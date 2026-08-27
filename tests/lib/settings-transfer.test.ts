import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock cache so auth's identity-clear path never touches IndexedDB; the pre-auth
// ordering test controls clearCache's timing directly via this mock.
vi.mock("../../src/app/stores/cache", () => ({
  clearCache: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@sentry/solid", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  withSentryErrorBoundary: vi.fn((c: unknown) => c),
}));

import { ConfigSchema, JiraConfigSchema } from "../../src/shared/schemas";
import {
  EXPORT_VERSION,
  EXPORT_DENYLIST,
  MAX_IMPORT_BYTES,
  buildExportPayload,
  parseImportFile,
  generateOneTimeCode,
  decodeOneTimeCode,
  deriveEnvelopeKey,
  encryptWithKey,
  encryptWithCode,
  decryptWithCode,
  ENVELOPE_VERSION,
  CredentialBundleSchema,
  assembleCredentialBundle,
  buildEncryptedCredentialsSection,
  resolveImportedCredentials,
  commitImportedSettings,
  hasExistingLocalConfig,
} from "../../src/app/lib/settings-transfer";
import type { CredentialBundle } from "../../src/app/lib/settings-transfer";
import * as proxyLib from "../../src/app/lib/proxy";
import * as authStore from "../../src/app/stores/auth";
import * as cacheStore from "../../src/app/stores/cache";
import * as errorsLib from "../../src/app/lib/errors";
import {
  config,
  setConfig,
  resetConfig,
  updateConfig,
  updateJiraConfig,
  CONFIG_STORAGE_KEY,
  initConfigPersistence,
} from "../../src/app/stores/config";
import * as configStore from "../../src/app/stores/config";
import { viewState, updateViewState } from "../../src/app/stores/view";
import { createRoot } from "solid-js";

// ── Schema-drift guard update workflow ────────────────────────────────────────
// When ConfigSchema / JiraConfigSchema change, the two guard tests below FAIL.
// Before touching the snapshot arrays:
//   1. Read the failure message — it names the added/removed key(s).
//   2. If a key was ADDED, decide whether it carries a secret or PII.
//      buildExportPayload() exports EVERY Config field by default, so a
//      sensitive new field MUST be added to EXPORT_DENYLIST in
//      src/app/lib/settings-transfer.ts.
//   3. Only THEN update the EXPECTED_*_KEYS array here to match the schema.

const EXPECTED_CONFIG_KEYS = [
  "authMethod",
  "customTabs",
  "defaultTab",
  "dependencies",
  "enableActions",
  "enableTracking",
  "hotPollInterval",
  "itemsPerPage",
  "jira",
  "maxRunsPerWorkflow",
  "maxWorkflowsPerRepo",
  "mcpRelayEnabled",
  "mcpRelayPort",
  "monitoredRepos",
  "notifications",
  "onboardingComplete",
  "refreshInterval",
  "rememberLastTab",
  "selectedOrgs",
  "selectedRepos",
  "theme",
  "trackedUsers",
  "upstreamRepos",
  "viewDensity",
];

const EXPECTED_JIRA_KEYS = [
  "authMethod",
  "cloudId",
  "customFields",
  "customScopes",
  "email",
  "enabled",
  "expandIssueDetails",
  "issueKeyDetection",
  "siteName",
  "siteUrl",
];

