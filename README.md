# 👁 Sentinelle perso

PWA installable : achats **et ventes** d'initiés **🇫🇷 AMF (France)** + **🇺🇸 SEC Form 4 (US)**, relevés automatiquement — avec **signaux nettoyés**, **pistes US/FR** et **notifications**.

- **App** : https://jeffbuzz060684.github.io/sentinelle--perso/
- **Relevé** : workflow GitHub Actions `insiders.yml` :
  - **toutes les 2 h en jours ouvrés** (cron 05:07 → 23:07 UTC, soit 6h07/7h07 → 0h07/1h07 Paris selon la saison — le dernier run couvre les dépôts US de fin de journée ET) ;
  - **+ un run à 02:07 UTC du mardi au samedi** (3h07/4h07 Paris), pour couvrir les dépôts US de 18 h à 22 h ET qui arrivent après le dernier run de la journée ;
  - commite `data.json` **et** `state.json` ; **redéploie Pages si les données OU les statuts changent** (seuls les horodateurs `updated`/`frUpdated`/`usUpdated` et `counts` sont ignorés : un flip `frOk`/`usOk` déploie, pour que le bandeau d'état de l'app reflète une panne même sans nouvelle transaction).
- **Sources** (publiques, officielles) :
  - FR : déclarations AMF des dirigeants (art. L.621-18-2, publiées sous 3 jours ouvrés), via le service d'agrégation transactions-amf.swaoo.com — **acquisitions et cessions ≥ 1 000 €** ;
  - US : formulaires **Form 4** de la SEC (dépôt sous 2 jours ouvrés) via EDGAR — achats code **P** (≥ 1 000 $) et ventes code **S** : d'après les [codes officiels](https://www.sec.gov/edgar/searchedgar/ownershipformcodes.html), P = « Open market or private purchase », S = « Open market or private sale » — marché **ou transactions privées** (l'app le dit honnêtement). Conversions (J), levées d'options (M), attributions (A) et cadeaux/dons (F/G) exclus des deux côtés.
