import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { AppDatabase } from "../src/database.js";

function seedRelations(database: AppDatabase): void {
  database.insertClient({
    clientId: "client-1",
    clientName: "Test",
    redirectUris: ["https://chatgpt.com/callback"],
    scope: "freshdesk:read freshdesk:write offline_access",
    tokenEndpointAuthMethod: "none",
    clientSecretHash: null,
    createdAt: 1,
  });
  database.upsertUser(
    {
      id: "user-1",
      tenantOrigin: "https://acme.freshdesk.com",
      agentId: "42",
      agentEmail: "agent@example.com",
      agentName: "Agent",
      accountId: "1",
      accountName: "Acme",
      encryptedApiKey: "encrypted",
    },
    1,
  );
}

describe("database one-time state", () => {
  it("rotates refresh tokens and detects family reuse", () => {
    const database = new AppDatabase(":memory:");
    seedRelations(database);
    database.insertRefreshToken(
      {
        tokenHash: "old",
        familyId: "family",
        clientId: "client-1",
        userId: "user-1",
        scope: "freshdesk:read offline_access",
        resource: "https://mcp.example.com/mcp",
        expiresAt: 10_000,
        revokedAt: null,
        replacedByHash: null,
      },
      1,
    );

    expect(database.consumeRefreshToken("old", "new", 2)).toMatchObject({ replacedByHash: "new" });
    expect(database.consumeRefreshToken("old", "another", 3)).toBe("reuse");
    database.close();
  });

  it("consumes a write intent exactly once", () => {
    const database = new AppDatabase(":memory:");
    seedRelations(database);
    database.insertWriteIntent(
      {
        intentHash: "intent",
        userId: "user-1",
        tenantOrigin: "https://acme.freshdesk.com",
        action: "update_ticket",
        targetId: "123",
        encryptedPayload: "encrypted",
        payloadHash: "hash",
        expiresAt: 10_000,
        usedAt: null,
      },
      1,
    );

    expect(database.consumeWriteIntent("intent", "user-1", 2)?.usedAt).toBe(2);
    expect(database.consumeWriteIntent("intent", "user-1", 3)).toBeUndefined();
    database.close();
  });
});


describe("authorization validation before consumption", () => {
  it("keeps an authorization code usable after a rejected verifier", () => {
    const database = new AppDatabase(":memory:");
    try {
      seedRelations(database);
      database.insertAuthorizationCode({ codeHash: "code", clientId: "client-1", userId: "user-1",
        redirectUri: "https://chatgpt.com/callback", scope: "freshdesk:read", resource: "https://mcp.example/mcp",
        codeChallenge: "challenge", issuer: "https://mcp.example", expiresAt: 100, usedAt: null });
      expect(() => database.consumeAuthorizationCode("code", 2, () => { throw new Error("bad verifier"); })).toThrow(/bad verifier/);
      expect(database.consumeAuthorizationCode("code", 3)?.usedAt).toBe(3);
      expect(database.consumeAuthorizationCode("code", 4)).toBeUndefined();
    } finally { database.close(); }
  });
});

