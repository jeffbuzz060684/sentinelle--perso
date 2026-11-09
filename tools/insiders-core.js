// ─── Sentinelle perso — cœur pur (testable Node, zéro dépendance) ────────────
// Sources :
//  - FR : swaoo (agrégateur AMF, 1 fetch par nature) + flux RSS officiel BDIF
//         (https://bdif.amf-france.org/back/api/v1/rss?lang=fr&typesInfo=DD)
//  - US : SEC EDGAR full-text search (forms=4) + documents Form 4 XML
// Délais légaux de publication : AMF ≤ 3 jours ouvrés · SEC Form 4 ≤ 2 jours ouvrés.

'use strict';

// ─── Constantes ─────────────────────────────────────────────────────────────
const BIG_THRESHOLD = 10000;        // € ou $ — seuil « gros achat » surligné
const NATURES_ACHAT_FR = ['Acquisition', 'Souscription']; // achat = mise de fond
const CODES_ACHAT_US = ['P'];       // Form 4 : P = open-market purchase
const JOURS_CONSERVES = 45;          // fenêtre glissante de data.json
const JOURS_FENETRE_SCAN = 8;        // rattrapage max à chaque scan

// ─── Utilitaires ─────────────────────────────────────────────────────────────
function parseNumFr(s) {
  if (s == null) return null;
  const t = String(s).replace(/[\s\u00a0\u202f]/g, '').replace(/€/g, '').replace(/,/g, '.').trim();
  if (t === '' || t === '-') return null;
  const v = parseFloat(t);
  return Number.isFinite(v) ? v : null;
}

function parseNumUs(s) {
  if (s == null) return null;
  const t = String(s).replace(/[\s\u00a0\u202f]/g, '').replace(/,/g, '').trim();
  if (t === '') return null;
  const v = parseFloat(t);
  return Number.isFinite(v) ? v : null;
}

// dd/mm/yyyy -> yyyy-mm-dd ; retourne null si invalide
function parseDateFr(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(s || '').trim());
  if (!m) return null;
  const d = parseInt(m[1], 10), mo = parseInt(m[2], 10), y = parseInt(m[3], 10);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function todayIso(now) {
  const d = now ? new Date(now) : new Date();
  return d.toISOString().slice(0, 10);
}

function isoMinusDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// jours calendaires entre deux dates ISO (null si invalide)
function daysBetween(fromIso, toIso) {
  if (!fromIso || !toIso) return null;
  const a = Date.parse(fromIso + 'T00:00:00Z');
  const b = Date.parse(toIso + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

function isRealDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''))) return false;
  const d = new Date(iso + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) &&
    d.toISOString().slice(0, 10) === iso;
}

