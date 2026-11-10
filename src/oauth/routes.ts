import {
  buildOAuthProtectedResourceMetadata,
  getOAuthProtectedResourceMetadataUrl,
  oauthMetadataResponse,
} from "@modelcontextprotocol/server";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import { randomOpaqueToken } from "../crypto.js";
import { FreshdeskApiError } from "../freshdesk/client.js";
import { renderCompletion, renderConnectionForm } from "./html.js";
import { OAuthService } from "./service.js";

const AUTH_COOKIE = "freshdesk_mcp_auth_req";

function oauthErrorBody(error: unknown): { error: string; error_description: string } {
  if (error && typeof error === "object" && "code" in error && "message" in error) {
    return { error: String(error.code), error_description: String(error.message) };
  }
  return { error: "server_error", error_description: "The authorization server encountered an error" };
}

function connectionErrorMessage(error: unknown): string {
  if (!(error instanceof FreshdeskApiError)) {
    return "La connexion n’a pas pu être validée. Vérifiez le domaine Freshdesk natif et réessayez.";
  }
  if (error.status === 0 || error.code === "network_error") {
    return "Le serveur MCP n’a pas pu joindre Freshdesk. Réessayez dans quelques instants ; si le problème persiste, l’administrateur doit vérifier le réseau et le DNS du Mac mini.";
  }
  if (error.code === "redirect_refused") {
    return "Freshdesk a redirigé la requête. Vérifiez que vous utilisez le domaine natif en *.freshdesk.com, sans chemin ni adresse personnalisée.";
  }
  if (error.status === 401) {
    return "Freshdesk a refusé la clé API. Utilisez la clé personnelle actuelle de votre profil Freshdesk, sans espace avant ou après.";
  }
  if (error.status === 403) {
    return "Freshdesk a reconnu l’identité, mais cet agent ne dispose pas des droits nécessaires pour valider la connexion.";
  }
  if (error.status === 429 || error.status >= 500) {
    return "Freshdesk est temporairement indisponible ou limite les requêtes. Réessayez dans quelques instants.";
  }
  return "Freshdesk a refusé la validation. Vérifiez le domaine natif, la clé API personnelle et les droits de l’agent.";
}

function redirectWithError(redirectUri: string, state: string, issuer: string, code: string, description: string): string {
  const target = new URL(redirectUri);
  target.searchParams.set("error", code);
  target.searchParams.set("error_description", description);
  target.searchParams.set("state", state);
  target.searchParams.set("iss", issuer);
  return target.href;
}

function redirectWithCode(redirectUri: string, state: string, issuer: string, code: string): string {
  const target = new URL(redirectUri);
  target.searchParams.set("code", code);
  target.searchParams.set("state", state);
  target.searchParams.set("iss", issuer);
  return target.href;
}

function securityHeaders(headers: Headers, nonce?: string, redirectUri?: string): void {
  headers.set("Cache-Control", "no-store");
  headers.set("Pragma", "no-cache");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  if (nonce) {
    const formActions = ["'self'"];
    if (redirectUri) formActions.push(new URL(redirectUri).origin);
    headers.set(
      "Content-Security-Policy",
      `default-src 'none'; style-src 'nonce-${nonce}'; form-action ${formActions.join(" ")}; base-uri 'none'; frame-ancestors 'none'`,
    );
  }
}

function formString(body: Record<string, unknown>, key: string, maxLength: number): string {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) throw new Error(`Invalid ${key}`);
  return value;
}

