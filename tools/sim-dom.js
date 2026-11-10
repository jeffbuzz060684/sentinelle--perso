#!/usr/bin/env node
"use strict";
// Simulation DOM v5.0.1 : charge index.html (app MONOVUE 🇫🇷 CAC 40) avec des stubs, exécute logic.js
// puis les blocs inline, et vérifie le rendu final : classement 🎯 (TTE 57 🥈 devant Accor 46 🥉),
// indice dédié, macro 🌍 en contexte, détail complet au tap, recherche, bouton Réessayer,
// garde anti-skew, hors ligne sans cache (message honnête) et hors ligne AVEC cache (le classement survit).
// Exporte (cb(passed, failed, notes)) pour test.js.
var fs = require("fs");
var vm = require("vm");
var path = require("path");

module.exports = function simDom(cb) {
  var passed = 0, failed = 0, notes = [];
  function T(name, fn) {
    try { fn(); passed++; notes.push("OK  " + name); }
    catch (e) { failed++; notes.push("ÉCHEC " + name + " : " + (e && e.message || e)); }
  }
  function A(cond, msg) { if (!cond) throw new Error(msg || "assertion"); }

  var html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

  // ---- stubs DOM minimaux ----
  var elements = {};
  function El(id) {
    var el = {
      id: id, style: {}, textContent: "", value: "", innerHTML: "", className: "", href: "",
      _cls: new Set(), listeners: {},
      classList: {
        add: function (c) { el._cls.add(c); },
        remove: function (c) { el._cls.delete(c); },
        toggle: function (c, on) { if (on === undefined) { el._cls.has(c) ? el._cls.delete(c) : el._cls.add(c); } else if (on) { el._cls.add(c); } else { el._cls.delete(c); } },
        contains: function (c) { return el._cls.has(c); }
      },
      addEventListener: function (ev, fn) { (el.listeners[ev] = el.listeners[ev] || []).push(fn); },
      fire: function (ev, e) { (el.listeners[ev] || []).forEach(function (f) { f(e || { target: el }); }); },
      getAttribute: function () { return null; }, closest: function () { return null; },
      querySelectorAll: function () { return []; }
    };
    return el;
  }
  var docListeners = {};
  var document = {
    getElementById: function (id) { if (!elements[id]) elements[id] = El(id); return elements[id]; },
    addEventListener: function (t, f) { (docListeners[t] = docListeners[t] || []).push(f); },
    querySelectorAll: function () { return []; },
    hidden: false
  };
  var store = {};
  var localStorage = {
    getItem: function (k) { return store[k] == null ? null : store[k]; },
    setItem: function (k, v) { store[k] = String(v); },
    removeItem: function (k) { delete store[k]; }
  };

  // ---- fixture quotes.json (validée v4.1.0 — moteur inchangé en v5.0.0) ----
  //   • TOTALENERGIES : qScore 80, val 100 (PER 8,1 le plus bas, rend. 5,4 %, P/B 0,8), upX 11,7 % → consensus 0 → aScore 57 (🥈)
  //   • Accor : qScore 20, val 10, upX 15,7 % le meilleur → consensus 100 → aScore 46 (🥉)
  //   • ROCHE BOBOIS (mid60) et Société en perte (mid60) : JAMAIS dans le périmètre cac40
  //   ⇒ TOTALENERGIES (57) DOIT apparaître AVANT Accor (46).
  var isoNow = new Date().toISOString();
  var macroDay = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  var FX = {
    updated: isoNow, source: "Yahoo Finance (Euronext en différé ~15 min)", ok: true, n: 4, missing: [], sbUpdated: "2026-11-09",
    cacIdx: { px: 7754.32, chg: 0.85, name: "CAC 40", t: Math.floor(Date.now() / 1000) },
    macro: { dateData: macroDay, dateMacro: isoNow, source: "Radar Conjoncture", vix: 21.4, vix5: 20.8, oat10: 4.76, bund10: 3.25, bceDepot: 2, bceDir: "hausse", inflZE: 2.2, pmiZE: 47.5, cape: 21.3 },
    list: [
      { y: "AC.PA", n: "Accor", mn: "AC", g: "cac40", isin: "FR0000120404", px: 39.42, chg: 0.81, per: 14.2, fper: 13.1, dY: 2.1, pb: 1.4, cap: 8.5e9, roe: 0.05, mOp: 0.03, gRev: -0.02, de: 10, tp: 45.6, tpLo: 40, tpHi: 52, tpN: 12, rec: "buy", nextRes: "2026-12-05", surp: 2.4, w52lo: 31.1, w52hi: 44.3 },
      { y: "TTE.PA", n: "TOTALENERGIES", mn: "TTE", g: "cac40", isin: "FR0000120271", px: 58.1, chg: -0.3, per: 8.1, fper: 7.6, dY: 5.4, pb: 0.8, cap: 1.2e11, roe: 0.2, mOp: 0.15, gRev: 0.03, de: 25, tp: 64.9, tpLo: 60, tpHi: 72, tpN: 18, rec: "hold", nextRes: "2026-12-11", surp: -1.1, w52lo: 52.9, w52hi: 66.7 },
      { y: "RCO.PA", n: "ROCHE BOBOIS", mn: "RCO", g: "mid60", isin: "FR0000030823", px: 16.4, chg: 1.2, per: 9.5, fper: 8.8, dY: 3.8, pb: 1.6, cap: 6.2e8 },
      { y: "PL.PA", n: "Société en perte", mn: "PL", g: "mid60", isin: "", px: 3.3, chg: -2.1, per: null, fper: null, dY: null, pb: null, cap: 4.5e7 }
    ]
  };
  var fetchCalls = 0;
  var OFFLINE = false;
  function fetchStub(url) {
    fetchCalls++;
    if (OFFLINE) return Promise.reject(new Error("sim hors ligne"));
    if (String(url).indexOf("quotes.json") > -1) {
      return Promise.resolve({ ok: true, json: function () { return Promise.resolve(JSON.parse(JSON.stringify(FX))); } });
    }
    return Promise.reject(new Error("URL inattendue en monovue : " + url));
  }
  var runErrors = [];
  var sandbox = {
    document: document, localStorage: localStorage, fetch: fetchStub,
    setInterval: function () { return 0; }, setTimeout: function () { return 0; }, clearTimeout: function () {},
    navigator: { serviceWorker: { register: function () { return Promise.resolve({}); } }, onLine: true, userAgent: "sim" },
    console: console
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  function run(src, name) {
    try { vm.runInContext(src, sandbox, { filename: name }); }
    catch (e) { runErrors.push(name + " ⛔ " + (e && e.message || e)); }
  }

  // 1. logic.js (moteur RI), 2. blocs <script> inline d'index.html dans l'ordre du document
  run(fs.readFileSync(path.join(__dirname, "..", "logic.js"), "utf8"), "logic.js");
  var re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g, m, i = 0;
  while ((m = re.exec(html))) run(m[1], "index.html#inline" + (i++));

  // âge attendu du relevé macro (relevé d'hier, calcul identique à macroState)
  var expAge = (function () { var d = new Date(); return Math.round((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.parse(macroDay + "T00:00:00Z")) / 86400000); })();   // v5.0.1 : âge en jours calendaires, comme macroState
  function txt(id) { return String((elements[id] && (elements[id].textContent || elements[id].innerHTML)) || ""); }
  function settle(fn) { setImmediate(function () { setImmediate(fn); }); }

  // le script inline a déjà appelé loadCac() : le fetch se règle en microtâches → vérifs après settle
  settle(function () {
    T("logic.js + blocs inline exécutés sans erreur (RI présent, garde anti-skew armée)", function () {
      A(runErrors.length === 0, "erreurs d'exécution : " + runErrors.join(" | "));
      A(!!sandbox.RI && !!sandbox.RI.cacScores, "RI.cacScores exposé");
      A(typeof sandbox.loadCac === "function" && typeof sandbox.renderCacData === "function", "loadCac/renderCacData globaux");
    });
    T("chargement : fetch quotes.json → classement rendu, cache localStorage persisté (secours hors ligne)", function () {
      var s = elements["cacList"] ? elements["cacList"].innerHTML : "";
      A(s.indexOf("TOTALENERGIES") > -1 && s.indexOf("Accor") > -1, "les 2 cac40 rendues");
      A(s.indexOf("ROCHE BOBOIS") === -1 && s.indexOf("Société en perte") === -1, "les Mid 60 (ROCHE BOBOIS, Société en perte) sont EXCLUS du périmètre");
      A((store["sentinelle-cac-quotes-v1"] || "").indexOf("TOTALENERGIES") > -1, "relevé persisté dans sentinelle-cac-quotes-v1");
      A(fetchCalls === 1, "exactement 1 fetch (quotes.json) au chargement, pas de data.json en monovue");
    });
    T("classement 🎯 : TOTALENERGIES (57, 🥈) DEVANT Accor (46, 🥉), scores et verdicts rendus", function () {
      var s = elements["cacList"].innerHTML;
      A(s.indexOf("TOTALENERGIES") < s.indexOf("Accor"), "TOTALENERGIES (aScore 57) AVANT Accor (46)");
      A(s.indexOf(">57<") > -1 && s.indexOf(">46<") > -1, "scores 🎯 57 et 46 affichés");
      A(s.indexOf("🥈") > -1 && s.indexOf("🥉") > -1, "verdicts 🥈 (57) et 🥉 (46)");
      A(s.indexOf("consensus 100/100") > -1 && s.indexOf("consensus 0/100") > -1, "percentiles consensus 100 (Accor) et 0 (TTE)");
      A(elements["cacN"].textContent === "2/40 cotées", "compteur 2/40 cotées (les mid60 ne comptent pas)");
    });
    T("indice CAC 40 dédié : nom, cours 7 754,32, variation +0,85 %", function () {
      var s = elements["cacIdxLine"].innerHTML;
      A(s.indexOf("CAC 40") > -1 && s.indexOf("7754,32") > -1 && s.indexOf("+0,85 %") > -1, "ligne indice complète : " + s);
    });
    T("macro 🌍 en contexte (jamais notée) : chips VIX/OAT/Bund/spread/BCE/inflation/PMI/CAPE + note source Radar", function () {
      var ch = txt("cacChips");
      A(ch.indexOf("VIX 21,4") > -1 && ch.indexOf("lissé 5 j 20,8") > -1, "chip VIX + lissé 5 j");
      A(ch.indexOf("OAT 10 ans 4,76 %") > -1 && ch.indexOf("Bund 10 ans 3,25 %") > -1, "chips OAT + Bund");
      A(ch.indexOf("spread France-Allemagne 151 pb") > -1, "spread calculé en pb");
      A(ch.indexOf("BCE dépôt 2 % (hausse)") > -1, "chip BCE + direction");
      A(ch.indexOf("inflation ZE 2,2 %") > -1 && ch.indexOf("PMI ZE 47,5") > -1 && ch.indexOf("CAPE 21,3") > -1, "chips inflation/PMI/CAPE");
      var mn = txt("cacMNote");
      A(mn.indexOf("relevés publics du Radar Conjoncture") > -1, "source tracée");
      A(mn.indexOf("(" + expAge + " j)") > -1, "âge du relevé affiché (" + expAge + " j)");
      A(mn.indexOf("jamais") > -1 && mn.indexOf("score 🎯") > -1, "macro explicitement hors score");
      A(mn.indexOf("Relevé ancien") === -1, "pas d'alerte péremption à 1 j");
      A(elements["cacMacroCard"].style.display !== "none", "carte macro visible");
    });
    T("meta relevé + bandeau d'avertissement honnête", function () {
      var rel = txt("cacRel");
      A(rel.indexOf("source : Yahoo") > -1 && rel.indexOf("différé ~15 min") > -1, "source + différé");
      A(rel.indexOf("composition du 09/11/2026") > -1, "date de composition (périmètre automatique)");
      A(elements["cacBanner"].style.display !== "none", "bandeau visible");
      A(txt("cacBanner").indexOf("sans cote") > -1, "les 38 valeurs sans cote de la fixture sont tracées");
    });
    T("détail complet au tap : composantes (base 3/3), valorisation, qualité, consensus, résultats, 52 s., cap., cote", function () {
      var s = elements["cacList"].innerHTML;
      A(s.indexOf("Composantes du score") > -1 && s.indexOf("(base 3/3)") > -1, "composantes + base affichées");
      A(s.indexOf("PER 8,1") > -1 && s.indexOf("rendement 5,4 %") > -1 && s.indexOf("P/B 0,8") > -1, "valorisation détaillée (TTE)");
      A(s.indexOf("ROE 20 %") > -1 && s.indexOf("marge op. 15 %") > -1 && s.indexOf("dette/CP 25 %") > -1, "qualité détaillée (TTE)");
      A(s.indexOf("64,9 €") > -1 && s.indexOf("+11,7 %") > -1 && s.indexOf("18 analystes") > -1, "objectif consensus +18 analystes");
      A(s.indexOf("prochaine publication le") > -1 && s.indexOf("05/12/2026") > -1 && s.indexOf("11/12/2026") > -1, "prochaines publications (calendarEvents)");
      A(s.indexOf("surprise EPS") > -1 && s.indexOf("✅") > -1 && s.indexOf("❌") > -1, "surprises EPS ✅ (Accor) et ❌ (TTE)");
      A(s.indexOf("52,9 – 66,7") > -1 && s.indexOf("52 s.") > -1, "fourchette 52 s.");
      A(s.indexOf("120 Md€") > -1, "capitalisation formatée");
      A(s.indexOf("boursorama.com") > -1, "lien cote");
      A(s.indexOf('<div class="crow"') > -1 && s.indexOf('class="csc') > -1 && s.indexOf('<div class="cdet"') > -1, "structure tableau compact portée du Radar");
    });
    T("tap sur une ligne → détail déplie, re-tap → se replie", function () {
      var det = document.getElementById("cdet0");
      det.style.display = "none";   // comme dans le DOM réel : inline style du détail masqué au rendu
      var fakeRow = { classList: { contains: function (c) { return c === "crow"; } }, getAttribute: function (k) { return k === "data-i" ? "0" : null; }, parentNode: null };
      elements["cacList"].fire("click", { target: fakeRow });
      A(det.style.display === "", "1er tap → détail déplié");
      elements["cacList"].fire("click", { target: fakeRow });
      A(det.style.display === "none", "2e tap → détail replié");
    });
    T("recherche : filtre par nom, message si rien trouvé, retour au classement complet", function () {
      elements["cq"].fire("input", { target: { value: "accor" } });
      var s = elements["cacList"].innerHTML;
      A(s.indexOf("Accor") > -1 && s.indexOf("TOTALENERGIES") === -1, "« accor » → Accor seule");
      elements["cq"].fire("input", { target: { value: "zzz" } });
      A((elements["cacList"].innerHTML || "").indexOf("Aucune valeur du CAC 40 pour") > -1, "message explicite si rien trouvé");
      elements["cq"].fire("input", { target: { value: "" } });
      A((elements["cacList"].innerHTML || "").indexOf("TOTALENERGIES") > -1, "recherche effacée → classement complet");
    });
    T("garde anti-skew : logic.js absent/périmé → renderCacData ne lève pas, le classement rendu reste en place", function () {
      var RI_SAVED = sandbox.RI;
      sandbox.RI = undefined;
      var ok = true;
      try { sandbox.renderCacData(JSON.parse(JSON.stringify(FX))); } catch (e) { ok = false; }
      A(ok, "jamais de crash (garde typeof RI)");
      A((elements["cacList"].innerHTML || "").indexOf("TOTALENERGIES") > -1, "page jamais blanche : le dernier rendu survit");
      sandbox.RI = RI_SAVED;
    });
    T("bouton Réessayer → loadCac(true) → nouveau fetch, re-rendu", function () {
      elements["btnCacRetry"].fire("click");
      A(fetchCalls === 2, "2e fetch déclenché");
    });
    settle(function () {
      T("re-rendu après Réessayer : classement toujours complet", function () {
        var s = elements["cacList"].innerHTML || "";
        A(s.indexOf("TOTALENERGIES") > -1 && s.indexOf("Accor") > -1, "classement re-rendu");
        A(elements["cacN"].textContent === "2/40 cotées", "compteur intact");
      });
      T("retour sur l'app (visibilitychange) avec relevé frais → AUCUN fetch parasite (anti-marteau)", function () {
        var before = fetchCalls;
        (docListeners.visibilitychange || []).forEach(function (f) { f(); });
        A(fetchCalls === before, "relevé de moins de 10 min → pas de refetch");
      });
      // ---- hors ligne, cache vide ----
      OFFLINE = true;
      delete store["sentinelle-cac-quotes-v1"];
      sandbox.cacState.q = null; sandbox.cacState.loading = false; sandbox.cacState.lastTry = 0;
      sandbox.loadCac(true);
      settle(function () {
        T("hors ligne SANS cache → pas de crash, message « Relevé indisponible » honnête", function () {
          A((elements["cacList"].innerHTML || "").indexOf("Relevé indisponible") > -1, "message affiché, jamais une page blanche");
        });
        // ---- hors ligne, cache présent (comme au 2e lancement réel : cacInit a lu le cache) ----
        sandbox.cacSave(FX);
        sandbox.cacState.q = JSON.parse(JSON.stringify(FX));
        sandbox.loadCac(true);
        settle(function () {
          T("hors ligne AVEC cache → le classement du cache reste affiché (« Relevé indisponible » ne l'écrase JAMAIS)", function () {
            var s = elements["cacList"].innerHTML || "";
            A(s.indexOf("TOTALENERGIES") > -1 && s.indexOf("Accor") > -1, "classement du cache rendu");
            A(s.indexOf("Relevé indisponible") === -1, "le message d'erreur n'écrase pas un classement existant");
          });
          cb(passed, failed, notes);
        });
      });
    });
  });
};
