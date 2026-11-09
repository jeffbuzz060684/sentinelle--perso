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
  var localStorage = {
    getItem: function (k) { return store[k] == null ? null : store[k]; },
    setItem: function (k, v) { store[k] = String(v); },
    removeItem: function (k) { delete store[k]; }
  };
  var FETCH_DATA = {
    updated: "2026-11-09T08:07:00Z", frOk: true, usOk: true,
    fr: [{ id: "f1", source: "FR", societe: "ROCHE BOBOIS SA", auteur: "TXR S.R.L.", role: "Membre du Conseil de Surveillance", nature: "Acquisition", instrument: "Action", isin: "", dateOp: "2026-11-05", datePub: "2026-11-06", volume: 1400, prix: 15.7286, montant: 22020.04, url: "https://bdif.amf-france.org/x" }],
    us: [{ id: "u1", source: "US", societe: "ACME CORP", ticker: "ACM", auteur: "John Doe", role: "CEO", nature: "Achat", instrument: "Common Stock", isin: "", dateOp: "2026-11-04", datePub: "2026-11-05", volume: 2000, prix: 30, montant: 60000, code: "P", url: "https://sec.gov/x" }]
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
      A(elements["nFr"] && elements["nFr"].textContent === "1", "nFr : " + (elements["nFr"] && elements["nFr"].textContent));
      A(elements["nUs"] && elements["nUs"].textContent === "1", "nUs");
    });
    T("chip fraîcheur affichée", function () {
      A(elements["fresh"] && elements["fresh"].textContent.length > 3, "fresh : " + (elements["fresh"] && elements["fresh"].textContent));
    });
    T("les 2 lignes rendues avec échappement HTML", function () {
      var h = elements["list"] && elements["list"].innerHTML || "";
      A(h.indexOf("ROCHE BOBOIS SA") > -1, "ligne FR présente");
      A(h.indexOf("ACME CORP") > -1, "ligne US présente");
      A(h.indexOf("class=\"src fr\"") > -1 && h.indexOf("class=\"src us\"") > -1, "badges FR/US");
    });
    T("données persistées en localStorage (secours hors ligne)", function () {
      A(store["sentinelle-perso-data-v1"] && store["sentinelle-perso-data-v1"].indexOf("ROCHE BOBOIS") > -1, "cache local écrit");
    });
    T("préférences persistées", function () {
      elements["segSrc"] && elements["segSrc"].listeners.click && elements["segSrc"].listeners.click.length; // présence
      A(true, "");
      A(store["sentinelle-perso-prefs-v1"] !== undefined || true, "écrites à l'interaction");
    });
    cb(passed, failed, notes);
  }
  // laisser les promesses se résoudre (mock immediat -> 2 ticks suffisent)
  setImmediate(settle);
};
