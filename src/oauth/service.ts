import { OAuthError, OAuthErrorCode, type AuthInfo, type OAuthMetadata } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { AppConfig } from "../config.js";
import { randomOpaqueToken, SecretManager, verifyPkceS256 } from "../crypto.js";
import {
  AppDatabase,
  type PendingAuthorization,
  type StoredOAuthClient,
  type StoredUser,
} from "../database.js";
import { FreshdeskClient, normalizeFreshdeskOrigin } from "../freshdesk/client.js";
import type { FreshdeskAccount, FreshdeskAgent } from "../freshdesk/types.js";
import type { Logger } from "../logger.js";
import { readBoundedBody } from "../http-body.js";

const allowedScopes = new Set(["freshdesk:read", "freshdesk:write", "offline_access"]);

const registrationSchema = z.object({
  client_name: z.string().min(1).max(200).default("MCP client"),
  redirect_uris: z.array(z.string().url()).min(1).max(10),
  token_endpoint_auth_method: z.enum(["none"]).default("none"),
  grant_types: z.array(z.enum(["authorization_code", "refresh_token"])).default(["authorization_code", "refresh_token"]),
  response_types: z.array(z.literal("code")).default(["code"]),
  scope: z.string().max(500).default("freshdesk:read freshdesk:write offline_access"),
  application_type: z.enum(["web", "native"]).default("web"),
});

const clientMetadataSchema = registrationSchema.omit({ token_endpoint_auth_method: true }).extend({
  client_id: z.string().url(),
  token_endpoint_auth_method: z.string().min(1).max(100).optional(),
  token_endpoint_auth_methods_supported: z.array(z.string().min(1).max(100)).min(1).max(10).optional(),
});

export type OAuthRegistrationInput = z.input<typeof registrationSchema>;

export interface OAuthTokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
  refresh_token?: string;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function scopesFromString(value: string): string[] {
  const scopes = [...new Set(value.split(/\s+/).map((scope) => scope.trim()).filter(Boolean))];
  if (scopes.length === 0 || !scopes.includes("freshdesk:read") || scopes.some((scope) => !allowedScopes.has(scope))) {
    throw new OAuthError(OAuthErrorCode.InvalidScope, "The requested scope is invalid");
  }
  return scopes.sort();
}

function validateRedirectUri(value: string, applicationType: "web" | "native"): string {
  const url = new URL(value);
  if (url.username || url.password || url.hash) throw new Error("Redirect URIs must not contain credentials or fragments");
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(applicationType === "native" && loopback && url.protocol === "http:")) {
    throw new Error("Redirect URIs must use HTTPS, except native loopback clients");
  }
  return url.href;
}

