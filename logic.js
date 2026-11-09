// ─── Sentinelle perso — logique UI pure (testable Node, aucun accès DOM) ─────
'use strict';

var S_VERSION = 'v1';
var S_CACHE_KEY = 'sentinelle-perso-cache';     // dernier data.json reçu (hors ligne)
var S_LASTSEEN_KEY = 'sentinelle-perso-lastSeen'; // date de dernière visite (yyyy-mm-dd)
var S_BIG = 10000;

// échappement HTML systématique (les données viennent de sources externes)
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtMontant(n, devise) {
  if (n == null) return '—';
  var sym = devise === 'USD' ? '$' : '€';
  if (n >= 1000000) return sym + (n / 1000000).toFixed(n >= 10000000 ? 0 : 1) + ' M';
  if (n >= 1000) return sym + Math.round(n / 1000) + ' k';
  return sym + Math.round(n);
}

function fmtNombre(n) {
  if (n == null) return '—';
  return Math.round(n * 100) / 100;
}

function fmtDate(iso) {
  if (!iso) return '—';
  var p = String(iso).split('-');
  return p.length === 3 ? p[2] + '/' + p[1] : iso;
}

function delayJours(b) {
  if (!b.dateOp || !b.datePub) return null;
  var a = Date.parse(b.dateOp + 'T00:00:00Z');
  var c = Date.parse(b.datePub + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(c)) return null;
  return Math.round((c - a) / 86400000);
}

// filtre d'affichage
function filterBuys(buys, f, q, lastSeen) {
  var s = (q || '').toLowerCase();
  var out = (buys || []).filter(function (b) {
    if (b.detail === false) return false; // la section à-vérifier est à part
    if (f === 'fr' && b.src !== 'FR') return false;
    if (f === 'us' && b.src !== 'US') return false;
    if (f === 'gros' && !(b.montant != null && b.montant >= S_BIG)) return false;
    if (f === 'nouveaux') {
      var ref = b.datePub || b.dateOp;
      if (!ref || !lastSeen || ref <= lastSeen) return false;
    }
    if (s) {
      var hay = (b.societe + ' ' + (b.auteur || '') + ' ' + (b.ticker || '') + ' ' + (b.isin || '')).toLowerCase();
      if (hay.indexOf(s) === -1) return false;
    }
    return true;
  });
  return out;
}

// tri : datePub desc (fallback dateOp), puis montant desc
function sortBuys(buys) {
  return (buys || []).slice().sort(function (a, b) {
    var da = a.datePub || a.dateOp || '';
    var db = b.datePub || b.dateOp || '';
    if (db !== da) return db > da ? 1 : -1;
    return (b.montant || 0) - (a.montant || 0);
  });
}

function isBig(b) { return b.montant != null && b.montant >= S_BIG; }

function countNew(buys, lastSeen) {
  if (!lastSeen) return 0;
  return (buys || []).filter(function (b) {
    if (b.detail === false) return false;
    var ref = b.datePub || b.dateOp;
    return ref && ref > lastSeen;
  }).length;
}

function fmtScan(data, nowMs) {
  if (!data || !data.generatedAt) return { html: 'aucun scan pour l\u2019instant', fresh: false };
  var t = Date.parse(data.generatedAt);
  if (!Number.isFinite(t)) return { html: 'scan : ?', fresh: false };
  var min = Math.max(0, Math.round(((nowMs || Date.now()) - t) / 60000));
  var h = Math.floor(min / 60);
  var ago = h >= 24 ? Math.floor(h / 24) + ' j' : (h > 0 ? h + ' h' : min + ' min');
  var src = data.sources || {};
  function dot(name) {
    var st = src[name] || {};
    var cls = st.status === 'ok' ? 'ok' : 'err';
    return '<span class="dot ' + cls + '"></span>' + name;
  }
  var fresh = min <= 120;
  return {
    html: 'Scan il y a ' + ago + ' · ' + dot('fr') + ' ' + dot('us') +
      (fresh ? '' : ' <span class="dot stale"></span>données anciennes'),
    fresh: fresh
  };
}

