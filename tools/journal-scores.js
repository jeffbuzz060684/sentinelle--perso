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
var DATA_PATH = path.join(__dirname, "..", "data.json");
var TOP_N = 20;

// v4.0.10 : le top journalisé est LA liste unique 🏆 Long terme (qualité 55 + entrée 35 + initiés 10).
// buildJournalEntry(q, data) : data = data.json (initiés FR) lu au mieux — absent/corrompu ⇒ bonus 0,
// le score 🏆 se calcule quand même (0 point d'initiés, jamais de malus).
function buildJournalEntry(q, data) {
  if (!q || !q.list || !q.list.length) return null;
  var val = RI.oppScores(RI.valScores(q.list));
  var bonus = { byName: {}, byIsin: {} };
  try {
    if (data && Array.isArray(data.fr) && data.fr.length) {
      var since30 = RI.isoDay(new Date(Date.now() - RI.CFG.SIGN_DAYS * 86400000));
      bonus = RI.insiderFrBonus(data.fr, { since: since30 });
    }
  } catch (eBonus) { /* bonus = vide : top 🏆 sans composante initiés, honnête */ }
  var enr = RI.sbfEnrich(val, bonus);
  var ltTop = RI.sbfSort(enr.filter(function (e) { return e.ltScore != null; }), "lt").slice(0, TOP_N);
  var valTop = RI.sbfSort(enr.filter(function (e) { return e.score != null; }), "val").slice(0, TOP_N);
  var px = {};
  q.list.forEach(function (e) { if (isFinite(e.px)) px[e.y] = Math.round(e.px * 100) / 100; });
  return {
    date: RI.isoDay(new Date(q.updated || Date.now())),
    updated: q.updated || null,
    source: q.source || null,
    idx: (q.idx && isFinite(q.idx.px)) ? Math.round(q.idx.px * 100) / 100 : null,
    // v4.0.12 (audit) : l'IDENTITÉ du benchmark est conservée dans chaque ligne — comparer un
    // relevé SBF 120 (Yahoo) à un repli CAC 40 (TradingView) n'est pas une comparaison.
    idxName: (q.idx && typeof q.idx.name === "string" && q.idx.name) ? q.idx.name : null,
    cov: Array.isArray(q.list) ? q.list.length : 0, // couverture du jour (titres dans le relevé)
    px: px,
    lt: ltTop.map(function (e) {
      return { y: e.y, ltScore: e.ltScore, qScore: e.qScore, score: e.score, ins: e.ins || 0, pos52: e.pos52 != null ? e.pos52 : null };
    }),
    val: valTop.map(function (e) { return { y: e.y, score: e.score }; })
  };
}

// une ligne par jour : le relevé de 14 h et celui de 16 h ne doivent pas doubler la ligne.
// v4.0.12 (audit) : le relevé LE PLUS RÉCENT du jour REMPLACE la ligne du jour — le snapshot
// de 14 h ne survit pas à celui de 16 h ; toujours 1 ligne par date, mais la plus fraîche.
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

// v4.0.12 : fusion texte + entrée — remplace la ligne du même jour s'il y en a une, sinon ajoute.
// Pure : testable sans toucher au fichier. Renvoie { text, replaced }.
function upsertEntry(prev, entry) {
  var lines = (prev && prev.trim()) ? prev.trim().split("\n") : [];
  for (var i = lines.length - 1; i >= 0; i--) {
    var same = false;
    try { var last = JSON.parse(lines[i]); same = !!(last && last.date === entry.date); } catch (e) { same = false; }
    if (same) {
      return { text: lines.slice(0, i).concat([JSON.stringify(entry)]).concat(lines.slice(i + 1)).join("\n") + "\n", replaced: true };
    }
  }
  return { text: (prev || "") + (prev && !prev.endsWith("\n") ? "\n" : "") + JSON.stringify(entry) + "\n", replaced: false };
}

function appendEntry(entry) {
  var prev = fs.existsSync(JOURNAL_PATH) ? fs.readFileSync(JOURNAL_PATH, "utf8") : "";
  var r = upsertEntry(prev, entry);
  fs.writeFileSync(JOURNAL_PATH, r.text);
  console.log("[journal] " + entry.date + (r.replaced ? " : ligne du jour REMPLACÉE par le relevé le plus récent — " : " : ") +
    "top " + entry.lt.length + " 🏆 + top " + entry.val.length + " 📐, " +
    Object.keys(entry.px).length + " cours, indice " + entry.idx + (entry.idxName ? " (" + entry.idxName + ")" : ""));
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
      // v4.0.12 (audit) : ne comparer que des périodes utilisant le MÊME indice — un relevé
      // SBF 120 (Yahoo) face à un repli CAC 40 (TradingView) n'est pas une comparaison.
      // Les lignes sans idxName (ancien format) restent comparées : on ne peut pas les identifier.
      if (l.idxName && later.idxName && l.idxName !== later.idxName) {
        console.log("[journal] " + l.date + " +" + h[0] + " : benchmark différent (" + l.idxName + " → " + later.idxName + ") — comparaison ignorée");
        return;
      }
      var bench = later.idx / l.idx - 1;
      var dur = Math.round((Date.parse(later.date) - t) / 86400000); // durée réellement observée
      var px0 = l.px || {};
      var top = function (arr) { return arr.slice(0, 5).map(function (t2) { return { y: t2.y, px: px0[t2.y] }; }); };
      var o = l.lt || l.opp; // v4.0.10 : clé "lt" (lignes anciennes : "opp")
      var oF = o && o.length ? fwd(top(o), later.px || {}, bench) : null;
      var v = l.val && l.val.length ? fwd(top(l.val), later.px || {}, bench) : null;
      console.log("[journal] " + l.date + " +" + h[0] + " (observé " + dur + " j, benchmark " + (l.idxName || "indice non identifié (ancien format)") + ", couverture " + (l.cov || "?") + " titres) : " +
        (oF == null ? "🏆 n/a" : "🏆 top 5 : " + (oF.mean * 100).toFixed(1) + " % (couverts " + oF.n + "/5) vs " + (bench * 100).toFixed(1) + " % → " + ((oF.mean - bench) * 100).toFixed(1) + " pt") +
        (v == null ? "" : " | 📐 top 5 : " + (v.mean * 100).toFixed(1) + " % (couverts " + v.n + "/5) → " + ((v.mean - bench) * 100).toFixed(1) + " pt"));
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
  var data = null; // data.json (initiés FR) au mieux : absent ⇒ bonus 0 dans le top 🏆
  try { data = JSON.parse(fs.readFileSync(DATA_PATH, "utf8")); } catch (eData) { data = null; }
  var entry = buildJournalEntry(q, data);
  if (!entry) { console.error("[journal] quotes.json sans list — journal ignoré"); process.exit(1); }
  appendEntry(entry);
}

if (require.main === module) main();
module.exports = { buildJournalEntry: buildJournalEntry, shouldAppend: shouldAppend, upsertEntry: upsertEntry, appendEntry: appendEntry, report: report, JOURNAL_PATH: JOURNAL_PATH };
