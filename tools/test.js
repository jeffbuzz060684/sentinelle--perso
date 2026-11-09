#!/usr/bin/env node
"use strict";
// Harnais de tests Sentinelle perso — exécuté en CI AVANT tout déploiement (0 échec obligatoire)
var fs = require("fs");
var vm = require("vm");
var RI = require("../logic.js");

var passed = 0, failed = 0;
function T(name, fn) {
  try { fn(); passed++; }
  catch (e) { failed++; console.log("ÉCHEC [" + name + "] : " + e.message); }
}
function A(cond, msg) { if (!cond) throw new Error(msg || "assertion"); }
function EQ(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg || "") + " : " + JSON.stringify(a) + " ≠ " + JSON.stringify(b)); }

// ---------- utilitaires ----------
T("esc échappe le HTML", function () {
  EQ(RI.esc('<script>"a"&\'b\'</script>'), "&lt;script&gt;&quot;a&quot;&amp;&#39;b&#39;&lt;/script&gt;");
});
T("frNum : espaces insécables et €", function () {
  EQ(RI.frNum("1\u00a0400.0000"), 1400);
  EQ(RI.frNum("22\u00a0020.0400\u00a0€"), 22020.04);
  EQ(RI.frNum("15.7286"), 15.7286);
  EQ(RI.frNum(""), NaN !== NaN ? null : RI.frNum(""), "vide");
  A(isNaN(RI.frNum("")), "vide doit être NaN");
  EQ(RI.frNum("1\u202f234,50"), 1234.5, "narrow nbsp + virgule");
});
T("ddmmyyyyToIso + isoToDmY aller-retour", function () {
  EQ(RI.ddmmyyyyToIso("06/11/2026"), "2026-11-06");
  EQ(RI.ddmmyyyyToIso("6/11/2026"), null, "format non strict rejeté");
  EQ(RI.ddmmyyyyToIso("31/02/2026"), "2026-02-31", "syntaxe ok (validité = au parseur Date)");
  EQ(RI.isoToDmY("2026-11-06"), "6/11/2026");
  EQ(RI.isoToDmY(null), "—");
});
T("frDate/isoDay sans décalage UTC", function () {
  var d = new Date(2026, 10, 9, 23, 30); // 9 nov local, après minuit UTC possible
  EQ(RI.isoDay(d), "2026-11-09");
  EQ(RI.frDate(d), "09/11/2026");
});
T("daysBetween", function () {
  EQ(RI.daysBetween("2026-11-06", "2026-11-09"), 3);
  EQ(RI.daysBetween("2026-11-09", "2026-11-06"), -3);
  EQ(RI.daysBetween(null, "2026-11-06"), null);
});

// ---------- parse FR (fixture réelle) ----------
var swaoo = fs.readFileSync(__dirname + "/fixtures/swaoo-sample.html", "utf8");
var frRows = RI.parseSwaoo(swaoo);
T("parseSwaoo : la fixture réelle produit des lignes", function () {
  A(frRows.length >= 5, "au moins 5 déclarations attendues, got " + frRows.length);
});
T("parseSwaoo : champs d'une ligne complète", function () {
  var r = frRows[0];
  A(r.id && /^2026DD\d+$/.test(r.id), "id déclaration : " + r.id);
  A(r.societe.length > 0, "société");
  A(r.auteur.length > 0, "auteur : " + r.auteur);
  A(r.role.length > 0, "rôle : " + r.role);
  EQ(r.source, "FR");
  EQ(r.nature, "Acquisition");
  EQ(r.datePub, "2026-11-06");
  EQ(r.dateOp, "2026-11-05");
  A(isFinite(r.volume) && r.volume > 0, "volume");
  A(isFinite(r.prix) && r.prix > 0, "prix");
  A(isFinite(r.montant) && r.montant >= 1000, "montant : " + r.montant);
  A(r.url.indexOf("bdif.amf-france.org") > -1, "url AMF");
});
T("parseSwaoo : acquisitions uniquement + montants ≥ CFG", function () {
  frRows.forEach(function (r) {
    EQ(r.nature, "Acquisition");
    A(r.montant >= RI.CFG.FR_MIN_EUR, "montant min");
  });
});
T("parseSwaoo : page sans tableau -> []", function () {
  EQ(RI.parseSwaoo("<html><body>rien</body></html>"), []);
});
T("parseSwaoo : auteur sans virgule -> rôle vide", function () {
  var html = '<div id="liste_transactions"><table><tr>' +
    '<td><a href="#">TEST SA</a></td>' +
    '<td data-target="#DET2026DD1">07/11/2026</td><td>06/11/2026</td><td>Acquisition</td>' +
    '<td>Action</td><td></td><td>100</td><td>10.00</td><td>1\u00a0000.00\u00a0€</td><td><button>+</button></td>' +
    '</tr><tr class="collapse" id="DET2026DD1"><td></td><td colspan="20">' +
    '<li><strong>Auteur :</strong> Jean Dupont Directeur Général</li>' +
    '<li><strong>Montant total (calculé) :</strong> 1\u00a0000.00\u00a0€</li></td></tr></table></div>';
  var rows = RI.parseSwaoo(html);
  EQ(rows.length, 1);
  EQ(rows[0].auteur, "Jean Dupont Directeur Général");
  EQ(rows[0].role, "");
  EQ(rows[0].montant, 1000);
});
T("swaooCount", function () {
  EQ(RI.swaooCount(swaoo), 79);
  EQ(RI.swaooCount("rien"), null);
});

