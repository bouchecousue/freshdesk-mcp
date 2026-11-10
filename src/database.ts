import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export interface StoredUser {
  id: string;
  tenantOrigin: string;
  agentId: string;
  agentEmail: string | null;
  agentName: string | null;
  accountId: string | null;
  accountName: string | null;
  encryptedApiKey: string;
  createdAt: number;
  updatedAt: number;
}

export interface StoredOAuthClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  scope: string;
  tokenEndpointAuthMethod: "none" | "client_secret_basic";
  clientSecretHash: string | null;
  createdAt: number;
}

export interface PendingAuthorization {
  requestHash: string;
  clientId: string;
  redirectUri: string;
  state: string;
  scope: string;
  resource: string;
  codeChallenge: string;
  expiresAt: number;
}

export interface StoredAuthorizationCode {
  codeHash: string;
  clientId: string;
  userId: string;
  redirectUri: string;
  scope: string;
  resource: string;
  codeChallenge: string;
  issuer: string;
  expiresAt: number;
  usedAt: number | null;
}

export interface StoredAccessToken {
  tokenHash: string;
  clientId: string;
  userId: string;
  scope: string;
  resource: string;
  expiresAt: number;
  revokedAt: number | null;
}

export interface StoredRefreshToken {
  tokenHash: string;
  familyId: string;
  clientId: string;
  userId: string;
  scope: string;
  resource: string;
  expiresAt: number;
  revokedAt: number | null;
  replacedByHash: string | null;
}

export interface StoredWriteIntent {
  intentHash: string;
  userId: string;
  tenantOrigin: string;
  action: string;
  targetId: string | null;
  encryptedPayload: string;
  payloadHash: string;
  expiresAt: number;
  usedAt: number | null;
}

export type UsageActionKind = "read" | "write_prepare" | "write_execute" | "write_cancel" | "oauth";

type SqlRow = Record<string, unknown>;

function asString(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid database row");
  return value;
}

function asNullableString(value: unknown): string | null {
  return value === null ? null : asString(value);
}

function asNumber(value: unknown): number {
  if (typeof value !== "number") throw new Error("Invalid database row");
  return value;
}

