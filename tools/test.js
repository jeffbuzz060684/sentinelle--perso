#!/usr/bin/env node
"use strict";
// Harnais de tests Sentinelle perso — exécuté en CI AVANT tout déploiement (0 échec obligatoire).
// SP_HARNESS=1 : sous le harnais, fetch-quotes ne loggue PAS son warning ::warning:: de contrôle
// de schéma TV (les fixtures volontairement sans bornes 52 s. le déclencheraient → bruit CI).
process.env.SP_HARNESS = "1";
// v3.3 : les tests du pipeline sont COMPORTEMENTAUX (fetch injecté), plus des grep de source
// (Jade) — seuls les workflows YAML restent vérifiés par chaîne (pas d'autre moyen).
var fs = require("fs");
var vm = require("vm");
var RI = require("../logic.js");
var FI = require("./fetch-insiders.js");

var passed = 0, failed = 0;
function T(name, fn) {
  try { fn(); passed++; }
  catch (e) { failed++; console.log("ÉCHEC [" + name + "] : " + e.message); }
}
function A(cond, msg) { if (!cond) throw new Error(msg || "assertion"); }
function EQ(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg || "") + " : " + JSON.stringify(a) + " ≠ " + JSON.stringify(b)); }
var NOW = Date.parse("2026-11-09T12:00:00Z");
var dayAt = function (k) { return RI.isoDay(new Date(Date.now() - k * 86400000)); }; // dates dynamiques (fenêtres 30 j vs Date.now())

