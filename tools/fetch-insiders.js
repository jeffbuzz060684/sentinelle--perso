#!/usr/bin/env node
// ─── Sentinelle perso — scan automatique des achats d'initiés ────────────────
// Usage : node tools/fetch-insiders.js            (scan live, écrit data.json)
//         node tools/fetch-insiders.js --dry      (scan live, n'écrit rien)
//         node tools/fetch-insiders.js --window 8 (jours de rattrapage)
// Sources : FR swaoo (nature Acquisition/Souscription) + RSS BDIF officiel AMF
//           US SEC EDGAR FTS forms=4 + Form 4 XML (code P = achat)
// Aucune dépendance : Node ≥ 18 (fetch natif). Échec d'une source ≠ échec du scan.

'use strict';
const fs = require('fs');
const path = require('path');
const C = require('./insiders-core.js');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'data.json');

const UA_SWAOO = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 SentinellePerso/1.0';
const UA_SEC = 'Sentinelle Perso/1.0 (jeffbuzz060684@users.noreply.github.com)';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const wIdx = args.indexOf('--window');
const WINDOW = wIdx >= 0 ? Math.max(2, Math.min(30, parseInt(args[wIdx + 1], 10) || 8)) : C.JOURS_FENETRE_SCAN;
const MAX_PAGES_SWAOO = 12;      // arrêt naturel à la 1re page vide (~7 pages sur 8 j)
const MAX_FILINGS_US = 80;       // plafond de Form 4 traités par scan
const MAX_SCANNED_KEEP = 1500;   // mémoire des dépôts US déjà traités

function log(...a) { console.log('[sentinelle]', ...a); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchText(url, ua, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs || 25000);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': ua, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7' },
      signal: ctl.signal,
      redirect: 'follow'
    });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url.slice(0, 90));
    return await r.text();
  } finally { clearTimeout(t); }
}

function fmtFr(d) { // yyyy-mm-dd -> dd/mm/yyyy (paramètres swaoo)
  if (!d) return '';
  const p = d.split('-');
  return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : d;
}

// ─── 1. FR — swaoo (données complètes : auteur, ISIN, montant, liens) ─────────
// Note : le filtre f_nature[] du serveur n'est pas fiable → on balaye les pages
// sans filtre de nature et on ne garde que les natures d'achat côté client
// (défense en profondeur, déjà dans parseSwaooPage).
async function scanFr(nowIso) {
  const debut = fmtFr(C.isoMinusDays(C.todayIso(nowIso), WINDOW));
  const fin = fmtFr(C.todayIso(nowIso));
  const buys = [];
  const seenIds = {};
  const numerosVus = {};
  for (let page = 1; page <= MAX_PAGES_SWAOO; page++) {
    const url = 'https://transactions-amf.swaoo.com/?' +
      'f_date_publication_debut=' + encodeURIComponent(debut) +
      '&f_date_publication_fin=' + encodeURIComponent(fin) +
      '&f_page=' + page;
    const html = await fetchText(url, UA_SWAOO);
    const parsed = C.parseSwaooPage(html);
    const rows = parsed.buys;
    for (const n of parsed.numeros) numerosVus[n] = true;
    let added = 0;
    for (const b of rows) {
      if (!seenIds[b.id]) { seenIds[b.id] = true; buys.push(b); added++; }
    }
    log('FR swaoo page', page, '→', rows.length, 'achats,', added, 'nouvelles,', parsed.numeros.length, 'déclarations vues');
    if (parsed.numeros.length === 0 && rows.length === 0) break;
    await sleep(400);
  }
  // ajoute le numero aux entrées FR (pour la déduplication RSS)
  for (const b of buys) {
    const m = /^FR-(\d{4}DD\d+)$/.exec(b.id);
    b.numero = m ? m[1] : null;
  }
  return { buys, numeros: Object.keys(numerosVus) };
}