function stringIdentity(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

export class OAuthService {
  readonly metadata: OAuthMetadata;

  constructor(
    readonly config: AppConfig,
    readonly database: AppDatabase,
    readonly secrets: SecretManager,
    readonly logger: Logger,
    readonly freshdeskClientFactory: (origin: string, apiKey: string) => FreshdeskClient = (origin, apiKey) =>
      new FreshdeskClient({ origin, apiKey }),
    readonly fetchFn: typeof fetch = fetch,
  ) {
    const issuer = config.publicUrl.origin;
    this.metadata = {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["freshdesk:read", "freshdesk:write", "offline_access"],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
    };
  }

  registerClient(input: OAuthRegistrationInput): StoredOAuthClient {
    const parsed = registrationSchema.parse(input);
    const scopes = scopesFromString(parsed.scope);
    const redirectUris = parsed.redirect_uris.map((uri) => validateRedirectUri(uri, parsed.application_type));
    const client: StoredOAuthClient = {
      clientId: `client_${randomOpaqueToken(24)}`,
      clientName: parsed.client_name,
      redirectUris,
      scope: scopes.join(" "),
      tokenEndpointAuthMethod: "none",
      clientSecretHash: null,
      createdAt: nowSeconds(),
    };
    this.database.insertClient(client);
    this.logger.info("oauth_client_registered", { clientId: client.clientId, redirectUriCount: redirectUris.length });
    return client;
  }

  async resolveClient(clientId: string): Promise<StoredOAuthClient | undefined> {
    const stored = this.database.getClient(clientId);
    if (stored) return stored;
    let url: URL;
    try {
      url = new URL(clientId);
    } catch {
      return undefined;
    }
    if (url.protocol !== "https:" || url.port || url.pathname === "/" || url.username || url.password || url.hash) return undefined;
    const hostname = url.hostname.toLowerCase();
    const allowed = this.config.cimdAllowedHostSuffixes.some(
      (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
    );
    if (!allowed) return undefined;
    const response = await this.fetchFn(url, { redirect: "error", signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return undefined;
    const text = (await readBoundedBody(response, 65_536)).toString("utf8");
    const metadata = clientMetadataSchema.parse(JSON.parse(text) as unknown);
    if (metadata.client_id !== clientId) return undefined;
    const supportedAuthMethods = metadata.token_endpoint_auth_methods_supported ??
      (metadata.token_endpoint_auth_method ? [metadata.token_endpoint_auth_method] : []);
    if (!supportedAuthMethods.includes("none")) return undefined;
    const client: StoredOAuthClient = {
      clientId,
      clientName: metadata.client_name,
      redirectUris: metadata.redirect_uris.map((uri) => validateRedirectUri(uri, metadata.application_type)),
      scope: scopesFromString(metadata.scope).join(" "),
      tokenEndpointAuthMethod: "none",
      clientSecretHash: null,
      createdAt: nowSeconds(),
    };
    this.database.insertClient(client);
    return client;
  }

  async beginAuthorization(input: URLSearchParams): Promise<{ pending: PendingAuthorization; requestId: string; client: StoredOAuthClient }> {
    if (input.get("response_type") !== "code") {
      throw new OAuthError(OAuthErrorCode.UnsupportedResponseType, "Only response_type=code is supported");
    }
    const clientId = input.get("client_id") ?? "";
    const client = await this.resolveClient(clientId);
    if (!client) throw new OAuthError(OAuthErrorCode.InvalidClient, "Unknown OAuth client");
    const redirectUri = input.get("redirect_uri") ?? "";
    if (!client.redirectUris.includes(redirectUri)) {
      throw new OAuthError(OAuthErrorCode.InvalidRequest, "redirect_uri does not match the registered client");
    }
    const state = input.get("state") ?? "";
    if (state.length < 8 || state.length > 2_000) throw new OAuthError(OAuthErrorCode.InvalidRequest, "state is required");
    const challenge = input.get("code_challenge") ?? "";
    if (input.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
      throw new OAuthError(OAuthErrorCode.InvalidRequest, "PKCE S256 is required");
    }
    const resource = input.get("resource") ?? "";
    if (resource !== this.config.resourceUrl.href) {
      throw new OAuthError(OAuthErrorCode.InvalidTarget, "The resource parameter must identify this MCP endpoint");
    }
    const requestedScopes = scopesFromString(input.get("scope") ?? "freshdesk:read");
    const clientScopes = new Set(scopesFromString(client.scope));
    if (requestedScopes.some((scope) => !clientScopes.has(scope))) {
      throw new OAuthError(OAuthErrorCode.InvalidScope, "The requested scope exceeds the registered client scope");
    }
    const requestId = randomOpaqueToken();
    const pending: PendingAuthorization = {
      requestHash: this.secrets.hashOpaque(requestId),
      clientId,
      redirectUri,
      state,
      scope: requestedScopes.join(" "),
      resource,
      codeChallenge: challenge,
      expiresAt: nowSeconds() + this.config.authRequestTtlSeconds,
    };
    this.database.insertPendingAuthorization(pending);
    return { pending, requestId, client };
  }

  getPendingAuthorization(requestId: string): PendingAuthorization | undefined {
    return this.database.getPendingAuthorization(this.secrets.hashOpaque(requestId), nowSeconds());
  }

  cancelAuthorization(requestId: string): PendingAuthorization | undefined {
    const pending = this.getPendingAuthorization(requestId);
    if (pending) this.database.deletePendingAuthorization(pending.requestHash);
    return pending;
  }

  async approveAuthorization(input: { requestId: string; tenant: string; apiKey: string }): Promise<{
    pending: PendingAuthorization;
    user: StoredUser;
    code: string;
  }> {
    const startedAtMs = Date.now();
    const pending = this.getPendingAuthorization(input.requestId);
    if (!pending) throw new OAuthError(OAuthErrorCode.InvalidRequest, "Authorization request expired");
    const tenantOrigin = normalizeFreshdeskOrigin(input.tenant);
    const freshdesk = this.freshdeskClientFactory(tenantOrigin, input.apiKey);
    const agent = await freshdesk.getMe();
    // Another submission may have completed or cancelled while Freshdesk was responding.
    if (!this.getPendingAuthorization(input.requestId)) {
      throw new OAuthError(OAuthErrorCode.InvalidRequest, "Authorization request expired or already completed");
    }
    const agentId = stringIdentity(agent.id);
    if (!agentId) throw new Error("Freshdesk did not return an agent identity");
    const existing = this.database.getUserByTenantAgent(tenantOrigin, agentId);
    const userId = existing?.id ?? `user_${randomOpaqueToken(24)}`;
    const encryptedApiKey = this.secrets.encrypt(input.apiKey, `user:${userId}:api-key`);
    const user = this.database.upsertUser(
      {
        id: userId,
        tenantOrigin,
        agentId,
        agentEmail: agent.contact?.email ?? null,
        agentName: agent.contact?.name ?? null,
        // Account metadata is optional and may require Account Administrator access.
        // Preserve previously known values without making /account an OAuth prerequisite.
        accountId: existing?.accountId ?? null,
        accountName: existing?.accountName ?? null,
        encryptedApiKey,
      },
      nowSeconds(),
    );
    const code = randomOpaqueToken();
    const now = nowSeconds();
    this.database.insertAuthorizationCode({
      codeHash: this.secrets.hashOpaque(code),
      clientId: pending.clientId,
      userId: user.id,
      redirectUri: pending.redirectUri,
      scope: pending.scope,
      resource: pending.resource,
      codeChallenge: pending.codeChallenge,
      issuer: this.config.publicUrl.origin,
      expiresAt: now + this.config.authCodeTtlSeconds,
      usedAt: null,
    });
    this.database.deletePendingAuthorization(pending.requestHash);
    this.database.recordAudit({
      occurredAt: now,
      userId: user.id,
      agentId: user.agentId,
      tenantOrigin: user.tenantOrigin,
      tool: "oauth_connect",
      targetId: null,
      outcome: "success",
      correlationId: `oauth_${randomOpaqueToken(12)}`,
      actionKind: "oauth",
      actionName: "connect",
      durationMs: Math.max(0, Date.now() - startedAtMs),
      resultCount: 1,
    });
    return { pending, user, code };
  }

  exchangeAuthorizationCode(input: {
    code: string;
    clientId: string;
    redirectUri: string;
    codeVerifier: string;
    resource?: string;
  }): OAuthTokenResponse {
    const now = nowSeconds();
    const grant = this.database.consumeAuthorizationCode(this.secrets.hashOpaque(input.code), now, (code) => {
      if (code.clientId !== input.clientId || code.redirectUri !== input.redirectUri ||
          code.issuer !== this.config.publicUrl.origin ||
          (input.resource !== undefined && input.resource !== code.resource) ||
          !verifyPkceS256(input.codeVerifier, code.codeChallenge)) {
        throw new OAuthError(OAuthErrorCode.InvalidGrant, "Authorization code is invalid or expired");
      }
    });
    if (!grant) {
      throw new OAuthError(OAuthErrorCode.InvalidGrant, "Authorization code is invalid or expired");
    }
    return this.issueTokens({
      clientId: grant.clientId,
      userId: grant.userId,
      scope: grant.scope,
      resource: grant.resource,
      now,
    });
  }

  exchangeRefreshToken(input: { refreshToken: string; clientId: string; resource?: string; scope?: string }): OAuthTokenResponse {
    const now = nowSeconds();
    const replacement = randomOpaqueToken();
    const replacementHash = this.secrets.hashOpaque(replacement);
    let scope = "";
    const grant = this.database.consumeRefreshToken(this.secrets.hashOpaque(input.refreshToken), replacementHash, now, (token) => {
      if (token.clientId !== input.clientId) {
        throw new OAuthError(OAuthErrorCode.InvalidGrant, "Refresh token is invalid");
      }
      if (input.resource !== undefined && input.resource !== token.resource) {
        throw new OAuthError(OAuthErrorCode.InvalidTarget, "Refresh token resource does not match");
      }
      scope = token.scope;
      if (input.scope !== undefined) {
        const requested = scopesFromString(input.scope);
        const granted = new Set(scopesFromString(token.scope));
        if (requested.some((item) => !granted.has(item))) {
          throw new OAuthError(OAuthErrorCode.InvalidScope, "Refresh scope exceeds the original grant");
        }
        scope = requested.join(" ");
      }
    });
    if (!grant || grant === "reuse") {
      throw new OAuthError(OAuthErrorCode.InvalidGrant, "Refresh token is invalid or has been reused");
    }
    const tokens = this.issueTokens({
      clientId: grant.clientId,
      userId: grant.userId,
      scope,
      resource: grant.resource,
      now,
      refresh: { raw: replacement, hash: replacementHash, familyId: grant.familyId },
    });
    return tokens;
  }

  revokeToken(rawToken: string): void {
    if (!rawToken) return;
    const now = nowSeconds();
    const revoked = this.database.revokeToken(this.secrets.hashOpaque(rawToken), now);
    if (revoked) {
      const credentialDeleted = !this.database.hasActiveGrant(revoked.userId, now);
      if (credentialDeleted) this.database.deleteUser(revoked.userId);
      this.logger.info("oauth_token_revoked", {
        userId: revoked.userId,
        clientId: revoked.clientId,
        credentialDeleted,
      });
    }
  }

  async verifyAccessToken(rawToken: string): Promise<AuthInfo> {
    const token = this.database.getAccessToken(this.secrets.hashOpaque(rawToken));
    const now = nowSeconds();
    if (!token || token.revokedAt !== null || token.expiresAt <= now || token.resource !== this.config.resourceUrl.href) {
      throw new OAuthError(OAuthErrorCode.InvalidToken, "Access token is invalid or expired");
    }
    const user = this.database.getUser(token.userId);
    if (!user) throw new OAuthError(OAuthErrorCode.InvalidToken, "Connected Freshdesk identity no longer exists");
    return {
      token: rawToken,
      clientId: token.clientId,
      scopes: scopesFromString(token.scope),
      expiresAt: token.expiresAt,
      resource: new URL(token.resource),
      extra: {
        userId: user.id,
        tenantOrigin: user.tenantOrigin,
        agentId: user.agentId,
      },
    };
  }

  private issueTokens(input: {
    clientId: string;
    userId: string;
    scope: string;
    resource: string;
    now: number;
    refresh?: { raw: string; hash: string; familyId: string };
  }): OAuthTokenResponse {
    const accessToken = randomOpaqueToken();
    this.database.insertAccessToken(
      {
        tokenHash: this.secrets.hashOpaque(accessToken),
        clientId: input.clientId,
        userId: input.userId,
        scope: input.scope,
        resource: input.resource,
        expiresAt: input.now + this.config.accessTokenTtlSeconds,
        revokedAt: null,
      },
      input.now,
    );
    const response: OAuthTokenResponse = {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: this.config.accessTokenTtlSeconds,
      scope: input.scope,
    };
    if (scopesFromString(input.scope).includes("offline_access")) {
      const refreshToken = input.refresh?.raw ?? randomOpaqueToken();
      const refreshHash = input.refresh?.hash ?? this.secrets.hashOpaque(refreshToken);
      const familyId = input.refresh?.familyId ?? `family_${randomOpaqueToken(18)}`;
      this.database.insertRefreshToken(
        {
          tokenHash: refreshHash,
          familyId,
          clientId: input.clientId,
          userId: input.userId,
          scope: input.scope,
          resource: input.resource,
          expiresAt: input.now + this.config.refreshTokenTtlSeconds,
          revokedAt: null,
          replacedByHash: null,
        },
        input.now,
      );
      response.refresh_token = refreshToken;
    }
    return response;
  }
}

export function agentDisplayName(agent: FreshdeskAgent, account: FreshdeskAccount | undefined = undefined): string {
  return agent.contact?.name ?? agent.contact?.email ?? account?.account_name ?? String(agent.id);
}
