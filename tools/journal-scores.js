#!/usr/bin/env node
"use strict";
// journal-scores.js — v4.0.8 : journal quotidien des scores, pour la validation.
// Motivation (revue du 09/11) : « Yahoo ne donne pas de fondamentaux historiques, donc pas de
// vrai backtest. En revanche le pipeline peut enregistrer chaque jour le top 20 et mesurer le
// rendement à 3, 6 et 12 mois contre l'indice. C'est la seule validation honnête, et elle est
// autonome. Commence maintenant. »
// Fichier : journal-scores.jsonl (1 ligne JSON par jour ouvré). Chaque ligne garde le cours des
// 120 valeurs ET l'indice : les rendements futurs se calculent sans biais du survivant (une
// valeur sortie du top 20 — ou de l'indice — reste mesurable tant qu'elle a coté ce jour-là).
// Sans composante qualité mesurable (Yahoo en rafale 429 etc.), la ligne enregistre quand
// même le top 20 du score 📐 : l'historique démarre aujourd'hui, pas quand Yahoo voudra bien
// répondre. ~7 Ko/jour, ~1,7 Mo/an — coût délibéré, assumé.

var fs = require("fs");
var path = require("path");
var RI = require("../logic.js");

var QUOTES_PATH = path.join(__dirname, "..", "quotes.json");
var JOURNAL_PATH = path.join(__dirname, "..", "journal-scores.jsonl");
var TOP_N = 20;

function buildJournalEntry(q) {
  if (!q || !q.list || !q.list.length) return null;
  var val = RI.oppScores(RI.valScores(q.list));
  var oppTop = RI.sbfSort(val.filter(function (e) { return e.oScore != null; }), "opp").slice(0, TOP_N);
  var valTop = RI.sbfSort(val.filter(function (e) { return e.score != null; }), "val").slice(0, TOP_N);
  var px = {};
  q.list.forEach(function (e) { if (isFinite(e.px)) px[e.y] = Math.round(e.px * 100) / 100; });
  return {
    date: RI.isoDay(new Date(q.updated || Date.now())),
    updated: q.updated || null,
    source: q.source || null,
    idx: (q.idx && isFinite(q.idx.px)) ? Math.round(q.idx.px * 100) / 100 : null,
    px: px,
    opp: oppTop.map(function (e) {
      return { y: e.y, oScore: e.oScore, qScore: e.qScore, score: e.score, pos52: e.pos52 != null ? e.pos52 : null };
    }),
    val: valTop.map(function (e) { return { y: e.y, score: e.score }; })
  };
}

// une ligne par jour : le relevé de 14 h et celui de 16 h ne doivent pas doubler la ligne
function shouldAppend(text, date) {
  if (!text || !text.trim()) return true;
  var lines = text.trim().split("\n");
  for (var i = lines.length - 1; i >= 0; i--) {
    try {
      var last = JSON.parse(lines[i]);
      if (last && last.date === date) return false;
    } catch (e) { /* ligne corrompue : on continue à chercher */ }
  }
  return true;
}

function appendEntry(entry) {
  var prev = fs.existsSync(JOURNAL_PATH) ? fs.readFileSync(JOURNAL_PATH, "utf8") : "";
  if (!shouldAppend(prev, entry.date)) {
    console.log("[journal] ligne du " + entry.date + " déjà présente — pas de doublon");
    return false;
  }
  fs.writeFileSync(JOURNAL_PATH, prev + (prev && !prev.endsWith("\n") ? "\n" : "") + JSON.stringify(entry) + "\n");
  console.log("[journal] " + entry.date + " : top " + entry.opp.length + " 💎 + top " + entry.val.length + " 📐, " +
    Object.keys(entry.px).length + " cours, indice " + entry.idx);
  return true;
}

// --report : rendements du top 5 💎 et du top 5 📐 contre l'indice, pour chaque ligne assez vieille
function report() {
  if (!fs.existsSync(JOURNAL_PATH)) { console.log("[journal] aucun fichier — rien à rapporter"); return; }
  var lines;
  try { lines = fs.readFileSync(JOURNAL_PATH, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse); }
  catch (e) { console.error("[journal] journal illisible : " + e.message); return; }
  function fwd(top, laterPx, bench) {
    var rs = [], n = 0;
    top.forEach(function (t) {
      var p0 = null;
      // le cours du jour J vient du top (journal récent) ou de la carte des cours (v2 du format)
      p0 = (t.px != null) ? t.px : null;
      var p1 = laterPx[t.y];
      if (p0 > 0 && p1 > 0) { rs.push(p1 / p0 - 1); n++; }
    });
    if (!rs.length || bench == null) return null;
    var m = rs.reduce(function (a, b) { return a + b; }, 0) / rs.length;
    return { mean: m, n: n, bench: bench };
  }
  var HORIZONS = [["3 mois", 90], ["6 mois", 180], ["12 mois", 360]];
  HORIZONS.forEach(function (h) {
    var n = 0;
    lines.forEach(function (l, i) {
      if (!l.idx) return;
      var t = Date.parse(l.date);
      var later = null;
      for (var j = i + 1; j < lines.length; j++) {
        if (Date.parse(lines[j].date) >= t + h[1] * 86400000) { later = lines[j]; break; }
      }
      if (!later) return;
      var bench = later.idx / l.idx - 1;
      var px0 = l.px || {};
      var top = function (arr) { return arr.slice(0, 5).map(function (t2) { return { y: t2.y, px: px0[t2.y] }; }); };
      var o = l.opp && l.opp.length ? fwd(top(l.opp), later.px || {}, bench) : null;
      var v = l.val && l.val.length ? fwd(top(l.val), later.px || {}, bench) : null;
      console.log("[journal] " + l.date + " +" + h[0] + " : " +
        (o == null ? "💎 n/a" : "💎 top 5 : " + (o.mean * 100).toFixed(1) + " % (n=" + o.n + ") vs indice " + (bench * 100).toFixed(1) + " % → " + ((o.mean - bench) * 100).toFixed(1) + " pt") +
        (v == null ? "" : " | 📐 top 5 : " + (v.mean * 100).toFixed(1) + " % → " + ((v.mean - bench) * 100).toFixed(1) + " pt"));
      n++;
    });
    if (!n) console.log("[journal] +" + h[0] + " : aucune ligne assez ancienne (journal démarré " + (lines[0] && lines[0].date) + ")");
  });
}

function main() {
  if (process.argv.indexOf("--report") > -1) { report(); return; }
  var q;
  try { q = JSON.parse(fs.readFileSync(QUOTES_PATH, "utf8")); }
  catch (e) { console.error("[journal] quotes.json illisible — journal ignoré : " + e.message); process.exit(1); }
  var entry = buildJournalEntry(q);
  if (!entry) { console.error("[journal] quotes.json sans list — journal ignoré"); process.exit(1); }
  appendEntry(entry);
}

if (require.main === module) main();
module.exports = { buildJournalEntry: buildJournalEntry, shouldAppend: shouldAppend, appendEntry: appendEntry, report: report, JOURNAL_PATH: JOURNAL_PATH };
