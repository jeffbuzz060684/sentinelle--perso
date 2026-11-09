#!/usr/bin/env node
// ─── Sentinelle perso — validation de data.json avant tout déploiement ────────
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('./insiders-core.js');

const dp = path.join(__dirname, '..', 'data.json');
if (!fs.existsSync(dp)) {
  console.error('validate-data : data.json introuvable');
  process.exit(1);
}
let d;
try { d = JSON.parse(fs.readFileSync(dp, 'utf8')); }
catch (e) { console.error('validate-data : JSON illisible :', e.message); process.exit(1); }

const errs = C.validateData(d);
// gardes supplémentaires
if (!d.generatedAt || !/^\d{4}-\d{2}-\d{2}T/.test(d.generatedAt)) errs.push('generatedAt manquant/invalid');
if (d.buys && d.buys.length > 3000) errs.push('buys anormalement long (' + d.buys.length + ')');
// jamais de données personnelles (dépôt public) : liste blanche des clés de premier niveau
const topKeys = Object.keys(d).sort();
const allowed = ['aVerifier', 'buys', 'generatedAt', 'sources', 'stats', 'usScanned', 'windowDays'];
const forbidden = topKeys.filter(k => allowed.indexOf(k) === -1);
if (forbidden.length) errs.push('clés inconnues (données perso interdites) : ' + forbidden.join(','));

if (errs.length) {
  console.error('validate-data : ÉCHEC');
  errs.forEach(e => console.error(' -', e));
  process.exit(1);
}
console.log('validate-data : OK —', (d.buys || []).length, 'entrées,',
  'stats', JSON.stringify(d.stats || {}));