// rendu HTML d'une carte achat (échappé)
function renderBuy(b) {
  var gros = isBig(b);
  var dj = delayJours(b);
  var meta = [];
  meta.push('<span class="tag ' + (b.src === 'FR' ? 'srcfr">🇫🇷 AMF' : 'srcus">🇺🇸 SEC') + '</span>');
  if (b.nature) meta.push('<span class="tag">' + esc(b.nature) + '</span>');
  if (b.dateOp) meta.push('<span class="tag">opéré le ' + fmtDate(b.dateOp) + '</span>');
  if (b.datePub) meta.push('<span class="tag">publié le ' + fmtDate(b.datePub) + '</span>');
  if (dj != null) meta.push('<span class="delay">publié ' + dj + ' j après l\u2019opération</span>');
  var val = [];
  if (b.volume != null) val.push(fmtNombre(b.volume) + ' titres');
  if (b.prix != null) val.push('@ ' + fmtNombre(b.prix) + (b.devise === 'USD' ? ' $' : ' €'));
  var links = [];
  if (b.lienPdf) links.push('<a href="' + esc(b.lienPdf) + '" target="_blank" rel="noopener">📄 Déclaration officielle</a>');
  if (b.lienFiche) links.push('<a href="' + esc(b.lienFiche) + '" target="_blank" rel="noopener">🔎 Fiche</a>');
  return '<div class="buy' + (gros ? ' gros' : '') + '">' +
    '<div class="top"><div><span class="soc">' + esc(b.societe) + '</span>' +
    (b.ticker ? '<span class="tk">' + esc(b.ticker) + '</span>' : '') +
    (gros ? '<span class="grosbadge">💰 gros achat</span>' : '') +
    '</div><div class="montant">' + fmtMontant(b.montant, b.devise) + '</div></div>' +
    (b.auteur ? '<div class="who">👤 <b>' + esc(b.auteur) + '</b></div>' : '') +
    (val.length ? '<div class="who" style="font-size:11.5px">' + val.join(' · ') + '</div>' : '') +
    '<div class="meta">' + meta.join('') + '</div>' +
    (links.length ? '<div class="links">' + links.join('') + '</div>' : '') +
    '</div>';
}

function renderAVerifier(items) {
  if (!items || !items.length) return '';
  var rows = items.map(function (b) {
    return '<div class="av"><span>' + esc(b.societe) + ' · publié le ' + fmtDate(b.datePub) +
      '</span><a href="' + esc(b.lienFiche || '') + '" target="_blank" rel="noopener">vérifier sur BDIF ↗</a></div>';
  }).join('');
  return '<div class="avhead" id="avHead"><span>❓ <b>' + items.length + '</b> déclarations AMF récentes non encore détaillées (à vérifier)</span><span>▾</span></div>' +
    '<div class="avlist" id="avList">' + rows + '</div>';
}

// ─── Exports ──────────────────────────────────────────────────────────────────
// Node (harnais) : module.exports · Navigateur : global window.Logic
// (pas de `return` top-level — leçon v5.3 du Radar : page blanche)
var S_API = {
  S_VERSION: S_VERSION, S_BIG: S_BIG,
  esc: esc, fmtMontant: fmtMontant, fmtNombre: fmtNombre, fmtDate: fmtDate,
  delayJours: delayJours, filterBuys: filterBuys, sortBuys: sortBuys,
  isBig: isBig, countNew: countNew, fmtScan: fmtScan,
  renderBuy: renderBuy, renderAVerifier: renderAVerifier
};
if (typeof module !== 'undefined' && module.exports) {
  module.exports = S_API;
} else if (typeof window !== 'undefined') {
  window.Logic = S_API;
}