// ─── Parser HTML swaoo (Transactions-AMF) ───────────────────────────────────
// La page rend des paires : ligne principale (≥10 <td>) + ligne détail
// (« Déclaration n°… » avec auteur, liens officiels).
function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&euro;/g, '€').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function stripTags(s) {
  return decodeEntities(String(s).replace(/<[^>]+>/g, ' '))
    .replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseSwaooPage(html) {
  const out = [];
  const numeros = {};   // tous les numéros déclarés vus sur la page (toutes natures)
  if (!html || typeof html !== 'string') return { buys: out, numeros: [] };
  const trs = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  const rows = [];
  let m;
  while ((m = trs.exec(html)) !== null) rows.push(m[1]);

  let pendingMain = null;
  for (const rowHtml of rows) {
    if (/D\u00e9claration n\u00b0|Déclaration n°/.test(rowHtml)) {
      // ligne détail — on enregistre TOUJOURS son numéro (toutes natures)
      const numAny = /D\u00e9claration n\u00b0\s*([0-9A-Z]+)|Déclaration n°\s*([0-9A-Z]+)/.exec(decodeEntities(rowHtml));
      if (numAny) numeros[(numAny[1] || numAny[2])] = true;
      // complète la ligne principale d'achat en attente, s'il y en a une
      if (!pendingMain) continue;
      const numM = numAny;
      const numero = (numM && (numM[1] || numM[2])) || null;
      if (numero) numeros[numero] = true;
      // auteur : bloc <li> dédié (évite d'avaler toute la ligne de détail)
      let auteur = null;
      const liRe = /<li[^>]*>([\s\S]*?)<\/li>/g;
      let li;
      while ((li = liRe.exec(rowHtml)) !== null) {
        const t = stripTags(li[1]);
        if (/^Auteur\s*:/.test(t)) { auteur = t.replace(/^Auteur\s*:\s*/, ''); break; }
      }
      const hrefs = /href="([^"]+)"/g;
      let lienFiche = null, lienPdf = null;
      let h;
      while ((h = hrefs.exec(rowHtml)) !== null) {
        const u = decodeEntities(h[1]);
        if (/Fiche-BDIF\?docId=/.test(u)) lienFiche = u;
        else if (/\/back\/api\/v1\/documents\/.*\.pdf/.test(u)) lienPdf = u;
      }
      out.push({
        id: 'FR-' + (numero || ('SWAO-' + pendingMain.societe + '-' + pendingMain.datePub + '-' + out.length)),
        src: 'FR',
        societe: pendingMain.societe,
        ticker: null,
        isin: pendingMain.isin || null,
        auteur: auteur,
        nature: pendingMain.nature,
        volume: pendingMain.volume,
        prix: pendingMain.prix,
        montant: pendingMain.montant,
        devise: 'EUR',
        dateOp: pendingMain.dateOp,
        datePub: pendingMain.datePub,
        detail: true,
        lienFiche: lienFiche || ('https://bdif.amf-france.org/fr/details/' + numero),
        lienPdf: lienPdf,
        lienSrc: 'https://transactions-amf.swaoo.com/'
      });
      pendingMain = null;
      continue;
    }
    const tds = [];
    const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g;
    let t;
    while ((t = tdRe.exec(rowHtml)) !== null) tds.push(t[1]);
    if (tds.length >= 10) {
      const societe = stripTags(tds[0]);
      if (!societe) continue;
      const nature = stripTags(tds[3]);
      // défense en profondeur : ne garder QUE les natures d'achat, même si le
      // filtre serveur renvoie autre chose.
      if (NATURES_ACHAT_FR.indexOf(nature) === -1) continue;      pendingMain = {
        societe: societe,
        datePub: parseDateFr(stripTags(tds[1])),
        dateOp: parseDateFr(stripTags(tds[2])),
        nature: nature,
        instrument: stripTags(tds[4]) || null,
        isin: stripTags(tds[5]) || null,
        volume: parseNumFr(stripTags(tds[6])),
        prix: parseNumFr(stripTags(tds[7])),
        montant: parseNumFr(stripTags(tds[8]))
      };
    }
  }
  return { buys: out, numeros: Object.keys(numeros) };
}

// ─── Parser RSS BDIF (Déclarations des dirigeants, officiel AMF) ─────────────
function parseBdifRss(xml) {
  const out = [];
  if (!xml || typeof xml !== 'string') return out;
  const items = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = items.exec(xml)) !== null) {
    const it = m[1];
    const title = stripTags((/<title>([\s\S]*?)<\/title>/.exec(it) || [])[1] || '');
    const link = stripTags((/<link>([\s\S]*?)<\/link>/.exec(it) || [])[1] || '');
    const pub = stripTags((/<pubDate>([\s\S]*?)<\/pubDate>/.exec(it) || [])[1] || '');
    const numM = /details\/([0-9A-Z]+)/.exec(link);
    if (!numM) continue;
    let datePub = null;
    const pd = Date.parse(pub);
    if (Number.isFinite(pd)) {
      datePub = new Date(pd).toISOString().slice(0, 10);
    }
    out.push({
      id: 'FR-' + numM[1],
      numero: numM[1],
      societe: title,
      datePub: datePub,
      lienFiche: 'https://bdif.amf-france.org/fr/details/' + numM[1]
    });
  }
  return out;
}

// déclarations du RSS officiel absentes de swaoo → entrées « à vérifier »
// numerosVus : TOUS les numéros déclarés vus chez swaoo (achats ET autres natures)
function bdifNotInSwaoo(rssItems, swaooBuys, numerosVus) {
  const seen = {};
  (numerosVus || []).forEach(n => { seen[n] = true; });
  (swaooBuys || []).forEach(b => { if (b.numero) seen[b.numero] = true; });
  const byId = {};
  (swaooBuys || []).forEach(b => { byId[b.id] = true; });
  return (rssItems || []).filter(it => !byId[it.id] && !seen[it.numero]).map(it => ({
    id: it.id,
    src: 'FR',
    societe: it.societe,
    ticker: null,
    isin: null,
    auteur: null,
    nature: null,           // nature non détaillée sans parse du PDF
    volume: null, prix: null, montant: null,
    devise: 'EUR',
    dateOp: null,
    datePub: it.datePub,
    detail: false,          // à vérifier : lien vers la fiche officielle
    lienFiche: it.lienFiche,
    lienPdf: null,
    lienSrc: 'https://bdif.amf-france.org/fr?typesInformation=DD'
  }));
}