// ─── 2. FR — RSS officiel BDIF (filet de sécurité, entrées « à vérifier ») ───
async function scanFrRss() {
  const xml = await fetchText('https://bdif.amf-france.org/back/api/v1/rss?lang=fr&typesInfo=DD', UA_SWAOO);
  return C.parseBdifRss(xml);
}

// ─── 3. US — EDGAR FTS + Form 4 XML ─────────────────────────────────────────
async function ftsForm4s(startdt, enddt) {
  const url = 'https://efts.sec.gov/LATEST/search-index?q=%22form%204%22&forms=4' +
    '&dateRange=custom&startdt=' + startdt + '&enddt=' + enddt;
  const txt = await fetchText(url, UA_SEC);
  const d = JSON.parse(txt);
  const hits = (d && d.hits && d.hits.hits) || [];
  return hits.map(h => ({
    adsh: h._source.adsh,
    fileDate: h._source.file_date || null,
    ciks: h._source.ciks || [],
    names: h._source.display_names || []
  }));
}

async function primaryDocUrl(adsh, cik) {
  const noDash = adsh.replace(/-/g, '');
  const cikDir = String(parseInt(cik, 10));
  const idxUrl = 'https://www.sec.gov/Archives/edgar/data/' + cikDir + '/' + noDash + '/index.json';
  let idx;
  try {
    idx = JSON.parse(await fetchText(idxUrl, UA_SEC));
  } catch (e) {
    return null;
  }
  const items = (idx && idx.directory && idx.directory.item) || [];
  for (const it of items) {
    if (it.type === '4' && /\.xml$/i.test(it.name)) {
      return 'https://www.sec.gov/Archives/edgar/data/' + cikDir + '/' + noDash + '/' + it.name;
    }
  }
  for (const it of items) {
    if (/\.xml$/i.test(it.name) && !/^xsl/i.test(it.name)) {
      return 'https://www.sec.gov/Archives/edgar/data/' + cikDir + '/' + noDash + '/' + it.name;
    }
  }
  return null;
}