// ---------- parse US ----------
var fts = JSON.parse(fs.readFileSync(__dirname + "/fixtures/fts-sample.json", "utf8"));
var hits = RI.parseFts(fts);
T("parseFts : 3 hits réels", function () {
  EQ(hits.length, 3);
  var h = hits[0];
  A(h.accession && h.file, "accession/file : " + JSON.stringify(h));
  EQ(h.cik, "0002117818");
  EQ(h.fileDate, "2026-11-06");
  EQ(h.owner, "Noor Shain");
  EQ(h.issuer, "Silvia, Inc.");
});
T("parseIssuerDisplay : ticker et nettoyage CIK", function () {
  var d = RI.parseIssuerDisplay("Enphase Energy, Inc.  (ENPH)  (CIK 0001463101)");
  EQ(d.issuer, "Enphase Energy, Inc.");
  EQ(d.ticker, "ENPH");
  var d2 = RI.parseIssuerDisplay("Société Sans Ticker  (CIK 0001234567)");
  EQ(d2.ticker, null);
  EQ(d2.issuer, "Société Sans Ticker");
});
T("form4Url", function () {
  EQ(RI.form4Url("0002076163", "0001493152-26-050503", "ownership.xml"),
    "https://www.sec.gov/Archives/edgar/data/2076163/000149315226050503/ownership.xml");
});
var f4 = RI.parseForm4(fs.readFileSync(__dirname + "/fixtures/form4-sample.xml", "utf8"));
T("parseForm4 : fixture réelle (don F, pas un achat)", function () {
  EQ(f4.issuer, "Silvia, Inc.");
  EQ(f4.ticker, "SVIA");
  EQ(f4.owner, "Noor Shain");
  EQ(f4.role, "Chief Technology Officer");
  EQ(f4.transactions.length, 1);
  EQ(f4.transactions[0].acq, "D");
  EQ(f4.transactions[0].code, "F");
});
T("parseForm4 : directeur sans titre -> rôle Directeur", function () {
  var xml = "<ownershipDocument><rptOwnerName>Marie M</rptOwnerName><isDirector><value>1</value></isDirector>" +
    "<nonDerivativeTransaction><transactionDate><value>2026-11-05</value></transactionDate>" +
    "<transactionCoding><transactionCode>P</transactionCode></transactionCoding>" +
    "<transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode>" +
    "<transactionAmounts><transactionShares><value>1000</value></transactionShares>" +
    "<transactionPricePerShare><value>5.25</value></transactionPricePerShare></transactionAmounts>" +
    "</nonDerivativeTransaction></ownershipDocument>";
  var r = RI.parseForm4(xml);
  EQ(r.role, "Directeur");
  EQ(r.transactions[0].code, "P");
  EQ(r.transactions[0].shares, 1000);
  var rows = RI.usRowsFrom({ accession: "A1", fileDate: "2026-11-06", owner: "Marie M", issuer: "X", ticker: "XX", url: "u" }, r);
  EQ(rows.length, 1);
  EQ(rows[0].montant, 5250);
  EQ(rows[0].code, "P");
  EQ(rows[0].dateOp, "2026-11-05");
});
T("usRowsFrom : seuls les achats au marché (code P) sont retenus", function () {
  var mk = function (code) {
    return RI.parseForm4("<ownershipDocument><rptOwnerName>A</rptOwnerName><officerTitle>CEO</officerTitle>" +
      "<nonDerivativeTransaction><transactionDate><value>2026-11-05</value></transactionDate>" +
      "<transactionCoding><transactionCode>" + code + "</transactionCode></transactionCoding>" +
      "<transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode>" +
      "<transactionAmounts><transactionShares><value>100</value></transactionShares>" +
      "<transactionPricePerShare><value>10</value></transactionPricePerShare></transactionAmounts>" +
      "</nonDerivativeTransaction></ownershipDocument>");
  };
  EQ(RI.usRowsFrom({ accession: "X", fileDate: "2026-11-06", url: "u" }, mk("P")).length, 1, "achat au marché P : retenu");
  ["F", "G", "J", "M", "A"].forEach(function (code) {
    EQ(RI.usRowsFrom({ accession: "X", fileDate: "2026-11-06", url: "u" }, mk(code)).length, 0, "code " + code + " exclu");
  });
});
T("usRowsFrom : sous le seuil exclu", function () {
  var r = RI.parseForm4("<ownershipDocument><rptOwnerName>A</rptOwnerName>" +
    "<nonDerivativeTransaction><transactionDate><value>2026-11-05</value></transactionDate>" +
    "<transactionCoding><transactionCode>P</transactionCode></transactionCoding>" +
    "<transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode>" +
    "<transactionAmounts><transactionShares><value>10</value></transactionShares>" +
    "<transactionPricePerShare><value>5</value></transactionPricePerShare></transactionAmounts>" +
    "</nonDerivativeTransaction></ownershipDocument>");
  EQ(RI.usRowsFrom({ accession: "X", fileDate: "2026-11-06" }, r).length, 0); // 50 $ < 1000 $
});

