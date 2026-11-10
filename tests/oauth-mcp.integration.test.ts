import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFreshdeskMcpApp, MAX_REQUEST_BODY_BYTES, type FreshdeskMcpApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { parseMasterKey, sha256Base64Url } from "../src/crypto.js";
import { FreshdeskClient } from "../src/freshdesk/client.js";

const activeApps: FreshdeskMcpApp[] = [];

afterEach(async () => {
  await Promise.all(activeApps.splice(0).map((service) => service.close()));
});

function config(databasePath = ":memory:"): AppConfig {
  const publicUrl = new URL("http://127.0.0.1:8788/");
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 8788,
    publicUrl,
    resourceUrl: new URL("/mcp", publicUrl),
    databasePath,
    masterKey: parseMasterKey("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 86_400,
    authCodeTtlSeconds: 300,
    authRequestTtlSeconds: 600,
    writeIntentTtlSeconds: 600,
    cimdAllowedHostSuffixes: ["chatgpt.com", "openai.com"],
  };
}

function createFakeFreshdesk(options: {
  denyAccount?: boolean;
  ignoreUpdate?: boolean;
  noteReadback?: "wrong_body" | "public" | "missing";
  rejectTicketSearch?: boolean;
} = {}): {
  fetchFn: typeof fetch; writeCount: () => number; accountReadCount: () => number; changeTicket: () => void;
  searchQueries: () => string[];
} {
  let writes = 0;
  let accountReads = 0;
  let status = 2;
  let updatedAt = "2026-08-14T12:00:00Z";
  let note: Record<string, unknown> | undefined;
  const ticketSearchQueries: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    const method = init?.method ?? "GET";
    if (url.pathname === "/api/v2/agents/me") {
      return new Response(JSON.stringify({ id: 42, contact: { name: "Alice Agent", email: "alice@example.com" }, ticket_scope: 1 }));
    }
    if (url.pathname === "/api/v2/account") {
      accountReads += 1;
      if (options.denyAccount) {
        return new Response(JSON.stringify({ code: "access_denied" }), { status: 403 });
      }
      return new Response(JSON.stringify({ account_id: 7, account_name: "Acme Support", plan: "pro", time_zone: "Paris" }));
    }
    if (url.pathname === "/api/v2/tickets/123" && method === "GET") {
      return new Response(
        JSON.stringify({ id: 123, subject: "Printer offline", description_text: "Customer printer is offline", status, priority: 2,
          source: 1, requester_id: 88, company_id: 77, group_id: 9, updated_at: updatedAt, due_by: "2026-08-13T12:00:00Z",
          attachments: [{ id: 700, name: "photo.png", content_type: "image/png", size: 1200, attachment_url: "https://cdn.freshdesk.com/photo.png" }],
          requester: { id: 88, name: "Camille Client", email: "camille@example.com", company_id: 77 },
          company: { id: 77, name: "Client Co", domains: ["client.example"] } }),
      );
    }
    if (url.pathname === "/api/v2/tickets/123/time_entries") {
      return new Response(JSON.stringify([{ id: 501, ticket_id: 123, agent_id: 42, time_spent: "01:30", billable: true }]));
    }
    if (url.pathname === "/api/v2/tickets/123/satisfaction_ratings") {
      return new Response(JSON.stringify([{ id: 601, ticket_id: 123, feedback: "Merci", ratings: { default_question: 100 } }]));
    }
    if (url.pathname === "/api/v2/ticket_fields") {
      return new Response(JSON.stringify([{ id: 1, name: "status", label: "Statut", type: "default_status", choices: { 2: "Ouvert", 3: "En attente" } }]));
    }
    if (url.pathname === "/api/v2/agents") {
      return new Response(JSON.stringify([{ id: 42, contact: { name: "Alice Agent", email: "alice@example.com" }, group_ids: [9] }]));
    }
    if (url.pathname === "/api/v2/groups") {
      return new Response(JSON.stringify([{ id: 9, name: "Support France", agent_ids: [42] }]));
    }
    if (url.pathname === "/api/v2/search/solutions") {
      return new Response(JSON.stringify([{ id: 801, title: "Redémarrer une imprimante", description_text: "Procédure imprimante", status: 2 }]));
    }
    if (url.pathname === "/api/v2/canned_response_folders") {
      return new Response(JSON.stringify([{ id: 901, name: "Imprimantes", responses_count: 1 }]));
    }
    if (url.pathname === "/api/v2/canned_response_folders/901/responses") {
      return new Response(JSON.stringify([{ id: 902, folder_id: 901, title: "Diagnostic imprimante", content: "Procédure imprimante à suivre" }]));
    }
    if (url.pathname === "/api/v2/contacts/88") {
      return new Response(JSON.stringify({ id: 88, name: "Camille Client", email: "camille@example.com", company_id: 77 }));
    }
    if (url.pathname === "/api/v2/companies/77") {
      return new Response(JSON.stringify({ id: 77, name: "Client Co", domains: ["client.example"] }));
    }
    if (url.pathname === "/api/v2/search/tickets") {
      ticketSearchQueries.push(url.searchParams.get("query") ?? "");
      if (options.rejectTicketSearch) {
        return new Response(JSON.stringify({ code: "invalid_query" }), { status: 400 });
      }
      return new Response(JSON.stringify({ total: 2, results: [
        { id: 124, subject: "Incident critique", status: 2, priority: 4, group_id: 9, due_by: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z" },
        { id: 125, subject: "Question récente", status: 3, priority: 2, responder_id: 42, group_id: 9, due_by: "2027-08-01T00:00:00Z", updated_at: "2026-09-12T00:00:00Z" },
      ] }));
    }
    if (url.pathname === "/api/v2/tickets" && method === "GET") {
      return new Response(JSON.stringify([
        { id: 123, subject: "Printer offline", status: 2, priority: 2, requester_id: 88, company_id: 77, due_by: "2026-08-13T12:00:00Z", created_at: "2026-08-10T12:00:00Z", updated_at: updatedAt },
        { id: 120, subject: "Old request", status: 5, priority: 1, requester_id: 88, company_id: 77, created_at: "2026-01-01T12:00:00Z", updated_at: "2026-01-02T12:00:00Z" },
      ]));
    }
    if (url.pathname === "/api/v2/tickets/123" && method === "PUT") {
      writes += 1;
      const payload = JSON.parse(String(init?.body)) as { status?: number };
      if (!options.ignoreUpdate) status = payload.status ?? status;
      return new Response(JSON.stringify({ id: 123, subject: "Printer offline", status, priority: 2 }));
    }
    if (url.pathname === "/api/v2/tickets/123/notes" && method === "POST") {
      writes += 1;
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      note = { id: 999, ticket_id: 123, body: payload.body, private: payload.private, notified_to: payload.notify_emails ?? [] };
      return new Response(JSON.stringify(note));
    }
    if (url.pathname === "/api/v2/tickets/123/conversations") {
      const baseline = [{ id: 400, body_text: "Pouvez-vous nous aider ?", incoming: true, private: false,
        attachments: [{ id: 701, name: "log.txt", content_type: "text/plain", size: 80, attachment_url: "https://cdn.freshdesk.com/log.txt" }] }];
      return new Response(JSON.stringify(!note ? baseline : options.noteReadback === "missing" ? [] : [...baseline, { ...note,
        ...(options.noteReadback === "public" ? { private: false } : {}),
        ...(options.noteReadback === "wrong_body" ? { body: "Changed body" } : {}),
      }]));
    }
    return new Response(JSON.stringify([]));
  }) as typeof fetch;
  return {
    fetchFn,
    writeCount: () => writes,
    accountReadCount: () => accountReads,
    changeTicket: () => { updatedAt = "2026-09-06T10:00:00Z"; },
    searchQueries: () => ticketSearchQueries,
  };
}

