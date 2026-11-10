# 🇫🇷 Sentinelle perso — classement d'achat CAC 40

PWA installable, **app monovue** : les 40 valeurs du CAC 40 classées selon le score d'achat 🎯 de Jade, avec le contexte macroéconomique 🌍 et le détail complet au tap. Les anciens onglets (initiés AMF/SEC, SBF 120) ont été retirés à la demande de Jade (« une seule et même application ») — le classement EST la page.

- **App** : https://jeffbuzz060684.github.io/sentinelle--perso/
- **Jumeau** : le même classement est aussi un onglet 🇫🇷 CAC 40 du Radar Conjoncture (app unique de suivi).

## Score 🎯 (heuristique de tri, jamais validée — pas un conseil)

**Qualité 40 %** (ROE, marge op., croissance CA, dette/CP — percentiles vs secteur ou indice) + **valorisation 25 %** (PER, rendement, P/B vs pairs) + **consensus 35 %** (potentiel vs objectif moyen des analystes). Composante manquante → poids renormalisés, **≥ 2/3 exigées** (base affichée au tap). Percentiles calculés sur **tout le SBF coté** puis filtre du groupe « cac40 » : le périmètre suit la composition de l'indice automatiquement. Verdicts : 🥇 ≥ 70 priorité · 🥈 55-69 opportunité · 🥉 40-54 neutre · ⏸ < 40 attendre.

## Données

- **Cotes** : `quotes.json` (même origine), rafraîchi en séance par le workflow `quotes.yml` (pings horaires — les schedules GitHub natifs ne partent pas sur ce compte). **Différé ~15 min, honnêtement affiché.** Repli TradingView si Yahoo sature (429) ; dans ce cas qualité/consensus dorment jusqu'au retour de Yahoo (dégradation propre : score sur les composantes disponibles, base ≥ 2/3).
- **Résultats financiers** : surprise EPS + prochaine date de publication (module Yahoo `calendarEvents`).
- **Macro 🌍** : relevés publics du **Radar Conjoncture** (https://jeffbuzz060684.github.io/radar-conjoncture/) transportés dans `quotes.json` — VIX, OAT/Bund 10 ans, spread, BCE, inflation, PMI, CAPE. **Contexte, jamais notée.** Si le Radar n'est plus mis à jour, la carte affiche « relevé ancien ».
- **Composition** : `sbf120.json` reconstruit chaque mois (Wikipédia) par `sbf120.yml` — déclenché par un commit sur `.github/ping-compo` (tâche planifiée externe).
- ⚠️ **URW.PA** : non éligible en principe au PEA (foncière/REIT) — badge affiché.

## Hors ligne

Cache `localStorage` du dernier relevé : le classement reste affiché sans réseau. Service worker `sentinelle-perso-v6` (timeout réseau 3,5 s puis repli cache). **Ne jamais effacer le stockage du site.**

## Arrière-plan inchangé

Les workflows `insiders.yml` (déclarations AMF/SEC), `quotes.yml` (cotes + objectifs + macro), `sbf120.yml` (composition) et `pages.yml` (déploiement + secours de régénération) continuent de tourner — gratuits et réversibles. `tools/test.js` (+ `tools/sim-dom.js`) : harnais complet à 0 échec avant chaque push.