function diffKeys(actual: string[], expected: string[]): { added: string[]; removed: string[] } {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  return {
    added: actual.filter((k) => !expectedSet.has(k)),
    removed: expected.filter((k) => !actualSet.has(k)),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("settings-transfer — schema-drift guard", () => {
  it("ConfigSchema top-level shape matches the export snapshot", () => {
    const actual = Object.keys(ConfigSchema.shape).sort();
    const { added, removed } = diffKeys(actual, EXPECTED_CONFIG_KEYS);
    expect(
      added.length === 0 && removed.length === 0,
      `ConfigSchema top-level keys changed (added: [${added.join(", ")}], removed: [${removed.join(", ")}]). ` +
        "Before updating EXPECTED_CONFIG_KEYS, review EXPORT_DENYLIST in " +
        "src/app/lib/settings-transfer.ts: buildExportPayload() exports EVERY Config field by " +
        "default, so decide whether any ADDED field carries a secret or PII that must be denylisted."
    ).toBe(true);
  });

  it("JiraConfigSchema shape matches the export snapshot", () => {
    const actual = Object.keys(JiraConfigSchema.shape).sort();
    const { added, removed } = diffKeys(actual, EXPECTED_JIRA_KEYS);
    expect(
      added.length === 0 && removed.length === 0,
      `JiraConfigSchema keys changed (added: [${added.join(", ")}], removed: [${removed.join(", ")}]). ` +
        "Before updating EXPECTED_JIRA_KEYS, review EXPORT_DENYLIST in " +
        "src/app/lib/settings-transfer.ts (jira.email is currently denylisted as PII) and decide " +
        "whether any ADDED Jira field must also be denylisted."
    ).toBe(true);
  });
});

describe("buildExportPayload", () => {
  it("omits denylisted jira.email while keeping the rest of the jira object", () => {
    const cfg = ConfigSchema.parse({
      jira: { enabled: true, email: "secret@example.com", cloudId: "cloud-123" },
    });
    expect(cfg.jira.email).toBe("secret@example.com");

    const out = buildExportPayload(cfg);
    const jira = out.jira as Record<string, unknown>;
    expect(jira).toBeDefined();
    expect("email" in jira).toBe(false);
    // The rest of the jira object survives the denylist deletion.
    expect(jira.cloudId).toBe("cloud-123");
    expect(jira.enabled).toBe(true);
    // EXPORT_DENYLIST documents exactly what was removed.
    expect(EXPORT_DENYLIST.jira).toContain("email");
  });

  it("stamps the export version", () => {
    const out = buildExportPayload(ConfigSchema.parse({}));
    expect(out._exportVersion).toBe(EXPORT_VERSION);
    expect(out._exportVersion).toBe(1);
  });

  it("includes fields absent from the old hand-maintained export list (proves the spread mechanism)", () => {
    // onboardingComplete + mcpRelayEnabled exist in ConfigSchema but were NEVER
    // in SettingsPage.tsx's pre-refactor object literal — their presence is the
    // assertion that actually distinguishes a schema-driven rewrite from a
    // leftover manual literal.
    const out = buildExportPayload(ConfigSchema.parse({}));
    expect(Object.prototype.hasOwnProperty.call(out, "onboardingComplete")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(out, "mcpRelayEnabled")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(out, "mcpRelayPort")).toBe(true);
  });
});

describe("parseImportFile", () => {
  it("parses a valid export payload produced by buildExportPayload", () => {
    const payload = buildExportPayload(ConfigSchema.parse({ theme: "dark", itemsPerPage: 50 }));
    const result = parseImportFile(JSON.stringify(payload));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.theme).toBe("dark");
      expect(result.config.itemsPerPage).toBe(50);
    }
  });

  it("rejects an oversized (ASCII) file WITHOUT calling JSON.parse", () => {
    const big = "a".repeat(300 * 1024); // 307200 bytes > 256KB
    const parseSpy = vi.spyOn(JSON, "parse");
    const result = parseImportFile(big);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/too large/i);
    expect(parseSpy).not.toHaveBeenCalled();
  });

  it("measures BYTES not code units — rejects multi-byte content under 256KB code units but over 256KB bytes", () => {
    // 100Ki CJK chars: length (code units) < 256Ki, UTF-8 byte size (~3x) > 256Ki.
    const cjk = "语".repeat(100 * 1024);
    expect(cjk.length).toBeLessThan(MAX_IMPORT_BYTES); // 102400 < 262144
    expect(new TextEncoder().encode(cjk).length).toBeGreaterThan(MAX_IMPORT_BYTES); // ~307200 > 262144

    const parseSpy = vi.spyOn(JSON, "parse");
    const result = parseImportFile(cjk);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/too large/i);
    expect(parseSpy).not.toHaveBeenCalled();
  });

  it("returns a JSON-syntax error for non-JSON text", () => {
    const result = parseImportFile("this is not json {{{");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/json/i);
  });

  it("returns Zod issue messages for structurally-invalid JSON (valid JSON, fails schema)", () => {
    const result = parseImportFile(JSON.stringify({ refreshInterval: -999 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((e) => e.includes("refreshInterval"))).toBe(true);
    }
  });

  it("carries the pre-parse theme salvage through import (invalid theme, otherwise valid)", () => {
    const result = parseImportFile(JSON.stringify({ theme: "ultraviolet", refreshInterval: 120 }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.theme).toBe("auto"); // salvaged, not a total fallback
      expect(result.config.refreshInterval).toBe(120); // proves the rest survived
    }
  });

  it("fills schema defaults for a payload missing fields (forward-compatible)", () => {
    const result = parseImportFile(JSON.stringify({}));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.refreshInterval).toBe(300);
      expect(result.config.theme).toBe("auto");
    }
  });

  it("STRUCT-I-001: rejects a file stamped with a NEWER export version, with a clear message", () => {
    const result = parseImportFile(JSON.stringify({ _exportVersion: 2, theme: "dark" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/newer version/i);
  });

  it("STRUCT-I-001: accepts version 1 and a missing _exportVersion (treated as v1)", () => {
    expect(parseImportFile(JSON.stringify({ _exportVersion: 1, theme: "dark" })).ok).toBe(true);
    expect(parseImportFile(JSON.stringify({ theme: "dark" })).ok).toBe(true);
    // A round-tripped real export (stamped v1 by buildExportPayload) also parses.
    expect(parseImportFile(JSON.stringify(buildExportPayload(ConfigSchema.parse({})))).ok).toBe(true);
  });
});

// ── Task 4: client-side envelope encryption ──────────────────────────────────

// Mirrors src/app/lib/settings-transfer.ts's Crockford alphabet (excludes I, L, O, U).
const CODE_DISPLAY_RE = /^([0-9A-HJKMNP-TV-Z]{4}-){5}[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{2}$/;

// Independent reference encoder (NOT imported from src) so the round-trip test
// below actually cross-checks decodeOneTimeCode against a second implementation,
// instead of just calling the same code twice.
function crockfordEncode(bytes: Uint8Array): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let value = 0n;
  for (const b of bytes) value = (value << 8n) | BigInt(b);
  value <<= 2n;
  let out = "";
  for (let i = 25; i >= 0; i--) out += alphabet[Number((value >> BigInt(i * 5)) & 0x1fn)];
  return out;
}

// Test-local base64url helpers to construct/mutate wire bytes precisely.
function b64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
function b64urlDecode(str: string): Uint8Array {
  const norm = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (norm.length % 4)) % 4;
  const bin = atob(norm + "=".repeat(pad));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

describe("generateOneTimeCode / decodeOneTimeCode", () => {
  it("produces the display format (26 Crockford base32 chars, dash-separated in groups of 4)", () => {
    expect(generateOneTimeCode()).toMatch(CODE_DISPLAY_RE);
  });

  it("produces a different code on consecutive calls", () => {
    expect(generateOneTimeCode()).not.toBe(generateOneTimeCode());
  });

  it("round-trips: decodeOneTimeCode(generateOneTimeCode()) is the original 16 bytes, and re-encodes identically", () => {
    const code = generateOneTimeCode();
    const bytes = decodeOneTimeCode(code);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(16);
    // Cross-checked against an independent reference encoder, not src's own.
    expect(crockfordEncode(bytes)).toBe(code.replace(/-/g, ""));
  });

  it("normalizes a manually-perturbed code (lowercased, whitespace/dashes added) to the same bytes", () => {
    const code = generateOneTimeCode();
    const original = decodeOneTimeCode(code);
    const perturbed = `  ${code.toLowerCase().replace(/-/g, "")}  `;
    expect(Array.from(decodeOneTimeCode(perturbed))).toEqual(Array.from(original));
  });

  it("applies Crockford's I/L->1, O->0 leniency (mixed case, non-standard dash placement)", () => {
    // 26 valid Crockford chars containing both '0' and '1' digits.
    const clean = "0011AABBCCDDEEFFGGHHJJKKMM";
    const original = decodeOneTimeCode(clean);
    // Same value retyped with I/L for 1, O/o for 0, mixed case, and dashes that
    // don't even align to 4-char groups — normalization doesn't care about
    // grouping, only about stripping dashes/whitespace before mapping.
    const perturbed = "  oO-IL-aabbccddeeffgghhjjkkmm  ";
    expect(Array.from(decodeOneTimeCode(perturbed))).toEqual(Array.from(original));
  });

  it("rejects 'U' — Crockford excludes it and it is never remapped", () => {
    const bad = "0011AABBCCDDEEFFGGHHJJKKMU"; // valid 25 chars + trailing U
    expect(() => decodeOneTimeCode(bad)).toThrow("One-time code is not in the expected format.");
  });

  it("rejects other out-of-alphabet characters", () => {
    expect(() => decodeOneTimeCode("0011AABBCCDDEEFFGGHHJJKK!!")).toThrow(
      "One-time code is not in the expected format."
    );
  });

  it("rejects the wrong length", () => {
    const valid = generateOneTimeCode().replace(/-/g, "");
    expect(() => decodeOneTimeCode(valid.slice(0, 25))).toThrow(
      "One-time code is not in the expected format."
    );
    expect(() => decodeOneTimeCode(valid + "0")).toThrow(
      "One-time code is not in the expected format."
    );
  });
});

