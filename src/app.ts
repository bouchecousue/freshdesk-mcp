import { createMcpHonoApp } from "@modelcontextprotocol/hono";
import {
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  requireBearerAuth,
  type AuthInfo,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import { Hono, type Context } from "hono";

import type { AppConfig } from "./config.js";
import { SecretManager } from "./crypto.js";
import { AppDatabase } from "./database.js";
import type { FreshdeskClient } from "./freshdesk/client.js";
import { Logger } from "./logger.js";
import { createFreshdeskMcpServer } from "./mcp/tools.js";
import { registerOAuthRoutes } from "./oauth/routes.js";
import { OAuthService } from "./oauth/service.js";
import { rateLimit } from "./rate-limit.js";

export interface AppOverrides {
  database?: AppDatabase;
  secrets?: SecretManager;
  logger?: Logger;
  freshdeskClientFactory?: (origin: string, apiKey: string) => FreshdeskClient;
  fetchFn?: typeof fetch;
}

export interface FreshdeskMcpApp {
  app: Hono;
  database: AppDatabase;
  oauth: OAuthService;
  handler: McpHttpHandler;
  close(): Promise<void>;
}

export const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;

function securityHeaders(headers: Headers): void {
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  headers.set("Cross-Origin-Resource-Policy", "same-site");
}

function oauthSecurityHeaders(headers: Headers): void {
  headers.set("Cache-Control", "no-store");
  headers.set("Pragma", "no-cache");
  headers.set("X-Frame-Options", "DENY");
}

function serviceDocument(config: AppConfig): string {
  const mcp = config.resourceUrl.href.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Freshdesk MCP</title><style>body{font:16px/1.55 system-ui,sans-serif;max-width:760px;margin:8vh auto;padding:0 24px;color:#14211d}code{background:#eef4f1;padding:.15rem .35rem;border-radius:.25rem}</style></head>
<body><h1>Freshdesk MCP</h1><p>Connecteur MCP BoucheCousue pour ChatGPT Work. Chaque utilisateur autorise son propre compte Freshdesk.</p>
<p>Point de terminaison MCP&nbsp;: <code>${mcp}</code></p><p>État&nbsp;: <a href="/health">/health</a></p></body></html>`;
}

export function createFreshdeskMcpApp(config: AppConfig, overrides: AppOverrides = {}): FreshdeskMcpApp {
  const database = overrides.database ?? new AppDatabase(config.databasePath);
  const secrets = overrides.secrets ?? new SecretManager(config.masterKey);
  const logger = overrides.logger ?? new Logger();
  const oauth = new OAuthService(
    config,
    database,
    secrets,
    logger,
    overrides.freshdeskClientFactory,
    overrides.fetchFn,
  );
  const allowedHosts = [config.publicUrl.hostname, "localhost", "127.0.0.1", "[::1]"];
  const protocolApp = createMcpHonoApp({
    host: config.host,
    allowedHosts: [...new Set(allowedHosts)],
    allowedOrigins: [...new Set([...allowedHosts, ...config.cimdAllowedHostSuffixes, "chat.openai.com"])],
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
  });
  const app = new Hono();

  app.use("*", async (context, next) => {
    const started = performance.now();
    const correlationId = context.req.header("x-request-id")?.slice(0, 100) || crypto.randomUUID();
    try {
      await next();
    } finally {
      context.res.headers.set("X-Request-Id", correlationId);
      securityHeaders(context.res.headers);
      logger.info("http_request", {
        correlationId,
        method: context.req.method,
        path: new URL(context.req.url).pathname,
        status: context.res.status,
        durationMs: Math.round(performance.now() - started),
      });
    }
  });

  app.use("/oauth/*", async (context, next) => {
    await next();
    oauthSecurityHeaders(context.res.headers);
  });

  app.use("/oauth/register", rateLimit({ windowMs: 60 * 60_000, limit: 20, keyPrefix: "oauth-register" }));
  app.use("/oauth/authorize", rateLimit({ windowMs: 15 * 60_000, limit: 60, keyPrefix: "oauth-authorize" }));
  app.use("/oauth/token", rateLimit({ windowMs: 60_000, limit: 60, keyPrefix: "oauth-token" }));
  app.use("/mcp", rateLimit({ windowMs: 60_000, limit: 240, keyPrefix: "mcp" }));

  registerOAuthRoutes(protocolApp, oauth);

  const handler = createMcpHandler(
    (context) =>
      createFreshdeskMcpServer(
        {
          config,
          database,
          secrets,
          logger,
          ...(overrides.freshdeskClientFactory ? { freshdeskClientFactory: overrides.freshdeskClientFactory } : {}),
        },
        context.authInfo,
      ),
    {
      legacy: "stateless",
      responseMode: "auto",
      onerror(error) {
        logger.error("mcp_handler_error", { error });
      },
    },
  );
  const authGate = requireBearerAuth({
    verifier: { verifyAccessToken: (token: string) => oauth.verifyAccessToken(token) },
    requiredScopes: ["freshdesk:read"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(config.resourceUrl),
  });

  const serveMcp = async (request: Request, parsedBody: unknown): Promise<Response> => {
    const auth: AuthInfo | Response = await authGate(request);
    if (!("token" in auth)) return auth;
    return handler.fetch(request, { authInfo: auth, parsedBody });
  };
  protocolApp.on(["POST", "GET", "DELETE"], "/mcp", (context) => {
    const typedContext = context as unknown as Context<{ Variables: { parsedBody: unknown } }>;
    return serveMcp(context.req.raw, typedContext.get("parsedBody"));
  });

  protocolApp.get("/health", (context) =>
    context.json({ status: "ok", service: "freshdesk-mcp", version: "0.3.4", protocol: "2026-07-28" }),
  );
  protocolApp.get("/", (context) => context.html(serviceDocument(config)));
  app.route("/", protocolApp);
  app.notFound((context) => context.json({ error: "not_found" }, 404));
  app.onError((error, context) => {
    logger.error("http_unhandled_error", { error, path: new URL(context.req.url).pathname });
    return context.json({ error: "server_error" }, 500);
  });

  const purgeTimer = setInterval(() => database.purgeExpired(Math.floor(Date.now() / 1_000)), 15 * 60_000);
  purgeTimer.unref();

  return {
    app,
    database,
    oauth,
    handler,
    async close() {
      clearInterval(purgeTimer);
      await handler.close();
      database.close();
    },
  };
}
