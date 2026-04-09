import { describe, it, expect } from "vitest";
import {
  toBase64Url,
  fromBase64Url,
  deriveKey,
  sealToken,
  unsealToken,
  unsealTokenWithRotation,
  signSession,
  verifySession,
  verifySessionWithRotation,
} from "../../src/worker/crypto";

// Stable base64url-encoded 32-byte test keys (not real secrets)
const KEY_A = btoa("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
const KEY_B = btoa("BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

describe("toBase64Url / fromBase64Url", () => {
  it("round-trips arbitrary bytes", () => {
    const original = new Uint8Array([0, 1, 2, 127, 128, 254, 255]);
    const encoded = toBase64Url(original);
    const decoded = fromBase64Url(encoded);
    expect(decoded).toEqual(original);
  });

  it("round-trips empty bytes", () => {
    const original = new Uint8Array(0);
    expect(fromBase64Url(toBase64Url(original))).toEqual(original);
  });

  it("produces no +, /, or = characters", () => {
    // Use bytes that produce all three problematic chars in standard base64
    for (let i = 0; i < 256; i++) {
      const bytes = new Uint8Array([i, i + 1, i + 2]);
      const encoded = toBase64Url(bytes);
      expect(encoded).not.toContain("+");
      expect(encoded).not.toContain("/");
      expect(encoded).not.toContain("=");
    }
  });

  it("handles 1-byte input (needs padding)", () => {
    const bytes = new Uint8Array([0xab]);
    const encoded = toBase64Url(bytes);
    expect(fromBase64Url(encoded)).toEqual(bytes);
  });
});

describe("deriveKey", () => {
  it("returns AES-GCM key for encrypt usage", async () => {
    const key = await deriveKey(KEY_A, "salt", "info", "encrypt");
    expect(key.algorithm.name).toBe("AES-GCM");
    expect(key.usages).toContain("encrypt");
    expect(key.usages).toContain("decrypt");
    expect(key.extractable).toBe(false);
  });

  it("returns HMAC key for sign usage", async () => {
    const key = await deriveKey(KEY_A, "salt", "info", "sign");
    expect(key.algorithm.name).toBe("HMAC");
    expect(key.usages).toContain("sign");
    expect(key.usages).toContain("verify");
    expect(key.extractable).toBe(false);
  });

  it("produces consistent output from same inputs", async () => {
    // Two keys derived with same params should encrypt/decrypt interchangeably
    const key1 = await deriveKey(KEY_A, "salt", "info", "sign");
    const key2 = await deriveKey(KEY_A, "salt", "info", "sign");
    const sig1 = await signSession("payload", key1);
    const sig2 = await signSession("payload", key2);
    expect(sig1).toBe(sig2);
  });

  it("produces different keys for different salt", async () => {
    const key1 = await deriveKey(KEY_A, "salt-a", "info", "sign");
    const key2 = await deriveKey(KEY_A, "salt-b", "info", "sign");
    const sig1 = await signSession("payload", key1);
    const sig2 = await signSession("payload", key2);
    expect(sig1).not.toBe(sig2);
  });

  it("produces different keys for different info", async () => {
    const key1 = await deriveKey(KEY_A, "salt", "info-a", "sign");
    const key2 = await deriveKey(KEY_A, "salt", "info-b", "sign");
    const sig1 = await signSession("payload", key1);
    const sig2 = await signSession("payload", key2);
    expect(sig1).not.toBe(sig2);
  });
});

describe("sealToken / unsealToken", () => {
  it("round-trips a simple string", async () => {
    const key = await deriveKey(KEY_A, "sealed-token-v1", "aes-gcm-key", "encrypt");
    const sealed = await sealToken("ghp_abc123", key);
    const unsealed = await unsealToken(sealed, key);
    expect(unsealed).toBe("ghp_abc123");
  });

  it("round-trips empty string", async () => {
    const key = await deriveKey(KEY_A, "sealed-token-v1", "aes-gcm-key", "encrypt");
    const sealed = await sealToken("", key);
    expect(await unsealToken(sealed, key)).toBe("");
  });

  it("round-trips a 1KB payload", async () => {
    const key = await deriveKey(KEY_A, "sealed-token-v1", "aes-gcm-key", "encrypt");
    const large = "x".repeat(1024);
    const sealed = await sealToken(large, key);
    expect(await unsealToken(sealed, key)).toBe(large);
  });

  it("produces different ciphertext on each call (random IV)", async () => {
    const key = await deriveKey(KEY_A, "sealed-token-v1", "aes-gcm-key", "encrypt");
    const s1 = await sealToken("same-payload", key);
    const s2 = await sealToken("same-payload", key);
    expect(s1).not.toBe(s2);
  });

  it("returns null for garbage input", async () => {
    const key = await deriveKey(KEY_A, "sealed-token-v1", "aes-gcm-key", "encrypt");
    expect(await unsealToken("garbage!!!", key)).toBeNull();
  });

  it("returns null for wrong key", async () => {
    const keyA = await deriveKey(KEY_A, "sealed-token-v1", "aes-gcm-key", "encrypt");
    const keyB = await deriveKey(KEY_B, "sealed-token-v1", "aes-gcm-key", "encrypt");
    const sealed = await sealToken("secret", keyA);
    expect(await unsealToken(sealed, keyB)).toBeNull();
  });

  it("returns null for tampered ciphertext (GCM auth tag fails)", async () => {
    const key = await deriveKey(KEY_A, "sealed-token-v1", "aes-gcm-key", "encrypt");
    const sealed = await sealToken("secret", key);
    // Flip a byte in the ciphertext portion (byte 14+) to fail GCM auth tag
    const bytes = fromBase64Url(sealed);
    bytes[14] ^= 0xff; // XOR to guarantee a change
    expect(await unsealToken(toBase64Url(bytes), key)).toBeNull();
  });

  it("returns null for wrong version byte", async () => {
    const key = await deriveKey(KEY_A, "sealed-token-v1", "aes-gcm-key", "encrypt");
    const sealed = await sealToken("secret", key);
    const bytes = fromBase64Url(sealed);
    bytes[0] = 0x02; // wrong version
    expect(await unsealToken(toBase64Url(bytes), key)).toBeNull();
  });

  it("returns null for too-short input", async () => {
    const key = await deriveKey(KEY_A, "sealed-token-v1", "aes-gcm-key", "encrypt");
    // 1 + 12 + 15 = 28 bytes (one short of minimum valid ciphertext with 16-byte tag)
    const short = new Uint8Array(28);
    short[0] = 0x01;
    expect(await unsealToken(toBase64Url(short), key)).toBeNull();
  });
});

describe("unsealTokenWithRotation", () => {
  it("unseals with current key", async () => {
    const keyA = await deriveKey(KEY_A, "sealed-token-v1", "aes-gcm-key", "encrypt");
    const sealed = await sealToken("value", keyA);
    const result = await unsealTokenWithRotation(
      sealed,
      KEY_A,
      undefined,
      "sealed-token-v1",
      "aes-gcm-key"
    );
    expect(result).toBe("value");
  });

  it("falls back to prevKey when currentKey fails", async () => {
    const keyA = await deriveKey(KEY_A, "sealed-token-v1", "aes-gcm-key", "encrypt");
    const sealed = await sealToken("value", keyA);
    // Sealed with A, try currentKey=B, prevKey=A
    const result = await unsealTokenWithRotation(
      sealed,
      KEY_B,
      KEY_A,
      "sealed-token-v1",
      "aes-gcm-key"
    );
    expect(result).toBe("value");
  });

  it("returns null when prevKey is undefined and currentKey fails", async () => {
    const keyA = await deriveKey(KEY_A, "sealed-token-v1", "aes-gcm-key", "encrypt");
    const sealed = await sealToken("value", keyA);
    const result = await unsealTokenWithRotation(
      sealed,
      KEY_B,
      undefined,
      "sealed-token-v1",
      "aes-gcm-key"
    );
    expect(result).toBeNull();
  });

  it("returns null when both keys fail", async () => {
    const keyA = await deriveKey(KEY_A, "sealed-token-v1", "aes-gcm-key", "encrypt");
    const sealed = await sealToken("value", keyA);
    const KEY_C = btoa("CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
    const result = await unsealTokenWithRotation(
      sealed,
      KEY_B,
      KEY_C,
      "sealed-token-v1",
      "aes-gcm-key"
    );
    expect(result).toBeNull();
  });
});

describe("signSession / verifySession", () => {
  it("round-trip: sign then verify returns true", async () => {
    const key = await deriveKey(KEY_A, "github-tracker-session-v1", "session-hmac", "sign");
    const sig = await signSession("payload-data", key);
    expect(await verifySession("payload-data", sig, key)).toBe(true);
  });

  it("returns false for wrong signature", async () => {
    const key = await deriveKey(KEY_A, "github-tracker-session-v1", "session-hmac", "sign");
    expect(await verifySession("payload-data", "wrong-sig", key)).toBe(false);
  });

  it("returns false for tampered payload", async () => {
    const key = await deriveKey(KEY_A, "github-tracker-session-v1", "session-hmac", "sign");
    const sig = await signSession("original-payload", key);
    expect(await verifySession("tampered-payload", sig, key)).toBe(false);
  });

  it("returns false for wrong key", async () => {
    const keyA = await deriveKey(KEY_A, "github-tracker-session-v1", "session-hmac", "sign");
    const keyB = await deriveKey(KEY_B, "github-tracker-session-v1", "session-hmac", "sign");
    const sig = await signSession("payload", keyA);
    expect(await verifySession("payload", sig, keyB)).toBe(false);
  });

  it("returns false for invalid base64 signature", async () => {
    const key = await deriveKey(KEY_A, "github-tracker-session-v1", "session-hmac", "sign");
    expect(await verifySession("payload", "!!!invalid!!!", key)).toBe(false);
  });
});

describe("verifySessionWithRotation", () => {
  it("verifies with current key", async () => {
    const keyA = await deriveKey(KEY_A, "github-tracker-session-v1", "session-hmac", "sign");
    const sig = await signSession("data", keyA);
    const result = await verifySessionWithRotation(
      "data",
      sig,
      KEY_A,
      undefined,
      "github-tracker-session-v1",
      "session-hmac"
    );
    expect(result).toBe(true);
  });

  it("falls back to prevKey when current key fails", async () => {
    const keyA = await deriveKey(KEY_A, "github-tracker-session-v1", "session-hmac", "sign");
    const sig = await signSession("data", keyA);
    // Signed with A, try currentKey=B, prevKey=A
    const result = await verifySessionWithRotation(
      "data",
      sig,
      KEY_B,
      KEY_A,
      "github-tracker-session-v1",
      "session-hmac"
    );
    expect(result).toBe(true);
  });

  it("returns false when both keys fail", async () => {
    const keyA = await deriveKey(KEY_A, "github-tracker-session-v1", "session-hmac", "sign");
    const sig = await signSession("data", keyA);
    const KEY_C = btoa("CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
    const result = await verifySessionWithRotation(
      "data",
      sig,
      KEY_B,
      KEY_C,
      "github-tracker-session-v1",
      "session-hmac"
    );
    expect(result).toBe(false);
  });
});