export function registerOAuthRoutes(app: Hono, oauth: OAuthService): void {
  const metadataOptions = {
    oauthMetadata: oauth.metadata,
    resourceServerUrl: oauth.config.resourceUrl,
    serviceDocumentationUrl: new URL("/", oauth.config.publicUrl),
    // offline_access is an authorization-server capability, not a protected-resource requirement.
    scopesSupported: ["freshdesk:read", "freshdesk:write"],
    resourceName: "Freshdesk MCP",
    dangerouslyAllowInsecureIssuerUrl: oauth.config.nodeEnv !== "production",
  };
  buildOAuthProtectedResourceMetadata(metadataOptions);

  app.use("/oauth/*", async (context, next) => {
    await next();
    securityHeaders(context.res.headers);
  });

  app.use("*", async (context, next) => {
    const discovery = oauthMetadataResponse(context.req.raw, metadataOptions);
    if (discovery) return discovery;
    await next();
  });

  app.post("/oauth/register", bodyLimit({ maxSize: 32 * 1024 }), async (context) => {
    try {
      const input = await context.req.json();
      const client = oauth.registerClient(input as never);
      const response = context.json(
        {
          client_id: client.clientId,
          client_id_issued_at: client.createdAt,
          client_name: client.clientName,
          redirect_uris: client.redirectUris,
          token_endpoint_auth_method: client.tokenEndpointAuthMethod,
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          scope: client.scope,
        },
        201,
      );
      securityHeaders(response.headers);
      return response;
    } catch (error) {
      oauth.logger.warn("oauth_registration_rejected", { error });
      const response = context.json({ error: "invalid_client_metadata", error_description: "Invalid client metadata" }, 400);
      securityHeaders(response.headers);
      return response;
    }
  });

  app.get("/oauth/authorize", async (context) => {
    try {
      const started = await oauth.beginAuthorization(new URL(context.req.url).searchParams);
      setCookie(context, AUTH_COOKIE, started.requestId, {
        httpOnly: true,
        secure: oauth.config.publicUrl.protocol === "https:",
        sameSite: "Lax",
        path: "/oauth/authorize",
        maxAge: oauth.config.authRequestTtlSeconds,
      });
      const nonce = randomOpaqueToken(18);
      const response = context.html(
        renderConnectionForm({
          nonce,
          requestId: started.requestId,
          clientName: started.client.clientName,
          scopes: started.pending.scope.split(" "),
        }),
      );
      // A form-action policy also applies to redirects produced by the form submission.
      // Permit only the origin of the callback URI that was already validated for this client.
      securityHeaders(response.headers, nonce, started.pending.redirectUri);
      return response;
    } catch (error) {
      const body = oauthErrorBody(error);
      oauth.logger.warn("oauth_authorization_rejected", { code: body.error });
      const response = context.json(body, body.error === "invalid_client" ? 401 : 400);
      securityHeaders(response.headers);
      return response;
    }
  });

  app.post("/oauth/authorize", bodyLimit({ maxSize: 16 * 1024 }), async (context) => {
    let requestId = "";
    let tenant = "";
    try {
      const body = await context.req.parseBody();
      requestId = formString(body, "request_id", 200);
      const cookie = getCookie(context, AUTH_COOKIE);
      if (!cookie || cookie !== requestId) throw new Error("Authorization request cookie mismatch");
      const decision = formString(body, "decision", 10);
      if (decision === "deny") {
        const pending = oauth.cancelAuthorization(requestId);
        deleteCookie(context, AUTH_COOKIE, { path: "/oauth/authorize" });
        if (!pending) throw new Error("Authorization request expired");
        return context.redirect(
          redirectWithError(
            pending.redirectUri,
            pending.state,
            oauth.config.publicUrl.origin,
            "access_denied",
            "The user denied the authorization request",
          ),
          302,
        );
      }
      if (decision !== "allow") throw new Error("Invalid authorization decision");
      tenant = formString(body, "tenant", 253);
      const apiKey = formString(body, "api_key", 1_000);
      const approved = await oauth.approveAuthorization({ requestId, tenant, apiKey });
      deleteCookie(context, AUTH_COOKIE, { path: "/oauth/authorize" });
      oauth.logger.info("oauth_authorization_approved", {
        userId: approved.user.id,
        agentId: approved.user.agentId,
        tenantOrigin: approved.user.tenantOrigin,
        clientId: approved.pending.clientId,
      });
      return context.redirect(
        redirectWithCode(
          approved.pending.redirectUri,
          approved.pending.state,
          oauth.config.publicUrl.origin,
          approved.code,
        ),
        302,
      );
    } catch (error) {
      const pending = requestId ? oauth.getPendingAuthorization(requestId) : undefined;
      if (pending) {
        const client = await oauth.resolveClient(pending.clientId);
        const nonce = randomOpaqueToken(18);
        const message = connectionErrorMessage(error);
        oauth.logger.warn("oauth_freshdesk_validation_failed", {
          failureType: error instanceof FreshdeskApiError ? "freshdesk_api" : "validation",
          freshdeskStatus: error instanceof FreshdeskApiError ? error.status : undefined,
          freshdeskCode: error instanceof FreshdeskApiError ? error.code : undefined,
        });
        const response = context.html(
          renderConnectionForm({
            nonce,
            requestId,
            clientName: client?.clientName ?? "ChatGPT",
            scopes: pending.scope.split(" "),
            error: message,
            tenant,
          }),
          400,
        );
        securityHeaders(response.headers, nonce, pending.redirectUri);
        return response;
      }
      const response = context.json({ error: "invalid_request", error_description: "Authorization request is invalid or expired" }, 400);
      securityHeaders(response.headers);
      return response;
    }
  });

  app.post("/oauth/token", bodyLimit({ maxSize: 16 * 1024 }), async (context) => {
    try {
      const body = await context.req.parseBody();
      const grantType = formString(body, "grant_type", 50);
      const clientId = formString(body, "client_id", 2_048);
      const client = await oauth.resolveClient(clientId);
      if (!client || client.tokenEndpointAuthMethod !== "none") {
        return context.json({ error: "invalid_client", error_description: "Client authentication failed" }, 401);
      }
      let tokens;
      if (grantType === "authorization_code") {
        tokens = oauth.exchangeAuthorizationCode({
          code: formString(body, "code", 500),
          clientId,
          redirectUri: formString(body, "redirect_uri", 2_048),
          codeVerifier: formString(body, "code_verifier", 200),
          ...(typeof body.resource === "string" ? { resource: body.resource } : {}),
        });
      } else if (grantType === "refresh_token") {
        tokens = oauth.exchangeRefreshToken({
          refreshToken: formString(body, "refresh_token", 500),
          clientId,
          ...(typeof body.resource === "string" ? { resource: body.resource } : {}),
          ...(typeof body.scope === "string" ? { scope: body.scope } : {}),
        });
      } else {
        throw { code: "unsupported_grant_type", message: "Unsupported grant type" };
      }
      const response = context.json(tokens);
      securityHeaders(response.headers);
      return response;
    } catch (error) {
      const body = oauthErrorBody(error);
      oauth.logger.warn("oauth_token_rejected", { code: body.error });
      const response = context.json(body, body.error === "invalid_client" ? 401 : 400);
      securityHeaders(response.headers);
      return response;
    }
  });

  app.post("/oauth/revoke", bodyLimit({ maxSize: 8 * 1024 }), async (context) => {
    try {
      const body = await context.req.parseBody();
      const token = formString(body, "token", 1_000);
      oauth.revokeToken(token);
    } catch {
      // RFC 7009 returns 200 even when a token is already invalid.
    }
    const response = context.body(null, 200);
    securityHeaders(response.headers);
    return response;
  });

  app.get("/oauth/complete", async (context) => {
    const nonce = randomOpaqueToken(18);
    const response = context.html(renderCompletion({ nonce, agentName: "Agent Freshdesk", tenantOrigin: "Freshdesk" }));
    securityHeaders(response.headers, nonce);
    return response;
  });

  app.get("/oauth/resource-metadata-url", (context) =>
    context.json({ resource_metadata: getOAuthProtectedResourceMetadataUrl(oauth.config.resourceUrl) }),
  );
}
