// Sentinelle perso — logique pure partagée (app navigateur + pipeline GitHub Actions + harnais de tests)
// Ce fichier s'exécute en script navigateur classique ET en module Node (aucun return top-level).
var RI = (function () {
  "use strict";

  // ---------- configuration du pipeline ----------
  var VERSION = "5.0.0";   // version unique de l'app (badge + footer la lisent) — v5.0.0 : app monovue 🇫🇷 CAC 40 (demande de Jade 10/11/2026 : « une seule et même application ») : les onglets initiés/SBF 120 cèdent la place au classement d'achat seul, design tableau compact + détail au tap identique au Radar ; le moteur (qualité 40 % + valorisation 25 % + consensus 35 %, percentiles SBF, filtre cac40, macroState) est inchangé ; v4.1.0 : classement + surprises EPS/prochaine publication + bandeau macro + indice CAC 40 dédié ; composition automatique (groupe cac40 de sbf120.json)
  var CFG = {
    FR_MIN_EUR: 1000,      // montant min des acquisitions FR (filtre côté service + re-vérifié ici)
    US_MIN_USD: 1000,      // montant min des achats US (filtre local)
    US_SELL_MIN_USD: 50000, // v3.3 : montant min des VENTES US collectées — les petites ventes noient
                            // les listes (plafond 600) et ne sont pas des signaux
    FR_DAYS: 10,           // fenêtre de requête FR (jours de publication)
    SIGN_DAYS: 30,          // v3.3 : fenêtre des cartes signal (90 j = bruit ; 30 j = conviction récente)
    KEEP_DAYS: 90,          // conservation des lignes dans data.json
    MAX_ROWS: 600,          // max lignes par source dans data.json
    US_FETCH_BUDGET: 400,   // max téléchargements de Form 4 XML par run
    US_RL_MS: 180,          // pause entre téléchargements SEC (~5/s, limite 10/s)
    STATE_DAYS: 40,         // conservation des accession US déjà traités (déduplication)
    STALE_H: 60             // au-delà : relevé marqué "ancien" (trou week-end = 57 h max)
  };

  // ---------- utilitaires ----------
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function decodeEntities(s) {
    return String(s == null ? "" : s)
      .replace(/&nbsp;/gi, " ").replace(/&euro;/gi, "€")
      .replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
  }
  function stripTags(s) {
    return decodeEntities(String(s == null ? "" : s).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
  }
  // "1 400.0000" ou "22 020.0400 €" (espaces insécables U+00A0 / U+202F) -> 1400 / 22020.04
  function frNum(s) {
    if (s == null) return NaN;
    var t = String(s).replace(/[\u00a0\u202f\s\u2028\u2029]/g, "").replace(/€/g, "").replace(",", ".");
    var m = t.match(/-?\d+(\.\d+)?/);
    return m ? parseFloat(m[0]) : NaN;
  }
  function ddmmyyyyToIso(s) {
    var m = String(s || "").trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    return m ? (m[3] + "-" + m[2] + "-" + m[1]) : null;
  }
  function isoToDmY(iso) {
    var m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? (parseInt(m[3], 10) + "/" + m[2] + "/" + m[1]) : "—";
  }
  // date locale -> "dd/mm/aaaa" pour la requête swaoo (décalage UTC évité)
  function frDate(d) {
    var p = function (n) { return (n < 10 ? "0" : "") + n; };
    return p(d.getDate()) + "/" + p(d.getMonth() + 1) + "/" + d.getFullYear();
  }
  function isoDay(d) {
    var p = function (n) { return (n < 10 ? "0" : "") + n; };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }
  function daysBetween(isoA, isoB) {
    if (!isoA || !isoB) return null;
    var a = Date.parse(isoA), b = Date.parse(isoB);
    if (isNaN(a) || isNaN(b)) return null;
    return Math.round((b - a) / 86400000);
  }

  // ---------- parseur FR : transactions-amf.swaoo.com ----------
  // Chaque déclaration = une ligne principale <tr> + une ligne détail <tr class="collapse" id="DET…">
  function parseSwaoo(html) {
    var out = [];
    var i = html.indexOf('id="liste_transactions"');
    if (i < 0) return out;
    var seg = html.slice(i);
    var re = /<tr>\s*<td><a[^>]*>([^<]*)<\/a><\/td>((?:\s*<td[^>]*>[\s\S]*?<\/td>)+)\s*<\/tr>\s*<tr class="collapse" id="([^"]+)">([\s\S]*?)<\/tr>/g;
    var m;
    while ((m = re.exec(seg)) !== null) {
      var cells = [];
      var cellRe = /<td[^>]*>([\s\S]*?)<\/td>/g;
      var cm;
      while ((cm = cellRe.exec(m[2])) !== null) cells.push(stripTags(cm[1]));
      if (cells.length < 8) continue;
      var detail = m[4];
      var id = String(m[3]).replace(/^DET/, "");
      var auteurM = detail.match(/<strong>Auteur :<\/strong>([\s\S]*?)<\/li>/);
      var auteurFull = auteurM ? stripTags(auteurM[1]) : "";
      var auteur = auteurFull, role = "";
      var cIdx = auteurFull.lastIndexOf(", ");
      if (cIdx > 0 && auteurFull.length - cIdx < 90) {
        auteur = auteurFull.slice(0, cIdx);
        role = auteurFull.slice(cIdx + 2);
      }
      var pdfM = detail.match(/href="([^"]+)"[^>]*>[^<]*Déclaration/);
      var ficheM = detail.match(/href="(https:\/\/bdif\.amf-france\.org\/Fiche-BDIF[^"]*)"/);
      // cellules après la société : [0]=datePub [1]=dateOp [2]=nature [3]=instrument [4]=ISIN [5]=volume [6]=prix [7]=montant
      var nature = cells[2];
      // v3 : acquisitions ET cessions (les autres natures restent hors périmètre)
      var natL = String(nature || "").toLowerCase();
      var side = null;
      if (natL.indexOf("acquisition") === 0) side = "buy";
      else if (natL.indexOf("cession") === 0) side = "sell";
      if (!side) continue;
      var row = {
        id: id,
        source: "FR",
        side: side,
        societe: stripTags(m[1]),
        auteur: auteur,
        role: role,
        nature: nature,
        instrument: cells[3] || "",
        isin: cells[4] || "",
        datePub: ddmmyyyyToIso(cells[0]),
        dateOp: ddmmyyyyToIso(cells[1]),
        volume: frNum(cells[5]),
        prix: frNum(cells[6]),
        montant: frNum(cells[7]),
        url: pdfM ? decodeEntities(pdfM[1]) : (ficheM ? ficheM[1] : "")
      };
      // garde-fous : ligne incohérente ignorée
      if (!row.datePub || !row.dateOp || !isFinite(row.montant) || row.montant < 0) continue;
      if (row.montant > 1e10) continue;
      out.push(row);
    }
    return out;
  }
  function swaooCount(html) {
    var m = html.match(/(\d+)\s+déclarations?\s+enregistrées?/);
    return m ? parseInt(m[1], 10) : null;
  }
  // décide de continuer la pagination FR : tant que la page contient des lignes (toutes natures)
  // — la page peut être pleine de cessions, le filtre acquisition se fait en local.
  function frNextPage(rawCount, page, maxPages) {
    var max = maxPages || 12;
    return rawCount > 0 && page < max;
  }

  // ---------- parseur US : EDGAR full-text search + Form 4 XML ----------  // "Enphase Energy, Inc.  (ENPH)  (CIK 0001463101)" -> { issuer, ticker }
  function parseIssuerDisplay(s) {
    var raw = String(s || "").replace(/\s+/g, " ").trim();
    var ticker = null;
    var mt = raw.match(/\(([^()]{1,8})\)/);
    if (mt && !/CIK/i.test(mt[1])) ticker = mt[1].trim();
    var name = raw.replace(/\s*\((?:CIK)?[^)]*\)/g, "").trim();
    return { issuer: name || raw, ticker: ticker };
  }
  function parseFts(jsonText) {
    var j = typeof jsonText === "string" ? JSON.parse(jsonText) : jsonText;
    var hits = (j && j.hits && j.hits.hits) || [];
    var out = [];
    for (var k = 0; k < hits.length; k++) {
      var h = hits[k];
      var parts = String(h._id || "").split(":");
      if (parts.length < 2) continue;
      var src = h._source || {};
      var names = src.display_names || [];
      var owner = names.length > 0 ? parseIssuerDisplay(names[0]).issuer : "";
      var issuerInfo = names.length > 1 ? parseIssuerDisplay(names[1]) : { issuer: "", ticker: null };
      out.push({
        accession: parts[0],
        file: parts.slice(1).join(":"),
        cik: (src.ciks && src.ciks[0]) || "",
        fileDate: src.file_date || "",
        owner: owner,
        issuer: issuerInfo.issuer,
        ticker: issuerInfo.ticker
      });
    }
    return out;
  }
  function form4Url(cik, accession, file) {
    return "https://www.sec.gov/Archives/edgar/data/" + String(cik).replace(/^0+/, "") +
      "/" + String(accession).replace(/-/g, "") + "/" + file;
  }
  function parseForm4(xml) {
    var x = String(xml || "");
    var g = function (re) { var m = x.match(re); return m ? m[1].trim() : ""; };
    var role = g(/<officerTitle>([^<]*)/);
    var isDir = /^\s*(?:<value>\s*)?1/.test(g(/<isDirector>((?:(?!<\/isDirector>)[\s\S])*)/) || "0");
    var is10 = /^\s*(?:<value>\s*)?1/.test(g(/<isTenPercentOwner>((?:(?!<\/isTenPercentOwner>)[\s\S])*)/) || "0");
    if (!role) role = isDir ? "Directeur" : (is10 ? "Propriétaire 10 %" : "Initié");
    // v3.3 : un même dépôt peut mentionner PLUSIEURS déclarants (formulaires multi-reporting,
    // prévus par les instructions SEC du Form 4). On les extrait tous : le premier reste la
    // référence (compat), mais l'attribution est signalée comme incertaine (multiOwner).
    var ownerTags = x.match(/<rptOwnerName>([^<]*)<\/rptOwnerName>/g) || [];
    var owners = [];
    for (var oi = 0; oi < ownerTags.length; oi++) {
      var nm = ownerTags[oi].replace(/<[^>]*>/g, "").trim();
      if (nm) owners.push(nm);
    }
    // 10b5-1 : plan de vente programmé déclaré (case à cocher depuis 2023, <aff10b5One>1</aff10b5One>)
    var p10 = x.match(/<aff10b5One>\s*([^<]*)/);
    var plan10b5 = p10 ? /^\s*1/.test(p10[1]) : null; // null = balise absente (ancien dépôt)
    // code M (levée d'options) dans le même dépôt : une vente S qui suit une levée
    // n'est pas un signal baissier autonome. ⚠ Constat au niveau du DÉPÔT, pas de la
    // transaction : le XML ne prouve pas le lien S↔M ligne à ligne.
    var hasM = /<transactionCode>\s*M\s*<\/transactionCode>/.test(x);
    var blocks = x.match(/<nonDerivativeTransaction>[\s\S]*?<\/nonDerivativeTransaction>/g) || [];
    var txs = [];
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      var q = function (re) { var m = b.match(re); return m ? m[1].trim() : ""; };
      txs.push({
        title: q(/<securityTitle>\s*<value>([^<]*)/),
        date: q(/<transactionDate>\s*<value>([^<]*)/),
        code: q(/<transactionCode>([^<]*)/),
        acq: q(/<transactionAcquiredDisposedCode>\s*<value>([^<]*)/),
        shares: parseFloat(q(/<transactionShares>\s*<value>([^<]*)/)),
        price: parseFloat(q(/<transactionPricePerShare>\s*<value>([^<]*)/))
      });
    }
    return {
      issuer: g(/<issuerName>([^<]*)/),
      ticker: g(/<issuerTradingSymbol>([^<]*)/),
      owner: owners.length > 0 ? owners[0] : g(/<rptOwnerName>([^<]*)/),
      owners: owners,
      multiOwner: owners.length > 1,
      role: role,
      plan10b5: plan10b5,
      hasM: hasM,
      transactions: txs
    };
  }
  // Filtre des transactions qui échangent de l'argent réel, pour honnêteté :
  //   achat  = code P (purchase) + code acquis A
  //   vente  = code S (sale) + code disposé D
  // ⚠️ Selon les instructions officielles de la SEC, P et S couvrent les transactions
  // « open market OU privées » — pas uniquement le marché. Hors périmètre des deux côtés :
  // F/G (cadeaux, dons), J (conversions, distributions), M (levée d'options), A (attribution).
  function usRowsFrom(hit, f4) {
    var rows = [];
    for (var i = 0; i < f4.transactions.length; i++) {
      var t = f4.transactions[i];
      var isBuy = (t.acq === "A" && t.code === "P");
      var isSell = (t.acq === "D" && t.code === "S");
      if (!isBuy && !isSell) continue;
      if (!isFinite(t.shares) || !isFinite(t.price) || t.shares <= 0 || t.price <= 0) continue;
      var montant = t.shares * t.price;
      if (isBuy && montant < CFG.US_MIN_USD) continue;
      // v3.3 : côté ventes US, on ne collecte que les ventes « dures » ≥ 50 k$ —
      // hors plan 10b5-1 déclaré et hors dépôt contenant une levée (code M) : ce sont des
      // liquidations programmées/neutres, pas des signaux baissiers, et elles noyaient les
      // listes (380 ventes en 1 journée = fenêtre réelle de ~2 j pour un affichage « 90 j »).
      if (isSell && (montant < CFG.US_SELL_MIN_USD || f4.plan10b5 === true || f4.hasM === true)) continue;
      rows.push({
        // id anti-collision : deux tranches du même dépôt peuvent partager date + quantité
        // (prix différents) — l'index et le prix les distinguent, sinon la 2e est écrasée
        id: hit.accession + "|" + (f4.owner || hit.owner) + "|" + t.code + "|" + t.date + "|" + t.shares + "|" + (t.price || "") + "|" + i,
        source: "US",
        side: isBuy ? "buy" : "sell",
        societe: f4.issuer || hit.issuer || "",
        ticker: f4.ticker || hit.ticker || "",
        auteur: f4.owner || hit.owner || "",
        role: f4.role || "",
        nature: isBuy ? "Achat" : "Vente",
        instrument: t.title || "",
        isin: "",
        dateOp: t.date || "",
        datePub: hit.fileDate || "",
        volume: t.shares,
        prix: t.price,
        montant: Math.round(montant * 100) / 100,
        code: t.code,
        cik: hit.cik || "",                    // CIK SEC — sert aux fondamentaux XBRL (v3.2)
        p10b5: f4.plan10b5 === true,           // champ conservé pour le scoring (toujours false après le filtre ci-dessus)
        opt: isSell && f4.hasM === true,       // idem : les ventes « levée » ne sont plus collectées
        multi: f4.multiOwner === true,         // v3.3 : dépôt multi-déclarants — attribution au 1er, incertaine
        url: hit.url || ""
      });
    }
    return rows;
  }
  function rowsOfSide(rows, side) {
    if (side !== "buy" && side !== "sell") return (rows || []).slice();
    return (rows || []).filter(function (r) { return r && r.side === side; });
  }

  // ---------- fusion / déduplication / fenêtre de conservation ----------
  function mergeRows(oldRows, newRows, keepDays, maxRows, nowMs) {
    var byId = {};
    var all = (oldRows || []).concat(newRows || []);
    for (var i = 0; i < all.length; i++) {
      var r = all[i];
      if (!r || !r.id || !r.datePub) continue;
      if (r.montant == null || !isFinite(r.montant) || r.montant < 0) continue;
      byId[r.id] = r; // les plus récents en dernier gagnent
    }
    var list = [];
    for (var k in byId) {
      if (!Object.prototype.hasOwnProperty.call(byId, k)) continue;
      var age = daysBetween(String(byId[k].datePub).slice(0, 10), isoDay(new Date(nowMs)));
      if (keepDays && age != null && age > keepDays) continue;
      list.push(byId[k]);
    }
    list.sort(function (a, b) {
      var d = String(b.datePub).localeCompare(String(a.datePub));
      if (d !== 0) return d;
      return (b.montant || 0) - (a.montant || 0);
    });
    if (maxRows && list.length > maxRows) list = list.slice(0, maxRows);
    return list;
  }

  // ---------- app : filtre, tri, format, fraîcheur ----------
  function filterRows(rows, opts) {
    var o = opts || {};
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (o.source === "FR" && r.source !== "FR") continue;
      if (o.source === "US" && r.source !== "US") continue;
      if (o.minMontant && (r.montant || 0) < o.minMontant) continue;
      if (o.q) {
        var q = String(o.q).toLowerCase();
        var hay = (r.societe + " " + (r.ticker || "") + " " + r.auteur + " " + (r.isin || "")).toLowerCase();
        if (hay.indexOf(q) === -1) continue;
      }
      out.push(r);
    }
    return out;
  }
  function sortRows(rows, key) {
    var list = rows.slice();
    list.sort(function (a, b) {
      if (key === "montant") return (b.montant || 0) - (a.montant || 0);
      var d = String(b.datePub).localeCompare(String(a.datePub));
      if (d !== 0) return d;
      return (b.montant || 0) - (a.montant || 0);
    });
    return list;
  }
  function fmtEUR(n) {
    if (n == null || !isFinite(n)) return "—";
    var v = Math.round(n);
    var s = String(v).replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");
    return s + "\u00a0€";
  }
  function fmtUSD(n) {
    if (n == null || !isFinite(n)) return "—";
    var v = Math.round(n);
    return "$" + String(v).replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");
  }
  function fmtNum(n) {
    if (n == null || !isFinite(n)) return "—";
    var v = Math.round(n * 100) / 100;
    return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0");
  }
  function fmtMontant(r) {
    return r.source === "US" ? fmtUSD(r.montant) : fmtEUR(r.montant);
  }
  function lagLabel(r) {
    var d = daysBetween(String(r.dateOp).slice(0, 10), String(r.datePub).slice(0, 10));
    if (d == null) return "";
    if (d < 0) return "publié avant l'opération"; // déclaration d'une acquisition future (cas réel)
    if (d <= 0) return "publié le jour même";
    return "publié J+" + d;
  }
  function freshness(updatedIso, nowMs) {
    var t = Date.parse(updatedIso);
    if (isNaN(t)) return { h: null, label: "inconnu", stale: true };
    var h = Math.max(0, Math.round((nowMs - t) / 3600000));
    var label;
    if (h < 1) label = "à l'instant";
    else if (h < 24) label = "il y a " + h + " h";
    else label = "il y a " + Math.floor(h / 24) + " j";
    return { h: h, label: label, stale: h > CFG.STALE_H };
  }

  // ---------- signaux : accumulation des initiés par société ----------
  // Un achat isolé = bruit ; plusieurs achats (surtout d'initiés DISTINCTS) = conviction.
  // Heuristique maison de niveau, non validée historiquement :
  //   niveau 3 (🔥🔥) : >= 2 initiés distincts ET >= 3 achats  — le vrai signal de cluster
  //   niveau 2 (🔥)   : >= 3 achats (même initié qui rachète) OU >= 2 initiés OU total >= 1 M
  //   niveau 1 (×)    : 2 achats d'un même initié — à nuancer
  //   < 2 achats      : pas un signal (reste dans la liste brute)
  // v3.3 — nettoyage des faux clusters (revue qualité du signal) :
  //   1. « personne morale liée à X » : le véhicule déclare, l'INITIÉ est X. Deux holdings
  //      liées à la même personne = 1 initié, pas 2 (cas réel KLEA : 20 achats, « 2 initiés » faux).
  //   2. opérations identiques (société + date + volume + prix) déclarées sous deux accessions
  //      = UNE opération (cas réel Silynxcom : 4 achats déclarés pour 2 réels).
  //   3. fenêtre 30 j (option since) au lieu de 90 : une accumulation ancienne n'est plus un signal.
  function normName(s) {
    return String(s == null ? "" : s).toUpperCase()
      .replace(/[\u00c0\u00c1\u00c2\u00c3\u00c4\u00c5]/g, "A").replace(/[\u00c8\u00c9\u00ca\u00cb]/g, "E")
      .replace(/[\u00cc\u00cd\u00ce\u00cf]/g, "I").replace(/[\u00d2\u00d3\u00d4\u00d5\u00d6]/g, "O")
      .replace(/[\u00d9\u00da\u00db\u00dc]/g, "U").replace(/\u00c7/g, "C")
      .replace(/[^A-Z0-9]+/g, " ").trim();
  }
  // clé de regroupement : jamais mélanger FR (€) et US ($). Côté FR, le NOM normalisé
  // prime : 37/63 déclarations réelles sans ISIN — la clé ISIN couperait une société
  // en deux cartes (cas ROCHE BOBOIS constaté). Côté US, le ticker (toujours présent).
  function sigKey(r) {
    if (r.source === "US") return "US|" + ((r.ticker && normName(r.ticker)) || normName(r.societe));
    return "FR|" + (normName(r.societe) || String(r.isin || "").trim());
  }
  // initié réel derrière le déclarant : « FONCIERE DE L'ESPLANADE personne morale liée à
  // RAPHAEL SMILA » → l'initié est RAPHAEL SMILA (53/116 lignes FR réelles sont des véhicules)
  function personKey(s) {
    var t = String(s == null ? "" : s);
    var m = t.match(/personne morale li[eé]e?\s+à\s+(.+)$/i);
    return normName(m ? m[1] : t) || "\u2014";
  }
  function signalsFrom(rows, opts) {
    var o = opts || {};
    var map = {};
    var seenOp = {}; // dédoublonnage des opérations identiques (plusieurs déclarants)
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r || !r.id || !r.datePub) continue;
      if (r.montant == null || !isFinite(r.montant) || r.montant < 0) continue;
      if (!isFinite(r.volume) || r.volume <= 0 || !isFinite(r.prix) || r.prix <= 0) continue;
      var pub = String(r.datePub).slice(0, 10);
      if (o.since && pub < o.since) continue; // fenêtre 30 j du signal
      var k = sigKey(r);
      var opKey = k + "|" + String(r.dateOp || "") + "|" + r.volume + "|" + r.prix;
      if (seenOp[opKey]) continue; // même opération re-déclarée : comptée UNE fois
      seenOp[opKey] = 1;
      var g = map[k];
      if (!g) {
        g = map[k] = { key: k, source: r.source, societe: r.societe, ticker: r.ticker || "", isin: r.isin || "",
          buys: 0, total: 0, volume: 0, buyers: {}, first: null, last: null };
      }
      g.buys++; g.total += r.montant; g.volume += r.volume;
      var bk = personKey(r.auteur);
      g.buyers[bk] = (g.buyers[bk] || 0) + 1;
      if (!g.first || pub < g.first) g.first = pub;
      if (!g.last || pub > g.last) g.last = pub;
    }
    var out = [];
    for (var k2 in map) {
      if (!Object.prototype.hasOwnProperty.call(map, k2)) continue;
      var m = map[k2];
      if (m.buys < 2) continue;
      var nBuyers = 0;
      for (var b in m.buyers) {
        if (Object.prototype.hasOwnProperty.call(m.buyers, b)) nBuyers++;
      }
      out.push({
        key: m.key, source: m.source, societe: m.societe, ticker: m.ticker, isin: m.isin,
        buys: m.buys, buyers: nBuyers,
        total: Math.round(m.total * 100) / 100,
        avgPx: m.volume > 0 ? Math.round((m.total / m.volume) * 10000) / 10000 : 0,
        first: m.first, last: m.last,
        level: (nBuyers >= 2 && m.buys >= 3) ? 3 : ((m.buys >= 3 || nBuyers >= 2 || m.total >= 1000000) ? 2 : 1)
      });
    }
    // tri : niveau d'abord, puis RÉCENCE du dernier achat, puis total (v3.3 : le cluster
    // tout frais prime sur le gros cluster ancien)
    out.sort(function (a, b) {
      if (b.level !== a.level) return b.level - a.level;
      var d = String(b.last).localeCompare(String(a.last));
      if (d !== 0) return d;
      return b.total - a.total;
    });
    return out;
  }
  // badge ×N dans la liste brute : nb d'achats de la société sur la fenêtre
  function signalCountByKey(rows) {
    var c = {};
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r || !r.datePub) continue;
      var k = sigKey(r);
      c[k] = (c[k] || 0) + 1;
    }
    return c;
  }

  // ---------- pistes d'étude (v3.2) : signal initiés × fondamentaux ----------
  // ⚠️ Heuristique maison, outillage de recherche — JAMAIS un conseil d'achat.
  // Côté ventes : une vente « dure » (ni plan 10b5-1 ni levée d'options) est un vrai
  // signal baissier ; une vente sous plan/levée est quasi neutre (liquidation programmée).
  function sellStatsByKey(rows) {
    var m = {};
    for (var i = 0; i < (rows || []).length; i++) {
      var r = rows[i];
      if (!r || r.side !== "sell") continue;
      var k = sigKey(r);
      var g = m[k];
      if (!g) g = m[k] = { key: k, sells: 0, hardSells: 0, softSells: 0 };
      g.sells++;
      if (r.p10b5 === true || r.opt === true) g.softSells++; else g.hardSells++;
    }
    return m;
  }
  // score initiés /10 : clusters (les vrais signaux) + bonus multi-initiés - malus ventes dures
  function insiderScoreFor(sig, sells) {
    if (!sig) return 0;
    var s = sig.level === 3 ? 5 : (sig.level === 2 ? 3.5 : 2);
    if (sig.buyers >= 2) s += 1.5;          // plusieurs dirigeants différents se positionnent
    if (sig.level === 3 && sig.buys >= 5) s += 0.5;
    if (sells && sells.sells > 0) {
      if (sells.hardSells > 0) s -= 2.5;    // au moins une vente sans motif programmé
      else s -= 0.5;                        // ventes uniquement sous plan 10b5-1 / levée
    }
    return Math.max(0, Math.min(10, Math.round(s * 10) / 10));
  }
  // score fondamentaux /10 — comptes annuels 10-K (XBRL SEC) : croissance, rentabilité, marge
  function fundScore(f) {
    if (!f || f.rev == null || !isFinite(f.rev) || f.rev <= 0) return null;
    var s = 0;
    var g = (f.growth == null || !isFinite(f.growth)) ? null : f.growth;
    if (g != null) s += g >= 50 ? 3.5 : g >= 25 ? 3 : g >= 15 ? 2.5 : g >= 8 ? 2 : g >= 3 ? 1 : g >= 0 ? 0.5 : 0;
    var margin = (f.ni != null && isFinite(f.ni)) ? f.ni / f.rev : null;
    if (f.ni != null && isFinite(f.ni)) s += f.ni > 0 ? 3 : 0;
    if (margin != null) s += margin >= 0.25 ? 3.5 : margin >= 0.15 ? 3 : margin >= 0.10 ? 2.5 : margin >= 0.05 ? 1.5 : margin > 0 ? 1 : 0;
    return Math.round(s * 10) / 10;
  }
  // XBRL companyconcept → série annuelle [{end, val}] : form 10-K uniquement,
  // dédoublonnée par date de clôture (la valeur avec "frame" CY gagne, c'est la consolidée)
  function xbrlAnnuals(concept) {
    if (!concept || !concept.units) return [];
    var units = concept.units;
    var list = units.USD || units[Object.keys(units)[0]] || [];
    var by = {};
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (!e || e.form !== "10-K" || !e.end || !isFinite(e.val)) continue;
      if (by[e.end] == null || e.frame) by[e.end] = e.val;
    }
    return Object.keys(by).sort().map(function (end) { return { end: end, val: by[end] }; });
  }
  // séries annuelles CA + résultat net → fondamentaux {rev, revEnd, growth, ni, margin}
  function fundFromXbrl(revAnnuals, niAnnuals) {
    if (!revAnnuals || revAnnuals.length === 0) return null;
    var last = revAnnuals[revAnnuals.length - 1];
    var prior = revAnnuals.length > 1 ? revAnnuals[revAnnuals.length - 2] : null;
    var growth = (prior && prior.val > 0) ? Math.round(((last.val - prior.val) / prior.val) * 1000) / 10 : null;
    var ni = null, niEnd = null;
    for (var i = (niAnnuals || []).length - 1; i >= 0; i--) {
      if (niAnnuals[i].end <= last.end) { ni = niAnnuals[i].val; niEnd = niAnnuals[i].end; break; }
    }
    return {
      rev: last.val, revEnd: last.end, growth: growth,
      ni: ni, niEnd: niEnd,
      margin: (ni != null) ? Math.round((ni / last.val) * 1000) / 10 : null // % du CA
    };
  }
  function pickBuyRows(rows) {
    var out = [];
    for (var i = 0; i < (rows || []).length; i++) {
      if (rows[i] && rows[i].side !== "sell") out.push(rows[i]);
    }
    return out;
  }
  // sociétés US avec un vrai signal initiés, triées, capées — celles qu'on va documenter
  function pickCandidates(buys, sells, max, opts) {
    var sigs = signalsFrom(pickBuyRows(buys), opts || {});
    var ss = sellStatsByKey(sells);
    var out = [];
    for (var i = 0; i < sigs.length; i++) {
      var s = sigs[i];
      if (s.source !== "US" || !s.ticker) continue;
      var ins = insiderScoreFor(s, ss[s.key]);
      if (ins < 4) continue; // cluster réel : plusieurs initiés ou niveau 3 — pas un achat isolé
      out.push({ key: s.key, ticker: s.ticker, societe: s.societe, insider: ins, sig: s, sells: ss[s.key] || null });
    }
    out.sort(function (a, b) { return b.insider - a.insider || b.sig.total - a.sig.total; });
    return out.slice(0, max || 15);
  }
  // croisement final : candidates × fondamentaux → pistes triées par score /20
  function picksFrom(buys, sells, funds, opts) {
    var o = opts || {};
    var cands = pickCandidates(buys, sells, 15, o);
    var out = [];
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i];
      var tk = String(c.ticker || "").toUpperCase();
      var f = funds ? funds[tk] : null;
      if (!f) continue; // fondamentaux introuvables (pas de 10-K exploitable) → pas de piste honnête
      var fsc = fundScore(f);
      if (fsc == null) continue;
      out.push({
        ticker: c.ticker, societe: c.societe, score: Math.round((c.insider + fsc) * 10) / 10,
        insider: {
          score: c.insider, buys: c.sig.buys, buyers: c.sig.buyers, level: c.sig.level,
          total: c.sig.total, avgPx: c.sig.avgPx, first: c.sig.first, last: c.sig.last
        },
        sells: c.sells ? { n: c.sells.sells, hard: c.sells.hardSells } : { n: 0, hard: 0 },
        fund: {
          score: fsc, growth: f.growth, ni: f.ni, rev: f.rev, revEnd: f.revEnd, margin: f.margin
        }
      });
    }
    out.sort(function (a, b) { return b.score - a.score; });
    return out.slice(0, o.max || 6);
  }
  // v3.3 : pistes FR — signal initiés NETTOYÉ seul, sur /10. Pas d'équivalent public et
  // gratuit des comptes 10-K SEC pour les sociétés cotées françaises : les fondamentaux
  // ne sont PAS évalués, c'est dit honnêtement dans la carte. Clusters 30 j dédoublonnés,
  // initiés regroupés par personne physique (véhicules « liée à X » = 1 initié).
  function picksFromFr(buys, sells, opts) {
    var o = opts || {};
    var sigs = signalsFrom(pickBuyRows(buys), o);
    var ss = sellStatsByKey(sells);
    var out = [];
    for (var i = 0; i < sigs.length; i++) {
      var s = sigs[i];
      if (s.source !== "FR") continue;
      var ins = insiderScoreFor(s, ss[s.key]);
      if (ins < 4) continue; // même exigence que côté US : un vrai cluster, pas un achat isolé
      out.push({
        societe: s.societe, isin: s.isin, score: ins,
        insider: {
          score: ins, buys: s.buys, buyers: s.buyers, level: s.level,
          total: s.total, avgPx: s.avgPx, first: s.first, last: s.last
        },
        sells: ss[s.key] ? { n: ss[s.key].sells, hard: ss[s.key].hardSells } : { n: 0, hard: 0 }
      });
    }
    out.sort(function (a, b) { return b.score - a.score || b.insider.total - a.insider.total; });
    return out.slice(0, o.max || 5);
  }

  // ---------- v4.0 : SBF 120 — scores de valorisation + croisement initiés FR ----------
  // Heuristique de TRI honnête, pas une juste valeur : percentiles internes à l'indice (une valeur
  // n'est « pas chère » que RELATIVEMENT aux 119 autres), pondération PER 50 % / rendement 30 % / P/B 20 %.
  // Le score exige un PER positif : une société en perte n'est pas bon marché, elle est en perte.

  // percentile 0-100 du champ sur la liste : lowerIsBetter -> le plus bas = 100.
  // PER/PB non positifs exclus du rang (perte, capitaux propres négatifs).
  function rankPct(list, field, lowerIsBetter) {
    var vals = [], idx = {}, n = 0;
    for (var i = 0; i < list.length; i++) {
      var v = list[i][field];
      if (v == null || !isFinite(v)) continue;
      if (field !== "dY" && v <= 0) continue;
      idx[i] = v; n++;
    }
    var pcts = {};
    // v4.0.10 (3e revue) : ex æquo → RANG MOYEN, comme rankPctAny. L'ancien rang strict
    // mettait TOUS les non-payeurs de dividende à 0 (dY ex æquo) — punir l'égalité n'a pas
    // de sens. Une seule valeur = pas de comparaison possible → percentile ABSENT, pas un
    // 50 qui ressemblerait à un rang neutre sans l'être.
    for (var a in idx) {
      if (!Object.prototype.hasOwnProperty.call(idx, a)) continue;
      if (n < 2) continue;
      var less = 0, tied = 0;
      for (var b in idx) {
        if (!Object.prototype.hasOwnProperty.call(idx, b) || b === a) continue;
        if (lowerIsBetter ? (idx[b] > idx[a]) : (idx[b] < idx[a])) less++;
        else if (idx[b] === idx[a]) tied++;
      }
      pcts[a] = Math.round(((less + tied / 2) / (n - 1)) * 100);
    }
    return pcts;
  }

  // ajoute pPer/pDY/pPb/score/vMode/vBase à une copie de chaque ligne ; score null sans PER exploitable.
  // v4.0.5 : percentiles PAR SECTEUR quand le relevé fournit le secteur (colonne TradingView)
  // et que le secteur compte ≥ 8 valeurs cotées — comparer des pairs enfin. Les lignes sans
  // secteur utilisable retombent en mode « index » : percentiles sur TOUTE la liste, comme
  // historiquement. vBase (0-3) rend la base du score explicite : un score renormalisé sur
  // une seule métrique n'a pas la même fiabilité qu'un score sur les trois.
  function valScores(list) {
    var W = { per: 0.5, dY: 0.3, pb: 0.2 };
    // v4.0.12 (audit) : le mode sectoriel d'une métrique exige ≥ 8 valeurs dans le secteur
    // ET ≥ 5 observations VALIDES de cette métrique dans le pool — un percentile sectoriel
    // calculé sur 2 observations est un bruit, pas un rang. Sinon la métrique se compare
    // à l'indice. vMode devient "sector" / "index" / "mix" (une partie des métriques de la
    // ligne est sectorisée, l'autre non) — l'UI affiche la base de chaque score.
    var MIN_SEC = 8, MIN_MET = 5;
    var bySec = {};
    for (var i = 0; i < list.length; i++) {
      var sec = (typeof list[i].sec === "string" && list[i].sec) ? list[i].sec : null;
      if (sec) (bySec[sec] = bySec[sec] || []).push(i);
    }
    var METS = [["per", "pPer", true], ["dY", "pDY", false], ["pb", "pPb", true]];
    var res = [];
    for (var r0 = 0; r0 < list.length; r0++) res[r0] = { pPer: null, pDY: null, pPb: null, mPer: "index", mDY: "index", mPb: "index" };
    // référentiel « vs indice » : une passe sur toute la liste, clés = index dans la liste
    var full = { pPer: rankPct(list, "per", true), pDY: rankPct(list, "dY", false), pPb: rankPct(list, "pb", true) };
    for (var i1 = 0; i1 < list.length; i1++) {
      res[i1].pPer = full.pPer[i1] != null ? full.pPer[i1] : null;
      res[i1].pDY = full.pDY[i1] != null ? full.pDY[i1] : null;
      res[i1].pPb = full.pPb[i1] != null ? full.pPb[i1] : null;
    }
    // observations valides d'une métrique dans un sous-ensemble (même filtre que rankPct)
    function validCount(sub, field) {
      var n = 0;
      for (var k = 0; k < sub.length; k++) {
        var v = sub[k][field];
        if (v == null || !isFinite(v)) continue;
        if (field !== "dY" && v <= 0) continue;
        n++;
      }
      return n;
    }
    // secteurs assez peuplés → classement interne au secteur, MÉTRIQUE PAR MÉTRIQUE
    for (var s2 in bySec) {
      if (!Object.prototype.hasOwnProperty.call(bySec, s2)) continue;
      if (bySec[s2].length < MIN_SEC) continue;
      var sub = bySec[s2].map(function (j) { return list[j]; });
      METS.forEach(function (m) {
        if (validCount(sub, m[0]) < MIN_MET) return; // métrique trop peu couverte dans le secteur → vs indice
        var p = rankPct(sub, m[0], m[2]);
        bySec[s2].forEach(function (j, k) {
          if (p[k] != null) { res[j][m[1]] = p[k]; res[j]["m" + m[1].slice(1)] = "sector"; }
        });
      });
    }
    return list.map(function (e, i) {
      var s = 0, w = 0;
      var p = res[i];
      if (p.pPer != null) { s += W.per * p.pPer; w += W.per; }
      if (p.pDY != null) { s += W.dY * p.pDY; w += W.dY; }
      if (p.pPb != null) { s += W.pb * p.pPb; w += W.pb; }
      var o = {};
      for (var k in e) if (Object.prototype.hasOwnProperty.call(e, k)) o[k] = e[k];
      o.pPer = p.pPer != null ? p.pPer : null;
      o.pDY = p.pDY != null ? p.pDY : null;
      o.pPb = p.pPb != null ? p.pPb : null;
      o.score = (p.pPer != null && w > 0) ? Math.round(s / w) : null;
      o.vBase = p.pPer != null ? ((p.pPer != null ? 1 : 0) + (p.pDY != null ? 1 : 0) + (p.pPb != null ? 1 : 0)) : 0;
      var modes = [];
      if (p.pPer != null) modes.push(p.mPer);
      if (p.pDY != null) modes.push(p.mDY);
      if (p.pPb != null) modes.push(p.mPb);
      o.vMode = modes.length === 0 ? "index"
        : (modes.every(function (m) { return m === "sector"; }) ? "sector"
        : (modes.every(function (m) { return m === "index"; }) ? "index" : "mix"));
      return o;
    });
  }

  // ---------- v4.0.8 : score 💎 Opportunité = qualité 57 % + valorisation 43 % ----------
  // Revue du 09/11 (2 lectures croisées du code v4.0.7) : le point bas 52 s. N'ENTRE PLUS
  // dans le score. George & Hwang (2004) : les titres proches de leur PLUS HAUT 52 s.
  // surperforment (ancrage momentum) — rien ne justifie d'acheter « au plus bas » comme un
  // signal. La position 52 s. reste une ÉTIQUETTE d'information (📉 bas de fourchette),
  // jamais une composante du score ; elle ne reviendra dans le calcul que si le journal
  // de validation (tools/journal-scores.js) démontre un jour qu'elle ajoute quelque chose.
  // Score = qualité 57 % + valorisation 43 % (mêmes proportions que le 40/30 initial).
  //   qualité — ROE 35 % + marge op. 25 % + croissance CA 20 % + dette/CP 20 %, percentile
  //              PAR SECTEUR comme la valorisation (≥ 8 pairs, repli vs indice) : ROE,
  //              marge et dette sont structurels par secteur (luxe ≠ distribution ≠ banque).
  //              ≥ 3 métriques sur 4 EXIGÉES (sinon pas d'avis), capitaux propres négatifs
  //              (P/B ≤ 0) → ROE et D/E non mesurables, D/E négatif → null, ex æquo →
  //              rang moyen. fper > per → ⚠️ bénéfices attendus en baisse (piège à valeur).
  //   valorisation — le score 📐 v4.0.5 (percentiles PER/rendement/P/B, par secteur).
  // Toujours une heuristique de tri honnête (jamais validée sur historique, pas un conseil).

  // percentile générique pour la qualité : TOUTE valeur finie participe (contrairement à
  // rankPct qui exclut les non positifs — bon pour PER/PB, faux pour une croissance à -3 %).
  // v4.0.8 : ex æquo → RANG MOYEN (mi-partage des égalités) ; toutes égales → 50, pas 0.
  function rankPctAny(list, field, lowerIsBetter) {
    var vals = {}, n = 0;
    for (var i = 0; i < list.length; i++) {
      var v = list[i][field];
      if (v == null || !isFinite(v)) continue;
      vals[i] = v; n++;
    }
    var pcts = {};
    for (var a in vals) {
      if (!Object.prototype.hasOwnProperty.call(vals, a)) continue;
      var beaten = 0, tied = 0;
      for (var b in vals) {
        if (!Object.prototype.hasOwnProperty.call(vals, b) || b === a) continue;
        if (lowerIsBetter ? (vals[b] > vals[a]) : (vals[b] < vals[a])) beaten++;
        else if (vals[b] === vals[a]) tied++;
      }
      pcts[a] = n > 1 ? Math.round(((beaten + tied / 2) / (n - 1)) * 100) : undefined; // v4.0.10 : une seule valeur = pas de comparaison → ABSENT (null côté appelant), pas un 50 faux neutre
    }
    return pcts;
  }

  // v4.0.8 : garde-fous financiers avant tout percentile qualité. Avec des capitaux propres
  // NÉGATIFS (P/B ≤ 0), le ROE et le D/E changent de signe et deviennent « bons » pour un
  // classement naïf (perte ÷ fonds propres négatifs = ROE positif) : non mesurables → null.
  // Un D/E négatif (fonds propres négatifs) est traité pareil. Les marges et croissances
  // NÉGATIVES restent des faits : elles participent (au bas du classement).
  function qMetricOf(e) {
    var bad = (e.pb != null && isFinite(e.pb) && e.pb <= 0); // fonds propres négatifs
    return {
      roe: (!bad && e.roe != null && isFinite(e.roe)) ? e.roe : null,
      mOp: (e.mOp != null && isFinite(e.mOp)) ? e.mOp : null,
      gRev: (e.gRev != null && isFinite(e.gRev)) ? e.gRev : null,
      de: (!bad && e.de != null && isFinite(e.de) && e.de >= 0) ? e.de : null
    };
  }

  // position dans la fourchette 52 s. : 0 = au plus bas, 100 = au plus haut (bornée).
  // gapLo = écart SIGNÉ au plus bas en % (négatif si le cours est SOUS la borne fournie),
  // dd52 = écart signé au plus haut en %. v4.0.12 (audit) : un cours HORS des bornes fournies
  // est signalé (out = -1 sous la fourchette, +1 au-dessus) au lieu d'être confondu avec une
  // position à l'extrémité — des bornes périmées ou un décrochage ne se lisent pas « au plus bas ».
  function pos52Of(e) {
    var lo = e.w52lo, hi = e.w52hi, px = e.px;
    if (lo == null || hi == null || !(hi > lo) || !(px > 0)) return { pos: null, gapLo: null, dd: null, out: 0 };
    var pos = Math.max(0, Math.min(100, ((px - lo) / (hi - lo)) * 100));
    var out = px < lo ? -1 : (px > hi ? 1 : 0);
    return { pos: Math.round(pos), gapLo: Math.round((px / lo - 1) * 1000) / 10, dd: Math.round((px / hi - 1) * 1000) / 10, out: out };
  }

  // enrichit la sortie de valScores : qScore (qualité, PAR SECTEUR, ≥ 3/4 métriques),
  // pos52/gapLo/dd52 (étiquette d'information, HORS score), earnWarn, oScore (💎 57/43).
  function oppScores(list) {
    var W = { roe: 0.35, mOp: 0.25, gRev: 0.2, de: 0.2 };
    var MIN_SEC = 8; // même seuil que la valorisation : mêmes référentiels, même transparence
    var MIN_MET = 5; // v4.0.12 (audit) : une métrique est sectorisée seulement si ≥ 5 observations valides dans le pool
    var clean = list.map(qMetricOf); // métriques nettoyées des non-sens financiers
    // regroupement sectoriel identique à valScores : secteurs ≥ 8 pairs → classement interne ;
    // le reste (secteur absent ou trop petit) → percentiles « vs indice » sur TOUTE la liste
    // nettoyée, comme le fait valScores pour ses propres métriques.
    var bySec = {};
    for (var i = 0; i < list.length; i++) {
      var sec = (typeof list[i].sec === "string" && list[i].sec) ? list[i].sec : null;
      if (!sec) continue;
      (bySec[sec] = bySec[sec] || []).push(i);
    }
    var groups = [];
    for (var s in bySec) {
      if (!Object.prototype.hasOwnProperty.call(bySec, s) || bySec[s].length < MIN_SEC) continue;
      groups.push(bySec[s]);
    }
    function secPct(field, lowerIsBetter, modeOut) {
      var out = {};
      var full = rankPctAny(clean, field, lowerIsBetter); // référentiel « vs indice »
      for (var j = 0; j < list.length; j++) { out[j] = full[j] != null ? full[j] : null; if (modeOut) modeOut[j] = "index"; }
      groups.forEach(function (g) {
        var sub = g.map(function (j) { return clean[j]; });
        // v4.0.12 : percentile sectoriel seulement si la métrique est assez couverte dans le secteur
        var n = 0;
        for (var k = 0; k < sub.length; k++) if (sub[k][field] != null) n++;
        if (n < MIN_MET) return; // trop peu d'observations → la métrique reste comparée à l'indice
        var p = rankPctAny(sub, field, lowerIsBetter);
        g.forEach(function (j, k) {
          out[j] = p[k] != null ? p[k] : null;
          if (modeOut && p[k] != null) modeOut[j] = "sector";
        });
      });
      return out;
    }
    var mRoe = {}, mOp = {}, mRev = {}, mDe = {};
    var pRoe = secPct("roe", false, mRoe), pOp = secPct("mOp", false, mOp),
        pRev = secPct("gRev", false, mRev), pDe = secPct("de", true, mDe);
    return list.map(function (e, i) {
      var o = {};
      for (var k in e) if (Object.prototype.hasOwnProperty.call(e, k)) o[k] = e[k];
      var s = 0, w = 0;
      if (pRoe[i] != null) { s += W.roe * pRoe[i]; w += W.roe; }
      if (pOp[i] != null) { s += W.mOp * pOp[i]; w += W.mOp; }
      if (pRev[i] != null) { s += W.gRev * pRev[i]; w += W.gRev; }
      if (pDe[i] != null) { s += W.de * pDe[i]; w += W.de; }
      var used = (pRoe[i] != null ? 1 : 0) + (pOp[i] != null ? 1 : 0) + (pRev[i] != null ? 1 : 0) + (pDe[i] != null ? 1 : 0);
      o.pRoe = pRoe[i] != null ? pRoe[i] : null;
      o.pOp = pOp[i] != null ? pOp[i] : null;
      o.pRev = pRev[i] != null ? pRev[i] : null;
      o.pDe = pDe[i] != null ? pDe[i] : null;
      o.qBase = used;
      // v4.0.12 : le mode dépend des métriques EFFECTIVEMENT utilisées — « mix » quand une
      // partie est sectorisée (pool assez couvert) et l'autre comparée à l'indice
      var qModes = [];
      if (pRoe[i] != null) qModes.push(mRoe[i]);
      if (pOp[i] != null) qModes.push(mOp[i]);
      if (pRev[i] != null) qModes.push(mRev[i]);
      if (pDe[i] != null) qModes.push(mDe[i]);
      o.qMode = qModes.length === 0 ? "index"
        : (qModes.every(function (m) { return m === "sector"; }) ? "sector"
        : (qModes.every(function (m) { return m === "index"; }) ? "index" : "mix"));
      o.qScore = (used >= 3 && w > 0) ? Math.round(s / w) : null; // v4.0.8 : 3/4 métriques exigées — 2/4 = données trop partielles, pas un avis
      // piège à valeur : PER prévisionnel AU-DESSUS du PER passé = bénéfices attendus en baisse
      // (le « pas cher » d'aujourd'hui est peut-être un effondrement des bénéfices de demain)
      o.earnWarn = (e.fper != null && e.per != null && e.fper > e.per) ? true : undefined;
      var p52 = pos52Of(e);
      o.pos52 = p52.pos; o.gapLo = p52.gapLo; o.dd52 = p52.dd; // INFO, hors score (v4.0.8)
      o.out52 = p52.out || 0; // v4.0.12 : -1 = cours SOUS la fourchette fournie, +1 = AU-DESSUS, 0 = dedans
      // composite 💎 : qualité 57 % + valorisation 43 % — point bas 52 s. exclu (cf. George & Hwang)
      o.oScore = (o.qScore != null && e.score != null) ? Math.round(0.57 * o.qScore + 0.43 * e.score) : null;
      return o;
    });
  }

  // signaux initiés FR (fenêtre 30 j) indexés par nom normalisé + ISIN → bonus de la vue croisée.
  // « Les initiés achètent pour une raison qu'ils connaissent » : on SURFAIT la valorisation du
  // marché, on ne remplace pas — bonus plafonné (15/10/4 pts par niveau de cluster), jamais un malus.
  function insiderFrBonus(frRows, opts) {
    var o = opts || {};
    var sigs = signalsFrom(pickBuyRows(frRows || []), { since: o.since || null });
    var byName = {}, byIsin = {};
    for (var i = 0; i < sigs.length; i++) {
      var s = sigs[i];
      var b = s.level >= 3 ? 15 : (s.level === 2 ? 10 : 4);
      var k = normName(s.societe);
      if (!byName[k] || byName[k].b < b) {
        byName[k] = { b: b, level: s.level, buys: s.buys, societe: s.societe };
      }
      if (s.isin && !byIsin[s.isin]) byIsin[s.isin] = byName[k];
    }
    return { byName: byName, byIsin: byIsin };
  }

  // attache le bonus initiés (ins, insLvl) + le score croisé (xScore = score + bonus) à la liste valorisée.
  function sbfEnrich(list, bonus) {
    bonus = bonus || { byName: {}, byIsin: {} };
    // correspondance société AMF ↔ nom Yahoo : l'égalité stricte ne suffit JAMAIS seule —
    // la déclaration dit « ROCHE BOBOIS SA », Yahoo dit « ROCHE BOBOIS », et 37/63 lignes FR
    // réelles n'ont pas d'ISIN. Règle : égalité, puis ISIN, puis préfixe AU MOT (« ROCHE
    // BOBOIS SA » commence par « ROCHE BOBOIS » ; « TOTAL » ne matche pas « TOTALENERGIES »
    // car on exige la frontière de mot), plus court des deux ≥ 4 caractères.
    function findHit(e) {
      var a = normName(e.n), d = normName(e.disp || "");
      if (e.isin && bonus.byIsin[e.isin]) return bonus.byIsin[e.isin];
      if (bonus.byName[a]) return bonus.byName[a];
      if (d && bonus.byName[d]) return bonus.byName[d];
      var ks = Object.keys(bonus.byName);
      for (var i = 0; i < ks.length; i++) {
        var k = ks[i];
        if (k.length < 4) continue;
        if (a.length >= 4 && (k.indexOf(a + " ") === 0 || a.indexOf(k + " ") === 0)) return bonus.byName[k];
        if (d.length >= 4 && (k.indexOf(d + " ") === 0 || d.indexOf(k + " ") === 0)) return bonus.byName[k];
      }
      return null;
    }
    return list.map(function (e) {
      var hit = findHit(e);
      var o = {};
      for (var k in e) if (Object.prototype.hasOwnProperty.call(e, k)) o[k] = e[k];
      o.ins = hit ? hit.b : 0;
      o.insLvl = hit ? hit.level : 0;
      // v4.0.12 (audit) : la composante initiés est NEUTRE (50/100) sans cluster d'achats —
      // l'ancienne formule (ins/15×100) donnait 0 à l'absence de signal, soit une pénalité
      // implicite de 5 points sur le score global, en contradiction avec « jamais de malus ».
      // Un cluster monte jusqu'à 100 : +15 → 100, +10 → 83, +4 → 63.
      o.insSc = Math.round(50 + (Math.max(0, Math.min(o.ins, 15)) / 15) * 50);
      o.xScore = o.score == null ? null : (o.score + o.ins);
      // v4.0.10 : LA liste unique 🏆 Long terme — demande de Jade : « une seule liste des
      // meilleures entreprises pour le long terme avec un point d'entrée intéressant et
      // justifiable ». Composition assumée (heuristique de tri, jamais validée sur historique) :
      //   qualité 55 %                → les meilleures entreprises : ROE/marge op./croissance/dette, PAR SECTEUR
      //   valorisation relative 35 %  → PER/rendement/P/B vs pairs (v4.0.12 : « point d'entrée » renommé —
      //                                 PER, rendement et P/B décrivent un écart de prix vs les pairs,
      //                                 pas le bon moment d'acheter)
      //   initiés FR 10 %            → la conviction des dirigeants : 50 NEUTRE sans signal, jusqu'à 100
      // Le contexte d'entrée est AFFICHÉ sans entrer dans le score : 📉 position 52 s. (info,
      // George & Hwang : momentum au plus HAUT), 🎯 potentiel consensus (avis du marché),
      // ⚠️ bénéfices attendus en baisse. oScore null (qualité ou valorisation manquante) → pas d'avis.
      o.ltScore = o.oScore == null ? null
        : Math.round(0.55 * o.qScore + 0.35 * o.score + 0.10 * o.insSc);
      // v4.0.6 : potentiel vs objectif de consensus (upside) — la carte 🎯 trie là-dessus.
      o.upX = (e.tp != null && e.px > 0 && isFinite(e.tp) && isFinite(e.px)) ? Math.round((e.tp / e.px - 1) * 1000) / 10 : null;
      return o;
    });
  }

  // tri des vues SBF 120 : "lt" = 🏆 Long terme (LA liste unique), "val" = score, "xins" = score
  // croisé, "cap" = capitalisation, "obj" = potentiel vs objectif de consensus analystes (upside)
  // — l'avis du marché, pas le nôtre. Les scores null (perte, pas d'objectif) restent en fin de liste — jamais cachés.
  function sbfSort(list, view) {
    var key = view === "xins" ? "xScore" : (view === "cap" ? "cap" : (view === "obj" ? "upX" : (view === "opp" ? "oScore" : (view === "lt" ? "ltScore" : "score"))));
    return list.slice().sort(function (a, b) {
      var va = a[key], vb = b[key];
      var na = va == null || !isFinite(va), nb = vb == null || !isFinite(vb);
      if (na && nb) return 0;
      if (na) return 1;
      if (nb) return -1;
      return vb - va;
    });
  }

  // ---------- v4.1.0 : 🇫🇷 CAC 40 — le classement d'achat (demande de Jade 10/11/2026) ----------
  // « Reprendre toutes les informations de chaque action et les classer selon l'importance
  // de l'avis d'achat, la meilleure opportunité — selon les résultats financiers, le consensus
  // et la macroéconomie. » Le score 🎯 d'achat du CAC 40 COMPOSE les briques déjà validées par
  // les revues de Jade (v4.0.5-v4.0.12) :
  //   qualité 40 %        → résultats financiers : ROE/marge op./croissance/dette, PAR SECTEUR (qScore)
  //   valorisation 25 %   → PER/rendement/P/B vs pairs (score de valScores)
  //   consensus 35 %     → percentile du potentiel vs objectif moyen (upX) — ENTRE dans le score
  //                        à la demande expresse de Jade pour CE classement. Note : l'onglet SBF 120
  //                        garde le consensus comme CONTEXTE non noté (décision v4.0.12) — les deux
  //                        lectures cohabitent volontairement, chacune affichée pour ce qu'elle est.
  // Les composantes manquantes RENORMALISENT les poids (convention vBase/qBase : la base est
  // affichée) ; ≥ 2 composantes sur 3 EXIGÉES (une seule = pas d'avis). Les percentiles restent
  // calculés sur TOUT le SBF coté (base identique aux autres scores, plus de pairs = rang plus
  // stable qu'un percentile calculé sur 40 valeurs seules). Les surprises EPS et la prochaine
  // date de publication (calendarEvents Yahoo) + la position 52 s. + les initiés restent des
  // ÉTIQUETTES de contexte AFFICHÉES, jamais notées — la macro frappe tout le monde pareil,
  // elle vit dans le bandeau 🌍. Heuristique de tri jamais validée sur historique : pas un conseil.

  // percentile du potentiel consensus (upX) sur la base fournie — higherIsBetter, ex æquo rang moyen
  function consPct(list) {
    return rankPctAny(list, "upX", false);
  }

  // enrichit la sortie de sbfEnrich : pUp (percentile consensus), aScore (composite renormalisé),
  // aBase (nb de composantes utilisées), verdict (🥇/🥈/🥉/⏸ — lecture, heuristique non validée)
  function cacScores(list) {
    var W = { q: 0.40, v: 0.25, c: 0.35 };
    var pUp = consPct(list);
    return list.map(function (e, i) {
      var o = {};
      for (var k in e) if (Object.prototype.hasOwnProperty.call(e, k)) o[k] = e[k];
      o.pUp = pUp[i] != null ? pUp[i] : null;
      var s = 0, w = 0, base = 0;
      if (o.qScore != null) { s += W.q * o.qScore; w += W.q; base++; }
      if (o.score != null) { s += W.v * o.score; w += W.v; base++; }
      if (o.pUp != null) { s += W.c * o.pUp; w += W.c; base++; }
      o.aBase = base;
      o.aScore = (base >= 2 && w > 0) ? Math.round(s / w) : null;
      o.verdict = o.aScore == null ? null
        : (o.aScore >= 70 ? "strong" : (o.aScore >= 55 ? "good" : (o.aScore >= 40 ? "mid" : "wait")));
      return o;
    });
  }

  // le groupe « cac40 » de la composition : LA source de vérité du périmètre — reconstruite chaque
  // mois par sbf120.yml (Wikipédia FR), l'onglet suit l'indice MÊME quand il change de composition.
  function cacFilter(list) {
    return (list || []).filter(function (e) { return e && e.g === "cac40"; });
  }

  // tri du classement d'achat : aScore décroissant, les scores null (composantes insuffisantes)
  // restent en fin de liste — jamais cachés
  function cacSort(list) {
    return list.slice().sort(function (a, b) {
      var va = a.aScore, vb = b.aScore;
      var na = va == null || !isFinite(va), nb = vb == null || !isFinite(vb);
      if (na && nb) return 0;
      if (na) return 1;
      if (nb) return -1;
      return vb - va;
    });
  }

  // macro du Radar Conjoncture (relevés publics data.json hebdo + data-daily.json) → état affichable :
  // champs validés, spread OAT-Bund en pb, direction BCE en liste blanche, âge en jours, périmé > 10 j.
  // La macro est un CONTEXTE affiché (bandeau 🌍), jamais une composante du score par valeur.
  function macroState(m, nowMs) {
    if (!m || typeof m !== "object") return null;
    var out = { dateData: m.dateData || null, dateMacro: m.dateMacro || null, src: m.source || null };
    ["vix", "vix5", "bund10", "oat10", "bceDepot", "inflZE", "pmiZE", "cape"].forEach(function (k) {
      out[k] = (m[k] != null && isFinite(m[k])) ? m[k] : null;
    });
    out.bceDir = ["hausse", "baisse", "stable"].indexOf(m.bceDir) >= 0 ? m.bceDir : null;
    out.spread = (out.oat10 != null && out.bund10 != null) ? Math.round((out.oat10 - out.bund10) * 100) : null;
    var age = null;
    if (out.dateData && /^\d{4}-\d{2}-\d{2}$/.test(out.dateData)) {
      var t = Date.parse(out.dateData + "T12:00:00Z");
      if (isFinite(t)) age = Math.floor(((nowMs || Date.now()) - t) / 86400000);
    }
    out.ageDays = age;
    out.stale = age != null && age > 10;
    return out;
  }

  function fmtCap(cap) {
    if (cap == null || !isFinite(cap)) return "—";
    if (cap >= 1e12) return (cap / 1e12).toFixed(2).replace(".", ",") + " T€";
    if (cap >= 1e9) return (cap / 1e9).toFixed(1).replace(".", ",") + " Md€";
    if (cap >= 1e6) return (cap / 1e6).toFixed(0) + " M€";
    return fmtNum(cap) + " €";
  }
  function fmtPct(v) {
    if (v == null || !isFinite(v)) return "—";
    var s = (v > 0 ? "+" : "") + String(Math.round(v * 100) / 100).replace(".", ",");
    return s + " %";
  }

  // lien cote en 1 tap — pas d'API marché (fragile, CORS) : on renvoie vers la recherche
  function quoteUrl(r) {
    if (r.source === "US") {
      return "https://www.google.com/finance/search?q=" + encodeURIComponent(String(r.ticker || r.societe || "").trim());
    }
    var id = String(r.isin || "").trim();
    return "https://www.boursorama.com/recherche/?query=" + encodeURIComponent(id || String(r.societe || "").trim());
  }
  function fmtPx(r, px) {
    if (px == null || !isFinite(px)) return "\u2014";
    return fmtNum(px) + (r.source === "US" ? " $" : " \u20ac");
  }

  return {
    VERSION: VERSION,
    CFG: CFG,
    esc: esc, decodeEntities: decodeEntities, stripTags: stripTags,
    frNum: frNum, ddmmyyyyToIso: ddmmyyyyToIso, isoToDmY: isoToDmY, frDate: frDate, isoDay: isoDay, daysBetween: daysBetween,
    parseSwaoo: parseSwaoo, swaooCount: swaooCount,
    parseIssuerDisplay: parseIssuerDisplay, parseFts: parseFts, form4Url: form4Url, parseForm4: parseForm4, usRowsFrom: usRowsFrom,
    frNextPage: frNextPage,
    mergeRows: mergeRows,
    filterRows: filterRows, sortRows: sortRows,
    fmtEUR: fmtEUR, fmtUSD: fmtUSD, fmtNum: fmtNum, fmtMontant: fmtMontant, lagLabel: lagLabel, freshness: freshness,
    normName: normName, sigKey: sigKey, personKey: personKey, signalsFrom: signalsFrom, signalCountByKey: signalCountByKey, quoteUrl: quoteUrl, fmtPx: fmtPx,
    rowsOfSide: rowsOfSide,
    pickBuyRows: pickBuyRows,
    sellStatsByKey: sellStatsByKey, insiderScoreFor: insiderScoreFor, fundScore: fundScore,
    xbrlAnnuals: xbrlAnnuals, fundFromXbrl: fundFromXbrl, pickCandidates: pickCandidates, picksFrom: picksFrom, picksFromFr: picksFromFr,
    rankPct: rankPct, valScores: valScores, oppScores: oppScores, rankPctAny: rankPctAny, pos52Of: pos52Of, qMetricOf: qMetricOf, insiderFrBonus: insiderFrBonus, sbfEnrich: sbfEnrich, sbfSort: sbfSort, fmtCap: fmtCap, fmtPct: fmtPct,
    consPct: consPct, cacScores: cacScores, cacFilter: cacFilter, cacSort: cacSort, macroState: macroState
  };
})();
if (typeof module !== "undefined" && module.exports) { module.exports = RI; }
