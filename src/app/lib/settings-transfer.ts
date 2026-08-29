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

import { z } from "zod";
import { ConfigSchema } from "../../shared/schemas";
import type { Config } from "../../shared/schemas";
import { preParseConfigFixups, postParseConfigFixups, config, setConfig } from "../stores/config";
import { EXPORTED_VIEW_PREF_KEYS, applyImportedViewState, resetViewState } from "../stores/view";
import type { ViewState, TrackedItem, IgnoredItem } from "../stores/view";
import {
  token,
  jiraAuth,
  user,
  setJiraAuth,
  setAuthFromCredential,
  clearIdentityData,
} from "../stores/auth";
import type { GitHubUser, JiraAuthState } from "../stores/auth";
import { pushNotification } from "./errors";
import { proxyFetch, sealCredentialBundle } from "./proxy";

// ── Export ────────────────────────────────────────────────────────────

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

// EXPORTED_VIEW_PREF_KEYS lives in stores/view.ts (not here) to avoid a
// circular import — this module already transitively depends on that one via
// stores/config.ts and stores/auth.ts. Re-exported so existing consumers of
// this module (tests, EXPORT_DENYLIST-style callers) don't need to know that.
export { EXPORTED_VIEW_PREF_KEYS };

/**
 * `trackedItems` entry fields included in the export. An ALLOWLIST, not a
 * denylist — `title`, `htmlUrl`, and `jiraStatus` are content/PII-adjacent
 * fields that must never leave the browser in plaintext, and an allowlist
 * excludes them (and any future field) by default until a conscious decision
 * adds it here, whereas a denylist would leak every new field automatically.
 */
const TRACKED_ITEM_EXPORT_KEEP_LIST = [
  "id",
  "number",
  "type",
  "source",
  "repoFullName",
  "jiraKey",
  "jiraProjectKey",
  "addedAt",
] as const satisfies readonly (keyof TrackedItem)[];

/** Same allowlist rationale as TRACKED_ITEM_EXPORT_KEEP_LIST — `title` excluded. */
const IGNORED_ITEM_EXPORT_KEEP_LIST = [
  "id",
  "type",
  "repo",
  "ignoredAt",
] as const satisfies readonly (keyof IgnoredItem)[];

/** Reconstructs `obj` from ONLY the given keys (allowlist), dropping everything else. */
function pickAllowedFields<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const key of keys) {
    if (key in obj) out[key] = obj[key];
  }
  return out;
}

/**
 * Builds the `_viewPreferences` export section from the live view-state store.
 * Deep-clones via a JSON round-trip (same reason as `buildExportPayload`'s
 * config handling — `viewState` is a SolidJS store proxy), keeps only
 * `EXPORTED_VIEW_PREF_KEYS` — `ignoredItems`/`trackedItems` are skipped in
 * this generic copy and rebuilt below from their allowlists instead, so
 * content/PII-adjacent fields never reach the export regardless of what else
 * is on the live entry.
 */
function buildViewPreferencesSection(viewState: ViewState): Record<string, unknown> {
  const snapshot = JSON.parse(JSON.stringify(viewState)) as ViewState;
  const section: Record<string, unknown> = {};
  for (const key of EXPORTED_VIEW_PREF_KEYS) {
    if (key === "ignoredItems" || key === "trackedItems") continue;
    section[key] = snapshot[key];
  }
  section.ignoredItems = snapshot.ignoredItems.map((item) =>
    pickAllowedFields(item, IGNORED_ITEM_EXPORT_KEEP_LIST)
  );
  section.trackedItems = snapshot.trackedItems.map((item) =>
    pickAllowedFields(item, TRACKED_ITEM_EXPORT_KEEP_LIST)
  );
  return section;
}

/**
 * Builds the plaintext export payload from the live config + view-state
 * stores.
 *
 * Deep-clones `config` via a JSON round-trip — it's a SolidJS store proxy, so
 * a raw spread would leave nested objects proxied (matching the clone pattern
 * in `initConfigPersistence()`, src/app/stores/config.ts) — then deletes each
 * denylisted nested path, attaches the curated `_viewPreferences` section
 * (plaintext — it never carries secrets, so it does NOT go through the
 * encrypted-credentials envelope), and stamps `_exportVersion`.
 */