describe("deriveEnvelopeKey — secure-context guard", () => {
  it("rejects with the secure-context message when crypto.subtle is unavailable", async () => {
    const realCrypto = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: realCrypto.getRandomValues.bind(realCrypto) });
    await expect(
      deriveEnvelopeKey("0000-0000-0000-0000-0000-0000-00", new Uint8Array(16))
    ).rejects.toThrow(/secure context/i);
  });
});

describe("encryptWithCode / decryptWithCode", () => {
  it("round-trips the plaintext exactly", async () => {
    const code = generateOneTimeCode();
    const { ciphertext, salt } = await encryptWithCode("hello, credential bundle", code);
    expect(await decryptWithCode(ciphertext, salt, code)).toBe("hello, credential bundle");
  });

  it("returns null when decrypting with the wrong code", async () => {
    const { ciphertext, salt } = await encryptWithCode("top secret", generateOneTimeCode());
    expect(await decryptWithCode(ciphertext, salt, generateOneTimeCode())).toBeNull();
  });

  it("returns null when the ciphertext is tampered (single flipped bit)", async () => {
    const code = generateOneTimeCode();
    const { ciphertext, salt } = await encryptWithCode("top secret", code);
    const bytes = b64urlDecode(ciphertext);
    bytes[bytes.length - 1] ^= 0x01; // flip a bit in the GCM tag/body
    expect(await decryptWithCode(b64urlEncode(bytes), salt, code)).toBeNull();
  });

  it("returns null when the version byte is unrecognized", async () => {
    const code = generateOneTimeCode();
    const { ciphertext, salt } = await encryptWithCode("top secret", code);
    const bytes = b64urlDecode(ciphertext);
    expect(bytes[0]).toBe(ENVELOPE_VERSION); // sanity: real version
    bytes[0] = 0x02; // corrupt version byte
    expect(await decryptWithCode(b64urlEncode(bytes), salt, code)).toBeNull();
  });

  it("uses a fresh IV per call — same key + same plaintext yields different ciphertexts", async () => {
    // MUST isolate the IV: derive the key ONCE (fixed salt) and call the
    // lower-level encryptWithKey twice, so a reused/hardcoded IV would fail here.
    // (Calling encryptWithCode twice would mask an IV-reuse bug via its
    // fresh-random-salt-per-call changing the derived key each time.)
    const salt = new Uint8Array(16); // fixed salt
    const key = await deriveEnvelopeKey(generateOneTimeCode(), salt);
    const c1 = await encryptWithKey("identical plaintext", key);
    const c2 = await encryptWithKey("identical plaintext", key);
    expect(c1).not.toBe(c2);
  });
});

// ── Task 5: assemble credential bundle ────────────────────────────────────────

describe("assembleCredentialBundle / CredentialBundleSchema", () => {
  beforeEach(() => {
    authStore.clearJiraConfigFull(); // nulls jiraAuth + resets jira config
    resetConfig();
  });

  it("PAT-auth user with no Jira produces { github:{token,method:pat}, jira:null }", () => {
    authStore.setAuth({ access_token: "ghp_patuser" });
    updateConfig({ authMethod: "pat" });
    const bundle = assembleCredentialBundle();
    expect(bundle).toEqual({ github: { token: "ghp_patuser", method: "pat" }, jira: null });
    expect(CredentialBundleSchema.safeParse(bundle).success).toBe(true);
  });

  it("OAuth user with Jira OAuth: carries sealedRefreshToken/cloudId/siteUrl/siteName, EXCLUDES plaintext access token", () => {
    authStore.setAuth({ access_token: "gho_oauthuser" });
    updateConfig({ authMethod: "oauth" });
    updateJiraConfig({ enabled: true, authMethod: "oauth" });
    authStore.setJiraAuth({
      accessToken: "JIRA-PLAINTEXT-ACCESS-DO-NOT-EXPORT",
      sealedRefreshToken: "sealed-refresh-blob",
      expiresAt: Date.now() + 3_600_000,
      cloudId: "cloud-1",
      siteUrl: "https://oauth.atlassian.net",
      siteName: "OAuthSite",
    });
    const bundle = assembleCredentialBundle();
    expect(bundle.jira).toEqual({
      authMethod: "oauth",
      sealedRefreshToken: "sealed-refresh-blob",
      cloudId: "cloud-1",
      siteUrl: "https://oauth.atlassian.net",
      siteName: "OAuthSite",
    });
    // The short-lived plaintext access token must NOT be present anywhere.
    expect(JSON.stringify(bundle)).not.toContain("JIRA-PLAINTEXT-ACCESS-DO-NOT-EXPORT");
    expect(CredentialBundleSchema.safeParse(bundle).success).toBe(true);
  });

  it("Jira token-mode: carries sealedApiToken/email/cloudId/siteUrl/siteName", () => {
    authStore.setAuth({ access_token: "ghp_tokenuser" });
    updateConfig({ authMethod: "pat" });
    updateJiraConfig({ enabled: true, authMethod: "token" });
    authStore.setJiraAuth({
      accessToken: "sealed-api-token-blob",
      sealedRefreshToken: "",
      expiresAt: Number.MAX_SAFE_INTEGER,
      cloudId: "cloud-2",
      siteUrl: "https://token.atlassian.net",
      siteName: "TokenSite",
      email: "user@example.com",
    });
    const bundle = assembleCredentialBundle();
    expect(bundle.jira).toEqual({
      authMethod: "token",
      sealedApiToken: "sealed-api-token-blob",
      email: "user@example.com",
      cloudId: "cloud-2",
      siteUrl: "https://token.atlassian.net",
      siteName: "TokenSite",
    });
    expect(CredentialBundleSchema.safeParse(bundle).success).toBe(true);
  });
});

