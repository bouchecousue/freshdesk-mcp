# Freshdesk MCP

[English](README.md) · [Français](README.fr.md)

A self-hosted Model Context Protocol server by **BoucheCousue** for Freshdesk: agent-specific access, ticket context, customer history, controlled ticket actions and optional local semantic search.

Each user connects their own Freshdesk tenant and personal API key through the server's OAuth flow. Freshdesk calls use that agent's native permissions. This is a community project, not an official Freshworks product.

## Features

- **24 MCP tools** for tickets, contacts, companies, agents, groups, knowledge and semantic search.
- OAuth authorization code + PKCE S256, client metadata discovery, dynamic registration and rotating refresh tokens.
- API keys encrypted with AES-256-GCM; local SQLite storage.
- Ticket Cockpit interface for MCP Apps clients, with conversations, SLA, ownership and attachments metadata.
- Writes use an immutable, expiring preview, interactive confirmation, a single-use intent and readback verification. Uncertain writes are never retried automatically.
- Optional semantic search over locally indexed history, with fresh access checks before returning evidence.

The implementation targets MCP `2026-07-28` and ChatGPT. Client support for OAuth, MCP Apps and interactive confirmation varies; verify your intended client. Connection pages and parts of the interface currently use French; the documentation is available in both languages.

## Quick start

Use **Node.js 22 or 24** and npm. Install and run with the same Node major version because SQLite uses a native module.

```bash
git clone https://github.com/bouchecousue/freshdesk-mcp.git
cd freshdesk-mcp
npm ci
cp .env.example .env
chmod 600 .env
npm run --silent generate-master-key
```

Copy the generated value into `FRESHDESK_MCP_MASTER_KEY` in your local `.env`. Then:

```bash
npm run build
node --env-file=.env dist/src/index.js
```

In another terminal:

```bash
curl -fsS http://127.0.0.1:8788/health
curl -i http://127.0.0.1:8788/mcp
```

The health route returns service status; an unauthenticated `/mcp` request returns `401` with OAuth discovery information. This does not yet prove Freshdesk connectivity: connect an agent and call `freshdesk_health`.

For a remote client, publish through your own HTTPS reverse proxy or tunnel and set `NODE_ENV=production` and `PUBLIC_URL=https://mcp.example.com`. The endpoint is `https://mcp.example.com/mcp`. See the deployment guide before exposing the service.

## Documentation

| Guide | English | Français |
| --- | --- | --- |
| Installation, configuration and deployment | [Setup](docs/en/setup.md) | [Installation](docs/fr/setup.md) |
| Tools, pagination and controlled writes | [Tools](docs/en/tools.md) | [Outils](docs/fr/tools.md) |
| Data storage, access and operations | [Security](docs/en/security.md) | [Sécurité](docs/fr/security.md) |
| Optional semantic search and indexing | [Semantic search](docs/en/semantic-search.md) | [Recherche sémantique](docs/fr/semantic-search.md) |

## Development

```bash
npm ci
npm run check
node --env-file=.env --import tsx --watch src/index.ts
```

`check` runs TypeScript checking, mocked tests and a production build. Tests do not require a real Freshdesk account or production secrets. GitHub Actions runs checks on Node 22 and 24 and scans Git history for secrets.

This repository contains source code, synthetic tests and generic examples. It does not include credentials, customer exports, runtime databases, logs or private deployment configuration. Runtime files belong outside Git; see [CONTRIBUTING.md](CONTRIBUTING.md).

## License and references

[MIT](LICENSE), copyright BoucheCousue. Third-party dependencies and optional embedding models retain their own licenses; model weights are not included.

[Freshdesk API](https://developers.freshdesk.com/api/) · [MCP specification](https://modelcontextprotocol.io/specification/2026-07-28) · [Connecting MCP servers in ChatGPT](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt)
