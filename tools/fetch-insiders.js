#!/usr/bin/env node
"use strict";
// Sentinelle perso — relevé automatique des achats ET ventes d'initiés (aucune dépendance, Node 18+)
//   FR : https://transactions-amf.swaoo.com/ (déclarations AMF, requête POST natures Acquisition+Cession)
//   US : SEC EDGAR full-text search (Form 4) + téléchargement des XML officiels (achats code P, ventes code S)
// Écrit data.json (affiché par la PWA : fr/us = achats, frS/usS = ventes) et state.json (accessions déjà traitées).
// Une panne de source ne casse jamais le run : on garde les données précédentes.

var fs = require("fs");
var RI = require("../logic.js");
var CFG = RI.CFG;

// La SEC exige un contact réel dans le User-Agent (format "Nom contact@domaine") ;
// surchargeable via la variable d'environnement RI_SEC_CONTACT (secret GitHub du même nom).
var UA = "SentinellePerso research " + (process.env.RI_SEC_CONTACT || "jeffbuzz060684@users.noreply.github.com");
var BUDGET = parseInt(process.env.RI_BUDGET || "", 10) || CFG.US_FETCH_BUDGET;

// injectable pour les tests (simuler 429/500 sans réseau)
var FETCH_IMPL = (typeof fetch === "function") ? fetch : null;
function setFetchForTests(f) { FETCH_IMPL = f; }

function log() { console.log.apply(console, arguments); }

function fetchText(url, opts, timeoutMs) {
  var t = timeoutMs || 30000;
  if (!FETCH_IMPL) return Promise.reject(new Error("fetch indisponible"));
  var timer = null;
  var p;
  try {
    var ac = new AbortController();
    timer = setTimeout(function () { ac.abort(); }, t);
    // fusion des en-têtes : les en-têtes par défaut (User-Agent) ne doivent jamais être écrasés
    var merged = Object.assign({
      "User-Agent": UA,
      "Accept": "*/*"
    }, (opts && opts.headers) || {});
    var init = Object.assign({}, opts || {}, { headers: merged, signal: ac.signal });
    p = FETCH_IMPL(url, init)
      .then(function (r) {
        if (!r.ok) {
          var err = new Error("HTTP " + r.status + " " + url);
          // 429/503 : respecter Retry-After si la SEC le renvoie
          if (r.status === 429 || r.status === 503) {
            var ra = r.headers && r.headers.get && r.headers.get("retry-after");
            if (ra && isFinite(ra)) err.retryAfterSec = Math.min(parseInt(ra, 10) || 5, 60);
          }
          throw err;
        }
        return r.text();
      });
  } catch (e) {
    return Promise.reject(e);
  }
  if (timer) p = p.finally ? p.finally(function () { clearTimeout(timer); }) : p;
  return p;
}

function retry(fn, tries) {
  var n = tries || 2;
  var attempt = function (i) {
    return fn().catch(function (e) {
      if (i >= n) throw e;
      var wait = e && e.retryAfterSec ? e.retryAfterSec * 1000 : 1500;
      return new Promise(function (res) { setTimeout(res, wait); }).then(function () { return attempt(i + 1); });
    });
  };
  return attempt(1);
}

function pad(n) { return (n < 10 ? "0" : "") + n; }

// ---------- FR : swaoo ----------
function frQuery(debut, fin, page) {
  var body = "f_nature%5B%5D=Acquisition&f_nature%5B%5D=Cession" +
    "&f_date_publication_debut=" + encodeURIComponent(debut) +
    "&f_date_publication_fin=" + encodeURIComponent(fin) +
    "&f_montant_min=" + CFG.FR_MIN_EUR +
    "&f_page=" + page;
  return fetchText("https://transactions-amf.swaoo.com/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body
  }, 40000);
}

