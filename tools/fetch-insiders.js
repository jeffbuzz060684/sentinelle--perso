#!/usr/bin/env node
"use strict";
// Sentinelle perso — relevé automatique des achats ET ventes d'initiés (aucune dépendance, Node 18+)
//   FR : https://transactions-amf.swaoo.com/ (déclarations AMF, requête POST natures Acquisition+Cession)
//   US : SEC EDGAR full-text search (Form 4) + téléchargement des XML officiels (achats code P, ventes code S)
// Écrit data.json (affiché par la PWA : fr/us = achats, frS/usS = ventes) et state.json (accessions déjà traitées).
// Une panne de source ne casse jamais le run : on garde les données précédentes.

var fs = require("fs");
var RI = require("../logic.js");
var CFG = RI.CFG;

// La SEC exige un contact réel dans le User-Agent (format "Nom contact@domaine") ;
// surchargeable via la variable d'environnement RI_SEC_CONTACT (secret GitHub du même nom).
var UA = "SentinellePerso research " + (process.env.RI_SEC_CONTACT || "jeffbuzz060684@users.noreply.github.com");
var BUDGET = parseInt(process.env.RI_BUDGET || "", 10) || CFG.US_FETCH_BUDGET;

// injectable pour les tests (simuler 429/500 sans réseau)
var FETCH_IMPL = (typeof fetch === "function") ? fetch : null;
function setFetchForTests(f) { FETCH_IMPL = f; }

function log() { console.log.apply(console, arguments); }

function fetchText(url, opts, timeoutMs) {
  var t = timeoutMs || 30000;
  if (!FETCH_IMPL) return Promise.reject(new Error("fetch indisponible"));
  var timer = null;
  var p;
  try {
    var ac = new AbortController();
    timer = setTimeout(function () { ac.abort(); }, t);
    // fusion des en-têtes : les en-têtes par défaut (User-Agent) ne doivent jamais être écrasés
    var merged = Object.assign({
      "User-Agent": UA,
      "Accept": "*/*"
    }, (opts && opts.headers) || {});
    var init = Object.assign({}, opts || {}, { headers: merged, signal: ac.signal });
    p = FETCH_IMPL(url, init)
      .then(function (r) {
        if (!r.ok) {
          var err = new Error("HTTP " + r.status + " " + url);
          // 429/503 : respecter Retry-After si la SEC le renvoie
          if (r.status === 429 || r.status === 503) {
            var ra = r.headers && r.headers.get && r.headers.get("retry-after");
            if (ra && isFinite(ra)) err.retryAfterSec = Math.min(parseInt(ra, 10) || 5, 60);
          }
          throw err;
        }
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
      var wait = e && e.retryAfterSec ? e.retryAfterSec * 1000 : 1500;
      return new Promise(function (res) { setTimeout(res, wait); }).then(function () { return attempt(i + 1); });
    });
  };
  return attempt(1);
}

function pad(n) { return (n < 10 ? "0" : "") + n; }

