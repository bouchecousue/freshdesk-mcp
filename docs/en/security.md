# Security and operations

[Français](../fr/security.md) · [README](../../README.md)

## Trust and authentication

The MCP server is an OAuth authorization server for clients, and uses personal API keys upstream to Freshdesk. Each user authorizes their own tenant and agent; there is no bundled shared administrator credential. Accepted tenant origins are native HTTPS `*.freshdesk.com` origins without a custom path or credentials.

Authorization codes use PKCE S256. Access tokens are short-lived opaque values; refresh tokens rotate with replay detection. Freshdesk API keys and prepared action payloads are encrypted with AES-256-GCM using a deployment-specific master key and bound additional data. OAuth tokens are stored as keyed hashes. Clients requesting only `freshdesk:read` cannot execute writes.

Registration and metadata discovery do not constitute an organization membership gate. This version does not provide a tenant allowlist or an administrator enrollment approval flow. Operators control who can reach and use their deployment; review enrollment and access requirements before exposing it.

## Stored data

| Data | Storage |
| --- | --- |
| Freshdesk API keys and prepared payloads | Encrypted in the application SQLite database |
| User/agent identity, tenant, OAuth client metadata | Operational records in SQLite; may identify people |
| OAuth tokens | Keyed token hashes and lifecycle metadata |
| Audit and daily usage statistics | Identity, tenant, tool, action, result, volumes, duration and write verification metadata |
| Semantic passages and content metadata | Encrypted in the separate optional semantic database |
| Semantic vectors, IDs, HMAC fingerprints and synchronization state | Not encrypted at application level; treat as sensitive |

Audit events do not retain raw ticket/conversation bodies or raw search text. Expert queries retain a keyed non-reversible fingerprint. The logger redacts sensitive field names and reduces error objects, but this is not a general-purpose content anonymizer. The semantic index intentionally stores protected copies of ticket content. Runtime data must never be added to this public repository.

The application creates SQLite files with mode `0600` and new storage directories with mode `0700`. Apply equivalent protection to SQLite WAL/SHM files, exports, backups, environment files and service logs. Use a restrictive process umask, storage encryption and appropriate host access controls. Optional local embeddings do not make vectors anonymous.

## Backup and restore

Use SQLite's online backup mechanism or stop all server/indexer processes before copying a database. Copying only a live main file can lose WAL state. Back up the application database and, when used, the semantic database; keep the master key separately in a protected store.

Restore into a separate protected directory first. Check database integrity, file permissions and access with the same master key before switching services. Losing the key prevents decryption; changing the environment variable alone is not a key rotation procedure. This version has no automated master-key migration command.

## Monitoring and updates

`/health` checks the process, not agent credentials or index completeness. Use authenticated `freshdesk_health` for Freshdesk connectivity and `freshdesk_semantic_index_status` for per-agent coverage. Monitor API rate limits, disk space, OAuth failures and write verification failures.

Local administrators can run the usage report without exposing it as a tool to workspace users:

```bash
npm run --silent usage-report -- --database /path/to/freshdesk-mcp.sqlite3 --days 30
```

The report contains names/emails when known: restrict access to its output. Define a retention policy for your installation; expired-token cleanup is not a complete audit/index retention policy.

Before an upgrade, back up the databases and master key, stop relevant workers, install/build the new code and check health, discovery and a read-only request. Test writes separately on a test ticket. Never use repeated writes as a health check. Review migrations before rollback; restoring older source alone may not restore an older schema.

## Reporting vulnerabilities

See [SECURITY.md](../../SECURITY.md). Do not include production credentials or customer content in public issues. These documented controls are not a claim of independent security certification.