function fetchFr(now) {
  var debut = RI.frDate(new Date(now - CFG.FR_DAYS * 86400000));
  var fin = RI.frDate(new Date(now));
  var rows = [];
  var seen = {};
  var page = 1;
  var rawTotal = 0;
  // la page peut contenir toutes natures (le filtre serveur n'est pas garanti) :
  // on pagine tant qu'il y a des lignes brutes, le filtre buy/sell se fait dans parseSwaoo.
  var run = function () {
    return retry(function () { return frQuery(debut, fin, page); }).then(function (html) {
      var raw = (html.match(/Déclaration n°/g) || []).length; // lignes toutes natures
      rawTotal += raw;
      var parsed = RI.parseSwaoo(html);
      for (var i = 0; i < parsed.length; i++) {
        if (!seen[parsed[i].id]) { seen[parsed[i].id] = 1; rows.push(parsed[i]); }
      }
      if (RI.frNextPage(raw, page)) { page++; return run(); }
      return null;
    });
  };
  return run().then(function () {
    // re-vérification locale du montant (le filtre serveur suffit, mais on ne fait confiance qu'aux données parsées)
    var kept = rows.filter(function (r) { return r.montant >= CFG.FR_MIN_EUR; });
    // canari du scraper : la page contenait des déclarations brutes mais AUCUNE n'est reconnue
    // → le HTML de swaoo a probablement changé → on échoue le run FR (données précédentes conservées)
    if (kept.length === 0 && rawTotal > 0) {
      throw new Error("CANARI swaoo : " + rawTotal + " déclarations brutes vues, 0 ligne parsée — structure HTML changée ?");
    }
    return kept;
  });
}

// entries "accession|YYYY-MM-DD" ; les anciennes entrées sans date héritent de la date du jour
// (elles sortiront de la fenêtre STATE_DAYS) — purge par date, plus par plafond arbitraire
function purgeProcessed(list, nowMs, keepDays) {
  var today = RI.isoDay(new Date(nowMs));
  var min = RI.isoDay(new Date(nowMs - (keepDays || CFG.STATE_DAYS) * 86400000));
  var out = [];
  for (var i = 0; i < (list || []).length; i++) {
    var e = String(list[i] || "");
    var j = e.indexOf("|");
    out.push(j > 0 ? e : e + "|" + today);
  }
  return out.filter(function (e) { return e.slice(e.indexOf("|") + 1) >= min; });
}

// ---------- US : EDGAR ----------
function ftsQuery(startdt, enddt, from) {
  var url = "https://efts.sec.gov/LATEST/search-index?q=a&forms=4" +
    "&dateRange=custom&startdt=" + startdt + "&enddt=" + enddt +
    "&from=" + from + "&size=100";
  return fetchText(url, null, 30000).then(function (txt) { return RI.parseFts(txt); });
}

// ---------- v3.2 : pistes d'étude — fondamentaux via les comptes annuels 10-K (XBRL SEC) ----------
// Sources officielles, sans clé : https://www.sec.gov/files/company_tickers.json (ticker → CIK)
// et https://data.sec.gov/api/xbrl/companyconcept/CIK…/us-gaap/<tag>.json (série annuelle 10-K).
// Les sociétés n'utilisent pas toutes le même tag de revenus → on essaie les plus courants.
var REV_TAGS = ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues",
  "RevenueFromContractWithCustomerIncludingAssessedTax", "SalesRevenueNet", "SalesRevenueGoodsNet"];
var NI_TAG = "NetIncomeLoss";

function conceptUrl(cik, tag) {
  return "https://data.sec.gov/api/xbrl/companyconcept/CIK" +
    String(cik).replace(/\D/g, "").padStart(10, "0") + "/us-gaap/" + tag + ".json";
}
var sleepMs = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

