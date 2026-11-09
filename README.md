# 👁 Sentinelle perso

PWA installable : achats **et ventes** d'initiés **🇫🇷 AMF (France)** + **🇺🇸 SEC Form 4 (US)**, relevés automatiquement.

- **App** : https://jeffbuzz060684.github.io/sentinelle--perso/
- **Relevé** : workflow GitHub Actions **toutes les 2 h en jours ouvrés** (6h07 → 22h07 Paris) — `insiders.yml` (commite `data.json` **et** `state.json`, valide puis redéploie)
- **Sources** (publiques, officielles) :
  - FR : déclarations AMF des dirigeants (art. L.621-18-2, publiées sous 3 jours ouvrés), via le service d'agrégation transactions-amf.swaoo.com — **acquisitions et cessions ≥ 1 000 €**
  - US : formulaires **Form 4** de la SEC (dépôt sous 2 jours ouvrés) via EDGAR — **au marché uniquement** : achats code **P** (≥ 1 000 $) et ventes code **S** ; conversions (J), levées d'options (M), attributions (A) et cadeaux/dons (F/G) exclus des deux côtés
- **Signaux (v2)** : détection des sociétés où les initiés **s'accumulent** (≥ 2 achats sur 90 j) — nb d'achats, **nb d'initiés distincts** (🔥🔥 cluster), total, **prix moyen payé par les initiés**, lien cote (Boursorama ISIN / Google Finance ticker), filtre 🆕 « publiés depuis ta dernière visite »
- **Ventes (v3)** : segment 🟢 Achats / 🔴 Ventes / les deux, carte « 🔴 Initiés qui vendent » (vendeurs distincts, total, prix moyen vendu) — les ventes US extraites des mêmes Form 4 (zéro requête en plus). ⚠️ Une vente peut être un plan de vente programmé (10b5-1) ou une diversification, pas forcément un mauvais signal : comparer au profil d'achat. L'historique US des ventes commence à la v3 (fenêtre FTS 3 j).
- **Fichiers** : `index.html` (UI), `logic.js` (logique pure partagée navigateur/Node), `sw.js` (PWA, réseau d'abord), `data.json` (données du relevé : `fr`/`us` achats, `frS`/`usS` ventes), `state.json` (déduplication US), `tools/` (relevé, harnais, validation, icônes)

## Tests

```bash
node tools/test.js           # harnais complet (0 échec obligatoire avant déploiement)
node tools/validate-data.js  # schéma data.json
node tools/sim-dom.js         # exécuté dans le harnais (chargement complet de la page)
node tools/fetch-insiders.js # relevé manuel (RI_BUDGET=800 pour un premier chargement)
```

⚠️ Outil d'information, pas un conseil en investissement. Aucune donnée personnelle dans ce dépôt public.