const protocolMeta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "freshdesk-mcp-tests", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": { elicitation: {} },
};

async function rpc(service: FreshdeskMcpApp, token: string, id: number, method: string, params: Record<string, unknown>) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    host: "127.0.0.1:8788",
    "mcp-method": method,
    "mcp-protocol-version": "2026-07-28",
  };
  if (typeof params.name === "string") headers["mcp-name"] = params.name;
  if (typeof params.uri === "string") headers["mcp-name"] = params.uri;
  const response = await service.app.request("/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params: { _meta: protocolMeta, ...params } }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Record<string, any>;
}

async function connect(service: FreshdeskMcpApp): Promise<{ accessToken: string; refreshToken: string }> {
  const client = service.oauth.registerClient({
    client_name: "ChatGPT Work",
    redirect_uris: ["https://chatgpt.com/aip/callback"],
    token_endpoint_auth_method: "none",
    scope: "freshdesk:read freshdesk:write offline_access",
    application_type: "web",
  });
  const verifier = "v".repeat(43);
  const parameters = new URLSearchParams({
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: client.redirectUris[0]!,
    state: "state-value-123",
    scope: "freshdesk:read freshdesk:write offline_access",
    code_challenge: sha256Base64Url(verifier),
    code_challenge_method: "S256",
    resource: service.oauth.config.resourceUrl.href,
  });
  const started = await service.oauth.beginAuthorization(parameters);
  const approved = await service.oauth.approveAuthorization({ requestId: started.requestId, tenant: "acme", apiKey: "secret-key" });
  const tokens = service.oauth.exchangeAuthorizationCode({
    code: approved.code,
    clientId: client.clientId,
    redirectUri: client.redirectUris[0]!,
    codeVerifier: verifier,
    resource: service.oauth.config.resourceUrl.href,
  });
  return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token! };
}