// ── Task 5/6: proxy credential seal/unseal helpers ────────────────────────────

/**
 * Installs a Turnstile mock (captures render opts) + a document.createElement
 * spy that auto-fires the injected <script>'s onload so acquireTurnstileToken's
 * script-load promise resolves. Returns the captured render-opts array.
 */
function installTurnstileHarness(): Array<Record<string, unknown>> {
  const renderOpts: Array<Record<string, unknown>> = [];
  (window as unknown as { turnstile: unknown }).turnstile = {
    render: (_c: unknown, opts: Record<string, unknown>) => {
      renderOpts.push(opts);
      queueMicrotask(() => (opts.callback as (t: string) => void)("ts-token"));
      return "widget-id";
    },
    execute: () => {},
    remove: () => {},
  };
  // Intercept the <script> append so happy-dom never tries to actually fetch the
  // Turnstile script (which fires onerror). Fire onload ourselves so
  // loadTurnstileScript's promise resolves. (Memoized module-side after the
  // first successful load, so only the first proxy test needs this.)
  const origAppend = document.head.appendChild.bind(document.head);
  vi.spyOn(document.head, "appendChild").mockImplementation(((node: Node) => {
    if ((node as Element).tagName === "SCRIPT") {
      queueMicrotask(() => (node as HTMLScriptElement).onload?.(new Event("load")));
      return node;
    }
    return origAppend(node as never);
  }) as typeof document.head.appendChild);
  return renderOpts;
}

describe("proxy — sealCredentialBundle / unsealCredentialBundle (Task 5/6)", () => {
  let renderOpts: Array<Record<string, unknown>>;

  beforeEach(() => {
    vi.stubEnv("VITE_TURNSTILE_SITE_KEY", "test-site-key");
    renderOpts = installTurnstileHarness();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sealApiToken still requests Turnstile action 'seal' after parameterization", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ sealed: "S" }) }));
    await proxyLib.sealApiToken("tok", "jira-api-token");
    expect(renderOpts[0]?.action).toBe("seal");
  });

  it("sealCredentialBundle sends the right body, requests action 'seal', and returns the sealed blob", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ sealed: "SEALED-BLOB" }) });
    vi.stubGlobal("fetch", fetchMock);
    const sealed = await proxyLib.sealCredentialBundle("ENVELOPE-CIPHERTEXT");
    expect(sealed).toBe("SEALED-BLOB");
    expect(renderOpts[0]?.action).toBe("seal");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/proxy/seal");
    expect(JSON.parse(init.body as string)).toEqual({ token: "ENVELOPE-CIPHERTEXT", purpose: "credential-export-bundle" });
    expect((init.headers as Record<string, string>)["X-Requested-With"]).toBe("fetch");
  });

  it("sealCredentialBundle throws SealError on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: "invalid_request" }) }));
    await expect(proxyLib.sealCredentialBundle("x")).rejects.toBeInstanceOf(proxyLib.SealError);
  });

  it("sealCredentialBundle rejects an oversized ciphertext BEFORE any network call (pre-check)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(proxyLib.sealCredentialBundle("z".repeat(4097))).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("unsealCredentialBundle maps 200 { payload } to { ok:true, ciphertext } and requests action 'unseal'", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ payload: "INNER-CIPHERTEXT" }) });
    vi.stubGlobal("fetch", fetchMock);
    const res = await proxyLib.unsealCredentialBundle("SEALED");
    expect(res).toEqual({ ok: true, ciphertext: "INNER-CIPHERTEXT" });
    expect(renderOpts[0]?.action).toBe("unseal");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/proxy/unseal");
    expect(JSON.parse(init.body as string)).toEqual({ sealed: "SEALED", purpose: "credential-export-bundle" });
    expect((init.headers as Record<string, string>)["X-Requested-With"]).toBe("fetch");
  });

  it("unsealCredentialBundle maps { error:'expired' } to { ok:false, reason:'expired' }", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: "expired" }) }));
    expect(await proxyLib.unsealCredentialBundle("SEALED")).toEqual({ ok: false, reason: "expired" });
  });

  it("unsealCredentialBundle maps { error:'invalid' } to { ok:false, reason:'invalid' }", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: "invalid" }) }));
    expect(await proxyLib.unsealCredentialBundle("SEALED")).toEqual({ ok: false, reason: "invalid" });
  });

  it("unsealCredentialBundle maps a thrown proxyFetch to { ok:false, reason:'network' } (retryable, no nonce consumed)", async () => {
    // SEC-001: a network throw means NO server response arrived, so the single-use
    // nonce was never reached — retryable, NOT the terminal 'invalid'.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network down")));
    expect(await proxyLib.unsealCredentialBundle("SEALED")).toEqual({ ok: false, reason: "network" });
  });

  it("unsealCredentialBundle maps a 429 to { ok:false, reason:'rate-limited' } (retryable, pre-nonce)", async () => {
    // API-001: the pre-gate rate limiter fires before Turnstile and long before
    // nonce access, so the bundle is still valid — retryable.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({ error: "rate_limited" }) }));
    expect(await proxyLib.unsealCredentialBundle("SEALED")).toEqual({ ok: false, reason: "rate-limited" });
  });

  it("unsealCredentialBundle maps a 403 turnstile_failed to { ok:false, reason:'network' } (retryable, pre-nonce)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: "turnstile_failed" }) }));
    expect(await proxyLib.unsealCredentialBundle("SEALED")).toEqual({ ok: false, reason: "network" });
  });

  it("unsealCredentialBundle maps a 503 internal_error to { ok:false, reason:'network' } (retryable, pre-nonce)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({ error: "internal_error" }) }));
    expect(await proxyLib.unsealCredentialBundle("SEALED")).toEqual({ ok: false, reason: "network" });
  });

  it("unsealCredentialBundle keeps a genuine 401 { error:'invalid' } TERMINAL (bad blob / consumed nonce)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: "invalid" }) }));
    expect(await proxyLib.unsealCredentialBundle("SEALED")).toEqual({ ok: false, reason: "invalid" });
  });
});

