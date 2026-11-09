// ─── Sentinelle perso — bootstrap UI (appelle logic.js, gère data.json) ─────
'use strict';
(function () {

  var state = { data: null, filter: 'tous', q: '' };

  var els = {
    scanLine: document.getElementById('scanLine'),
    newBanner: document.getElementById('newBanner'),
    stats: document.getElementById('stats'),
    list: document.getElementById('list'),
    aVerifier: document.getElementById('aVerifier'),
    search: document.getElementById('search'),
    refresh: document.getElementById('refreshBtn')
  };

  function lastSeen() {
    try { return localStorage.getItem('sentinelle-perso-lastSeen') || null; }
    catch (e) { return null; }
  }
  function setLastSeen(d) {
    try { localStorage.setItem('sentinelle-perso-lastSeen', d); } catch (e) {}
  }
  function cacheData(d) {
    try { localStorage.setItem('sentinelle-perso-cache', JSON.stringify(d)); } catch (e) {}
  }
  function cachedData() {
    try { return JSON.parse(localStorage.getItem('sentinelle-perso-cache') || 'null'); }
    catch (e) { return null; }
  }

  function todayLocal() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function render() {
    var d = state.data;
    var buys = (d && d.buys) || [];
    var ls = lastSeen();
    var nNew = Logic.countNew(buys, ls);

    // bandeau nouveautés (compté sur la visite précédente, puis mis à jour)
    if (nNew > 0) {
      els.newBanner.classList.remove('hidden');
      els.newBanner.innerHTML = '🆕 <b>' + nNew + '</b> nouveau' + (nNew > 1 ? 'x' : '') +
        ' achat' + (nNew > 1 ? 's' : '') + ' d\u2019initié' + (nNew > 1 ? 's' : '') +
        ' depuis ta dernière visite — filtre « 🆕 Nouveaux » pour les voir.';
    } else {
      els.newBanner.classList.add('hidden');
    }

    // stats
    var achats = buys.filter(function (b) { return b.detail !== false; });
    var gros = achats.filter(Logic.isBig).length;
    var fr = achats.filter(function (b) { return b.src === 'FR'; }).length;
    var us = achats.filter(function (b) { return b.src === 'US'; }).length;
    var av = buys.length - achats.length;
    els.stats.innerHTML =
      '<div class="stat"><div class="v">' + achats.length + '</div><div class="l">achats</div></div>' +
      '<div class="stat"><div class="v" style="color:var(--gold)">' + gros + '</div><div class="l">≥ 10 k</div></div>' +
      '<div class="stat"><div class="v">' + fr + '</div><div class="l">🇫🇷 AMF</div></div>' +
      '<div class="stat"><div class="v">' + us + '</div><div class="l">🇺🇸 SEC</div></div>' +
      (av ? '<div class="stat"><div class="v" style="color:var(--mut)">' + av + '</div><div class="l">à vérifier</div></div>' : '');

    // liste principale
    var filtered = Logic.sortBuys(Logic.filterBuys(buys, state.filter, state.q, ls));
    els.list.innerHTML = filtered.length
      ? filtered.map(Logic.renderBuy).join('')
      : '<div class="empty">Aucun achat pour ce filtre' + (state.q ? ' (« ' + Logic.esc(state.q) + ' »)' : '') + '.</div>';

    // à vérifier (déclarations RSS non détaillées)
    var avItems = buys.filter(function (b) { return b.detail === false; });
    els.aVerifier.innerHTML = Logic.renderAVerifier(avItems);
    var head = document.getElementById('avHead');
    if (head) head.addEventListener('click', function () {
      var l = document.getElementById('avList');
      if (l) l.classList.toggle('open');
    });

    // ligne de scan (contenu 100 % interne à fmtScan — injection sûre)
    var s = Logic.fmtScan(d, Date.now());
    els.scanLine.innerHTML = s.html;
  }

  function applyData(d, firstLoad) {
    if (!d || !Array.isArray(d.buys)) return;
    var prev = lastSeen();
    state.data = d;
    render();
    if (firstLoad) {
      // le bandeau « nouveaux » a été calculé sur l'ancienne valeur → on marque
      // la visite APRÈS le premier rendu (prochaine visite comparera à aujourd'hui)
      setLastSeen(todayLocal());
    }
    cacheData(d);
  }

  async function loadData(firstLoad) {
    els.refresh.classList.add('spin');
    try {
      var r = await fetch('data.json?v=' + Date.now(), { cache: 'no-store' });
      if (r.ok) {
        var d = await r.json();
        applyData(d, firstLoad);
      } else if (firstLoad) {
        throw new Error('HTTP ' + r.status);
      }
    } catch (e) {
      if (firstLoad) {
        var c = cachedData();
        if (c) { state.data = c; render(); }
        else els.list.innerHTML = '<div class="empty">Impossible de charger data.json.</div>';
      }
    } finally {
      els.refresh.classList.remove('spin');
    }
  }

  // filtres
  document.querySelectorAll('.chip').forEach(function (chip) {
    chip.addEventListener('click', function () {
      document.querySelectorAll('.chip').forEach(function (c) { c.classList.remove('on'); });
      chip.classList.add('on');
      state.filter = chip.getAttribute('data-f');
      render();
    });
  });

  els.search.addEventListener('input', function () {
    state.q = els.search.value.trim();
    render();
  });

  els.refresh.addEventListener('click', function () { loadData(false); });

  // re-scan au retour sur l'app (PWA laissée ouverte)
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') loadData(false);
  });

  loadData(true);
})();
