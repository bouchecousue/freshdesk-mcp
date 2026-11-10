# Installation et déploiement

[English](../en/setup.md) · [README](../../README.fr.md)

## Installation locale

Utiliser Node 22 ou 24, npm et un répertoire local accessible en écriture. `better-sqlite3` nécessite un binaire natif compatible ; en l'absence de binaire précompilé, installer les outils de compilation nécessaires à cette dépendance. Python 3 sert uniquement au lecteur d'export optionnel.

Suivre le démarrage rapide du README. Le serveur ne charge pas automatiquement `.env` : utiliser `node --env-file=.env` ou injecter les variables avec le gestionnaire de services. `npm start` et `npm run dev` supposent l'environnement déjà chargé. Ne jamais committer `.env` ni utiliser une vraie clé dans les tests.

Le générateur de clé maîtresse produit 32 octets aléatoires encodés en base64url. Utiliser une clé distincte par installation et la conserver en lieu sûr : une nouvelle clé ne déchiffre pas la base existante.

## Configuration

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development`, `test` ou `production` |
| `HOST` | `127.0.0.1` | Adresse d'écoute ; conserver la boucle locale derrière un proxy |
| `PORT` | `8788` | Port d'écoute, 1024–65535 |
| `PUBLIC_URL` | Origine locale | Origine externe sans chemin, identifiants, requête ni fragment ; obligatoire en production |
| `DATABASE_PATH` | `./var/freshdesk-mcp.sqlite3` | Base SQLite ; les chemins relatifs dépendent du répertoire de travail |
| `FRESHDESK_MCP_MASTER_KEY` | Obligatoire | Encodage base64/base64url d'exactement 32 octets |
| `ACCESS_TOKEN_TTL_SECONDS` | `900` | Durée du jeton d'accès, 300–3600 |
| `REFRESH_TOKEN_TTL_SECONDS` | `2592000` | Durée du refresh token, 3600–31536000 |
| `AUTH_CODE_TTL_SECONDS` | `300` | Durée du code d'autorisation, 60–600 |
| `AUTH_REQUEST_TTL_SECONDS` | `600` | Durée de la demande d'autorisation, 60–1800 |
| `WRITE_INTENT_TTL_SECONDS` | `600` | Durée d'une intention d'écriture, 60–1800 |
| `CIMD_ALLOWED_HOST_SUFFIXES` | `chatgpt.com,openai.com` | Suffixes autorisés des hôtes de métadonnées client, séparés par des virgules |
| `FRESHDESK_EMBEDDING_URL` | `http://127.0.0.1:9932/v1/embeddings` | Endpoint local optionnel d'embeddings ; voir le guide sémantique |

HTTP n'est accepté que pour les origines locales en développement. HTTPS est obligatoire en production. Les hôtes de métadonnées autorisés par défaut ciblent ChatGPT ; les autres clients peuvent nécessiter une configuration explicite et des tests d'interopérabilité.

## Déploiement distant

1. Installer ce dépôt sur votre hôte, puis exécuter `npm ci` et `npm run build`.
2. Utiliser un compte de service dédié, un répertoire de travail persistant et un fichier d'environnement accessible uniquement à ce compte. Définir un umask restrictif, par exemple `077`.
3. Définir `NODE_ENV=production`, `PUBLIC_URL=https://mcp.example.com` et un `DATABASE_PATH` absolu hors du code source. Injecter la clé maîtresse depuis votre gestionnaire de secrets ou votre fichier d'environnement protégé.
4. Exécuter `node dist/src/index.js` avec un gestionnaire de services. Configurer le redémarrage et conserver la base et la clé maîtresse pendant les mises à jour.
5. Relayer l'origine HTTPS vers `http://127.0.0.1:8788` avec votre reverse proxy ou tunnel. Préserver l'en-tête Host externe, les paramètres OAuth, les en-têtes Authorization et les réponses en streaming. Ne pas mettre OAuth/MCP en cache ni journaliser les identifiants.
6. Vérifier `/health`, `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource/mcp` et le challenge `401` de `/mcp` sans authentification.

Aucun service propre à un hôte, jeton de tunnel, configuration DNS ou endpoint hébergé n'est fourni. Configurer ces éléments pour votre installation. Le dépôt ne déploie aucun service automatiquement.

## Connexion d'un client

Utiliser l'endpoint HTTPS `/mcp` de votre serveur avec OAuth. La découverte expose les endpoints d'autorisation, de jetons, d'enregistrement et de révocation. Le parcours prend en charge PKCE S256 et les scopes `freshdesk:read`, `freshdesk:write` et `offline_access`.

Dans la page d'autorisation, saisir le domaine natif `your-tenant.freshdesk.com` et votre clé API Freshdesk personnelle. Les domaines personnalisés sont refusés. Le serveur vérifie l'identité de l'agent et chiffre sa clé localement ; il ne la transmet pas au client MCP. Celui-ci reçoit des jetons OAuth MCP.

Pour ChatGPT, suivre le [guide officiel actuel](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt) ; les permissions du workspace et capacités du client s'appliquent. Examiner les outils découverts, appeler `freshdesk_health` et `freshdesk_me`, puis tester une lecture de ticket. Actualiser les définitions des outils après une mise à jour. Vérifier séparément les écritures sur un ticket de test.

## Diagnostic

| Symptôme | Vérification |
| --- | --- |
| Erreur du module natif SQLite | Même version majeure de Node pour `npm ci` et l'exécution ; réinstaller après un changement de Node |
| Environnement refusé au démarrage | Longueur de clé, origine HTTPS en production et plages de variables acceptées |
| Échec du retour OAuth | Origine publique, transmission de Host, URI de retour et scopes du client |
| Rejet Freshdesk | Droits de l'agent, domaine natif, clé API et quotas |
| Recherche sémantique indisponible | Service d'embeddings et worker optionnels ; les outils classiques n'en dépendent pas |
| Écriture non vérifiée | Examiner `writeApplied`, `readbackVerified` et `verificationIssues` ; aucun rejeu automatique |

Utiliser les identifiants de corrélation et journaux expurgés pour le diagnostic. Ne jamais joindre de dump, clé API ou contenu de ticket à une issue publique.
