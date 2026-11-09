# Sentinelle perso

Suivi des **achats d'initiés** — France (AMF/BDIF) + États-Unis (SEC EDGAR), mis à jour **automatiquement toutes les heures**.

## Sources

| Zone | Source | Fréquence |
| --- | --- | --- |
| 🇫🇷 | [Transactions dirigeants AMF](https://transactions-amf.swaoo.com) (miroir du BDIF officiel) | horaire |
| 🇫🇷 | Flux RSS officiel [BDIF AMF](https://bdif.amf-france.org) — filet de sécurité | horaire |
| 🇺🇸 | [SEC EDGAR Full-Text Search](https://efts.sec.gov) — Form 4, code **P** (achat) | horaire |

Délais légaux de publication : **3 jours ouvrés** (AMF), **2 jours ouvrés** (SEC). Les achats ≥ 10 000 €/$ sont surlignés.

## Fonctionnement

- GitHub Actions (`.github/workflows/scan.yml`) scanne toutes les heures → `data.json` → commit + redéploiement.
- PWA installable, fonctionne hors ligne (cache réseau-priorité).
- Les **nouveaux achats** depuis la dernière consultation sont marqués 🆕.
- Zéro API privée, zéro clé : tout vient de sources publiques ; aucune donnée personnelle n'est stockée.

## Démarrage

```bash
node tools/test-insiders.js   # 77 tests
node tools/sim-dom.js          # 24 tests
node tools/fetch-insiders.js  # scan live → data.json
node tools/validate-data.js   # garde-fou avant déploiement
```

## Avertissement

Les déclarations d'initiés sont des **informations publiques réglementées**. Cet outil les regroupe pour consultation ; il ne s'agit **pas** d'un conseil en investissement. Un achat d'initié peut avoir de nombreuses motivations (plan d'achat programmé, compensation…) qui n'impliquent aucune anticipation particulière.