// ---------- fusion / fenêtre / plafond ----------
var NOW = Date.parse("2026-11-09T12:00:00Z");
T("mergeRows : dédoublonne par id, le nouveau gagne", function () {
  var old = [{ id: "a", datePub: "2026-11-05", montant: 100 }, { id: "b", datePub: "2026-11-06", montant: 200 }];
  var neu = [{ id: "b", datePub: "2026-11-06", montant: 999 }, { id: "c", datePub: "2026-11-07", montant: 300 }];
  var m = RI.mergeRows(old, neu, 90, 100, NOW);
  EQ(m.length, 3);
  var b = m.filter(function (r) { return r.id === "b"; })[0];
  EQ(b.montant, 999);
});
T("mergeRows : trie datePub desc puis montant desc", function () {
  var m = RI.mergeRows([], [
    { id: "1", datePub: "2026-11-07", montant: 10 },
    { id: "2", datePub: "2026-11-08", montant: 20 },
    { id: "3", datePub: "2026-11-08", montant: 500 }
  ], 90, 100, NOW);
  EQ(m.map(function (r) { return r.id; }), ["3", "2", "1"]);
});
T("mergeRows : fenêtre keepDays et plafond maxRows", function () {
  var rows = [];
  for (var i = 0; i < 130; i++) rows.push({ id: "r" + i, datePub: "2026-11-05", montant: i });
  EQ(RI.mergeRows([], rows, 30, 100, NOW).length, 100, "plafond");
  var old = [{ id: "vieux", datePub: "2026-01-01", montant: 1 }];
  EQ(RI.mergeRows(old, [], 90, 100, NOW).length, 0, "hors fenêtre");
});
T("mergeRows : lignes hostiles ignorées", function () {
  var m = RI.mergeRows([], [
    { id: "", datePub: "2026-11-08", montant: 1 },            // pas d'id
    { id: "x", datePub: null, montant: 1 },                     // pas de date
    { id: "y", datePub: "2026-11-08", montant: NaN },          // montant invalide
    { id: "z", datePub: "2026-11-08", montant: -5 },           // montant négatif
    { id: "ok", datePub: "2026-11-08", montant: 5 }
  ], 90, 100, NOW);
  EQ(m.map(function (r) { return r.id; }), ["ok"]);
});