export function buildExportPayload(config: Config, viewState: ViewState): Record<string, unknown> {
  const snapshot = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  for (const [parentKey, childKeys] of Object.entries(EXPORT_DENYLIST)) {
    const parent = snapshot[parentKey];
    if (parent && typeof parent === "object") {
      for (const childKey of childKeys) {
        delete (parent as Record<string, unknown>)[childKey];
      }
    }
  }
  return {
    ...snapshot,
    _exportVersion: EXPORT_VERSION,
    _viewPreferences: buildViewPreferencesSection(viewState),
  };
}

// ── Import ──────────────────────────────────────────────────────────

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
 * LoginPage. Runs: byte-size guard → JSON parse → pre-parse fixups → full
 * `ConfigSchema.safeParse()` (NOT `.partial()`) → post-parse fixups. Mirrors
 * `loadConfig()`'s validation pattern.
 *
 * `rawJson` is the parsed-but-unvalidated object, retained so callers can
 * inspect it for `_credentials`/`_viewPreferences` sections without re-parsing
 * the text.
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

  // (b2) file-level version gate — reject a file stamped with a NEWER export
  // version up front with a clear message, mirroring the envelope/seal
  // version-byte fail-clean behavior. A missing/absent
  // _exportVersion is treated as version 1 (back-compat with pre-version
  // exports); ConfigSchema strips the key, so it must be read from rawJson here.
  if (rawJson && typeof rawJson === "object") {
    const rawVersion = (rawJson as Record<string, unknown>)._exportVersion;
    if (typeof rawVersion === "number" && rawVersion > EXPORT_VERSION) {
      return {
        ok: false,
        errors: [
          `This settings file was made by a newer version of the app (export v${rawVersion}). Update the app, then try importing again.`,
        ],
      };
    }
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

  // (f) success — rawJson is the parsed original, retained for _credentials/_viewPreferences inspection
  return { ok: true, config, rawJson };
}

// ── Client-side envelope encryption ─────────────────────────────────
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

// ── Crockford base32 helpers (client-side, self-contained) ───────────────────
//
// The one-time code is encoded as Crockford base32 rather than hex: it's what
// a user hand-types back in on the Login page, and Crockford's alphabet omits
// I, L, O, U specifically to avoid characters that are easily confused with
// each other (or, for U, with profanity) when read aloud or copied by hand.
//
// 16 bytes is 128 bits, which doesn't divide evenly into 5-bit groups, so the
// value is treated as a 128-bit big-endian integer, left-shifted 2 bits to 130
// bits (26 * 5 divides evenly), then emitted as 26 base32 digits MSB-first.
// Decoding reverses this: parse 26 digits back to the 130-bit integer, then
// right-shift 2 bits and serialize 16 big-endian bytes. The 2 padding bits
// introduced by the left-shift are always 0, so this round-trips exactly for
// any 16-byte input.

const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Crockford's documented human-entry leniency: I and L are easily misread as
 * the digit 1, and O as the digit 0, so a hand-retyped code maps them back
 * deterministically. U is deliberately NOT included here — it's simply not a
 * valid alphabet character, so an input 'U' is rejected by the format check
 * below rather than silently remapped (mapping it would make decoding
 * ambiguous with whatever character it aliased to).
 */
const CROCKFORD_LENIENCY: Readonly<Record<string, string>> = { I: "1", L: "1", O: "0" };

/** Exactly 26 Crockford base32 characters. Checked AFTER normalization (see `decodeOneTimeCode`), so this only ever sees uppercase, leniency-mapped input. */
const ONE_TIME_CODE_FORMAT_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function toCrockfordBase32(bytes: Uint8Array): string {
  let value = 0n;
  for (const b of bytes) {
    value = (value << 8n) | BigInt(b);
  }
  value <<= 2n; // 128 -> 130 bits (26 * 5)
  let out = "";
  for (let i = 25; i >= 0; i--) {
    out += CROCKFORD_ALPHABET[Number((value >> BigInt(i * 5)) & 0x1fn)];
  }
  return out;
}

