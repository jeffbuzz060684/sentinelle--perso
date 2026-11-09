#!/usr/bin/env node
"use strict";
// Sentinelle perso — relevé automatique des achats d'initiés (aucune dépendance, Node 18+)
//   FR : https://transactions-amf.swaoo.com/ (déclarations AMF, requête POST nature=Acquisition)
//   US : SEC EDGAR full-text search (Form 4) + téléchargement des XML officiels
// Écrit data.json (affiché par la PWA) et state.json (accessions déjà traitées).
// Une panne de source ne casse jamais le run : on garde les données précédentes.

var fs = require("fs");
var RI = require("../logic.js");
var CFG = RI.CFG;

var UA = "SentinellePerso research contact@example.com"; // format attendu par la SEC : "Sample Company Name AdminContact@domain"
var BUDGET = parseInt(process.env.RI_BUDGET || "", 10) || CFG.US_FETCH_BUDGET;

function log() { console.log.apply(console, arguments); }

function fetchText(url, opts, timeoutMs) {
  var t = timeoutMs || 30000;
  var ctrl = new AbortController ? null : null; // Node >=16 : AbortController global
  var timer = null;
  var p;
  try {
    var ac = new AbortController();
    timer = setTimeout(function () { ac.abort(); }, t);
    p = fetch(url, Object.assign({ headers: { "User-Agent": UA, "Accept": "*/*" }, signal: ac.signal }, opts || {}))
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status + " " + url);
        return r.text();
      });
  } catch (e) {
    return Promise.reject(e);
  }
  if (timer) p = p.finally ? p.finally(function () { clearTimeout(timer); }) : p;
  return p;
}

function retry(fn, tries) {
  var n = tries || 2;
  var attempt = function (i) {
    return fn().catch(function (e) {
      if (i >= n) throw e;
      return new Promise(function (res) { setTimeout(res, 1500); }).then(function () { return attempt(i + 1); });
    });
  };
  return attempt(1);
}

function pad(n) { return (n < 10 ? "0" : "") + n; }

// ---------- FR : swaoo ----------
function frQuery(debut, fin, page) {
  var body = "f_nature%5B%5D=Acquisition" +
    "&f_date_publication_debut=" + encodeURIComponent(debut) +
    "&f_date_publication_fin=" + encodeURIComponent(fin) +
    "&f_montant_min=" + CFG.FR_MIN_EUR +
    "&f_page=" + page;
  return fetchText("https://transactions-amf.swaoo.com/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body
  }, 40000);
}

function fetchFr(now) {
  var debut = RI.frDate(new Date(now - CFG.FR_DAYS * 86400000));
  var fin = RI.frDate(new Date(now));
  var rows = [];
  var seen = {};
  var page = 1;
  // la page peut contenir toutes natures (le filtre serveur n'est pas garanti) :
  // on pagine tant qu'il y a des lignes brutes, le filtre acquisition se fait dans parseSwaoo.
  var run = function () {
    return retry(function () { return frQuery(debut, fin, page); }).then(function (html) {
      var raw = (html.match(/Déclaration n°/g) || []).length; // lignes toutes natures
      var parsed = RI.parseSwaoo(html);
      for (var i = 0; i < parsed.length; i++) {
        if (!seen[parsed[i].id]) { seen[parsed[i].id] = 1; rows.push(parsed[i]); }
      }
      if (RI.frNextPage(raw, page)) { page++; return run(); }
      return null;
    });
  };
  return run().then(function () {
    // re-vérification locale du montant (le filtre serveur suffit, mais on ne fait confiance qu'aux données parsées)
    return rows.filter(function (r) { return r.montant >= CFG.FR_MIN_EUR; });
  });
}

// ---------- US : EDGAR ----------
function ftsQuery(startdt, enddt, from) {
  var url = "https://efts.sec.gov/LATEST/search-index?q=a&forms=4" +
    "&dateRange=custom&startdt=" + startdt + "&enddt=" + enddt +
    "&from=" + from + "&size=100";
  return fetchText(url, null, 30000).then(function (txt) { return RI.parseFts(txt); });
}

