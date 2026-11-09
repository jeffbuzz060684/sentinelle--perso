#!/usr/bin/env node
"use strict";
// Sentinelle perso — cotations + métriques de valorisation du SBF 120 (aucune dépendance, Node 18+)
//   Source : Yahoo Finance public. Le flux non officiel exige un cookie (fc.yahoo.com) + un crumb
//   (/v1/test/getcrumb) ; ensuite l'API batch /v7/finance/quote renvoie pour chaque titre .PA :
//   cours, variation, PER (trailing + forward), rendement du dividende, P/B, capitalisation.
//   L'indice lui-même : ^SBF120 (Yahoo). Données Euronext en différé (~15 min) — pas de licence temps réel.
//   120 valeurs en 3 batchs de 40 + 1 pour l'indice = 4 requêtes par run.
// Écrit quotes.json. Garde : moins de 90 % des valeurs qui répondent -> exit 1, quotes.json conservé.

var fs = require("fs");
var path = require("path");


var UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
var FETCH_IMPL = (typeof fetch === "function") ? fetch : null;
function setFetchForTests(f) { FETCH_IMPL = f; }
function log() { console.log.apply(console, arguments); }
function sleep(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }

// ---------- garde-fous temps (v4.0.4) ----------
// Timeout par requête : une requête qui ne répond jamais ne doit pas immobiliser un workflow
// (voire retarder un déploiement Pages). Budget global : délai maximal pour UNE collecte
// complète, borné dans main() — les boucles de tentatives s'arrêtent proprement une fois épuisé.
var REQ_TIMEOUT_MS = 12000;
var DEADLINE = null;
function setDeadline(ms) { DEADLINE = ms ? Date.now() + ms : null; }
function outOfTime() { return DEADLINE !== null && Date.now() >= DEADLINE; }

async function rawFetch(url, opts) {
  if (!FETCH_IMPL) throw new Error("fetch indisponible");
  opts = opts || {};
  if (!opts.signal && typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    opts.signal = AbortSignal.timeout(opts.timeoutMs || REQ_TIMEOUT_MS);
  }
  return FETCH_IMPL(url, opts);
}

// ---------- cookie + crumb Yahoo ----------

async function yahooSession(maxAttempts) {
  var attempts = maxAttempts || 8;
  var cookie = "", crumb = "";
  var lastErr = null;
  for (var a = 1; a <= attempts; a++) {
    if (outOfTime()) throw new Error("budget temps dépassé : session Yahoo abandonnée");
    try {
      // 1) cookie : fc.yahoo.com pose A1/A3 même en renvoyant 404
      var r1 = await rawFetch("https://fc.yahoo.com", { headers: { "User-Agent": UA, "Accept": "*/*" } });
      var setCookies = [];
      if (r1.headers && typeof r1.headers.getSetCookie === "function") setCookies = r1.headers.getSetCookie();
      else if (r1.headers && r1.headers.get("set-cookie")) setCookies = String(r1.headers.get("set-cookie")).split(/,(?=[^;]+=)/);
      cookie = setCookies.map(function (c) { return c.split(";")[0]; }).filter(Boolean).join("; ");
      // 2) crumb — un 429 renvoie un CORPS texte (« Too Many Requests ») qui se glisserait en crumb :
      //    on exige un statut 200, sinon on retente. Les 429 de Yahoo vont par rafales : on alterne
      //    query1/query2 et on patiente (backoff ~2,5 s × n° de tentative, jusqu'à ~70 s au total —
      //    le cron a 10 min, mieux vaut patienter que publier un relevé vide).
      var host = (a % 2 === 0) ? "query2" : "query1";
      var r2 = await rawFetch("https://" + host + ".finance.yahoo.com/v1/test/getcrumb", {        headers: { "User-Agent": UA, "Accept": "*/*", "Cookie": cookie }
      });
      if (r2.status !== 200) throw new Error("getcrumb HTTP " + r2.status);
      crumb = (await r2.text()).trim();
      if (crumb && cookie && crumb.length < 32 && /^[\w-]+$/.test(crumb)) return { cookie: cookie, crumb: crumb };
      lastErr = new Error("crumb/cookie inattendus (crumb=" + JSON.stringify(crumb.slice(0, 40)) + ")");
    } catch (e) { lastErr = e; }
    await sleep(2500 * a);
  }
  throw new Error("session Yahoo impossible : " + (lastErr ? lastErr.message : "?"));
}