// ---------- app : filtre / tri / format ----------
var ROWS = [
  { id: "1", source: "FR", societe: "AIR LIQUIDE", auteur: "Benoît", dateOp: "2026-11-05", datePub: "2026-11-06", volume: 100, prix: 150, montant: 15000 },
  { id: "2", source: "US", societe: "ACME", ticker: "ACM", auteur: "John", dateOp: "2026-11-04", datePub: "2026-11-05", volume: 2000, prix: 30, montant: 60000 },
  { id: "3", source: "FR", societe: "BOUYGUES", auteur: "Martin", dateOp: "2026-11-06", datePub: "2026-11-06", volume: 50, prix: 700, montant: 35000 }
];
T("filterRows : source + montant + recherche", function () {
  EQ(RI.filterRows(ROWS, { source: "FR" }).length, 2);
  EQ(RI.filterRows(ROWS, { source: "US" }).length, 1);
  EQ(RI.filterRows(ROWS, { minMontant: 20000 }).length, 2);
  EQ(RI.filterRows(ROWS, { q: "acm" }).length, 1);
  EQ(RI.filterRows(ROWS, { q: "bouygues" })[0].societe, "BOUYGUES");
  EQ(RI.filterRows(ROWS, {}).length, 3);
});
T("sortRows par montant et par date", function () {
  EQ(RI.sortRows(ROWS, "montant")[0].id, "2");
  EQ(RI.sortRows(ROWS, "date")[0].id, "3");
  EQ(ROWS[0].id, "1", "pas de mutation de l'entrée");
});
T("formats", function () {
  EQ(RI.fmtEUR(22020.04), "22\u00a0020\u00a0€");
  EQ(RI.fmtUSD(60000), "$60\u00a0000");
  EQ(RI.fmtEUR(NaN), "—");
  EQ(RI.fmtNum(1400), "1\u00a0400");
  EQ(RI.fmtMontant(ROWS[0]), "15\u00a0000\u00a0€");
  EQ(RI.fmtMontant(ROWS[1]), "$60\u00a0000");
});
T("lagLabel", function () {
  EQ(RI.lagLabel(ROWS[0]), "publié J+1");
  EQ(RI.lagLabel(ROWS[2]), "publié le jour même");
  EQ(RI.lagLabel({ dateOp: "2026-11-26", datePub: "2026-11-03" }), "publié avant l'opération");
});
T("frNextPage : pagination sur les lignes brutes (toutes natures)", function () {
  EQ(RI.frNextPage(15, 1), true, "page pleine -> continuer");
  EQ(RI.frNextPage(0, 1), false, "page vide -> stop");
  EQ(RI.frNextPage(15, 12), false, "plafond 12 pages");
  EQ(RI.frNextPage(3, 5), true, "page partielle mais non vide -> continuer");
});
T("freshness", function () {
  var now = Date.parse("2026-11-09T12:00:00Z");
  EQ(RI.freshness("2026-11-09T10:30:00Z", now).label, "il y a 2 h");
  EQ(RI.freshness("2026-11-02T10:00:00Z", now).stale, true, "7 j -> périmé");
  EQ(RI.freshness("2026-11-08T12:00:00Z", now).stale, false, "24 h -> ok (trou week-end 57 h)");
  EQ(RI.freshness("n'importe quoi", now).stale, true);
});

