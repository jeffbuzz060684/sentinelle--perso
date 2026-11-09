// Sentinelle perso — logique pure partagée (app navigateur + pipeline GitHub Actions + harnais de tests)
// Ce fichier s'exécute en script navigateur classique ET en module Node (aucun return top-level).
var RI = (function () {
  "use strict";

  // ---------- configuration du pipeline ----------
  var CFG = {
    FR_MIN_EUR: 1000,      // montant min des acquisitions FR (filtre côté service + re-vérifié ici)
    US_MIN_USD: 1000,      // montant min des achats US (filtre local)
    FR_DAYS: 10,           // fenêtre de requête FR (jours de publication)
    KEEP_DAYS: 90,          // conservation des lignes dans data.json
    MAX_ROWS: 600,          // max lignes par source dans data.json
    US_FETCH_BUDGET: 400,   // max téléchargements de Form 4 XML par run
    US_RL_MS: 180,          // pause entre téléchargements SEC (~5/s, limite 10/s)
    STATE_DAYS: 40,         // conservation des accession US déjà traités (déduplication)
    STALE_H: 60             // au-delà : relevé marqué "ancien" (trou week-end = 57 h max)
  };

  // ---------- utilitaires ----------
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function decodeEntities(s) {
    return String(s == null ? "" : s)
      .replace(/&nbsp;/gi, " ").replace(/&euro;/gi, "€")
      .replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
  }
  function stripTags(s) {
    return decodeEntities(String(s == null ? "" : s).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
  }
  // "1 400.0000" ou "22 020.0400 €" (espaces insécables U+00A0 / U+202F) -> 1400 / 22020.04
  function frNum(s) {
    if (s == null) return NaN;
    var t = String(s).replace(/[\u00a0\u202f\s\u2028\u2029]/g, "").replace(/€/g, "").replace(",", ".");
    var m = t.match(/-?\d+(\.\d+)?/);
    return m ? parseFloat(m[0]) : NaN;
  }
  function ddmmyyyyToIso(s) {
    var m = String(s || "").trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    return m ? (m[3] + "-" + m[2] + "-" + m[1]) : null;
  }
  function isoToDmY(iso) {
    var m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? (parseInt(m[3], 10) + "/" + m[2] + "/" + m[1]) : "—";
  }
  // date locale -> "dd/mm/aaaa" pour la requête swaoo (décalage UTC évité)
  function frDate(d) {
    var p = function (n) { return (n < 10 ? "0" : "") + n; };
    return p(d.getDate()) + "/" + p(d.getMonth() + 1) + "/" + d.getFullYear();
  }
  function isoDay(d) {
    var p = function (n) { return (n < 10 ? "0" : "") + n; };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }
  function daysBetween(isoA, isoB) {
    if (!isoA || !isoB) return null;
    var a = Date.parse(isoA), b = Date.parse(isoB);
    if (isNaN(a) || isNaN(b)) return null;
    return Math.round((b - a) / 86400000);
  }

  // ---------- parseur FR : transactions-amf.swaoo.com ----------
  // Chaque déclaration = une ligne principale <tr> + une ligne détail <tr class="collapse" id="DET…">
  function parseSwaoo(html) {
    var out = [];
    var i = html.indexOf('id="liste_transactions"');
    if (i < 0) return out;
    var seg = html.slice(i);
    var re = /<tr>\s*<td><a[^>]*>([^<]*)<\/a><\/td>((?:\s*<td[^>]*>[\s\S]*?<\/td>)+)\s*<\/tr>\s*<tr class="collapse" id="([^"]+)">([\s\S]*?)<\/tr>/g;
    var m;
    while ((m = re.exec(seg)) !== null) {
      var cells = [];
      var cellRe = /<td[^>]*>([\s\S]*?)<\/td>/g;
      var cm;
      while ((cm = cellRe.exec(m[2])) !== null) cells.push(stripTags(cm[1]));
      if (cells.length < 8) continue;
      var detail = m[4];
      var id = String(m[3]).replace(/^DET/, "");
      var auteurM = detail.match(/<strong>Auteur :<\/strong>([\s\S]*?)<\/li>/);
      var auteurFull = auteurM ? stripTags(auteurM[1]) : "";
      var auteur = auteurFull, role = "";
      var cIdx = auteurFull.lastIndexOf(", ");
      if (cIdx > 0 && auteurFull.length - cIdx < 90) {
        auteur = auteurFull.slice(0, cIdx);
        role = auteurFull.slice(cIdx + 2);
      }
      var pdfM = detail.match(/href="([^"]+)"[^>]*>[^<]*Déclaration/);
      var ficheM = detail.match(/href="(https:\/\/bdif\.amf-france\.org\/Fiche-BDIF[^"]*)"/);
      // cellules après la société : [0]=datePub [1]=dateOp [2]=nature [3]=instrument [4]=ISIN [5]=volume [6]=prix [7]=montant
      var nature = cells[2];
      if (nature && nature.toLowerCase().indexOf("acquisition") !== 0) continue; // acquisitions uniquement
      var row = {
        id: id,
        source: "FR",
        societe: stripTags(m[1]),
        auteur: auteur,
        role: role,
        nature: nature,
        instrument: cells[3] || "",
        isin: cells[4] || "",
        datePub: ddmmyyyyToIso(cells[0]),
        dateOp: ddmmyyyyToIso(cells[1]),
        volume: frNum(cells[5]),
        prix: frNum(cells[6]),
        montant: frNum(cells[7]),
        url: pdfM ? decodeEntities(pdfM[1]) : (ficheM ? ficheM[1] : "")
      };
      // garde-fous : ligne incohérente ignorée
      if (!row.datePub || !row.dateOp || !isFinite(row.montant) || row.montant < 0) continue;
      if (row.montant > 1e10) continue;
      out.push(row);
    }
    return out;
  }
  function swaooCount(html) {
    var m = html.match(/(\d+)\s+déclarations?\s+enregistrées?/);
    return m ? parseInt(m[1], 10) : null;
  }
  // décide de continuer la pagination FR : tant que la page contient des lignes (toutes natures)
  // — la page peut être pleine de cessions, le filtre acquisition se fait en local.
  function frNextPage(rawCount, page, maxPages) {
    var max = maxPages || 12;
    return rawCount > 0 && page < max;
  }

  // ---------- parseur US : EDGAR full-text search + Form 4 XML ----------
  // "Enphase Energy, Inc.  (ENPH)  (CIK 0001463101)" -> { issuer, ticker }
  function parseIssuerDisplay(s) {
    var raw = String(s || "").replace(/\s+/g, " ").trim();
    var ticker = null;
    var mt = raw.match(/\(([^()]{1,8})\)/);
    if (mt && !/CIK/i.test(mt[1])) ticker = mt[1].trim();
    var name = raw.replace(/\s*\((?:CIK)?[^)]*\)/g, "").trim();
    return { issuer: name || raw, ticker: ticker };
  }
  function parseFts(jsonText) {
    var j = typeof jsonText === "string" ? JSON.parse(jsonText) : jsonText;
    var hits = (j && j.hits && j.hits.hits) || [];
    var out = [];
    for (var k = 0; k < hits.length; k++) {
      var h = hits[k];
      var parts = String(h._id || "").split(":");
      if (parts.length < 2) continue;
      var src = h._source || {};
      var names = src.display_names || [];
      var owner = names.length > 0 ? parseIssuerDisplay(names[0]).issuer : "";
      var issuerInfo = names.length > 1 ? parseIssuerDisplay(names[1]) : { issuer: "", ticker: null };
      out.push({
        accession: parts[0],
        file: parts.slice(1).join(":"),
        cik: (src.ciks && src.ciks[0]) || "",
        fileDate: src.file_date || "",
        owner: owner,
        issuer: issuerInfo.issuer,
        ticker: issuerInfo.ticker
      });
    }
    return out;
  }
  function form4Url(cik, accession, file) {
    return "https://www.sec.gov/Archives/edgar/data/" + String(cik).replace(/^0+/, "") +
      "/" + String(accession).replace(/-/g, "") + "/" + file;
  }
  function parseForm4(xml) {
    var x = String(xml || "");
    var g = function (re) { var m = x.match(re); return m ? m[1].trim() : ""; };
    var role = g(/<officerTitle>([^<]*)/);
    var isDir = /^\s*(?:<value>\s*)?1/.test(g(/<isDirector>((?:(?!<\/isDirector>)[\s\S])*)/) || "0");
    var is10 = /^\s*(?:<value>\s*)?1/.test(g(/<isTenPercentOwner>((?:(?!<\/isTenPercentOwner>)[\s\S])*)/) || "0");
    if (!role) role = isDir ? "Directeur" : (is10 ? "Propriétaire 10 %" : "Initié");
    var blocks = x.match(/<nonDerivativeTransaction>[\s\S]*?<\/nonDerivativeTransaction>/g) || [];
    var txs = [];
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      var q = function (re) { var m = b.match(re); return m ? m[1].trim() : ""; };
      txs.push({
        title: q(/<securityTitle>\s*<value>([^<]*)/),
        date: q(/<transactionDate>\s*<value>([^<]*)/),
        code: q(/<transactionCode>([^<]*)/),
        acq: q(/<transactionAcquiredDisposedCode>\s*<value>([^<]*)/),
        shares: parseFloat(q(/<transactionShares>\s*<value>([^<]*)/)),
        price: parseFloat(q(/<transactionPricePerShare>\s*<value>([^<]*)/))
      });
    }
    return {
      issuer: g(/<issuerName>([^<]*)/),
      ticker: g(/<issuerTradingSymbol>([^<]*)/),
      owner: g(/<rptOwnerName>([^<]*)/),
      role: role,
      transactions: txs
    };
  }
  // Filtre "achats" : code A (acquis) + code P uniquement (achat au marché).
  // Hors périmètre, pour honnêteté : F/G (cadeaux, dons), J (autres — conversions, distributions),
  // M (levée d'options — pas de nouvel argent engagé), A (attribution — rémunération).
  function usRowsFrom(hit, f4) {
    var rows = [];
    for (var i = 0; i < f4.transactions.length; i++) {
      var t = f4.transactions[i];
      if (t.acq !== "A") continue;
      if (t.code !== "P") continue;
      if (!isFinite(t.shares) || !isFinite(t.price) || t.shares <= 0 || t.price <= 0) continue;
      var montant = t.shares * t.price;
      if (montant < CFG.US_MIN_USD) continue;
      rows.push({
        id: hit.accession + "|" + (f4.owner || hit.owner) + "|" + t.code + "|" + t.date + "|" + t.shares,
        source: "US",
        societe: f4.issuer || hit.issuer || "",
        ticker: f4.ticker || hit.ticker || "",
        auteur: f4.owner || hit.owner || "",
        role: f4.role || "",
        nature: "Achat",
        instrument: t.title || "",
        isin: "",
        dateOp: t.date || "",
        datePub: hit.fileDate || "",
        volume: t.shares,
        prix: t.price,
        montant: Math.round(montant * 100) / 100,
        code: t.code,
        url: hit.url || ""
      });
    }
    return rows;
  }

  // ---------- fusion / déduplication / fenêtre de conservation ----------
  function mergeRows(oldRows, newRows, keepDays, maxRows, nowMs) {
    var byId = {};
    var all = (oldRows || []).concat(newRows || []);
    for (var i = 0; i < all.length; i++) {
      var r = all[i];
      if (!r || !r.id || !r.datePub) continue;
      if (r.montant == null || !isFinite(r.montant) || r.montant < 0) continue;
      byId[r.id] = r; // les plus récents en dernier gagnent
    }
    var list = [];
    for (var k in byId) {
      if (!Object.prototype.hasOwnProperty.call(byId, k)) continue;
      var age = daysBetween(String(byId[k].datePub).slice(0, 10), isoDay(new Date(nowMs)));
      if (keepDays && age != null && age > keepDays) continue;
      list.push(byId[k]);
    }
    list.sort(function (a, b) {
      var d = String(b.datePub).localeCompare(String(a.datePub));
      if (d !== 0) return d;
      return (b.montant || 0) - (a.montant || 0);
    });
    if (maxRows && list.length > maxRows) list = list.slice(0, maxRows);
    return list;
  }

  // ---------- app : filtre, tri, format, fraîcheur ----------
  function filterRows(rows, opts) {
    var o = opts || {};
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (o.source === "FR" && r.source !== "FR") continue;
      if (o.source === "US" && r.source !== "US") continue;
      if (o.minMontant && (r.montant || 0) < o.minMontant) continue;
      if (o.q) {
        var q = String(o.q).toLowerCase();
        var hay = (r.societe + " " + (r.ticker || "") + " " + r.auteur + " " + (r.isin || "")).toLowerCase();
        if (hay.indexOf(q) === -1) continue;
      }
      out.push(r);
    }
    return out;
  }
  function sortRows(rows, key) {
    var list = rows.slice();
    list.sort(function (a, b) {
      if (key === "montant") return (b.montant || 0) - (a.montant || 0);
      var d = String(b.datePub).localeCompare(String(a.datePub));
      if (d !== 0) return d;
      return (b.montant || 0) - (a.montant || 0);
    });
    return list;
  }
  function fmtEUR(n) {
    if (n == null || !isFinite(n)) return "—";
    var v = Math.round(n);
    var s = String(v).replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");
    return s + "\u00a0€";
  }
  function fmtUSD(n) {
    if (n == null || !isFinite(n)) return "—";
    var v = Math.round(n);
    return "$" + String(v).replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");
  }
  function fmtNum(n) {
    if (n == null || !isFinite(n)) return "—";
    var v = Math.round(n * 100) / 100;
    return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");
  }
  function fmtMontant(r) {
    return r.source === "US" ? fmtUSD(r.montant) : fmtEUR(r.montant);
  }
  function lagLabel(r) {
    var d = daysBetween(String(r.dateOp).slice(0, 10), String(r.datePub).slice(0, 10));
    if (d == null) return "";
    if (d < 0) return "publié avant l'opération"; // déclaration d'une acquisition future (cas réel)
    if (d <= 0) return "publié le jour même";
    return "publié J+" + d;
  }
  function freshness(updatedIso, nowMs) {
    var t = Date.parse(updatedIso);
    if (isNaN(t)) return { h: null, label: "inconnu", stale: true };
    var h = Math.max(0, Math.round((nowMs - t) / 3600000));
    var label;
    if (h < 1) label = "à l'instant";
    else if (h < 24) label = "il y a " + h + " h";
    else label = "il y a " + Math.floor(h / 24) + " j";
    return { h: h, label: label, stale: h > CFG.STALE_H };
  }

  // ---------- signaux : accumulation des initiés par société ----------
  // Un achat isolé = bruit ; plusieurs achats (surtout d'initiés DISTINCTS) = conviction.
  // Heuristique maison de niveau, non validée historiquement :
  //   niveau 3 (🔥🔥) : >= 2 initiés distincts ET >= 3 achats  — le vrai signal de cluster
  //   niveau 2 (🔥)   : >= 3 achats (même initié qui rachète) OU >= 2 initiés OU total >= 1 M
  //   niveau 1 (×)    : 2 achats d'un même initié — à nuancer
  //   < 2 achats      : pas un signal (reste dans la liste brute)
  function normName(s) {
    return String(s == null ? "" : s).toUpperCase()
      .replace(/[\u00c0\u00c1\u00c2\u00c3\u00c4\u00c5]/g, "A").replace(/[\u00c8\u00c9\u00ca\u00cb]/g, "E")
      .replace(/[\u00cc\u00cd\u00ce\u00cf]/g, "I").replace(/[\u00d2\u00d3\u00d4\u00d5\u00d6]/g, "O")
      .replace(/[\u00d9\u00da\u00db\u00dc]/g, "U").replace(/\u00c7/g, "C")
      .replace(/[^A-Z0-9]+/g, " ").trim();
  }
  // clé de regroupement : jamais mélanger FR (€) et US ($). Côté FR, le NOM normalisé
  // prime : 37/63 déclarations réelles sans ISIN — la clé ISIN couperait une société
  // en deux cartes (cas ROCHE BOBOIS constaté). Côté US, le ticker (toujours présent).
  function sigKey(r) {
    if (r.source === "US") return "US|" + ((r.ticker && normName(r.ticker)) || normName(r.societe));
    return "FR|" + (normName(r.societe) || String(r.isin || "").trim());
  }
  function signalsFrom(rows) {
    var map = {};
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r || !r.id || !r.datePub) continue;
      if (r.montant == null || !isFinite(r.montant) || r.montant < 0) continue;
      if (!isFinite(r.volume) || r.volume <= 0 || !isFinite(r.prix) || r.prix <= 0) continue;
      var k = sigKey(r);
      var g = map[k];
      if (!g) {
        g = map[k] = { key: k, source: r.source, societe: r.societe, ticker: r.ticker || "", isin: r.isin || "",
          buys: 0, total: 0, volume: 0, buyers: {}, first: null, last: null };
      }
      g.buys++; g.total += r.montant; g.volume += r.volume;
      var bk = normName(r.auteur) || "\u2014";
      g.buyers[bk] = (g.buyers[bk] || 0) + 1;
      var d = String(r.datePub).slice(0, 10);
      if (!g.first || d < g.first) g.first = d;
      if (!g.last || d > g.last) g.last = d;
    }
    var out = [];
    for (var k2 in map) {
      if (!Object.prototype.hasOwnProperty.call(map, k2)) continue;
      var m = map[k2];
      if (m.buys < 2) continue;
      var nBuyers = 0;
      for (var b in m.buyers) {
        if (Object.prototype.hasOwnProperty.call(m.buyers, b)) nBuyers++;
      }
      out.push({
        key: m.key, source: m.source, societe: m.societe, ticker: m.ticker, isin: m.isin,
        buys: m.buys, buyers: nBuyers,
        total: Math.round(m.total * 100) / 100,
        avgPx: m.volume > 0 ? Math.round((m.total / m.volume) * 10000) / 10000 : 0,
        first: m.first, last: m.last,
        level: (nBuyers >= 2 && m.buys >= 3) ? 3 : ((m.buys >= 3 || nBuyers >= 2 || m.total >= 1000000) ? 2 : 1)
      });
    }
    out.sort(function (a, b) {
      if (b.level !== a.level) return b.level - a.level;
      return b.total - a.total;
    });
    return out;
  }
  // badge ×N dans la liste brute : nb d'achats de la société sur la fenêtre
  function signalCountByKey(rows) {
    var c = {};
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r || !r.datePub) continue;
      var k = sigKey(r);
      c[k] = (c[k] || 0) + 1;
    }
    return c;
  }
  // lien cote en 1 tap — pas d'API marché (fragile, CORS) : on renvoie vers la recherche
  function quoteUrl(r) {
    if (r.source === "US") {
      return "https://www.google.com/finance/search?q=" + encodeURIComponent(String(r.ticker || r.societe || "").trim());
    }
    var id = String(r.isin || "").trim();
    return "https://www.boursorama.com/recherche/?query=" + encodeURIComponent(id || String(r.societe || "").trim());
  }
  function fmtPx(r, px) {
    if (px == null || !isFinite(px)) return "\u2014";
    return fmtNum(px) + (r.source === "US" ? " $" : " \u20ac");
  }

  return {
    CFG: CFG,
    esc: esc, decodeEntities: decodeEntities, stripTags: stripTags,
    frNum: frNum, ddmmyyyyToIso: ddmmyyyyToIso, isoToDmY: isoToDmY, frDate: frDate, isoDay: isoDay, daysBetween: daysBetween,
    parseSwaoo: parseSwaoo, swaooCount: swaooCount,
    parseIssuerDisplay: parseIssuerDisplay, parseFts: parseFts, form4Url: form4Url, parseForm4: parseForm4, usRowsFrom: usRowsFrom,
    frNextPage: frNextPage,
    mergeRows: mergeRows,
    filterRows: filterRows, sortRows: sortRows,
    fmtEUR: fmtEUR, fmtUSD: fmtUSD, fmtNum: fmtNum, fmtMontant: fmtMontant, lagLabel: lagLabel, freshness: freshness,
    normName: normName, sigKey: sigKey, signalsFrom: signalsFrom, signalCountByKey: signalCountByKey, quoteUrl: quoteUrl, fmtPx: fmtPx
  };
})();
if (typeof module !== "undefined" && module.exports) { module.exports = RI; }
