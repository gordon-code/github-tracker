import { describe, it, expect } from "vitest";
import { test, fc } from "@fast-check/vitest";
import {
  toBase64Url,
  fromBase64Url,
  deriveKey,
  sealToken,
  unsealToken,
  unsealTokenWithRotation,
  signSession,
  verifySession,
} from "../../src/worker/crypto";

// 32-byte test keys as base64url (not real secrets)
// 0x41 × 32 = "AAAA..." and 0x42 × 32 = "BBBB..."
const KEY_A = "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE";
const KEY_B = "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI";

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

describe("sealToken cross-purpose isolation", () => {
  it("cannot unseal a token sealed with a different purpose (F-003)", async () => {
    const sealKey = await deriveKey(KEY_A, "sealed-token-v1", "aes-gcm-key:jira-api-token", "encrypt");
    const unsealKey = await deriveKey(KEY_A, "sealed-token-v1", "aes-gcm-key:gitlab-pat", "encrypt");
    const sealed = await sealToken("secret-token", sealKey);
    expect(await unsealToken(sealed, unsealKey)).toBeNull();
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

  it("returns false for valid base64url signature of wrong byte length", async () => {
    const key = await deriveKey(KEY_A, "github-tracker-session-v1", "session-hmac", "sign");
    // 31 bytes — valid base64url, but shorter than 32-byte HMAC-SHA256 output
    const shortSig = toBase64Url(new Uint8Array(31));
    expect(await verifySession("payload-data", shortSig, key)).toBe(false);
    // 33 bytes — valid base64url, longer than expected
    const longSig = toBase64Url(new Uint8Array(33));
    expect(await verifySession("payload-data", longSig, key)).toBe(false);
  });
});

// ── Known-Answer Tests (KAT) ─────────────────────────────────────────────
// These validate the underlying Web Crypto runtime against published
// reference outputs, catching implementation bugs that round-trip tests miss.

/** Convert a hex string to Uint8Array. Throws on odd-length or invalid hex. */
function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error(`fromHex: odd-length string (${hex.length})`);
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.slice(i, i + 2), 16);
    if (Number.isNaN(byte)) throw new Error(`fromHex: invalid hex at position ${i}: "${hex.slice(i, i + 2)}"`);
    bytes[i / 2] = byte;
  }
  return bytes;
}

/** Convert Uint8Array to lowercase hex string. */
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("HKDF-SHA256 known-answer test (RFC 5869 Appendix A.1)", () => {
  it("deriveBits matches published OKM", async () => {
    // RFC 5869 Appendix A, Test Case 1
    const ikm = fromHex("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b"); // 22 octets
    const salt = fromHex("000102030405060708090a0b0c"); // 13 octets
    const info = fromHex("f0f1f2f3f4f5f6f7f8f9"); // 10 octets
    const expectedOkm =
      "3cb25f25faacd57a90434f64d0362f2a" +
      "2d2d0a90cf1a5a4c5db02d56ecc4c5bf" +
      "34007208d5b887185865"; // 42 octets

    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      ikm.buffer as ArrayBuffer,
      { name: "HKDF" },
      false,
      ["deriveBits"]
    );
    const okm = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt: salt.buffer as ArrayBuffer, info: info.buffer as ArrayBuffer },
        keyMaterial,
        42 * 8 // length in bits
      )
    );

    expect(toHex(okm)).toBe(expectedOkm);
  });
});

describe("AES-256-GCM known-answer test (McGrew-Viega Test Case 14)", () => {
  it("encrypt with zero key/IV/empty plaintext produces published tag", async () => {
    // GCM spec Test Case 14: 256-bit zero key, 96-bit zero IV, empty plaintext, no AAD
    const key = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(32).buffer as ArrayBuffer, // 32 zero bytes
      { name: "AES-GCM" },
      false,
      ["encrypt"]
    );
    const iv = new Uint8Array(12); // 12 zero bytes
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new Uint8Array(0))
    );

    // Empty plaintext → output is just the 128-bit authentication tag
    expect(ciphertext.length).toBe(16);
    expect(toHex(ciphertext)).toBe("530f8afbc74536b9a963b4f1c4cb738b");
  });
});

// ── Property-based tests (fast-check) ─────────────────────────────────────
// These fuzz the base64url codec and seal/unseal paths with hundreds of
// random inputs per run, catching edge cases that specific test cases miss.

describe("property-based tests", () => {
  test.prop([fc.uint8Array({ minLength: 0, maxLength: 4096 })])(
    "base64url round-trips arbitrary byte arrays",
    (data) => {
      const encoded = toBase64Url(data);
      const decoded = fromBase64Url(encoded);
      expect(decoded).toEqual(data);
    }
  );

  test.prop([fc.uint8Array({ minLength: 1, maxLength: 1024 })])(
    "base64url output contains only URL-safe characters",
    (data) => {
      const encoded = toBase64Url(data);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]*$/);
    }
  );

  test.prop([fc.string({ minLength: 0, maxLength: 256 })])(
    "fromBase64Url either throws or returns bytes that re-encode to the same canonical form",
    (input) => {
      let decoded: Uint8Array;
      try {
        decoded = fromBase64Url(input);
      } catch {
        return; // throws on invalid base64 — acceptable
      }
      // If decode succeeded, re-encoding must produce valid base64url
      const reencoded = toBase64Url(decoded);
      expect(reencoded).toMatch(/^[A-Za-z0-9_-]*$/);
      // And decoding that must give the same bytes
      expect(fromBase64Url(reencoded)).toEqual(decoded);
    }
  );

  test.prop([fc.string({ minLength: 0, maxLength: 2048 })])(
    "sealToken/unsealToken round-trips arbitrary strings",
    async (plaintext) => {
      const key = await deriveKey(KEY_A, "sealed-token-v1", "aes-gcm-key", "encrypt");
      const sealed = await sealToken(plaintext, key);
      const unsealed = await unsealToken(sealed, key);
      expect(unsealed).toBe(plaintext);
    }
  );

  test.prop([fc.string({ minLength: 1, maxLength: 512 })])(
    "unsealToken returns null for arbitrary garbage without crashing",
    async (garbage) => {
      const key = await deriveKey(KEY_A, "sealed-token-v1", "aes-gcm-key", "encrypt");
      const result = await unsealToken(garbage, key);
      expect(result).toBeNull();
    }
  );
});
