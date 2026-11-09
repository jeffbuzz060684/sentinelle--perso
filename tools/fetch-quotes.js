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

async function rawFetch(url, opts) {
  if (!FETCH_IMPL) throw new Error("fetch indisponible");
  return FETCH_IMPL(url, opts);
}

// ---------- cookie + crumb Yahoo ----------

async function yahooSession(maxAttempts) {
  var attempts = maxAttempts || 8;
  var cookie = "", crumb = "";
  var lastErr = null;
  for (var a = 1; a <= attempts; a++) {
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
      var r2 = await rawFetch("https://" + host + ".finance.yahoo.com/v1/test/getcrumb", {
        headers: { "User-Agent": UA, "Accept": "*/*", "Cookie": cookie }
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
      y: e.y, n: q.n, mn: e.mn, g: e.g, isin: e.isin || "",
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
  "dividends_yield_current", "price_book_ratio", "market_cap_basic"];

function tvTicker(y) { return "EURONEXT:" + String(y).replace(/\.PA$/i, ""); }
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
      y: e.y, n: e.n, mn: e.mn, g: e.g, isin: e.isin || "",
      px: d[1], chg: tvNum(d[2]), per: tvNum(d[3]), fper: tvNum(d[4]),
      dY: tvNum(d[5]), pb: tvNum(d[6]), cap: tvNum(d[7]), t: null
    });
  });
  if (list.length / sb.list.length < (opts.minRatio || 0.9)) {
    throw new Error("trop peu de réponses TradingView : " + list.length + "/" + sb.list.length + " — quotes.json précédent conservé");
  }
  // indice : SBF 120 absent du scanner → repli CAC 40, explicitement nommé (idx.name affiché par l'UI)
  var idx = null;
  try {
    var idxData = await tvScan(["EURONEXT:PX1"]);
    if (idxData[0] && tvNum(idxData[0].d[1]) != null) {
      idx = { px: idxData[0].d[1], chg: tvNum(idxData[0].d[2]), t: null,
        name: "CAC 40 (repli — SBF 120 absent de TradingView)" };
    }
  } catch (eIdx) { log("[quotes/TV] indice indisponible : " + eIdx.message); }
  return {
    updated: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    source: "TradingView (repli — Yahoo indisponible), Euronext en différé ~15 min",
    ok: true,
    n: list.length,
    missing: missing,
    idx: idx,
    list: list
  };
}

async function main() {
  var dest = path.join(__dirname, "..", "quotes.json");
  try {
    var sb = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "sbf120.json"), "utf8"));
    var out;
    try {
      out = await fetchQuotes(sb, {});
    } catch (eYahoo) {
      // Yahoo sature par rafales (429) : repli TradingView plutôt qu'un relevé vide.
      log("[quotes] Yahoo en échec (" + eYahoo.message + ") — repli TradingView");
      out = await fetchQuotesTv(sb, {});
      log("[quotes] relevé TradingView OK : " + out.n + " valeurs");
    }
    fs.writeFileSync(dest, JSON.stringify(out));
    log("[quotes] écrit : " + out.n + " valeurs" + (out.missing.length ? " (manquantes : " + out.missing.join(", ") + ")" : "") + " -> " + dest);
  } catch (e) {
    console.error("[quotes] ÉCHEC — quotes.json précédent conservé : " + e.message);
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { yahooSession: yahooSession, quotesBatch: quotesBatch, quoteRow: quoteRow, fetchQuotes: fetchQuotes, setFetchForTests: setFetchForTests, fetchQuotesTv: fetchQuotesTv, tvScan: tvScan, tvTicker: tvTicker };
