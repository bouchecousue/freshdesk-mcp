# Freshdesk MCP

[English](README.md) · [Français](README.fr.md)

Un serveur Model Context Protocol auto-hébergé développé par **BoucheCousue** pour Freshdesk : accès individuel par agent, contexte des tickets, historique client, actions contrôlées et recherche sémantique locale optionnelle.

Chaque utilisateur connecte son tenant Freshdesk et sa clé API personnelle via le parcours OAuth du serveur. Les appels Freshdesk utilisent les droits natifs de cet agent. Ce projet communautaire n'est pas un produit officiel Freshworks.

## Fonctionnalités

- **24 outils MCP** pour les tickets, contacts, sociétés, agents, groupes, connaissances et recherches sémantiques.
- OAuth avec code d'autorisation et PKCE S256, découverte des métadonnées client, enregistrement dynamique et refresh tokens rotatifs.
- Clés API chiffrées en AES-256-GCM ; stockage SQLite local.
- Ticket Cockpit pour les clients MCP Apps : conversations, SLA, attribution et métadonnées des pièces jointes.
- Écritures avec aperçu immuable à durée limitée, confirmation interactive, intention à usage unique et vérification par relecture. Aucun rejeu automatique d'une écriture incertaine.
- Recherche sémantique optionnelle sur un historique indexé localement, avec vérification des accès avant restitution des sources.

L'implémentation cible MCP `2026-07-28` et ChatGPT. Le support d'OAuth, de MCP Apps et de la confirmation interactive dépend du client : vérifier celui que vous souhaitez utiliser. Les pages de connexion et une partie de l'interface sont actuellement en français ; la documentation existe dans les deux langues.

## Démarrage rapide

Utiliser **Node.js 22 ou 24** et npm. Installer et exécuter avec la même version majeure de Node, car SQLite utilise un module natif.

```bash
git clone https://github.com/bouchecousue/freshdesk-mcp.git
cd freshdesk-mcp
npm ci
cp .env.example .env
chmod 600 .env
npm run --silent generate-master-key
```

Copier la valeur générée dans `FRESHDESK_MCP_MASTER_KEY` de votre `.env` local, puis :

```bash
npm run build
node --env-file=.env dist/src/index.js
```

Dans un autre terminal :

```bash
curl -fsS http://127.0.0.1:8788/health
curl -i http://127.0.0.1:8788/mcp
```

La route de santé renvoie l'état du service ; `/mcp` sans authentification renvoie `401` et les informations de découverte OAuth. Cela ne vérifie pas encore la connexion Freshdesk : connecter un agent et appeler `freshdesk_health`.

Pour un client distant, publier via votre propre reverse proxy ou tunnel HTTPS et définir `NODE_ENV=production` et `PUBLIC_URL=https://mcp.example.com`. L'endpoint devient `https://mcp.example.com/mcp`. Consulter le guide de déploiement avant d'exposer le service.

## Documentation

| Guide | English | Français |
| --- | --- | --- |
| Installation, configuration et déploiement | [Setup](docs/en/setup.md) | [Installation](docs/fr/setup.md) |
| Outils, pagination et écritures contrôlées | [Tools](docs/en/tools.md) | [Outils](docs/fr/tools.md) |
| Stockage, accès et exploitation | [Security](docs/en/security.md) | [Sécurité](docs/fr/security.md) |
| Recherche sémantique et indexation optionnelles | [Semantic search](docs/en/semantic-search.md) | [Recherche sémantique](docs/fr/semantic-search.md) |

## Développement

```bash
npm ci
npm run check
node --env-file=.env --import tsx --watch src/index.ts
```

`check` exécute le contrôle TypeScript, les tests simulés et le build de production. Les tests ne nécessitent ni compte Freshdesk réel ni secret de production. GitHub Actions exécute ces contrôles sous Node 22 et 24 et recherche les secrets dans l'historique Git.

Ce dépôt contient le code, des tests synthétiques et des exemples génériques. Il ne contient pas d'identifiants, d'exports clients, de bases d'exploitation, de journaux ou de configuration de déploiement privée. Les fichiers d'exploitation restent hors de Git ; voir [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence et références

[MIT](LICENSE), copyright BoucheCousue. Les dépendances et modèles d'embeddings optionnels conservent leurs propres licences ; les poids des modèles ne sont pas inclus.

[API Freshdesk](https://developers.freshdesk.com/api/) · [Spécification MCP](https://modelcontextprotocol.io/specification/2026-07-28) · [Connexion MCP dans ChatGPT](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt)
