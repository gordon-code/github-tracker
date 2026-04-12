export interface CryptoEnv {
  SEAL_KEY: string; // base64-encoded HKDF input key material (32 bytes recommended)
  SEAL_KEY_PREV?: string; // previous HKDF key material for rotation
}

// ── Base64url utilities ────────────────────────────────────────────────────

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

export function fromBase64Url(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const padding = (4 - (padded.length % 4)) % 4;
  const base64 = padded + "=".repeat(padding);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ── HKDF key derivation ────────────────────────────────────────────────────

/**
 * Derives a CryptoKey from a base64-encoded secret using HKDF.
 * - usage "encrypt" → AES-256-GCM key
 * - usage "sign" → HMAC-SHA256 key
 *
 * The info parameter MUST include a purpose string for token audience binding
 * (SC-8). Pass e.g. "aes-gcm-key:<purpose>" or "session-hmac" so keys derived
 * for different purposes are cryptographically isolated.
 */
export async function deriveKey(
  secret: string,
  salt: string,
  info: string,
  usage: "encrypt" | "sign"
): Promise<CryptoKey> {
  const secretBytes = fromBase64Url(secret);
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    secretBytes.buffer as ArrayBuffer,
    { name: "HKDF" },
    false,
    ["deriveKey"]
  );

  const saltBytes = new TextEncoder().encode(salt);
  const infoBytes = new TextEncoder().encode(info);

  if (usage === "encrypt") {
    return crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: saltBytes, info: infoBytes },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  } else {
    return crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: saltBytes, info: infoBytes },
      keyMaterial,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"]
    );
  }
}

// ── Sealed-token encryption ────────────────────────────────────────────────
// Byte layout: [version:1][iv:12][ciphertext+tag:N]
// version = 0x01 (reserved for future format changes)

const SEAL_VERSION = 0x01;
const SEAL_SALT = "sealed-token-v1";

/**
 * Encrypts a plaintext string with AES-256-GCM.
 * Returns a base64url-encoded sealed token.
 */
export async function sealToken(
  plaintext: string,
  key: CryptoKey
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintextBytes = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintextBytes
  );

  const ciphertextBytes = new Uint8Array(ciphertext);
  const result = new Uint8Array(1 + 12 + ciphertextBytes.length);
  result[0] = SEAL_VERSION;
  result.set(iv, 1);
  result.set(ciphertextBytes, 13);

  return toBase64Url(result);
}

/**
 * Decrypts a sealed token produced by sealToken.
 * Returns null on any failure (wrong key, tampered ciphertext, bad version).
 */
export async function unsealToken(
  sealed: string,
  key: CryptoKey
): Promise<string | null> {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(sealed);
  } catch {
    return null;
  }

  if (bytes.length < 1 + 12 + 16) return null; // too short to be valid
  if (bytes[0] !== SEAL_VERSION) return null;

  const iv = bytes.slice(1, 13);
  const ciphertext = bytes.slice(13);

  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}

/**
 * Unseals a token, falling back to prevKey if currentKey fails.
 * Both salt and info must match the values used during sealing.
 * SC-8: info MUST include a purpose string for token audience binding.
 */
export async function unsealTokenWithRotation(
  sealed: string,
  currentKey: string,
  prevKey: string | undefined,
  salt: string,
  info: string
): Promise<string | null> {
  const current = await deriveKey(currentKey, salt, info, "encrypt");
  const result = await unsealToken(sealed, current);
  if (result !== null) return result;

  if (prevKey !== undefined) {
    const prev = await deriveKey(prevKey, salt, info, "encrypt");
    return unsealToken(sealed, prev);
  }

  return null;
}

// ── HMAC session signing ───────────────────────────────────────────────────

/**
 * Signs a payload string with HMAC-SHA256.
 * Returns a base64url-encoded signature.
 */
export async function signSession(
  payload: string,
  key: CryptoKey
): Promise<string> {
  const payloadBytes = new TextEncoder().encode(payload);
  const signature = await crypto.subtle.sign("HMAC", key, payloadBytes);
  return toBase64Url(new Uint8Array(signature));
}

/**
 * Verifies an HMAC-SHA256 signature using crypto.subtle.timingSafeEqual
 * (Cloudflare Workers extension) for an explicit constant-time guarantee.
 *
 * Both inputs are hashed to SHA-256 before comparison so timingSafeEqual
 * always receives equal-length buffers — no early-return length guard needed.
 * This follows Cloudflare's recommended pattern for timing-attack protection.
 */
export async function verifySession(
  payload: string,
  signature: string,
  key: CryptoKey
): Promise<boolean> {
  let sigBytes: Uint8Array;
  try {
    sigBytes = fromBase64Url(signature);
  } catch {
    return false;
  }

  const payloadBytes = new TextEncoder().encode(payload);
  try {
    const expected = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, payloadBytes)
    );
    // Hash both to fixed 32 bytes so timingSafeEqual never sees mismatched
    // lengths and the comparison is unconditionally constant-time.
    const [hashA, hashB] = await Promise.all([
      crypto.subtle.digest("SHA-256", sigBytes.buffer as ArrayBuffer),
      crypto.subtle.digest("SHA-256", expected.buffer as ArrayBuffer),
    ]);
    return crypto.subtle.timingSafeEqual(hashA, hashB);
  } catch {
    return false;
  }
}

export { SEAL_SALT };