// ---------- cotations ----------

async function quotesBatch(symbols, sess, maxAttempts) {
  var attempts = maxAttempts || 6;
  var lastErr = null;
  for (var a = 1; a <= attempts; a++) {
    if (outOfTime()) throw new Error("budget temps dépassé : batch v7/quote abandonné (" + symbols.length + " symboles)");
    try {
      var host = (a % 2 === 0) ? "query2" : "query1"; // alternance : les 429 de Yahoo vont par rafales
      var url = "https://" + host + ".finance.yahoo.com/v7/finance/quote?symbols=" + encodeURIComponent(symbols.join(",")) +
        "&crumb=" + encodeURIComponent(sess.crumb);
      var r = await rawFetch(url, { headers: { "User-Agent": UA, "Accept": "application/json", "Cookie": sess.cookie } });
      if (r.status === 429 || r.status >= 500) { await sleep(2000 * a); continue; }
      if (r.status !== 200) throw new Error("HTTP " + r.status + " sur v7/quote");
      var body = JSON.parse(await r.text());
      var res = (body.quoteResponse && body.quoteResponse.result) || null;
      if (!res) throw new Error("réponse v7/quote inattendue");
      return res;
    } catch (e) { lastErr = e; await sleep(1500 * a); }
  }
  throw new Error("batch v7/quote en échec (" + symbols.length + " symboles) : " + (lastErr ? lastErr.message : "?"));
}

// ---------- objectifs de cours (consensus analystes) + éléments éco/financiers (v4.0.6) ----------
// Yahoo v10/finance/quoteSummary?modules=financialData, 1 requête PAR valeur (pas de batch pour
// ce module). Fournit l'objectif de cours moyen/haut/bas, le nombre d'analystes, la recommandation
// ET les éléments économiques et financiers qui fondent les modèles des analystes : croissance du
// CA et du résultat, marge opérationnelle, ROE, dette/capitaux propres. Les objectifs bougent
// lentement : garde --max-age-targets-min (12 h côté workflows), et abandon immédiat au premier
// 429 — l'étape n'est JAMAIS bloquante, le relevé des cotes reste valide sans objectifs.

function finDataRow(fd) {
  function num(v) { return (v && typeof v.raw === "number" && isFinite(v.raw)) ? v.raw : null; }
  return {
    tp: num(fd.targetMeanPrice), tpLo: num(fd.targetLowPrice), tpHi: num(fd.targetHighPrice),
    tpN: num(fd.numberOfAnalystOpinions),
    rec: (typeof fd.recommendationKey === "string" && fd.recommendationKey) || null,
    gRev: num(fd.revenueGrowth), gEps: num(fd.earningsGrowth),
    mOp: num(fd.operatingMargins), roe: num(fd.returnOnEquity), de: num(fd.debtToEquity)
  };
}

// Requête v10 pour un symbole (null si la réponse est vide/mal formée).
async function finDataFor(sym, sess) {
  var host = (Math.random() < 0.5) ? "query1" : "query2";
  var url = "https://" + host + ".finance.yahoo.com/v10/finance/quoteSummary/" + encodeURIComponent(sym) +
    "?modules=financialData&crumb=" + encodeURIComponent(sess.crumb);
  var r = await rawFetch(url, { headers: { "User-Agent": UA, "Accept": "application/json", "Cookie": sess.cookie } });
  if (r.status !== 200) { var e = new Error("v10 HTTP " + r.status); e.status = r.status; throw e; }
  var body = JSON.parse(await r.text());
  var res = body && body.quoteSummary && body.quoteSummary.result && body.quoteSummary.result[0];
  return (res && res.financialData) ? finDataRow(res.financialData) : null;
}