// ---------- utilitaires ----------
T("esc échappe le HTML", function () {
  EQ(RI.esc('<script>"a"&\'b\'</script>'), "&lt;script&gt;&quot;a&quot;&amp;&#39;b&#39;&lt;/script&gt;");
});
T("frNum : espaces insécables et €", function () {
  EQ(RI.frNum("1\u00a0400.0000"), 1400);
  EQ(RI.frNum("22\u00a0020.0400\u00a0€"), 22020.04);
  EQ(RI.frNum("15.7286"), 15.7286);
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
T("RI.VERSION : source unique de la version (badge + footer la lisent)", function () {
  EQ(RI.VERSION, "4.1.0");
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
  A(r.role.length > 0, "rôle");
  EQ(r.source, "FR");
  EQ(r.nature, "Acquisition");
  EQ(r.datePub, "2026-11-06");
  EQ(r.dateOp, "2026-11-05");
  A(isFinite(r.volume) && r.volume > 0, "volume");
  A(isFinite(r.prix) && r.prix > 0, "prix");
  A(isFinite(r.montant) && r.montant >= 1000, "montant : " + r.montant);
  A(r.url.indexOf("bdif.amf-france.org") > -1, "url AMF");
});
T("parseSwaoo v3 : acquisitions ET cessions uniquement + montants ≥ CFG", function () {
  frRows.forEach(function (r) {
    A(r.nature === "Acquisition" || r.nature === "Cession", "nature inattendue : " + r.nature);
    EQ(r.side, r.nature === "Cession" ? "sell" : "buy", "side cohérent avec la nature");
    A(r.montant >= RI.CFG.FR_MIN_EUR, "montant min");
  });
  var sells = frRows.filter(function (r) { return r.side === "sell"; });
  A(sells.length >= 3, "cessions de la fixture réelle présentes : " + sells.length);
});
T("rowsOfSide : séparation buy/sell/all", function () {
  var b = RI.rowsOfSide(frRows, "buy"), s = RI.rowsOfSide(frRows, "sell"), a = RI.rowsOfSide(frRows, "all");
  EQ(a.length, b.length + s.length, "all = buy + sell");
  EQ(s.length, frRows.length - b.length, "sell = complément de buy");
  b.forEach(function (r) { EQ(r.side, "buy", "aucune vente côté buy"); });
  EQ(RI.rowsOfSide(frRows, "n'importe").length, frRows.length, "side inconnu -> tout");
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
T("parseForm4 v3.3 : déclarant unique -> multiOwner=false, owners=[nom]", function () {
  EQ(f4.multiOwner, false);
  EQ(f4.owners.length, 1);
  EQ(f4.owners[0], "Noor Shain");
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
T("parseForm4 v3.3 : dépôt multi-déclarants -> owners complets, multiOwner=true, attribution au 1er", function () {
  var xml = "<ownershipDocument><rptOwnerName>Alice Dupont</rptOwnerName><rptOwnerName>Bob Martin</rptOwnerName>" +
    "<officerTitle>CEO</officerTitle>" +
    "<nonDerivativeTransaction><transactionDate><value>2026-11-05</value></transactionDate>" +
    "<transactionCoding><transactionCode>P</transactionCode></transactionCoding>" +
    "<transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode>" +
    "<transactionAmounts><transactionShares><value>1000</value></transactionShares>" +
    "<transactionPricePerShare><value>10</value></transactionPricePerShare></transactionAmounts>" +
    "</nonDerivativeTransaction></ownershipDocument>";
  var r = RI.parseForm4(xml);
  EQ(r.owners.length, 2, "les DEUX déclarants sont extraits (instructions SEC Form 4)");
  EQ(r.owner, "Alice Dupont", "le premier reste la référence (compat)");
  EQ(r.multiOwner, true);
  var rows = RI.usRowsFrom({ accession: "A2", fileDate: "2026-11-06", url: "u" }, r);
  EQ(rows.length, 1);
  EQ(rows[0].auteur, "Alice Dupont");
  EQ(rows[0].multi, true, "ligne marquée multi-déclarants (attribution incertaine, badge ⚠ dans l'app)");
});

// mkForm4 : XML Form 4 synthétique (déclarants + transactions paramétrables)
function mkForm4(opts) {
  var o = opts || {};
  var owners = (o.owners || ["A"]).map(function (n) { return "<rptOwnerName>" + n + "</rptOwnerName>"; }).join("");
  var tx = (o.txs || [{ code: "P", acq: "A", shares: 100, price: 10 }]).map(function (t) {
    return "<nonDerivativeTransaction><transactionDate><value>" + (t.date || "2026-11-05") + "</value></transactionDate>" +
      "<transactionCoding><transactionCode>" + t.code + "</transactionCode></transactionCoding>" +
      "<transactionAcquiredDisposedCode><value>" + t.acq + "</value></transactionAcquiredDisposedCode>" +
      "<transactionAmounts><transactionShares><value>" + t.shares + "</value></transactionShares>" +
      "<transactionPricePerShare><value>" + t.price + "</value></transactionPricePerShare></transactionAmounts>" +
      "</nonDerivativeTransaction>";
  }).join("");
  return "<ownershipDocument>" + owners + "<officerTitle>CEO</officerTitle>" +
    (o.plan === null || o.plan === undefined ? "" : "<aff10b5One>" + o.plan + "</aff10b5One>") +
    (o.derivativeM ? "<derivativeTransaction><transactionDate><value>2026-11-05</value></transactionDate>" +
      "<transactionCoding><transactionCode>M</transactionCode></transactionCoding>" +
      "<transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode>" +
      "<transactionAmounts><transactionShares><value>100</value></transactionShares></transactionAmounts>" +
      "</derivativeTransaction>" : "") +
    tx + "</ownershipDocument>";
}
var HIT = { accession: "X", fileDate: "2026-11-06", url: "u" };
T("usRowsFrom : achat = P+A (≥ 1 k$) ; codes F/G/J/M/A exclus ; paires incohérentes exclues", function () {
  var buy = RI.usRowsFrom(HIT, RI.parseForm4(mkForm4({ txs: [{ code: "P", acq: "A", shares: 100, price: 10 }] })));
  EQ(buy.length, 1, "achat au marché P+A : retenu");
  EQ(buy[0].side, "buy");
  EQ(buy[0].nature, "Achat");
  EQ(buy[0].montant, 1000);
  ["F", "G", "J", "M", "A"].forEach(function (code) {
    EQ(RI.usRowsFrom(HIT, RI.parseForm4(mkForm4({ txs: [{ code: code, acq: "A", shares: 100, price: 10 }] }))).length, 0, "code " + code + " exclu côté achat");
  });
  EQ(RI.usRowsFrom(HIT, RI.parseForm4(mkForm4({ txs: [{ code: "P", acq: "D", shares: 100, price: 10 }] }))).length, 0, "P+D incohérent : exclu");
  EQ(RI.usRowsFrom(HIT, RI.parseForm4(mkForm4({ txs: [{ code: "S", acq: "A", shares: 6000, price: 10 }] }))).length, 0, "S+A incohérent : exclu");
});
T("usRowsFrom v3.3 : vente S+D retenue UNIQUEMENT si ≥ 50 k$ (US_SELL_MIN_USD)", function () {
  var low = RI.usRowsFrom(HIT, RI.parseForm4(mkForm4({ txs: [{ code: "S", acq: "D", shares: 100, price: 30 }] })));
  EQ(low.length, 0, "vente de 3 k$ : non collectée (elles noyaient les listes, 380 en 1 journée)");
  var hard = RI.usRowsFrom(HIT, RI.parseForm4(mkForm4({ txs: [{ code: "S", acq: "D", shares: 6000, price: 10 }] })));
  EQ(hard.length, 1, "vente de 60 k$ sans plan ni levée : collectée (vente « dure »)");
  EQ(hard[0].side, "sell");
  EQ(hard[0].p10b5, false, "pas de plan déclaré");
  EQ(hard[0].opt, false, "pas de levée");
});
T("usRowsFrom v3.3 : vente ≥ 50 k$ sous plan 10b5-1 déclarée ⇒ EXCLUE (liquidation programmée, pas un signal)", function () {
  var rows = RI.usRowsFrom(HIT, RI.parseForm4(mkForm4({
    plan: 1,
    txs: [{ code: "P", acq: "A", shares: 100, price: 10 }, { code: "S", acq: "D", shares: 6000, price: 10 }]
  })));
  EQ(rows.length, 1, "seul l'achat survit");
  EQ(rows[0].side, "buy");
});
T("usRowsFrom v3.3 : vente ≥ 50 k$ dans un dépôt avec levée d'options (code M) ⇒ EXCLUE", function () {
  var rows = RI.usRowsFrom(HIT, RI.parseForm4(mkForm4({
    derivativeM: true,
    txs: [{ code: "S", acq: "D", shares: 6000, price: 10 }]
  })));
  EQ(rows.length, 0, "vente suivant une levée : non collectée (⚠ le code M est un constat au niveau du DÉPÔT)");
});
T("parseForm4 : plan 10b5-1 — 1 ⇒ plan, 0 ⇒ pas de plan, absent ⇒ inconnu", function () {
  EQ(RI.parseForm4(mkForm4({ plan: 1, txs: [] })).plan10b5, true);
  EQ(RI.parseForm4(mkForm4({ plan: 0, txs: [] })).plan10b5, false);
  EQ(RI.parseForm4(mkForm4({ txs: [] })).plan10b5, null, "balise absente (dépôts pré-2023)");
});
T("usRowsFrom : sous le seuil achat exclu", function () {
  EQ(RI.usRowsFrom(HIT, RI.parseForm4(mkForm4({ txs: [{ code: "P", acq: "A", shares: 10, price: 5 }] }))).length, 0); // 50 $ < 1000 $
});
T("v3.1 usRowsFrom : id anti-collision — deux tranches identiques (date, quantité), prix différents", function () {
  var rows = RI.usRowsFrom(HIT, RI.parseForm4(mkForm4({
    txs: [{ code: "P", acq: "A", shares: 100, price: 10 }, { code: "P", acq: "A", shares: 100, price: 12 }]
  })));
  EQ(rows.length, 2, "les deux tranches sont conservées");
  A(rows[0].id !== rows[1].id, "ids distincts (prix + index dans l'id)");
  EQ(rows[0].montant + rows[1].montant, 1000 + 1200, "montants cumulés exacts");
});

// ---------- purge d'état (v3.3 : date d'origine conservée) ----------
T("purgeProcessed : purge par date, entrées legacy datées du jour", function () {
  var out = FI.purgeProcessed(["acc-new|2026-11-08", "acc-vieux|2026-09-01", "acc-legacy"], NOW, RI.CFG.STATE_DAYS);
  EQ(out[0], "acc-new|2026-11-08", "entrée récente conservée");
  A(out.indexOf("acc-vieux|2026-09-01") === -1, "entrée > STATE_DAYS purgée");
  A(out.indexOf("acc-legacy|2026-11-09") > -1, "entrée sans date (legacy) conservée + datée du jour");
});
T("purgeProcessed v3.3 : la date d'ORIGINE est conservée (le bug v3.1.1 redatait tout au jour du run)", function () {
  // now = 2026-11-09, STATE_DAYS = 40 → min 2026-09-30
  var out = FI.purgeProcessed(["acc-old|2026-10-01", "acc-vieux|2026-09-01"], NOW, RI.CFG.STATE_DAYS);
  EQ(out.length, 1);
  EQ(out[0], "acc-old|2026-10-01", "entrée de 39 j conservée avec SA date d'origine, pas re-datée");
});

// ---------- v3.2 : fondamentaux XBRL + scoring ----------
var XBR = JSON.parse(fs.readFileSync(__dirname + "/fixtures/xbrl-rev-sample.json", "utf8"));
var XBNI = JSON.parse(fs.readFileSync(__dirname + "/fixtures/xbrl-ni-sample.json", "utf8"));
T("v3.2 xbrlAnnuals : 10-K uniquement, la valeur avec frame gagne, 10-Q exclus", function () {
  var a = RI.xbrlAnnuals(XBR);
  EQ(a.length, 3, "3 exercices annuels");
  EQ(a[0].end, "2022-12-31");
  EQ(a[1].end, "2023-12-31");
  EQ(a[1].val, 100000000, "entrée avec frame CY2023 prioritaire sur le doublon 99999999");
  EQ(a[2].end, "2024-12-31");
  EQ(a[2].val, 150000000);
});
T("v3.2 fundFromXbrl : croissance, résultat net aligné sur le dernier CA, marge", function () {
  var f = RI.fundFromXbrl(RI.xbrlAnnuals(XBR), RI.xbrlAnnuals(XBNI));
  EQ(f.rev, 150000000);
  EQ(f.revEnd, "2024-12-31");
  EQ(f.growth, 50, "+50 % vs N-1");
  EQ(f.ni, 30000000, "NI du dernier 10-K");
  EQ(f.margin, 20, "marge nette 20 %");
  var f2 = RI.fundFromXbrl([{ end: "2024-12-31", val: 100 }, { end: "2025-12-31", val: 80 }], []);
  EQ(f2.growth, -20, "croissance négative -20 %");
  A(f2.ni === null, "NI absent → null, pas de crash");
  var f3 = RI.fundFromXbrl([{ end: "2025-12-31", val: 100 }], []);
  A(f3.growth === null, "un seul exercice → croissance inconnue (pas de 0 % inventé)");
  A(RI.fundFromXbrl([], []) === null, "pas de CA annuel → null");
});
T("v3.2 fundScore : barèmes croissance / rentabilité / marge", function () {
  EQ(RI.fundScore({ rev: 100, growth: 50, ni: 30 }), 10, "+50 % · bénéficiaire · marge 30 % → 10/10");
  EQ(RI.fundScore({ rev: 100, growth: 15, ni: 10 }), 8, "+15 % · bénéficiaire · marge 10 % → 8");
  EQ(RI.fundScore({ rev: 100, growth: -5, ni: -5 }), 0, "CA en baisse + perte → 0");
  EQ(RI.fundScore({ rev: 100, growth: null, ni: 10 }), 5.5, "croissance inconnue + bénéficiaire marge 10 % → 5.5");
  A(RI.fundScore(null) === null, "pas de fondamentaux → null");
  A(RI.fundScore({ rev: 0, growth: 10, ni: 5 }) === null, "CA nul → null");
});
T("v3.2 insiderScoreFor : clusters récompensés, ventes dures pénalisées", function () {
  var sig3 = { level: 3, buyers: 2, buys: 3 };
  EQ(RI.insiderScoreFor(sig3, null), 6.5, "niveau 3 + 2 initiés distincts = 6.5");
  EQ(RI.insiderScoreFor({ level: 3, buyers: 3, buys: 6 }, null), 7, "niveau 3 + ≥5 achats = 7");
  EQ(RI.insiderScoreFor(sig3, { sells: 2, hardSells: 1 }), 4, "une vente dure : -2.5");
  EQ(RI.insiderScoreFor(sig3, { sells: 3, hardSells: 0 }), 6, "ventes toutes sous plan/levée : -0.5 seulement");
  EQ(RI.insiderScoreFor({ level: 2, buyers: 1, buys: 3 }, null), 3.5, "rachats d'un seul initié : 3.5 (sous le seuil des pistes)");
  EQ(RI.insiderScoreFor({ level: 1, buyers: 1, buys: 2 }, null), 2, "×2 même initié : 2");
});

// ---------- v3.3 : pistes US + pistes FR ----------
T("v3.3 pickCandidates + picksFrom : US only, seuil cluster, tri /20, cap", function () {
  var mk = function (id, source, soc, ticker, auteur, volume, prix, dateOp) {
    return { id: id, source: source, side: "buy", societe: soc, ticker: ticker, auteur: auteur,
      montant: volume * prix, volume: volume, prix: prix, dateOp: dateOp || "2026-11-05", datePub: "2026-11-06" };
  };
  // volumes DISTINCTS par ligne : depuis v3.3, deux opérations identiques (même date/volume/prix)
  // sont dédoublonnées — le cas Silynxcom (même opération sous 2 accessions) ne compte qu'une fois
  var buys = [
    mk("k1", "US", "KLEA PHARMA", "KLEA", "Alice", 5000, 10, "2026-11-03"),
    mk("k2", "US", "KLEA PHARMA", "KLEA", "Bob", 4000, 10, "2026-11-04"),
    mk("k3", "US", "KLEA PHARMA", "KLEA", "Alice", 4500, 10, "2026-11-05"),
    mk("s1", "US", "SILVIA, INC.", "SVIA", "Noor", 5000, 10, "2026-11-04"),
    mk("s2", "US", "SILVIA, INC.", "SVIA", "Zang", 6000, 10, "2026-11-05"),
    mk("o1", "US", "SOLO CORP", "SOLO", "Solo", 1000, 10, "2026-11-03"),
    mk("o2", "US", "SOLO CORP", "SOLO", "Solo", 1100, 10, "2026-11-04"),
    mk("o3", "US", "SOLO CORP", "SOLO", "Solo", 1200, 10, "2026-11-05"),
    mk("f1", "FR", "ROCHE BOBOIS SA", "", "Tamburi", 1400, 15.7, "2026-11-03"),
    mk("f2", "FR", "ROCHE BOBOIS SA", "", "Txr", 600, 16, "2026-11-04"),
    mk("f3", "FR", "ROCHE BOBOIS SA", "", "Tamburi", 500, 16, "2026-11-05"),
    mk("x1", "US", "XFIN CORP", "XFIN", "Xa", 2000, 10, "2026-11-04"),
    mk("x2", "US", "XFIN CORP", "XFIN", "Xb", 2400, 10, "2026-11-05")
  ];
  var sells = [{ id: "ks1", source: "US", side: "sell", societe: "KLEA PHARMA", ticker: "KLEA", auteur: "Carol",
    montant: 20000, volume: 2000, prix: 10, dateOp: "2026-11-04", datePub: "2026-11-05" }];
  var cands = RI.pickCandidates(buys, sells, 15);
  A(cands.length === 3, "SVIA (5), XFIN (5), KLEA (4) candidates — SOLO (3.5) sous le seuil, FR exclue : " + cands.length);
  EQ(cands[0].ticker, "SVIA", "tri par score initiés, total en égalité");
  var funds = {
    KLEA: { rev: 100000000, revEnd: "2024-12-31", growth: 50, ni: 30000000, margin: 30 },
    SVIA: { rev: 150000000, revEnd: "2024-12-31", growth: 50, ni: 30000000, margin: 20 }
  };
  var picks = RI.picksFrom(buys, sells, funds, { max: 6 });
  EQ(picks.length, 2, "XFIN écartée : cluster sans fondamentaux exploitables");
  EQ(picks[0].ticker, "SVIA", "SVIA 5+9.5 = 14.5 > KLEA 4+10 = 14");
  EQ(picks[0].score, 14.5);
  EQ(picks[0].fund.score, 9.5, "marge 20 % → 3 pts (pas 3.5)");
  EQ(picks[0].sells.n, 0, "SVIA : aucune vente");
  EQ(picks[1].ticker, "KLEA");
  EQ(picks[1].sells.hard, 1, "KLEA : 1 vente dure comptée");
  EQ(picks[1].insider.score, 4);
  EQ(RI.picksFrom(buys, sells, funds, { max: 1 }).length, 1, "cap max appliqué");
});
T("v3.3 picksFromFr : cluster FR nettoyé → piste /10 (signal initiés seul, pas de fondamentaux en France)", function () {
  var fr = [
    { id: "f1", source: "FR", side: "buy", societe: "ROCHE BOBOIS SA", isin: "FR0013344173", auteur: "TAMBURI GIOVANNI", dateOp: "2026-11-03", datePub: "2026-11-05", volume: 1400, prix: 15.7, montant: 21980 },
    { id: "f2", source: "FR", side: "buy", societe: "ROCHE BOBOIS SA", isin: "FR0013344173", auteur: "TXR S.R.L.", dateOp: "2026-11-04", datePub: "2026-11-06", volume: 600, prix: 16, montant: 9600 },
    { id: "f3", source: "FR", side: "buy", societe: "ROCHE BOBOIS SA", isin: "FR0013344173", auteur: "TAMBURI GIOVANNI", dateOp: "2026-11-05", datePub: "2026-11-07", volume: 500, prix: 16, montant: 8000 }
  ];
  var picks = RI.picksFromFr(fr, [], {});
  EQ(picks.length, 1, "cluster niveau 3 (3 achats, 2 initiés) → 1 piste");
  EQ(picks[0].societe, "ROCHE BOBOIS SA");
  EQ(picks[0].score, 6.5, "score initiés seul, sur /10");
  EQ(picks[0].insider.score, 6.5);
  EQ(picks[0].sells.n, 0);
  A(picks[0].fund === undefined, "pas de champ fund côté FR (pas d'équivalent public du 10-K)");
});

// ---------- fusion / fenêtre / plafond ----------
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
  EQ(RI.freshness("2026-11-09T10:30:00Z", NOW).label, "il y a 2 h");
  EQ(RI.freshness("2026-11-02T10:00:00Z", NOW).stale, true, "7 j -> périmé");
  EQ(RI.freshness("2026-11-08T12:00:00Z", NOW).stale, false, "24 h -> ok (trou week-end 57 h)");
  EQ(RI.freshness("n'importe quoi", NOW).stale, true);
});

// ---------- signaux d'accumulation ----------
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
T("signalsFrom v3.3 : fenêtre {since} — les lignes publiées avant la fenêtre 30 j sont ignorées", function () {
  var rows = [
    { id: "a", source: "US", societe: "X CORP", ticker: "XC", auteur: "A", dateOp: "2026-10-01", datePub: "2026-10-02", volume: 100, prix: 10, montant: 1000 },
    { id: "b", source: "US", societe: "X CORP", ticker: "XC", auteur: "B", dateOp: "2026-10-02", datePub: "2026-10-03", volume: 100, prix: 10, montant: 1000 },
    { id: "c", source: "US", societe: "X CORP", ticker: "XC", auteur: "C", dateOp: "2026-11-04", datePub: "2026-11-05", volume: 100, prix: 10, montant: 1000 }
  ];
  EQ(RI.signalsFrom(rows, { since: "2026-11-01" }).length, 0, "2 lignes hors fenêtre (1 seule dedans) -> pas de signal");
  EQ(RI.signalsFrom(rows).length, 1, "sans fenêtre -> signal (les listes brutes restent 90 j)");
});
T("signalsFrom v3.3 : la même opération déclarée par 2 déclarants compte UNE fois (cas Silynxcom)", function () {
  var s = RI.signalsFrom([
    { id: "a", source: "US", societe: "SILYNXCOM", ticker: "SLX", auteur: "PDG", dateOp: "2026-11-04", datePub: "2026-11-05", volume: 10000, prix: 2, montant: 20000 },
    { id: "b", source: "US", societe: "SILYNXCOM", ticker: "SLX", auteur: "VP", dateOp: "2026-11-04", datePub: "2026-11-06", volume: 10000, prix: 2, montant: 20000 },
    { id: "c", source: "US", societe: "SILYNXCOM", ticker: "SLX", auteur: "PDG", dateOp: "2026-11-05", datePub: "2026-11-07", volume: 5000, prix: 2, montant: 10000 }
  ]);
  EQ(s.length, 1);
  EQ(s[0].buys, 2, "2 achats réels, pas 3 (l'opération doublée est fusionnée)");
  EQ(s[0].total, 30000, "total non doublé");
  EQ(s[0].buyers, 1, "l'opération fusionnée n'ajoute pas de 2e initié (comptage conservateur : le déclarant doublé n'est pas compté comme personne distincte)");
});
T("personKey v3.3 : « personne morale liée à X » regroupée sur X (KLEA = 1 initié, pas 2)", function () {
  EQ(RI.personKey("TXR S.R.L., personne morale liée à RAPHAEL SMILA"), RI.personKey("RAPHAEL SMILA"), "véhicule et personne physique = même initié");
  EQ(RI.personKey("RAPHAEL SMILA"), "RAPHAEL SMILA");
  EQ(RI.personKey("KLEA HOLDING, personne morale liée à Raphaël Smila"), "RAPHAEL SMILA", "accents/casse normalisés");
  var s = RI.signalsFrom([
    { id: "1", source: "FR", societe: "KLEA HOLDING", auteur: "KLEA HOLDING, personne morale liée à RAPHAEL SMILA", dateOp: "2026-11-02", datePub: "2026-11-05", volume: 10000, prix: 4, montant: 40000 },
    { id: "2", source: "FR", societe: "KLEA HOLDING", auteur: "TXR S.R.L., personne morale liée à RAPHAEL SMILA", dateOp: "2026-11-03", datePub: "2026-11-06", volume: 5000, prix: 4.4, montant: 22000 },
    { id: "3", source: "FR", societe: "KLEA HOLDING", auteur: "RAPHAEL SMILA", dateOp: "2026-11-04", datePub: "2026-11-07", volume: 1000, prix: 4.2, montant: 4200 }
  ]);
  EQ(s[0].buyers, 1, "3 achats de la même personne via 2 holdings + en direct = 1 initié (le cluster 🔥🔥 faux disparaît)");
  EQ(s[0].level, 2, "1 initié -> pas un cluster multi-personnes");
});
T("signalsFrom : même initié x3 -> niveau 2 ; x2 -> niveau 1", function () {
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
});
T("signalsFrom v3.3 : tri niveau, puis RÉCENCE du dernier achat, puis total", function () {
  var mk = function (soc, auteur, dateOp, datePub, montant) {
    return { id: soc + dateOp + auteur, source: "FR", societe: soc, auteur: auteur,
      dateOp: dateOp, datePub: datePub, volume: montant, prix: 1, montant: montant };
  };
  var rows = [
    mk("VIEUX GROS", "A", "2026-11-01", "2026-11-02", 900000),
    mk("VIEUX GROS", "B", "2026-11-02", "2026-11-03", 900000),
    mk("VIEUX GROS", "C", "2026-11-03", "2026-11-04", 900000),
    mk("RECENT PETIT", "D", "2026-11-06", "2026-11-07", 2000),
    mk("RECENT PETIT", "E", "2026-11-07", "2026-11-08", 2000),
    mk("RECENT PETIT", "F", "2026-11-08", "2026-11-09", 2000)
  ];
  var s = RI.signalsFrom(rows);
  EQ(s.length, 2);
  EQ(s[0].societe, "RECENT PETIT", "même niveau 3 : le cluster tout frais prime sur le gros cluster ancien");
  EQ(s[0].level, 3);
  EQ(s[1].societe, "VIEUX GROS");
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

// ---------- v3.3 : garde anti-effondrement SÉPARÉE de la rétention ----------
T("collapseGuard : les lignes prev expirées (> KEEP_DAYS) ne déclenchent PAS la garde", function () {
  var old30 = [];
  for (var i = 0; i < 30; i++) old30.push({ id: "o" + i, datePub: "2026-06-01", montant: 1000 }); // tous hors fenêtre 90 j
  var g = FI.collapseGuard(old30, [], "FR achats", NOW, function () { });
  EQ(g.keep, false, "l'expiration naturelle des vieilles lignes n'est pas une panne (v3.1.1 confondait les deux)");
  EQ(g.rows.length, 0, "next (vide) retourné : la rétention s'applique normalement");
});
T("collapseGuard : vraie chute -50 % sur des lignes fraîches ⇒ version précédente conservée", function () {
  var fresh30 = [];
  for (var i = 0; i < 30; i++) fresh30.push({ id: "f" + i, datePub: "2026-11-08", montant: 1000 });
  var next10 = fresh30.slice(0, 10);
  var g = FI.collapseGuard(fresh30, next10, "FR achats", NOW, function () { });
  EQ(g.keep, true, "-67 % de lignes fraîches -> panne probable");
  EQ(g.rows.length, 30, "les données précédentes sont conservées");
  var ok = FI.collapseGuard(fresh30, fresh30.slice(0, 16), "FR achats", NOW, function () { });
  EQ(ok.keep, false, "-47 % (au-dessus du seuil -50 %) -> pas de garde");
});

// ---------- v3.3 : alertes (diff avant/après du run) ----------
T("computeAlerts : premier run (prevData vide) ⇒ aucun message (pas de spam)", function () {
  var newBuy = { id: "n1", source: "FR", side: "buy", societe: "DYN CORP", auteur: "A", role: "PDG",
    dateOp: dayAt(2), datePub: dayAt(1), volume: 10000, prix: 20, montant: 200000 };
  EQ(FI.computeAlerts({}, { fr: [newBuy], us: [] }, function () { }).length, 0);
  EQ(FI.computeAlerts(null, { fr: [newBuy], us: [] }, function () { }).length, 0);
});
T("computeAlerts : NOUVEAU cluster 🔥🔥 (≥ 2 initiés distincts sur 30 j) ⇒ message", function () {
  var mk = function (id, auteur, k) {
    return { id: id, source: "FR", side: "buy", societe: "DYN CORP", auteur: auteur, role: "Dirigeant",
      dateOp: dayAt(k + 2), datePub: dayAt(k + 1), volume: 1000, prix: 10, montant: 10000 };
  };
  var prev = { fr: [mk("p1", "A", 3)], us: [] }; // 1 achat isolé avant : pas de cluster
  var neu = { fr: [mk("p1", "A", 3), mk("n1", "B", 2), mk("n2", "C", 1)], us: [] }; // cluster 3 achats / 3 initiés
  var msgs = FI.computeAlerts(prev, neu, function () { });
  EQ(msgs.length, 1, "exactement le nouveau cluster, pas les achats < 100 k");
  A(msgs[0].indexOf("DYN CORP") > -1 && msgs[0].indexOf("NOUVEAU cluster") > -1, "message cluster : " + msgs[0]);
  EQ(FI.computeAlerts(neu, neu, function () { }).length, 0, "même cluster avant et après (même clé) ⇒ silence");
});
T("computeAlerts : achat ≥ 100 k d'un dirigeant ⇒ message ; fonds 10 % et doublons ⇒ silence", function () {
  var mkBuy = function (id, role, montant) {
    return { id: id, source: "FR", side: "buy", societe: "BIG SA", auteur: "Jean D", role: role,
      dateOp: dayAt(3), datePub: dayAt(2), volume: montant / 10, prix: 10, montant: montant };
  };
  var ceo = mkBuy("c1", "Directeur Général", 150000);
  var prev = { fr: [ceo], us: [] }; // déjà vu avant (clé naturelle identique)
  var neu = {
    fr: [ceo, mkBuy("f1", "Propriétaire 10 %", 200000), mkBuy("c2", "Président", 120000)],
    us: []
  };
  var msgs = FI.computeAlerts(prev, neu, function () { });
  EQ(msgs.length, 1, "le fonds 10 % et le doublon ne notifient pas");
  A(msgs[0].indexOf("achetés par") > -1 && msgs[0].indexOf("Président") > -1, "message gros achat dirigeant : " + msgs[0]);
  // achat ≥ 100 k sans rôle (role vide) : pas un dirigeant identifié -> silence
  var noRole = { id: "x1", source: "US", side: "buy", societe: "X CORP", ticker: "XC", auteur: "Fund LP", role: "",
    dateOp: dayAt(3), datePub: dayAt(2), volume: 10000, prix: 20, montant: 200000 };
  EQ(FI.computeAlerts({ us: [], fr: [] }, { us: [noRole], fr: [] }, function () { }).length, 0, "rôle vide -> pas notifié");
});

// ---------- compilation navigateur de tous les scripts ----------
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

// ---------- cohérence de l'app (structure HTML : pas testable autrement) ----------
(function () {
  var html = fs.readFileSync(__dirname + "/../index.html", "utf8");
  T("index.html référence logic.js, sw, manifest et RI", function () {
    A(html.indexOf('src="logic.js"') > -1, "logic.js chargé");
    A(html.indexOf("navigator.serviceWorker.register") > -1, "service worker réellement enregistré (v3.1 — était du code mort)");
    A(html.indexOf('manifest.webmanifest') > -1, "manifest lié");
    A(html.indexOf("RI.esc") > -1, "esc RI utilisé (anti-XSS)");
  });
  T("v3.3 : version en UNE seule source (RI.VERSION) — badge et footer la lisent", function () {
    A(html.indexOf('id="ver"') > -1, "badge version");
    A(html.indexOf('id="footVer"') > -1, "version footer");
    A(html.indexOf("RI.VERSION") > -1, "init lit RI.VERSION");
    A(html.indexOf(">v3.2<") === -1 && html.indexOf(">v3<") === -1, "plus de version en dur périmée dans le HTML");
  });
  T("v3.3 : emoji 🆕 correct (🖕 de la v3.1.1 corrigé)", function () {
    A(html.indexOf("\ud83c\udd95") > -1, "🆕 écrit en dur (UTF-8) présent");
    A(html.indexOf("\ud83d\udd95") === -1, "plus de 🖔 (la séquence échappée de la v3.1.1)");
    A(html.indexOf("\ud83d\udc1f") === -1, "plus de 🐟");
  });
  T("v3.3 : pagination « Afficher plus » à 100 lignes", function () {
    A(html.indexOf("Afficher plus") > -1, "bouton pagination");
    A(html.indexOf('id="moreBtn"') > -1, "id moreBtn");
    A(html.indexOf("state.limit") > -1, "limit pilotée par state");
  });
  T("v3.3 : multi-déclarants signalés, badges 10b5-1/levée retirés des lignes", function () {
    A(html.indexOf("⚠ déclarants multiples") > -1, "badge ⚠ multi-déclarants (attribution incertaine)");
    A(html.indexOf("r.p10b5 ?") === -1, "plus de badge ⚙ 10b5-1 sur les lignes (ventes douces non collectées)");
    A(html.indexOf("r.opt ?") === -1, "plus de badge 🪜 levée sur les lignes");
  });
  T("v3.3 : fenêtre signal 30 j + ventes US ≥ 50 k$ expliquées", function () {
    A(html.indexOf("fenêtre 30 j") > -1, "cartes signal 30 j (90 j = bruit)");
    A(html.indexOf("50 k$") > -1, "seuil ventes US expliqué");
    A(html.indexOf("cessions sont exclues") === -1, "plus de texte périmé « cessions exclues »");
    A(html.indexOf("Lignes publiées") > -1, "bandeau nouveaux parle de lignes publiées");
  });
  T("v3.1 : éléments UI achats/ventes, fraîcheur par source, défaut Achats", function () {
    A(html.indexOf('id="segSide"') > -1, "segment Achats+ventes");
    A(html.indexOf('id="segSort"') > -1, "segment tri par id");
    A(html.indexOf('id="sigCardSell"') > -1, "carte ventes");
    A(html.indexOf('id="nSell"') > -1, "stat ventes");
    A(html.indexOf('id="srcBanner"') > -1, "bandeau d'état par source (frOk/usOk/frUpdated/usUpdated)");
    A(html.indexOf('id="sigCard"') > -1, "carte accumulations");
    A(html.indexOf('id="newBanner"') > -1, "bandeau nouveaux");
    A(html.indexOf('id="newChip"') > -1, "filtre 🆕");
    A(html.indexOf("state.newIds.indexOf") === -1, "newIds en objet");
    A(html.indexOf("clearTimeout(debTimer)") > -1, "recherche debouncée");
    A(html.indexOf("/^https:\\/\\//.test(r.url)") > -1, "liens source validés https:// (anti javascript:)");
    A(html.indexOf("data-side=\"buy\"") > -1 && /data-side="buy"[^>]*class="[^"]*on"/.test(html.replace(/\n/g, " ")), "défaut 🟢 Achats actif");
  });
  T("v3.1.1 : recherche par société ignore le filtre Achats/Ventes", function () {
    A(html.indexOf("var qTxt = String(state.prefs.q || \"\").trim();") > -1, "q trimé");
    A(html.indexOf("qTxt ? buys.concat(sells)") > -1, "recherche => achats ET ventes");
    A(html.indexOf("Aucune ligne pour « ") > -1, "message vide explicite");
  });
  T("v3.3 : carte pistes 💡 US /20 + FR /10", function () {
    A(html.indexOf('id="picksCard"') > -1, "carte pistes");
    A(html.indexOf('id="picksList"') > -1, "liste pistes");
    A(html.indexOf("renderPicks") > -1, "rendu pistes branché sur render()");
    A(html.indexOf("pk.us || pk.picks") > -1, "compat ancien format picks");
    A(html.indexOf("pas un conseil d'achat") > -1, "disclaimer recherche, pas conseil");
    A(html.indexOf("data-sig=") > -1, "lien « voir les déclarations » réutilise le filtre recherche");
  });
  T("sw.js : cache v5 + timeout réseau 3,5 s", function () {
    var sw = fs.readFileSync(__dirname + "/../sw.js", "utf8");
    A(sw.indexOf("sentinelle-perso-v5") > -1, "cache v5");
    A(sw.indexOf("sentinelle-perso-v4") === -1, "plus d'ancien nom de cache v4 (sinon les installs v4.0.x gardent le vieux shell)");
    A(sw.indexOf("sentinelle-perso-v3.3") === -1 && sw.indexOf("sentinelle-perso-v3.2") === -1, "plus d'ancien nom de cache");
    A(sw.indexOf("3500") > -1, "timeout réseau 3,5 s (repli cache si connexion morte)");
    A(sw.indexOf("split(\"?\")") > -1, "clé de cache sans query");
  });
  T("workflows YAML (structure non testable par comportement — vérifiés par chaîne)", function () {
    var y = fs.readFileSync(__dirname + "/../.github/workflows/insiders.yml", "utf8");
    A(y.indexOf("7 5-23/2 * * 1-5") > -1, "cron 2 h ouvrés 05:07–23:07 UTC");
    A(y.indexOf("7 2 * * 2-6") > -1, "cron 02:07 UTC mar-sam (dépôts US de 18 h à 22 h ET)");
    A(y.indexOf("RI_SEC_CONTACT") > -1, "contact SEC depuis le secret");
    A(y.indexOf("::warning::RI_SEC_CONTACT non défini") > -1, "warning si le secret manque (adresse que personne ne lit sinon)");
    A(y.indexOf("NTFY_TOPIC") > -1, "topic ntfy en secret (dépôt public)");
    A(y.indexOf("git pull --rebase origin main") > -1, "pull --rebase avant push");
    A(y.indexOf("contents: write") > -1, "permission commit");
    A(y.indexOf("actions: write") > -1, "permission relancer pages.yml");
    A(y.indexOf("gh workflow run pages.yml") > -1, "redéploiement explicite");
    A(y.indexOf("\"(updated|frUpdated|usUpdated|counts)\":") > -1, "redéploiement si les DONNÉES changent");
    A(y.indexOf("frOk|usOk") === -1, "un flip frOk/usOk n'est PAS exclu du diff : il DÉPLOIE aussi (les statuts doivent atteindre l'app)");
    A(y.indexOf("git add data.json state.json") > -1, "state.json committé (déduplication US durable)");
    A(y.indexOf("node tools/validate-data.js") > -1, "validation avant commit");
    var p = fs.readFileSync(__dirname + "/../.github/workflows/pages.yml", "utf8");
    A(p.indexOf("node tools/test.js") > -1, "harnais bloquant dans pages.yml");
    A(p.indexOf("node tools/validate-data.js") > -1, "validation data");
    A(p.indexOf("needs: test") > -1, "deploy dépend de test");
    A(p.indexOf("mkdir -p dist") > -1 && p.indexOf('path: "dist"') > -1, "dist/ construit et publié (plus tout le dépôt)");
  });
  T("un seul workflow de scan : scan.yml supprimé (doublon horaire)", function () {
    A(!fs.existsSync(__dirname + "/../.github/workflows/scan.yml"), "scan.yml absent");
  });
  // ---------- v4.0 : onglet SBF 120 (valorisation + vue croisée initiés FR) ----------
  T("v4.0 : workflows YAML cotations + composition + déploiement", function () {
    var q = fs.readFileSync(__dirname + "/../.github/workflows/quotes.yml", "utf8");
    A(q.indexOf("*/15 7-16 * * 1-5") > -1, "cron 15 min en séance (07:00-16:45 UTC, lun-ven)");
    A(q.indexOf("timeout-minutes: 10") > -1, "timeout du run cotations");
    A(q.indexOf("node tools/fetch-quotes.js") > -1, "relevé des cotes");
    A(q.indexOf("node tools/validate-quotes.js") > -1, "validation avant commit");
    A(q.indexOf("git pull --rebase origin main") > -1, "pull --rebase avant push (pas de collision avec le cron initiés)");
    A(q.indexOf("contents: write") > -1 && q.indexOf("actions: write") > -1, "permissions commit + relance pages");
    A(q.indexOf("gh workflow run pages.yml") > -1, "redéploiement Pages quand les cotes changent");
    A(q.indexOf("concurrency") > -1 && q.indexOf("cancel-in-progress: true") > -1, "runs obsolètes annulés (une seule vague de cotes à la fois)");
    var s = fs.readFileSync(__dirname + "/../.github/workflows/sbf120.yml", "utf8");
    A(s.indexOf("node tools/build-sbf120.js") > -1, "reconstruction de la composition");
    A(s.indexOf("git add sbf120.json") > -1, "commit de la seule composition");
    A(s.indexOf("37 4 3 * *") > -1, "cron mensuel (prêt avant les révisions trimestrielles Euronext)");
    // v4.1.0 : les schedules GitHub ne partent pas sur ce compte — le déclencheur réel est le ping
    A(s.indexOf("ping-compo") > -1 && s.indexOf("paths: [\".github/ping-compo\"]") > -1, "v4.1.0 : trigger push sur .github/ping-compo (tâche Vibe mensuelle)");
    var p = fs.readFileSync(__dirname + "/../.github/workflows/pages.yml", "utf8");
    A(p.indexOf("test -f quotes.json && cp quotes.json dist/") > -1, "quotes.json servi (cp tolérant tant que le premier cron n'a pas tourné)");
    A(p.indexOf("test -f sbf120.json && cp sbf120.json dist/") > -1, "sbf120.json servi");
    A(p.indexOf("validate-quotes.js") > -1, "validation quotes + composition AVANT déploiement");
  });
  T("v4.0 : structure de l'onglet SBF 120 dans index.html", function () {
    var h = fs.readFileSync(__dirname + "/../index.html", "utf8");
    A(h.indexOf('id="tabs"') > -1 && h.indexOf('data-tab="sbf"') > -1, "barre d'onglets 👁 Initiés / 📊 SBF 120");
    A(h.indexOf('id="viewIns"') > -1 && h.indexOf('id="viewSbf"') > -1, "deux vues séparées");
    A(h.indexOf('id="segSb"') > -1 && h.indexOf("🏆 Long terme — LA liste unique") > -1, "v4.0.11 : UN SEUL classement 🏆, titre statique");
    A(h.indexOf('data-v="val"') === -1 && h.indexOf('data-v="xins"') === -1 && h.indexOf('data-v="obj"') === -1 && h.indexOf('data-v="lt"') === -1, "v4.0.11 : plus aucun segment de vue (📐 🔀 🎯 supprimés, demande de Jade)");
    A(h.indexOf('id="sq"') > -1, "recherche d'une valeur");
    A(h.indexOf('id="sbList"') > -1 && h.indexOf("sbLimit") > -1, "liste + pagination 100");
    A(h.indexOf('id="sbIdxPx"') > -1 && h.indexOf('id="sbIdxChg"') > -1, "stats indice");
    A(h.indexOf("sentinelle-perso-quotes-v4") > -1, "clé de cache localStorage des cotes");
    A(h.indexOf("refreshQuotes") > -1, "rafraîchissement des cotes au chargement");
    A(h.indexOf("différé ≈ 15 min") > -1, "mention honnête du différé (pas de temps réel officiel payant)");
    A(h.indexOf("Percentiles internes") > -1 && h.indexOf("par secteur") > -1, "note méthodo dans la page (secteur + indice)");
    A(h.indexOf("k/3 métriques") > -1, "note : base du score explicite");
    A(h.indexOf("id=\"sbComp\"") > -1, "stat âge de la composition (univers)");
    A(h.indexOf("id=\"sbTpN\"") > -1, "stat objectifs analystes (consensus)");
    A(h.indexOf("≈ à vérifier") > -1, "badge approx visible sur les tickers approximatifs");
    A(h.indexOf("vs secteur") > -1 && h.indexOf("vs indice") > -1, "référentiel du score affiché");
    A(h.indexOf("UNE SEULE liste 🏆 Long terme") > -1, "v4.0.11 : note méthodo = un seul classement, vues séparées supprimées");
    A(h.indexOf("📉 bas de fourchette 52 s.") > -1, "badge position 52 s. neutre (info, pas un signal d'achat)");
    A(h.indexOf("qualité 55 %") > -1 && h.indexOf("valorisation relative 35 %") > -1 && h.indexOf("initiés FR 10 %") > -1, "note méthodo 🏆 : 55/35/10 affichés (v4.0.12 : « point d'entrée » renommé « valorisation relative »)");
    A(h.indexOf("NEUTRE à 50/100") > -1, "v4.0.12 : initiés neutres à 50 sans signal expliqués (plus de pénalité d'absence)");
    A(h.indexOf("≥ 5 observations valides") > -1 && h.indexOf("bases mixtes") > -1, "v4.0.12 : percentile sectoriel par métrique (≥ 8 pairs ET ≥ 5 observations), cas mixtes affichés");
    A(h.indexOf("SOUS la fourchette 52 s.") > -1 && h.indexOf("AU-DESSUS de la fourchette 52 s.") > -1, "v4.0.12 : cours hors bornes 52 s. signalé, pas confondu avec une extrémité");
    A(h.indexOf("trois composantes et leur couverture") > -1, "v4.0.12 : composantes + couverture affichées sur les cartes");
    A(h.indexOf("affiché sans être noté") > -1, "v4.0.10 : contexte d'entrée (52 s., consensus 🎯) affiché mais hors score");
    A(h.indexOf("George &amp; Hwang") > -1 || h.indexOf("George & Hwang") > -1, "référence littérature momentum citée");
    A(h.indexOf("Un point bas n’est pas un plancher") > -1 || h.indexOf("un point bas n’est pas un plancher") > -1 || h.indexOf("un point bas n'est pas un plancher") > -1, "honnêteté : point bas ≠ plancher");
    A(h.indexOf("⚠️ bénef. attendus en baisse") > -1, "garde-fou piège à valeur (fper > per) affiché");
    A(h.indexOf('id="sbQ"') > -1, "stat couverture qualité (v4.0.8)");
    A(h.indexOf("journal-scores.jsonl") > -1, "journal de validation mentionné dans l'aide");
    A(h.indexOf("repli TradingView la croissance est absente") > -1 || h.indexOf("repli TradingView, la croissance") > -1, "v4.0.9 : repli TV qualité expliqué (3/4 sans croissance)");
    A(h.indexOf("3 métriques sur 4") > -1 || h.indexOf("3 métriques qualité") > -1, "exigence 3/4 expliquée");
    A(h.indexOf("contexte d'entrée") > -1 && h.indexOf("≠ notre score maison") > -1, "consensus 🎯 = contexte d'entrée, ≠ score maison (v4.0.11)");
    A(h.indexOf("pas un conseil") > -1, "disclaimer valorisation");
  });
  T("v4.1.0 : structure de l'onglet 🇫🇷 CAC 40 dans index.html", function () {
    var h = fs.readFileSync(__dirname + "/../index.html", "utf8");
    A(h.indexOf('data-tab="cac"') > -1, "bouton d'onglet cac");
    A(h.indexOf('id="viewCac"') > -1, "vue dédiée");
    A(h.indexOf('id="cacList"') > -1 && h.indexOf('id="cq"') > -1, "classement + recherche");
    A(h.indexOf('id="macroCard"') > -1 && h.indexOf('id="macroChips"') > -1 && h.indexOf('id="macroNote"') > -1, "bandeau macro 🌍 (contexte, jamais noté)");
    A(h.indexOf('id="caxPx"') > -1 && h.indexOf('id="cacMg"') > -1, "stats indice CAC 40 + fraîcheur macro");
    A(h.indexOf("renderCac") > -1, "fonction de rendu branchée");
    A(h.indexOf("qualité 40 %") > -1 && h.indexOf("valorisation 25 %") > -1 && h.indexOf("consensus 35 %") > -1, "pondérations du score 🎯 affichées dans la méthodo");
    A(h.indexOf("⚠️ PEA : non éligible en principe") > -1, "badge URW (REIT, PEA) affiché");
    A(h.indexOf("surprise EPS") > -1 && h.indexOf("prochain résultat") > -1, "résultats financiers (surprise + publication) sur les cartes");
    A(h.indexOf("n'entre") > -1 && h.indexOf("jamais") > -1 && h.indexOf("score 🎯") > -1, "macro explicitement hors score");
    A(h.indexOf("heuristique") > -1 && h.indexOf("jamais validée") > -1, "honnêteté : score = heuristique jamais validée");
    A(h.indexOf("cacQ") > -1, "préférence de recherche cacQ persistée");
  });
  T("rankPct : percentiles, plus bas = 100, exclusion des non positifs", function () {
    var l = [
      { per: 5 }, { per: 10 }, { per: 20 }, { per: 40 }, // PER croissant
      { per: -3 }, { per: 0 }                            // perte et zéro : hors rang
    ];
    var p = RI.rankPct(l, "per", true);
    EQ(p[0], 100, "PER 5 (le plus bas) = 100");
    EQ(p[3], 0, "PER 40 (le plus haut) = 0");
    A(p[4] === undefined && p[5] === undefined, "non positifs exclus du rang");
    var d = [{ dY: 0 }, { dY: 2 }, { dY: 6 }];
    var pd = RI.rankPct(d, "dY", false);
    EQ(pd[2], 100, "rendement le plus haut = 100");
    A(pd[0] !== undefined, "rendement 0 participe (null seulement est exclu)");
  });
  T("valScores : pondération PER 50 / rendement 30 / P/B 20 — PER exigé", function () {
    var l = [
      { n: "A", per: 5, dY: 6, pb: 0.5 },   // les trois meilleurs → 100
      { n: "B", per: 40, dY: 0, pb: 8 },    // les trois pires → 0
      { n: "C", per: null, dY: 3, pb: 2 },  // PER absent (perte) → score null
      { n: "D", per: 10, dY: null, pb: 4 }  // rendement absent → renormalisé sur per+pb
    ];
    var s = RI.valScores(l);
    EQ(s[0].score, 100, "A : tout au plancher de valorisation = 100");
    EQ(s[1].score, 0, "B : tout au plafond = 0");
    EQ(s[2].score, null, "C : pas de PER = pas de score (une perte n'est pas « pas chère »)");
    EQ(s[3].score, 45, "D : renormalisé sur PER+P/B — pPer 50 (1/2) + pPb 33 (1/3) : 0.5×50+0.2×33 = 31.7/0.7");
    EQ(s[0].pPer, 100, "percentile PER exposé");
  });
  T("insiderFrBonus : +15/+10/+4 par niveau de cluster 30 j, byName + byIsin", function () {
    var mk = function (soc, isin, k, memeAuteur) { // 3 achats ; memeAuteur → 1 acheteur (niveau 2), sinon 3 (niveau 3)
      var rows = [];
      for (var i = 0; i < 3; i++) {
        rows.push({ id: "b" + k + i, source: "FR", side: "buy", societe: soc, auteur: memeAuteur ? "Initie Unique" : "Initie " + (i + k), role: "DG", nature: "Acquisition", instrument: "Action", isin: isin, dateOp: "2026-11-0" + (i + 1), datePub: "2026-11-06", volume: 100, prix: 10, montant: 1000, url: "x" });
      }
      return rows;
    };
    var fr = mk("SOCIETE A SA", "FR0000000001", 1)        // 3 achats, 3 acheteurs → niveau 3
      .concat(mk("SOCIETE B SA", "", 10, true))           // 3 achats, MÊME acheteur → niveau 2
      .concat([{ id: "z1", source: "FR", side: "buy", societe: "SOCIETE C SA", auteur: "X", role: "DG", nature: "Acquisition", instrument: "Action", isin: "FR0000000003", dateOp: "2026-11-02", datePub: "2026-11-06", volume: 100, prix: 10, montant: 1000, url: "x" },
        { id: "z2", source: "FR", side: "buy", societe: "SOCIETE C SA", auteur: "X", role: "DG", nature: "Acquisition", instrument: "Action", isin: "FR0000000003", dateOp: "2026-11-03", datePub: "2026-11-06", volume: 100, prix: 10, montant: 1000, url: "x" }]); // 2 achats, 1 acheteur → niveau 1
    var b = RI.insiderFrBonus(fr, { since: "2026-10-15" });
    EQ(b.byName["SOCIETE A SA"].b, 15, "niveau 3 → +15");
    EQ(b.byName["SOCIETE B SA"].b, 10, "niveau 2 → +10");
    EQ(b.byName["SOCIETE C SA"].b, 4, "niveau 1 → +4");
    EQ(b.byIsin["FR0000000001"].b, 15, "index par ISIN");
    var bNone = RI.insiderFrBonus([], { since: null });
    EQ(Object.keys(bNone.byName).length, 0, "pas d'achats → bonus vide, pas d'erreur");
    // hors fenêtre : le signal ancien ne donne plus de bonus
    var old = [{ id: "o1", source: "FR", side: "buy", societe: "VIEILLE SA", auteur: "X", role: "DG", nature: "Acquisition", instrument: "Action", isin: "", dateOp: "2026-01-02", datePub: "2026-01-06", volume: 100, prix: 10, montant: 1000, url: "x" },
      { id: "o2", source: "FR", side: "buy", societe: "VIEILLE SA", auteur: "Y", role: "DG", nature: "Acquisition", instrument: "Action", isin: "", dateOp: "2026-01-03", datePub: "2026-01-07", volume: 100, prix: 10, montant: 1000, url: "x" }];
    var bOld = RI.insiderFrBonus(old, { since: "2026-10-15" });
    EQ(Object.keys(bOld.byName).length, 0, "cluster hors fenêtre 30 j → pas de bonus");
  });
  T("sbfEnrich : « ROCHE BOBOIS SA » (déclaration AMF) matche « ROCHE BOBOIS » (nom Yahoo)", function () {
    var bonus = { byName: { "ROCHE BOBOIS SA": { b: 10, level: 2, buys: 2, societe: "ROCHE BOBOIS SA" } }, byIsin: {} };
    var r = RI.sbfEnrich([{ n: "ROCHE BOBOIS", mn: "RCO", score: 55, isin: "" }, { n: "TOTALENERGIES", mn: "TTE", score: 50, isin: "" }], bonus);
    EQ(r[0].ins, 10, "préfixe au mot : la déclaration avec suffixe SA matche le nom Yahoo nu");
    EQ(r[0].insLvl, 2, "niveau du cluster reporté");
    EQ(r[0].xScore, 65, "score croisé = score + bonus");
    EQ(r[1].ins, 0, "TOTAL ne matche pas TOTALENERGIES (frontière de mot)");
    EQ(r[1].xScore, 50, "sans initiés, score croisé = score");
    var byIsin = RI.sbfEnrich([{ n: "Exemple", mn: "EX", score: 20, isin: "FR0000030823" }], { byName: {}, byIsin: { FR0000030823: { b: 10, level: 3, buys: 3, societe: "EXEMPLE SA" } } });
    EQ(byIsin[0].ins, 10, "match par ISIN direct");
    var perte = RI.sbfEnrich([{ n: "En Perte", mn: "PL", score: null, isin: "" }], bonus);
    EQ(perte[0].xScore, null, "score null → xScore null (jamais déguisé en 0+bonus)");
  });
  T("sbfSort : tri desc, nulls en fin, vues val/xins/cap", function () {
    var l = [
      { n: "A", score: 90, xScore: 90, cap: 1 },
      { n: "B", score: 20, xScore: 105, cap: 100 },
      { n: "P", score: null, xScore: null, cap: 10 }
    ];
    EQ(RI.sbfSort(l, "val").map(function (e) { return e.n; }), ["A", "B", "P"], "vue valorisation, perte en fin");
    EQ(RI.sbfSort(l, "xins").map(function (e) { return e.n; }), ["B", "A", "P"], "vue croisée : le bonus initiés peut renverser le tri");
    EQ(RI.sbfSort(l, "cap").map(function (e) { return e.n; }), ["B", "P", "A"], "vue capitalisation");
    EQ(RI.sbfSort(l, "val").length, 3, "sort ne mute pas la liste d'entrée");
  });
  T("fmtCap/fmtPct : formats français", function () {
    EQ(RI.fmtCap(2.34e12), "2,34 T€");
    EQ(RI.fmtCap(12.5e9), "12,5 Md€");
    EQ(RI.fmtCap(340e6), "340 M€");
    EQ(RI.fmtCap(null), "—");
    EQ(RI.fmtPct(1.234), "+1,23 %");
    EQ(RI.fmtPct(-0.5), "-0,5 %");
    EQ(RI.fmtPct(null), "—");
  });
  T("build-sbf120 : navboxCompanies (labels ≥ 3, exclusions v/m/CAC, hrefs absolus)", function () {
    var SB = require("./build-sbf120.js");
    var h = '<table class="navbox"><tr><td>Entreprises du CAC 40</td></tr><tr><td>' +
      '<a href="/wiki/Accor" title="Accor">Accor</a> · ' +
      '<a href="https://fr.wikipedia.org/wiki/Air liquide" title="Air liquide">Air liquide</a> · ' +
      '<a href="/wiki/Airbus" class="new">Airbus</a> · ' +                       // article inexistant → exclu
      '<a href="/wiki/Mod%C3%A8le:Indices_CAC" title="Modèle:Indices CAC">v · m</a> · ' + // bandeau → exclu
      '<a href="/wiki/Accor" title="Accor">Accor</a> · ' +                      // doublon → 1 fois
      '<a href="/wiki/CAC_Mid_60" title="CAC Mid 60">CAC Mid 60</a> · ' +        // autre indice → exclu
      '<a href="/wiki/Eiffage" title="Eiffage">Eiffage</a>' +
      '</td></tr></table>';
    var r = SB.navboxCompanies(h);
    EQ(r, [{ label: "Accor", page: "Accor" }, { label: "Air liquide", page: "Air liquide" }, { label: "Eiffage", page: "Eiffage" }],
      "seules les sociétés, dans l'ordre, sans doublons");
    EQ(SB.navboxCompanies("<p>pas de navbox</p>"), null, "pas de table « Entreprises du » → null");
  });
  T("build-sbf120 : cac40Table (41 lignes, en-tête Société|Mnémo)", function () {
    var SB = require("./build-sbf120.js");
    var rows = ['<tr><th>Société</th><th>Mnémo</th><th>Secteur</th></tr>'];
    for (var i = 0; i < 40; i++) rows.push("<tr><td>Societe " + i + "</td><td> S" + (100 + i) + " </td><td>Secteur</td></tr>");
    var h = '<table class="wikitable">' + rows.join("") + "</table>";
    var r = SB.cac40Table(h);
    EQ(r.length, 40, "40 lignes");
    EQ(r[0], { nom: "Societe 0", mnemo: "S100", secteur: "Secteur" }, "mnémo nettoyé des espaces");
    EQ(SB.cac40Table("<table><tr><td>Autre table</td></tr></table>"), null, "pas de table 41 lignes → null");
  });
  T("build-sbf120 : euronextFromWikitext (casse, espace, ISIN)", function () {
    var SB = require("./build-sbf120.js");
    EQ(SB.euronextFromWikitext("{{Euronext|AC|FR0000120404|Paris}}"), { mn: "AC", isin: "FR0000120404" }, "canonique");
    EQ(SB.euronextFromWikitext("{{euronext|ADP}}"), { mn: "ADP", isin: "" }, "minuscules, sans ISIN");
    EQ(SB.euronextFromWikitext("{{Euronext |BIM}}"), { mn: "BIM", isin: "" }, "espace avant le premier argument");
    EQ(SB.euronextFromWikitext("{{Euronext|pas-un-mnemo|X}}"), null, "mnémo non conforme rejeté");
    EQ(SB.euronextFromWikitext("pas de modèle"), null, "absence → null");
  });
  T("code mort de la v0 supprimé", function () {
    A(!fs.existsSync(__dirname + "/../app.js"), "app.js");
    A(!fs.existsSync(__dirname + "/../styles.css"), "styles.css");
    A(!fs.existsSync(__dirname + "/../insiders-core.js"), "insiders-core.js");
    A(!fs.existsSync(__dirname + "/../test-insiders.js"), "test-insiders.js");
  });
})();

// ---------- tests asynchrones : pipeline réel avec fetch injecté (SÉRIALISÉS, pas de réseau) ----------
// v3.3 : le TA de la v3.1.1 faisait « return p » sans appeler p — les tests async passaient
// sans jamais s'exécuter. Ici chaque test est réellement appelé, en chaîne (un stub fetch
// à la fois : pas de collision entre tests).
var asyncTests = [];
var seq = Promise.resolve();
function TA(name, fn) {
  seq = seq.then(function () { return fn(); }).then(function () {
    passed++; console.log("ok  [async] " + name);
  }, function (e) {
    failed++; console.log("ÉCHEC [" + name + "] : " + (e && e.message));
  });
  asyncTests.push(seq);
}
(function () {
  var FTS = fs.readFileSync(__dirname + "/fixtures/fts-sample.json", "utf8"); // 3 hits, accessions distinctes
  var okRes = function (txt) { return { ok: true, status: 200, headers: { get: function () { return null; } }, text: function () { return Promise.resolve(txt); } }; };
  var errRes = function (status, ra) { return { ok: false, status: status, headers: { get: function (k) { return k === "retry-after" ? (ra || null) : null; } }, text: function () { return Promise.resolve(""); } }; };
  // XML de succès v3.3 : achat P+A de 1 k$ + VENTE DURE de 66 746 $ (sans plan 10b5-1, sans code M)
  var XML_OK = "<ownershipDocument><rptOwnerName>Testeur I</rptOwnerName><officerTitle>CEO</officerTitle>" +
    "<nonDerivativeTransaction><transactionDate><value>2026-11-05</value></transactionDate>" +
    "<transactionCoding><transactionCode>P</transactionCode></transactionCoding>" +
    "<transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode>" +
    "<transactionAmounts><transactionShares><value>100</value></transactionShares>" +
    "<transactionPricePerShare><value>10</value></transactionPricePerShare></transactionAmounts>" +
    "</nonDerivativeTransaction>" +
    "<nonDerivativeTransaction><transactionDate><value>2026-11-05</value></transactionDate>" +
    "<transactionCoding><transactionCode>S</transactionCode></transactionCoding>" +
    "<transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode>" +
    "<transactionAmounts><transactionShares><value>2000</value></transactionShares>" +
    "<transactionPricePerShare><value>33.373</value></transactionPricePerShare></transactionAmounts>" +
    "</nonDerivativeTransaction></ownershipDocument>";
  // XML avec une vente SOUS le seuil 50 k$ (3 k$) : ne doit pas être collectée
  var XML_LOW_SELL = "<ownershipDocument><rptOwnerName>Testeur I</rptOwnerName><officerTitle>CEO</officerTitle>" +
    "<nonDerivativeTransaction><transactionDate><value>2026-11-05</value></transactionDate>" +
    "<transactionCoding><transactionCode>S</transactionCode></transactionCoding>" +
    "<transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode>" +
    "<transactionAmounts><transactionShares><value>100</value></transactionShares>" +
    "<transactionPricePerShare><value>30</value></transactionPricePerShare></transactionAmounts>" +
    "</nonDerivativeTransaction></ownershipDocument>";

  TA("fetchUs : XML en 500 ⇒ accessions NON marquées (retentées au run suivant), errRatio exposé", function () {
    FI.setFetchForTests(function (url) {
      if (url.indexOf("efts.sec.gov") > -1) return Promise.resolve(okRes(FTS));
      return Promise.resolve(errRes(500)); // les 3 XML échouent
    });
    var state = { v: 4, processedUs: [] };
    return FI.fetchUs(NOW, state, [], []).then(function (r) {
      A(r.errors === 3, "3 erreurs attendues, got " + r.errors);
      A(r.fetched === 0, "0 XML exploité");
      A(r.attempted === 3 && r.errRatio === 1, "ratio d'échec exposé au main (usOk=false si ≥ 5 tentées et > 30 %)");
      A(state.processedUs.length === 0, "AUCUNE accession marquée traitée (le bug v3 les perdait définitivement)");
    });
  });

  TA("fetchUs v3.3 : réponse 200 SANS <ownershipDocument> (page HTML de limitation) ⇒ erreur, NON marquée", function () {
    FI.setFetchForTests(function (url) {
      if (url.indexOf("efts.sec.gov") > -1) return Promise.resolve(okRes(FTS));
      return Promise.resolve(okRes("<html><body>SEC rate limit page</body></html>")); // 200 mais pas un Form 4
    });
    var state = { v: 4, processedUs: [] };
    return FI.fetchUs(NOW, state, [], []).then(function (r) {
      A(r.errors === 3, "3 réponses invalides comptées comme erreurs, got " + r.errors);
      A(r.fetched === 0, "0 XML valide");
      A(state.processedUs.length === 0, "accessions invalides non marquées (le bug v3.1.1 les perdait à jamais)");
    });
  });

  TA("fetchUs v3.3 : disjoncteur — 5 erreurs XML consécutives ⇒ run abandonné, attempted=5, errRatio=1", function () {
    var hits8 = [];
    for (var i = 0; i < 8; i++) {
      hits8.push({ _id: "acc-brk-" + i + ":ownership.xml", _source: { ciks: ["0001234567"], file_date: "2026-11-08",
        display_names: ["John Doe ()", "Acme Corp (ACME) (CIK 0001234567)"] } });
    }
    var FTS8 = JSON.stringify({ hits: { hits: hits8 } });
    FI.setFetchForTests(function (url) {
      if (url.indexOf("efts.sec.gov") > -1) return Promise.resolve(okRes(FTS8));
      return Promise.resolve(errRes(403)); // panne SEC totale
    });
    var state = { v: 4, processedUs: [] };
    return FI.fetchUs(NOW, state, [], []).then(function (r) {
      A(r.errors === 5, "le disjoncteur coupe à 5 erreurs consécutives, got " + r.errors);
      A(r.attempted === 5 && r.errRatio === 1, "5 tentées, 100 % KO -> usOk=false côté main (une panne totale ne passe plus pour un succès)");
      A(state.processedUs.length === 0, "rien de marqué : tout sera retenté au prochain run");
    });
  });

  TA("fetchUs : succès ⇒ achats ET ventes dures extraites, accessions marquées avec la date du jour", function () {
    FI.setFetchForTests(function (url) {
      if (url.indexOf("efts.sec.gov") > -1) return Promise.resolve(okRes(FTS));
      return Promise.resolve(okRes(XML_OK));
    });
    var state = { v: 4, processedUs: [] };
    return FI.fetchUs(NOW, state, [], []).then(function (r) {
      A(r.errors === 0 && r.fetched === 3, "3 XML téléchargés");
      A(r.nBuys === 3 && r.nSells === 3, "3 achats + 3 ventes DURES (66 746 $ ≥ 50 k$, sans plan ni levée), got " + r.nBuys + "/" + r.nSells);
      A(state.processedUs.length === 3, "3 accessions marquées");
      state.processedUs.forEach(function (e) {
        A(e.slice(-11) === "|2026-11-09", "entrée datée du jour : " + e);
      });
      var sell = r.sells[r.sells.length - 1];
      A(sell.side === "sell" && sell.montant === 66746, "vente dure 66 746 $ extraite");
      A(sell.p10b5 === false && sell.opt === false, "ni plan ni levée");
      var buy = r.buys[r.buys.length - 1];
      A(buy.side === "buy" && buy.montant === 1000, "achat P+A retenu");
    });
  });

  TA("fetchUs : date d'ORIGINE des accessions conservée d'un run à l'autre (le bug v3.1.1 redatait tout)", function () {
    FI.setFetchForTests(function (url) {
      if (url.indexOf("efts.sec.gov") > -1) return Promise.resolve(okRes(FTS));
      return Promise.resolve(okRes(XML_OK));
    });
    var state = { v: 4, processedUs: ["acc-old|2026-10-05"] }; // déjà traitée il y a 35 j
    return FI.fetchUs(NOW, state, [], []).then(function (r) {
      A(state.processedUs.length === 4, "3 nouvelles + l'ancienne conservée, got " + state.processedUs.length);
      A(state.processedUs.indexOf("acc-old|2026-10-05") > -1, "l'entrée ancienne garde SA date (elle expirera à 40 j, pas jamais)");
      A(r.skipped >= 0, "run sain");
    });
  });

  TA("fetchUs v3.3 : vente US < 50 k$ NON collectée", function () {
    FI.setFetchForTests(function (url) {
      if (url.indexOf("efts.sec.gov") > -1) return Promise.resolve(okRes(FTS));
      return Promise.resolve(okRes(XML_LOW_SELL)); // vente de 3 k$
    });
    return FI.fetchUs(NOW, { v: 4, processedUs: [] }, [], []).then(function (r) {
      A(r.nBuys === 0 && r.nSells === 0, "aucune ligne extraite (la vente de 3 k$ est filtrée), got " + r.nBuys + "/" + r.nSells);
      A(r.sells.length === 0, "aucune vente dans la liste");
    });
  });

  TA("fetchUs v3.3 : migration v4 — ventes < 50 k$ purgées, anciens ids de la fenêtre 3 j re-téléchargés", function () {
    FI.setFetchForTests(function (url) {
      if (url.indexOf("efts.sec.gov") > -1) return Promise.resolve(okRes(FTS));
      return Promise.resolve(errRes(403)); // on teste la migration, pas le téléchargement
    });
    var oldId = "acc1|own|P|2026-11-07|100"; // 5 segments = ancien format v3
    var prevBuys = [
      { id: oldId, source: "US", side: "buy", societe: "A CORP", ticker: "A", auteur: "X", dateOp: "2026-11-07", datePub: "2026-11-08", volume: 100, prix: 10, montant: 1000 },
      { id: "acc2|own|P|2026-08-01|100", source: "US", side: "buy", societe: "B CORP", ticker: "B", auteur: "Y", dateOp: "2026-08-01", datePub: "2026-09-01", volume: 100, prix: 10, montant: 1000 }
    ];
    var prevSells = [
      { id: "acc3|own|S|2026-11-07|100", source: "US", side: "sell", societe: "A CORP", ticker: "A", auteur: "X", dateOp: "2026-11-07", datePub: "2026-11-08", volume: 100, prix: 10, montant: 66746 },
      { id: "acc4|own|S|2026-10-01|100", source: "US", side: "sell", societe: "C CORP", ticker: "C", auteur: "Z", dateOp: "2026-10-01", datePub: "2026-10-02", volume: 100, prix: 10, montant: 30000 },
      { id: "acc5|own|S|2026-08-01|100", source: "US", side: "sell", societe: "D CORP", ticker: "D", auteur: "W", dateOp: "2026-08-01", datePub: "2026-09-01", volume: 100, prix: 10, montant: 60000 }
    ];
    var state = { v: 3, processedUs: ["acc-legacy-1"] };
    return FI.fetchUs(NOW, state, prevBuys, prevSells).then(function (r) {
      EQ(state.v, 4, "état migré en v4 (une seule fois)");
      EQ(state.processedUs.length, 0, "mémoire US réinitialisée : la fenêtre 3 j sera re-téléchargée avec les nouveaux ids");
      A(r.buys.some(function (x) { return x.id === oldId; }) === false, "ligne ancien id DANS la fenêtre 3 j supprimée (re-téléchargée, pas dupliquée)");
      A(r.buys.some(function (x) { return x.societe === "B CORP"; }), "ligne ancien id HORS fenêtre conservée (expire avec KEEP_DAYS)");
      EQ(r.sells.length, 1, "il ne reste que la vente dure ≥ 50 k$ hors fenêtre, got " + r.sells.length);
      A(r.sells[0].societe === "D CORP", "vente ≥ 50 k$ conservée");
      A(r.sells.some(function (x) { return x.montant === 30000; }) === false, "vente < 50 k$ purgée (dette v3.1.1)");
    });
  });

  TA("fetchUs v3.3 : Retry-After honoré sur les XML (429 puis 200)", function () {
    var seen = {};
    FI.setFetchForTests(function (url) {
      if (url.indexOf("efts.sec.gov") > -1) return Promise.resolve(okRes(FTS));
      seen[url] = (seen[url] || 0) + 1;
      if (seen[url] === 1) return Promise.resolve(errRes(429, "1")); // la SEC demande 1 s de pause
      return Promise.resolve(okRes(XML_OK));
    });
    var t0 = Date.now();
    return FI.fetchUs(NOW, { v: 4, processedUs: [] }, [], []).then(function (r) {
      A(r.fetched === 3 && r.errors === 0, "3 XML au bout du compte, 0 erreur définitive");
      var xmlCalls = Object.keys(seen).map(function (k) { return seen[k]; }).reduce(function (a, b) { return a + b; }, 0);
      EQ(xmlCalls, 6, "chaque XML a bien été retenté (retry(fn, 2) — la v3.1.1 ne faisait qu'une tentative)");
      A(Date.now() - t0 >= 2900, "Retry-After de 1 s réellement attendu par XML");
    });
  });

  TA("fetchUs v3.3 : canari du parseur — 400 XML téléchargés, 0 ligne ⇒ canary (pas de succès silencieux)", function () {
    RI.CFG.US_RL_MS = 1; // test rapide (400 téléchargements simulés)
    var mkFts = function (from) {
      var hs = [];
      for (var i = 0; i < 100; i++) {
        var n = from + i;
        hs.push({ _id: "acc-can-" + n + ":ownership.xml", _source: { ciks: ["0001234567"], file_date: "2026-11-08",
          display_names: ["John Doe ()", "Acme Corp (ACME) (CIK 0001234567)"] } });
      }
      return JSON.stringify({ hits: { hits: hs } });
    };
    FI.setFetchForTests(function (url) {
      var m = String(url).match(/from=(\d+)/);
      if (m) return Promise.resolve(okRes(mkFts(parseInt(m[1], 10)))); // 6 pages × 100 hits
      return Promise.resolve(okRes("<ownershipDocument></ownershipDocument>")); // Form 4 vide : 0 transaction
    });
    return FI.fetchUs(NOW, { v: 4, processedUs: [] }, [], []).then(function (r) {
      RI.CFG.US_RL_MS = 180; // restauration pour la suite
      A(r.fetched === 400, "400 XML téléchargés (budget), got " + r.fetched);
      A(r.nBuys + r.nSells === 0, "0 ligne extraite");
      A(r.canary === true, "canari déclenché : le main conserve les listes précédentes");
      A(r.capped === true, "plafond 600 hits signalé (couverture partielle de la fenêtre 3 j)");
      A(r.errRatio === 0, "pas d'erreurs réseau : la panne est côté parseur, pas côté SEC");
    });
  });

  TA("fetchFr : canari — déclarations brutes présentes mais 0 parsée ⇒ échec ; requête bien Acquisition+Cession", function () {
    var bodies = [];
    FI.setFetchForTests(function (url, init) {
      bodies.push(String((init && init.body) || ""));
      return Promise.resolve(okRes("<html><body>Déclaration n° 1 Déclaration n° 2 (structure changée, aucun tableau connu)</body></html>"));
    });
    return FI.fetchFr(NOW).then(function () {
      throw new Error("le canari aurait dû faire échouer fetchFr");
    }, function (e) {
      A(String(e.message).indexOf("CANARI") > -1, "message canari, got : " + e.message);
      A(bodies.length >= 1 && bodies[0].indexOf("f_nature%5B%5D=Acquisition") > -1 && bodies[0].indexOf("f_nature%5B%5D=Cession") > -1,
        "la requête FR demande bien les acquisitions ET les cessions : " + bodies[0]);
      A(bodies[0].indexOf("f_montant_min=" + RI.CFG.FR_MIN_EUR) > -1, "montant min transmis au service");
    });
  });

  TA("UA : contact SEC réel (plus d'adresse @example.com)", function () {
    A(FI.UA.indexOf("contact@example.com") === -1, "UA sans exemple bidon");
    A(FI.UA.indexOf("SentinellePerso research") === 0, "UA format SEC");
    A(FI.UA.length > 30, "UA contient un contact");
  });

  TA("v3.2 fetchFundamentals : essai des tags de revenus en cascade, fondamentaux extraits", function () {
    var TICKERS = fs.readFileSync(__dirname + "/fixtures/company_tickers-sample.json", "utf8");
    var calls = [];
    FI.setFetchForTests(function (url) {
      calls.push(url);
      if (url.indexOf("company_tickers") > -1) return Promise.resolve(okRes(TICKERS));
      if (url.indexOf("RevenueFromContractWithCustomerExcludingAssessedTax") > -1) return Promise.resolve(errRes(404)); // tag non utilisé par SVIA
      if (url.indexOf("/us-gaap/Revenues.json") > -1) return Promise.resolve(okRes(fs.readFileSync(__dirname + "/fixtures/xbrl-rev-sample.json", "utf8")));
      if (url.indexOf("NetIncomeLoss") > -1) return Promise.resolve(okRes(fs.readFileSync(__dirname + "/fixtures/xbrl-ni-sample.json", "utf8")));
      return Promise.resolve(errRes(404));
    });
    return FI.fetchFundamentals([{ ticker: "SVIA", societe: "SILVIA, INC." }], function () { }).then(function (funds) {
      A(funds.SVIA != null, "SVIA documentée");
      EQ(funds.SVIA.growth, 50, "croissance +50 %");
      EQ(funds.SVIA.ni, 30000000, "NI 30 M$");
      A(funds.NOTCO == null && funds.KLEA == null, "seules les candidates demandées");
      A(calls.some(function (u) { return u.indexOf("RevenueFromContractWithCustomerExcludingAssessedTax") > -1; }),
        "le 1er tag de revenus a bien été essayé avant repli sur Revenues");
    });
  });

  TA("computePicks v3.3 : clusters US + FR → data.picks { us: [...], fr: [...] }", function () {
    FI.setFetchForTests(function (url) {
      if (url.indexOf("company_tickers") > -1) return Promise.resolve(okRes(fs.readFileSync(__dirname + "/fixtures/company_tickers-sample.json", "utf8")));
      if (url.indexOf("RevenueFromContractWithCustomerExcludingAssessedTax") > -1) return Promise.resolve(errRes(404));
      if (url.indexOf("/us-gaap/Revenues.json") > -1) return Promise.resolve(okRes(fs.readFileSync(__dirname + "/fixtures/xbrl-rev-sample.json", "utf8")));
      if (url.indexOf("NetIncomeLoss") > -1) return Promise.resolve(okRes(fs.readFileSync(__dirname + "/fixtures/xbrl-ni-sample.json", "utf8")));
      return Promise.resolve(errRes(404));
    });
    var mkUs = function (id, auteur, volume, k) {
      return { id: id, source: "US", side: "buy", societe: "SILVIA, INC.", ticker: "SVIA", auteur: auteur, role: "CEO",
        montant: volume * 10, volume: volume, prix: 10, dateOp: dayAt(k + 2), datePub: dayAt(k + 1) };
    };
    var mkFr = function (id, auteur, volume, k) {
      return { id: id, source: "FR", side: "buy", societe: "ROCHE BOBOIS SA", isin: "FR0013344173", auteur: auteur, role: "Président",
        montant: volume * 16, volume: volume, prix: 16, dateOp: dayAt(k + 2), datePub: dayAt(k + 1) };
    };
    var data = {
      us: [mkUs("s1", "Noor", 5000, 1), mkUs("s2", "Zang", 6000, 0)], // volumes différents : pas de dédoublonnage
      usS: [],
      fr: [mkFr("f1", "Tamburi", 1400, 2), mkFr("f2", "Txr", 600, 1), mkFr("f3", "Tamburi", 500, 0)],
      frS: []
    };
    return FI.computePicks(data, function () { }).then(function () {
      A(data.picks && data.picks.us.length === 1, "1 piste US, got " + (data.picks && data.picks.us.length));
      EQ(data.picks.us[0].ticker, "SVIA");
      A(data.picks.us[0].score === 14.5, "5 (initiés) + 9.5 (fondamentaux) = 14.5/20");
      EQ(data.picks.us[0].fund.growth, 50);
      EQ(data.picks.us[0].fund.ni, 30000000);
      A(data.picks.fr.length === 1, "1 piste FR (signal initiés seul)");
      EQ(data.picks.fr[0].societe, "ROCHE BOBOIS SA");
      A(data.picks.fr[0].score === 6.5, "score initiés /10, pas de fondamentaux inventés");
      A(data.picks.fr[0].fund === undefined, "pas de champ fund côté FR");
    });
  });

  TA("computePicks : XBRL injoignable ⇒ échec explicite, pistes précédentes conservées", function () {
    FI.setFetchForTests(function () { return Promise.resolve(errRes(403)); }); // même le registre tickers est bloqué
    var mk = function (id, auteur, volume, k) {
      return { id: id, source: "US", side: "buy", societe: "SILVIA, INC.", ticker: "SVIA", auteur: auteur,
        montant: volume * 10, volume: volume, prix: 10, dateOp: dayAt(k + 2), datePub: dayAt(k + 1) };
    };
    var data = {
      us: [mk("s1", "Noor", 5000, 1), mk("s2", "Zang", 6000, 0)],
      usS: [], fr: [], frS: [],
      picks: { updated: "2026-11-09T08:00:00Z", us: [{ ticker: "OLD", societe: "Old Corp", score: 5,
        insider: { score: 5, buys: 2, buyers: 2, level: 2, total: 100000, avgPx: 10, first: "2026-11-05", last: "2026-11-06" },
        sells: { n: 0, hard: 0 }, fund: { score: 0, growth: 0, ni: 0, rev: 1, revEnd: "2024-12-31", margin: 0 } }], fr: [] }
    };
    return FI.computePicks(data, function () { }).then(function () {
      throw new Error("computePicks aurait dû échouer");
    }, function (e) {
      A(/403|XBRL|fondamental/.test(String(e.message)), "erreur explicite : " + e.message);
      EQ(data.picks.us[0].ticker, "OLD", "pistes précédentes conservées (pas de vidage silencieux)");
    });
  });

  TA("computePicks : aucun cluster nettoyé (FR ni US) ⇒ pistes vidées honnêtement {us:[],fr:[]}", function () {
    var calls = 0;
    FI.setFetchForTests(function () { calls++; return Promise.resolve(errRes(403)); }); // ne doit pas être appelé
    var data = {
      us: [{ id: "s1", source: "US", side: "buy", societe: "SOLO CORP", ticker: "SOLO", auteur: "Solo",
        montant: 50000, volume: 5000, prix: 10, dateOp: dayAt(2), datePub: dayAt(1) }],
      usS: [],
      fr: [{ id: "f1", source: "FR", side: "buy", societe: "SEUL SA", auteur: "Seul",
        montant: 5000, volume: 500, prix: 10, dateOp: dayAt(2), datePub: dayAt(1) }],
      frS: []
    };
    return FI.computePicks(data, function () { }).then(function () {
      A(data.picks && data.picks.us.length === 0, "pistes US vides (un achat isolé n'est pas une piste)");
      A(data.picks.fr.length === 0, "pistes FR vides");
      EQ(calls, 0, "aucune requête XBRL envoyée quand il n'y a rien à documenter");
    });
  });

  TA("notifyNtfy : POST vers ntfy.sh/<topic> avec titre et messages ; topic vide ⇒ no-op", function () {
    var calls = [];
    FI.setFetchForTests(function (url, init) {
      calls.push({ url: url, init: init });
      return Promise.resolve({ ok: true });
    });
    return FI.notifyNtfy("topic-secret-123", ["🚨 message 1", "🚨 message 2"]).then(function (n) {
      EQ(n, 2, "2 messages notifiés");
      EQ(calls.length, 1, "1 requête POST");
      EQ(calls[0].url, "https://ntfy.sh/topic-secret-123");
      EQ(calls[0].init.method, "POST");
      A(String(calls[0].init.body).indexOf("message 1") > -1, "body = les messages");
      EQ(calls[0].init.headers.Title, "Sentinelle perso");
      return FI.notifyNtfy("", ["x"]).then(function (n0) {
        A(n0 === 0 && calls.length === 1, "topic vide (secret absent) ⇒ aucun envoi, le run continue");
      });
    });
  });
})();

// ---------- v4.0 : tests asynchrones SBF 120 (fetch injecté, sérialisés eux aussi) ----------
(function () {
  var FQ = require("./fetch-quotes.js");
  var SB2 = require("./build-sbf120.js");
  function res(status, body, headers) {
    var h = headers || {};
    return {
      status: status,
      headers: {
        get: function (k) { return h[String(k).toLowerCase()] || null; },
        getSetCookie: function () { return h["set-cookie"] || []; }
      },
      text: function () { return Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)); }
    };
  }
  TA("fetch-quotes : yahooSession exige un 200 sur getcrumb — le corps 429 « Too Many Requests » ne devient jamais un crumb", function () {
    var n = 0;
    FQ.setFetchForTests(function (url) {
      if (String(url).indexOf("fc.yahoo.com") > -1) return Promise.resolve(res(404, "", { "set-cookie": ["A1=d=abc123; Path=/; Max-Age=31536000"] }));
      n++;
      if (n === 1) return Promise.resolve(res(429, "Too Many Requests"));
      return Promise.resolve(res(200, "crumb4tests"));
    });
    return FQ.yahooSession(3).then(function (s) {
      EQ(s.crumb, "crumb4tests", "crumb valide : le 429 a été rejeté puis retenté");
      EQ(s.cookie, "A1=d=abc123", "cookie de session extrait");
    });
  });
  TA("fetch-quotes : 100 valeurs en 3 batchs + 1 indice ; valeur muette → missing ; garde < 90 % en échec", function () {
    var sbList = [];
    for (var i = 0; i < 100; i++) sbList.push({ n: "Val " + i, y: "V" + (1000 + i) + ".PA", mn: "V" + (1000 + i), g: "mid60", isin: "", disp: "Val " + i });
    var sb = { updated: "2026-01-01T00:00:00Z", source: "fixture", counts: {}, list: sbList };
    var batchCalls = 0;
    FQ.setFetchForTests(function (url) {
      var u = String(url);
      if (u.indexOf("fc.yahoo.com") > -1) return Promise.resolve(res(404, "", { "set-cookie": ["A1=d=x"] }));
      if (u.indexOf("getcrumb") > -1) return Promise.resolve(res(200, "c"));
      if (u.indexOf("/quote?symbols=") > -1) {
        batchCalls++;
        var syms = decodeURIComponent(u.split("symbols=")[1].split("&")[0]).split(",");
        var out = syms.map(function (s) {
          if (s === "^SBF120") return { symbol: s, shortname: "SBF 120", regularMarketPrice: 6850.4, regularMarketChangePercent: 0.62, regularMarketTime: 1799900000 };
          if (s === "V1099.PA") return null; // une valeur sans cote → missing, pas d'échec du relevé
          return { symbol: s, shortname: s.replace(".PA", ""), regularMarketPrice: 42.5, regularMarketChangePercent: 1.1, trailingPE: 12.4, forwardPE: 11.1, dividendYield: 2.35, priceToBook: 1.8, marketCap: 2.5e9, regularMarketTime: 1799900000 };
        }).filter(Boolean);
        return Promise.resolve(res(200, { quoteResponse: { result: out } }));
      }
      return Promise.resolve(res(404, ""));
    });
    return FQ.fetchQuotes(sb, {}).then(function (q) {
      EQ(q.n, 99, "99 cotes (1 valeur muette)");
      EQ(q.missing, ["V1099.PA"], "la valeur sans cote est listée dans missing");
      A(q.ok === true, "relevé déclaré OK");
      EQ(batchCalls, 4, "3 batchs de 40 + 1 pour l'indice = 4 requêtes (jamais 101 requêtes individuelles)");
      A(q.idx && q.idx.px === 6850.4, "indice récupéré");
      EQ(q.list[0].per, 12.4, "PER trailing conservé");
      EQ(q.list[0].dY, 2.35, "rendement conservé");
      EQ(q.list[0].g, "mid60", "groupe reporté depuis sbf120.json");
      // garde : minRatio inatteignable → échec, on ne sert JAMAIS un relevé partiel
      return FQ.fetchQuotes(sb, { minRatio: 0.995 }).then(function () {
        throw new Error("la garde aurait dû déclencher");
      }, function (e) {
        A(String(e.message).indexOf("trop peu de réponses") > -1, "garde 90 % : " + e.message);
      });
    });
  });
  TA("fetch-quotes : 429 sur un batch → Retry-After honoré, batch retenté puis réussi", function () {
    var n = 0;
    FQ.setFetchForTests(function () {
      n++;
      if (n === 1) return Promise.resolve(res(429, "", { "retry-after": "0" }));
      return Promise.resolve(res(200, { quoteResponse: { result: [{ symbol: "AIR.PA", regularMarketPrice: 1 }] } }));
    });
    return FQ.quotesBatch(["AIR.PA"], { cookie: "a", crumb: "c" }, 3).then(function (r) {
      EQ(r.length, 1, "réponse après retry");
      EQ(n, 2, "1 tentative 429 + 1 réussie");
    });
  });
  TA("fetch-quotes : réponse JSON inattendue → erreur, pas de quotes.json corrompu", function () {
    FQ.setFetchForTests(function (url) {
      var u = String(url);
      if (u.indexOf("fc.yahoo.com") > -1) return Promise.resolve(res(404, "", { "set-cookie": ["A1=d=x"] }));
      if (u.indexOf("getcrumb") > -1) return Promise.resolve(res(200, "c"));
      return Promise.resolve(res(200, "ceci n'est pas du JSON attendu"));
    });
    return FQ.fetchQuotes({ list: sbf100() }, {}).then(function () {
      throw new Error("aurait dû échouer");
    }, function (e) { A(String(e.message).length > 0, "échec propre : " + e.message); });
  });

  // ---------- v4.0.4 : repli TradingView — couverture harnais (revue Jade du 09/11) ----------
  TA("v4.0.4 tvTicker : MC.PA → EURONEXT:MC, insensible à la casse", function () {
    EQ(FQ.tvTicker("MC.PA"), "EURONEXT:MC");
    EQ(FQ.tvTicker("mc.pa"), "EURONEXT:MC");
    EQ(FQ.tvTicker("AIR.PA"), "EURONEXT:AIR");
  });
  TA("v4.0.4 tvScan : erreurs HTTP répétées → échec explicite, jamais de bouillie", function () {
    var n = 0;
    FQ.setFetchForTests(function () {
      n++;
      return Promise.resolve(res(500, "boom"));
    });
    return FQ.tvScan(["EURONEXT:MC"], 2).then(function () {
      throw new Error("tvScan aurait dû échouer");
    }, function (e) {
      EQ(n, 2, "tentatives épuisées puis abandon");
      A(String(e.message).indexOf("scanner TV en échec") > -1, "échec explicite : " + e.message);
    });
  });
  TA("v4.0.4 fetchQuotesTv : réponses partielles → missing ; métriques reportées ; indice repli nommé", function () {
    var sb = { updated: "2026-01-01T00:00:00Z", list: sbf100() };
    FQ.setFetchForTests(function (url, opts) {
      A(String(url).indexOf("scanner.tradingview.com") > -1, "URL scanner TV : " + url);
      var body = JSON.parse(opts.body);
      var out = [];
      body.symbols.tickers.forEach(function (t) {
        if (t === "EURONEXT:PX1") { out.push({ s: t, d: ["PX1", 8229.14, 1.07] }); return; }
        var key = t.split(":")[1];
        var n = parseInt(key.slice(1), 10);
        if (n >= 2095) return; // 5 valeurs muettes → missing (95 % > garde 90 %)
        out.push({ s: t, d: [key, 42.5, 1.1, 12.4, null, 2.35, 1.8, 2.5e9] });
      });
      return Promise.resolve(res(200, { totalCount: out.length, data: out }));
    });
    return FQ.fetchQuotesTv(sb, {}).then(function (q) {
      EQ(q.n, 95, "95 cotes, 5 muettes");
      EQ(q.missing.length, 5, "les muettes sont listées dans missing");
      A(String(q.source).indexOf("TradingView") > -1, "source = repli TradingView");
      A(q.idx && q.idx.px === 8229.14, "indice de repli récupéré");
      A(String(q.idx.name).indexOf("CAC 40") > -1, "indice nommé honnêtement (pas déguisé en SBF 120)");
      EQ(q.list[0].per, 12.4, "PER trailing reporté");
      EQ(q.list[0].cap, 2.5e9, "capitalisation reportée");
      EQ(q.list[0].fper, null, "forward PER absent sur EURONEXT → null");
    });
  });
  TA("v4.0.4 fetchQuotesTv : garde < 90 % → rejet, pas de relevé partiel servi", function () {
    var sb = { updated: "2026-01-01T00:00:00Z", list: sbf100() };
    FQ.setFetchForTests(function (url, opts) {
      var body = JSON.parse(opts.body);
      var out = [];
      body.symbols.tickers.forEach(function (t) {
        if (t === "EURONEXT:PX1") { out.push({ s: t, d: ["PX1", 8229.14, 1.07] }); return; }
        var key = t.split(":")[1];
        if (parseInt(key.slice(1), 10) >= 2050) return; // 50 réponses = 50 % < garde
        out.push({ s: t, d: [key, 42.5, 1.1, 12.4, null, 2.35, 1.8, 2.5e9] });
      });
      return Promise.resolve(res(200, { totalCount: out.length, data: out }));
    });
    return FQ.fetchQuotesTv(sb, {}).then(function () {
      throw new Error("la garde aurait dû déclencher");
    }, function (e) {
      A(String(e.message).indexOf("trop peu de réponses TradingView") > -1, "garde 90 % : " + e.message);
    });
  });
  TA("v4.0.4 fetchQuotesTv : indice absent → rejet explicite avant écriture (règle : pas de quotes.json sans indice)", function () {
    var sb = { updated: "2026-01-01T00:00:00Z", list: sbf100() };
    FQ.setFetchForTests(function (url, opts) {
      var body = JSON.parse(opts.body);
      var out = [];
      body.symbols.tickers.forEach(function (t) {
        if (t === "EURONEXT:PX1") return; // l'indice ne répond jamais
        out.push({ s: t, d: [t.split(":")[1], 42.5, 1.1, 12.4, null, 2.35, 1.8, 2.5e9] });
      });
      return Promise.resolve(res(200, { totalCount: out.length, data: out }));
    });
    return FQ.fetchQuotesTv(sb, {}).then(function () {
      throw new Error("aurait dû être rejeté sans indice");
    }, function (e) {
      A(String(e.message).indexOf("indice de repli") > -1, "rejet explicite : " + e.message);
    });
  });
  TA("v4.0.4 fetchQuotesAuto : Yahoo KO → bascule TradingView automatique", function () {
    var sb = { updated: "2026-01-01T00:00:00Z", list: sbf100() };
    FQ.setFetchForTests(function (url, opts) {
      var u = String(url);
      if (u.indexOf("scanner.tradingview.com") > -1) {
        var body = JSON.parse(opts.body);
        var out = body.symbols.tickers.map(function (t) {
          return t === "EURONEXT:PX1"
            ? { s: t, d: ["PX1", 8229.14, 1.07] }
            : { s: t, d: [t.split(":")[1], 42.5, 1.1, 12.4, null, 2.35, 1.8, 2.5e9] };
        });
        return Promise.resolve(res(200, { totalCount: out.length, data: out }));
      }
      return Promise.resolve(res(429, "Too Many Requests")); // Yahoo sature
    });
    return FQ.fetchQuotesAuto(sb, { sessionAttempts: 1 }).then(function (q) {
      A(String(q.source).indexOf("TradingView") > -1, "relevé final via le repli");
      EQ(q.n, 100, "100 cotes via TradingView");
    });
  });
  TA("v4.0.5 valScores : percentiles PAR SECTEUR (≥ 8 pairs) ; secteur trop petit ou absent → vs indice ; vBase/vMode", function () {
    var l = [];
    for (var i = 0; i < 8; i++) l.push({ n: "B" + i, per: 10 + 2 * i, sec: "Banques" }); // 8 → mode secteur
    for (var j = 0; j < 7; j++) l.push({ n: "E" + j, per: 5 + j, sec: "Énergie" });     // 7 → trop petit → index
    l.push({ n: "X", per: 40 });                                                        // sans secteur → index
    var s = RI.valScores(l);
    A(s[0].vMode === "sector" && s[7].vMode === "sector", "8 banques → classées vs secteur");
    A(s[8].vMode === "index" && s[14].vMode === "index", "secteur de 7 (< 8) → vs indice");
    EQ(s[15].vMode, "index", "sans secteur → vs indice");
    EQ(s[0].pPer, 100, "PER 10 = le moins cher DES BANQUES → 100 (l'Énergie à 5 n'est pas dans le pool)");
    EQ(s[7].pPer, 0, "PER 24 = le plus cher des banques → 0");
    EQ(s[8].pPer, 100, "Énergie PER 5 = le moins cher de TOUTE la liste → 100 en mode indice");
    EQ(s[0].vBase, 1, "une seule métrique (per) → base 1/3");
    EQ(s[0].score, 100, "score renormalisé sur le PER seul");
  });
  TA("v4.0.5 fetchQuotesTv : secteur TradingView (d[8]) + sbUpdated reportés dans le relevé", function () {
    var sb = { updated: "2026-01-01T00:00:00Z", list: sbf100() };
    FQ.setFetchForTests(function (url, opts) {
      var body = JSON.parse(opts.body);
      var out = body.symbols.tickers.map(function (t) {
        return t === "EURONEXT:PX1"
          ? { s: t, d: ["PX1", 8229.14, 1.07] }
          : { s: t, d: [t.split(":")[1], 42.5, 1.1, 12.4, null, 2.35, 1.8, 2.5e9, "Consumer Non-Durables"] };
      });
      return Promise.resolve(res(200, { totalCount: out.length, data: out }));
    });
    return FQ.fetchQuotesTv(sb, {}).then(function (q) {
      EQ(q.sbUpdated, "2026-01-01T00:00:00Z", "sbUpdated = date de la composition propagée");
      A(q.list.length > 0 && q.list[0].sec === "Consumer Non-Durables", "secteur TV reporté sur les lignes");
    });
  });
  T("v4.0.5 build-sbf120/fetch-quotes : le marqueur approx n'est plus perdu en route", function () {
    var b = fs.readFileSync(__dirname + "/../tools/build-sbf120.js", "utf8");
    A(b.indexOf("approx = r.approx === true") > -1, "addGroup relit approx du resolveur");
    A(b.indexOf("approx: e.approx === true ? true : undefined") > -1, "assemblage final garde approx (sbf120.json)");
    var f = fs.readFileSync(__dirname + "/../tools/fetch-quotes.js", "utf8");
    A(f.indexOf("approx: e.approx === true ? true : undefined") > -1, "relevés quotes.json gardent approx (Yahoo + TV)");
  });
  T("v4.0.7/4.0.8 rankPctAny : négatifs PARTICIPENT, ex æquo → rang moyen, toutes égales → 50", function () {
    var l = [{ gRev: 0.05 }, { gRev: -0.02 }, { gRev: 0.01 }];
    var p = RI.rankPctAny(l, "gRev", false);
    EQ(p[0], 100, "croissance 5 % = la meilleure");
    EQ(p[1], 0, "croissance NÉGATIVE participe et finit dernière (rankPct l'aurait exclue)");
    EQ(p[2], 50, "croissance 1 % au milieu");
    var d = RI.rankPctAny([{ de: 30 }, { de: 60 }], "de", true);
    EQ(d[0], 100, "dette 30 % < 60 % → 100 (bas mieux)");
    // v4.0.8 : ex æquo → rang moyen (mi-partage des égalités), plus de « toute égale = 0 »
    var t = RI.rankPctAny([{ de: 30 }, { de: 30 }, { de: 60 }], "de", true);
    EQ(t[0], 75, "ex æquo à 30 : battu 1, à égalité 1 → (1+0,5)/2 = 75");
    EQ(t[1], 75, "l'autre 30 reçoit le même rang moyen");
    EQ(t[2], 0, "le 60 reste dernier");
    var all = RI.rankPctAny([{ gRev: 1 }, { gRev: 1 }, { gRev: 1 }], "gRev", false);
    EQ(all[0], 50, "toutes égales → 50 (rang neutre), pas 0");
    EQ(all[2], 50, "rang neutre sur toute la liste");
  });
  // ---------- v4.1.0 : onglet 🇫🇷 CAC 40 — score composite d'achat + bandeau macro ----------
  T("v4.1.0 cacScores : qualité 40 % + valorisation 25 % + consensus 35 %, renormalisé si composante absente, ≥ 2/3 exigées", function () {
    // 5 lignes : A/B/C/D cac40, E mid60. Percentile consensus sur les 4 lignes avec upX (n-1=3).
    // pUp attendus : A=100 (3 battus), B=0, C=null (pas d'upX), D=33 (1 battu : B), E=67 (2 battus).
    var l = [
      { g: "cac40", n: "A", qScore: 80, score: 60, upX: 20 },
      { g: "cac40", n: "B", qScore: 40, score: 30, upX: -20 },
      { g: "cac40", n: "C", qScore: 70, score: 80, upX: null },
      { g: "cac40", n: "D", qScore: null, score: 50, upX: 0 },
      { g: "mid60", n: "E", qScore: 60, score: 70, upX: 10 }
    ];
    var s = RI.cacScores(l);
    EQ(s[0].pUp, 100, "A : meilleur potentiel → percentile 100");
    EQ(s[1].pUp, 0, "B : potentiel le plus bas → 0 (les NÉGATIFS participent)");
    EQ(s[2].pUp, null, "C : pas d'upX → percentile null, composante écartée");
    EQ(s[3].pUp, 33, "D : 1 battu sur 3 → (1+0,5)/... → 33");
    EQ(s[4].pUp, 67, "E : 2 battus sur 3 → 67");
    // aScore A = 0,4×80 + 0,25×60 + 0,35×100 = 82 → 🥇 strong (base 3/3)
    EQ(s[0].aScore, 82, "A : composite complet 82");
    EQ(s[0].aBase, 3, "A : 3 composantes");
    EQ(s[0].verdict, "strong", "A : ≥ 70 → 🥇 priorité");
    // aScore B = 0,4×40 + 0,25×30 + 0,35×0 = 23,5 → 24 → ⏸ wait
    EQ(s[1].aScore, 24, "B : composite 24");
    EQ(s[1].verdict, "wait", "B : < 40 → ⏸ attendre");
    // C : consensus absent → (0,4×70 + 0,25×80)/0,65 = 73,85 → 74 → strong, base 2/3
    EQ(s[2].aScore, 74, "C : renormalisé sur qualité+valorisation");
    EQ(s[2].aBase, 2, "C : base 2/3");
    EQ(s[2].verdict, "strong", "C : 74 ≥ 70 → 🥇");
    // D : qualité absente → (0,25×50 + 0,35×33)/0,6 = 40,08 → 40 → mid, base 2/3
    EQ(s[3].aScore, 40, "D : renormalisé sur valorisation+consensus");
    EQ(s[3].aBase, 2, "D : base 2/3");
    EQ(s[3].verdict, "mid", "D : 40 → 🥉 neutre");
    // E : 0,4×60 + 0,25×70 + 0,35×67 = 64,95 → 65 → good
    EQ(s[4].aScore, 65, "E : composite 65");
    EQ(s[4].verdict, "good", "E : 55-69 → 🥈 opportunité");
  });
  T("v4.1.0 cacScores : UNE SEULE composante → pas de score (on n'invente rien)", function () {
    var solo = RI.cacScores([{ g: "cac40", qScore: 90, score: null, upX: null }]);
    EQ(solo[0].aScore, null, "qualité seule → null");
    EQ(solo[0].aBase, 1, "base 1/3");
    EQ(solo[0].verdict, null, "pas de verdict");
  });
  T("v4.1.0 cacFilter/cacSort : périmètre = groupe cac40 ; tri aScore décroissant, null en fin", function () {
    var l = [
      { g: "mid60", n: "M", aScore: 90 },
      { g: "cac40", n: "A", aScore: 40 },
      { g: "cac40", n: "B", aScore: 82 },
      { g: "next20", n: "N", aScore: 99 },
      { g: "cac40", n: "C", aScore: null }
    ];
    var f = RI.cacFilter(l);
    EQ(f.length, 3, "seules les 3 lignes cac40 passent");
    var s = RI.cacSort(f);
    EQ(s[0].n, "B", "meilleur score en tête");
    EQ(s[1].n, "A", "puis le suivant");
    EQ(s[2].n, "C", "score null (composantes insuffisantes) en fin — jamais caché");
  });
  T("v4.1.0 macroState : champs validés, spread en pb, direction BCE en liste blanche, âge + péremption", function () {
    var now = Date.parse("2026-11-12T12:00:00Z");
    var m = RI.macroState({ dateData: "2026-11-09", source: "Radar Conjoncture", vix: 21.4, oat10: 4.76, bund10: 3.25, bceDepot: 2, bceDir: "hausse", inflZE: 2.2, pmiZE: "abc" }, now);
    A(m != null, "objet macro reconnu");
    EQ(m.spread, 151, "spread OAT-Bund (4,76-3,25)×100 = 151 pb");
    EQ(m.ageDays, 3, "3 jours d'âge");
    EQ(m.stale, false, "pas périmé à 3 j (seuil 10 j)");
    EQ(m.bceDir, "hausse", "direction BCE valide");
    EQ(m.pmiZE, null, "PMI non numérique → null (jamais affiché comme fait)");
    EQ(m.src, "Radar Conjoncture", "source propagée");
    var old = RI.macroState({ dateData: "2026-09-01", oat10: 3, bund10: 2.4 }, now);
    EQ(old.ageDays, 72, "72 jours d'âge");
    EQ(old.stale, true, "périmé (> 10 j) → l'UI affichera l'avertissement");
    EQ(RI.macroState({ dateData: "2026-11-09", bceDir: "cut" }, now).bceDir, null, "direction BCE hors liste blanche → null");
    EQ(RI.macroState(null, now), null, "macro absente → null (bandeau masqué, pas d'erreur)");
    EQ(RI.macroState({ dateData: "pas-une-date" }, now).ageDays, null, "date illisible → âge null");
  });
  T("v4.0.8 qMetricOf : capitaux propres négatifs (P/B ≤ 0) → ROE et D/E non mesurables ; marge/croissance négatives = faits", function () {
    var m = RI.qMetricOf({ pb: -0.5, roe: 0.25, mOp: 0.1, gRev: -0.02, de: 20 });
    A(m.roe === null && m.de === null, "fonds propres négatifs → ROE et D/E null (perte ÷ négatif n'est pas un « bon ROE »)");
    EQ(m.mOp, 0.1, "la marge reste mesurable");
    EQ(m.gRev, -0.02, "la croissance négative participe (fait, pas absence)");
    var m2 = RI.qMetricOf({ pb: 1.2, roe: 0.12, de: -40 });
    EQ(m2.roe, 0.12, "P/B sain : ROE conservé");
    A(m2.de === null, "D/E négatif → null, plus jamais un « meilleur » rang");
  });
  T("v4.0.7 pos52Of : position fourchette 52 s., bornée, écart au plus bas/plus haut", function () {
    var r = RI.pos52Of({ px: 10, w52lo: 9.5, w52hi: 20 });
    EQ(r.pos, 5, "(10-9,5)/(20-9,5) = 4,76 → 5");
    EQ(r.gapLo, 5.3, "+5,3 % au-dessus du plus bas");
    EQ(r.dd, -50, "-50 % du plus haut");
    EQ(RI.pos52Of({ px: 25, w52lo: 9.5, w52hi: 20 }).pos, 100, "cours au-dessus du plus haut → borné à 100");
    // v4.0.12 (audit) : un cours HORS des bornes fournies est SIGNALÉ, pas confondu avec une
    // position à l'extrémité — bornes périmées ou décrochage ne se lisent pas « au plus bas ».
    var under = RI.pos52Of({ px: 9, w52lo: 9.5, w52hi: 20 });
    EQ(under.out, -1, "cours sous la borne basse → out = -1 (SOUS la fourchette)");
    EQ(under.gapLo, -5.3, "écart au plus bas SIGNÉ : -5,3 % (le cours est sous la borne)");
    var over = RI.pos52Of({ px: 25, w52lo: 9.5, w52hi: 20 });
    EQ(over.out, 1, "cours au-dessus de la borne haute → out = +1 (AU-DESSUS de la fourchette)");
    EQ(over.dd, 25, "écart au plus haut SIGNÉ : +25 % (au-dessus)");
    EQ(RI.pos52Of({ px: 10, w52lo: 9.5, w52hi: 20 }).out, 0, "cours dans la fourchette → out = 0");
    A(RI.pos52Of({ px: 10, w52lo: null, w52hi: 20 }).pos === null, "bornes absentes → null");
    A(RI.pos52Of({ px: 10, w52lo: 20, w52hi: 20 }).pos === null, "fourchette vide (lo = hi) → null");
  });
  T("v4.0.8 oppScores : qualité 57 % + valorisation 43 %, point bas HORS score ; 3/4 métriques exigées", function () {
    // attendus recalculés À LA MAIN (piège des percentiles : beaten = valeurs en-dessous pour
    // higherIsBetter, au-dessus pour lowerIsBetter — se tromper 2 fois en v4.0.7, on ne recommence pas)
    var l = [
      { n: "A", mn: "A", y: "A.PA", g: "cac40", per: 10, dY: 3, pb: 1, px: 10, w52lo: 9.5, w52hi: 20, roe: 0.2, mOp: 0.15, gRev: 0.05, de: 30, fper: 9 },
      { n: "B", mn: "B", y: "B.PA", g: "cac40", per: 20, dY: 1, pb: 2, px: 15, w52lo: 10, w52hi: 16, roe: 0.1, mOp: 0.1, gRev: -0.02, de: 60, fper: 25 },
      { n: "C", mn: "C", y: "C.PA", g: "cac40", per: 15, dY: 2.5, pb: 1.5, px: 12, w52lo: 11, w52hi: 14 }, // sans fondamentaux
      { n: "D", mn: "D", y: "D.PA", g: "cac40", px: 5, pb: 1.2, roe: 0.12, de: -40 }, // D/E négatif → null ; 1 seule métrique utile, pas de PER
      { n: "E", mn: "E", y: "E.PA", g: "cac40", per: 11, dY: 1.5, pb: -0.5, px: 13, roe: 0.25, mOp: 0.11, gRev: 0.03, de: 20 }, // fonds propres négatifs → roe/de null → 2/4
      { n: "F", mn: "F", y: "F.PA", g: "cac40", per: 12, dY: 2, pb: 1.4, px: 13, roe: 0.18, mOp: 0.12, gRev: 0.01, de: 45 }
    ];
    var val = RI.oppScores(RI.valScores(l));
    EQ(val[0].qScore, 100, "A : meilleure à tout → qualité 100");
    EQ(val[0].qBase, 4, "base 4/4");
    EQ(val[0].qMode, "index", "sans secteur → vs indice");
    EQ(val[0].score, 100, "A : valorisation 100");
    EQ(val[0].oScore, 100, "A : 0,57×100 + 0,43×100 = 100");
    EQ(val[0].pos52, 5, "A : pos52 5 — étiquette d'info, toujours calculée");
    A(val[0].earnWarn !== true, "A : fper 9 < per 10 → pas d'avertissement");
    EQ(val[1].qScore, 0, "B : pire à tout → qualité 0");
    EQ(val[1].oScore, 0, "B : 0,57×0 + 0,43×0 = 0");
    EQ(val[1].pos52, 83, "B : (15-10)/(16-10) = 83 % de la fourchette (info seule, ne pèse plus 30 %)");
    A(val[1].earnWarn === true, "B : fper 25 > per 20 → bénéfices attendus en baisse");
    A(val[2].oScore === null, "C : pas de fondamentaux → pas de score 💎 (on n'invente rien)");
    A(val[3].qScore === null, "D : roe seul (D/E négatif nullifié) → 1/4 métriques → null");
    A(val[3].pDe === null, "D : percentile dette null (le D/E négatif n'a PAS été classé premier)");
    A(val[4].qScore === null, "E : roe et de nullifiés (fonds propres négatifs) → 2/4 métriques → null (v4.0.8 : 3/4 exigés)");
    A(val[4].pRoe === null, "E : le ROE 0,25 sur fonds propres négatifs n'entre PAS dans le classement");
    // F : roe 67 (battu B 0,1 et D 0,12 sur 3 autres : 2/3) · mOp 67 (battu B 0,1 et E 0,11 : 2/3)
    //     gRev 33 (battu B -0,02 seul : 1/3) · de 50 (battu B 60 seul : 1/2)
    //     qScore = (0,35×67 + 0,25×67 + 0,2×33 + 0,2×50) = 56,8 → 57
    EQ(val[5].qScore, 57, "F : qualité 57");
    //     valorisation F : per 50 (battu B 20 et C 15 sur 4) · dY 50 (battu B 1 et E 1,5 sur 4)
    //     · pb 50 (battu B 2 et C 1,5 sur 4 — D 1,2 est SOUS F, E -0,5 exclu)
    //     score = 0,5×50 + 0,3×50 + 0,2×50 = 50
    EQ(val[5].score, 50, "F : valorisation 50");
    EQ(val[5].oScore, 54, "F : 0,57×57 + 0,43×50 = 53,99 → 54 (plus de renormalisation : une seule formule)");;
    EQ(RI.sbfSort(val, "opp").map(function (e) { return e.n; }).slice(0, 3), ["A", "F", "B"], "vue 💎 : A puis F puis B, nulls en fin");
  });
  T("v4.0.8 oppScores : qualité PAR SECTEUR (≥ 8 pairs), repli vs indice — ROE/marge/dette comparés aux pairs", function () {
    var l2 = [];
    for (var k = 0; k < 8; k++) {
      l2.push({ n: "Bk" + k, mn: "Bk" + k, y: "B" + k + ".PA", g: "cac40", sec: "Finance", per: 10 + k, dY: 1, pb: 1, px: 10 + k,
        roe: 0.05 + 0.01 * k, gRev: 0.01 * k, de: 20 + 10 * k }); // banques : pas de marge op. → 3/4 métriques quand même
    }
    l2.push({ n: "X", mn: "X", y: "X.PA", g: "cac40", per: 10, dY: 3, pb: 1, px: 20, roe: 0.2, gRev: 0.1, de: 15 }); // hors secteur → vs indice
    var val2 = RI.oppScores(RI.valScores(l2));
    EQ(val2[3].qMode, "sector", "secteur Finance ≥ 8 pairs → classement interne");
    EQ(val2[3].qBase, 3, "banque sans marge op. : 3/4 métriques → score autorisé");
    // Bk3 : roe 0,08 → battu 3/7 = 43 · gRev 0,03 → 43 · de 50 → battu 4/7 = 57
    // qScore = (0,35×43 + 0,2×43 + 0,2×57)/0,75 = 46,73 → 47
    EQ(val2[3].qScore, 47, "Bk3 : qualité sectorielle 47");
    // Bk0 : roe 0 · gRev 0 · de 100 → (0 + 0 + 0,2×100)/0,75 = 26,67 → 27
    EQ(val2[0].qScore, 27, "Bk0 : qualité sectorielle 27");
    EQ(val2[8].qMode, "index", "sans secteur → vs indice");
    // X : roe/gRev/de battent les 8 autres → 100/100/100 → (0,35+0,2+0,2)×100/0,75 = 100
    EQ(val2[8].qScore, 100, "X : qualité 100 vs indice");
    // oScore de Bk3 (v4.0.10 : ex æquo → rang moyen PARTOUT) : per 57 (battu 4/7) · dY 50
    // (les 8 banques sont TOUTES ex æquo à 1 → rang moyen 50, plus de punition de l'égalité)
    // · pb 50 (idem, toutes à 1) → score = 0,5×57 + 0,3×50 + 0,2×50 = 53,5 → 54
    // oScore = 0,57×47 + 0,43×54 = 50,01 → 50
    EQ(val2[3].oScore, 50, "Bk3 : composite 💎 50");
    // X (v4.0.10 : rang moyen) : per à égalité avec Bk0 (10) → battu 7, ex æquo 1 → (7+0,5)/8 = 94
    // · dY 100 (battu 8/8) · pb 50 (les 9 lignes ex æquo à 1 → rang moyen, plus de 0)
    //     → score = 0,5×94 + 0,3×100 + 0,2×50 = 87
    // oScore = 0,57×100 + 0,43×87 = 94,41 → 94
    EQ(val2[8].oScore, 94, "X : composite 💎 94");
  });
  T("v4.0.12 valScores : percentile sectoriel PAR MÉTRIQUE — < 5 observations valides dans le secteur → la métrique retombe vs indice (mode mixte)", function () {
    // 8 banques : 4 PER seulement (Bk4-Bk7 sans per) → per refusé en sectoriel (4 < 5), dY/pb sectorisés
    var l = [];
    for (var b = 0; b < 8; b++) l.push({ n: "Bk" + b, per: (b < 4 ? 10 + 10 * b : null), dY: 2, pb: 1, sec: "Banques" });
    l.push({ n: "X", per: 5, dY: 1, pb: 2 });  // hors secteur → tout vs indice
    l.push({ n: "Y", per: 50, dY: 1, pb: 2 }); // hors secteur → tout vs indice
    var s = RI.valScores(l);
    // per vs indice (pool : 10,20,30,40,5,50) : Bk0 (10) battu 4/5 → 80 — PAS 100 (le pool sectoriel des
    // seuls PER existants le donnerait premier) ; dY/pb sectorisés (8 ex æquo → rang moyen 50)
    EQ(s[0].pPer, 80, "Bk0 : per à 4 observations dans le secteur → REFUSÉ, percentile vs indice : 80");
    EQ(s[0].pDY, 50, "dY : 8 observations dans le secteur → sectorisé, ex æquo → 50");
    EQ(s[0].pPb, 50, "pb : idem → 50");
    EQ(s[0].vMode, "mix", "v4.0.12 : per vs indice + dY/pb vs secteur → vMode MIXTE, pas un bloc sectoriel figé");
    EQ(s[0].score, 65, "score = 0,5×80 + 0,3×50 + 0,2×50 = 65");
    EQ(s[8].vMode, "index", "X sans secteur → vs indice");
    // X : pPer 100 (per 5 le moins cher du pool indice) · pDY 6 (ex æquo avec Y à 1, rang moyen (0+0,5)/9)
    // · pPb 6 (idem à 2) → 0,5×100 + 0,3×6 + 0,2×6 = 53
    EQ(s[8].score, 53, "X : score vs indice 53 (attendus recalculés à la main, ex æquo inclus)");
    // frontière exacte : 5 observations valides dans le secteur → sectorisé (5 = seuil, pas 6)
    var l2 = [];
    for (var c = 0; c < 8; c++) l2.push({ n: "C" + c, per: (c < 5 ? 10 + 10 * c : null), sec: "Banques" });
    l2.push({ n: "Z", per: 5 });
    var s2 = RI.valScores(l2);
    EQ(s2[0].pPer, 100, "5 PER dans le secteur (= seuil) → sectorisé : C0 (10) premier DU SECTEUR → 100 (Z per 5 hors du pool)");
  });
  T("v4.0.12 oppScores : qualité PAR MÉTRIQUE aussi — roe à 4 observations dans un secteur de 8 → vs indice, gRev/de sectorisés (qMode mixte)", function () {
    var l = [];
    for (var k = 0; k < 8; k++) {
      l.push({ n: "Bk" + k, roe: (k < 4 ? 0.05 + 0.01 * k : null), gRev: 0.01 * k, de: 20 + 10 * k, sec: "Finance" });
    }
    l.push({ n: "X", roe: 0.2, gRev: 0.1, de: 15 }); // hors secteur → vs indice
    var val = RI.oppScores(l);
    EQ(val[0].pRoe, 0, "Bk0 : roe à 4 observations dans le secteur → REFUSÉ, vs indice (dernier du pool 0,05-0,2)");
    EQ(val[0].qMode, "mix", "roe vs indice + gRev/de vs secteur → qMode MIXTE");
    // Bk0 : pRev 0 (gRev 0 le plus bas du secteur) · pDe 100 (dette 20 la plus basse) →
    // (0,35×0 + 0,2×0 + 0,2×100)/0,75 = 26,67 → 27
    EQ(val[0].qScore, 27, "Bk0 : qScore renormalisé sur les 3 métriques disponibles (mOp absent)");
    EQ(val[0].qBase, 3, "3 métriques qualité utilisées (roe, gRev, de — pas de marge op.)");
    EQ(val[8].qMode, "index", "X sans secteur → vs indice");
    EQ(val[8].qScore, 100, "X : roe/gRev/de tous premiers du pool indice → 100");
  });
  T("v4.0.7 quoteRow : bornes 52 s. Yahoo rapportées (fiftyTwoWeekLow/High)", function () {
    var r = FQ.quoteRow({ symbol: "MC.PA", shortname: "LVMH", regularMarketPrice: 402.45, regularMarketChangePercent: -0.5,
      trailingPE: 14.9, dividendYield: 6.6, priceToBook: 1.16, marketCap: 2.02e11,
      fiftyTwoWeekLow: 375.65, fiftyTwoWeekHigh: 654.7 });
    EQ(r.w52lo, 375.65, "plus bas 52 s.");
    EQ(r.w52hi, 654.7, "plus haut 52 s.");
    A(FQ.quoteRow({ symbol: "X.PA", regularMarketPrice: 5 }).w52lo === null, "absentes → null");
  });
  TA("v4.0.7 fetchQuotesTv : bornes 52 s. du scanner (d[9]/d[10]) reportées", function () {
    var sb = { updated: "2026-01-01T00:00:00Z", list: sbf100() };
    FQ.setFetchForTests(function (url, opts) {
      var body = JSON.parse(opts.body);
      var out = body.symbols.tickers.map(function (t) {
        return t === "EURONEXT:PX1"
          ? { s: t, d: ["PX1", 8229.14, 1.07] }
          : { s: t, d: [t.split(":")[1], 42.5, 1.1, 12.4, null, 2.35, 1.8, 2.5e9, "Finance", 38.2, 61.9] };
      });
      return Promise.resolve(res(200, { totalCount: out.length, data: out }));
    });
    return FQ.fetchQuotesTv(sb, {}).then(function (q) {
      EQ(q.list[0].w52lo, 38.2, "plus bas 52 s. TradingView");
      EQ(q.list[0].w52hi, 61.9, "plus haut 52 s. TradingView");
      EQ(q.list[0].sec, "Finance", "secteur toujours là");
      A(q.list[0].roe === null && q.list[0].mOp === null && q.list[0].de === null, "ancien schéma 11 colonnes → fondamentaux null (tvNum/tvPct/tvDe tolèrent l'absence)");
    });
  });
  TA("v4.0.9 fetchQuotesTv : fondamentaux qualité du scanner (d[11]/d[12]/d[13]) — % et ratio TV convertis au format canonique Yahoo", function () {
    var sb = { updated: "2026-01-01T00:00:00Z", list: sbf100() };
    FQ.setFetchForTests(function (url, opts) {
      var body = JSON.parse(opts.body);
      var out = body.symbols.tickers.map(function (t) {
        return t === "EURONEXT:PX1"
          ? { s: t, d: ["PX1", 8229.14, 1.07] }
          : { s: t, d: [t.split(":")[1], 42.5, 1.1, 12.4, null, 2.35, 1.8, 2.5e9, "Finance", 38.2, 61.9, 16.3085688582353, 21.7965620722994, 0.537734048021147] };
      });
      return Promise.resolve(res(200, { totalCount: out.length, data: out }));
    });
    return FQ.fetchQuotesTv(sb, {}).then(function (q) {
      EQ(q.list[0].roe, 16.3085688582353 / 100, "ROE TV 16,3 % → décimal Yahoo 0,163 (même échelle que finDataRow)");
      EQ(q.list[0].mOp, 21.7965620722994 / 100, "marge op. TV 21,8 % → décimal 0,218");
      EQ(q.list[0].de, 0.537734048021147 * 100, "dette/CP TV ratio 0,538 → % Yahoo 53,8");
    });
  });
  T("v4.0.9 oppScores : repli TV sans croissance → score sur 3/4 métriques (attendus recalculés à la main)", function () {
    var list = [ // gRev absent PARTOUT = le cas réel du repli TradingView (revenue_* null sur EURONEXT)
      { n: "A", sec: "S", roe: 0.20, mOp: 0.15, de: 30, score: 80 },
      { n: "B", sec: "S", roe: 0.10, mOp: 0.10, de: 60, score: 40 },
      { n: "C", sec: "S", roe: 0.15, mOp: 0.12, de: 45, score: 60 }
    ];
    var o = RI.oppScores(list);
    // percentiles index (3 < MIN_SEC=8) : A bat tout (100), B dernier (0), C médian (50) — sur les 3 métriques
    EQ(o[0].qBase, 3, "A : 3 métriques qualité sans croissance");
    EQ(o[0].qScore, 100, "A : (35+25+20)×100/80 = 100");
    EQ(o[0].oScore, 91, "A : round(0,57×100 + 0,43×80) = 91");
    EQ(o[1].qScore, 0, "B : 0 sur les 3 métriques");
    EQ(o[2].qScore, 50, "C : 4000/80 = 50");
    EQ(o[2].oScore, 54, "C : round(0,57×50 + 0,43×60) = 54");
    A(o[0].pRev === null, "croissance absente → percentile croissance null (pas un zéro qui punirait)");
    EQ(o[1].qBase, 3, "B : qBase 3 → qScore non null malgré l'absence de croissance");
  });
  T("v4.0.10 rankPct : ex æquo → RANG MOYEN aussi dans la valorisation ; valeur unique → pas de faux 50", function () {
    var l = [
      { n: "A", per: 10, dY: 0 }, // 2 non-payeurs de dividende ex æquo — plus de « tous à 0 »
      { n: "B", per: 10, dY: 0 },
      { n: "C", per: 20, dY: 3 },
      { n: "D", per: 30, dY: 5 }
    ];
    var pPer = RI.rankPct(l, "per", true);
    // per (plus bas mieux) : A ex æquo avec B, bat C et D → (2 + 1/2)/3 = 83 ; D dernier → 0
    EQ(pPer[0], 83, "A : rang moyen de l'ex æquo per (plus de rang strict qui cassait l'égalité)");
    EQ(pPer[1], 83, "B : MÊME rang que A — l'égalité n'est plus une punition");
    EQ(pPer[3], 0, "D : dernier, 0");
    var pDY = RI.rankPct(l, "dY", false);
    // dY (plus haut mieux) : A et B à 0 ex æquo → (0 + 1/2)/3 = 17 ; D seule à 5 → 100
    EQ(pDY[0], 17, "A non-payeur : rang moyen 17, pas 0");
    EQ(pDY[1], 17, "B non-payeur : idem A");
    EQ(pDY[3], 100, "D meilleur rendement : 100");
    var solo = RI.rankPct([{ per: 5 }, { per: -3 }], "per", true); // -3 exclu (non positif) → 1 seule valeur
    A(solo[0] === undefined, "valeur unique → ABSENT (pas de 50 qui ressemblerait à un rang neutre sans l'être)");
  });
  T("v4.0.12 🏆 Long terme : ltScore = qualité 55 + valorisation relative 35 + initiés 10 (50 NEUTRE sans signal — v4.0.12 : l'absence d'initiés n'est plus une pénalité)", function () {
    var bonus = { byName: {}, byIsin: { "FR0000120073": { b: 15, level: 3, buys: 9, societe: "TOTAL" } } };
    var l = [
      { n: "A", y: "A.PA", mn: "A", isin: "", qScore: 80, score: 60, oScore: 70 },
      { n: "B", y: "B.PA", mn: "B", isin: "FR0000120073", qScore: 80, score: 60, oScore: 70 },
      { n: "L", y: "L.PA", mn: "L", isin: "", qScore: null, score: null, oScore: null }
    ];
    var e = RI.sbfEnrich(l, bonus);
    EQ(e[0].insSc, 50, "A sans initiés : composante NEUTRE à 50 (plus 0/100 = pénalité implicite de 5 points)");
    EQ(e[1].insSc, 100, "B avec cluster +15 : composante à 100");
    EQ(e[0].ltScore, 70, "A sans initiés : 0,55×80 + 0,35×60 + 0,10×50 = 70");
    EQ(e[1].ltScore, 75, "B avec initiés 🔥🔥 +15 : 44 + 21 + 0,10×100 = 75");
    A(e[2].ltScore === null, "oScore null (qualité ou valorisation non mesurable) → ltScore null, on n'invente rien");
    EQ(RI.sbfSort(e, "lt").map(function (r) { return r.n; }), ["B", "A", "L"], "vue 🏆 : B (conviction initiés) devant A, null en fin");
    // v4.0.12 : bonus intermédiaires — +10 → 83, +4 → 63 (50 + bonus/15×50)
    var e2 = RI.sbfEnrich([{ n: "C", y: "C.PA", mn: "C", isin: "", qScore: 80, score: 60, oScore: 70, ins: 0 }], { byName: {}, byIsin: {} });
    EQ(e2[0].insSc, 50, "bonus vide : insSc 50, le plancher de la composante");
  });
  T("v4.0.8 journal-scores : entrée du jour (top triés + cours des 120 = pas de biais du survivant), anti-doublon par date", function () {
    var J = require("./journal-scores.js");
    var q = {
      updated: "2026-11-09T17:42:36Z", source: "TradingView (repli — Yahoo indisponible), Euronext en différé ~15 min",
      idx: { px: 8229.14, name: "CAC 40 (repli — SBF 120 absent de TradingView)" },
      list: [
        { n: "A", mn: "A", y: "A.PA", g: "cac40", per: 10, dY: 3, pb: 1, px: 10, roe: 0.2, mOp: 0.15, gRev: 0.05, de: 30 },
        { n: "B", mn: "B", y: "B.PA", g: "cac40", per: 20, dY: 1, pb: 2, px: 15, roe: 0.1, mOp: 0.1, gRev: -0.02, de: 60 },
        { n: "C", mn: "C", y: "C.PA", g: "cac40", px: 12 } // ni score ni qualité — mais le cours est journalisé
      ]
    };
    var e = J.buildJournalEntry(q);
    EQ(e.date, "2026-11-09", "date = jour du relevé (UTC)");
    EQ(e.idx, 8229.14, "indice journalisé (benchmark intégré à chaque ligne)");
    EQ(e.idxName, "CAC 40 (repli — SBF 120 absent de TradingView)", "v4.0.12 : l'IDENTITÉ du benchmark est conservée — SBF 120 vs repli CAC 40 ne se comparent pas");
    EQ(e.cov, 3, "v4.0.12 : couverture du jour journalisée (titres dans le relevé)");
    EQ(e.lt.length, 2, "top 🏆 = valeurs avec ltScore non null");
    EQ(e.lt[0].y, "A.PA", "meilleur 🏆 en tête");
    EQ(e.lt[0].ltScore, 95, "🏆 = 0,55×100 (qualité) + 0,35×100 (valorisation) + 0,10×50 (initiés NEUTRES sans signal, v4.0.12)");
    EQ(e.lt[0].ins, 0, "composante initiés journalisée (0 ici)");
    EQ(e.val.length, 2, "top 📐 = valeurs avec score non null");
    EQ(e.px["C.PA"], 12, "TOUTES les valeurs journalisées (même sans score) — rendements futurs sans biais du survivant");
    A(J.shouldAppend("", "2026-11-09"), "journal vide → on écrit");
    A(J.shouldAppend('{"date":"2026-11-08"}\n', "2026-11-09"), "dernière ligne d'un autre jour → on écrit");
    A(!J.shouldAppend('{"date":"2026-11-09"}\n', "2026-11-09"), "ligne du jour déjà là → pas de doublon");
    A(!J.shouldAppend('{"date":"2026-11-08"}\n{"date":"2026-11-09"}\n', "2026-11-09"), "doublon caché au milieu → détecté");
    // v4.0.12 : le relevé LE PLUS RÉCENT du jour REMPLACE la ligne du jour (l'audit : le
    // snapshot de 14 h ne doit pas survivre à celui de 16 h) — toujours 1 ligne par date.
    var prev = '{"date":"2026-11-09","updated":"2026-11-09T14:00:00Z","idx":8100,"px":{"A.PA":9}}\n{"date":"2026-11-08","idx":8050}\n';
    var up = J.upsertEntry(prev, e);
    A(up.replaced, "ligne du jour déjà présente → REMPLACÉE, pas de doublon");
    var lines = up.text.trim().split("\n");
    EQ(lines.length, 2, "toujours une ligne par date");
    A(lines[0].indexOf('"updated":"2026-11-09T17:42:36Z"') > -1, "la ligne du jour porte le relevé le plus récent");
    A(lines[0].indexOf('"idx":8229.14') > -1, "l'indice du relevé récent remplace l'ancien");
    A(lines[1].indexOf('"date":"2026-11-08"') > -1, "les autres jours sont intacts");
    var up2 = J.upsertEntry('{"date":"2026-11-08","idx":8050}\n', e);
    A(!up2.replaced, "aucune ligne du jour → ajout en fin de fichier");
    A(up2.text.trim().split("\n").length === 2, "2 lignes après ajout : 2026-11-08 + 2026-11-09");
  });
  T("v4.0.8 ops : transitions d'état → alertes ntfy ; échecs cotes ×2 de suite → alerte dédiée", function () {
    var OPS = require("./ops.js");
    var ok = { frOk: true, usOk: true, quotesOk: true, quotesFailStreak: 0 };
    var r1 = OPS.nextQuotes(ok, false);
    EQ(r1.alerts.length, 1, "ok → panne : alerte flip");
    A(r1.alerts[0].indexOf("ÉCHEC") > -1, "message de panne cotations");
    EQ(r1.ops.quotesFailStreak, 1, "1er échec : compteur à 1, pas d'alerte double échec");
    var r2 = OPS.nextQuotes(r1.ops, false);
    EQ(r2.ops.quotesFailStreak, 2, "2e échec consécutif : compteur à 2");
    EQ(r2.alerts.length, 1, "alerte du 2e échec de suite (le flip a déjà été signalé au 1er)");
    A(r2.alerts[0].indexOf("2 runs de suite") > -1, "message double échec explicite");
    var r3 = OPS.nextQuotes(r2.ops, true);
    EQ(r3.ops.quotesFailStreak, 0, "retour OK : compteur remis à zéro");
    EQ(r3.alerts.length, 1, "alerte de rétablissement");
    A(r3.alerts[0].indexOf("rétablies") > -1, "message rétablissement");
    var ri = OPS.nextInsiders(ok, false, true);
    EQ(ri.alerts.length, 1, "frOk → false : alerte panne FR");
    A(ri.alerts[0].indexOf("FR") > -1, "la panne FR est identifiée");
    var ri2 = OPS.nextInsiders(ri.ops, true, true);
    EQ(ri2.alerts.length, 1, "rétablissement FR → alerte");
    A(ri2.alerts[0].indexOf("rétablie") > -1, "message rétablissement FR");
    var ri3 = OPS.nextInsiders(ri2.ops, true, true);
    EQ(ri3.alerts.length, 0, "aucun changement → aucun spam ntfy");
  });
  TA("v4.0.8 ops : dead man's switch — ping 2xx = true, échec = false, jamais de throw", function () {
    var OPS = require("./ops.js");
    OPS.setFetchForTests(function () { return Promise.resolve({ status: 200 }); });
    return OPS.pingHealth("https://hc.example/xyz").then(function (ok) {
      A(ok === true, "2xx → ping délivré");
      OPS.setFetchForTests(function () { return Promise.reject(new Error("network down")); });
      return OPS.pingHealth("https://hc.example/xyz");
    }).then(function (ok2) {
      A(ok2 === false, "échec réseau → false (le run continue)");
      OPS.setFetchForTests((typeof fetch === "function") ? fetch : null);
    });
  });
  T("v4.0.8 fetch-quotes/fetch-insiders : intégration ops (alertes panne + dead man) branchée dans les mains", function () {
    var fq = fs.readFileSync(__dirname + "/../tools/fetch-quotes.js", "utf8");
    A(fq.indexOf("opsSuccess") > -1, "fetch-quotes : succès → ops + ping");
    A(fq.indexOf("nextQuotes(prevOps, false)") > -1, "fetch-quotes : échec → compteur + alertes");
    A(fq.indexOf("schéma suspect") > -1, "fetch-quotes : contrôle de schéma TV (bornes 52 s. massivement absentes → warning)");
    var fi = fs.readFileSync(__dirname + "/../tools/fetch-insiders.js", "utf8");
    A(fi.indexOf("nextInsiders") > -1, "fetch-insiders : transitions frOk/usOk → alertes");
    A(fi.indexOf("HTTP \" + r.status") > -1, "notifyNtfy : un statut non-2xx n'est plus compté comme envoyé");
    var wq = fs.readFileSync(__dirname + "/../.github/workflows/quotes.yml", "utf8");
    A(wq.indexOf("journal-scores.js") > -1, "workflow cotes : journal quotidien branché");
    A(wq.indexOf("ops.json") > -1, "workflow cotes : ops.json committé (même en échec)");
    A(wq.indexOf("HEALTHCHECKS_URL") > -1, "workflow cotes : dead man's switch câblé");
    var wi = fs.readFileSync(__dirname + "/../.github/workflows/insiders.yml", "utf8");
    A(wi.indexOf("ops.json") > -1 && wi.indexOf("HEALTHCHECKS_URL") > -1, "workflow initiés : ops + dead man câblés");
  });
  TA("v4.0.6 fetchTargets : URL v10 financialData + objectifs/éléments parsés ; 429 → arrêt immédiat, partiel conservé", function () {
    var calls = 0;
    FQ.setFetchForTests(function (url) {
      var u = String(url);
      A(u.indexOf("v10/finance/quoteSummary/") > -1 && u.indexOf("modules=financialData") > -1 && u.indexOf("crumb=") > -1, "URL v10 + module + crumb : " + u);
      calls++;
      if (calls === 1) return Promise.resolve(res(200, JSON.stringify({ quoteSummary: { result: [{ financialData: {
        targetMeanPrice: { raw: 491.36 }, targetLowPrice: { raw: 415 }, targetHighPrice: { raw: 590 },
        numberOfAnalystOpinions: { raw: 27 }, recommendationKey: "buy",
        revenueGrowth: { raw: -0.029 }, earningsGrowth: { raw: 0.008 },
        operatingMargins: { raw: 0.2252 }, returnOnEquity: { raw: 0.16586 }, debtToEquity: { raw: 53.306 }
      } }] } })));
      return Promise.resolve(res(429, "Too Many Requests")); // 2e valeur : la rafale commence
    });
    return FQ.fetchTargets(["MC.PA", "AIR.PA", "CAP.PA"], { cookie: "A1=d=x", crumb: "crumb4tests" }, { paceMs: 0 }).then(function (t) {
      EQ(t.got, 1, "1 objectif récupéré avant le 429");
      EQ(t.rows["MC.PA"].tp, 491.36, "objectif moyen");
      EQ(t.rows["MC.PA"].tpHi, 590, "borne haute");
      EQ(t.rows["MC.PA"].tpN, 27, "27 analystes");
      EQ(t.rows["MC.PA"].rec, "buy", "recommandation");
      EQ(t.rows["MC.PA"].roe, 0.16586, "ROE exposé (élément financier)");
      A(t.rows["AIR.PA"] === undefined, "le 429 arrête la boucle : AIR.PA non traité");
      EQ(t.errors, 0, "le 429 n'est pas compté comme erreur muette");
    });
  });
  T("v4.0.6 finDataRow : champs absents → null (jamais de faux zéro)", function () {
    var r = FQ.finDataRow({ targetMeanPrice: { raw: 42 } });
    EQ(r.tp, 42, "objectif présent");
    A(r.tpLo === null && r.tpHi === null && r.tpN === null && r.rec === null, "bornes/analystes/reco absents → null");
    A(r.gRev === null && r.mOp === null && r.roe === null && r.de === null, "éléments éco/fin absents → null");
  });
  T("v4.0.6 mergeTargets : fusion par ticker ; tpUpdated posé seulement si ≥ 60 % de couverture", function () {
    var q = { updated: "2026-01-01T00:00:00Z", list: [{ y: "A.PA", px: 100 }, { y: "B.PA", px: 50 }, { y: "C.PA", px: 10 }] };
    FQ.mergeTargets(q, { rows: { "A.PA": { tp: 120, tpLo: 100, tpHi: 140, tpN: 9, rec: "buy", gRev: 0.02, gEps: 0.05, mOp: 0.1, roe: 0.12, de: 40 }, "B.PA": { tp: 60, tpLo: 55, tpHi: 70, tpN: 4, rec: "hold", gRev: 0.01, gEps: 0.02, mOp: 0.05, roe: 0.08, de: 30 } }, got: 2 });
    EQ(q.list[0].tp, 120, "objectif fusionné par ticker");
    EQ(q.list[0].tpN, 9, "nb analystes fusionné");
    EQ(q.tpN, 2, "compteur global");
    A(q.tpUpdated !== null && /^\d{4}-\d{2}-\d{2}T/.test(q.tpUpdated), "2/3 ≈ 67 % ≥ 60 % → tpUpdated posé");
    var q2 = { updated: "2026-01-01T00:00:00Z", list: [{ y: "A.PA", px: 100 }, { y: "B.PA", px: 50 }, { y: "C.PA", px: 10 }] };
    FQ.mergeTargets(q2, { rows: { "A.PA": { tp: 120 } }, got: 1 });
    A(q2.tpUpdated === null, "1/3 < 2 (60 % de 3) → tpUpdated null : le run suivant réessaiera");
    EQ(q2.list[1].tp, undefined, "ligne sans objectif inchangée");
  });
  T("v4.0.6 sbfEnrich/sbfSort : potentiel upX + vue 🎯 par potentiel décroissant, sans objectif en fin", function () {
    var l = [
      { n: "A", y: "A.PA", px: 100, tp: 120, score: 50 },
      { n: "B", y: "B.PA", px: 50, tp: 40, score: 60 },
      { n: "C", y: "C.PA", px: 10, tp: null, score: 70 },
      { n: "D", y: "D.PA", px: 80, tp: 80, score: 40 }
    ];
    var enr = RI.sbfEnrich(l, { byName: {}, byIsin: {} });
    EQ(enr[0].upX, 20, "A : objectif 120 vs cours 100 → +20 %");
    EQ(enr[1].upX, -20, "B : objectif 40 vs cours 50 → −20 %");
    A(enr[2].upX === null, "C sans objectif → upX null");
    EQ(enr[3].upX, 0, "D : objectif = cours → 0 %");
    EQ(RI.sbfSort(enr, "obj").map(function (e) { return e.n; }), ["A", "D", "B", "C"], "vue 🎯 : potentiel décroissant, null en fin");
  });
  T("v4.0.6 workflows : garde 12 h sur les objectifs (120 requêtes v10 à ne refaire que 2×/jour)", function () {
    var q = fs.readFileSync(__dirname + "/../.github/workflows/quotes.yml", "utf8");
    A(q.indexOf("--max-age-targets-min=720") > -1, "quotes.yml : garde objectifs 12 h");
    var p = fs.readFileSync(__dirname + "/../.github/workflows/pages.yml", "utf8");
    A(p.indexOf("--max-age-targets-min=720") > -1, "pages.yml : le secours respecte la même garde");
  });
  TA("v4.0.4 ageMinutesOf : âge en minutes ; absent/invalide → null (garde anti-doublon)", function () {
    EQ(FQ.ageMinutesOf(null), null);
    EQ(FQ.ageMinutesOf("pas une date"), null);
    var age = FQ.ageMinutesOf(new Date(Date.now() - 5 * 60000).toISOString());
    A(age !== null && age >= 4 && age <= 6, "≈ 5 min : " + age);
  });
  function sbf100() {
    var l = [];
    for (var i = 0; i < 100; i++) l.push({ n: "V" + i, y: "V" + (2000 + i) + ".PA", mn: "V" + (2000 + i), g: "mid60", isin: "" });
    return l;
  }
  TA("build-sbf120 : resolveYahoo — le .PA dont le nom matche gagne, sinon repli approximatif", function () {
    SB2.setFetchForTests(function (url) {
      A(String(url).indexOf("v1/finance/search") > -1, "URL search Yahoo : " + url);
      return Promise.resolve(res(200, { quotes: [
        { symbol: "AAPL" },
        { symbol: "AIR.PA", shortname: "Autre chose" },
        { symbol: "EXENS.PA", shortname: "Exosens" }
      ] }));
    });
    return SB2.resolveYahoo("Exosens").then(function (r) {
      EQ(r, { y: "EXENS.PA", approx: false }, "match par nom, symbole .PA valide");
    });
  });
  TA("build-sbf120 : e2e fetch injecté — navbox 40/20/60 + table CAC 40 + infobox {{Euronext}} + contrôles", function () {
    function mkNames(prefix, n) { var a = []; for (var i = 0; i < n; i++) a.push(prefix + (i < 10 ? "0" + i : i)); return a; }
    function mkNavbox(names, titre) {
      var links = names.map(function (n) { return '<a href="/wiki/' + n + '" title="' + n + '">' + n + "</a>"; }).join(" · ");
      return '<table class="navbox"><tr><th>Entreprises du ' + titre + "</th></tr><tr><td>" + links + "</td></tr></table>";
    }
    var g40 = mkNames("Core", 40), g20 = mkNames("Next", 20), g60 = mkNames("Mid", 60);
    var tableRows = ["<tr><th>Société</th><th>Mnémo</th></tr>"];
    g40.forEach(function (n, i) { tableRows.push("<tr><td>" + n + "</td><td>M" + (i < 10 ? "0" + i : i) + "</td></tr>"); });
    var page40 = mkNavbox(g40, "CAC 40") + '<table class="wikitable">' + tableRows.join("") + "</table>";
    SB2.setFetchForTests(function (url) {
      var u = String(url);
      if (u.indexOf("CAC_40") > -1) return Promise.resolve(res(200, page40));
      if (u.indexOf("CAC_Next_20") > -1) return Promise.resolve(res(200, mkNavbox(g20, "CAC Next 20")));
      if (u.indexOf("CAC_Mid_60") > -1) return Promise.resolve(res(200, mkNavbox(g60, "CAC Mid 60")));
      if (u.indexOf("api.php") > -1) {
        var titles = decodeURIComponent(u.split("titles=")[1]).split("|");
        var pages = {};
        titles.forEach(function (t, i) {
          var mn = "E" + t.slice(-3).toUpperCase(); // mnémo unique dérivé du titre (ET00, ED00…)
          pages[i + 1] = { title: t, revisions: [{ "*": "{{Euronext |" + mn + "|FR00000000" + t.slice(-2) + "|Paris}}" }] };
        });
        return Promise.resolve(res(200, { query: { pages: pages } }));
      }
      return Promise.resolve(res(404, ""));
    });
    // la garde anti-diff lit sbf120.json s'il existe → l'écarter le temps du test (restauré dans finally)
    var p = __dirname + "/../sbf120.json";
    var bak = null;
    if (fs.existsSync(p)) { bak = fs.readFileSync(p, "utf8"); fs.unlinkSync(p); }
    var restore = function () { if (bak !== null) fs.writeFileSync(p, bak); };
    return SB2.buildSbf120().then(function (out) {
      EQ(out.list.length, 120, "120 valeurs");
      EQ(out.counts, { cac40: 40, next20: 20, mid60: 60 }, "comptes par groupe");
      EQ(out.list[0].y, "M00.PA", "mnémo CAC 40 pris depuis la table Wikipédia");
      EQ(out.list[40].y, "ET00.PA", "mnémo Next 20 pris depuis l'infobox {{Euronext}}");
      EQ(out.list[40].n, "Next00", "nom conservé");
      A(out.list.every(function (e) { return /^[A-Z0-9]{1,6}\.PA$/.test(e.y); }), "symboles .PA valides");
      var y = out.list.map(function (e) { return e.y; });
      EQ(y.filter(function (v, i, a) { return a.indexOf(v) !== i; }).length, 0, "aucun symbole en double");
      A(/^2026-\d{2}-\d{2}T/.test(out.updated), "horodatage ISO");
    }, function (e) {
      throw new Error("buildSbf120 e2e a échoué : " + e.message);
    }).then(function () { restore(); }, function (e) { restore(); throw e; });
  });
})();

// ---------- simulation DOM (chargement complet de la page) ----------
Promise.all(asyncTests).then(function () {
  require("./sim-dom.js")(function (simPassed, simFailed, notes) {
    passed += simPassed; failed += simFailed;
    (notes || []).forEach(function (n) { console.log("  sim: " + n); });
    console.log("\nSentinelle perso — harnais : " + passed + "/" + (passed + failed) + " verts");
    if (failed > 0) { console.log("ÉCHECS : " + failed); process.exit(1); }
    process.exit(0);
  });
}).catch(function (e) { console.error("ERREUR HARNAIS", e); process.exit(1); });