describe("OAuth identity and MCP 2026-07-28", () => {
  it("stores per-identity usage statistics without request or ticket content", async () => {
    const directory = mkdtempSync(join(tmpdir(), "freshdesk-mcp-usage-integration-"));
    const databasePath = join(directory, "freshdesk.sqlite3");
    const fake = createFakeFreshdesk();
    const service = createFreshdeskMcpApp(config(databasePath), {
      freshdeskClientFactory: (origin, apiKey) => new FreshdeskClient({ origin, apiKey, fetchFn: fake.fetchFn }),
    });
    try {
      const tokens = await connect(service);
      await rpc(service, tokens.accessToken, 1, "tools/call", { name: "freshdesk_health", arguments: {} });
      await rpc(service, tokens.accessToken, 2, "tools/call", { name: "freshdesk_semantic_index_status", arguments: {} });
      await rpc(service, tokens.accessToken, 3, "tools/call", {
        name: "freshdesk_prepare_ticket_action",
        arguments: { action: "update_ticket", ticketId: 123, status: 3 },
      });

      const inspected = new Database(databasePath, { readonly: true });
      const rows = inspected.prepare(`
        SELECT tool, action_kind, action_name, outcome, call_count, duration_sample_count,
          result_count_sample_count, write_sample_count, agent_id, agent_name, agent_email
        FROM usage_daily_stats
        WHERE agent_id = '42'
        ORDER BY tool
      `).all() as Array<Record<string, unknown>>;
      const auditColumns = inspected.prepare("PRAGMA table_info(audit_events)").all() as Array<{ name: string }>;
      inspected.close();

      expect(rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ tool: "freshdesk_health", action_kind: "read", call_count: 1, duration_sample_count: 1 }),
        expect.objectContaining({ tool: "freshdesk_semantic_index_status", action_kind: "read", call_count: 1 }),
        expect.objectContaining({
          tool: "freshdesk_prepare_ticket_action",
          action_kind: "write_prepare",
          action_name: "update_ticket",
          write_sample_count: 1,
        }),
      ]));
      expect(rows.every((row) => row.agent_name === "Alice Agent" && row.agent_email === "alice@example.com")).toBe(true);
      expect(auditColumns.map((column) => column.name)).not.toContain("query");
      expect(auditColumns.map((column) => column.name)).not.toContain("request_body");
    } finally {
      await service.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects oversized request bodies before JSON parsing and preserves normal MCP requests", async () => {
    const fake = createFakeFreshdesk();
    const service = createFreshdeskMcpApp(config(), {
      freshdeskClientFactory: (origin, apiKey) => new FreshdeskClient({ origin, apiKey, fetchFn: fake.fetchFn }),
    });
    activeApps.push(service);

    const streamedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_REQUEST_BODY_BYTES + 1));
        controller.close();
      },
    });
    const streamed = await service.app.fetch(new Request("http://127.0.0.1:8788/mcp", {
      method: "POST",
      headers: { host: "127.0.0.1:8788", "content-type": "application/json" },
      body: streamedBody,
      duplex: "half",
    } as RequestInit));
    expect(streamed.status).toBe(413);
    expect(streamed.headers.get("x-request-id")).toBeTruthy();
    expect(streamed.headers.get("x-content-type-options")).toBe("nosniff");
    expect(streamed.headers.get("ratelimit-limit")).toBe("240");
    expect(await streamed.json()).toMatchObject({
      jsonrpc: "2.0",
      error: { code: -32000 },
    });

    const declared = await service.app.request("/mcp", {
      method: "POST",
      headers: {
        host: "127.0.0.1:8788",
        "content-type": "application/json",
        "content-length": String(MAX_REQUEST_BODY_BYTES + 1),
      },
      body: "{}",
    });
    expect(declared.status).toBe(413);

    let invalidHostBodyReads = 0;
    const invalidHostBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        invalidHostBodyReads += 1;
        controller.enqueue(new Uint8Array(1_024));
      },
    }, { highWaterMark: 0 });
    const invalidHost = await service.app.fetch(new Request("http://invalid.example/mcp", {
      method: "POST",
      headers: { host: "invalid.example", "content-type": "application/json" },
      body: invalidHostBody,
      duplex: "half",
    } as RequestInit));
    expect(invalidHost.status).toBe(403);
    expect(invalidHostBodyReads).toBe(0);

    const oversizedOAuth = await service.app.request("/oauth/register", {
      method: "POST",
      headers: {
        host: "127.0.0.1:8788",
        "content-type": "application/json",
        "content-length": String(MAX_REQUEST_BODY_BYTES + 1),
      },
      body: "{}",
    });
    expect(oversizedOAuth.status).toBe(413);
    expect(oversizedOAuth.headers.get("cache-control")).toBe("no-store");
    expect(oversizedOAuth.headers.get("pragma")).toBe("no-cache");
    expect(oversizedOAuth.headers.get("x-frame-options")).toBe("DENY");

    const missing = await service.app.request("/missing", {
      headers: { host: "127.0.0.1:8788" },
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not_found" });

    const tokens = await connect(service);
    const discovery = await rpc(service, tokens.accessToken, 100, "server/discover", {});
    expect(discovery.result.supportedVersions).toContain("2026-07-28");
  });

  it("allows the registered callback origin in the authorization form CSP", async () => {
    const service = createFreshdeskMcpApp(config());
    activeApps.push(service);
    const client = service.oauth.registerClient({
      client_name: "ChatGPT Work",
      redirect_uris: ["https://chatgpt.com/connector/oauth/test-callback"],
      token_endpoint_auth_method: "none",
      scope: "freshdesk:read freshdesk:write offline_access",
      application_type: "web",
    });
    const query = new URLSearchParams({
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: client.redirectUris[0]!,
      state: "state-value-123",
      scope: "freshdesk:read freshdesk:write offline_access",
      code_challenge: sha256Base64Url("v".repeat(43)),
      code_challenge_method: "S256",
      resource: service.oauth.config.resourceUrl.href,
    });

    const response = await service.app.request(`/oauth/authorize?${query}`, {
      headers: { host: "127.0.0.1:8788" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain(
      "form-action 'self' https://chatgpt.com",
    );
  });

  it("advertises CIMD and keeps offline_access out of protected-resource requirements", async () => {
    const service = createFreshdeskMcpApp(config());
    activeApps.push(service);

    const authorizationMetadata = await service.app.request("/.well-known/oauth-authorization-server", {
      headers: { host: "127.0.0.1:8788" },
    });
    expect(authorizationMetadata.status).toBe(200);
    expect(await authorizationMetadata.json()).toMatchObject({
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
      scopes_supported: ["freshdesk:read", "freshdesk:write", "offline_access"],
    });

    const resourceMetadata = await service.app.request("/.well-known/oauth-protected-resource/mcp", {
      headers: { host: "127.0.0.1:8788" },
    });
    expect(resourceMetadata.status).toBe(200);
    expect((await resourceMetadata.json()).scopes_supported).toEqual(["freshdesk:read", "freshdesk:write"]);
  });

  it("accepts ChatGPT CIMD when none is supported but private_key_jwt is preferred", async () => {
    const clientId = "https://chatgpt.com/oauth/client.json";
    const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
    const cimd = {
      client_id: clientId,
      client_name: "ChatGPT",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "private_key_jwt",
      token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
    };
    const service = createFreshdeskMcpApp(config(), {
      fetchFn: (async (input: RequestInfo | URL) => {
        expect(String(input)).toBe(clientId);
        return new Response(JSON.stringify(cimd), { headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });
    activeApps.push(service);
    const query = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      state: "state-value-123",
      scope: "freshdesk:read freshdesk:write offline_access",
      code_challenge: sha256Base64Url("v".repeat(43)),
      code_challenge_method: "S256",
      resource: service.oauth.config.resourceUrl.href,
    });

    const response = await service.app.request(`/oauth/authorize?${query}`, {
      headers: { host: "127.0.0.1:8788" },
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.text()).toContain("Connecter votre compte Freshdesk");
  });

  it("discovers the v0.2 tools and strict structured contracts under the connected Freshdesk identity", async () => {
    const fake = createFakeFreshdesk();
    const service = createFreshdeskMcpApp(config(), {
      freshdeskClientFactory: (origin, apiKey) => new FreshdeskClient({ origin, apiKey, fetchFn: fake.fetchFn }),
    });
    activeApps.push(service);
    const tokens = await connect(service);

    const discovery = await rpc(service, tokens.accessToken, 1, "server/discover", {});
    expect(discovery.result.supportedVersions).toContain("2026-07-28");
    const listed = await rpc(service, tokens.accessToken, 2, "tools/list", {});
    expect(listed.result.tools).toHaveLength(24);
    const semanticSolutions = listed.result.tools.find((tool: { name: string }) => tool.name === "freshdesk_find_problem_solutions");
    expect(semanticSolutions.inputSchema.properties.minimumSimilarity.default).toBe(0.72);
    const recurringIncidents = listed.result.tools.find((tool: { name: string }) => tool.name === "freshdesk_discover_recurring_incidents");
    expect(recurringIncidents.inputSchema.properties.similarityThreshold.default).toBe(0.9);
    expect(recurringIncidents.inputSchema.properties.includeMonitoringAlerts.default).toBe(false);
    expect(recurringIncidents.inputSchema.properties.crossCompany.default).toBe(false);
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toContain("freshdesk_get_company_context");
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toContain("freshdesk_triage_queue");
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toContain("freshdesk_get_customer_360");
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toContain("freshdesk_get_ticket_contexts");
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toContain("freshdesk_search_tickets_expert");
    const ticketSearch = listed.result.tools.find((tool: { name: string }) => tool.name === "freshdesk_search_tickets");
    expect(ticketSearch.inputSchema.properties.expertQuery).toBeUndefined();
    expect(ticketSearch.inputSchema.properties.query).toBeUndefined();
    expect(ticketSearch.inputSchema.properties.filter.enum).toEqual(["new_and_my_open", "watching", "spam", "deleted"]);
    const expertSearch = listed.result.tools.find((tool: { name: string }) => tool.name === "freshdesk_search_tickets_expert");
    expect(expertSearch.inputSchema.required).toContain("expertQuery");
    expect(expertSearch.inputSchema.properties.requesterId).toBeUndefined();
    const cockpit = listed.result.tools.find((tool: { name: string }) => tool.name === "freshdesk_get_ticket_context");
    expect(cockpit.inputSchema.additionalProperties).toBe(false);
    expect(cockpit.outputSchema.type).toBe("object");
    expect(cockpit._meta.ui.resourceUri).toBe("ui://freshdesk/ticket-cockpit-v3.html");
    const me = await rpc(service, tokens.accessToken, 3, "tools/call", { name: "freshdesk_me", arguments: {} });
    expect(me.result.structuredContent.agent).toMatchObject({ id: "42", email: "alice@example.com" });
  });

  it("connects agents without account-level API access and keeps identity usable", async () => {
    const fake = createFakeFreshdesk({ denyAccount: true });
    const service = createFreshdeskMcpApp(config(), {
      freshdeskClientFactory: (origin, apiKey) => new FreshdeskClient({ origin, apiKey, fetchFn: fake.fetchFn }),
    });
    activeApps.push(service);

    const tokens = await connect(service);
    expect(fake.accountReadCount()).toBe(0);

    const me = await rpc(service, tokens.accessToken, 30, "tools/call", { name: "freshdesk_me", arguments: {} });
    expect(me.result.isError).not.toBe(true);
    expect(me.result.structuredContent.agent).toMatchObject({ id: "42", email: "alice@example.com" });
    expect(me.result.structuredContent.account).toMatchObject({
      available: false,
      unavailableReason: "access_denied",
    });
    expect(fake.accountReadCount()).toBe(1);
  });

  it("renders the Ticket Cockpit with enriched, labelled, bounded context", async () => {
    const fake = createFakeFreshdesk();
    const service = createFreshdeskMcpApp(config(), {
      freshdeskClientFactory: (origin, apiKey) => new FreshdeskClient({ origin, apiKey, fetchFn: fake.fetchFn }),
    });
    activeApps.push(service);
    const tokens = await connect(service);

    const resource = await rpc(service, tokens.accessToken, 4, "resources/read", { uri: "ui://freshdesk/ticket-cockpit-v3.html" });
    expect(resource.result.contents[0]).toMatchObject({ uri: "ui://freshdesk/ticket-cockpit-v3.html", mimeType: "text/html;profile=mcp-app" });
    expect(resource.result.contents[0].text).toContain("Freshdesk");

    const context = await rpc(service, tokens.accessToken, 5, "tools/call", {
      name: "freshdesk_get_ticket_context",
      arguments: { ticketId: 123, conversationLimit: 10, maxConversationPages: 2, maxTimeEntryPages: 1, timeEntryLimit: 10 },
    });
    expect(context.result.structuredContent.ticket).toMatchObject({ id: 123, statusLabel: "Ouvert", priorityLabel: "Moyenne", sourceLabel: "E-mail" });
    expect(context.result.structuredContent.ticket.attachments).toHaveLength(1);
    expect(context.result.structuredContent.conversations[0].attachments).toHaveLength(1);
    expect(context.result.structuredContent.timeEntries).toHaveLength(1);
    expect(context.result.structuredContent.satisfactionRatings).toHaveLength(1);
    expect(context.result.structuredContent.ownership).toMatchObject({ responder: null, group: { name: "Support France" } });

    const batch = await rpc(service, tokens.accessToken, 31, "tools/call", {
      name: "freshdesk_get_ticket_contexts",
      arguments: { ticketIds: [123, 999], conversationLimit: 5, maxConversationPages: 1 },
    });
    expect(batch.result.structuredContent).toMatchObject({ requestedCount: 2, successCount: 1, failureCount: 1 });
    expect(batch.result.structuredContent.contexts[0].ticket).toMatchObject({ id: 123 });
    expect(batch.result.structuredContent.failures[0]).toMatchObject({ ticketId: 999, stage: "application" });
  });

  it("keeps structured ticket search separate from expert query mode", async () => {
    const fake = createFakeFreshdesk();
    const service = createFreshdeskMcpApp(config(), {
      freshdeskClientFactory: (origin, apiKey) => new FreshdeskClient({ origin, apiKey, fetchFn: fake.fetchFn }),
    });
    activeApps.push(service);
    const tokens = await connect(service);

    const structured = await rpc(service, tokens.accessToken, 32, "tools/call", {
      name: "freshdesk_search_tickets",
      arguments: { statuses: [2, 3], priorities: [4], groupIds: [9], unassigned: true, updatedFrom: "2026-10-01" },
    });
    expect(structured.result.isError).not.toBe(true);
    expect(fake.searchQueries()[0]).toBe("\"(status:2 OR status:3) AND priority:4 AND group_id:9 AND agent_id:null AND updated_at:>'2026-10-01'\"");

    const expert = await rpc(service, tokens.accessToken, 33, "tools/call", {
      name: "freshdesk_search_tickets_expert",
      arguments: { expertQuery: "status:2 OR status:3" },
    });
    expect(expert.result.isError).not.toBe(true);
    expect(fake.searchQueries()[1]).toBe("\"status:2 OR status:3\"");

    const recovered = await rpc(service, tokens.accessToken, 34, "tools/call", {
      name: "freshdesk_search_tickets_expert",
      arguments: { expertQuery: "requester_id:88" },
    });
    expect(recovered.result.isError).not.toBe(true);
    expect(recovered.result.structuredContent.updatedSince).toBeDefined();
    expect(fake.searchQueries()).toHaveLength(2);
  });

  it("guides rejected expert ticket searches toward structured fields", async () => {
    const fake = createFakeFreshdesk({ rejectTicketSearch: true });
    const service = createFreshdeskMcpApp(config(), {
      freshdeskClientFactory: (origin, apiKey) => new FreshdeskClient({ origin, apiKey, fetchFn: fake.fetchFn }),
    });
    activeApps.push(service);
    const tokens = await connect(service);

    const rejected = await rpc(service, tokens.accessToken, 35, "tools/call", {
      name: "freshdesk_search_tickets_expert",
      arguments: { expertQuery: "unsupported:value" },
    });
    expect(rejected.result.isError).toBe(true);
    expect(rejected.result.content[0].text).toContain("Do not retry the same expert query");
    expect(rejected.result.content[0].text).toContain("requesterId or companyId");
  });

  it("triages tickets and builds Customer 360 and knowledge context", async () => {
    const fake = createFakeFreshdesk();
    const service = createFreshdeskMcpApp(config(), {
      freshdeskClientFactory: (origin, apiKey) => new FreshdeskClient({ origin, apiKey, fetchFn: fake.fetchFn }),
    });
    activeApps.push(service);
    const tokens = await connect(service);

    const triage = await rpc(service, tokens.accessToken, 6, "tools/call", {
      name: "freshdesk_triage_queue", arguments: { onlyOverdue: true, staleDays: 7, maxPages: 2, limit: 10 },
    });
    expect(triage.result.structuredContent.tickets).toHaveLength(1);
    expect(triage.result.structuredContent.tickets[0]).toMatchObject({ id: 124, priorityLabel: "Urgente", overdue: true, groupName: "Support France" });

    const customer = await rpc(service, tokens.accessToken, 7, "tools/call", {
      name: "freshdesk_get_customer_360", arguments: { contactId: 88, maxTicketPages: 2, recentTicketLimit: 10 },
    });
    expect(customer.result.structuredContent).toMatchObject({ subjectType: "contact", brief: { total: 2, countState: "exact", active: 1 } });

    const knowledge = await rpc(service, tokens.accessToken, 8, "tools/call", {
      name: "freshdesk_search_knowledge", arguments: { query: "imprimante", includeCannedResponses: true },
    });
    expect(knowledge.result.structuredContent.articles).toHaveLength(1);
    expect(knowledge.result.structuredContent.cannedResponses).toHaveLength(1);
  });

  it("prepares without writing, confirms with MRTR, writes once, and blocks replay", async () => {
    const fake = createFakeFreshdesk();
    const service = createFreshdeskMcpApp(config(), {
      freshdeskClientFactory: (origin, apiKey) => new FreshdeskClient({ origin, apiKey, fetchFn: fake.fetchFn }),
    });
    activeApps.push(service);
    const tokens = await connect(service);

    const prepared = await rpc(service, tokens.accessToken, 10, "tools/call", {
      name: "freshdesk_prepare_ticket_action",
      arguments: { action: "update_ticket", ticketId: 123, status: 3 },
    });
    expect(prepared.result.structuredContent.writeApplied).toBe(false);
    expect(fake.writeCount()).toBe(0);
    const intentId = prepared.result.structuredContent.intentId as string;

    const requested = await rpc(service, tokens.accessToken, 11, "tools/call", {
      name: "freshdesk_execute_ticket_action",
      arguments: { intentId },
    });
    expect(requested.result.resultType).toBe("input_required");
    expect(fake.writeCount()).toBe(0);

    const confirmed = await rpc(service, tokens.accessToken, 12, "tools/call", {
      name: "freshdesk_execute_ticket_action",
      arguments: { intentId },
      inputResponses: { confirm: { action: "accept", content: { confirm: true } } },
      requestState: requested.result.requestState,
    });
    expect(confirmed.result.structuredContent).toMatchObject({ writeApplied: true, readbackVerified: true, ticketId: 123 });
    expect(fake.writeCount()).toBe(1);

    const replayed = await rpc(service, tokens.accessToken, 13, "tools/call", {
      name: "freshdesk_execute_ticket_action",
      arguments: { intentId },
      inputResponses: { confirm: { action: "accept", content: { confirm: true } } },
      requestState: requested.result.requestState,
    });
    expect(replayed.result.isError).toBe(true);
    expect(fake.writeCount()).toBe(1);
  });

  it("rotates refresh tokens and invalidates the family after reuse", async () => {
    const fake = createFakeFreshdesk();
    const service = createFreshdeskMcpApp(config(), {
      freshdeskClientFactory: (origin, apiKey) => new FreshdeskClient({ origin, apiKey, fetchFn: fake.fetchFn }),
    });
    activeApps.push(service);
    const tokens = await connect(service);
    const auth = await service.oauth.verifyAccessToken(tokens.accessToken);
    const rotated = service.oauth.exchangeRefreshToken({ refreshToken: tokens.refreshToken, clientId: auth.clientId });

    expect(rotated.refresh_token).toBeTruthy();
    expect(() => service.oauth.exchangeRefreshToken({ refreshToken: tokens.refreshToken, clientId: auth.clientId })).toThrow(/reused/);
    await expect(service.oauth.verifyAccessToken(rotated.access_token)).rejects.toThrow(/invalid or expired/);
  });
});

async function prepareAndRequest(service: FreshdeskMcpApp, accessToken: string, arguments_: Record<string, unknown>) {
  const prepared = await rpc(service, accessToken, 20, "tools/call", { name: "freshdesk_prepare_ticket_action", arguments: arguments_ });
  const intentId = prepared.result.structuredContent.intentId;
  const requested = await rpc(service, accessToken, 21, "tools/call", { name: "freshdesk_execute_ticket_action", arguments: { intentId } });
  return { intentId, requestState: requested.result.requestState };
}

async function confirmIntent(service: FreshdeskMcpApp, token: string, intent: { intentId: string; requestState: string }, confirm = true) {
  return rpc(service, token, 22, "tools/call", {
    name: "freshdesk_execute_ticket_action", arguments: { intentId: intent.intentId }, requestState: intent.requestState,
    inputResponses: { confirm: { action: "accept", content: { confirm } } },
  });
}

describe("Write and OAuth regressions", () => {
  it.each([
    {
      label: "network failure",
      fetchFn: (async () => { throw new Error("dns unavailable"); }) as typeof fetch,
      expected: "Le serveur MCP n’a pas pu joindre Freshdesk",
    },
    {
      label: "invalid API key",
      fetchFn: (async () => new Response(JSON.stringify({ code: "invalid_credentials" }), { status: 401 })) as typeof fetch,
      expected: "Freshdesk a refusé la clé API",
    },
    {
      label: "insufficient agent rights",
      fetchFn: (async () => new Response(JSON.stringify({ code: "access_denied" }), { status: 403 })) as typeof fetch,
      expected: "cet agent ne dispose pas des droits nécessaires",
    },
  ])("reports $label without exposing credentials", async ({ fetchFn, expected }) => {
    const service = createFreshdeskMcpApp(config(), {
      freshdeskClientFactory: (origin, apiKey) => new FreshdeskClient({
        origin,
        apiKey,
        fetchFn,
        maxReadRetries: 0,
      }),
    });
    activeApps.push(service);
    const client = service.oauth.registerClient({ redirect_uris: ["https://chatgpt.com/callback"] });
    const started = await service.oauth.beginAuthorization(new URLSearchParams({
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: client.redirectUris[0]!,
      state: "test-state",
      code_challenge: sha256Base64Url("v".repeat(43)),
      code_challenge_method: "S256",
      resource: service.oauth.config.resourceUrl.href,
    }));

    const response = await service.app.request("/oauth/authorize", {
      method: "POST",
      headers: {
        host: "127.0.0.1:8788",
        cookie: `freshdesk_mcp_auth_req=${started.requestId}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        request_id: started.requestId,
        decision: "allow",
        tenant: "acme",
        api_key: "test-only-key",
      }),
    });

    const html = await response.text();
    expect(response.status).toBe(400);
    expect(html).toContain(expected);
    expect(html).not.toContain("test-only-key");
  });

  it("does not claim verification just because the ticket GET succeeded", async () => {
    const fake = createFakeFreshdesk({ ignoreUpdate: true });
    const service = createFreshdeskMcpApp(config(), { freshdeskClientFactory: (origin, apiKey) => new FreshdeskClient({ origin, apiKey, fetchFn: fake.fetchFn }) });
    activeApps.push(service);
    const tokens = await connect(service);
    const intent = await prepareAndRequest(service, tokens.accessToken, { action: "update_ticket", ticketId: 123, status: 3 });
    const result = await confirmIntent(service, tokens.accessToken, intent);
    expect(result.result.structuredContent).toMatchObject({ writeApplied: true, readbackVerified: false, verificationIssues: ["status"] });
    expect(fake.writeCount()).toBe(1);
  });

  it.each(["wrong_body", "public", "missing"] as const)("checks the actual created conversation: %s", async (noteReadback) => {
    const fake = createFakeFreshdesk({ noteReadback });
    const service = createFreshdeskMcpApp(config(), { freshdeskClientFactory: (origin, apiKey) => new FreshdeskClient({ origin, apiKey, fetchFn: fake.fetchFn }) });
    activeApps.push(service);
    const tokens = await connect(service);
    const intent = await prepareAndRequest(service, tokens.accessToken, { action: "private_note", ticketId: 123, bodyHtml: "<p>Hello</p>", notifyEmails: ["agent@example.com"] });
    const result = await confirmIntent(service, tokens.accessToken, intent);
    expect(result.result.structuredContent).toMatchObject({ writeApplied: true, readbackVerified: false });
    expect(fake.writeCount()).toBe(1);
  });

  it("verifies a private note including its notification recipients", async () => {
    const fake = createFakeFreshdesk();
    const service = createFreshdeskMcpApp(config(), { freshdeskClientFactory: (origin, apiKey) => new FreshdeskClient({ origin, apiKey, fetchFn: fake.fetchFn }) });
    activeApps.push(service);
    const tokens = await connect(service);
    const intent = await prepareAndRequest(service, tokens.accessToken, { action: "private_note", ticketId: 123, bodyHtml: "<p>Hello</p>", notifyEmails: ["agent@example.com"] });
    const result = await confirmIntent(service, tokens.accessToken, intent);
    expect(result.result.structuredContent).toMatchObject({ writeApplied: true, readbackVerified: true, verificationIssues: [] });
    expect(fake.writeCount()).toBe(1);
  });

  it.each(["cancel", "stale"] as const)("prevents a write after %s", async (mode) => {
    const fake = createFakeFreshdesk();
    const service = createFreshdeskMcpApp(config(), { freshdeskClientFactory: (origin, apiKey) => new FreshdeskClient({ origin, apiKey, fetchFn: fake.fetchFn }) });
    activeApps.push(service);
    const tokens = await connect(service);
    const intent = await prepareAndRequest(service, tokens.accessToken, { action: "update_ticket", ticketId: 123, status: 3 });
    if (mode === "stale") fake.changeTicket();
    const result = await confirmIntent(service, tokens.accessToken, intent, mode !== "cancel");
    expect(result.result.isError).toBe(true);
    expect(fake.writeCount()).toBe(0);
  });

  it.each(["client", "resource", "scope"] as const)("preserves the refresh token after an invalid %s", async (field) => {
    const fake = createFakeFreshdesk();
    const service = createFreshdeskMcpApp(config(), { freshdeskClientFactory: (origin, apiKey) => new FreshdeskClient({ origin, apiKey, fetchFn: fake.fetchFn }) });
    activeApps.push(service);
    const tokens = await connect(service);
    const auth = await service.oauth.verifyAccessToken(tokens.accessToken);
    expect(() => service.oauth.exchangeRefreshToken({ refreshToken: tokens.refreshToken,
      clientId: field === "client" ? "wrong" : auth.clientId,
      ...(field === "resource" ? { resource: "https://other.example/mcp" } : {}),
      ...(field === "scope" ? { scope: "admin" } : {}),
    })).toThrow();
    expect(service.oauth.exchangeRefreshToken({ refreshToken: tokens.refreshToken, clientId: auth.clientId }).refresh_token).toBeTruthy();
  });

  it("cancels OAuth without asking for tenant or API credentials", async () => {
    const service = createFreshdeskMcpApp(config());
    activeApps.push(service);
    const client = service.oauth.registerClient({ redirect_uris: ["https://chatgpt.com/callback"] });
    const started = await service.oauth.beginAuthorization(new URLSearchParams({ response_type: "code", client_id: client.clientId,
      redirect_uri: client.redirectUris[0]!, state: "test-state", code_challenge: sha256Base64Url("v".repeat(43)),
      code_challenge_method: "S256", resource: service.oauth.config.resourceUrl.href }));
    const response = await service.app.request("/oauth/authorize", { method: "POST", headers: { host: "127.0.0.1:8788",
      cookie: `freshdesk_mcp_auth_req=${started.requestId}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request_id: started.requestId, decision: "deny" }) });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("error=access_denied");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(service.oauth.getPendingAuthorization(started.requestId)).toBeUndefined();
  });
});
