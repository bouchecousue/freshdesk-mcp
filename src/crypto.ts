import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

// Public HKDF domain separator, shared by every key derivation in this format.
const KEY_DERIVATION_SALT = Buffer.from("freshdesk-mcp-v1", "utf8");

function base64UrlEncode(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function base64UrlDecode(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

function equalBuffers(left: Uint8Array, right: Uint8Array): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function parseMasterKey(encoded: string): Uint8Array {
  let decoded: Buffer;
  try {
    decoded = Buffer.from(encoded.trim(), encoded.includes("-") || encoded.includes("_") ? "base64url" : "base64");
  } catch {
    throw new Error("FRESHDESK_MCP_MASTER_KEY must be valid base64 or base64url");
  }
  if (decoded.length !== 32) {
    throw new Error("FRESHDESK_MCP_MASTER_KEY must decode to exactly 32 bytes");
  }
  return decoded;
}

export function generateMasterKey(): string {
  return randomBytes(32).toString("base64url");
}

export function randomOpaqueToken(bytes = 32): string {
  return base64UrlEncode(randomBytes(bytes));
}

export function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

export function deriveKey(masterKey: Uint8Array, purpose: string): Uint8Array {
  if (masterKey.length !== 32) throw new Error("Master key must be 32 bytes");
  return Buffer.from(hkdfSync("sha256", masterKey, KEY_DERIVATION_SALT, purpose, 32));
}

export function verifyPkceS256(verifier: string, expectedChallenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  return equalBuffers(Buffer.from(sha256Base64Url(verifier)), Buffer.from(expectedChallenge));
}

export class SecretManager {
  readonly #encryptionKey: Buffer;
  readonly #hashKey: Buffer;

  constructor(masterKey: Uint8Array) {
    if (masterKey.length !== 32) throw new Error("Master key must be 32 bytes");
    this.#encryptionKey = Buffer.from(hkdfSync("sha256", masterKey, KEY_DERIVATION_SALT, "data-encryption", 32));
    this.#hashKey = Buffer.from(hkdfSync("sha256", masterKey, KEY_DERIVATION_SALT, "opaque-token-hash", 32));
  }

  hashOpaque(value: string): string {
    return createHmac("sha256", this.#hashKey).update(value, "utf8").digest("base64url");
  }

  encrypt(plaintext: string, aad: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#encryptionKey, nonce);
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ["v1", base64UrlEncode(nonce), base64UrlEncode(tag), base64UrlEncode(ciphertext)].join(".");
  }

  decrypt(envelope: string, aad: string): string {
    const [version, nonceValue, tagValue, ciphertextValue, extra] = envelope.split(".");
    if (version !== "v1" || !nonceValue || !tagValue || ciphertextValue === undefined || extra !== undefined) {
      throw new Error("Invalid encrypted secret envelope");
    }
    const nonce = base64UrlDecode(nonceValue);
    const tag = base64UrlDecode(tagValue);
    const ciphertext = base64UrlDecode(ciphertextValue);
    if (nonce.length !== 12 || tag.length !== 16) throw new Error("Invalid encrypted secret envelope");
    const decipher = createDecipheriv("aes-256-gcm", this.#encryptionKey, nonce);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  }
}