function fetchUs(now, state, prevRows) {
  var startdt = RI.isoDay(new Date(now - 3 * 86400000)); // fenêtre 3 jours, la dédup fait le reste
  var enddt = RI.isoDay(new Date(now));
  var processed = {};
  (state.processedUs || []).forEach(function (a) { processed[a] = 1; });
  var hits = [];
  var run = function (from) {
    return retry(function () { return ftsQuery(startdt, enddt, from); }).then(function (batch) {
      for (var i = 0; i < batch.length; i++) hits.push(batch[i]);
      if (batch.length === 100 && from < 500) return run(from + 100); // plafond 600 hits par run
      return null;
    });
  };
  var buys = (prevRows || []).slice();
  var done = 0, skipped = 0, fetched = 0, errors = 0;
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  return run(0).then(function () {
    var todo = [];
    for (var i = 0; i < hits.length; i++) {
      var h = hits[i];
      if (!h.accession || processed[h.accession]) { skipped++; continue; }
      todo.push(h);
    }
    todo = todo.slice(0, BUDGET);
    var chain = Promise.resolve();
    todo.forEach(function (h) {
      chain = chain.then(function () {
        var url = RI.form4Url(h.cik, h.accession, h.file);
        return retry(function () { return fetchText(url, null, 25000); }, 1)
          .then(function (xml) {
            fetched++;
            var f4 = RI.parseForm4(xml);
            var rows = RI.usRowsFrom(Object.assign({}, h, { url: url }), f4);
            rows.forEach(function (r) { buys.push(r); });
          })
          .catch(function () { errors++; }) // un XML inaccessible n'arrête jamais le run
          .then(function () {
            done++;
            if (done % 20 === 0) log("US " + done + "/" + todo.length);
            return sleep(CFG.US_RL_MS);
          });
      });
    });
    return chain.then(function () {
      // les accessions vues sont marquées traitées (qu'elles contiennent des achats ou non)
      todo.forEach(function (h) { processed[h.accession] = 1; });
      var list = Object.keys(processed);
      if (list.length > 20000) list = list.slice(list.length - 20000); // fenêtre glissante
      state.processedUs = list;
      return { rows: buys, hits: hits.length, fetched: fetched, skipped: skipped, errors: errors };
    });
  });
}

// ---------- main ----------
function main() {
  var now = Date.now();
  var data = { updated: new Date(now).toISOString(), fr: [], us: [] };
  var state = { processedUs: [] };
  try { data = JSON.parse(fs.readFileSync("data.json", "utf8")); } catch (e) { }
  try { state = JSON.parse(fs.readFileSync("state.json", "utf8")); } catch (e) { }
  if (!data.fr) data.fr = [];
  if (!data.us) data.us = [];
  var frOk = true, usOk = true;

  log("== Sentinelle perso — relevé du " + new Date(now).toISOString() + " ==");
  return fetchFr(now).then(function (frRows) {
    log("FR : " + frRows.length + " acquisitions sur la fenêtre de " + CFG.FR_DAYS + " j");
    data.fr = RI.mergeRows(data.fr, frRows, CFG.KEEP_DAYS, CFG.MAX_ROWS, now);
    log("FR total consolidé : " + data.fr.length);
  }).catch(function (e) {
    frOk = false;
    log("FR : ECHEC source (" + e.message + ") — données précédentes conservées");
  }).then(function () {
    return fetchUs(now, state, data.us);
  }).then(function (usRes) {
    data.us = RI.mergeRows(usRes.rows, [], CFG.KEEP_DAYS, CFG.MAX_ROWS, now);
    log("US : " + usRes.hits + " Form 4 vus, " + usRes.fetched + " XML téléchargés, " +
      usRes.skipped + " déjà traités, " + usRes.errors + " erreurs");
    log("US total consolidé : " + data.us.length);
  }).catch(function (e) {
    usOk = false;
    log("US : ECHEC source (" + e.message + ") — données précédentes conservées");
  }).then(function () {
    data.updated = new Date(Date.now()).toISOString();
    data.frOk = frOk;
    data.usOk = usOk;
    data.counts = { fr: data.fr.length, us: data.us.length };
    var out = JSON.stringify(data, null, 1);
    fs.writeFileSync("data.json", out);
    fs.writeFileSync("state.json", JSON.stringify(state));
    log("data.json écrit : " + data.fr.length + " FR + " + data.us.length + " US");
    log("Fréquence : toutes les 2 h en jours ouvrés (workflow insiders.yml)");
  });
}

if (require.main === module) {
  main().then(function () { process.exit(0); }).catch(function (e) {
    console.error("ERREUR FATALE", e);
    process.exit(1);
  });
}

module.exports = { fetchFr: fetchFr, fetchUs: fetchUs, main: main, UA: UA };
