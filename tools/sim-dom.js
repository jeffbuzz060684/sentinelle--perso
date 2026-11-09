#!/usr/bin/env node
// ─── Sentinelle perso — simulation DOM du chargement complet de la page ──────
// Stubs DOM/localStorage/fetch → exécute index.html (scripts inline) + logic.js + app.js
// comme un navigateur classique, puis vérifie l'état final. À exécuter après tout
// changement d'UI : node tools/sim-dom.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) pass++;
  else { fail++; console.error('✗', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

// ── stubs DOM ────────────────────────────────────────────────────────────────
function makeElement(id) {
  const el = {
    id: id || '', innerHTML: '', value: '', _cls: new Set(), _listeners: {},
    classList: {
      add: c => el._cls.add(c), remove: c => el._cls.delete(c),
      toggle: c => { el._cls.has(c) ? el._cls.delete(c) : el._cls.add(c); },
      contains: c => el._cls.has(c)
    },
    addEventListener: (ev, fn) => { (el._listeners[ev] = el._listeners[ev] || []).push(fn); },
    getAttribute: () => null,
    set textContent(v) { el.innerHTML = String(v); },
    get textContent() { return el.innerHTML; }
  };
  return el;
}
const elements = {};
function getEl(id) { if (!elements[id]) elements[id] = makeElement(id); return elements[id]; }

const store = {};
const sandbox = {
  console: { log: () => {}, warn: () => {}, error: () => {} },
  document: {
    getElementById: getEl,
    querySelectorAll: sel => {
      if (sel === '.chip') return [
        Object.assign(makeElement('chip-tous'), { getAttribute: () => 'tous' }),
        Object.assign(makeElement('chip-fr'), { getAttribute: () => 'fr' }),
        Object.assign(makeElement('chip-us'), { getAttribute: () => 'us' }),
        Object.assign(makeElement('chip-gros'), { getAttribute: () => 'gros' }),
        Object.assign(makeElement('chip-nouveaux'), { getAttribute: () => 'nouveaux' })
      ];
      return [];
    },
    addEventListener: () => {},
    visibilityState: 'visible'
  },
  localStorage: {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; }
  },
  fetch: null, // défini plus bas
  navigator: { serviceWorker: { register: async () => {} } },
  window: {},
  setTimeout, clearTimeout, Date, Math, JSON, Promise, RegExp, String, Number, Array, Object, Boolean, Error
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

// data.json de test
const sampleData = {
  generatedAt: new Date().toISOString(),
  windowDays: 8,
  buys: [
    { id: 'FR-2026DD1', src: 'FR', societe: 'SOCIETE TEST', ticker: null, isin: 'FR00000', auteur: 'M. Dupont — Directeur Général', nature: 'Acquisition', volume: 1000, prix: 15.5, montant: 15500, devise: 'EUR', dateOp: '2026-11-05', datePub: '2026-11-06', detail: true, lienFiche: 'https://bdif.amf-france.org/fr/details/2026DD1', lienPdf: 'https://bdif.amf-france.org/back/api/v1/documents/2026/2026DD1/x.pdf' },
    { id: 'US-0001', src: 'US', societe: 'US CORP', ticker: 'USCP', isin: null, auteur: 'J. Smith — CEO', nature: 'Achat (code P)', volume: 500, prix: 20, montant: 10000, devise: 'USD', dateOp: '2026-11-05', datePub: '2026-11-06', detail: true, lienPdf: 'https://www.sec.gov/x.xml' },
    { id: 'FR-2026DD2', src: 'FR', societe: 'MYSTERE SA', ticker: null, isin: null, auteur: null, nature: null, volume: null, prix: null, montant: null, devise: 'EUR', dateOp: null, datePub: '2026-11-08', detail: false, lienFiche: 'https://bdif.amf-france.org/fr/details/2026DD2' }
  ],
  usScanned: [],
  sources: { fr: { status: 'ok' }, us: { status: 'ok' }, lastScan: new Date().toISOString() },
  stats: { total: 2, gros: 2, fr: 1, us: 1, aVerifier: 1 }
};
sandbox.fetch = async () => ({ ok: true, json: async () => sampleData });

// ── exécution navigateur-like des scripts ────────────────────────────────────
function runBrowser(src, label) {
  const script = new vm.Script(src, { filename: label });
  script.runInNewContext(sandbox);
}
runBrowser(fs.readFileSync(path.join(ROOT, 'logic.js'), 'utf8'), 'logic.js');
runBrowser(fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8'), 'app.js');

// app.js est async : laisser le chargement se terminer
setTimeout(async () => {
  const Logic = sandbox.Logic;
  t('sim : Logic exposé (module navigateur)', !!Logic);
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  t('sim : chaque <script> inline compile comme navigateur', (() => {
    const scripts = html.match(/<script>[\s\S]*?<\/script>/g) || [];
    return scripts.length === 0 || scripts.every(s => { try { new vm.Script(s.replace(/<\/?script>/g, '')); return true; } catch (e) { return false; } });
  })());

  // index.html référence bien les fichiers poussés
  for (const f of ['styles.css', 'logic.js', 'app.js', 'manifest.webmanifest', 'icon.svg']) {
    t('sim : index.html référence ' + f, html.indexOf(f) !== -1);
  }
  t('sim : apple-touch-icon', html.indexOf('apple-touch-icon') !== -1);

  // attendre le fetch asynchrone (loadData)
  await new Promise(r => setTimeout(r, 30));

  t('sim : scanLine rendu', getEl('scanLine').innerHTML.indexOf('Scan') !== -1);
  t('sim : liste rendue (2 achats)', (getEl('list').innerHTML.match(/class="buy/g) || []).length === 2);
  t('sim : gros achat surligné', getEl('list').innerHTML.indexOf('gros achat') !== -1);
  t('sim : carte FR avec fonction dirigeant', getEl('list').innerHTML.indexOf('Directeur Général') !== -1);
  t('sim : pas d entrée à-vérifier dans la liste', getEl('list').innerHTML.indexOf('MYSTERE') === -1);
  t('sim : section à-vérifier rendue', getEl('aVerifier').innerHTML.indexOf('MYSTERE SA') !== -1);
  t('sim : stats rendues', getEl('stats').innerHTML.indexOf('achats') !== -1);
  t('sim : échappement HTML actif', Logic.esc('<img src=x onerror=alert(1)>').indexOf('<img') === -1);

  // lastSeen marqué après la première visite
  t('sim : lastSeen persisté', !!store['sentinelle-perso-lastSeen']);
  t('sim : cache data.json persisté', !!store['sentinelle-perso-cache']);

  // filtre « gros » : filtre les montants < 10k
  const small = Logic.filterBuys([{ ...sampleData.buys[0], montant: 500 }], 'gros', '', null);
  t('sim : filtre gros exclut < 10k', small.length === 0);
  const big = Logic.filterBuys(sampleData.buys, 'gros', '', null);
  t('sim : filtre gros garde ≥ 10k', big.length === 2);

  // nouveau depuis dernière visite
  const nNew = Logic.countNew(sampleData.buys, '2026-11-07');
  t('sim : countNew ignore les achats déjà vus', nNew === 0, nNew);
  const nNew2 = Logic.countNew(sampleData.buys.concat([
    { id: 'X', src: 'FR', societe: 'NOUVEAU', montant: 100, devise: 'EUR', datePub: '2026-11-08', detail: true }
  ]), '2026-11-07');
  t('sim : countNew compte le nouveau du jour', nNew2 === 1, nNew2);

  // fmtScan honnête
  const fs1 = Logic.fmtScan({ generatedAt: new Date(Date.now() - 30 * 60000).toISOString(), sources: { fr: { status: 'ok' }, us: { status: 'ok' } } }, Date.now());
  t('sim : scan récent affiché', fs1.html.indexOf('30 min') !== -1 && fs1.fresh);
  const fs2 = Logic.fmtScan({ generatedAt: new Date(Date.now() - 5 * 86400000).toISOString(), sources: {} }, Date.now());
  t('sim : ancien scan signalé', !fs2.fresh && fs2.html.indexOf('ancien') !== -1);

  console.log(`\nsim-dom : ${pass} verts, ${fail} échecs`);
  process.exit(fail ? 1 : 0);
}, 20);