// ---------- FR : swaoo ----------
function frQuery(debut, fin, page) {
  var body = "f_nature%5B%5D=Acquisition&f_nature%5B%5D=Cession" +
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
  var rawTotal = 0;
  // la page peut contenir toutes natures (le filtre serveur n'est pas garanti) :
  // on pagine tant qu'il y a des lignes brutes, le filtre buy/sell se fait dans parseSwaoo.
  var run = function () {
    return retry(function () { return frQuery(debut, fin, page); }).then(function (html) {
      var raw = (html.match(/Déclaration n°/g) || []).length; // lignes toutes natures
      rawTotal += raw;
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
    var kept = rows.filter(function (r) { return r.montant >= CFG.FR_MIN_EUR; });
    // canari du scraper : la page contenait des déclarations brutes mais AUCUNE n'est reconnue
    // → le HTML de swaoo a probablement changé → on échoue le run FR (données précédentes conservées)
    if (kept.length === 0 && rawTotal > 0) {
      throw new Error("CANARI swaoo : " + rawTotal + " déclarations brutes vues, 0 ligne parsée — structure HTML changée ?");
    }
    return kept;
  });
}

// entries "accession|YYYY-MM-DD" ; les anciennes entrées sans date héritent de la date du jour
// (elles sortiront de la fenêtre STATE_DAYS) — purge par date, plus par plafond arbitraire
function purgeProcessed(list, nowMs, keepDays) {
  var today = RI.isoDay(new Date(nowMs));
  var min = RI.isoDay(new Date(nowMs - (keepDays || CFG.STATE_DAYS) * 86400000));
  var out = [];
  for (var i = 0; i < (list || []).length; i++) {
    var e = String(list[i] || "");
    var j = e.indexOf("|");
    out.push(j > 0 ? e : e + "|" + today);
  }
  return out.filter(function (e) { return e.slice(e.indexOf("|") + 1) >= min; });
}

// ---------- US : EDGAR ----------
function ftsQuery(startdt, enddt, from) {
  var url = "https://efts.sec.gov/LATEST/search-index?q=a&forms=4" +
    "&dateRange=custom&startdt=" + startdt + "&enddt=" + enddt +
    "&from=" + from + "&size=100";
  return fetchText(url, null, 30000).then(function (txt) { return RI.parseFts(txt); });
}

function fetchUs(now, state, prevBuys, prevSells) {
  var startdt = RI.isoDay(new Date(now - 3 * 86400000)); // fenêtre 3 jours, la dédup fait le reste
  var enddt = RI.isoDay(new Date(now));
  var today = RI.isoDay(new Date(now));
  var processed = {};
  // v3 : migration — les XML traités par l'ancien parseur n'ont pas leurs ventes extraites.
  // On vide la mémoire US une seule fois : les accessions de la fenêtre 3 j sont re-téléchargées
  // et re-parsées des deux côtés (l'historique US des ventes commence à cette date, honnêtement).
  if (state.v !== 3) {
    log("US : migration v3 (ventes) — mémoire des accessions réinitialisée");
    state.processedUs = [];
    state.v = 3;
  }
  // purge par date (STATE_DAYS) au lieu d'un plafond arbitraire ; entrées "accession|date"
  var stored = purgeProcessed(state.processedUs || [], now, CFG.STATE_DAYS);
  var pkey = function (e) { var j = e.indexOf("|"); return j > 0 ? e.slice(0, j) : e; };
  stored.forEach(function (e) { processed[pkey(e)] = 1; });
  var hits = [];
  var capped = false;
  var run = function (from) {
    return retry(function () { return ftsQuery(startdt, enddt, from); }).then(function (batch) {
      for (var i = 0; i < batch.length; i++) hits.push(batch[i]);
      if (batch.length === 100 && from < 500) return run(from + 100); // plafond 600 hits par run
      if (batch.length === 100) capped = true; // fenêtre 3 j non couverte en entier
      return null;
    });
  };
  var buys = (prevBuys || []).slice();
  var sells = (prevSells || []).slice();
  var done = 0, skipped = 0, fetched = 0, errors = 0, nBuys = 0, nSells = 0;
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  return run(0).then(function () {
    if (capped) log("US : PLAFOND 600 hits atteint — couverture partielle de la fenêtre 3 j");
    var todo = [];
    for (var i = 0; i < hits.length; i++) {
      var h = hits[i];
      if (!h.accession || processed[h.accession]) { skipped++; continue; }
      todo.push(h);
    }
    todo = todo.slice(0, BUDGET);
    if (todo.length === hits.length && hits.length >= BUDGET) log("US : budget " + BUDGET + " atteint — le reste sera vu au run suivant");
    var chain = Promise.resolve();
    todo.forEach(function (h) {
      chain = chain.then(function () {
        var url = RI.form4Url(h.cik, h.accession, h.file);
        return retry(function () { return fetchText(url, null, 25000); }, 1)
          .then(function (xml) {
            fetched++;
            var f4 = RI.parseForm4(xml);
            var rows = RI.usRowsFrom(Object.assign({}, h, { url: url }), f4);
            rows.forEach(function (r) {
              if (r.side === "sell") { sells.push(r); nSells++; }
              else { buys.push(r); nBuys++; }
            });
            // marquée traitée UNIQUEMENT si téléchargée et parsée : un 429/503/500 de la SEC
            // ne fait plus perdre le dépôt — il sera retéléchargé au run suivant
            processed[h.accession] = 1;
          })
          .catch(function () { errors++; }) // un XML inaccessible n'arrête jamais le run, et n'est PAS marqué
          .then(function () {
            done++;
            if (done % 20 === 0) log("US " + done + "/" + todo.length);
            return sleep(CFG.US_RL_MS);
          });
      });
    });
    return chain.then(function () {
      if (errors > 0) log("US : " + errors + " XML en erreur — NON marqués traités, retentés au prochain run");
      // canari du parseur US : des XML téléchargés mais zéro ligne extraite → structure changée ?
      var canary = (fetched > 100 && nBuys + nSells === 0);
      if (canary) log("US : CANARI — " + fetched + " XML téléchargés, 0 ligne extraite (achats comme ventes) — parseur cassé ?");
      var list = Object.keys(processed).map(function (a) { return a + "|" + today; });
      state.processedUs = purgeProcessed(list, now, CFG.STATE_DAYS);
      return { buys: buys, sells: sells, nBuys: nBuys, nSells: nSells, hits: hits.length, fetched: fetched, skipped: skipped, errors: errors, capped: capped, canary: canary };
    });
  });
}

// ---------- main ----------
function main() {
  var now = Date.now();
  var data = { updated: new Date(now).toISOString(), fr: [], us: [], frS: [], usS: [] };
  var state = { processedUs: [] };
  try { data = JSON.parse(fs.readFileSync("data.json", "utf8")); } catch (e) { }
  try { state = JSON.parse(fs.readFileSync("state.json", "utf8")); } catch (e) { }
  if (!data.fr) data.fr = [];
  if (!data.us) data.us = [];
  if (!data.frS) data.frS = [];
  if (!data.usS) data.usS = [];
  var frOk = true, usOk = true;
  // détection d'effondrement : une liste qui perd > 50 % en un run (2 h) alors qu'elle
  // était fournie = source ou parseur cassé → on garde la version précédente
  var guard = function (prev, next, what) {
    if (prev.length >= 20 && next.length < prev.length * 0.5) {
      log("CRITIQUE " + what + " : " + prev.length + " → " + next.length + " lignes (-" +
        Math.round(100 - (100 * next.length) / prev.length) + " %) — version précédente conservée");
      return { keep: true, rows: prev };
    }
    return { keep: false, rows: next };
  };
  var prevFr = data.fr.slice(), prevFrS = data.frS.slice(), prevUs = data.us.slice(), prevUsS = data.usS.slice();

  log("== Sentinelle perso — relevé du " + new Date(now).toISOString() + " ==");
  return fetchFr(now).then(function (frRows) {
    var frBuys = RI.rowsOfSide(frRows, "buy");
    var frSells = RI.rowsOfSide(frRows, "sell");
    log("FR : " + frBuys.length + " acquisitions + " + frSells.length + " cessions sur la fenêtre de " + CFG.FR_DAYS + " j");
    var mB = RI.mergeRows(prevFr, frBuys, CFG.KEEP_DAYS, CFG.MAX_ROWS, now);
    var mS = RI.mergeRows(prevFrS, frSells, CFG.KEEP_DAYS, CFG.MAX_ROWS, now);
    var gB = guard(prevFr, mB, "FR achats"), gS = guard(prevFrS, mS, "FR ventes");
    if (gB.keep || gS.keep) frOk = false;
    data.fr = gB.rows;
    data.frS = gS.rows;
    data.frUpdated = new Date(Date.now()).toISOString();
    log("FR total consolidé : " + data.fr.length + " achats + " + data.frS.length + " cessions");
  }).catch(function (e) {
    frOk = false;
    log("FR : ECHEC source (" + e.message + ") — données précédentes conservées");
  }).then(function () {
    return fetchUs(now, state, data.us, data.usS);
  }).then(function (usRes) {
    var mB = RI.mergeRows(usRes.buys, [], CFG.KEEP_DAYS, CFG.MAX_ROWS, now);
    var mS = RI.mergeRows(usRes.sells, [], CFG.KEEP_DAYS, CFG.MAX_ROWS, now);
    var gB = guard(prevUs, mB, "US achats"), gS = guard(prevUsS, mS, "US ventes");
    // canari parseur US : garder la version précédente plutôt que vider les listes
    if (usRes.canary && (prevUs.length > 0 || prevUsS.length > 0)) {
      usOk = false;
      log("US : canari parseur — listes précédentes conservées");
      data.us = prevUs;
      data.usS = prevUsS;
    } else {
      if (gB.keep || gS.keep) usOk = false;
      data.us = gB.rows;
      data.usS = gS.rows;
      data.usUpdated = new Date(Date.now()).toISOString();
    }
    log("US : " + usRes.hits + " Form 4 vus, " + usRes.fetched + " XML téléchargés, " +
      usRes.skipped + " déjà traités, " + usRes.errors + " erreurs (retentées), " + usRes.nBuys + " achats + " + usRes.nSells + " ventes extraits" + (usRes.capped ? " [PLAFOND]" : ""));
    log("US total consolidé : " + data.us.length + " achats + " + data.usS.length + " ventes");
  }).catch(function (e) {
    usOk = false;
    log("US : ECHEC source (" + e.message + ") — données précédentes conservées");
  }).then(function () {
    data.updated = new Date(Date.now()).toISOString();
    data.frOk = frOk;
    data.usOk = usOk;
    data.counts = { fr: data.fr.length, us: data.us.length, frS: data.frS.length, usS: data.usS.length };
    var out = JSON.stringify(data, null, 1);
    fs.writeFileSync("data.json", out);
    fs.writeFileSync("state.json", JSON.stringify(state));
    log("data.json écrit : " + data.fr.length + " achats FR + " + data.us.length + " achats US + " +
      data.frS.length + " ventes FR + " + data.usS.length + " ventes US" +
      (frOk && usOk ? "" : " [échec source : " + (frOk ? "US" : (usOk ? "FR" : "FR+US")) + "]"));
    log("Fréquence : toutes les 2 h en jours ouvrés (workflow insiders.yml)");
  });
}

if (require.main === module) {
  main().then(function () { process.exit(0); }).catch(function (e) {
    console.error("ERREUR FATALE", e);
    process.exit(1);
  });
}

module.exports = { fetchFr: fetchFr, fetchUs: fetchUs, main: main, UA: UA, setFetchForTests: setFetchForTests, purgeProcessed: purgeProcessed };