// ── Task 5: buildEncryptedCredentialsSection (encrypt-then-seal) ───────────────

describe("buildEncryptedCredentialsSection", () => {
  beforeEach(() => {
    authStore.clearJiraConfigFull();
    resetConfig();
    authStore.setAuth({ access_token: "ghp_SECRET_GITHUB_TOKEN" });
    updateConfig({ authMethod: "pat" });
  });

  it("returns sealed + salt in the output and never leaks the one-time code into the stored pair", async () => {
    vi.spyOn(proxyLib, "sealCredentialBundle").mockResolvedValue("SEALED-OUTPUT");
    const { sealed, salt, oneTimeCode } = await buildEncryptedCredentialsSection();
    expect(sealed).toBe("SEALED-OUTPUT");
    expect(typeof salt).toBe("string");
    expect(oneTimeCode).toMatch(CODE_DISPLAY_RE);
    // The one-time code must NOT appear in what gets written to the export file.
    expect(JSON.stringify({ sealed, salt })).not.toContain(oneTimeCode);
  });

  it("ENCRYPT-THEN-SEAL: sealCredentialBundle receives ciphertext that decrypts to the bundle, never the raw token", async () => {
    const sealSpy = vi.spyOn(proxyLib, "sealCredentialBundle").mockResolvedValue("SEALED");

    const { salt, oneTimeCode } = await buildEncryptedCredentialsSection();

    expect(sealSpy).toHaveBeenCalledTimes(1);
    const sealedArg = sealSpy.mock.calls[0][0];
    // Negative assertions: the sealed input is opaque ciphertext, not plaintext.
    expect(sealedArg).not.toContain("ghp_SECRET_GITHUB_TOKEN");
    expect(sealedArg).not.toContain("\"github\"");
    expect(sealedArg).not.toContain("\"token\"");
    // It is EXACTLY encryptWithCode's output: decrypting sealCredentialBundle's
    // argument with the returned code+salt recovers the original bundle JSON —
    // proving the ciphertext (not the raw bundle) was handed to seal, i.e.
    // encrypt happened FIRST, then that exact ciphertext was sealed.
    const decrypted = await decryptWithCode(sealedArg, salt, oneTimeCode);
    expect(decrypted).not.toBeNull();
    const roundTripped = JSON.parse(decrypted!) as CredentialBundle;
    expect(roundTripped.github.token).toBe("ghp_SECRET_GITHUB_TOKEN");
  });

  it("full round-trip for a Jira-inclusive bundle near the 4096 pre-check boundary (assemble→encrypt→seal)", async () => {
    updateJiraConfig({ enabled: true, authMethod: "token" });
    const bigSealed = "S".repeat(2700); // pushes the envelope ciphertext near the 4096 client cap
    authStore.setJiraAuth({
      accessToken: bigSealed,
      sealedRefreshToken: "",
      expiresAt: Number.MAX_SAFE_INTEGER,
      cloudId: "cloud-2",
      siteUrl: "https://token.atlassian.net",
      siteName: "TokenSite",
      email: "user@example.com",
    });

    // Echo the ciphertext back as the sealed blob so we can decrypt it and prove
    // the whole assemble→encrypt→seal chain produced a recoverable Jira bundle.
    let sealedInput = "";
    vi.spyOn(proxyLib, "sealCredentialBundle").mockImplementation(async (ct: string) => {
      sealedInput = ct;
      return ct;
    });

    const { sealed, salt, oneTimeCode } = await buildEncryptedCredentialsSection();
    expect(sealed).toBe(sealedInput);
    // Within — and near — the client 4096 pre-check cap.
    expect(sealedInput.length).toBeLessThanOrEqual(4096);
    expect(sealedInput.length).toBeGreaterThan(3000);

    const decrypted = await decryptWithCode(sealed, salt, oneTimeCode);
    expect(decrypted).not.toBeNull();
    const bundle = JSON.parse(decrypted!) as CredentialBundle;
    expect(bundle.github.token).toBe("ghp_SECRET_GITHUB_TOKEN");
    expect(bundle.jira).toEqual({
      authMethod: "token",
      sealedApiToken: bigSealed,
      email: "user@example.com",
      cloudId: "cloud-2",
      siteUrl: "https://token.atlassian.net",
      siteName: "TokenSite",
    });
  });
});

// ── Task 6: resolveImportedCredentials ────────────────────────────────────────

