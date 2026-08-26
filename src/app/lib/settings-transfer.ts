// ── Settings import / export utilities ────────────────────────────────────────
//
// Schema-drift guard workflow (enforced by tests/lib/settings-transfer.test.ts):
//   1. Add or remove a field on ConfigSchema / JiraConfigSchema (src/shared/schemas.ts).
//   2. Run `pnpm vitest run tests/lib/settings-transfer.test.ts`.
//   3. The guard test FAILS, naming the added/removed key(s).
//   4. Decide whether an ADDED field carries a secret or PII that must NOT leave
//      the browser. buildExportPayload() spreads the ENTIRE Config, so every new
//      field is exported by default — if the new field is sensitive, add it to
//      EXPORT_DENYLIST below. This conscious review is the whole point of the guard.
//   5. Only then update the snapshot arrays in the guard test to match the schema.
//
// SECURITY: nothing in this module may log the one-time code, decrypted bundle
// contents, or raw GitHub/Jira tokens — no console.* and no Sentry capture here
// (console output is production-visible and captured as Sentry breadcrumbs).

import { ConfigSchema } from "../../shared/schemas";
import type { Config } from "../../shared/schemas";
import { preParseConfigFixups, postParseConfigFixups } from "../stores/config";

// ── Export (Task 1) ────────────────────────────────────────────────────────────

/**
 * Nested paths stripped from the exported config. Currently only `jira.email`
 * (PII). The export spreads the full Config (see `buildExportPayload`) so every
 * current and future field is captured automatically; this denylist is the
 * single place secrets/PII are removed, and the schema-drift guard test forces a
 * review of it whenever the schema changes.
 */
export const EXPORT_DENYLIST: Record<string, readonly string[]> = {
  jira: ["email"],
};

/** Version stamp on exported payloads (bump on an incompatible format change). */
export const EXPORT_VERSION = 1;

/**
 * Builds the plaintext export payload from the live config store.
 *
 * Deep-clones via a JSON round-trip — `config` is a SolidJS store proxy, so a
 * raw spread would leave nested objects proxied (matching the clone pattern in
 * `initConfigPersistence()`, src/app/stores/config.ts) — then deletes each
 * denylisted nested path and stamps `_exportVersion`.
 */
export function buildExportPayload(config: Config): Record<string, unknown> {
  const snapshot = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  for (const [parentKey, childKeys] of Object.entries(EXPORT_DENYLIST)) {
    const parent = snapshot[parentKey];
    if (parent && typeof parent === "object") {
      for (const childKey of childKeys) {
        delete (parent as Record<string, unknown>)[childKey];
      }
    }
  }
  return { ...snapshot, _exportVersion: EXPORT_VERSION };
}

// ── Import (Task 2) ──────────────────────────────────────────────────────────

/**
 * Max import file size, in BYTES. Legitimate exports are only a few KB; this
 * bounds hand-crafted/adversarial files before we attempt to parse them.
 */
export const MAX_IMPORT_BYTES = 256 * 1024;

export type ParseImportResult =
  | { ok: true; config: Config; rawJson: unknown }
  | { ok: false; errors: string[] };

/**
 * Single entry point for importing a settings file, shared by SettingsPage and
 * (in a later task) LoginPage. Runs: byte-size guard → JSON parse → pre-parse
 * fixups → full `ConfigSchema.safeParse()` (NOT `.partial()`) → post-parse
 * fixups. Mirrors `loadConfig()`'s validation pattern.
 *
 * `rawJson` is the parsed-but-unvalidated object, retained so a later task can
 * inspect it for a `_credentials` section without re-parsing the text.
 */