- **Ventes US « dures » uniquement (v3.3)** : ne sont collectées que les ventes **≥ 50 k$** **sans plan 10b5-1 déclaré** (`aff10b5One`) **et sans code M dans le dépôt**. Raison : les liquidations programmées/neutres noyaient le signal (380 ventes en une seule journée rendaient la fenêtre « 90 j » réelle de ~2 jours), et elles ne sont pas des signaux baissiers. ⚠️ Le code M reste un constat au niveau du **dépôt**, pas de la transaction : le XML ne prouve pas le lien ligne à ligne.
- **Fiabilité (v3.1 → v3.3)** :
  - un Form 4 en erreur de téléchargement (429/500/503) **n'est pas marqué traité** — retéléchargé au run suivant ; une réponse **200 qui n'est pas un Form 4** (page HTML de limitation) non plus ;
  - **`Retry-After` honoré aussi sur les XML** (retry ×2) ;
  - **disjoncteur** : 5 erreurs XML consécutives ⇒ le reste du run est abandonné (retenté au prochain) ; **ratio d'erreur > 30 % (≥ 5 tentées) ⇒ `usOk=false`** — une panne SEC massive ne passe plus pour un succès ;
  - **canaris du scraper** : swaoo ou le parseur US change de structure ⇒ le run **échoue** au lieu de publier 0 ligne en silence ;
  - **garde anti-effondrement séparée de la rétention** : on ne compare que les lignes précédentes **encore dans la fenêtre 90 j** (−50 % dessus ⇒ version précédente conservée) ; l'expiration naturelle des vieilles lignes n'est plus confondue avec une panne ;
  - **fraîcheur par source** : `frUpdated`/`usUpdated` rafraîchis **uniquement si le relevé a réussi et été retenu**, `frOk`/`usOk` publiés sur Pages (bandeau ⚠️ dans l'UI : échec ou source figée) ;
  - **`state.json` purgé pour de vrai (40 j)** : chaque accession garde sa **date d'origine** (le bug v3.1.1 redatait tout au jour du run, donc la purge ne purgeait rien) ;
  - User-Agent SEC avec contact réel (`RI_SEC_CONTACT`, secret GitHub — warning dans le workflow s'il manque) ;
  - un `data.json`/`state.json` **illisible fait échouer le run** (exit 1) au lieu d'écraser les données avec des tableaux vides ;
  - service worker réellement enregistré (cache `sentinelle-perso-v3.3`, **timeout réseau 3,5 s** puis repli cache).
- **Migration v4** : les lignes US de la v3.1.1 avaient des ids incomplets (5 segments, sans prix) et aucun tag plan/levée. Au premier run v3.3 : ventes < 50 k$ purgées, lignes à ancien id de la fenêtre 3 j **supprimées puis re-téléchargées** avec le nouveau format (pas de doublons), mémoire US réinitialisée.
- **Signaux nettoyés (v3.3)** : cartes « accumulation » et « ventes » sur **30 j** (les listes brutes restent 90 j), et :
  - **regroupement par personne physique** : les véhicules « personne morale liée à X » comptent pour X (cas KLEA : 2 holdings = 1 initié, pas 2) ;
  - **dédoublonnage des opérations identiques** (même société/date/volume/prix re-déclarées) : cas Silynxcom = 2 achats, pas 4 ;
  - tri niveau → **récence** du dernier achat → total (un cluster tout frais prime sur un gros cluster ancien) ;
  - **⚠ déclarants multiples** : un Form 4 peut être déposé par plusieurs déclarants ([instructions SEC du Form 4](https://www.sec.gov/about/forms/form4.pdf)) — la ligne est attribuée au premier, avec badge ⚠ (attribution incertaine).
- **💡 Pistes à étudier (v3.2/v3.3)** : classement maison — **🇺🇸 sur /20** = signal initiés /10 + fondamentaux /10 (croissance, rentabilité, marge nette des **comptes 10-K** via l'API XBRL officielle de la SEC, sans clé) ; **🇫🇷 sur /10** = signal initiés nettoyé seul (pas d'équivalent public et gratuit du 10-K pour les sociétés françaises — c'est dit honnêtement dans la carte). Seuils identiques des deux côtés : un vrai cluster (score initiés ≥ 4), pas un achat isolé. **Outil de tri pour la recherche, pas un conseil d'achat.** Recalcul par le workflow quand les listes bougent (sinon 1×/jour) ; XBRL injoignable ⇒ pistes précédentes conservées.
- **🔔 Notifications (v3.3)** : le workflow pousse un message [ntfy.sh](https://ntfy.sh) quand (1) un **nouveau cluster 🔥🔥** apparaît (≥ 2 initiés distincts sur 30 j) ou (2) un **achat ≥ 100 k** est fait par un dirigeant/administrateur (les fonds à 10 % ne comptent pas). Comparaison par **clés naturelles** (société|auteur|date|volume|prix) : la migration v4 ne re-notifie pas les anciennes lignes. Topic en **secret GitHub `NTFY_TOPIC`** (le dépôt est public) ; secret absent ⇒ aucune notification, le run continue. Max 5 messages par run.
- **Pagination (v3.3)** : « Afficher plus » par centaines — « Achats + ventes » affichait ~545 lignes d'un coup.

## Tests

```bash
node tools/test.js           # harnais complet, 0 échec obligatoire avant déploiement
node tools/validate-data.js  # schéma data.json (+ pistes us/fr)
node tools/sim-dom.js        # exécuté dans le harnais (chargement complet de la page)
node tools/fetch-insiders.js # relevé manuel (RI_BUDGET=800 pour un premier chargement)
```

Le harnais couvre le pipeline **sans réseau** (`fetch` injecté, tests **comportementaux** sérialisés — plus de grep du source) : 429/500 SEC (accession non marquée + Retry-After honoré), réponse 200 invalide (non marquée), **disjoncteur** (5 erreurs consécutives), **canari parseur** (400 XML, 0 ligne), **migration v4** (purge < 50 k$, re-téléchargement des anciens ids), purge d'état avec date d'origine conservée, garde anti-effondrement vs rétention, **alertes** (cluster nouveau, gros achat dirigeant, fonds 10 % ignoré, pas de spam), **ntfy** (URL, titre, topic vide = no-op), pistes US+FR, XBRL en cascade d'étiquettes, échec = pistes conservées.

⚠️ Outil d'information, pas un conseil en investissement. Aucune donnée personnelle dans ce dépôt public.