describe("resolveImportedCredentials", () => {
  const bundle: CredentialBundle = { github: { token: "ghp_valid_token", method: "pat" }, jira: null };

  async function makeCiphertext(code: string) {
    return encryptWithCode(JSON.stringify(bundle), code);
  }

  it("wrong code and corrupted ciphertext both surface the SAME generic message", async () => {
    const code = generateOneTimeCode();
    const { ciphertext, salt } = await makeCiphertext(code);

    const wrong = await resolveImportedCredentials(ciphertext, salt, generateOneTimeCode());
    const corrupted = await resolveImportedCredentials("!!!not-base64-cipher!!!", salt, code);
    expect(wrong.ok).toBe(false);
    expect(corrupted.ok).toBe(false);
    if (!wrong.ok && !corrupted.ok) {
      expect(wrong.error).toBe(corrupted.error);
      expect(wrong.error).toMatch(/check the code and file match/i);
    }
  });

  it("retries against the SAME cached ciphertext (wrong then correct) with no additional network unseal", async () => {
    const code = generateOneTimeCode();
    const { ciphertext, salt } = await makeCiphertext(code);
    const unsealSpy = vi.spyOn(proxyLib, "unsealCredentialBundle");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ login: "u", avatar_url: "a", name: "N" }) }));

    const first = await resolveImportedCredentials(ciphertext, salt, generateOneTimeCode());
    expect(first.ok).toBe(false);
    const second = await resolveImportedCredentials(ciphertext, salt, code);
    expect(second.ok).toBe(true);
    expect(unsealSpy).not.toHaveBeenCalled(); // pure local decrypt — never re-unseals
  });

  it("a revoked GitHub token (401) surfaces the distinct revoked-credential message", async () => {
    const code = generateOneTimeCode();
    const { ciphertext, salt } = await makeCiphertext(code);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }));
    const res = await resolveImportedCredentials(ciphertext, salt, code);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no longer valid|revoked/i);
  });

  it("a /user network failure surfaces the SAME message as the 401 case", async () => {
    const code = generateOneTimeCode();
    const { ciphertext, salt } = await makeCiphertext(code);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }));
    const revoked = await resolveImportedCredentials(ciphertext, salt, code);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    const offline = await resolveImportedCredentials(ciphertext, salt, code);
    expect(revoked.ok).toBe(false);
    expect(offline.ok).toBe(false);
    if (!revoked.ok && !offline.ok) expect(offline.error).toBe(revoked.error);
  });

  it("valid ciphertext + correct code resolves the full GitHubUser and mutates nothing", async () => {
    const code = generateOneTimeCode();
    const { ciphertext, salt } = await makeCiphertext(code);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ login: "octocat", avatar_url: "https://avatars/oct", name: "Octo" }),
    }));
    const setConfigSpy = vi.spyOn(configStore, "setConfig");
    const setAuthSpy = vi.spyOn(authStore, "setAuthFromCredential");

    const res = await resolveImportedCredentials(ciphertext, salt, code);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.identity).toEqual({ login: "octocat", avatar_url: "https://avatars/oct", name: "Octo" });
      expect(res.bundle).toEqual(bundle);
    }
    expect(setConfigSpy).not.toHaveBeenCalled();
    expect(setAuthSpy).not.toHaveBeenCalled();
  });

  it("QA-002: the /user identity check sends the standard GitHub API headers", async () => {
    const code = generateOneTimeCode();
    const { ciphertext, salt } = await makeCiphertext(code);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ login: "u", avatar_url: "a", name: "N" }) });
    vi.stubGlobal("fetch", fetchMock);
    await resolveImportedCredentials(ciphertext, salt, code);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Accept).toBe("application/vnd.github+json");
    expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
    expect(headers.Authorization).toBe("Bearer ghp_valid_token");
  });

  it("SEC-002: a bundle with a malformed jira.siteUrl fails resolution before any /user call", async () => {
    // The tightened CredentialBundleSchema (siteUrl .url(), cloudId/siteName
    // .min(1)) rejects at import via the generic decrypt-failure path, instead of
    // importing + working in-session then silently vanishing on the next reload
    // when the stricter JiraAuthStateSchema rejects it.
    const code = generateOneTimeCode();
    const malformed = {
      github: { token: "ghp_valid_token", method: "pat" },
      jira: { authMethod: "token", sealedApiToken: "s", email: "e@e.com", cloudId: "c", siteUrl: "not-a-url", siteName: "S" },
    };
    const { ciphertext, salt } = await encryptWithCode(JSON.stringify(malformed), code);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await resolveImportedCredentials(ciphertext, salt, code);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/check the code and file match/i);
    expect(fetchMock).not.toHaveBeenCalled(); // schema fails before the identity check
  });

  it("R-001: surfaces the secure-context precondition distinctly on the decrypt path", async () => {
    const code = generateOneTimeCode();
    const { ciphertext, salt } = await makeCiphertext(code); // build BEFORE stubbing crypto
    const realCrypto = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: realCrypto.getRandomValues.bind(realCrypto) }); // no .subtle
    const res = await resolveImportedCredentials(ciphertext, salt, code);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/secure context/i);
  });
});

// ── Task 6: commitImportedSettings ────────────────────────────────────────────