function optionalMetric(value: number | null | undefined, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function inferredActionKind(tool: string, outcome: string): UsageActionKind {
  if (tool.startsWith("oauth_")) return "oauth";
  if (tool === "freshdesk_prepare_ticket_action") return "write_prepare";
  if (tool === "freshdesk_execute_ticket_action") return outcome === "cancelled" ? "write_cancel" : "write_execute";
  return "read";
}

function userFromRow(row: SqlRow): StoredUser {
  return {
    id: asString(row.id),
    tenantOrigin: asString(row.tenant_origin),
    agentId: asString(row.agent_id),
    agentEmail: asNullableString(row.agent_email),
    agentName: asNullableString(row.agent_name),
    accountId: asNullableString(row.account_id),
    accountName: asNullableString(row.account_name),
    encryptedApiKey: asString(row.encrypted_api_key),
    createdAt: asNumber(row.created_at),
    updatedAt: asNumber(row.updated_at),
  };
}

export class AppDatabase {
  readonly #db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#db = new Database(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.#db.pragma("foreign_keys = ON");
    this.#db.pragma("busy_timeout = 5000");
    if (path !== ":memory:") this.#db.pragma("journal_mode = WAL");
    this.migrate();
  }

  listUserIds(): string[] {
    return (this.#db.prepare("SELECT id FROM users ORDER BY created_at").all() as Array<{ id: string }>).map(row => row.id);
  }

  close(): void {
    this.#db.close();
  }

  private migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        tenant_origin TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        agent_email TEXT,
        agent_name TEXT,
        account_id TEXT,
        account_name TEXT,
        encrypted_api_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (tenant_origin, agent_id)
      );
      CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id TEXT PRIMARY KEY,
        client_name TEXT NOT NULL,
        redirect_uris TEXT NOT NULL,
        scope TEXT NOT NULL,
        token_endpoint_auth_method TEXT NOT NULL,
        client_secret_hash TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_authorizations (
        request_hash TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        state TEXT NOT NULL,
        scope TEXT NOT NULL,
        resource TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        FOREIGN KEY (client_id) REFERENCES oauth_clients(client_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS authorization_codes (
        code_hash TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        scope TEXT NOT NULL,
        resource TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        issuer TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        FOREIGN KEY (client_id) REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS access_tokens (
        token_hash TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        resource TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (client_id) REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        token_hash TEXT PRIMARY KEY,
        family_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        resource TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER,
        replaced_by_hash TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (client_id) REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS refresh_tokens_family_idx ON refresh_tokens(family_id);
      CREATE TABLE IF NOT EXISTS write_intents (
        intent_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        tenant_origin TEXT NOT NULL,
        action TEXT NOT NULL,
        target_id TEXT,
        encrypted_payload TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at INTEGER NOT NULL,
        user_id TEXT,
        agent_id TEXT,
        tenant_origin TEXT,
        tool TEXT NOT NULL,
        target_id TEXT,
        outcome TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        failure_stage TEXT,
        upstream_status INTEGER,
        upstream_code TEXT,
        input_mode TEXT,
        input_fingerprint TEXT,
        action_kind TEXT NOT NULL DEFAULT 'read',
        action_name TEXT,
        duration_ms INTEGER,
        result_count INTEGER,
        write_applied INTEGER,
        readback_verified INTEGER,
        usage_aggregated INTEGER NOT NULL DEFAULT 0
      );
    `);
    const auditColumns = new Set(
      (this.#db.prepare("PRAGMA table_info(audit_events)").all() as Array<{ name: string }>).map((column) => column.name),
    );
    const additions = [
      ["failure_stage", "TEXT"],
      ["upstream_status", "INTEGER"],
      ["upstream_code", "TEXT"],
      ["input_mode", "TEXT"],
      ["input_fingerprint", "TEXT"],
      ["action_kind", "TEXT NOT NULL DEFAULT 'read'"],
      ["action_name", "TEXT"],
      ["duration_ms", "INTEGER"],
      ["result_count", "INTEGER"],
      ["write_applied", "INTEGER"],
      ["readback_verified", "INTEGER"],
      ["usage_aggregated", "INTEGER NOT NULL DEFAULT 0"],
    ] as const;
    for (const [name, type] of additions) {
      if (!auditColumns.has(name)) this.#db.exec(`ALTER TABLE audit_events ADD COLUMN ${name} ${type}`);
    }
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS usage_daily_stats (
        day_utc TEXT NOT NULL,
        user_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        agent_name TEXT,
        agent_email TEXT,
        tenant_origin TEXT NOT NULL,
        tool TEXT NOT NULL,
        action_kind TEXT NOT NULL,
        action_name TEXT NOT NULL DEFAULT '',
        outcome TEXT NOT NULL,
        call_count INTEGER NOT NULL,
        duration_sample_count INTEGER NOT NULL,
        total_duration_ms INTEGER NOT NULL,
        max_duration_ms INTEGER NOT NULL,
        result_count_sample_count INTEGER NOT NULL,
        total_result_count INTEGER NOT NULL,
        write_sample_count INTEGER NOT NULL,
        writes_applied INTEGER NOT NULL,
        readbacks_verified INTEGER NOT NULL,
        first_occurred_at INTEGER NOT NULL,
        last_occurred_at INTEGER NOT NULL,
        PRIMARY KEY (day_utc, user_id, tool, action_kind, action_name, outcome)
      );
      CREATE INDEX IF NOT EXISTS usage_daily_stats_user_day_idx ON usage_daily_stats(user_id, day_utc);
      CREATE INDEX IF NOT EXISTS usage_daily_stats_tool_day_idx ON usage_daily_stats(tool, day_utc);
    `);
    const backfill = this.#db.transaction(() => {
      this.#db.exec(`
        UPDATE audit_events
        SET action_kind = CASE
          WHEN tool LIKE 'oauth_%' THEN 'oauth'
          WHEN tool = 'freshdesk_prepare_ticket_action' THEN 'write_prepare'
          WHEN tool = 'freshdesk_execute_ticket_action' AND outcome = 'cancelled' THEN 'write_cancel'
          WHEN tool = 'freshdesk_execute_ticket_action' THEN 'write_execute'
          ELSE 'read'
        END
        WHERE usage_aggregated = 0;

        INSERT INTO usage_daily_stats (
          day_utc, user_id, agent_id, agent_name, agent_email, tenant_origin, tool, action_kind, action_name, outcome,
          call_count, duration_sample_count, total_duration_ms, max_duration_ms,
          result_count_sample_count, total_result_count, write_sample_count, writes_applied, readbacks_verified,
          first_occurred_at, last_occurred_at
        )
        SELECT
          date(a.occurred_at, 'unixepoch'), a.user_id, a.agent_id, u.agent_name, u.agent_email,
          a.tenant_origin, a.tool, a.action_kind, COALESCE(a.action_name, ''), a.outcome,
          COUNT(*), COUNT(a.duration_ms), COALESCE(SUM(a.duration_ms), 0), COALESCE(MAX(a.duration_ms), 0),
          COUNT(a.result_count), COALESCE(SUM(a.result_count), 0), COUNT(a.write_applied),
          COALESCE(SUM(a.write_applied), 0), COALESCE(SUM(a.readback_verified), 0),
          MIN(a.occurred_at), MAX(a.occurred_at)
        FROM audit_events a
        LEFT JOIN users u ON u.id = a.user_id
        WHERE a.usage_aggregated = 0
          AND a.user_id IS NOT NULL
          AND a.agent_id IS NOT NULL
          AND a.tenant_origin IS NOT NULL
        GROUP BY date(a.occurred_at, 'unixepoch'), a.user_id, a.agent_id, u.agent_name, u.agent_email,
          a.tenant_origin, a.tool, a.action_kind, COALESCE(a.action_name, ''), a.outcome
        ON CONFLICT (day_utc, user_id, tool, action_kind, action_name, outcome) DO UPDATE SET
          agent_id = excluded.agent_id,
          agent_name = COALESCE(excluded.agent_name, usage_daily_stats.agent_name),
          agent_email = COALESCE(excluded.agent_email, usage_daily_stats.agent_email),
          tenant_origin = excluded.tenant_origin,
          call_count = usage_daily_stats.call_count + excluded.call_count,
          duration_sample_count = usage_daily_stats.duration_sample_count + excluded.duration_sample_count,
          total_duration_ms = usage_daily_stats.total_duration_ms + excluded.total_duration_ms,
          max_duration_ms = MAX(usage_daily_stats.max_duration_ms, excluded.max_duration_ms),
          result_count_sample_count = usage_daily_stats.result_count_sample_count + excluded.result_count_sample_count,
          total_result_count = usage_daily_stats.total_result_count + excluded.total_result_count,
          write_sample_count = usage_daily_stats.write_sample_count + excluded.write_sample_count,
          writes_applied = usage_daily_stats.writes_applied + excluded.writes_applied,
          readbacks_verified = usage_daily_stats.readbacks_verified + excluded.readbacks_verified,
          first_occurred_at = MIN(usage_daily_stats.first_occurred_at, excluded.first_occurred_at),
          last_occurred_at = MAX(usage_daily_stats.last_occurred_at, excluded.last_occurred_at);

        UPDATE audit_events SET usage_aggregated = 1 WHERE usage_aggregated = 0;
      `);
    });
    backfill();
  }

  upsertUser(user: Omit<StoredUser, "createdAt" | "updatedAt">, now: number): StoredUser {
    this.#db
      .prepare(`
        INSERT INTO users (
          id, tenant_origin, agent_id, agent_email, agent_name, account_id, account_name,
          encrypted_api_key, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (tenant_origin, agent_id) DO UPDATE SET
          agent_email = excluded.agent_email,
          agent_name = excluded.agent_name,
          account_id = excluded.account_id,
          account_name = excluded.account_name,
          encrypted_api_key = excluded.encrypted_api_key,
          updated_at = excluded.updated_at
      `)
      .run(
        user.id,
        user.tenantOrigin,
        user.agentId,
        user.agentEmail,
        user.agentName,
        user.accountId,
        user.accountName,
        user.encryptedApiKey,
        now,
        now,
      );
    const stored = this.getUserByTenantAgent(user.tenantOrigin, user.agentId);
    if (!stored) throw new Error("Failed to store user");
    return stored;
  }

  getUser(id: string): StoredUser | undefined {
    const row = this.#db.prepare("SELECT * FROM users WHERE id = ?").get(id) as SqlRow | undefined;
    return row ? userFromRow(row) : undefined;
  }

  getUserByTenantAgent(tenantOrigin: string, agentId: string): StoredUser | undefined {
    const row = this.#db
      .prepare("SELECT * FROM users WHERE tenant_origin = ? AND agent_id = ?")
      .get(tenantOrigin, agentId) as SqlRow | undefined;
    return row ? userFromRow(row) : undefined;
  }

  deleteUser(id: string): void {
    this.#db.prepare("DELETE FROM users WHERE id = ?").run(id);
  }

  insertClient(client: StoredOAuthClient): void {
    this.#db
      .prepare(`
        INSERT INTO oauth_clients (
          client_id, client_name, redirect_uris, scope, token_endpoint_auth_method,
          client_secret_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (client_id) DO UPDATE SET
          client_name = excluded.client_name,
          redirect_uris = excluded.redirect_uris,
          scope = excluded.scope,
          token_endpoint_auth_method = excluded.token_endpoint_auth_method,
          client_secret_hash = excluded.client_secret_hash
      `)
      .run(
        client.clientId,
        client.clientName,
        JSON.stringify(client.redirectUris),
        client.scope,
        client.tokenEndpointAuthMethod,
        client.clientSecretHash,
        client.createdAt,
      );
  }

  getClient(clientId: string): StoredOAuthClient | undefined {
    const row = this.#db.prepare("SELECT * FROM oauth_clients WHERE client_id = ?").get(clientId) as SqlRow | undefined;
    if (!row) return undefined;
    const redirectUris = JSON.parse(asString(row.redirect_uris)) as unknown;
    if (!Array.isArray(redirectUris) || !redirectUris.every((item) => typeof item === "string")) {
      throw new Error("Invalid OAuth client redirect URIs");
    }
    const method = asString(row.token_endpoint_auth_method);
    if (method !== "none" && method !== "client_secret_basic") throw new Error("Invalid OAuth client authentication method");
    return {
      clientId: asString(row.client_id),
      clientName: asString(row.client_name),
      redirectUris,
      scope: asString(row.scope),
      tokenEndpointAuthMethod: method,
      clientSecretHash: asNullableString(row.client_secret_hash),
      createdAt: asNumber(row.created_at),
    };
  }

  insertPendingAuthorization(pending: PendingAuthorization): void {
    this.#db
      .prepare(`
        INSERT INTO pending_authorizations (
          request_hash, client_id, redirect_uri, state, scope, resource, code_challenge, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        pending.requestHash,
        pending.clientId,
        pending.redirectUri,
        pending.state,
        pending.scope,
        pending.resource,
        pending.codeChallenge,
        pending.expiresAt,
      );
  }

  getPendingAuthorization(requestHash: string, now: number): PendingAuthorization | undefined {
    const row = this.#db
      .prepare("SELECT * FROM pending_authorizations WHERE request_hash = ? AND expires_at > ?")
      .get(requestHash, now) as SqlRow | undefined;
    if (!row) return undefined;
    return {
      requestHash: asString(row.request_hash),
      clientId: asString(row.client_id),
      redirectUri: asString(row.redirect_uri),
      state: asString(row.state),
      scope: asString(row.scope),
      resource: asString(row.resource),
      codeChallenge: asString(row.code_challenge),
      expiresAt: asNumber(row.expires_at),
    };
  }

  deletePendingAuthorization(requestHash: string): void {
    this.#db.prepare("DELETE FROM pending_authorizations WHERE request_hash = ?").run(requestHash);
  }

  insertAuthorizationCode(code: StoredAuthorizationCode): void {
    this.#db
      .prepare(`
        INSERT INTO authorization_codes (
          code_hash, client_id, user_id, redirect_uri, scope, resource,
          code_challenge, issuer, expires_at, used_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        code.codeHash,
        code.clientId,
        code.userId,
        code.redirectUri,
        code.scope,
        code.resource,
        code.codeChallenge,
        code.issuer,
        code.expiresAt,
        code.usedAt,
      );
  }

  consumeAuthorizationCode(
    codeHash: string, now: number, validate?: (code: StoredAuthorizationCode) => void,
  ): StoredAuthorizationCode | undefined {
    const transaction = this.#db.transaction(() => {
      const row = this.#db.prepare("SELECT * FROM authorization_codes WHERE code_hash = ?").get(codeHash) as SqlRow | undefined;
      if (!row || row.used_at !== null || asNumber(row.expires_at) <= now) return undefined;
      const code = {
        codeHash: asString(row.code_hash),
        clientId: asString(row.client_id),
        userId: asString(row.user_id),
        redirectUri: asString(row.redirect_uri),
        scope: asString(row.scope),
        resource: asString(row.resource),
        codeChallenge: asString(row.code_challenge),
        issuer: asString(row.issuer),
        expiresAt: asNumber(row.expires_at),
        usedAt: null,
      } satisfies StoredAuthorizationCode;
      validate?.(code);
      this.#db.prepare("UPDATE authorization_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL").run(now, codeHash);
      return { ...code, usedAt: now };
    });
    return transaction();
  }

  insertAccessToken(token: StoredAccessToken, now: number): void {
    this.#db
      .prepare(`
        INSERT INTO access_tokens (
          token_hash, client_id, user_id, scope, resource, expires_at, revoked_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(token.tokenHash, token.clientId, token.userId, token.scope, token.resource, token.expiresAt, token.revokedAt, now);
  }

  getAccessToken(tokenHash: string): StoredAccessToken | undefined {
    const row = this.#db.prepare("SELECT * FROM access_tokens WHERE token_hash = ?").get(tokenHash) as SqlRow | undefined;
    if (!row) return undefined;
    return {
      tokenHash: asString(row.token_hash),
      clientId: asString(row.client_id),
      userId: asString(row.user_id),
      scope: asString(row.scope),
      resource: asString(row.resource),
      expiresAt: asNumber(row.expires_at),
      revokedAt: row.revoked_at === null ? null : asNumber(row.revoked_at),
    };
  }

  insertRefreshToken(token: StoredRefreshToken, now: number): void {
    this.#db
      .prepare(`
        INSERT INTO refresh_tokens (
          token_hash, family_id, client_id, user_id, scope, resource,
          expires_at, revoked_at, replaced_by_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        token.tokenHash,
        token.familyId,
        token.clientId,
        token.userId,
        token.scope,
        token.resource,
        token.expiresAt,
        token.revokedAt,
        token.replacedByHash,
        now,
      );
  }

  consumeRefreshToken(
    tokenHash: string, replacementHash: string, now: number, validate?: (token: StoredRefreshToken) => void,
  ): StoredRefreshToken | "reuse" | undefined {
    const transaction = this.#db.transaction(() => {
      const row = this.#db.prepare("SELECT * FROM refresh_tokens WHERE token_hash = ?").get(tokenHash) as SqlRow | undefined;
      if (!row) return undefined;
      const familyId = asString(row.family_id);
      const token: StoredRefreshToken = {
        tokenHash: asString(row.token_hash), familyId,
        clientId: asString(row.client_id), userId: asString(row.user_id),
        scope: asString(row.scope), resource: asString(row.resource),
        expiresAt: asNumber(row.expires_at),
        revokedAt: row.revoked_at === null ? null : asNumber(row.revoked_at),
        replacedByHash: asNullableString(row.replaced_by_hash),
      };
      // Reject invalid client/audience/scope before consuming or revoking any grant.
      validate?.(token);
      if (row.revoked_at !== null || row.replaced_by_hash !== null) {
        this.#db.prepare("UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE family_id = ?").run(now, familyId);
        this.#db.prepare("UPDATE access_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ? AND client_id = ?").run(
          now,
          asString(row.user_id),
          asString(row.client_id),
        );
        return "reuse" as const;
      }
      if (asNumber(row.expires_at) <= now) return undefined;
      this.#db
        .prepare("UPDATE refresh_tokens SET revoked_at = ?, replaced_by_hash = ? WHERE token_hash = ? AND revoked_at IS NULL")
        .run(now, replacementHash, tokenHash);
      return { ...token, revokedAt: now, replacedByHash: replacementHash };
    });
    return transaction();
  }

  revokeToken(tokenHash: string, now: number): { userId: string; clientId: string } | undefined {
    const transaction = this.#db.transaction(() => {
      const access = this.#db.prepare("SELECT user_id, client_id FROM access_tokens WHERE token_hash = ?").get(tokenHash) as
        | SqlRow
        | undefined;
      if (access) {
        this.#db.prepare("UPDATE access_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE token_hash = ?").run(now, tokenHash);
        return { userId: asString(access.user_id), clientId: asString(access.client_id) };
      }
      const refresh = this.#db
        .prepare("SELECT user_id, client_id, family_id FROM refresh_tokens WHERE token_hash = ?")
        .get(tokenHash) as SqlRow | undefined;
      if (!refresh) return undefined;
      this.#db.prepare("UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE family_id = ?").run(
        now,
        asString(refresh.family_id),
      );
      this.#db.prepare("UPDATE access_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ? AND client_id = ?").run(
        now,
        asString(refresh.user_id),
        asString(refresh.client_id),
      );
      return { userId: asString(refresh.user_id), clientId: asString(refresh.client_id) };
    });
    return transaction();
  }

  hasActiveGrant(userId: string, now: number): boolean {
    const row = this.#db
      .prepare(`
        SELECT 1 AS active
        FROM access_tokens
        WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
        UNION ALL
        SELECT 1 AS active
        FROM refresh_tokens
        WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
        LIMIT 1
      `)
      .get(userId, now, userId, now) as SqlRow | undefined;
    return row !== undefined;
  }

  insertWriteIntent(intent: StoredWriteIntent, now: number): void {
    this.#db
      .prepare(`
        INSERT INTO write_intents (
          intent_hash, user_id, tenant_origin, action, target_id, encrypted_payload,
          payload_hash, expires_at, used_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        intent.intentHash,
        intent.userId,
        intent.tenantOrigin,
        intent.action,
        intent.targetId,
        intent.encryptedPayload,
        intent.payloadHash,
        intent.expiresAt,
        intent.usedAt,
        now,
      );
  }

  getWriteIntent(intentHash: string, now: number): StoredWriteIntent | undefined {
    const row = this.#db.prepare("SELECT * FROM write_intents WHERE intent_hash = ? AND expires_at > ?").get(intentHash, now) as
      | SqlRow
      | undefined;
    if (!row) return undefined;
    return {
      intentHash: asString(row.intent_hash),
      userId: asString(row.user_id),
      tenantOrigin: asString(row.tenant_origin),
      action: asString(row.action),
      targetId: asNullableString(row.target_id),
      encryptedPayload: asString(row.encrypted_payload),
      payloadHash: asString(row.payload_hash),
      expiresAt: asNumber(row.expires_at),
      usedAt: row.used_at === null ? null : asNumber(row.used_at),
    };
  }

  consumeWriteIntent(intentHash: string, userId: string, now: number): StoredWriteIntent | undefined {
    const transaction = this.#db.transaction(() => {
      const intent = this.getWriteIntent(intentHash, now);
      if (!intent || intent.userId !== userId || intent.usedAt !== null) return undefined;
      const result = this.#db
        .prepare("UPDATE write_intents SET used_at = ? WHERE intent_hash = ? AND used_at IS NULL")
        .run(now, intentHash);
      return result.changes === 1 ? { ...intent, usedAt: now } : undefined;
    });
    return transaction();
  }

  recordAudit(event: {
    occurredAt: number;
    userId: string | null;
    agentId: string | null;
    tenantOrigin: string | null;
    tool: string;
    targetId: string | null;
    outcome: string;
    correlationId: string;
    failureStage?: string | null;
    upstreamStatus?: number | null;
    upstreamCode?: string | null;
    inputMode?: string | null;
    inputFingerprint?: string | null;
    actionKind?: UsageActionKind;
    actionName?: string | null;
    durationMs?: number | null;
    resultCount?: number | null;
    writeApplied?: boolean | null;
    readbackVerified?: boolean | null;
  }): void {
    const durationMs = optionalMetric(event.durationMs, "durationMs");
    const resultCount = optionalMetric(event.resultCount, "resultCount");
    const actionKind = event.actionKind ?? inferredActionKind(event.tool, event.outcome);
    const actionName = event.actionName?.trim() || null;
    const writeApplied = event.writeApplied === null || event.writeApplied === undefined ? null : Number(event.writeApplied);
    const readbackVerified = event.readbackVerified === null || event.readbackVerified === undefined
      ? null
      : Number(event.readbackVerified);
    const transaction = this.#db.transaction(() => {
      this.#db
        .prepare(`
          INSERT INTO audit_events (
            occurred_at, user_id, agent_id, tenant_origin, tool, target_id, outcome, correlation_id,
            failure_stage, upstream_status, upstream_code, input_mode, input_fingerprint,
            action_kind, action_name, duration_ms, result_count, write_applied, readback_verified, usage_aggregated
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        `)
        .run(
          event.occurredAt,
          event.userId,
          event.agentId,
          event.tenantOrigin,
          event.tool,
          event.targetId,
          event.outcome,
          event.correlationId,
          event.failureStage ?? null,
          event.upstreamStatus ?? null,
          event.upstreamCode ?? null,
          event.inputMode ?? null,
          event.inputFingerprint ?? null,
          actionKind,
          actionName,
          durationMs,
          resultCount,
          writeApplied,
          readbackVerified,
        );
      if (!event.userId || !event.agentId || !event.tenantOrigin) return;
      const identity = this.#db
        .prepare("SELECT agent_name, agent_email FROM users WHERE id = ?")
        .get(event.userId) as { agent_name: string | null; agent_email: string | null } | undefined;
      const dayUtc = new Date(event.occurredAt * 1_000).toISOString().slice(0, 10);
      this.#db
        .prepare(`
          INSERT INTO usage_daily_stats (
            day_utc, user_id, agent_id, agent_name, agent_email, tenant_origin, tool, action_kind, action_name, outcome,
            call_count, duration_sample_count, total_duration_ms, max_duration_ms,
            result_count_sample_count, total_result_count, write_sample_count, writes_applied, readbacks_verified,
            first_occurred_at, last_occurred_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (day_utc, user_id, tool, action_kind, action_name, outcome) DO UPDATE SET
            agent_id = excluded.agent_id,
            agent_name = COALESCE(excluded.agent_name, usage_daily_stats.agent_name),
            agent_email = COALESCE(excluded.agent_email, usage_daily_stats.agent_email),
            tenant_origin = excluded.tenant_origin,
            call_count = usage_daily_stats.call_count + 1,
            duration_sample_count = usage_daily_stats.duration_sample_count + excluded.duration_sample_count,
            total_duration_ms = usage_daily_stats.total_duration_ms + excluded.total_duration_ms,
            max_duration_ms = MAX(usage_daily_stats.max_duration_ms, excluded.max_duration_ms),
            result_count_sample_count = usage_daily_stats.result_count_sample_count + excluded.result_count_sample_count,
            total_result_count = usage_daily_stats.total_result_count + excluded.total_result_count,
            write_sample_count = usage_daily_stats.write_sample_count + excluded.write_sample_count,
            writes_applied = usage_daily_stats.writes_applied + excluded.writes_applied,
            readbacks_verified = usage_daily_stats.readbacks_verified + excluded.readbacks_verified,
            first_occurred_at = MIN(usage_daily_stats.first_occurred_at, excluded.first_occurred_at),
            last_occurred_at = MAX(usage_daily_stats.last_occurred_at, excluded.last_occurred_at)
        `)
        .run(
          dayUtc,
          event.userId,
          event.agentId,
          identity?.agent_name ?? null,
          identity?.agent_email ?? null,
          event.tenantOrigin,
          event.tool,
          actionKind,
          actionName ?? "",
          event.outcome,
          durationMs === null ? 0 : 1,
          durationMs ?? 0,
          durationMs ?? 0,
          resultCount === null ? 0 : 1,
          resultCount ?? 0,
          writeApplied === null ? 0 : 1,
          writeApplied ?? 0,
          readbackVerified ?? 0,
          event.occurredAt,
          event.occurredAt,
        );
    });
    transaction();
  }

  purgeExpired(now: number): void {
    this.#db.prepare("DELETE FROM pending_authorizations WHERE expires_at <= ?").run(now);
    this.#db.prepare("DELETE FROM authorization_codes WHERE expires_at <= ? OR used_at IS NOT NULL").run(now);
    this.#db.prepare("DELETE FROM access_tokens WHERE expires_at <= ? OR revoked_at IS NOT NULL").run(now);
    this.#db.prepare("DELETE FROM refresh_tokens WHERE expires_at <= ?").run(now);
    this.#db.prepare("DELETE FROM write_intents WHERE expires_at <= ? OR used_at IS NOT NULL").run(now);
  }
}