function fetchTickerMap() {
  return fetchText("https://www.sec.gov/files/company_tickers.json", null, 30000).then(function (txt) {
    var j = JSON.parse(txt);
    var m = {};
    for (var k in j) {
      if (Object.prototype.hasOwnProperty.call(j, k) && j[k] && j[k].ticker) {
        m[String(j[k].ticker).toUpperCase()] = j[k].cik_str;
      }
    }
    return m;
  });
}
// une seule tentative par tag : un 404 (tag non utilisé par la société) est une réponse normale
function tryRevTags(cik, i) {
  if (i >= REV_TAGS.length) return Promise.resolve(null);
  return fetchText(conceptUrl(cik, REV_TAGS[i]), null, 25000).then(function (txt) {
    var a = RI.xbrlAnnuals(JSON.parse(txt));
    return a.length > 0 ? a : tryRevTags(cik, i + 1);
  }, function () { return tryRevTags(cik, i + 1); });
}
function fetchFundamentals(cands, log) {
  return fetchTickerMap().then(function (map) {
    var funds = {};
    var chain = Promise.resolve();
    cands.forEach(function (c) {
      chain = chain.then(function () {
        var tk = String(c.ticker || "").toUpperCase();
        var cik = map[tk];
        if (!cik) { log("PICKS : " + c.ticker + " absent du registre SEC — ignoré"); return sleepMs(60); }
        return tryRevTags(cik, 0).then(function (revA) {
          if (!revA) return null;
          return fetchText(conceptUrl(cik, NI_TAG), null, 25000).then(function (txt) {
            return RI.fundFromXbrl(revA, RI.xbrlAnnuals(JSON.parse(txt)));
          }, function () {
            return RI.fundFromXbrl(revA, []); // résultat net indisponible → marge inconnue, pas bloquant
          });
        }).then(function (f) {
          if (f) funds[tk] = f;
          else log("PICKS : pas de 10-K exploitable pour " + c.ticker);
          return sleepMs(120);
        });
      });
    });
    return chain.then(function () { return funds; });
  });
}
function computePicks(data, log) {
  var since = RI.isoDay(new Date(Date.now() - CFG.SIGN_DAYS * 86400000));
  // v3.3 : pistes FR — signal initiés nettoyé seul (/10), pas d'équivalent public gratuit du 10-K
  var frPicks = RI.picksFromFr(data.fr, data.frS, { since: since, max: 5 });
  var cands = RI.pickCandidates(data.us, data.usS, 15, { since: since });
  if (cands.length === 0 && frPicks.length === 0) {
    log("PICKS : aucun cluster nettoyé (FR ou US) sur la fenêtre " + CFG.SIGN_DAYS + " j — pistes vidées (honnête)");
    data.picks = { updated: new Date(Date.now()).toISOString(), us: [], fr: [] };
    return Promise.resolve(null);
  }
  log("PICKS : " + cands.length + " candidate(s) US + " + frPicks.length + " piste(s) FR — consultation des comptes 10-K…");
  if (cands.length === 0) {
    data.picks = { updated: new Date(Date.now()).toISOString(), us: [], fr: frPicks };
    log("PICKS : 0 piste US, " + frPicks.length + " piste(s) FR écrite(s)");
    return Promise.resolve(null);
  }
  return fetchFundamentals(cands, log).then(function (funds) {
    if (Object.keys(funds).length === 0) {
      throw new Error("aucun fondamental récupéré — XBRL indisponible ?");
    }
    var picks = RI.picksFrom(data.us, data.usS, funds, { max: 6, since: since });
    data.picks = { updated: new Date(Date.now()).toISOString(), us: picks, fr: frPicks };
    log("PICKS : " + picks.length + " piste(s) US écrite(s)" +
      (picks.length > 0 ? " — n°1 : " + picks[0].ticker + " " + picks[0].score + "/20" : "") +
      " + " + frPicks.length + " FR (clusters sans 10-K exploitable exclus, honnêtement)");
  });
}