describe("commitImportedSettings", () => {
  const identity = { login: "newuser", avatar_url: "https://avatars/new", name: "New User" };

  beforeEach(() => {
    localStorage.clear();
    vi.mocked(cacheStore.clearCache).mockResolvedValue(undefined);
    authStore.clearAuth(); // clean baseline: token/user null, config/view reset
  });

  it("setAuthFromCredential is the same reference as setAuthFromPat (alias not drifted)", () => {
    expect(authStore.setAuthFromCredential).toBe(authStore.setAuthFromPat);
  });

  it("commits identity strictly before config for a PAT bundle", async () => {
    vi.spyOn(authStore, "user").mockReturnValue(identity);
    const order: string[] = [];
    vi.spyOn(authStore, "setAuthFromCredential").mockImplementation(() => { order.push("auth"); });
    vi.spyOn(configStore, "setConfig").mockImplementation(() => { order.push("config"); });
    const res = await commitImportedSettings(
      { bundle: { github: { token: "ghp_x", method: "pat" }, jira: null }, identity },
      ConfigSchema.parse({ authMethod: "pat" })
    );
    expect(order).toEqual(["auth", "config"]);
    expect(res.jiraRestored).toBe(true);
  });

  it("commits identity strictly before config for an OAuth bundle", async () => {
    vi.spyOn(authStore, "user").mockReturnValue(identity);
    const order: string[] = [];
    vi.spyOn(authStore, "setAuthFromCredential").mockImplementation(() => { order.push("auth"); });
    vi.spyOn(configStore, "setConfig").mockImplementation(() => { order.push("config"); });
    vi.spyOn(authStore, "setJiraAuth").mockImplementation(() => {});
    const res = await commitImportedSettings(
      { bundle: { github: { token: "gho_x", method: "oauth" }, jira: null }, identity },
      ConfigSchema.parse({ authMethod: "oauth" })
    );
    expect(order).toEqual(["auth", "config"]);
    expect(res.jiraRestored).toBe(true);
  });

  it("final config.authMethod matches importedConfig (not the transient 'pat' setAuthFromPat sets)", async () => {
    // Real setAuthFromCredential + setConfig; seed user() to the same login so no
    // heavy cascade runs, then assert setConfig's oauth authMethod wins over the
    // transient "pat" write.
    vi.spyOn(authStore, "user").mockReturnValue(identity);
    await commitImportedSettings(
      { bundle: { github: { token: "gho_x", method: "oauth" }, jira: null }, identity },
      ConfigSchema.parse({ authMethod: "oauth" })
    );
    expect(config.authMethod).toBe("oauth");
  });

  it("Jira token-mode: setJiraAuth with sealedApiToken sentinels and zero network calls", async () => {
    vi.spyOn(authStore, "user").mockReturnValue(identity);
    vi.spyOn(authStore, "setAuthFromCredential").mockImplementation(() => {});
    vi.spyOn(configStore, "setConfig").mockImplementation(() => {});
    const jiraSpy = vi.spyOn(authStore, "setJiraAuth").mockImplementation(() => {});
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await commitImportedSettings(
      {
        bundle: {
          github: { token: "ghp_x", method: "pat" },
          jira: { authMethod: "token", sealedApiToken: "SEALED-API", email: "e@e.com", cloudId: "c", siteUrl: "https://s.atlassian.net", siteName: "S" },
        },
        identity,
      },
      ConfigSchema.parse({})
    );
    expect(jiraSpy).toHaveBeenCalledWith({
      accessToken: "SEALED-API",
      sealedRefreshToken: "",
      expiresAt: Number.MAX_SAFE_INTEGER,
      cloudId: "c",
      siteUrl: "https://s.atlassian.net",
      siteName: "S",
      email: "e@e.com",
    });
    expect(res.jiraRestored).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Jira oauth-mode: refresh (snake_case body + X-Requested-With) then setJiraAuth with computed shape", async () => {
    vi.spyOn(authStore, "user").mockReturnValue(identity);
    vi.spyOn(authStore, "setAuthFromCredential").mockImplementation(() => {});
    vi.spyOn(configStore, "setConfig").mockImplementation(() => {});
    const jiraSpy = vi.spyOn(authStore, "setJiraAuth").mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "NEW-ACCESS", sealed_refresh_token: "NEW-SEALED-RT", expires_in: 3600 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const res = await commitImportedSettings(
      {
        bundle: {
          github: { token: "gho_x", method: "oauth" },
          jira: { authMethod: "oauth", sealedRefreshToken: "OLD-SEALED-RT", cloudId: "c", siteUrl: "https://s.atlassian.net", siteName: "S" },
        },
        identity,
      },
      ConfigSchema.parse({})
    );
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/oauth/jira/refresh");
    expect(JSON.parse(init.body as string)).toEqual({ sealed_refresh_token: "OLD-SEALED-RT" });
    expect((init.headers as Record<string, string>)["X-Requested-With"]).toBe("fetch");
    expect(jiraSpy).toHaveBeenCalledWith({
      accessToken: "NEW-ACCESS",
      sealedRefreshToken: "NEW-SEALED-RT",
      expiresAt: 1_000_000 + 3600 * 1000,
      cloudId: "c",
      siteUrl: "https://s.atlassian.net",
      siteName: "S",
    });
    expect(res.jiraRestored).toBe(true);
  });

  it("Jira oauth refresh failure: warning + jiraRestored:false, no throw, GitHub identity/config not rolled back", async () => {
    vi.spyOn(authStore, "user").mockReturnValue(identity);
    const authSpy = vi.spyOn(authStore, "setAuthFromCredential").mockImplementation(() => {});
    const cfgSpy = vi.spyOn(configStore, "setConfig").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }));
    const notifySpy = vi.spyOn(errorsLib, "pushNotification").mockImplementation(() => {});
    const res = await commitImportedSettings(
      {
        bundle: {
          github: { token: "gho_x", method: "oauth" },
          jira: { authMethod: "oauth", sealedRefreshToken: "OLD-SEALED-RT", cloudId: "c", siteUrl: "https://s.atlassian.net", siteName: "S" },
        },
        identity,
      },
      ConfigSchema.parse({})
    );
    expect(res.jiraRestored).toBe(false);
    expect(notifySpy).toHaveBeenCalledWith("settings-import-jira", expect.stringMatching(/reconnect/i), "warning");
    expect(authSpy).toHaveBeenCalled();
    expect(cfgSpy).toHaveBeenCalled();
  });

  it("pre-auth (a0): awaits clearIdentityData (real clearCache) before setAuthFromCredential/setConfig (SD-001)", async () => {
    vi.spyOn(authStore, "user").mockReturnValue(null); // pre-auth
    let resolveClear!: () => void;
    vi.mocked(cacheStore.clearCache).mockReturnValue(new Promise<void>((r) => { resolveClear = () => r(); }));
    const order: string[] = [];
    vi.spyOn(authStore, "setAuthFromCredential").mockImplementation(() => { order.push("auth"); });
    vi.spyOn(configStore, "setConfig").mockImplementation(() => { order.push("config"); });

    const p = commitImportedSettings(
      { bundle: { github: { token: "ghp_x", method: "pat" }, jira: null }, identity },
      ConfigSchema.parse({})
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual([]); // blocked on the un-resolved clearCache
    resolveClear();
    await p;
    expect(order).toEqual(["auth", "config"]); // established only after the await
  });

  it("identity-switch integration: REAL cascade replaces config/view/jira and persists imported config", async () => {
    vi.spyOn(errorsLib, "pushNotification").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn());

    // Seed a prior, different identity + distinguishable per-identity state.
    authStore.setAuthFromPat("ghp_old", { login: "olduser", avatar_url: "https://a/old", name: "Old" });
    setConfig(ConfigSchema.parse({ selectedOrgs: ["prior-org"], theme: "dark" }));
    updateViewState({ lastActiveTab: "actions" });
    authStore.setJiraAuth({
      accessToken: "old-access",
      sealedRefreshToken: "",
      expiresAt: Number.MAX_SAFE_INTEGER,
      cloudId: "old-cloud",
      siteUrl: "https://old.atlassian.net",
      siteName: "Old",
      email: "old@e.com",
    });

    let dispose!: () => void;
    createRoot((d) => { dispose = d; initConfigPersistence(); });

    const importedConfig = ConfigSchema.parse({ selectedOrgs: ["new-org"], theme: "light", authMethod: "oauth" });
    const bundle: CredentialBundle = {
      github: { token: "ghp_new", method: "oauth" },
      jira: { authMethod: "token", sealedApiToken: "new-sealed-api", email: "new@e.com", cloudId: "new-cloud", siteUrl: "https://new.atlassian.net", siteName: "New" },
    };

    await commitImportedSettings({ bundle, identity: { login: "newuser", avatar_url: "https://a/new", name: "New" } }, importedConfig);

    // (1) config deep-equals importedConfig (no prior-identity leftovers, no transient defaults)
    expect(JSON.parse(JSON.stringify(config))).toEqual(importedConfig);
    // (2) viewState reset to defaults
    expect(viewState.lastActiveTab).toBe("issues");
    // (3) Jira auth matches the imported bundle (cascade cleared it; setJiraAuth restored it)
    expect(authStore.jiraAuth()).toEqual({
      accessToken: "new-sealed-api",
      sealedRefreshToken: "",
      expiresAt: Number.MAX_SAFE_INTEGER,
      cloudId: "new-cloud",
      siteUrl: "https://new.atlassian.net",
      siteName: "New",
      email: "new@e.com",
    });
    // (4) localStorage CONFIG persisted with the imported config after the 200ms debounce
    await new Promise((r) => setTimeout(r, 250));
    expect(JSON.parse(localStorage.getItem(CONFIG_STORAGE_KEY)!)).toEqual(importedConfig);
    dispose();
  });

  it("STRUCT-I-002: a non-positive expires_in yields a sane future expiresAt (default 3600s), not past/NaN", async () => {
    vi.spyOn(authStore, "user").mockReturnValue(identity);
    vi.spyOn(authStore, "setAuthFromCredential").mockImplementation(() => {});
    vi.spyOn(configStore, "setConfig").mockImplementation(() => {});
    const jiraSpy = vi.spyOn(authStore, "setJiraAuth").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "A", sealed_refresh_token: "RT", expires_in: 0 }),
    }));
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    await commitImportedSettings(
      {
        bundle: {
          github: { token: "gho_x", method: "oauth" },
          jira: { authMethod: "oauth", sealedRefreshToken: "OLD", cloudId: "c", siteUrl: "https://s.atlassian.net", siteName: "S" },
        },
        identity,
      },
      ConfigSchema.parse({})
    );
    const state = jiraSpy.mock.calls[0][0];
    expect(state.expiresAt).toBe(1_000_000 + 3600 * 1000); // clamped to the 3600s default
    expect(Number.isNaN(state.expiresAt)).toBe(false);
  });

  it("STRUCT-I-003: aligns the imported config's jira.authMethod with the tamper-proof bundle authMethod", async () => {
    vi.spyOn(authStore, "user").mockReturnValue(identity);
    vi.spyOn(authStore, "setAuthFromCredential").mockImplementation(() => {});
    vi.spyOn(authStore, "setJiraAuth").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn());
    const cfgSpy = vi.spyOn(configStore, "setConfig").mockImplementation(() => {});
    // Plaintext config claims OAuth, but the sealed bundle is token-mode → the
    // committed config must follow the bundle so runtime Jira branching matches
    // the restored credential shape.
    const importedConfig = ConfigSchema.parse({ jira: { enabled: true, authMethod: "oauth" } });
    await commitImportedSettings(
      {
        bundle: {
          github: { token: "ghp_x", method: "pat" },
          jira: { authMethod: "token", sealedApiToken: "SA", email: "e@e.com", cloudId: "c", siteUrl: "https://s.atlassian.net", siteName: "S" },
        },
        identity,
      },
      importedConfig
    );
    const committed = cfgSpy.mock.calls[0][0] as { jira: { authMethod: string } };
    expect(committed.jira.authMethod).toBe("token");
  });

  it("QA-003: OAuth-Jira identity-switch (REAL cascade) — final jiraAuth reflects the refreshed token, not the cascade-cleared null", async () => {
    vi.spyOn(errorsLib, "pushNotification").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "REFRESHED-ACCESS", sealed_refresh_token: "NEW-RT", expires_in: 3600 }),
    }));

    // Seed a prior, DIFFERENT identity + a prior Jira auth blob so the real
    // setAuthFromCredential identity-switch cascade runs (and clears jiraAuth).
    authStore.setAuthFromPat("ghp_old", { login: "olduser", avatar_url: "https://a/old", name: "Old" });
    authStore.setJiraAuth({
      accessToken: "old-access",
      sealedRefreshToken: "old-rt",
      expiresAt: Number.MAX_SAFE_INTEGER,
      cloudId: "old-cloud",
      siteUrl: "https://old.atlassian.net",
      siteName: "Old",
    });

    vi.spyOn(Date, "now").mockReturnValue(2_000_000);
    const importedConfig = ConfigSchema.parse({ authMethod: "oauth", jira: { enabled: true, authMethod: "oauth" } });
    const bundle: CredentialBundle = {
      github: { token: "gho_new", method: "oauth" },
      jira: { authMethod: "oauth", sealedRefreshToken: "EXPORTED-RT", cloudId: "new-cloud", siteUrl: "https://new.atlassian.net", siteName: "New" },
    };

    const res = await commitImportedSettings(
      { bundle, identity: { login: "newuser", avatar_url: "https://a/new", name: "New" } },
      importedConfig
    );

    expect(res.jiraRestored).toBe(true);
    // The cascade nulled jiraAuth; the OAuth refresh restored it with the minted token.
    expect(authStore.jiraAuth()).toEqual({
      accessToken: "REFRESHED-ACCESS",
      sealedRefreshToken: "NEW-RT",
      expiresAt: 2_000_000 + 3600 * 1000,
      cloudId: "new-cloud",
      siteUrl: "https://new.atlassian.net",
      siteName: "New",
    });
  });
});