// Collecte des objectifs pour tous les tickers. Retour { rows: {ticker: champs}, got, errors }.
// Au premier 429 : on ARRÊTE (les 429 de Yahoo vont par rafales — inutile de marteler 119 fois).
async function fetchTargets(symbols, sess, opts) {
  opts = opts || {};
  var rows = {}, got = 0, errors = 0, aborted = false;
  for (var i = 0; i < symbols.length; i++) {
    if (outOfTime()) { log("[targets] budget temps dépassé après " + i + "/" + symbols.length + " — objectifs partiels conservés"); aborted = true; break; }
    var sym = symbols[i];
    try {
      var row = await finDataFor(sym, sess);
      if (row && row.tp != null) { rows[sym] = row; got++; }
    } catch (e) {
      if (e && e.status === 429) { log("[targets] 429 Yahoo au symbole " + (i + 1) + "/" + symbols.length + " — étape interrompue, le relevé des cotes reste valide"); aborted = true; break; }
      errors++;
    }
    if (i % 20 === 19) log("[targets] " + (i + 1) + "/" + symbols.length + " traités (" + got + " objectifs)");
    await sleep(opts.paceMs != null ? opts.paceMs : 150);
  }
  if (!aborted && errors) log("[targets] " + errors + " réponses en erreur (ignorées)");
  return { rows: rows, got: got, errors: errors };
}

// Session + collecte, budget temps dédié (jamais de budget résiduel entre les étapes).
async function fetchTargetsAuto(symbols, opts) {
  opts = opts || {};
  setDeadline(opts.budgetTargetsMs || 100000);
  try {
    var sess = await yahooSession(opts.sessionAttempts || 4);
    log("[targets] session Yahoo OK — collecte des objectifs (" + symbols.length + " valeurs)");
    return await fetchTargets(symbols, sess, opts);
  } finally {
    setDeadline(null);
  }
}

// Fusion des objectifs dans un relevé : par ticker, champs courts sur chaque ligne.
// tpUpdated n'est posé QUE si la couverture est décente (≥ 60 % des lignes) — sinon null :
// le run suivant réessaiera au lieu de servir des objectifs périmés en silence.
function mergeTargets(q, targets) {
  if (!targets || !targets.rows) return q;
  q.list.forEach(function (e) {
    var t = targets.rows[e.y];
    if (!t) return;
    for (var k in t) if (Object.prototype.hasOwnProperty.call(t, k)) e[k] = t[k];
  });
  q.tpN = targets.got;
  q.tpUpdated = (targets.got >= Math.ceil(q.list.length * 0.6)) ? new Date().toISOString().replace(/\.\d+Z$/, "Z") : null;
  return q;
}

// Normalise une réponse v7/quote en ligne compacte (noms de champs courts — quotes.json est servi au
// navigateur : taille maîtrisée). null -> champ absent.
function quoteRow(q) {
  function num(v) { return (typeof v === "number" && isFinite(v)) ? v : null; }
  return {
    y: q.symbol,
    n: q.shortname || q.longname || q.symbol,
    px: num(q.regularMarketPrice),
    chg: num(q.regularMarketChangePercent),
    per: num(q.trailingPE),
    fper: num(q.forwardPE),
    dY: num(q.dividendYield),
    pb: num(q.priceToBook),
    cap: num(q.marketCap),
    t: num(q.regularMarketTime),
    st: q.marketState || null
  };
}

async function fetchQuotes(sb, opts) {
  opts = opts || {};
  if (!sb || !Array.isArray(sb.list) || sb.list.length < 100) throw new Error("sbf120.json invalide (" + (sb && sb.list ? sb.list.length : 0) + " valeurs)");
  var sess = await yahooSession(opts.sessionAttempts);
  log("[quotes] session Yahoo OK (crumb " + sess.crumb.slice(0, 4) + "…)");

  var bySym = {};
  var batch = 40;
  var symbols = sb.list.map(function (e) { return e.y; });
  for (var i = 0; i < symbols.length; i += batch) {
    if (outOfTime()) throw new Error("budget temps dépassé : relevé Yahoo interrompu après " + i + " valeurs");
    var part = symbols.slice(i, i + batch);
    var res = await quotesBatch(part, sess);
    res.forEach(function (q) { bySym[q.symbol] = quoteRow(q); });
    log("[quotes] batch " + (Math.floor(i / batch) + 1) + "/" + Math.ceil(symbols.length / batch) + " : " + res.length + "/" + part.length + " réponses");
    if (i + batch < symbols.length) await sleep(350);
  }
  // l'indice
  var idxRes = await quotesBatch(["^SBF120"], sess);
  var idx = idxRes && idxRes[0] ? quoteRow(idxRes[0]) : null;

  var list = [], missing = [];
  sb.list.forEach(function (e) {
    var q = bySym[e.y];
    if (!q || q.px == null) { missing.push(e.y); return; }
    list.push({
      y: e.y, n: q.n, mn: e.mn, g: e.g, isin: e.isin || "", approx: e.approx === true ? true : undefined,
      px: q.px, chg: q.chg, per: q.per, fper: q.fper, dY: q.dY, pb: q.pb, cap: q.cap, t: q.t
    });
  });

  var ratio = list.length / sb.list.length;
  if (ratio < (opts.minRatio || 0.9)) {
    throw new Error("trop peu de réponses Yahoo : " + list.length + "/" + sb.list.length + " — quotes.json précédent conservé");
  }

  return {
    updated: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    source: "Yahoo Finance (Euronext en différé ~15 min)",
    ok: true,
    n: list.length,
    missing: missing,
    sbUpdated: sb.updated || null,
    idx: idx && idx.px != null ? { px: idx.px, chg: idx.chg, t: idx.t } : null,
    list: list
  };
}

