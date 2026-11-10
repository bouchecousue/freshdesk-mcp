import { resolve } from "node:path";
import { z } from "zod";

import { parseMasterKey } from "./crypto.js";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1024).max(65535).default(8788),
  PUBLIC_URL: z.string().url().optional(),
  DATABASE_PATH: z.string().min(1).optional(),
  FRESHDESK_MCP_MASTER_KEY: z.string().min(1),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(300).max(3600).default(900),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().min(3600).max(31_536_000).default(2_592_000),
  AUTH_CODE_TTL_SECONDS: z.coerce.number().int().min(60).max(600).default(300),
  AUTH_REQUEST_TTL_SECONDS: z.coerce.number().int().min(60).max(1800).default(600),
  WRITE_INTENT_TTL_SECONDS: z.coerce.number().int().min(60).max(1800).default(600),
  CIMD_ALLOWED_HOST_SUFFIXES: z.string().default("chatgpt.com,openai.com"),
});

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  publicUrl: URL;
  resourceUrl: URL;
  databasePath: string;
  masterKey: Uint8Array;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  authCodeTtlSeconds: number;
  authRequestTtlSeconds: number;
  writeIntentTtlSeconds: number;
  cimdAllowedHostSuffixes: string[];
}

function normalizePublicUrl(value: string, nodeEnv: AppConfig["nodeEnv"]): URL {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("PUBLIC_URL must not contain credentials, query parameters, or a fragment");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error("PUBLIC_URL must be an origin without a path");
  }
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(nodeEnv !== "production" && local && url.protocol === "http:")) {
    throw new Error("PUBLIC_URL must use HTTPS outside local development");
  }
  url.pathname = "/";
  return url;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  const defaultPublicUrl = `http://${parsed.HOST}:${parsed.PORT}`;
  if (parsed.NODE_ENV === "production" && !parsed.PUBLIC_URL) {
    throw new Error("PUBLIC_URL is required in production");
  }
  const publicUrl = normalizePublicUrl(parsed.PUBLIC_URL ?? defaultPublicUrl, parsed.NODE_ENV);
  const resourceUrl = new URL("/mcp", publicUrl);
  const databasePath =
    parsed.DATABASE_PATH ??
    resolve("var", "freshdesk-mcp.sqlite3");

  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    publicUrl,
    resourceUrl,
    databasePath,
    masterKey: parseMasterKey(parsed.FRESHDESK_MCP_MASTER_KEY),
    accessTokenTtlSeconds: parsed.ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTtlSeconds: parsed.REFRESH_TOKEN_TTL_SECONDS,
    authCodeTtlSeconds: parsed.AUTH_CODE_TTL_SECONDS,
    authRequestTtlSeconds: parsed.AUTH_REQUEST_TTL_SECONDS,
    writeIntentTtlSeconds: parsed.WRITE_INTENT_TTL_SECONDS,
    cimdAllowedHostSuffixes: parsed.CIMD_ALLOWED_HOST_SUFFIXES.split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  };
}