// ─── Parser Form 4 XML (SEC EDGAR) ──────────────────────────────────────────
function xmlTag(xml, tag) {
  // 1) <tag><value>x</value></tag>  2) <tag>x</tag> — ne jamais traverser d'autres balises
  const m = new RegExp('<' + tag + '>\\s*<value>([^<]*)<').exec(xml) ||
            new RegExp('<' + tag + '>\\s*([^<]*)\\s*<').exec(xml);
  return m ? m[1].trim() : null;
}

function parseForm4Xml(xml) {
  const res = { ok: false, ownerName: null, officerTitle: null, isDirector: false,
               isTenPercent: false, issuerName: null, ticker: null,
               periodOfReport: null, buys: [] };
  if (!xml || typeof xml !== 'string') return res;
  res.ownerName = xmlTag(xml, 'rptOwnerName');
  res.officerTitle = xmlTag(xml, 'officerTitle') ||
    (/isOfficer>1/.test(xml) ? 'Dirigeant' : null);
  res.isDirector = /<isDirector>1/.test(xml);
  res.isTenPercent = /<isTenPercentOwner>1/.test(xml);
  res.issuerName = xmlTag(xml, 'issuerName');
  res.ticker = xmlTag(xml, 'issuerTradingSymbol');
  res.periodOfReport = xmlTag(xml, 'periodOfReport');
  const blocks = xml.split(/<nonDerivativeTransaction>/).slice(1);
  for (const raw of blocks) {
    const b = raw.split(/<\/nonDerivativeTransaction>/)[0];
    const code = (xmlTag(b, 'transactionCode') || '').toUpperCase();
    if (CODES_ACHAT_US.indexOf(code) === -1) continue;
    const shares = parseNumUs(xmlTag(b, 'transactionShares'));
    const price = parseNumUs(xmlTag(b, 'transactionPricePerShare'));
    const date = xmlTag(b, 'transactionDate');
    res.buys.push({
      code: code,
      shares: shares,
      price: price,
      montant: (shares != null && price != null) ? shares * price : null,
      date: date,
      titre: xmlTag(b, 'securityTitle')
    });
  }
  res.ok = !!res.issuerName;
  return res;
}

// agrège une déclaration Form 4 en entrée Sentinelle (id US-<adsh>)
function form4ToEntry(adsh, cik, parsed) {
  if (!parsed || !parsed.ok || !parsed.buys.length) return null;
  const shares = parsed.buys.reduce((s, b) => s + (b.shares || 0), 0);
  const montant = parsed.buys.every(b => b.montant != null)
    ? parsed.buys.reduce((s, b) => s + b.montant, 0)
    : (parsed.buys.some(b => b.montant != null)
        ? parsed.buys.reduce((s, b) => s + (b.montant || 0), 0) : null);
  const date = parsed.periodOfReport || parsed.buys[0].date || null;
  let role = parsed.officerTitle || null;
  if (parsed.isDirector && role) role = role + ' · Administrateur';
  else if (parsed.isDirector) role = 'Administrateur';
  if (parsed.isTenPercent) role = (role ? role + ' · >10 %' : 'Actionnaire >10 %');
  return {
    id: 'US-' + String(adsh).replace(/-/g, ''),
    src: 'US',
    societe: parsed.issuerName,
    ticker: parsed.ticker,
    isin: null,
    auteur: parsed.ownerName + (role ? ' — ' + role : ''),
    nature: 'Achat (code P)',
    volume: shares > 0 ? shares : null,
    prix: montant != null && shares > 0 ? Math.round((montant / shares) * 10000) / 10000 : null,
    montant: montant,
    devise: 'USD',
    dateOp: date,
    datePub: null,           // date de dépôt EDGAR ajoutée par le scan
    detail: true,
    lienFiche: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=' +
                (cik || '') + '&type=4',
    lienPdf: null,
    lienSrc: 'https://efts.sec.gov/LATEST/search-index?q=%22form+4%22&forms=4',
    nOps: parsed.buys.length
  };
}