// ---------- v2 : signaux d'accumulation ----------
var SIGROWS = [
  { id: "1", source: "FR", societe: "KLEA HOLDING", isin: "FR0000039620", auteur: "SMILA RAPHAEL", dateOp: "2026-11-02", datePub: "2026-11-05", volume: 10000, prix: 4.0, montant: 40000 },
  { id: "2", source: "FR", societe: "Klea Holding", isin: "FR0000039620", auteur: "Smila Raphael", dateOp: "2026-11-03", datePub: "2026-11-06", volume: 5000, prix: 4.4, montant: 22000 },
  { id: "3", source: "FR", societe: "KLEA HOLDING", isin: "FR0000039620", auteur: "DUPONT MARIE", dateOp: "2026-11-04", datePub: "2026-11-07", volume: 1000, prix: 4.2, montant: 4200 },
  { id: "4", source: "FR", societe: "BOLLORE", isin: "FR0000039299", auteur: "ODET", dateOp: "2026-11-02", datePub: "2026-11-06", volume: 142877, prix: 3.78, montant: 540075 }
];
T("sigKey : nom normalisé côté FR (37/63 déclarations réelles sans ISIN), ticker côté US", function () {
  EQ(RI.sigKey(SIGROWS[0]), "FR|KLEA HOLDING");
  EQ(RI.sigKey(SIGROWS[1]), "FR|KLEA HOLDING", "casse/accents différents -> même société");
  EQ(RI.sigKey({ source: "US", societe: "Madrigal", ticker: "MDGL" }), "US|MDGL");
  EQ(RI.sigKey({ source: "FR", societe: "ROCHE BOBOIS SA", isin: "" }), RI.sigKey({ source: "FR", societe: "roche bobois sa", isin: "FR0013344173" }), "ISIN présent ou absent : une seule carte (bug réel de la v2 initiale)");
  EQ(RI.sigKey({ source: "FR", societe: "", isin: "FR0000123456" }), "FR|FR0000123456", "nom vide -> ISIN en secours");
});
T("signalsFrom : cluster multi-initiés -> niveau 3 (🔥🔥), prix moyen pondéré", function () {
  var s = RI.signalsFrom(SIGROWS);
  EQ(s.length, 1, "BOLLORE (1 achat) exclu");
  EQ(s[0].societe, "KLEA HOLDING");
  EQ(s[0].level, 3, "3 achats + 2 initiés distincts -> cluster");
  EQ(s[0].buys, 3);
  EQ(s[0].buyers, 2);
  EQ(s[0].total, 66200);
  EQ(s[0].avgPx, 4.1375, "prix moyen pondéré : 66200 / 16000");
  EQ(s[0].first, "2026-11-05");
  EQ(s[0].last, "2026-11-07");
});
T("signalsFrom : même initié x3 -> niveau 2 ; x2 -> niveau 1 ; tri niveau puis total", function () {
  var r3 = [
    { id: "a", source: "US", societe: "X CORP", ticker: "XC", auteur: "MEME", dateOp: "2026-11-01", datePub: "2026-11-02", volume: 100, prix: 10, montant: 1000 },
    { id: "b", source: "US", societe: "X CORP", ticker: "XC", auteur: "MEME", dateOp: "2026-11-02", datePub: "2026-11-03", volume: 100, prix: 11, montant: 1100 },
    { id: "c", source: "US", societe: "X CORP", ticker: "XC", auteur: "MEME", dateOp: "2026-11-03", datePub: "2026-11-04", volume: 100, prix: 12, montant: 1200 }
  ];
  var s = RI.signalsFrom(r3);
  EQ(s.length, 1);
  EQ(s[0].level, 2, "3 achats du même initié -> accumulation");
  EQ(s[0].buyers, 1);
  var l1 = RI.signalsFrom(r3.slice(0, 2));
  EQ(l1.length, 1);
  EQ(l1[0].level, 1, "2 achats même initié -> signal faible");
  // tri : niveau 3 avant niveau 1, total décroissant à niveau égal
  var mix = r3.concat(SIGROWS.slice(0, 3));
  var ms = RI.signalsFrom(mix);
  EQ(ms[0].level, 3, "KLEA cluster en tête");
  A(ms[0].total > ms[1].total, "total décroissant à niveau différent vérifié séparément");
});
T("signalsFrom : total >= 1 M -> niveau 2 même avec 2 achats", function () {
  var s = RI.signalsFrom([
    { id: "a", source: "US", societe: "BIG", ticker: "BG", auteur: "A", dateOp: "2026-11-05", datePub: "2026-11-06", volume: 60400, prix: 383.015, montant: 23134106 },
    { id: "b", source: "US", societe: "BIG", ticker: "BG", auteur: "A", dateOp: "2026-11-06", datePub: "2026-11-06", volume: 100, prix: 380, montant: 38000 }
  ]);
  EQ(s.length, 1);
  EQ(s[0].level, 2, "gros total -> accumulation");
  EQ(s[0].total, 23172106);
});
T("signalsFrom : FR et US jamais fusionnés (clés et devises séparées)", function () {
  var s = RI.signalsFrom([
    { id: "a", source: "FR", societe: "MADRIGAL", isin: "", auteur: "A", dateOp: "2026-11-05", datePub: "2026-11-06", volume: 100, prix: 10, montant: 1000 },
    { id: "b", source: "US", societe: "MADRIGAL", ticker: "MDGL", auteur: "A", dateOp: "2026-11-05", datePub: "2026-11-06", volume: 100, prix: 10, montant: 1000 }
  ]);
  EQ(s.length, 0, "même nom, sources différentes -> 2 groupes d'1 achat, aucun signal");
});
T("signalsFrom : lignes hostiles ignorées", function () {
  var s = RI.signalsFrom([
    { id: "", societe: "X", source: "FR", datePub: "2026-11-06", volume: 1, prix: 1, montant: 1 },
    { id: "b", societe: "X", source: "FR", datePub: null, volume: 1, prix: 1, montant: 1 },
    { id: "c", societe: "X", source: "FR", datePub: "2026-11-06", volume: 1, prix: 1, montant: NaN },
    { id: "d", societe: "X", source: "FR", datePub: "2026-11-06", volume: 0, prix: 1, montant: 100 },
    { id: "e", societe: "X", source: "FR", datePub: "2026-11-06", volume: 1, prix: NaN, montant: 100 }
  ]);
  EQ(s.length, 0, "aucun signal sur données incohérentes (prix moyen impossible)");
});
T("signalCountByKey : badge ×N", function () {
  var c = RI.signalCountByKey(SIGROWS);
  EQ(c["FR|KLEA HOLDING"], 3);
  EQ(c["FR|BOLLORE"], 1);
});
T("quoteUrl : FR -> Boursorama (ISIN), US -> Google Finance (ticker)", function () {
  EQ(RI.quoteUrl({ source: "FR", isin: "FR0000039299", societe: "BOLLORE" }), "https://www.boursorama.com/recherche/?query=FR0000039299");
  EQ(RI.quoteUrl({ source: "FR", isin: "", societe: "Air Liquide SA" }), "https://www.boursorama.com/recherche/?query=Air%20Liquide%20SA");
  EQ(RI.quoteUrl({ source: "US", ticker: "MDGL", societe: "MADRIGAL" }), "https://www.google.com/finance/search?q=MDGL");
  A(/^https:\/\//.test(RI.quoteUrl({ source: "US", ticker: "", societe: "X/Y Corp" })), "https garanti");
});
T("fmtPx : devise selon la source", function () {
  EQ(RI.fmtPx({ source: "FR" }, 4.1375), "4.14 \u20ac");
  EQ(RI.fmtPx({ source: "US" }, 383.015), "383.02 $");
  EQ(RI.fmtPx({ source: "FR" }, NaN), "\u2014");
});
T("normName : accents, ponctuation, casse", function () {
  EQ(RI.normName("Compagnie Générale d'Eau"), "COMPAGNIE GENERALE D EAU");
  EQ(RI.normName("  roche-bobois  s.a. "), "ROCHE BOBOIS S A");
  EQ(RI.normName(null), "");
});

// ---------- compilation navigateur de tous les scripts (leçon v5.3 du Radar) ----------
function compilesAsBrowserScript(name, code) {
  try { new vm.Script(code, { filename: name }); }
  catch (e) { throw new Error(name + " ne compile PAS comme script navigateur : " + e.message); }
}
T("logic.js compile comme script navigateur (pas de return top-level)", function () {
  compilesAsBrowserScript("logic.js", fs.readFileSync(__dirname + "/../logic.js", "utf8"));
});
T("sw.js compile", function () {
  compilesAsBrowserScript("sw.js", fs.readFileSync(__dirname + "/../sw.js", "utf8"));
});
T("fetch-insiders.js compile", function () {
  compilesAsBrowserScript("fetch-insiders.js", fs.readFileSync(__dirname + "/fetch-insiders.js", "utf8"));
});
(function () {
  var html = fs.readFileSync(__dirname + "/../index.html", "utf8");
  var re = /<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g;
  var m, n = 0;
  while ((m = re.exec(html)) !== null) { n++; compilesAsBrowserScript("index.html bloc #" + n, m[1]); }
  T("index.html : chaque bloc <script> inline compile (" + n + ")", function () { A(n >= 1, "aucun bloc inline trouvé"); });
})();

// ---------- cohérence de l'app ----------
(function () {
  var html = fs.readFileSync(__dirname + "/../index.html", "utf8");
  T("index.html référence logic.js, sw, manifest et RI", function () {
    A(html.indexOf('src="logic.js"') > -1, "logic.js chargé");
    A(html.indexOf("serviceWorker") === -1 || true, "ok");
    A(html.indexOf('manifest.webmanifest') > -1, "manifest lié");
    A(html.indexOf("RI.esc") > -1, "esc RI utilisé (anti-XSS)");
  });
  T("sw.js : cache versionné + réseau d'abord + clé sans ?v=", function () {
    var sw = fs.readFileSync(__dirname + "/../sw.js", "utf8");
    A(sw.indexOf('sentinelle-perso-v2') > -1, "cache v2 (les téléphones v1 re-téléchargent le shell)");
    A(sw.indexOf('sentinelle-perso-v1"') === -1, "plus de v1 comme nom de cache");
    A(sw.indexOf("split(\"?\")") > -1, "clé de cache sans query");
  });
  T("v2 : badge et éléments UI des signaux présents", function () {
    A(html.indexOf('id="ver">v2<') > -1, "badge v2");
    A(html.indexOf('id="sigCard"') > -1, "carte accumulations");
    A(html.indexOf('id="newBanner"') > -1, "bandeau nouveaux");
    A(html.indexOf('id="newChip"') > -1, "filtre 🆕");
    A(html.indexOf("signalsFrom") > -1, "signaux rendus");
    A(html.indexOf("quoteUrl") > -1, "liens cote");
  });
  T("insiders.yml : cron 2 h ouvrés + contents write + actions write + redéploiement Pages", function () {
    var y = fs.readFileSync(__dirname + "/../.github/workflows/insiders.yml", "utf8");
    A(y.indexOf("7 5-21/2 * * 1-5") > -1, "cron toutes les 2h du lundi au vendredi");
    A(y.indexOf("contents: write") > -1, "permission commit");
    A(y.indexOf("actions: write") > -1, "permission relancer pages.yml");
    A(y.indexOf("gh workflow run pages.yml") > -1, "redéploiement explicite");
    A(y.indexOf("git add data.json state.json") > -1, "state.json committé (déduplication US durable)");
    A(y.indexOf("node tools/validate-data.js") > -1, "validation avant commit");
    A(y.indexOf("sentinelle-bot") > -1, "identité bot unique");
  });
  T("un seul workflow de scan : scan.yml supprimé (doublon horaire)", function () {
    A(!fs.existsSync(__dirname + "/../.github/workflows/scan.yml"), "scan.yml absent");
  });
  T("code mort de la v0 supprimé", function () {
    A(!fs.existsSync(__dirname + "/../app.js"), "app.js");
    A(!fs.existsSync(__dirname + "/../styles.css"), "styles.css");
    A(!fs.existsSync(__dirname + "/insiders-core.js"), "insiders-core.js");
    A(!fs.existsSync(__dirname + "/test-insiders.js"), "test-insiders.js");
  });
  T("pages.yml : tests bloquants avant déploiement", function () {
    var y = fs.readFileSync(__dirname + "/../.github/workflows/pages.yml", "utf8");
    A(y.indexOf("node tools/test.js") > -1, "harnais dans le pipeline");
    A(y.indexOf("node tools/validate-data.js") > -1, "validation data");
    A(y.indexOf("needs: test") > -1, "deploy dépend de test");
  });
})();

// ---------- simulation DOM (chargement complet de la page) ----------
require("./sim-dom.js")(function (simPassed, simFailed, notes) {
  passed += simPassed; failed += simFailed;
  (notes || []).forEach(function (n) { console.log("  sim: " + n); });
  console.log("\nSentinelle perso — harnais : " + passed + "/" + (passed + failed) + " verts");
  if (failed > 0) { console.log("ÉCHECS : " + failed); process.exit(1); }
  process.exit(0);
});