function fetchUs(now, state, prevBuys, prevSells) {
  var startdt = RI.isoDay(new Date(now - 3 * 86400000)); // fenêtre 3 jours, la dédup fait le reste
  var enddt = RI.isoDay(new Date(now));
  var today = RI.isoDay(new Date(now));
  var processed = {}; // accession -> date de PREMIÈRE réussite
  // v4 : migration de la dette v3.1.1 — les anciennes lignes US ont des ids à 5 segments
  // (sans prix) et aucun tag plan 10b5-1/levée. Les ventes < 50 k$ ne sont plus collectées ;
  // les lignes à ancien id de la fenêtre 3 j vont être re-téléchargées avec le nouveau format
  // (id complet + tags) : on supprime leurs anciennes lignes pour éviter les doublons.
  // Les plus vieilles ne seront jamais re-vues (la fenêtre glisse) et expirent avec KEEP_DAYS.
  if (state.v !== 4) {
    log("US : migration v4 (ids complets + tags plan/levée + ventes ≥ 50 k$) — fenêtre 3 j re-téléchargée");
    var isOldId = function (r) { return r && r.id && String(r.id).split("|").length <= 6; };
    var inWin = function (r) { return r && String(r.datePub || "").slice(0, 10) >= startdt; };
    prevBuys = (prevBuys || []).filter(function (r) { return !(isOldId(r) && inWin(r)); });
    prevSells = (prevSells || []).filter(function (r) {
      if (isOldId(r) && inWin(r)) return false; // re-téléchargée ce run avec le bon id
      return !((r.montant || 0) < CFG.US_SELL_MIN_USD); // v3.3 : ventes US < 50 k$ purgées
    });
    state.processedUs = [];
    state.v = 4;
  }
  // purge par date (STATE_DAYS) ; v3.3 : chaque entrée garde SA date d'origine —
  // le bug v3.1.1 redatait toutes les accessions à chaque run, donc la purge ne purgeait rien
  var stored = purgeProcessed(state.processedUs || [], now, CFG.STATE_DAYS);
  var pkey = function (e) { var j = e.indexOf("|"); return j > 0 ? e.slice(0, j) : e; };
  var pdate = function (e) { var j = e.indexOf("|"); return j > 0 ? e.slice(j + 1) : today; };
  stored.forEach(function (e) { processed[pkey(e)] = pdate(e); });
  var hits = [];
  var capped = false;
  var run = function (from) {
    return retry(function () { return ftsQuery(startdt, enddt, from); }).then(function (batch) {
      for (var i = 0; i < batch.length; i++) hits.push(batch[i]);
      if (batch.length === 100 && from < 500) return run(from + 100); // plafond 600 hits par run
      if (batch.length === 100) capped = true; // fenêtre 3 j non couverte en entier
      return null;
    });
  };
  var buys = (prevBuys || []).slice();
  var sells = (prevSells || []).slice();
  var done = 0, skipped = 0, fetched = 0, errors = 0, nBuys = 0, nSells = 0;
  var consecutive = 0, broken = false; // disjoncteur : une panne SEC totale ne doit pas boucler 400 fois
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  return run(0).then(function () {
    if (capped) log("US : PLAFOND 600 hits atteint — couverture partielle de la fenêtre 3 j (roadmap : curseur persistant)");
    var todo = [];
    for (var i = 0; i < hits.length; i++) {
      var h = hits[i];
      if (!h.accession || processed[h.accession]) { skipped++; continue; }
      todo.push(h);
    }
    todo = todo.slice(0, BUDGET);
    if (todo.length === hits.length && hits.length >= BUDGET) log("US : budget " + BUDGET + " atteint — le reste sera vu au run suivant");
    var chain = Promise.resolve();
    todo.forEach(function (h) {
      chain = chain.then(function () {
        if (broken) return null; // disjoncteur ouvert : on n'insiste pas, retenté au run suivant
        var url = RI.form4Url(h.cik, h.accession, h.file);
        // v3.3 : retry(fn, 2) — le Retry-After de la SEC est désormais honoré aussi sur les XML
        return retry(function () { return fetchText(url, null, 25000); }, 2)
          .then(function (xml) {
            // v3.3 : une réponse 200 qui n'est PAS un Form 4 (page HTML de limitation, XML
            // tronqué) n'est pas un succès — sinon l'accession était perdue à jamais
            if (xml.indexOf("<ownershipDocument") === -1) {
              throw new Error("réponse 200 sans <ownershipDocument> — pas un Form 4");
            }
            fetched++;
            consecutive = 0;
            var f4 = RI.parseForm4(xml);
            var rows = RI.usRowsFrom(Object.assign({}, h, { url: url }), f4);
            rows.forEach(function (r) {
              if (r.side === "sell") { sells.push(r); nSells++; }
              else { buys.push(r); nBuys++; }
            });
            // marquée traitée UNIQUEMENT si téléchargée et parsée : un 429/503/500 de la SEC
            // ne fait plus perdre le dépôt — il sera retéléchargé au run suivant.
            // La date conservée est celle du PREMIER succès (v3.3), pas celle du run courant.
            processed[h.accession] = today;
          })
          .catch(function () { // un XML inaccessible ou invalide n'arrête jamais le run, et n'est PAS marqué
            errors++;
            consecutive++;
            if (consecutive >= 5) {
              broken = true;
              log("US : DISJONCTEUR — 5 erreurs XML consécutives, le reste du run est abandonné (retenté au prochain)");
            }
          })
          .then(function () {
            done++;
            if (done % 20 === 0) log("US " + done + "/" + todo.length);
            return sleep(CFG.US_RL_MS);
          });
      });
    });
    return chain.then(function () {
      if (broken) log("US : " + (todo.length - done) + " XML non tentés (disjoncteur)");
      if (errors > 0) log("US : " + errors + " XML en erreur — NON marqués traités, retentés au prochain run");
      // canari du parseur US : des XML téléchargés mais zéro ligne extraite → structure changée ?
      var canary = (fetched > 100 && nBuys + nSells === 0);
      if (canary) log("US : CANARI — " + fetched + " XML téléchargés, 0 ligne extraite (achats comme ventes) — parseur cassé ?");
      // v3.3 : une panne SEC massive ne passe plus pour un succès — ratio d'échec sur les
      // XML réellement tentés (au-delà de ~30 %, la source est marquée KO côté main)
      var attempted = fetched + errors;
      var errRatio = attempted > 0 ? errors / attempted : 0;
      if (attempted >= 5 && errRatio > 0.3) {
        log("US : " + Math.round(errRatio * 100) + " % des XML tentés en erreur — source marquée KO (usOk=false)");
      }
      var list = Object.keys(processed).map(function (a) { return a + "|" + processed[a]; });
      state.processedUs = purgeProcessed(list, now, CFG.STATE_DAYS);
      return { buys: buys, sells: sells, nBuys: nBuys, nSells: nSells, hits: hits.length,
        fetched: fetched, skipped: skipped, errors: errors, capped: capped, canary: canary,
        errRatio: errRatio, attempted: attempted };
    });
  });
}