// ---------- repli TradingView (quand Yahoo sature en 429 — rafales constatées le 09/11/2026) ----------
// Le scanner public scanner.tradingview.com ne demande ni clé ni cookie et couvre Euronext Paris,
// en différé ~15 min comme Yahoo. Colonnes vérifiées le 09/11/2026 : close, change,
// price_earnings_ttm, dividends_yield_current, price_book_ratio, market_cap_basic répondent ;
// price_earnings_forecast_fy0 reste null sur EURONEXT (→ fper null, l'UI affiche « — »).
// Limites honnêtes : ~8/120 tickers absents du scanner (MT, SOLB, TF1…) → missing[] ;
// le SBF 120 n'y existe pas → indice de repli = CAC 40 (EURONEXT:PX1), nommé dans idx.name
// (affiché tel quel par l'UI — jamais d'indice CAC 40 déguisé en SBF 120).

var TV_SCAN_URL = "https://scanner.tradingview.com/france/scan";
var TV_COLUMNS = ["name", "close", "change", "price_earnings_ttm", "price_earnings_forecast_fy0",
  "dividends_yield_current", "price_book_ratio", "market_cap_basic", "sector"];

function tvTicker(y) { return "EURONEXT:" + String(y).replace(/\.PA$/i, "").toUpperCase(); } // le scanner TV exige des MAJUSCULES
function tvNum(v) { return (typeof v === "number" && isFinite(v)) ? v : null; }

async function tvScan(tickers, maxAttempts) {
  var attempts = maxAttempts || 3;
  var lastErr = null;
  for (var a = 1; a <= attempts; a++) {
    try {
      var r = await rawFetch(TV_SCAN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Referer": "https://fr.tradingview.com/", "User-Agent": UA },
        body: JSON.stringify({ symbols: { tickers: tickers, query: { types: [] } }, columns: TV_COLUMNS })
      });
      if (r.status !== 200) throw new Error("scanner HTTP " + r.status);
      var body = JSON.parse(await r.text());
      if (!body || !Array.isArray(body.data)) throw new Error("réponse scanner inattendue");
      return body.data;
    } catch (e) { lastErr = e; await sleep(1500 * a); }
  }
  throw new Error("scanner TV en échec (" + tickers.length + " tickers) : " + (lastErr ? lastErr.message : "?"));
}