// ── Task 7: hasExistingLocalConfig (Login-page confirmation-skip detector) ─────

describe("hasExistingLocalConfig", () => {
  it("returns false for a default/empty config (fresh browser / incognito)", () => {
    const cfg = ConfigSchema.parse({});
    expect(cfg.onboardingComplete).toBe(false);
    expect(cfg.selectedRepos).toEqual([]);
    expect(cfg.selectedOrgs).toEqual([]);
    expect(hasExistingLocalConfig(cfg)).toBe(false);
  });

  it("returns true when onboardingComplete is true even with empty repo/org arrays", () => {
    const cfg = ConfigSchema.parse({ onboardingComplete: true });
    expect(cfg.selectedRepos).toEqual([]);
    expect(cfg.selectedOrgs).toEqual([]);
    expect(hasExistingLocalConfig(cfg)).toBe(true);
  });

  it("returns true for non-empty selectedRepos even when onboardingComplete is false", () => {
    const cfg = ConfigSchema.parse({
      onboardingComplete: false,
      selectedRepos: [{ owner: "acme", name: "api", fullName: "acme/api" }],
    });
    expect(cfg.onboardingComplete).toBe(false);
    expect(hasExistingLocalConfig(cfg)).toBe(true);
  });

  it("returns true for non-empty selectedOrgs even when onboardingComplete is false", () => {
    const cfg = ConfigSchema.parse({ onboardingComplete: false, selectedOrgs: ["acme"] });
    expect(hasExistingLocalConfig(cfg)).toBe(true);
  });
});