export function parseImportFile(rawText: string): ParseImportResult {
  // (a) Byte-size guard — measure UTF-8 bytes, NOT rawText.length (UTF-16 code
  // units undercount multi-byte content by up to ~3x). Reject before parsing.
  if (new TextEncoder().encode(rawText).length > MAX_IMPORT_BYTES) {
    return { ok: false, errors: ["File is too large to import (max 256KB)."] };
  }

  // (b) JSON parse
  let rawJson: unknown;
  try {
    rawJson = JSON.parse(rawText);
  } catch {
    return { ok: false, errors: ["File is not valid JSON."] };
  }

  // (c) pre-parse migrations (theme salvage, [bot]-suffix strip)
  const fixed = preParseConfigFixups(rawJson);

  // (d) full schema validation
  const result = ConfigSchema.safeParse(fixed);
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map(
        (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`
      ),
    };
  }

  // (e) post-parse migrations (stale-defaultTab cleanup)
  const config = postParseConfigFixups(result.data);

  // (f) success — rawJson is the parsed original (for later _credentials inspection)
  return { ok: true, config, rawJson };
}

// ── Client-side envelope encryption (Task 4) ─────────────────────────────────
//
// A fully independent client-side AES-256-GCM implementation (NO shared code
// with src/worker/crypto.ts). Wire format for the ciphertext genuinely mirrors
// the Worker's sealToken layout: [ENVELOPE_VERSION:1][iv:12][ciphertext+tag:N],
// base64url-encoded. The one-time code is CSPRNG output (full entropy), so the
// key is HKDF-derived (not PBKDF2 — iteration cost buys nothing here).

/** Envelope wire-format version byte (mirrors crypto.ts's SEAL_VERSION). */
export const ENVELOPE_VERSION = 0x01;

/**
 * HKDF `info` string for the envelope key. Named for the FULL bundle's scope
 * (GitHub AND Jira credentials), distinct from every Worker-side HKDF purpose
 * string — this key is derived and used entirely client-side, never transmitted.
 */
export const ENVELOPE_KEY_INFO = "envelope-key:credential-bundle-export";

const ONE_TIME_CODE_HEX_RE = /^[0-9a-f]{32}$/;

// ── base64url helpers (client-side, self-contained) ──────────────────────────

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function fromBase64Url(str: string): Uint8Array {
  const normalized = str.replace(/-/g, "+").replace(/_/g, "/");
  const padding = (4 - (normalized.length % 4)) % 4;
  const binary = atob(normalized + "=".repeat(padding));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Generates a one-time code: 16 CSPRNG bytes (128 bits) hex-encoded and
 * formatted for display/copy as 8 dash-separated groups of 4 hex chars
 * (`XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX`).
 */
export function generateOneTimeCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return hex.match(/.{4}/g)!.join("-");
}

/**
 * Decodes a one-time code (as displayed OR as manually retyped by a user) back
 * to its 16 raw bytes. Normalizes first — trims surrounding whitespace, strips
 * all internal dashes/whitespace, and lowercases — because on the pre-auth
 * Login page the code is retyped by hand and copy-paste may perturb it.
 */
export function decodeOneTimeCode(code: string): Uint8Array {
  const normalized = code.trim().replace(/[\s-]/g, "").toLowerCase();
  if (!ONE_TIME_CODE_HEX_RE.test(normalized)) {
    throw new Error("One-time code is not in the expected format.");
  }
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Derives the AES-256-GCM envelope key from a one-time `code` and a `salt` (raw
 * bytes). The single entry point both `encryptWithCode` and `decryptWithCode`
 * call through, so the secure-context guard lives here and nowhere else.
 */
export async function deriveEnvelopeKey(code: string, salt: Uint8Array): Promise<CryptoKey> {
  if (!crypto.subtle) {
    throw new Error(
      "Encrypted credential export/import requires a secure context (HTTPS, or localhost) — this page was loaded insecurely."
    );
  }
  const ikm = decodeOneTimeCode(code);
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    ikm.buffer as ArrayBuffer,
    { name: "HKDF" },
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    // `salt as BufferSource`: the param is Uint8Array<ArrayBufferLike>, which the
    // strict lib types don't accept for HkdfParams.salt (SharedArrayBuffer-vs-
    // ArrayBuffer). Cast the view (preserves byteOffset/length, unlike .buffer).
    { name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: new TextEncoder().encode(ENVELOPE_KEY_INFO) },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * Encrypts `plaintext` with an already-derived `key`, producing a base64url
 * `[ENVELOPE_VERSION:1][iv:12][ciphertext+tag]` blob with a FRESH random 12-byte
 * IV per call. Exported so the IV-freshness test can hold the key fixed across
 * two calls and assert the ciphertexts differ (the catastrophic AES-GCM
 * IV-reuse regression guard).
 */
export async function encryptWithKey(plaintext: string, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintextBytes = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintextBytes);
  const ciphertextBytes = new Uint8Array(ciphertext);
  const result = new Uint8Array(1 + 12 + ciphertextBytes.length);
  result[0] = ENVELOPE_VERSION;
  result.set(iv, 1);
  result.set(ciphertextBytes, 13);
  return toBase64Url(result);
}

/**
 * Encrypts `plaintext` under a key derived from `code`, generating a FRESH
 * random 16-byte salt per call. Returns the base64url `ciphertext` and the
 * base64url `salt` (the salt is not secret — it's stored in the export file so
 * the same key can be re-derived on import).
 */
export async function encryptWithCode(
  plaintext: string,
  code: string
): Promise<{ ciphertext: string; salt: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveEnvelopeKey(code, salt);
  const ciphertext = await encryptWithKey(plaintext, key);
  return { ciphertext, salt: toBase64Url(salt) };
}

/**
 * Inverse of `encryptWithCode`. Returns the plaintext on success, or `null` on
 * ANY failure — wrong code, tampered ciphertext, malformed input, or an
 * unrecognized version byte — matching the Worker-side `unsealToken` convention
 * (no differentiated error detail).
 */
export async function decryptWithCode(
  ciphertext: string,
  salt: string,
  code: string
): Promise<string | null> {
  try {
    const key = await deriveEnvelopeKey(code, fromBase64Url(salt));
    const bytes = fromBase64Url(ciphertext);
    if (bytes.length < 1 + 12 + 16) return null; // too short to be valid
    if (bytes[0] !== ENVELOPE_VERSION) return null;
    const iv = bytes.slice(1, 13);
    const payload = bytes.slice(13);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, payload);
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}