async function fetchQuotesTv(sb, opts) {
  opts = opts || {};
  if (!sb || !Array.isArray(sb.list) || sb.list.length < 100) throw new Error("sbf120.json invalide (" + (sb && sb.list ? sb.list.length : 0) + " valeurs)");
  var tickers = sb.list.map(function (e) { return tvTicker(e.y); });
  var rows = {};
  for (var i = 0; i < tickers.length; i += 60) {
    if (outOfTime()) throw new Error("budget temps dépassé : relevé TradingView interrompu");
    var part = tickers.slice(i, i + 60);
    var data = await tvScan(part);
    data.forEach(function (row) { rows[String(row.s).split(":")[1].toUpperCase()] = row.d; });
    log("[quotes/TV] batch " + (Math.floor(i / 60) + 1) + "/" + Math.ceil(tickers.length / 60) + " : " + data.length + "/" + part.length + " réponses");
  }
  var list = [], missing = [];
  sb.list.forEach(function (e) {
    var key = String(e.y).replace(/\.PA$/i, "").toUpperCase();
    var d = rows[key];
    if (!d || tvNum(d[1]) == null) { missing.push(e.y); return; }
    list.push({
      y: e.y, n: e.n, mn: e.mn, g: e.g, isin: e.isin || "", approx: e.approx === true ? true : undefined,
      px: d[1], chg: tvNum(d[2]), per: tvNum(d[3]), fper: tvNum(d[4]),
      dY: tvNum(d[5]), pb: tvNum(d[6]), cap: tvNum(d[7]), t: null,
      sec: (typeof d[8] === "string" && d[8]) ? d[8] : null
    });
  });
  if (list.length / sb.list.length < (opts.minRatio || 0.9)) {
    throw new Error("trop peu de réponses TradingView : " + list.length + "/" + sb.list.length + " — quotes.json précédent conservé");
  }
  // indice : SBF 120 absent du scanner → repli CAC 40, explicitement nommé (idx.name affiché par l'UI).
  // Règle v4.0.4 : un relevé de repli SANS indice est REJETÉ (avant écriture) — le validateur
  // exige idx.px, on ne publie jamais un quotes.json destiné à être invalidé. 2 tentatives,
  // puis échec explicite : le relevé précédent est conservé, le cycle suivant réessaiera.
  var idx = null;
  for (var k = 0; k < 2 && !idx; k++) {
    try {
      var idxData = await tvScan(["EURONEXT:PX1"]);
      if (idxData[0] && tvNum(idxData[0].d[1]) != null) {
        idx = { px: idxData[0].d[1], chg: tvNum(idxData[0].d[2]), t: null,
          name: "CAC 40 (repli — SBF 120 absent de TradingView)" };
      }
    } catch (eIdx) { log("[quotes/TV] indice : tentative " + (k + 1) + "/2 en échec — " + eIdx.message); }
  }
  if (!idx) throw new Error("indice de repli (CAC 40) indisponible — relevé rejeté (règle v4.0.4 : jamais de quotes.json sans indice)");
  return {
    updated: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    source: "TradingView (repli — Yahoo indisponible), Euronext en différé ~15 min",
    ok: true,
    n: list.length,
    missing: missing,
    sbUpdated: sb.updated || null,
    idx: idx,
    list: list
  };
}

// Bascule v4.0.3 : Yahoo d'abord, repli TradingView si Yahoo sature (429 par rafales).
// v4.0.4 : budget temps PAR ÉTAPE — l'étape Yahoo ne doit jamais consommer celui du repli
// (constaté en réel : 8 tentatives getcrumb ≈ 90 s, il ne restait plus rien pour TradingView).
async function fetchQuotesAuto(sb, opts) {
  opts = opts || {};
  var eYahoo = null;
  try {
    try {
      setDeadline(opts.budgetYahooMs || 75000);
      return await fetchQuotes(sb, opts);
    } catch (e) { eYahoo = e; }
    setDeadline(opts.budgetTvMs || 60000);
    log("[quotes] Yahoo en échec (" + eYahoo.message + ") — repli TradingView");
    var out = await fetchQuotesTv(sb, opts);
    log("[quotes] relevé TradingView OK : " + out.n + " valeurs");
    return out;
  } finally {
    setDeadline(null); // jamais de budget résiduel entre deux collectes
  }
}

// Âge d'un relevé en minutes (null si absent/invalide) — pour la garde anti-doublon.
function ageMinutesOf(updatedIso) {
  if (!updatedIso) return null;
  var t = Date.parse(updatedIso);
  if (!isFinite(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 60000));
}