/**
 * Inverse of `toCrockfordBase32`. `chars` MUST already be normalized and
 * format-validated (exactly 26 characters, all members of CROCKFORD_ALPHABET)
 * — see `decodeOneTimeCode`, the only caller.
 */
function fromCrockfordBase32(chars: string): Uint8Array {
  let value = 0n;
  for (const ch of chars) {
    value = (value << 5n) | BigInt(CROCKFORD_ALPHABET.indexOf(ch));
  }
  value >>= 2n; // 130 -> 128 bits
  const bytes = new Uint8Array(16);
  for (let i = 15; i >= 0; i--) {
    bytes[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return bytes;
}

/**
 * Generates a one-time code: 16 CSPRNG bytes (128 bits) Crockford base32-
 * encoded (26 chars) and formatted for display/copy as dash-separated groups
 * of 4 (`XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XX`).
 */
export function generateOneTimeCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const encoded = toCrockfordBase32(bytes);
  return encoded.match(/.{1,4}/g)!.join("-");
}

/**
 * Decodes a one-time code (as displayed OR as manually retyped by a user) back
 * to its 16 raw bytes. Normalizes first — trims surrounding whitespace, strips
 * all internal dashes/whitespace, uppercases, and applies Crockford's I/L->1,
 * O->0 leniency — because on the pre-auth Login page the code is retyped by
 * hand and copy-paste may perturb it.
 */
export function decodeOneTimeCode(code: string): Uint8Array {
  const stripped = code.trim().replace(/[\s-]/g, "").toUpperCase();
  let normalized = "";
  for (const ch of stripped) {
    normalized += CROCKFORD_LENIENCY[ch] ?? ch;
  }
  if (!ONE_TIME_CODE_FORMAT_RE.test(normalized)) {
    throw new Error("One-time code is not in the expected format.");
  }
  return fromCrockfordBase32(normalized);
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

// ── Encrypted credentials export ────────────────────────────────────

/**
 * Schema for the decrypted credential bundle. The Jira sub-object is a
 * discriminated union on `authMethod` so TypeScript narrows
 * `sealedRefreshToken`/`sealedApiToken` to defined after the check (avoids a cast
 * in `commitImportedSettings`). Reused on import to validate the decrypted bundle
 * before use, matching this codebase's Zod-validate-every-persisted-blob
 * convention.
 */
export const CredentialBundleSchema = z.object({
  github: z.object({
    token: z.string(),
    method: z.enum(["pat", "oauth"]),
  }),
  jira: z.union([
    z.null(),
    // Jira identity fields mirror JiraAuthStateSchema's constraints
    // (cloudId/siteName .min(1), siteUrl .url()) so a malformed bundle fails
    // clearly at import via resolveImportedCredentials' generic failure, instead
    // of importing + working in-session then silently vanishing on the next
    // reload when the stricter JiraAuthStateSchema rejects it.
    z.discriminatedUnion("authMethod", [
      z.object({
        authMethod: z.literal("oauth"),
        sealedRefreshToken: z.string(),
        cloudId: z.string().min(1),
        siteUrl: z.string().url(),
        siteName: z.string().min(1),
      }),
      z.object({
        authMethod: z.literal("token"),
        sealedApiToken: z.string(),
        email: z.string(),
        cloudId: z.string().min(1),
        siteUrl: z.string().url(),
        siteName: z.string().min(1),
      }),
    ]),
  ]),
});

export type CredentialBundle = z.infer<typeof CredentialBundleSchema>;

/**
 * Schema for the export file's `_credentials` section (sealed blob + salt).
 * Import uses `.safeParse()` on `rawJson._credentials` (NOT a bare `"in"` check —
 * a hand-crafted `_credentials: null` would pass that and then throw on
 * dereference) to decide whether a credentials section is present.
 */
export const CredentialsSectionSchema = z.object({
  sealed: z.string(),
  salt: z.string(),
});

export type CredentialsSection = z.infer<typeof CredentialsSectionSchema>;

/**
 * Assembles the credential bundle from the live auth + config stores.
 * Non-nullable — the Settings page always has an authenticated GitHub session.
 *
 * Jira identity fields (cloudId/siteUrl/siteName) are read from `JiraAuthState`,
 * the authoritative source restored on import — NOT `config.jira`'s independent
 * copies. The Jira OAuth branch deliberately excludes the short-lived plaintext
 * `accessToken` (re-minted on import via `/api/oauth/jira/refresh`); the
 * token-mode branch carries the already-Worker-sealed API token + email.
 */
export function assembleCredentialBundle(): CredentialBundle {
  const githubToken = token() ?? "";
  const method = config.authMethod; // "oauth" | "pat"

  const auth = jiraAuth();
  let jira: CredentialBundle["jira"] = null;
  if (config.jira?.enabled && auth) {
    if (config.jira.authMethod === "oauth") {
      jira = {
        authMethod: "oauth",
        sealedRefreshToken: auth.sealedRefreshToken,
        cloudId: auth.cloudId,
        siteUrl: auth.siteUrl,
        siteName: auth.siteName,
      };
    } else {
      jira = {
        authMethod: "token",
        sealedApiToken: auth.accessToken,
        email: auth.email ?? config.jira.email ?? "",
        cloudId: auth.cloudId,
        siteUrl: auth.siteUrl,
        siteName: auth.siteName,
      };
    }
  }

  return { github: { token: githubToken, method }, jira };
}

/**
 * Orchestrates the encrypted-credentials export section:
 *   1. generate a one-time code (client-side CSPRNG),
 *   2. encrypt the JSON-stringified bundle WITH that code (client-side), THEN
 *   3. seal ONLY that ciphertext server-side.
 *
 * ENCRYPT-THEN-SEAL ordering is load-bearing (see the plan's security review):
 * `sealCredentialBundle` receives ONLY `encryptWithCode`'s ciphertext output,
 * never the raw bundle. Returns the sealed blob + salt (both safe to store in the
 * export file) and the one-time code (returned for one-time display, NEVER
 * written into the export JSON).
 */
export async function buildEncryptedCredentialsSection(): Promise<{
  sealed: string;
  salt: string;
  oneTimeCode: string;
}> {
  const bundle = assembleCredentialBundle();
  const oneTimeCode = generateOneTimeCode();
  const { ciphertext, salt } = await encryptWithCode(JSON.stringify(bundle), oneTimeCode);
  const sealed = await sealCredentialBundle(ciphertext);
  return { sealed, salt, oneTimeCode };
}

// ── Encrypted credentials import ────────────────────────────────────

const IMPORT_DECRYPT_FAILED =
  "Couldn't decrypt credentials — check the code and file match.";
const IMPORT_GITHUB_INVALID =
  "Imported GitHub credential is no longer valid — it may have been revoked, or the token/session has expired.";
const IMPORT_INSECURE_CONTEXT =
  "Encrypted credential import requires a secure context (HTTPS or localhost) — this page was loaded insecurely.";

/**
 * Standard GitHub REST headers for the identity check, mirroring auth.ts's
 * VALIDATE_HEADERS (not exported there) used at every other GET /user site —
 * pins the API version so a future default change can't shift this validation.
 */
const GITHUB_API_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
} as const;

/**
 * Resolves (validates — does NOT commit) imported credentials from an
 * already-unsealed inner ciphertext. NON-mutating and retryable against a cached
 * ciphertext: the single-use network unseal happens once in the caller (via
 * `unsealCredentialBundle`); this only decrypts, schema-validates, and makes a
 * read-only `GET /user` identity check, so wrong-code retries never re-hit the
 * single-use endpoint.
 *
 * Failure messages: wrong-code and corrupted-file both surface the SAME generic
 * message (uniform-failure security decision); a revoked/expired GitHub token
 * (401 OR network failure) surfaces a distinct message; and the secure-context
 * precondition — an environment condition, not a secret — is surfaced distinctly
 * up front so it isn't swallowed into a null that masquerades as a wrong
 * code.
 */
export async function resolveImportedCredentials(
  unsealedCiphertext: string,
  salt: string,
  code: string
): Promise<
  | { ok: true; bundle: CredentialBundle; identity: GitHubUser }
  | { ok: false; error: string }
> {
  if (!crypto.subtle) {
    return { ok: false, error: IMPORT_INSECURE_CONTEXT };
  }

  const decrypted = await decryptWithCode(unsealedCiphertext, salt, code);
  if (decrypted === null) {
    return { ok: false, error: IMPORT_DECRYPT_FAILED };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(decrypted);
  } catch {
    return { ok: false, error: IMPORT_DECRYPT_FAILED };
  }

  const bundleResult = CredentialBundleSchema.safeParse(parsedJson);
  if (!bundleResult.success) {
    return { ok: false, error: IMPORT_DECRYPT_FAILED };
  }
  const bundle = bundleResult.data;

  let resp: Response;
  try {
    resp = await fetch("https://api.github.com/user", {
      headers: { ...GITHUB_API_HEADERS, Authorization: `Bearer ${bundle.github.token}` },
    });
  } catch {
    return { ok: false, error: IMPORT_GITHUB_INVALID };
  }
  if (!resp.ok) {
    return { ok: false, error: IMPORT_GITHUB_INVALID };
  }

  const identity = (await resp.json()) as GitHubUser;
  return { ok: true, bundle, identity };
}

/**
 * Commits resolved credentials + imported config + imported view preferences
 * in a strict order. Called ONLY after user confirmation.
 *
 *   (a0) pre-auth (user() === null, the Login-page path): `await
 *        clearIdentityData()` FIRST so a prior identity's IndexedDB cache + poll
 *        state can't leak into the just-imported identity, THEN `resetViewState()`
 *        — setAuthFromCredential's identity-switch reset is INERT here (its
 *        `previousLogin` check needs a non-null `user()`), and `setConfig`/
 *        `applyImportedViewState` below only wholesale-replace config and overlay
 *        the CURATED view-preference keys respectively, so without this a prior
 *        expired-token session's transient view keys (globalFilter/lastActiveTab/
 *        globalSort) would otherwise survive the import. On the Settings page
 *        user() is non-null, so this whole branch is skipped and
 *        setAuthFromCredential's own identity-switch reset handles isolation.
 *   (a)  `setAuthFromCredential(token, identity)` — establishes the GitHub
 *        session (auth-method-agnostic; runs the identity-switch reset cascade
 *        when the login differs).
 *   (b)  `setConfig(importedConfig)` — full replacement, AFTER (a) so the reset
 *        cascade can't clobber the just-imported config (and this corrects the
 *        transient `authMethod: "pat"` the cascade sets). Immediately followed
 *        by `applyImportedViewState(viewPreferences)` — same identity-scoped
 *        ordering rationale, and it's a total/no-throw no-op when
 *        `viewPreferences` is absent or malformed, so callers with no
 *        `_viewPreferences` section can pass `undefined` unconditionally.
 *   (c)  Jira restore — token-mode: build JiraAuthState locally (no network);
 *        oauth-mode: POST /api/oauth/jira/refresh to mint a fresh access token.
 *        Jira restore failure does NOT abort — GitHub identity/config are already
 *        committed; it pushes a reconnect warning and returns jiraRestored:false.
 */
export async function commitImportedSettings(
  resolved: { bundle: CredentialBundle; identity: GitHubUser },
  importedConfig: Config,
  viewPreferences?: unknown
): Promise<{ jiraRestored: boolean }> {
  // (a0) pre-auth identity isolation — awaited, so the cache clear + reset
  // callbacks fully complete before the new identity/config are established.
  if (user() === null) {
    await clearIdentityData();
    resetViewState();
  }

  // (a) establish the GitHub credential (used for BOTH pat and oauth methods).
  setAuthFromCredential(resolved.bundle.github.token, resolved.identity);

  // (b) apply the imported config wholesale AFTER identity is established.
  // The sealed bundle's authMethod is the tamper-proof source of
  // truth for the restored credential SHAPE (the plaintext config.jira.authMethod
  // is user-editable via the export file). Align the config to the bundle so
  // runtime createJiraClient/ensureJiraTokenValid take the branch matching the
  // JiraAuthState we actually restore below — otherwise a hand-edited
  // config.jira.authMethod could make Jira silently never work.
  const jira = resolved.bundle.jira;
  if (jira !== null && importedConfig.jira) {
    importedConfig.jira = { ...importedConfig.jira, authMethod: jira.authMethod };
  }
  setConfig(importedConfig);
  applyImportedViewState(viewPreferences);

  // (c) restore Jira.
  if (jira === null) {
    return { jiraRestored: true };
  }

  if (jira.authMethod === "token") {
    const state: JiraAuthState = {
      accessToken: jira.sealedApiToken,
      sealedRefreshToken: "",
      expiresAt: Number.MAX_SAFE_INTEGER,
      cloudId: jira.cloudId,
      siteUrl: jira.siteUrl,
      siteName: jira.siteName,
      email: jira.email,
    };
    setJiraAuth(state);
    return { jiraRestored: true };
  }

  // oauth-mode: mint a fresh access token from the sealed refresh token. Uses
  // proxyFetch (X-Requested-With) — handleJiraTokenRefresh calls
  // validateProxyRequest even though /api/oauth/* is not an isProxyPath route, so
  // a bare fetch would 403. Body key is snake_case (endpoint contract), NOT the
  // bundle's camelCase field name.
  let resp: Response;
  try {
    resp = await proxyFetch("/api/oauth/jira/refresh", {
      method: "POST",
      body: JSON.stringify({ sealed_refresh_token: jira.sealedRefreshToken }),
    });
  } catch {
    pushNotification(
      "settings-import-jira",
      "Your Jira connection couldn't be restored — please reconnect it in Settings.",
      "warning"
    );
    return { jiraRestored: false };
  }

  if (!resp.ok) {
    pushNotification(
      "settings-import-jira",
      "Your Jira connection couldn't be restored — please reconnect it in Settings.",
      "warning"
    );
    return { jiraRestored: false };
  }

  let data: { access_token: string; sealed_refresh_token: string; expires_in: number };
  try {
    data = (await resp.json()) as {
      access_token: string;
      sealed_refresh_token: string;
      expires_in: number;
    };
  } catch {
    // A malformed (but 200) refresh body degrades gracefully like the failures
    // above — GitHub identity/config are already committed, so throwing here
    // would abort a half-applied import instead of returning jiraRestored:false.
    pushNotification(
      "settings-import-jira",
      "Your Jira connection couldn't be restored — please reconnect it in Settings.",
      "warning"
    );
    return { jiraRestored: false };
  }
  // Clamp expires_in defensively, matching ensureJiraTokenValid's
  // handling of the same endpoint's contract — a non-positive/absent value would
  // otherwise yield a past/NaN expiresAt.
  const ttl = typeof data.expires_in === "number" && data.expires_in > 0 ? data.expires_in : 3600;
  const state: JiraAuthState = {
    accessToken: data.access_token,
    sealedRefreshToken: data.sealed_refresh_token,
    expiresAt: Date.now() + ttl * 1000,
    cloudId: jira.cloudId,
    siteUrl: jira.siteUrl,
    siteName: jira.siteName,
  };
  setJiraAuth(state);
  return { jiraRestored: true };
}

// ── Login-page import ────────────────────────────────────────────────

/**
 * True when the local config indicates prior onboarding or use — the signal the
 * pre-auth Login-page import uses to decide whether to show the identity-confirm
 * dialog before finalizing. A genuinely fresh browser/incognito session (no
 * onboarding, no repo/org selections) returns `false` and imports straight
 * through to the dashboard without a confirmation prompt. On the Settings page
 * the user is always already authenticated, so that flow always confirms and
 * never consults this helper.
 */
export function hasExistingLocalConfig(config: Config): boolean {
  return (
    config.onboardingComplete === true ||
    config.selectedRepos.length > 0 ||
    config.selectedOrgs.length > 0
  );
}