async function scanUs(nowIso, alreadyScanned, usBuysById) {
  const today = C.todayIso(nowIso);
  const start = C.isoMinusDays(today, Math.min(3, WINDOW)); // FTS : fenêtre courte
  const fresh = [];
  const scanned = [];
  let hits = [];
  try {
    hits = await ftsForm4s(start, today);
    log('US FTS', start, '→', today, ':', hits.length, 'Form 4');
  } catch (e) {
    log('US FTS indisponible :', e.message);
    return { buys: fresh, scanned, status: 'erreur', erreur: e.message };
  }
  let treated = 0;
  for (const hit of hits) {
    if (treated >= MAX_FILINGS_US) break;
    if (!hit.adsh) continue;
    const id = 'US-' + hit.adsh.replace(/-/g, '');
    if (usBuysById[id] || alreadyScanned[id]) { scanned.push(id); continue; }
    treated++;
    await sleep(160); // politesse SEC ≤ 8 req/s
    let xmlUrl = null;
    for (const cik of hit.ciks.slice(0, 3)) {
      xmlUrl = await primaryDocUrl(hit.adsh, cik);
      if (xmlUrl) break;
      await sleep(160);
    }
    if (!xmlUrl) { scanned.push(id); continue; }
    let xml;
    try { xml = await fetchText(xmlUrl, UA_SEC); }
    catch (e) { continue; }
    const parsed = C.parseForm4Xml(xml);
    const entry = C.form4ToEntry(hit.adsh, hit.ciks[0], parsed);
    if (entry) {
      entry.datePub = hit.fileDate || today;
      entry.lienPdf = xmlUrl; // document primaire EDGAR
      fresh.push(entry);
      log('US +', entry.societe, '—', entry.auteur, '—', entry.montant, 'USD');
    } else {
      scanned.push(id); // dépôt traité sans achat P (vente, etc.)
    }
    await sleep(160);
  }
  return { buys: fresh, scanned, status: 'ok' };
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const nowIso = new Date().toISOString();
  const today = C.todayIso(nowIso);

  let data = { generatedAt: null, buys: [], usScanned: [], sources: {} };
  if (fs.existsSync(OUT)) {
    try { data = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { log('data.json illisible, repart à zéro'); }
  }
  if (!Array.isArray(data.buys)) data.buys = [];
  const usBuysById = {};
  data.buys.forEach(b => { if (b.src === 'US') usBuysById[b.id] = b; });
  const alreadyScanned = {};
  (data.usScanned || []).forEach(id => { alreadyScanned[id] = true; });

  const sources = { fr: { status: 'erreur' }, frRss: { status: 'erreur' }, us: { status: 'erreur' }, lastScan: nowIso };
  const fresh = [];
  let frNumeros = [];

  // FR swaoo
  try {
    const fr = await scanFr(nowIso);
    frNumeros = fr.numeros;
    fresh.push(...fr.buys);
    sources.fr = { status: 'ok', n: fr.buys.length, scan: nowIso };
    log('FR swaoo :', fr.buys.length, 'achats');
  } catch (e) {
    sources.fr = { status: 'erreur', erreur: e.message, scan: nowIso };
    log('ERREUR FR swaoo :', e.message);
  }

  // FR RSS officiel (filet de sécurité : déclarations non encore agrégées)
  let rssCount = 0;
  try {
    const rss = await scanFrRss();
    const orphans = C.bdifNotInSwaoo(rss, fresh.filter(b => b.src === 'FR'), frNumeros);
    // ne garder que les orphans récents (dans la fenêtre)
    const cut = C.isoMinusDays(today, WINDOW);
    const recent = orphans.filter(o => !o.datePub || o.datePub >= cut);
    fresh.push(...recent);
    rssCount = recent.length;
    sources.frRss = { status: 'ok', n: recent.length, scan: nowIso };
    log('FR RSS BDIF :', rss.length, 'déclarations,', recent.length, 'non détaillées récentes');
  } catch (e) {
    sources.frRss = { status: 'erreur', erreur: e.message, scan: nowIso };
    log('ERREUR FR RSS :', e.message);
  }

  // US EDGAR
  try {
    const us = await scanUs(nowIso, alreadyScanned, usBuysById);
    fresh.push(...us.buys);
    const scannedIds = us.scanned.slice(0, MAX_SCANNED_KEEP);
    data.usScanned = Array.from(new Set((data.usScanned || []).concat(scannedIds))).slice(-MAX_SCANNED_KEEP);
    sources.us = { status: us.status, n: us.buys.length, scan: nowIso };
    if (us.status !== 'ok') sources.us.erreur = us.erreur;
  } catch (e) {
    sources.us = { status: 'erreur', erreur: e.message, scan: nowIso };
    log('ERREUR US :', e.message);
  }

  // fusion + purge
  const merged = C.mergeBuys(data.buys, fresh, C.JOURS_CONSERVES, nowIso);
  const errs = C.validateData({ buys: merged, usScanned: data.usScanned });
  if (errs.length) {
    log('VALIDATION ÉCHOUÉE :', errs.slice(0, 5).join(' ; '));
    process.exit(1);
  }
  const stats = C.statsOf(merged);
  const next = {
    generatedAt: nowIso,
    windowDays: WINDOW,
    buys: merged,
    usScanned: data.usScanned || [],
    sources,
    stats
  };
  const before = JSON.stringify(data);
  const after = JSON.stringify(next);
  if (before === after) {
    log('Aucun changement — data.json inchangé.');
    return;
  }
  if (DRY) {
    log('--dry :', merged.length, 'achats au total,', fresh.length, 'nouveaux trouvés — PAS d écriture.');
    console.log(JSON.stringify(next, null, 1).slice(0, 800));
    return;
  }
  fs.writeFileSync(OUT, JSON.stringify(next, null, 1) + '\n');
  log('data.json mis à jour :', merged.length, 'achats,', fresh.length, 'nouveaux ce scan,',
      'stats:', JSON.stringify(stats));
}

main().catch(e => { console.error('[sentinelle] FATAL', e); process.exit(1); });
