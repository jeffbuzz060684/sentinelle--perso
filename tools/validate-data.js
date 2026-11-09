#!/usr/bin/env node
"use strict";
// Validation de data.json avant tout déploiement — échec = pas de mise en ligne
var fs = require("fs");
var path = process.argv[2] || "data.json";
var RI = require("../logic.js");

function fail(msg) { console.error("VALIDATION ÉCHOUÉE : " + msg); process.exit(1); }

var data;
try { data = JSON.parse(fs.readFileSync(path, "utf8")); } catch (e) { fail("data.json illisible : " + e.message); }
if (!data || typeof data !== "object") fail("data.json : pas un objet");
if (!/^\d{4}-\d{2}-\d{2}T/.test(data.updated || "")) fail("updated absent ou non ISO : " + data.updated);
["fr", "us", "frS", "usS"].forEach(function (src) {
  if (!Array.isArray(data[src])) fail(src + " : pas un tableau");
  data[src].forEach(function (r, i) {
    var w = src + "[" + i + "] : ";
    if (!r.id) fail(w + "id manquant");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.dateOp || "")) fail(w + "dateOp invalide : " + r.dateOp);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.datePub || "")) fail(w + "datePub invalide : " + r.datePub);
    if (!isFinite(r.montant) || r.montant < 0 || r.montant > 1e10) fail(w + "montant incohérent : " + r.montant);
    if (!r.societe) fail(w + "societe manquant");
    if (r.dateOp > r.datePub) console.log("  note : " + w + "opération après publication (données AMF telles quelles)");
    if (RI.daysBetween(r.datePub, RI.isoDay(new Date())) === null) fail(w + "dates non parsables");
  });
  // tri décroissant garanti
  for (var k = 1; k < data[src].length; k++) {
    if (String(data[src][k - 1].datePub) < String(data[src][k].datePub)) fail(src + " : tri décroissant violé en " + k);
  }
});
// aucune donnée personnelle ne doit jamais y figurer (dépôt public)
["reserve", "paliersDone", "phone", "email", "password"].forEach(function (k) {
  if (k in data) fail("clé interdite dans data.json : " + k);
});
// pistes v3.3 (facultatif — écrites par le workflow) : structure et cohérence.
// Nouveau format : { updated, us: [...], fr: [...] } ; ancien { updated, picks: [...] } accepté.
if (data.picks !== undefined) {
  if (!data.picks || typeof data.picks !== "object") fail("picks : structure invalide");
  if (!/^\d{4}-\d{2}-\d{2}T/.test(data.picks.updated || "")) fail("picks.updated absent ou non ISO : " + data.picks.updated);
  var validateUsPick = function (p, i, w) {
    if (!p.ticker) fail(w + "ticker manquant");
    if (!p.societe) fail(w + "societe manquante");
    if (!isFinite(p.score) || p.score < 0 || p.score > 20) fail(w + "score invalide : " + p.score);
    if (!p.insider || !isFinite(p.insider.score) || p.insider.score < 0 || p.insider.score > 10) fail(w + "score initiés invalide");
    if (!p.fund || !isFinite(p.fund.score) || p.fund.score < 0 || p.fund.score > 10) fail(w + "score fondamentaux invalide");
    if (!p.insider.buys || !p.insider.buyers) fail(w + "détail initiés incomplet");
  };
  var validateFrPick = function (p, i, w) {
    if (!p.societe) fail(w + "societe manquante");
    if (!isFinite(p.score) || p.score < 0 || p.score > 10) fail(w + "score invalide (/10) : " + p.score);
    if (!p.insider || !isFinite(p.insider.score) || p.insider.score < 0 || p.insider.score > 10) fail(w + "score initiés invalide");
    if (!p.insider.buys || !p.insider.buyers) fail(w + "détail initiés incomplet");
  };
  var checkSorted = function (list) {
    for (var k = 1; k < list.length; k++) {
      if (list[k - 1].score < list[k].score) fail("picks : tri décroissant violé en " + k);
    }
  };
  if (Array.isArray(data.picks.picks)) { // ancien format v3.2
    data.picks.picks.forEach(function (p, i) { validateUsPick(p, i, "picks[" + i + "] : "); });
    checkSorted(data.picks.picks);
  }
  if (Array.isArray(data.picks.us)) {
    data.picks.us.forEach(function (p, i) { validateUsPick(p, i, "picks.us[" + i + "] : "); });
    checkSorted(data.picks.us);
  }
  if (Array.isArray(data.picks.fr)) {
    data.picks.fr.forEach(function (p, i) { validateFrPick(p, i, "picks.fr[" + i + "] : "); });
    checkSorted(data.picks.fr);
  }
  if (!Array.isArray(data.picks.us) && !Array.isArray(data.picks.picks) && !Array.isArray(data.picks.fr)) {
    fail("picks : ni us ni fr ni picks (ancien) — structure inconnue");
  }
}
console.log("data.json OK : " + data.fr.length + " achats FR + " + data.us.length + " achats US + " +
  (data.frS ? data.frS.length : 0) + " ventes FR + " + (data.usS ? data.usS.length : 0) + " ventes US, relevé " + data.updated +
  (data.picks ? " + " + data.picks.picks.length + " piste(s)" : ""));