// ---------- v3.3 : garde anti-effondrement, SÉPARÉE de la rétention ----------
// La v3.1.1 comparait prev (90 j) et next (90 j purgé) : après une longue interruption,
// l'expiration naturelle des vieilles lignes ressemblait à une panne et faisait conserver
// des données périmées. On ne compare désormais que les lignes précédentes ENCORE DANS la
// fenêtre de conservation : si elles disparaissent, c'est une vraie panne.
function collapseGuard(prev, next, what, nowMs, logFn) {
  var cutoff = RI.isoDay(new Date(nowMs - CFG.KEEP_DAYS * 86400000));
  var fresh = (prev || []).filter(function (r) {
    return r && String(r.datePub || "").slice(0, 10) >= cutoff;
  });
  if (fresh.length >= 20 && (next || []).length < fresh.length * 0.5) {
    (logFn || log)("CRITIQUE " + what + " : " + fresh.length + " → " + next.length + " lignes (-" +
      Math.round(100 - (100 * (next || []).length) / fresh.length) + " %) — version précédente conservée");
    return { keep: true, rows: prev };
  }
  return { keep: false, rows: next };
}

// ---------- v3.3 : notifications — la sentinelle prévient, pas seulement affiche ----------
// Diff avant/après du run. Alerte si : (1) un NOUVEAU cluster nettoyé 🔥🔥 apparaît
// (≥ 2 initiés DISTINCTS — personnes physiques, véhicules regroupés — sur 30 j) ;
// (2) un achat ≥ 100 k (€ ou $) par un dirigeant/administrateur (pas un fonds 10 %).
// La comparaison utilise des clés NATURELLES (société|auteur|date|volume|prix), pas les ids
// techniques : la migration v4 (nouveaux ids) ne re-notifie pas les anciennes lignes.
function computeAlerts(prevData, newData, logFn) {
  var since = RI.isoDay(new Date(Date.now() - CFG.SIGN_DAYS * 86400000));
  var allPrev = (((prevData || {}).fr) || []).concat(((prevData || {}).us) || []);
  var allNew = ((newData || {}).fr || []).concat(((newData || {}).us) || []);
  if (allPrev.length === 0) return []; // tout premier run : pas de spam, rien de comparable
  var before = {};
  RI.signalsFrom(RI.pickBuyRows(allPrev), { since: since }).forEach(function (s) {
    if (s.level >= 3) before[s.key] = s;
  });
  var msgs = [];
  RI.signalsFrom(RI.pickBuyRows(allNew), { since: since }).forEach(function (s) {
    if (s.level >= 3 && !before[s.key]) {
      msgs.push((s.source === "US" ? "🇺🇸 [" + s.ticker + "] " : "🇫🇷 ") + s.societe +
        " : NOUVEAU cluster 🔥🔥 — " + s.buys + " achats, " + s.buyers + " initié(s) distinct(s), total " +
        (s.source === "US" ? RI.fmtUSD(s.total) : RI.fmtEUR(s.total)) + " sur 30 j");
    }
  });
  var seen = {};
  var natKey = function (r) {
    return (r.source || "") + "|" + (r.societe || "") + "|" + (r.auteur || "") + "|" +
      (r.dateOp || "") + "|" + (r.volume || "") + "|" + (r.prix || "");
  };
  allPrev.forEach(function (r) { seen[natKey(r)] = 1; });
  allNew.forEach(function (r) {
    if (!r || r.side !== "buy" || (r.montant || 0) < 100000) return;
    var role = String(r.role || "");
    // fonds / propriétaires 10 % : pas un dirigeant — le signal « gros achat » ne compte pas
    if (!role || /10\s*%|propri[ée]taire/i.test(role)) return;
    if (seen[natKey(r)]) return;
    msgs.push((r.source === "US" ? "🇺🇸 [" + (r.ticker || "") + "] " : "🇫🇷 ") + r.societe + " : " +
      RI.fmtMontant(r) + " achetés par " + r.auteur + " (" + role + ")");
  });
  return msgs;
}
// ntfy.sh : topic en secret GitHub (NTFYY topic = canal privé, le dépôt est public).
// N'importe quel client ntfy peut s'abonner : https://ntfy.sh/<ton-topic>.
function notifyNtfy(topic, msgs) {
  if (!topic || !msgs || msgs.length === 0 || !FETCH_IMPL) return Promise.resolve(0);
  var body = msgs.slice(0, 5).join("\n\n") + (msgs.length > 5 ? "\n\n… +" + (msgs.length - 5) + " autre(s)" : "");
  return FETCH_IMPL("https://ntfy.sh/" + encodeURIComponent(topic), {
    method: "POST",
    headers: { "Title": "Sentinelle perso", "Priority": "high", "Tags": "chart_with_upwards_trend" },
    body: body
  }).then(function () { return msgs.length; }, function () { return 0; }); // jamais faire échouer le run
}

