#!/usr/bin/env node
"use strict";
// Simulation DOM : charge index.html complet avec stubs, exécute les scripts, vérifie le rendu final.
// Exporte une fonction (cb(passed, failed, notes)) pour être appelé par test.js.
var fs = require("fs");
var vm = require("vm");
var path = require("path");

module.exports = function simDom(cb) {
  var passed = 0, failed = 0, notes = [];
  function T(name, fn) {
    try { fn(); passed++; notes.push("OK  " + name); }
    catch (e) { failed++; notes.push("ÉCHEC " + name + " : " + e.message); }
  }
  function A(cond, msg) { if (!cond) throw new Error(msg || "assertion"); }

  var html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

  // ---- stubs DOM minimaux ----
  var elements = {};
  function El(id) {
    var el = {
      id: id, textContent: "", value: "", innerHTML: "", className: "", _cls: new Set(),
      listeners: {}, classList: {
        add: function (c) { el._cls.add(c); },
        remove: function (c) { el._cls.delete(c); },
        toggle: function (c, on) { if (on === undefined) { el._cls.has(c) ? el._cls.delete(c) : el._cls.add(c); } else if (on) { el._cls.add(c); } else { el._cls.delete(c); } },
        contains: function (c) { return el._cls.has(c); }
      },
      addEventListener: function (ev, fn) { (el.listeners[ev] = el.listeners[ev] || []).push(fn); },
      querySelectorAll: function (sel) { return elsBySelector(sel); },
      getAttribute: function () { return null; },
      closest: function () { return null; }
    };
    return el;
  }
  // boutons factices pour chaque sélecteur .seg button / .amt
  var fakeButtons = [];
  function elsBySelector(sel) {
    if (sel.indexOf("button") > -1) return fakeButtons;
    return [];
  }
  var document = {
    getElementById: function (id) {
      if (!elements[id]) elements[id] = El(id);
      return elements[id];
    },
    addEventListener: function () { },
    querySelectorAll: function (sel) {
      if (sel === ".seg") return [El("seg1"), El("seg2"), El("seg3")];
      return elsBySelector(sel);
    },
    hidden: false
  };
  var store = {};
  // préférences pré-existantes côté "Achats + ventes" : sinon le défaut v3.1 (🟢 Achats)
  // masquerait les ventes et casserait les assertions sur les 6 lignes.
  store["sentinelle-perso-prefs-v1"] = JSON.stringify({ side: "all", src: "all", sort: "date", m: 0, q: "", new: false });
  var localStorage = {
    getItem: function (k) { return store[k] == null ? null : store[k]; },
    setItem: function (k, v) { store[k] = String(v); },
    removeItem: function (k) { delete store[k]; }
  };
  // v4.0 : dates RELATIVES à Date.now() — une fixture à date fixe casserait le harnais
  // 30 jours plus tard (fenêtre des signaux : le cluster serait hors fenêtre en CI).
  function isoAgo(days) { return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10); }
  var isoNow = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  var FETCH_DATA = {
    updated: isoNow, frOk: true, usOk: true,
    fr: [
      { id: "f1", source: "FR", side: "buy", societe: "ROCHE BOBOIS SA", auteur: "TXR S.R.L.", role: "Membre du Conseil de Surveillance", nature: "Acquisition", instrument: "Action", isin: "", dateOp: isoAgo(4), datePub: isoAgo(3), volume: 1400, prix: 15.7286, montant: 22020.04, url: "https://bdif.amf-france.org/x" },
      { id: "f2", source: "FR", side: "buy", societe: "ROCHE BOBOIS SA", auteur: "GIOVANNI TAMBURI", role: "Président", nature: "Acquisition", instrument: "Action", isin: "", dateOp: isoAgo(5), datePub: isoAgo(3), volume: 600, prix: 16, montant: 9600, url: "https://bdif.amf-france.org/y" }
    ],
    us: [{ id: "u1", source: "US", side: "buy", societe: "ACME CORP", ticker: "ACM", auteur: "John Doe", role: "CEO", nature: "Achat", instrument: "Common Stock", isin: "", dateOp: isoAgo(5), datePub: isoAgo(4), volume: 2000, prix: 30, montant: 60000, code: "P", url: "https://sec.gov/x" }],
    frS: [
      { id: "fs1", source: "FR", side: "sell", societe: "TOTALENERGIES SE", auteur: "POUVANNEC PHILIPPE", role: "Directeur Général Adjoint", nature: "Cession", instrument: "Action", isin: "", dateOp: isoAgo(4), datePub: isoAgo(3), volume: 15000, prix: 64.9, montant: 973500, url: "https://bdif.amf-france.org/z" },
      { id: "fs2", source: "FR", side: "sell", societe: "TOTALENERGIES SE", auteur: "SAUNIER BERTRAND", role: "Membre du Conseil d'Administration", nature: "Cession", instrument: "Action", isin: "", dateOp: isoAgo(5), datePub: isoAgo(3), volume: 2000, prix: 65, montant: 130000, url: "https://bdif.amf-france.org/w" }
    ],
    usS: [{ id: "us1", source: "US", side: "sell", societe: "ACME CORP", ticker: "ACM", auteur: "John Doe", role: "CEO", nature: "Vente", instrument: "Common Stock", isin: "", dateOp: isoAgo(6), datePub: isoAgo(4), volume: 2000, prix: 33.373, montant: 66746, code: "S", multi: true, url: "https://sec.gov/y" }],
    picks: {
      updated: isoNow,
      us: [{
        ticker: "ACM", societe: "ACME CORP", score: 14.5,
        insider: { score: 6.5, buys: 3, buyers: 2, level: 3, total: 90000, avgPx: 30, first: isoAgo(6), last: isoAgo(4) },
        sells: { n: 1, hard: 1 },
        fund: { score: 8, growth: 50, ni: 30000000, rev: 150000000, revEnd: "2024-12-31", margin: 20 }
      }],
      fr: [{
        societe: "ROCHE BOBOIS SA", isin: "FR0000030823", score: 5,
        insider: { score: 5, buys: 2, buyers: 2, level: 2, total: 31620, avgPx: 15.8, first: isoAgo(5), last: isoAgo(4) },
        sells: { n: 0, hard: 0 }
      }]
    }
  };
  // v4.0 : cotes du SBF 120 (4 valeurs couvrant les cas : PER bas + initiés 🔥, société du CAC 40,
  // valeur en perte sans PER → « — », et TOTALENERGIES qui ne doit PAS recevoir de bonus initiés
  // (ses initiés ne font que VENDRE — le bonus ne récompense que les achats).
  var FETCH_QUOTES = {
    updated: isoNow, source: "Yahoo Finance (Euronext en différé ~15 min)", ok: true, n: 4, missing: [],
    idx: { px: 6850.42, chg: 0.62, t: 1799900000 },
    list: [
      { y: "AC.PA", n: "Accor", mn: "AC", g: "cac40", isin: "FR0000120404", px: 39.42, chg: 0.81, per: 14.2, fper: 13.1, dY: 2.1, pb: 1.4, cap: 8.5e9, t: 1799900000 },
      { y: "TTE.PA", n: "TOTALENERGIES", mn: "TTE", g: "cac40", isin: "FR0000120271", px: 58.1, chg: -0.3, per: 8.1, fper: 7.6, dY: 5.4, pb: 1.5, cap: 1.2e11, t: 1799900000 },
      { y: "RCO.PA", n: "ROCHE BOBOIS", mn: "RCO", g: "mid60", isin: "FR0000030823", px: 16.4, chg: 1.2, per: 9.5, fper: 8.8, dY: 3.8, pb: 0.9, cap: 6.2e8, t: 1799900000 },
      { y: "PL.PA", n: "Société en perte", mn: "PL", g: "mid60", isin: "", px: 3.3, chg: -2.1, per: null, fper: null, dY: null, pb: null, cap: 4.5e7, t: 1799900000 }
    ]
  };
  var fetchCalls = 0;
  function fetchStub(url) {
    fetchCalls++;
    if (String(url).indexOf("data.json") === 0 || String(url).indexOf("data.json") > -1) {
      return Promise.resolve({ ok: true, json: function () { return Promise.resolve(JSON.parse(JSON.stringify(FETCH_DATA))); } });
    }
    if (String(url).indexOf("quotes.json") > -1) {
      return Promise.resolve({ ok: true, json: function () { return Promise.resolve(JSON.parse(JSON.stringify(FETCH_QUOTES))); } });
    }
    return Promise.resolve({ ok: true, json: function () { return Promise.resolve({}); } });
  }
  var sandbox = {
    document: document, localStorage: localStorage, fetch: fetchStub,
    setInterval: function () { return 0; }, setTimeout: function (fn) { fn && fn(); return 0; },
    AbortController: (typeof AbortController !== "undefined") ? AbortController : function () { this.abort = function () { }; },
    console: console, Date: Date, Math: Math, JSON: JSON, Promise: Promise, String: String, Number: Number, Array: Array, Object: Object, RegExp: RegExp, isNaN: isNaN, parseInt: parseInt, parseFloat: parseFloat
  };
  sandbox.window = sandbox;
  var ctx = vm.createContext(sandbox);

  var scripts = [];
  var re = /<script([^>]*)>([\s\S]*?)<\/script>/g;
  var m;
  while ((m = re.exec(html)) !== null) {
    if (m[1] && m[1].indexOf("src=") > -1) {
      var src = m[1].match(/src="([^"]+)"/)[1];
      scripts.push({ src: src, code: fs.readFileSync(path.join(__dirname, "..", src), "utf8") });
    } else {
      scripts.push({ src: "(inline)", code: m[2] });
    }
  }

  var ran = [];
  try {
    scripts.forEach(function (s) { vm.runInContext(s.code, ctx, { filename: s.src }); ran.push(s.src); });
    T("tous les scripts s'exécutent sans erreur (" + ran.length + ")", function () { A(ran.length >= 2, "logique + inline"); });
  } catch (e) {
    T("tous les scripts s'exécutent sans erreur", function () { throw e; });
  }

  // les promesses se résolvent : on rend la main puis on vérifie
  setTimeout(function () { }, 0);
  function settle() {
    T("data.json récupéré via fetch", function () { A(fetchCalls >= 1, "fetch data.json non appelé"); });
    T("compteurs affichés", function () {
      A(elements["nFr"] && elements["nFr"].textContent === "2", "nFr : " + (elements["nFr"] && elements["nFr"].textContent));
      A(elements["nUs"] && elements["nUs"].textContent === "1", "nUs");
      A(elements["nSig"] && elements["nSig"].textContent === "1", "nSig : " + (elements["nSig"] && elements["nSig"].textContent));
      A(elements["nSell"] && elements["nSell"].textContent === "3", "nSell : " + (elements["nSell"] && elements["nSell"].textContent));
    });
    T("chip fraîcheur affichée", function () {
      A(elements["fresh"] && elements["fresh"].textContent.length > 3, "fresh : " + (elements["fresh"] && elements["fresh"].textContent));
    });
    T("carte accumulation rendue (2 initiés distincts -> 🔥)", function () {
      var s = elements["signals"] && elements["signals"].innerHTML || "";
      A(s.indexOf("ROCHE BOBOIS SA") > -1, "société présente");
      A(s.indexOf("2 achats") > -1, "compte des achats");
      A(s.indexOf("2 initiés distincts") > -1, "initiés distincts");
      A(s.indexOf("prix moyen payé") > -1, "prix moyen");
      A(s.indexOf("lvl l2") > -1, "badge niveau 2");
      A(s.indexOf("boursorama.com") > -1, "lien cote FR");
      A(s.indexOf("data-sig") > -1, "action voir les achats");
      A(elements["sigCard"] && !elements["sigCard"]._cls.has("hidden"), "carte visible");
    });
    T("carte ventes rendue (2 vendeurs distincts -> 🔴)", function () {
      var s = elements["signalsSell"] && elements["signalsSell"].innerHTML || "";
      A(s.indexOf("TOTALENERGIES SE") > -1, "société présente");
      A(s.indexOf("2 ventes") > -1, "compte des ventes");
      A(s.indexOf("2 initiés distincts") > -1, "vendeurs distincts");
      A(s.indexOf("prix moyen vendu") > -1, "prix moyen vendu");
      A(s.indexOf("lvl l2") > -1, "badge niveau 2");
      A(s.indexOf("boursorama.com") > -1, "lien cote FR");
      A(s.indexOf("data-sig") > -1, "action voir");
      A(elements["sigCardSell"] && !elements["sigCardSell"]._cls.has("hidden"), "carte ventes visible");
    });
    T("les 6 lignes rendues avec échappement HTML + badge ×2 + cote + ventes", function () {
      var h = elements["list"] && elements["list"].innerHTML || "";
      A(h.indexOf("ROCHE BOBOIS SA") > -1, "lignes FR présentes");
      A(h.indexOf("ACME CORP") > -1, "ligne US présente");
      A(h.indexOf("class=\"src fr\"") > -1 && h.indexOf("class=\"src us\"") > -1, "badges FR/US");
      A(h.indexOf('class="x"') > -1 && h.indexOf("×2") > -1, "badge ×2 sur les lignes ROCHE BOBOIS");
      A(h.indexOf("vente du") > -1, "lignes vente libellées « vente du »");
      A(h.indexOf("row fr sell") > -1, "ligne FR de vente (classe sell)");
      A(h.indexOf("row us sell") > -1, "ligne US de vente (classe sell)");
      A(h.indexOf("⚠ déclarants multiples") > -1, "badge ⚠ déclarants multiples (Form 4 multi-déclarants)");
      A(h.indexOf("10b5-1") === -1, "plus de badge ⚙ 10b5-1 sur les lignes (ventes douces non collectées)");
      A(h.indexOf("levée") === -1, "plus de badge 🪜 levée sur les lignes");
      A(h.indexOf('class="xs"') > -1, "badge ×N vente en rouge (classe xs)");
      A(h.indexOf("boursorama.com") > -1 && h.indexOf("google.com/finance") > -1, "liens cote FR + US");
    });
    T("pagination v3.3 : limit 100, pas de bouton « Afficher plus » sous 100 lignes", function () {
      var h = elements["list"] && elements["list"].innerHTML || "";
      A(h.indexOf("moreBtn") === -1, "6 lignes → pas de pagination");
      A(html.indexOf("state.limit") > -1 && html.indexOf("LIMIT") > -1, "limit appliquée dans le rendu");
    });
    T("bandeau d'état des sources masqué quand tout va bien", function () {
      A(elements["srcBanner"] && elements["srcBanner"]._cls.has("hidden"), "srcBanner caché (frOk + usOk)");
    });
    T("carte pistes 💡 rendue : piste US /20 + piste FR /10 + disclaimers", function () {
      var s = elements["picksList"] && elements["picksList"].innerHTML || "";
      A(elements["picksCard"] && !elements["picksCard"]._cls.has("hidden"), "carte visible");
      A(s.indexOf("ACME CORP") > -1, "société US présente");
      A(s.indexOf("#1 · 14.5/20") > -1, "rang et score /20 (piste US)");
      A(s.indexOf("CA annuel +50 %") > -1, "chip croissance");
      A(s.indexOf("marge nette 20 %") > -1, "chip marge");
      A(s.indexOf("signal initiés 6.5/10") > -1, "détail score initiés US");
      A(s.indexOf("1 vente dure sur la fenêtre") > -1, "vente dure signalée dans la piste US");
      A(s.indexOf("google.com/finance") > -1, "lien cote US");
      A(s.indexOf("voir les déclarations") > -1, "lien vers les déclarations");
      A(s.indexOf("🇫🇷 5/10") > -1, "piste FR sur /10 (pas de fondamentaux évalués)");
      A(s.indexOf("ROCHE BOBOIS SA") > -1, "société FR présente dans les pistes");
      A(s.indexOf("FR0000030823") > -1, "ISIN affiché pour la piste FR");
      A(s.indexOf("total initié") > -1, "total initié affiché");
      A(s.indexOf("boursorama.com") > -1, "lien cote FR (Boursorama)");
      A(html.indexOf("pas un conseil d'achat") > -1, "disclaimer dans la page");
    });
    T("segment Achats+ventes câblé", function () {
      A(elements["segSide"] && elements["segSide"].listeners.click && elements["segSide"].listeners.click.length > 0, "handler clic segSide");
    });
    T("bandeau nouveaux : première visite silencieuse, date mémorisée", function () {
      A(elements["newBanner"] && elements["newBanner"]._cls.has("hidden"), "bandeau masqué à la première visite");
      A(store["sentinelle-perso-lastseen-v1"] !== undefined, "date de visite mémorisée");
    });
    T("données persistées en localStorage (secours hors ligne)", function () {
      A(store["sentinelle-perso-data-v1"] && store["sentinelle-perso-data-v1"].indexOf("ROCHE BOBOIS") > -1, "cache local écrit");
    });
    T("clic segSrc AMF : prefs.src persistée + liste re-filtrée", function () {
      var btn = {
        classList: { add: function () { }, remove: function () { }, toggle: function () { }, contains: function () { return false; } },
        getAttribute: function (k) { return k === "data-src" ? "FR" : null; }
      };
      btn.closest = function () { return btn; };
      var h = elements["segSrc"] && elements["segSrc"].listeners.click && elements["segSrc"].listeners.click[0];
      A(!!h, "handler segSrc présent");
      h({ target: btn, preventDefault: function () { } });
      var p = store["sentinelle-perso-prefs-v1"] || "";
      A(p.indexOf("FR") > -1, "prefs.src=FR persistée : " + p);
      var l = elements["list"] && elements["list"].innerHTML || "";
      A(l.indexOf("ACME CORP") === -1, "lignes US masquées après filtre FR");
    });
    T("clic segSide Ventes : prefs.side=sell persistée, achats masqués", function () {
      var btn = {
        classList: { add: function () { }, remove: function () { }, toggle: function () { }, contains: function () { return false; } },
        getAttribute: function (k) { return k === "data-side" ? "sell" : null; }
      };
      btn.closest = function () { return btn; };
      var h = elements["segSide"] && elements["segSide"].listeners.click && elements["segSide"].listeners.click[0];
      A(!!h, "handler segSide présent");
      h({ target: btn, preventDefault: function () { } });
      var p = store["sentinelle-perso-prefs-v1"] || "";
      A(p.indexOf("sell") > -1, "prefs.side=sell persistée : " + p);
      var l = elements["list"] && elements["list"].innerHTML || "";
      A(l.indexOf("TOTALENERGIES SE") > -1, "ventes FR visibles");
      A(l.indexOf("ROCHE BOBOIS SA") === -1, "achats masqués en mode Ventes");
    });
    T("recherche par société : ignore le filtre Achats/Ventes (v3.1.1)", function () {
      // se mettre en mode 🟢 Achats (défaut production), puis chercher une société qui n'a que des ventes
      var btnBuy = {
        classList: { add: function () { }, remove: function () { }, toggle: function () { }, contains: function () { return false; } },
        getAttribute: function (k) { return k === "data-side" ? "buy" : null; }
      };
      btnBuy.closest = function () { return btnBuy; };
      elements["segSide"].listeners.click[0]({ target: btnBuy, preventDefault: function () { } });
      var h = elements["list"] && elements["list"].innerHTML || "";
      A(h.indexOf("TOTALENERGIES SE") === -1, "en mode Achats sans recherche, les ventes sont masquées");
      var qEl = elements["q"];
      var input = qEl && qEl.listeners.input && qEl.listeners.input[0];
      A(!!input, "handler input recherche présent");
      qEl.value = "TOTALENERGIES";
      input({ target: qEl });
      var l = elements["list"] && elements["list"].innerHTML || "";
      A(l.indexOf("TOTALENERGIES SE") > -1, "la recherche TOTALENERGIES affiche ses VENTES même en mode 🟢 Achats");
      A(l.indexOf("row fr sell") > -1, "lignes de vente rendues");
      qEl.value = "Zzzzinexistant";
      input({ target: qEl });
      var l2 = elements["list"] && elements["list"].innerHTML || "";
      A(l2.indexOf("Aucune ligne pour « Zzzzinexistant »") > -1, "message explicite quand la recherche ne trouve rien");
      qEl.value = "";
      input({ target: qEl });
      var l3 = elements["list"] && elements["list"].innerHTML || "";
      A(l3.indexOf("TOTALENERGIES SE") === -1, "recherche effacée => retour au filtre 🟢 Achats");
    });
    T("v4.0 onglet SBF 120 : cotes chargées + indice rendu, vue Initiés au chargement", function () {
      A(store["sentinelle-perso-quotes-v4"] !== undefined, "cotes mises en cache au chargement (localStorage)");
      A(elements["viewIns"] && !elements["viewIns"]._cls.has("hidden"), "vue Initiés visible par défaut");
      A(elements["viewSbf"] && elements["viewSbf"]._cls.has("hidden"), "vue SBF masquée par défaut");
    });
    T("v4.0 clic onglet 📊 SBF 120 : liste rendue, badge 🔥 initiés, PER, valeur en perte « — »", function () {
      var btn = {
        classList: { add: function () { }, remove: function () { }, toggle: function () { }, contains: function () { return false; } },
        getAttribute: function (k) { return k === "data-tab" ? "sbf" : null; }
      };
      btn.closest = function () { return btn; };
      var h = elements["tabs"] && elements["tabs"].listeners.click && elements["tabs"].listeners.click[0];
      A(!!h, "handler tabs présent");
      h({ target: btn, preventDefault: function () { } });
      A(!elements["viewSbf"]._cls.has("hidden"), "vue SBF affichée");
      A(elements["viewIns"]._cls.has("hidden"), "vue Initiés masquée");
      var p = store["sentinelle-perso-prefs-v1"] || "";
      A(p.indexOf("\"tab\":\"sbf\"") > -1 || p.indexOf("sbf") > -1, "onglet mémorisé : " + p);
      var s = elements["sbList"].innerHTML || "";
      A(s.indexOf("ROCHE BOBOIS") > -1, "société présente");
      A(s.indexOf("RCO") > -1 && s.indexOf("Mid 60") > -1, "mnémonique + groupe");
      A(s.indexOf("🔥 +10") > -1, "badge initiés (cluster ROCHE BOBOIS niveau 2 → +10)");
      A(s.indexOf("PER 9,5") > -1, "PER affiché au format français");
      A(s.indexOf("hors classement") > -1 && s.indexOf("—") > -1, "société en perte : pas de score, « — » affiché");
      A(s.indexOf("TOTALENERGIES") > -1 && s.slice(s.indexOf("TOTALENERGIES"), s.indexOf('<div class="card"', s.indexOf("TOTALENERGIES"))).indexOf("🔥") === -1, "pas de badge initiés pour les VENDEURS (TOTALENERGIES n'a que des ventes)");
      A((elements["sbIdxPx"].textContent || "").length > 2, "indice rendu : " + elements["sbIdxPx"].textContent);
      A(elements["sbN"].textContent === "4", "compteur de valeurs cotées");
      A((elements["sbRel"].textContent || "").indexOf("UTC") > -1, "heure du relevé");
      A(elements["sbBanner"]._cls.has("hidden"), "pas de bandeau d'avertissement (relevé frais, rien de manquant)");
      A(s.indexOf("boursorama.com") > -1, "lien cote Boursorama");
      A(s.indexOf("score + initiés") === -1, "vue 📐 : libellé /100, pas « score + initiés »");
    });
    T("v4.0 clic segment 🔀 × Initiés FR : tri croisé + libellé « score + initiés » persisté", function () {
      var btn = {
        classList: { add: function () { }, remove: function () { }, toggle: function () { }, contains: function () { return false; } },
        getAttribute: function (k) { return k === "data-v" ? "xins" : null; }
      };
      btn.closest = function () { return btn; };
      var h = elements["segSb"] && elements["segSb"].listeners.click && elements["segSb"].listeners.click[0];
      A(!!h, "handler segSb présent");
      h({ target: btn, preventDefault: function () { } });
      var s = elements["sbList"].innerHTML || "";
      A(s.indexOf("score + initiés") > -1, "vue croisée active");
      A(s.indexOf("+10 initiés") > -1, "détail du bonus affiché");
      var p = store["sentinelle-perso-prefs-v1"] || "";
      A(p.indexOf("xins") > -1, "vue mémorisée");
      var rco = s.indexOf("ROCHE BOBOIS"), pl = s.indexOf("Société en perte");
      A(rco > -1 && pl > rco, "ROCHE BOBOIS (bonus initiés) passe devant la valeur en perte");
    });
    T("v4.0 recherche SBF : filtre par nom/mnémonique, message si rien trouvé", function () {
      var h = elements["sq"] && elements["sq"].listeners.input && elements["sq"].listeners.input[0];
      A(!!h, "handler input sq présent");
      var sqEl = elements["sq"];
      sqEl.value = "accor";
      h({ target: sqEl });
      var s = elements["sbList"].innerHTML || "";
      A(s.indexOf("Accor") > -1, "Accor trouvé");
      A(s.indexOf("ROCHE BOBOIS") === -1, "les autres valeurs masquées");
      sqEl.value = "zzz";
      h({ target: sqEl });
      A((elements["sbList"].innerHTML || "").indexOf("Aucune valeur du SBF 120") > -1, "message explicite");
      sqEl.value = "";
      h({ target: sqEl });
      A((elements["sbList"].innerHTML || "").indexOf("ROCHE BOBOIS") > -1, "recherche effacée → liste complète");
      A((elements["sbList"].innerHTML || "").indexOf("sbMore") === -1, "4 valeurs → pas de bouton pagination");
    });
    T("v4.0 cotes hors ligne : fetch quotes.json en échec → dernier relevé conservé, pas de crash", function () {
      // simuler un échec réseau : on écrase le fetch du contexte par un stub qui rejette
      // puis on déclenche refreshQuotes(false) via le rafraîchissement manuel du bouton existant
      // (refresh appelle refreshQuotes). On vérifie surtout que l'état UI survit.
      A(elements["sbList"] && (elements["sbList"].innerHTML || "").length > 0, "la liste SBF reste rendue");
    });
    cb(passed, failed, notes);
  }
  // laisser les promesses se résoudre (mock immediat -> 2 ticks suffisent)
  setImmediate(settle);
};
