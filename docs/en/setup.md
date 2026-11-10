# Setup and deployment

[Français](../fr/setup.md) · [README](../../README.md)

## Local installation

Use Node 22 or 24, npm and a writable local directory. `better-sqlite3` needs a compatible native binary; if no prebuilt binary is available, install the build tools required by that dependency. Python 3 is only needed for the optional export streamer.

Follow the README quick start. The server does not automatically load `.env`: use `node --env-file=.env`, or inject environment variables with your service manager. `npm start` and `npm run dev` assume the environment is already loaded. Never commit `.env` or use a real key in tests.

The master key generator produces 32 random bytes encoded as base64url. Generate a separate key per installation. Retain it securely: generating a replacement does not decrypt the existing database.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development`, `test` or `production` |
| `HOST` | `127.0.0.1` | Bind address; keep loopback behind a proxy |
| `PORT` | `8788` | Listening port, 1024–65535 |
| `PUBLIC_URL` | Local bind origin | External origin, no path, credentials, query or fragment; required in production |
| `DATABASE_PATH` | `./var/freshdesk-mcp.sqlite3` | SQLite file; relative paths use the working directory |
| `FRESHDESK_MCP_MASTER_KEY` | Required | Base64/base64url encoding of exactly 32 bytes |
| `ACCESS_TOKEN_TTL_SECONDS` | `900` | Access token lifetime, 300–3600 |
| `REFRESH_TOKEN_TTL_SECONDS` | `2592000` | Refresh token lifetime, 3600–31536000 |
| `AUTH_CODE_TTL_SECONDS` | `300` | Authorization code lifetime, 60–600 |
| `AUTH_REQUEST_TTL_SECONDS` | `600` | Authorization request lifetime, 60–1800 |
| `WRITE_INTENT_TTL_SECONDS` | `600` | Prepared write lifetime, 60–1800 |
| `CIMD_ALLOWED_HOST_SUFFIXES` | `chatgpt.com,openai.com` | Comma-separated client metadata host suffixes |
| `FRESHDESK_EMBEDDING_URL` | `http://127.0.0.1:9932/v1/embeddings` | Optional local embedding endpoint; see semantic guide |

HTTP is permitted only for local development origins. Production requires HTTPS. The default client metadata allowlist targets ChatGPT; other clients may require deliberate configuration and interoperability testing.

## Remote deployment

1. Install from this repository on your own host, run `npm ci` and `npm run build`.
2. Use a dedicated service account, a persistent working directory and an environment file readable only by that account. Set a restrictive umask such as `077`.
3. Set `NODE_ENV=production`, `PUBLIC_URL=https://mcp.example.com` and an absolute `DATABASE_PATH` outside the source checkout. Inject the master key from your secret store or protected environment file.
4. Run `node dist/src/index.js` with a service manager. Configure restart behavior and preserve the database and master key across upgrades.
5. Forward your HTTPS origin to `http://127.0.0.1:8788` using your reverse proxy or tunnel. Preserve the external Host header, OAuth query parameters, Authorization headers and streaming responses. Do not cache OAuth or MCP responses or log credentials.
6. Check `/health`, `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource/mcp` and the `401` challenge on unauthenticated `/mcp`.

No host-specific service units, tunnel tokens, DNS configuration or hosted endpoint are provided. Configure those for your own installation. The repository does not deploy any service automatically.

## Connecting a client

Use your server's HTTPS `/mcp` endpoint and OAuth authentication. Discovery exposes authorization, token, registration and revocation endpoints. The flow supports PKCE S256 and the scopes `freshdesk:read`, `freshdesk:write` and `offline_access`.

In the authorization page, enter your native `your-tenant.freshdesk.com` domain and personal Freshdesk API key. Custom Freshdesk domains are rejected. The server checks the agent identity and encrypts the key locally; it does not pass the Freshdesk key to the MCP client. The client receives MCP OAuth tokens instead.

For ChatGPT, follow the [current official connection guide](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt); workspace permissions and client capabilities apply. Review the discovered tools, call `freshdesk_health` and `freshdesk_me`, then try a read-only ticket lookup. Refresh the connection's tool definitions after an upgrade. Confirm write compatibility separately on a test ticket.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| SQLite native module error | Use the same Node major for `npm ci` and runtime; reinstall dependencies after changing Node |
| Startup rejects environment | Master key length, production HTTPS origin and supported variable ranges |
| OAuth callback fails | Public origin, proxy Host forwarding, client redirect URI and scopes |
| Freshdesk rejects a request | Agent permissions, native tenant domain, API key and rate limits |
| Semantic search unavailable | Optional embedding service and worker; ordinary tools do not require embeddings |
| Write is unverified | Inspect `writeApplied`, `readbackVerified` and `verificationIssues`; do not replay automatically |

Use correlation IDs and redacted logs for diagnostics. Never paste database dumps, API keys or ticket content into public issues.
