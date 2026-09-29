export interface CryptoEnv {
  SEAL_KEY: string; // base64-encoded HKDF input key material (32 bytes recommended)
  SEAL_KEY_NEXT?: string; // next HKDF key material for rotation (set before promoting to SEAL_KEY)
}

// ── Base64url utilities ────────────────────────────────────────────────────

export function toBase64Url(bytes: Uint8Array): string {
  const binary = String.fromCharCode(...bytes);
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
 * The info parameter MUST include a purpose string for token audience binding.
 * Pass e.g. "aes-gcm-key:<purpose>" or "session-hmac" so keys derived
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
 * Unseals a token, trying both current and next keys during rotation.
 * Both salt and info must match the values used during sealing.
 * The info parameter MUST include a purpose string for token audience binding.
 *
 * During rotation, tokens may have been sealed with either the current key
 * (SEAL_KEY) or the next key (SEAL_KEY_NEXT). Try current first since most
 * tokens were sealed before rotation began.
 */
export async function unsealTokenWithRotation(
  sealed: string,
  currentKey: string,
  nextKey: string | undefined,
  salt: string,
  info: string
): Promise<string | null> {
  const current = await deriveKey(currentKey, salt, info, "encrypt");
  const result = await unsealToken(sealed, current);
  if (result !== null) return result;

  if (nextKey !== undefined) {
    const next = await deriveKey(nextKey, salt, info, "encrypt");
    return unsealToken(sealed, next);
  }

  return null;
}

// ── Expiry-aware credential-bundle sealing ─────────────────────────────────
// Additive helpers used ONLY by the "credential-export-bundle" purpose. They
// wrap the plaintext with a server-clock timestamp (for expiry) and a
// content-fingerprint nonce (for single-use enforcement) before delegating to
// the existing sealToken/unsealToken primitives. Do NOT modify
// sealToken/unsealToken/unsealTokenWithRotation — the existing Jira sealing
// paths must remain untouched. crypto.ts stays a pure, KV-free module: the
// nonce is surfaced but never checked/consumed here (only index.ts has KV).

/** 30 days — a credential-export bundle expires this long after it is sealed. */
export const CREDENTIAL_BUNDLE_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Seals a plaintext inside a {createdAt, nonce, payload} wrapper.
 *
 * The nonce is a DETERMINISTIC SHA-256 fingerprint of the plaintext (base64url),
 * NOT a fresh per-call random value — re-sealing the exact same plaintext later
 * reproduces the identical nonce, which the unseal endpoint relies on to detect
 * an unseal-then-reseal attempt to renew a bundle's expiry.
 *
 * `key` must already be derived by the caller (matching how sealToken is invoked
 * at the existing call sites).
 */
export async function sealWithExpiry(
  plaintext: string,
  key: CryptoKey
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(plaintext)
  );
  const nonce = toBase64Url(new Uint8Array(digest));
  const wrapped = JSON.stringify({ createdAt: Date.now(), nonce, payload: plaintext });
  return sealToken(wrapped, key);
}

/**
 * Unseals a token produced by sealWithExpiry, trying current+next keys during
 * rotation (via unsealTokenWithRotation — same raw-secret-string signature).
 *
 * Returns the wrapper's payload, its content-fingerprint nonce, and its seal
 * timestamp on success (so the caller can consume the nonce AND derive a KV TTL
 * bounded by the bundle's remaining lifetime). Returns { reason: "expired" } if
 * the wrapper is older than maxAgeMs, or a single generic { reason: "invalid" }
 * for EVERY other failure (bad version, wrong key, corrupted ciphertext,
 * malformed wrapper JSON) — no further distinction, per the security decision.
 *
 * Does NOT check or consume the nonce — that is the caller's responsibility
 * (only index.ts has KV access).
 */
export async function unsealWithExpiry(
  sealed: string,
  currentKeySecret: string,
  nextKeySecret: string | undefined,
  salt: string,
  info: string,
  maxAgeMs: number
): Promise<
  | { ok: true; payload: string; nonce: string; createdAt: number }
  | { ok: false; reason: "expired" | "invalid" }
> {
  const wrapped = await unsealTokenWithRotation(
    sealed,
    currentKeySecret,
    nextKeySecret,
    salt,
    info
  );
  if (wrapped === null) return { ok: false, reason: "invalid" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(wrapped);
  } catch {
    return { ok: false, reason: "invalid" };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "invalid" };
  }
  const { createdAt, nonce, payload } = parsed as Record<string, unknown>;
  if (
    typeof createdAt !== "number" ||
    typeof nonce !== "string" ||
    typeof payload !== "string"
  ) {
    return { ok: false, reason: "invalid" };
  }

  if (Date.now() - createdAt > maxAgeMs) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true, payload, nonce, createdAt };
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
 * Verifies an HMAC-SHA256 signature using crypto.subtle.verify.
 * Cloudflare Workers implements this with constant-time comparison;
 * the Web Crypto spec does not mandate it, but this is the
 * platform-recommended pattern over manual sign() + comparison.
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
    return await crypto.subtle.verify("HMAC", key, sigBytes.buffer as ArrayBuffer, payloadBytes);
  } catch {
    return false;
  }
}

export { SEAL_SALT };