describe("audit diagnostics migration", () => {
  it("adds safe diagnostic columns to an existing database and stores no request payload", () => {
    const directory = mkdtempSync(join(tmpdir(), "freshdesk-mcp-audit-"));
    const path = join(directory, "legacy.sqlite3");
    try {
      const legacy = new Database(path);
      legacy.exec(`
        CREATE TABLE audit_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          occurred_at INTEGER NOT NULL,
          user_id TEXT,
          agent_id TEXT,
          tenant_origin TEXT,
          tool TEXT NOT NULL,
          target_id TEXT,
          outcome TEXT NOT NULL,
          correlation_id TEXT NOT NULL
        );
      `);
      legacy.close();

      const database = new AppDatabase(path);
      database.recordAudit({
        occurredAt: 10,
        userId: null,
        agentId: null,
        tenantOrigin: null,
        tool: "freshdesk_search_tickets",
        targetId: null,
        outcome: "error",
        correlationId: "req_safe",
        failureStage: "freshdesk_api",
        upstreamStatus: 400,
        upstreamCode: "invalid_value",
        inputMode: "structured",
        inputFingerprint: "hmac-only",
      });
      database.close();

      const inspected = new Database(path, { readonly: true });
      const row = inspected.prepare("SELECT * FROM audit_events WHERE correlation_id = ?").get("req_safe") as Record<string, unknown>;
      inspected.close();
      expect(row).toMatchObject({
        failure_stage: "freshdesk_api",
        upstream_status: 400,
        upstream_code: "invalid_value",
        input_mode: "structured",
        input_fingerprint: "hmac-only",
      });
      expect(Object.keys(row)).not.toContain("query");
      expect(Object.keys(row)).not.toContain("request_body");
      expect(row).toMatchObject({ action_kind: "read", usage_aggregated: 1 });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("privacy-safe usage statistics", () => {
  it("aggregates identity, actions, outcomes, duration, results, and verified writes", () => {
    const directory = mkdtempSync(join(tmpdir(), "freshdesk-mcp-usage-"));
    const path = join(directory, "usage.sqlite3");
    try {
      const database = new AppDatabase(path);
      seedRelations(database);
      database.recordAudit({
        occurredAt: 1_795_977_600,
        userId: "user-1",
        agentId: "42",
        tenantOrigin: "https://acme.freshdesk.com",
        tool: "freshdesk_search_contacts",
        targetId: null,
        outcome: "success",
        correlationId: "req-1",
        durationMs: 80,
        resultCount: 3,
      });
      database.recordAudit({
        occurredAt: 1_795_977_601,
        userId: "user-1",
        agentId: "42",
        tenantOrigin: "https://acme.freshdesk.com",
        tool: "freshdesk_search_contacts",
        targetId: null,
        outcome: "success",
        correlationId: "req-2",
        durationMs: 120,
        resultCount: 2,
      });
      database.recordAudit({
        occurredAt: 1_795_977_602,
        userId: "user-1",
        agentId: "42",
        tenantOrigin: "https://acme.freshdesk.com",
        tool: "freshdesk_execute_ticket_action",
        targetId: "123",
        outcome: "success",
        correlationId: "req-3",
        actionName: "private_note",
        durationMs: 240,
        resultCount: 1,
        writeApplied: true,
        readbackVerified: true,
      });
      database.close();

      const inspected = new Database(path, { readonly: true });
      const search = inspected.prepare(`
        SELECT * FROM usage_daily_stats
        WHERE user_id = 'user-1' AND tool = 'freshdesk_search_contacts' AND outcome = 'success'
      `).get() as Record<string, unknown>;
      const write = inspected.prepare(`
        SELECT * FROM usage_daily_stats
        WHERE user_id = 'user-1' AND tool = 'freshdesk_execute_ticket_action' AND outcome = 'success'
      `).get() as Record<string, unknown>;
      const columns = inspected.prepare("PRAGMA table_info(audit_events)").all() as Array<{ name: string }>;
      inspected.close();

      expect(search).toMatchObject({
        agent_id: "42",
        agent_name: "Agent",
        agent_email: "agent@example.com",
        action_kind: "read",
        action_name: "",
        call_count: 2,
        duration_sample_count: 2,
        total_duration_ms: 200,
        max_duration_ms: 120,
        result_count_sample_count: 2,
        total_result_count: 5,
      });
      expect(write).toMatchObject({
        action_kind: "write_execute",
        action_name: "private_note",
        call_count: 1,
        write_sample_count: 1,
        writes_applied: 1,
        readbacks_verified: 1,
      });
      expect(columns.map((column) => column.name)).not.toContain("request_body");
      expect(columns.map((column) => column.name)).not.toContain("query");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("backfills legacy audit rows exactly once", () => {
    const directory = mkdtempSync(join(tmpdir(), "freshdesk-mcp-usage-backfill-"));
    const path = join(directory, "usage.sqlite3");
    try {
      const initial = new AppDatabase(path);
      seedRelations(initial);
      initial.recordAudit({
        occurredAt: 1_795_977_600,
        userId: "user-1",
        agentId: "42",
        tenantOrigin: "https://acme.freshdesk.com",
        tool: "freshdesk_execute_ticket_action",
        targetId: "123",
        outcome: "cancelled",
        correlationId: "legacy",
      });
      initial.close();

      const reset = new Database(path);
      reset.exec("DELETE FROM usage_daily_stats; UPDATE audit_events SET usage_aggregated = 0, action_kind = 'read';");
      reset.close();

      new AppDatabase(path).close();
      new AppDatabase(path).close();
      const inspected = new Database(path, { readonly: true });
      const row = inspected.prepare("SELECT * FROM usage_daily_stats").get() as Record<string, unknown>;
      const event = inspected.prepare("SELECT action_kind, usage_aggregated FROM audit_events").get() as Record<string, unknown>;
      inspected.close();

      expect(row).toMatchObject({ action_kind: "write_cancel", call_count: 1, duration_sample_count: 0 });
      expect(event).toMatchObject({ action_kind: "write_cancel", usage_aggregated: 1 });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
