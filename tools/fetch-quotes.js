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
  var attempts = maxAttempts || 5;
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
      //    on exige un statut 200, sinon on retente.
      var r2 = await rawFetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
        headers: { "User-Agent": UA, "Accept": "*/*", "Cookie": cookie }
      });
      if (r2.status !== 200) throw new Error("getcrumb HTTP " + r2.status);
      crumb = (await r2.text()).trim();
      if (crumb && cookie && crumb.length < 32 && /^[\w-]+$/.test(crumb)) return { cookie: cookie, crumb: crumb };
      lastErr = new Error("crumb/cookie inattendus (crumb=" + JSON.stringify(crumb.slice(0, 40)) + ")");
    } catch (e) { lastErr = e; }
    await sleep(1500 * a);
  }
  throw new Error("session Yahoo impossible : " + (lastErr ? lastErr.message : "?"));
}

// ---------- cotations ----------

async function quotesBatch(symbols, sess, maxAttempts) {
  var attempts = maxAttempts || 5;
  var url = "https://query1.finance.yahoo.com/v7/finance/quote?symbols=" + encodeURIComponent(symbols.join(",")) +
    "&crumb=" + encodeURIComponent(sess.crumb);
  var lastErr = null;
  for (var a = 1; a <= attempts; a++) {
    try {
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

async function main() {
  var dest = path.join(__dirname, "..", "quotes.json");
  try {
    var sb = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "sbf120.json"), "utf8"));
    var out = await fetchQuotes(sb, {});
    fs.writeFileSync(dest, JSON.stringify(out));
    log("[quotes] écrit : " + out.n + " valeurs" + (out.missing.length ? " (manquantes : " + out.missing.join(", ") + ")" : "") + " -> " + dest);
  } catch (e) {
    console.error("[quotes] ÉCHEC — quotes.json précédent conservé : " + e.message);
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { yahooSession: yahooSession, quotesBatch: quotesBatch, quoteRow: quoteRow, fetchQuotes: fetchQuotes, setFetchForTests: setFetchForTests };
