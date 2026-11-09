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
  var FETCH_DATA = {
    updated: "2026-11-09T08:07:00Z", frOk: true, usOk: true,
    fr: [
      { id: "f1", source: "FR", side: "buy", societe: "ROCHE BOBOIS SA", auteur: "TXR S.R.L.", role: "Membre du Conseil de Surveillance", nature: "Acquisition", instrument: "Action", isin: "", dateOp: "2026-11-05", datePub: "2026-11-06", volume: 1400, prix: 15.7286, montant: 22020.04, url: "https://bdif.amf-france.org/x" },
      { id: "f2", source: "FR", side: "buy", societe: "ROCHE BOBOIS SA", auteur: "GIOVANNI TAMBURI", role: "Président", nature: "Acquisition", instrument: "Action", isin: "", dateOp: "2026-11-04", datePub: "2026-11-06", volume: 600, prix: 16, montant: 9600, url: "https://bdif.amf-france.org/y" }
    ],
    us: [{ id: "u1", source: "US", side: "buy", societe: "ACME CORP", ticker: "ACM", auteur: "John Doe", role: "CEO", nature: "Achat", instrument: "Common Stock", isin: "", dateOp: "2026-11-04", datePub: "2026-11-05", volume: 2000, prix: 30, montant: 60000, code: "P", url: "https://sec.gov/x" }],
    frS: [
      { id: "fs1", source: "FR", side: "sell", societe: "TOTALENERGIES SE", auteur: "POUVANNEC PHILIPPE", role: "Directeur Général Adjoint", nature: "Cession", instrument: "Action", isin: "", dateOp: "2026-11-05", datePub: "2026-11-06", volume: 15000, prix: 64.9, montant: 973500, url: "https://bdif.amf-france.org/z" },
      { id: "fs2", source: "FR", side: "sell", societe: "TOTALENERGIES SE", auteur: "SAUNIER BERTRAND", role: "Membre du Conseil d'Administration", nature: "Cession", instrument: "Action", isin: "", dateOp: "2026-11-04", datePub: "2026-11-06", volume: 2000, prix: 65, montant: 130000, url: "https://bdif.amf-france.org/w" }
    ],
    usS: [{ id: "us1", source: "US", side: "sell", societe: "ACME CORP", ticker: "ACM", auteur: "John Doe", role: "CEO", nature: "Vente", instrument: "Common Stock", isin: "", dateOp: "2026-11-03", datePub: "2026-11-05", volume: 1000, prix: 30, montant: 30000, code: "S", p10b5: true, opt: true, url: "https://sec.gov/y" }]
  };
  var fetchCalls = 0;
  function fetchStub(url) {
    fetchCalls++;
    if (String(url).indexOf("data.json") === 0 || String(url).indexOf("data.json") > -1) {
      return Promise.resolve({ ok: true, json: function () { return Promise.resolve(JSON.parse(JSON.stringify(FETCH_DATA))); } });
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
      A(h.indexOf("10b5-1") > -1, "badge ⚙ 10b5-1 sur la vente US (plan déclaré)");
      A(h.indexOf("levée") > -1, "badge 🪜 levée sur la vente US (code M dans le dépôt)");
      A(h.indexOf('class="xs"') > -1, "badge ×N vente en rouge (classe xs)");
      A(h.indexOf("boursorama.com") > -1 && h.indexOf("google.com/finance") > -1, "liens cote FR + US");
    });
    T("bandeau d'état des sources masqué quand tout va bien", function () {
      A(elements["srcBanner"] && elements["srcBanner"]._cls.has("hidden"), "srcBanner caché (frOk + usOk)");
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
    cb(passed, failed, notes);
  }
  // laisser les promesses se résoudre (mock immediat -> 2 ticks suffisent)
  setImmediate(settle);
};
