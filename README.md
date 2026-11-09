# 👁 Sentinelle perso

PWA installable : achats **et ventes** d'initiés **🇫🇷 AMF (France)** + **🇺🇸 SEC Form 4 (US)**, relevés automatiquement.

- **App** : https://jeffbuzz060684.github.io/sentinelle--perso/
- **Relevé** : workflow GitHub Actions **toutes les 2 h en jours ouvrés** (cron 05:07 → 23:07 UTC, soit 6h07/7h07 → 0h07/1h07 Paris selon la saison — le dernier run couvre les dépôts US de fin de journée ET) — `insiders.yml` : commite `data.json` **et** `state.json`, **redéploie Pages uniquement si les listes ont changé** (pas pour les horodateurs)
- **Sources** (publiques, officielles) :
  - FR : déclarations AMF des dirigeants (art. L.621-18-2, publiées sous 3 jours ouvrés), via le service d'agrégation transactions-amf.swaoo.com — **acquisitions et cessions ≥ 1 000 €**
  - US : formulaires **Form 4** de la SEC (dépôt sous 2 jours ouvrés) via EDGAR — achats code **P** (≥ 1 000 $) et ventes code **S** : d'après les instructions officielles de la SEC, ces codes couvrent des transactions « au marché **ou privées** » (le libellé de l'app le dit honnêtement) ; conversions (J), levées d'options (M), attributions (A) et cadeaux/dons (F/G) exclus des deux côtés
- **Fiabilité (v3.1)** :
  - un Form 4 en erreur de téléchargement (429/500/503) **n'est pas marqué traité** — il est retéléchargé au run suivant, plus aucune déclaration perdue
  - **canaris du scraper** : si swaoo (ou le parseur US) change de structure, le run **échoue** au lieu de publier silencieusement 0 ligne ; garde anti-effondrement (−50 % ⇒ version précédente conservée)
  - **fraîcheur par source** : `frUpdated`/`usUpdated` + bandeau d'état dans l'UI (⚠️ échec ou source figée), au lieu d'un « il y a 2 h » trompeur
  - User-Agent SEC avec contact réel (`RI_SEC_CONTACT`, secret GitHub), backoff `Retry-After` sur 429/503, `state.json` purgé par date (40 j)
  - service worker **réellement enregistré** (cache `sentinelle-perso-v3.1`)
- **Signaux (v2)** : détection des sociétés où les initiés **s'accumulent** (≥ 2 achats sur 90 j) — nb d'achats, **nb d'initiés distincts** (🔥🔥 cluster), total, **prix moyen payé par les initiés**, lien cote (Boursorama ISIN / Google Finance ticker), filtre 🆕 « publiés depuis ta dernière visite »
- **Ventes (v3)** : segment 🟢 Achats (défaut) / 🔴 Ventes / les deux, carte « 🔴 Initiés qui vendent » (vendeurs distincts, total, prix moyen vendu) — les ventes US extraites des mêmes Form 4 (zéro requête en plus). ⚠️ Une vente peut être un plan de vente programmé ou une diversification, pas forcément un mauvais signal : les lignes vendues sous plan **⚙ 10b5-1** (déclaré dans le Form 4) ou liées à une levée d'options **🪜** (code M dans le même dépôt) sont taguées comme telles. L'historique US des ventes commence à la v3 (fenêtre FTS 3 j).
- **Fichiers** : `index.html` (UI), `logic.js` (logique pure partagée navigateur/Node), `sw.js` (PWA, réseau d'abord), `data.json` (données du relevé : `fr`/`us` achats, `frS`/`usS` ventes, `frOk`/`usOk`/`frUpdated`/`usUpdated` état des sources), `state.json` (déduplication US), `tools/` (relevé, harnais, validation, icônes)

## Tests

```bash
node tools/test.js           # harnais complet, 0 échec obligatoire avant déploiement
node tools/validate-data.js  # schéma data.json
node tools/sim-dom.js        # exécuté dans le harnais (chargement complet de la page)
node tools/fetch-insiders.js # relevé manuel (RI_BUDGET=800 pour un premier chargement)
```

Le harnais couvre aussi le pipeline réseau **sans réseau** : `fetch` injecté pour simuler un 429/500 SEC (accession non marquée), un succès (marquage + tags 10b5-1/levée) et un scraper cassé (canari).

⚠️ Outil d'information, pas un conseil en investissement. Aucune donnée personnelle dans ce dépôt public.
