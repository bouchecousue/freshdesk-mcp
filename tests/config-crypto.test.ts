import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { generateMasterKey, parseMasterKey, SecretManager, verifyPkceS256, sha256Base64Url } from "../src/crypto.js";

describe("configuration and secret handling", () => {
  it("encrypts secrets with authenticated context binding", () => {
    const manager = new SecretManager(parseMasterKey(generateMasterKey()));
    const encrypted = manager.encrypt("freshdesk-api-key", "user:1:api-key");

    expect(encrypted).not.toContain("freshdesk-api-key");
    expect(manager.decrypt(encrypted, "user:1:api-key")).toBe("freshdesk-api-key");
    expect(() => manager.decrypt(encrypted, "user:2:api-key")).toThrow();
  });

  it("validates PKCE S256", () => {
    const verifier = "v".repeat(43);
    expect(verifyPkceS256(verifier, sha256Base64Url(verifier))).toBe(true);
    expect(verifyPkceS256(verifier, sha256Base64Url("different"))).toBe(false);
  });

  it("rejects an insecure production issuer", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        PUBLIC_URL: "http://mcp.example.com",
        FRESHDESK_MCP_MASTER_KEY: generateMasterKey(),
      }),
    ).toThrow(/HTTPS/);
  });
});
