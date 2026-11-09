#!/usr/bin/env node
// ─── Sentinelle perso — harnais de tests (0 échec obligatoire avant push) ────
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('./insiders-core.js');

const FIX = p => fs.readFileSync(path.join(__dirname, 'fixtures', p), 'utf8');
let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; console.error('✗', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

// ─── utilitaires ─────────────────────────────────────────────────────────────
t('parseNumFr 22 020.0400 €', C.parseNumFr('22\u00a0020.0400\u00a0€') === 22020.04);
t('parseNumFr vide', C.parseNumFr('') === null);
t('parseNumFr 1 006,08 (virgule)', C.parseNumFr('1\u00a0006,08\u00a0€') === 1006.08);
t('parseNumUs 10,000', C.parseNumUs('10,000') === 10000);
t('parseDateFr 05/11/2026', C.parseDateFr('05/11/2026') === '2026-11-05');
t('parseDateFr invalide', C.parseDateFr('2026-13-45') === null);
t('parseDateFr format', C.parseDateFr('2026-11-05') === null);
t('daysBetween', C.daysBetween('2026-11-05', '2026-11-06') === 1);
t('daysBetween weekend', C.daysBetween('2026-11-05', '2026-11-09') === 4);
t('daysBetween null', C.daysBetween(null, '2026-11-09') === null);
t('isRealDate ok', C.isRealDate('2026-11-09'));
t('isRealDate 2026-02-30', !C.isRealDate('2026-02-30'));
t('isRealDate format', !C.isRealDate('09/11/2026'));
t('isoMinusDays', C.isoMinusDays('2026-11-09', 8) === '2026-11-01');

// ─── parser swaoo (fixture réelle du 09/11/2026) ─────────────────────────────
const sw = C.parseSwaooPage(FIX('swaoo-page.html'));
t('swaoo : des achats trouvés', sw.buys.length > 0, sw.buys.length);
t('swaoo : numeros vus (toutes natures)', sw.numeros.length >= sw.buys.length, sw.numeros.length);
const rb = sw.buys.find(b => b.id === 'FR-2026DD1149199');
t('swaoo : ROCHE BOBOIS présente', !!rb);
if (rb) {
  t('swaoo : société', rb.societe === 'ROCHE BOBOIS SA', rb.societe);
  t('swaoo : nature Acquisition', rb.nature === 'Acquisition');
  t('swaoo : montant', rb.montant === 22020.04, rb.montant);
  t('swaoo : volume', rb.volume === 1400, rb.volume);
  t('swaoo : prix', rb.prix === 15.7286, rb.prix);
  t('swaoo : datePub', rb.datePub === '2026-11-06', rb.datePub);
  t('swaoo : dateOp', rb.dateOp === '2026-11-05', rb.dateOp);
  t('swaoo : auteur avec fonction', /Tamburi/.test(rb.auteur) && /Conseil de Surveillance/.test(rb.auteur), rb.auteur);
  t('swaoo : lien fiche BDIF', /Fiche-BDIF\?docId=/.test(rb.lienFiche || ''), rb.lienFiche);
  t('swaoo : lien PDF officiel', /back\/api\/v1\/documents\/.*\.pdf/.test(rb.lienPdf || ''), rb.lienPdf);
  t('swaoo : devise EUR', rb.devise === 'EUR');
}
t('swaoo : aucune nature hors achat', sw.buys.every(b => ['Acquisition', 'Souscription'].indexOf(b.nature) !== -1));
t('swaoo : ids uniques', new Set(sw.buys.map(b => b.id)).size === sw.buys.length);
t('swaoo : html null sans crash', C.parseSwaooPage(null).buys.length === 0);
t('swaoo : TOTALENERGIES (cession) absente des achats', !sw.buys.some(b => /TOTALENERGIES/.test(b.societe) && b.nature === 'Acquisition'));

// ─── parser RSS BDIF (fixture réelle du 09/11/2026) ──────────────────────────
const rss = C.parseBdifRss(FIX('bdif-dd.xml'));
t('rss : 100 items', rss.length === 100, rss.length);
t('rss : numero extrait', /^2026DD\d+$/.test(rss[0].numero), rss[0].numero);
t('rss : société', rss[0].societe.length > 0, rss[0].societe);
t('rss : date ISO', /^\d{4}-\d{2}-\d{2}$/.test(rss[0].datePub || ''), rss[0].datePub);
t('rss : lien fiche', /\/fr\/details\//.test(rss[0].lienFiche));
t('rss : xml null sans crash', C.parseBdifRss(null).length === 0);

// ─── orphelins RSS ────────────────────────────────────────────────────────────
const fakeRss = [
  { id: 'FR-2026DD1', numero: '2026DD1', societe: 'A', datePub: '2026-11-07', lienFiche: 'https://bdif.amf-france.org/fr/details/2026DD1' },
  { id: 'FR-2026DD2', numero: '2026DD2', societe: 'B', datePub: '2026-11-08', lienFiche: 'https://bdif.amf-france.org/fr/details/2026DD2' }
];
const orph = C.bdifNotInSwaoo(fakeRss, [], ['2026DD1']);
t('orphans : déduit par numero vu', orph.length === 1 && orph[0].id === 'FR-2026DD2');
t('orphans : déduit par id de buy', C.bdifNotInSwaoo([{ id: 'FR-2026DD2', numero: '2026DD2', societe: 'B', datePub: '2026-11-08', lienFiche: 'x' }], [{ id: 'FR-2026DD2', numero: '2026DD2' }], []).length === 0);
t('orphans : entrée à vérifier', orph[0].detail === false && orph[0].nature === null && orph[0].montant === null);

// ─── parser Form 4 (fixture synthétique : 1 vente S + 2 achats P) ────────────
const f4 = C.parseForm4Xml(FIX('form4.xml'));
t('form4 : ok', f4.ok);
t('form4 : owner', f4.ownerName === 'JANE DOE', f4.ownerName);
t('form4 : fonction', f4.officerTitle === 'Chief Executive Officer', f4.officerTitle);
t('form4 : issuer', f4.issuerName === 'EXAMPLE ENERGY, INC.', f4.issuerName);
t('form4 : ticker', f4.ticker === 'EXMP', f4.ticker);
t('form4 : 2 achats P (vente S ignorée)', f4.buys.length === 2, f4.buys.length);
t('form4 : code P partout', f4.buys.every(b => b.code === 'P'));
t('form4 : montant 10000×21.75', f4.buys[0].montant === 217500, f4.buys[0].montant);
t('form4 : montant sans prix -> null', f4.buys[1].montant === null);
t('form4 : date opération', f4.buys[0].date === '2026-11-05', f4.buys[0].date);
t('form4 : période', f4.periodOfReport === '2026-11-05', f4.periodOfReport);
t('form4 : xml null sans crash', C.parseForm4Xml(null).ok === false);

const e4 = C.form4ToEntry('0001234-26-000001', '0001463101', f4);
t('form4→entrée : id', e4.id === 'US-000123426000001', e4.id);
t('form4→entrée : montant somme partielle', e4.montant === 217500, e4.montant);
t('form4→entrée : volume 12000.5', e4.volume === 12000.5, e4.volume);
t('form4→entrée : auteur avec fonction', /JANE DOE — Chief Executive Officer/.test(e4.auteur), e4.auteur);
t('form4→entrée : nOps', e4.nOps === 2);
t('form4→entrée : sans achat -> null', C.form4ToEntry('x', 'y', { ok: true, buys: [] }) === null);

// ─── fusion / purge / nouveautés / stats ─────────────────────────────────────
const b1 = { id: 'FR-2026DD10', src: 'FR', societe: 'A', nature: 'Acquisition', montant: 5000, devise: 'EUR', datePub: '2026-11-08', dateOp: '2026-11-07', detail: true };
const b2 = { id: 'US-0001', src: 'US', societe: 'B', nature: 'Achat (code P)', montant: 12000, devise: 'USD', datePub: '2026-11-08', dateOp: '2026-11-07', detail: true };
const merged = C.mergeBuys([b1], [b2, b1], 45, '2026-11-09T10:00:00Z');
t('merge : pas de doublon', merged.length === 2, merged.length);
t('merge : tri datePub desc', merged[0].id === 'FR-2026DD10' || merged[0].datePub >= merged[1].datePub);
const old = { id: 'FR-2026DD1', src: 'FR', societe: 'OLD', montant: 1, devise: 'EUR', datePub: '2026-09-01', detail: true };
t('merge : purge > 45 j', C.mergeBuys([old], [], 45, '2026-11-09T10:00:00Z').length === 0);
t('merge : garde < 45 j', C.mergeBuys([b1], [], 45, '2026-11-09T10:00:00Z').length === 1);
const orphan = { id: 'FR-2026DD99', src: 'FR', societe: 'X', montant: null, devise: 'EUR', datePub: '2026-11-08', detail: false };
const detailed = { id: 'FR-2026DD99', src: 'FR', societe: 'X', nature: 'Acquisition', montant: 8000, devise: 'EUR', datePub: '2026-11-08', detail: true };
const m2 = C.mergeBuys([orphan], [detailed], 45, '2026-11-09T10:00:00Z');
t('merge : le détail remplace l orphelin', m2.length === 1 && m2[0].detail === true && m2[0].montant === 8000);
t('newSince : filtre', C.newSince([b1, b2], '2026-11-07').length === 2);
t('newSince : rien de nouveau', C.newSince([b1], '2026-11-08').length === 0);
t('isBig : 12 000 ≥ 10 000', C.isBig(b2) === true);
t('isBig : 5 000 < 10 000', C.isBig(b1) === false);
const st = C.statsOf([b1, b2, orphan]);
t('stats : total hors à-vérifier', st.total === 2, st.total);
t('stats : gros', st.gros === 1, st.gros);
t('stats : fr/us', st.fr === 1 && st.us === 1);
t('stats : à vérifier', st.aVerifier === 1, st.aVerifier);

// ─── index quotidien EDGAR (parseFormIdx) ─────────────────────────────────────
const idxTxt = FIX('form-idx.txt');
const idx = C.parseFormIdx(idxTxt);
t('parseFormIdx : 4 Form 4 retenus (4 + 4/A + noDash)', idx.length === 4, idx.length);
t('parseFormIdx : Apple dashed', idx[0].adsh === '0000320193-26-000123' && idx[0].ciks[0] === '320193');
t('parseFormIdx : 4/A accepté', idx[1].adsh === '0001493152-26-000456');
t('parseFormIdx : dashed 10-2-6', idx[2].adsh === '0000001067-26-000001', idx[2]);
t('parseFormIdx : 18 chiffres → dashed', idx[3].adsh === '0000950170-26-100456', idx[3]);
t('parseFormIdx : S-1 rejeté', !idx.some(f => f.names[0] === 'OTHER CORP'));
t('parseFormIdx : dateFiled', idx[0].fileDate === '2026-11-06');
t('parseFormIdx : sans accession ignoré', !idx.some(f => f.names[0] === 'EMPTY FILENAME INC'));
t('parseFormIdx : vide', C.parseFormIdx('').length === 0);
t('parseFormIdx : pas de pipes', C.parseFormIdx('pas de pipe ici').length === 0);

// ─── validation ──────────────────────────────────────────────────────────────
t('validate : ok', C.validateData({ buys: [b1, b2] }).length === 0);
t('validate : id dupliqué', C.validateData({ buys: [b1, { ...b1 }] }).length > 0);
t('validate : src invalide', C.validateData({ buys: [{ id: 'x', src: 'XX', societe: 'A', devise: 'EUR' }] }).length > 0);
t('validate : datePub invalide', C.validateData({ buys: [{ id: 'x', src: 'FR', societe: 'A', devise: 'EUR', datePub: '2026-02-30' }] }).length > 0);
t('validate : data.json vide accepté', C.validateData({ buys: [] }).length === 0);

// ─── cohérence avec le fichier réel (si data.json existe) ─────────────────────
const dp = path.join(__dirname, '..', 'data.json');
if (fs.existsSync(dp)) {
  const d = JSON.parse(fs.readFileSync(dp, 'utf8'));
  const errs = C.validateData(d);
  t('data.json : valide (' + d.buys.length + ' entrées)', errs.length === 0, errs.slice(0, 3));
}

console.log(`\n${pass} verts, ${fail} échecs`);
process.exit(fail ? 1 : 0);