// ─── Fusion / purge / nouveautés ────────────────────────────────────────────
function mergeBuys(existing, fresh, maxDays, nowIso) {
  const byId = {};
  const merged = [];
  (existing || []).forEach(b => { if (b && b.id) { byId[b.id] = b; merged.push(b); } });
  (fresh || []).forEach(b => {
    if (!b || !b.id) return;
    if (byId[b.id]) {
      // un détail peut arriver après une entrée RSS « à vérifier »
      const old = byId[b.id];
      if (b.detail && !old.detail) {
        const i = merged.indexOf(old);
        merged[i] = b; byId[b.id] = b;
      }
    } else {
      byId[b.id] = b;
      merged.push(b);
    }
  });
  const cut = isoMinusDays(todayIso(nowIso), maxDays || JOURS_CONSERVES);
  const pruned = merged.filter(b => !b.datePub || b.datePub >= cut);
  pruned.sort((a, b) => String(b.datePub || b.dateOp || '').localeCompare(String(a.datePub || a.dateOp || '')));
  return pruned;
}

function newSince(buys, lastSeenIso) {
  if (!lastSeenIso) return buys.slice();
  return (buys || []).filter(b =>
    b.datePub ? b.datePub > lastSeenIso : (b.dateOp ? b.dateOp > lastSeenIso : false));
}

function isBig(b, threshold) {
  const th = threshold || BIG_THRESHOLD;
  return b && b.montant != null && b.montant >= th;
}

function statsOf(buys) {
  const all = buys || [];
  const achats = all.filter(b => b.detail !== false); // achats détaillés confirmés
  const big = achats.filter(b => isBig(b)).length;
  const fr = achats.filter(b => b.src === 'FR').length;
  const us = achats.filter(b => b.src === 'US').length;
  return { total: achats.length, gros: big, fr: fr, us: us, aVerifier: all.length - achats.length };
}

// ─── Validation data.json ────────────────────────────────────────────────────
function validateData(d) {
  const errs = [];
  if (!d || typeof d !== 'object') return ['data.json : objet attendu'];
  if (!Array.isArray(d.buys)) errs.push('data.json : buys[] attendu');
  else {
    const ids = {};
    (d.buys || []).forEach(b => {
      if (!b.id) errs.push('achat sans id');
      else if (ids[b.id]) errs.push('id dupliqué ' + b.id);
      else ids[b.id] = 1;
      if (b.src !== 'FR' && b.src !== 'US') errs.push('src invalide');
      if (!b.societe) errs.push('société manquante');
      if (b.datePub && !isRealDate(b.datePub)) errs.push('datePub invalide ' + b.datePub);
      if (b.dateOp && !isRealDate(b.dateOp)) errs.push('dateOp invalide ' + b.dateOp);
      if (b.montant != null && (typeof b.montant !== 'number' || !Number.isFinite(b.montant)))
        errs.push('montant non numérique');
      if (b.devise !== 'EUR' && b.devise !== 'USD') errs.push('devise invalide');
    });
  }
  if (d.usScanned && !Array.isArray(d.usScanned)) errs.push('usScanned : tableau attendu');
  return errs;
}

// ─── US : index quotidien EDGAR (form.YYYYMMDD.idx) ──────────────────────────
// Lignes pipe-séparées : CIK |Company Name|Form Type|Date Filed|Filename
function parseFormIdx(txt) {
  const out = [];
  if (!txt || txt.indexOf('|') < 0) return out;
  for (const line of String(txt).split('\n')) {
    if (line.indexOf('|') < 0) continue;
    const p = line.split('|').map(s => s.trim());
    if (p.length < 5) continue;
    if (!/^4(\/A)?$/.test(p[2])) continue;
    const mAdsh = p[4].match(/(\d{10})-(\d{2})-(\d{6})/) || p[4].match(/(\d{18})/);
    if (!mAdsh) continue;
    const adsh = mAdsh.length === 4
      ? (mAdsh[1] + '-' + mAdsh[2] + '-' + mAdsh[3])
      : (mAdsh[1].slice(0, 10) + '-' + mAdsh[1].slice(10, 12) + '-' + mAdsh[1].slice(12));
    const cik = String(parseInt(p[0], 10));
    if (!cik || cik === 'NaN') continue;
    out.push({ adsh, fileDate: p[3] || null, ciks: [cik], names: [p[1] || ''] });
  }
  return out;
}

// ─── Exports (Node) ──────────────────────────────────────────────────────────
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    BIG_THRESHOLD, NATURES_ACHAT_FR, CODES_ACHAT_US, JOURS_CONSERVES, JOURS_FENETRE_SCAN,
    parseNumFr, parseNumUs, parseDateFr, todayIso, isoMinusDays, daysBetween, isRealDate,
    decodeEntities, stripTags,
    parseSwaooPage, parseBdifRss, bdifNotInSwaoo,
    parseForm4Xml, form4ToEntry, parseFormIdx,
    mergeBuys, newSince, isBig, statsOf, validateData
  };
}