async function main() {
  var dest = path.join(__dirname, "..", "quotes.json");
  // v4.0.4 anti-double collecte : --max-age-min=N (utilisé par le secours de pages.yml) —
  // si le quotes.json existant a moins de N minutes, on ne re-collecte PAS (le cron quotes.yml
  // couvre déjà la cadence). Sans l'option, on collecte toujours (workflow cotes dédié).
  // v4.0.6 : --max-age-targets-min=N — les objectifs d'analystes bougent lentement : si le
  // tpUpdated du fichier existant a moins de N minutes, l'étape objectifs est sautée (le module
  // v10 est PAR valeur : 120 requêtes à ne refaire que 1×/12 h).
  var maxAge = null, maxAgeTargets = null;
  process.argv.forEach(function (a) {
    var m = /^--max-age-min=(\d+)$/.exec(a);
    if (m) maxAge = parseInt(m[1], 10);
    var t = /^--max-age-targets-min=(\d+)$/.exec(a);
    if (t) maxAgeTargets = parseInt(t[1], 10);
  });
  try {
    var sb = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "sbf120.json"), "utf8"));
    var prev = null;
    try { prev = JSON.parse(fs.readFileSync(dest, "utf8")); } catch (eRead) { /* pas de quotes.json précédent */ }
    var targetsFresh = function () {
      var ageT = prev ? ageMinutesOf(prev.tpUpdated) : null;
      return ageT !== null && (maxAgeTargets === null || ageT < maxAgeTargets);
    };
    if (maxAge !== null && prev) {
      var age = ageMinutesOf(prev.updated);
      if (age !== null && age < maxAge) {
        log("[quotes] relevé précédent frais (" + age + " min < " + maxAge + ") — pas de nouvelle collecte (anti-doublon)");
        // les cotes sont fraîches mais les objectifs peuvent être périmés : étape ciblée,
        // on ne touche à RIEN d'autre du fichier (cotes, indice, composition d'origine).
        if (targetsFresh()) { log("[targets] objectifs précédents frais — rien à faire"); return; }
        if (!prev.list || !prev.list.length) return;
        try {
          var t0 = await fetchTargetsAuto(prev.list.map(function (e) { return e.y; }), {});
          if (t0.got > 0) {
            mergeTargets(prev, t0);
            fs.writeFileSync(dest, JSON.stringify(prev));
            log("[targets] écrit : " + t0.got + " objectifs (relevé des cotes inchangé)");
          } else log("[targets] aucun objectif récupéré — fichier inchangé");
        } catch (eT) { log("[targets] étape en échec (non bloquant) : " + eT.message); }
        return;
      }
    }
    setDeadline(null); // fetchQuotesAuto pose son budget par étape (Yahoo puis repli)
    var out = await fetchQuotesAuto(sb, {});
    // étape objectifs (v4.0.6) : non bloquante. Si les objectifs du fichier précédent sont
    // frais, on les REPORTe sur le nouveau relevé (l'objectif ne dépend pas du relevé en cours) ;
    // sinon on collecte (Yahoo v10 — le repli TradingView n'a pas d'objectifs, la colonne est null).
    if (prev && targetsFresh() && prev.list) {
      var carried = { rows: {}, got: 0 };
      prev.list.forEach(function (e) { if (e.tp != null) { carried.rows[e.y] = { tp: e.tp, tpLo: e.tpLo, tpHi: e.tpHi, tpN: e.tpN, rec: e.rec, gRev: e.gRev, gEps: e.gEps, mOp: e.mOp, roe: e.roe, de: e.de }; carried.got++; } });
      if (carried.got >= Math.ceil(out.list.length * 0.6)) {
        mergeTargets(out, carried); out.tpUpdated = prev.tpUpdated;
        log("[targets] objectifs précédents reportés sur le nouveau relevé (" + carried.got + ")");
      }
    }
    if (out.tpUpdated == null) {
      try {
        var t1 = await fetchTargetsAuto(out.list.map(function (e) { return e.y; }), {});
        mergeTargets(out, t1);
        log("[targets] " + t1.got + "/" + out.list.length + " objectifs intégrés" + (out.tpUpdated ? "" : " (couverture insuffisante — tpUpdated non posé)"));
      } catch (eT) { log("[targets] étape en échec (non bloquant) : " + eT.message); }
    }
    fs.writeFileSync(dest, JSON.stringify(out));
    log("[quotes] écrit : " + out.n + " valeurs" + (out.missing.length ? " (manquantes : " + out.missing.join(", ") + ")" : "") + " -> " + dest);
  } catch (e) {
    console.error("[quotes] ÉCHEC — quotes.json précédent conservé : " + e.message);
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { yahooSession: yahooSession, quotesBatch: quotesBatch, quoteRow: quoteRow, fetchQuotes: fetchQuotes, setFetchForTests: setFetchForTests, fetchQuotesTv: fetchQuotesTv, tvScan: tvScan, tvTicker: tvTicker, fetchQuotesAuto: fetchQuotesAuto, ageMinutesOf: ageMinutesOf, setDeadline: setDeadline, finDataRow: finDataRow, finDataFor: finDataFor, fetchTargets: fetchTargets, fetchTargetsAuto: fetchTargetsAuto, mergeTargets: mergeTargets };