// ---------- main ----------
function readJsonOrDie(path, fallback) {
  if (!fs.existsSync(path)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (e) {
    // v3.3 : un data.json/state.json corrompu doit FAIRE ÉCHOUER le run — sinon des tableaux
    // vides par défaut remplaçaient silencieusement les données précédentes
    throw new Error(path + " présent mais illisible — run arrêté pour ne rien écraser : " + e.message);
  }
}
function main() {
  var now = Date.now();
  var data = readJsonOrDie("data.json", { fr: [], us: [], frS: [], usS: [] });
  var state = readJsonOrDie("state.json", { processedUs: [] });
  if (!Array.isArray(data.fr)) data.fr = [];
  if (!Array.isArray(data.us)) data.us = [];
  if (!Array.isArray(data.frS)) data.frS = [];
  if (!Array.isArray(data.usS)) data.usS = [];
  if (!state.processedUs) state.processedUs = [];
  var frOk = true, usOk = true;
  var usNew = 0, frNew = 0; // lignes nouvelles ce run → recalcul des pistes si besoin
  var prevFr = data.fr.slice(), prevFrS = data.frS.slice(), prevUs = data.us.slice(), prevUsS = data.usS.slice();
  var prevSnapshot = { fr: prevFr, us: prevUs, frS: prevFrS, usS: prevUsS }; // pour les alertes

  log("== Sentinelle perso v" + RI.VERSION + " — relevé du " + new Date(now).toISOString() + " ==");
  return fetchFr(now).then(function (frRows) {
    var frBuys = RI.rowsOfSide(frRows, "buy");
    var frSells = RI.rowsOfSide(frRows, "sell");
    log("FR : " + frBuys.length + " acquisitions + " + frSells.length + " cessions sur la fenêtre de " + CFG.FR_DAYS + " j");
    var mB = RI.mergeRows(prevFr, frBuys, CFG.KEEP_DAYS, CFG.MAX_ROWS, now);
    var mS = RI.mergeRows(prevFrS, frSells, CFG.KEEP_DAYS, CFG.MAX_ROWS, now);
    var gB = collapseGuard(prevFr, mB, "FR achats", now, log);
    var gS = collapseGuard(prevFrS, mS, "FR ventes", now, log);
    if (gB.keep || gS.keep) frOk = false;
    data.fr = gB.rows;
    data.frS = gS.rows;
    // v3.3 : frUpdated n'est rafraîchi QUE si le relevé a réussi ET que les nouvelles lignes
    // ont été retenues (avant : la garde conservait les anciennes lignes mais rafraîchissait l'horodatage)
    if (frOk && !gB.keep && !gS.keep) data.frUpdated = new Date(Date.now()).toISOString();
    var prevIds = {};
    prevFr.concat(prevFrS).forEach(function (r) { prevIds[r.id] = 1; });
    frNew = data.fr.concat(data.frS).filter(function (r) { return !prevIds[r.id]; }).length;
    log("FR total consolidé : " + data.fr.length + " achats + " + data.frS.length + " cessions");
  }).catch(function (e) {
    frOk = false;
    log("FR : ECHEC source (" + e.message + ") — données précédentes conservées");
  }).then(function () {
    return fetchUs(now, state, data.us, data.usS);
  }).then(function (usRes) {
    var mB = RI.mergeRows(usRes.buys, [], CFG.KEEP_DAYS, CFG.MAX_ROWS, now);
    var mS = RI.mergeRows(usRes.sells, [], CFG.KEEP_DAYS, CFG.MAX_ROWS, now);
    var gB = collapseGuard(prevUs, mB, "US achats", now, log);
    var gS = collapseGuard(prevUsS, mS, "US ventes", now, log);
    // v3.3 : une panne SEC partielle/massive ne passe plus pour un succès
    if (usRes.attempted >= 5 && usRes.errRatio > 0.3) usOk = false;
    // canari parseur US : garder la version précédente plutôt que vider les listes
    if (usRes.canary && (prevUs.length > 0 || prevUsS.length > 0)) {
      usOk = false;
      log("US : canari parseur — listes précédentes conservées");
      data.us = prevUs;
      data.usS = prevUsS;
    } else {
      if (gB.keep || gS.keep) usOk = false;
      data.us = gB.rows;
      data.usS = gS.rows;
      if (usOk) data.usUpdated = new Date(Date.now()).toISOString();
    }
    log("US : " + usRes.hits + " Form 4 vus, " + usRes.fetched + " XML téléchargés, " +
      usRes.skipped + " déjà traités, " + usRes.errors + " erreurs (retentées)" +
      (usRes.attempted >= 5 && usRes.errRatio > 0.3 ? " [" + Math.round(usRes.errRatio * 100) + " % KO → usOk=false]" : "") +
      ", " + usRes.nBuys + " achats + " + usRes.nSells + " ventes (dures ≥ " + CFG.US_SELL_MIN_USD + " $) extraits" +
      (usRes.capped ? " [PLAFOND]" : ""));
    log("US total consolidé : " + data.us.length + " achats + " + data.usS.length + " ventes");
    usNew = usRes.nBuys + usRes.nSells;
  }).catch(function (e) {
    usOk = false;
    log("US : ECHEC source (" + e.message + ") — données précédentes conservées");
  }).then(function () {
    // pistes : recalculées si une liste a bougé ce run, sinon une fois par jour
    var today = RI.isoDay(new Date(now));
    var hasPicks = data.picks && (data.picks.us || data.picks.picks);
    if (hasPicks && state.picksDay === today && usNew === 0 && frNew === 0) {
      log("PICKS : listes FR/US inchangées et pistes déjà calculées aujourd'hui — pas de recalcul");
      return null;
    }
    return computePicks(data, log).then(function () { state.picksDay = today; });
  }).catch(function (e) {
    log("PICKS : échec (" + e.message + ") — pistes précédentes conservées");
  }).then(function () {
    // sentinelle : notifier les vraies nouveautés (clusters nets, gros achats de dirigeants)
    var alerts = [];
    try {
      alerts = computeAlerts(prevSnapshot, data, log);
    } catch (e) {
      log("ALERTES : échec du calcul (" + e.message + ") — run non impacté");
    }
    if (alerts.length === 0) return null;
    var topic = String(process.env.NTFY_TOPIC || "").trim();
    if (!topic) {
      log("ALERTES : " + alerts.length + " nouvelle(s) — NTFY_TOPIC non défini (secret GitHub), pas d'envoi");
      return null;
    }
    return notifyNtfy(topic, alerts).then(function (n) {
      log("ALERTES : " + n + "/" + alerts.length + " notification(s) envoyée(s) via ntfy");
    });
  }).then(function () {
    data.updated = new Date(Date.now()).toISOString();
    data.frOk = frOk;
    data.usOk = usOk;
    data.counts = { fr: data.fr.length, us: data.us.length, frS: data.frS.length, usS: data.usS.length };
    var out = JSON.stringify(data, null, 1);
    fs.writeFileSync("data.json", out);
    fs.writeFileSync("state.json", JSON.stringify(state));
    log("data.json écrit : " + data.fr.length + " achats FR + " + data.us.length + " achats US + " +
      data.frS.length + " ventes FR + " + data.usS.length + " ventes US" +
      (frOk && usOk ? "" : " [échec source : " + (frOk ? "US" : (usOk ? "FR" : "FR+US")) + "]"));
    log("Fréquence : toutes les 2 h en jours ouvrés + 02:07 UTC mar-sam (workflow insiders.yml)");
  });
}

if (require.main === module) {
  main().then(function () { process.exit(0); }).catch(function (e) {
    console.error("ERREUR FATALE", e);
    process.exit(1);
  });
}

module.exports = { fetchFr: fetchFr, fetchUs: fetchUs, main: main, UA: UA, setFetchForTests: setFetchForTests,
  purgeProcessed: purgeProcessed, computePicks: computePicks, fetchFundamentals: fetchFundamentals,
  collapseGuard: collapseGuard, computeAlerts: computeAlerts, notifyNtfy: notifyNtfy };
