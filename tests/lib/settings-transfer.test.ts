import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { z } from "zod";

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
  EXPORTED_VIEW_PREF_KEYS,
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
import {
  viewState,
  updateViewState,
  resetViewState,
  ViewStateSchema,
  TrackedItemSchema,
  IgnoredItemSchema,
  applyImportedViewState,
} from "../../src/app/stores/view";
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

// Same workflow as EXPECTED_CONFIG_KEYS/EXPECTED_JIRA_KEYS above, for the
// _viewPreferences export section. A top-level ViewStateSchema key change
// forces a decision: add it to EXPORTED_VIEW_PREF_KEYS (durable, non-transient,
// non-privacy-sensitive) or leave it excluded like lastActiveTab/globalSort/
// globalFilter. A TrackedItemSchema/IgnoredItemSchema field change forces the
// same decision for the per-entry keep-lists (TRACKED_ITEM_EXPORT_KEEP_LIST /
// IGNORED_ITEM_EXPORT_KEEP_LIST in settings-transfer.ts) — an allowlist, so an
// added field is excluded by default until consciously added.
const EXPECTED_VIEW_STATE_KEYS = [
  "customTabFilters",
  "dependencyExpandedGroups",
  "expandedRepos",
  "globalFilter",
  "globalSort",
  "hideDepDashboard",
  "ignoredItems",
  "jiraCustomOrder",
  "lastActiveTab",
  "lockedRepos",
  "showPrRuns",
  "tabFilters",
  "trackedItems",
];

const EXPECTED_TRACKED_ITEM_KEYS = [
  "addedAt",
  "htmlUrl",
  "id",
  "jiraKey",
  "jiraProjectKey",
  "jiraStatus",
  "number",
  "repoFullName",
  "source",
  "title",
  "type",
];

const EXPECTED_IGNORED_ITEM_KEYS = ["id", "ignoredAt", "repo", "title", "type"];

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

  it("ViewStateSchema top-level shape matches the _viewPreferences allowlist snapshot", () => {
    const actual = Object.keys(ViewStateSchema.shape).sort();
    const { added, removed } = diffKeys(actual, EXPECTED_VIEW_STATE_KEYS);
    expect(
      added.length === 0 && removed.length === 0,
      `ViewStateSchema top-level keys changed (added: [${added.join(", ")}], removed: [${removed.join(", ")}]). ` +
        "Before updating EXPECTED_VIEW_STATE_KEYS, decide whether an ADDED key belongs in " +
        "EXPORTED_VIEW_PREF_KEYS (src/app/lib/settings-transfer.ts) — durable, non-transient, " +
        "non-privacy-sensitive view state — or should stay excluded like lastActiveTab/globalSort/globalFilter."
    ).toBe(true);
  });

  it("TrackedItemSchema shape matches the trackedItems export keep-list snapshot", () => {
    const actual = Object.keys(TrackedItemSchema.shape).sort();
    const { added, removed } = diffKeys(actual, EXPECTED_TRACKED_ITEM_KEYS);
    expect(
      added.length === 0 && removed.length === 0,
      `TrackedItemSchema keys changed (added: [${added.join(", ")}], removed: [${removed.join(", ")}]). ` +
        "Before updating EXPECTED_TRACKED_ITEM_KEYS, decide whether an ADDED field is reference-only " +
        "(safe to add to TRACKED_ITEM_EXPORT_KEEP_LIST in settings-transfer.ts) or content/PII-adjacent " +
        "(must stay excluded, like title/htmlUrl/jiraStatus)."
    ).toBe(true);
  });

  it("IgnoredItemSchema shape matches the ignoredItems export keep-list snapshot", () => {
    const actual = Object.keys(IgnoredItemSchema.shape).sort();
    const { added, removed } = diffKeys(actual, EXPECTED_IGNORED_ITEM_KEYS);
    expect(
      added.length === 0 && removed.length === 0,
      `IgnoredItemSchema keys changed (added: [${added.join(", ")}], removed: [${removed.join(", ")}]). ` +
        "Before updating EXPECTED_IGNORED_ITEM_KEYS, decide whether an ADDED field is reference-only " +
        "(safe to add to IGNORED_ITEM_EXPORT_KEEP_LIST in settings-transfer.ts) or content (must stay " +
        "excluded, like title)."
    ).toBe(true);
  });
});

describe("buildExportPayload", () => {
  it("omits denylisted jira.email while keeping the rest of the jira object", () => {
    const cfg = ConfigSchema.parse({
      jira: { enabled: true, email: "secret@example.com", cloudId: "cloud-123" },
    });
    expect(cfg.jira.email).toBe("secret@example.com");

    const out = buildExportPayload(cfg, viewState);
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
    const out = buildExportPayload(ConfigSchema.parse({}), viewState);
    expect(out._exportVersion).toBe(EXPORT_VERSION);
    expect(out._exportVersion).toBe(1);
  });

  it("includes fields absent from the old hand-maintained export list (proves the spread mechanism)", () => {
    // onboardingComplete + mcpRelayEnabled exist in ConfigSchema but were NEVER
    // in SettingsPage.tsx's pre-refactor object literal — their presence is the
    // assertion that actually distinguishes a schema-driven rewrite from a
    // leftover manual literal.
    const out = buildExportPayload(ConfigSchema.parse({}), viewState);
    expect(Object.prototype.hasOwnProperty.call(out, "onboardingComplete")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(out, "mcpRelayEnabled")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(out, "mcpRelayPort")).toBe(true);
  });
});

// ── curated, privacy-scrubbed view preferences ────────────────────────────────

describe("buildExportPayload — _viewPreferences", () => {
  // viewState is a module-level singleton shared across this whole test file —
  // reset it before AND after so these tests neither inherit nor leak state.
  beforeEach(() => resetViewState());
  afterEach(() => resetViewState());

  it("includes _viewPreferences with EXACTLY the curated top-level key set", () => {
    const out = buildExportPayload(ConfigSchema.parse({}), viewState);
    const prefs = out._viewPreferences as Record<string, unknown>;
    expect(prefs).toBeDefined();
    expect(Object.keys(prefs).sort()).toEqual([...EXPORTED_VIEW_PREF_KEYS].sort());
  });

  it("excludes the transient/privacy keys: lastActiveTab, globalSort, globalFilter", () => {
    const out = buildExportPayload(ConfigSchema.parse({}), viewState);
    const prefs = out._viewPreferences as Record<string, unknown>;
    expect("lastActiveTab" in prefs).toBe(false);
    expect("globalSort" in prefs).toBe(false);
    expect("globalFilter" in prefs).toBe(false);
  });

  it("carries a non-item durable preference through unmodified (jiraCustomOrder)", () => {
    updateViewState({ jiraCustomOrder: ["PROJ-1", "PROJ-2"] });
    const out = buildExportPayload(ConfigSchema.parse({}), viewState);
    const prefs = out._viewPreferences as Record<string, unknown>;
    expect(prefs.jiraCustomOrder).toEqual(["PROJ-1", "PROJ-2"]);
  });

  it("scrubs ignoredItems entries to the reference-field allowlist — no title", () => {
    updateViewState({
      ignoredItems: [
        { id: 1, type: "issue", repo: "org/repo", title: "Secret issue title", ignoredAt: 1000 },
      ],
    });
    const out = buildExportPayload(ConfigSchema.parse({}), viewState);
    const prefs = out._viewPreferences as Record<string, unknown>;
    const entries = prefs.ignoredItems as Record<string, unknown>[];
    expect(entries).toHaveLength(1);
    expect(Object.keys(entries[0]).sort()).toEqual(["id", "ignoredAt", "repo", "type"]);
    expect("title" in entries[0]).toBe(false);
    expect(entries[0]).toMatchObject({ id: 1, type: "issue", repo: "org/repo", ignoredAt: 1000 });
  });

  it("scrubs trackedItems entries to the reference-field allowlist — no title, htmlUrl, or jiraStatus", () => {
    updateViewState({
      trackedItems: [
        {
          id: 2,
          number: 42,
          type: "issue",
          source: "github",
          repoFullName: "org/repo",
          title: "Secret issue title",
          addedAt: 2000,
          htmlUrl: "https://github.com/org/repo/issues/42",
        },
        {
          id: 3,
          type: "jiraIssue",
          source: "jira",
          repoFullName: "",
          title: "Secret jira summary",
          addedAt: 3000,
          jiraKey: "PROJ-123",
          jiraProjectKey: "PROJ",
          jiraStatus: "In Progress",
        },
      ],
    });
    const out = buildExportPayload(ConfigSchema.parse({}), viewState);
    const prefs = out._viewPreferences as Record<string, unknown>;
    const entries = prefs.trackedItems as Record<string, unknown>[];
    expect(entries).toHaveLength(2);

    for (const entry of entries) {
      expect("title" in entry).toBe(false);
      expect("htmlUrl" in entry).toBe(false);
      expect("jiraStatus" in entry).toBe(false);
    }
    expect(entries[0]).toMatchObject({ id: 2, number: 42, type: "issue", source: "github", repoFullName: "org/repo", addedAt: 2000 });
    expect(entries[1]).toMatchObject({ id: 3, type: "jiraIssue", source: "jira", jiraKey: "PROJ-123", jiraProjectKey: "PROJ", addedAt: 3000 });
  });
});

describe("parseImportFile", () => {
  it("parses a valid export payload produced by buildExportPayload", () => {
    const payload = buildExportPayload(ConfigSchema.parse({ theme: "dark", itemsPerPage: 50 }), viewState);
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

  it("rejects a file stamped with a NEWER export version, with a clear message", () => {
    const result = parseImportFile(JSON.stringify({ _exportVersion: 2, theme: "dark" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/newer version/i);
  });

  it("accepts version 1 and a missing _exportVersion (treated as v1)", () => {
    expect(parseImportFile(JSON.stringify({ _exportVersion: 1, theme: "dark" })).ok).toBe(true);
    expect(parseImportFile(JSON.stringify({ theme: "dark" })).ok).toBe(true);
    // A round-tripped real export (stamped v1 by buildExportPayload) also parses.
    expect(parseImportFile(JSON.stringify(buildExportPayload(ConfigSchema.parse({}), viewState))).ok).toBe(true);
  });
});

// ── client-side envelope encryption ──────────────────────────────────────────

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

// Known-answer vectors for the Crockford codec. The round-trip test above
// cross-checks decodeOneTimeCode against a SECOND encoder (crockfordEncode)
// that implements the identical algorithm — a divergence guard, catching the
// two implementations disagreeing, but NOT a true anchor: if both encode and
// decode independently flipped the same bit-packing detail (shift direction,
// alphabet index order, etc.) the round-trip test would still pass. These two
// vectors are literal, hand-computed expected values for both directions
// (decode a known string -> known bytes, AND encode known bytes -> known
// string), verified against the documented bit-packing: 16 bytes -> a 128-bit
// big-endian integer -> left-shift 2 bits (128 -> 130 bits, 26 * 5) -> 26
// base32 digits emitted MSB-first from alphabet "0123456789ABCDEFGHJKMNPQRSTVWXYZ".
describe("generateOneTimeCode / decodeOneTimeCode — known-answer vectors", () => {
  it("KAV-1: all-zero 16 bytes <-> \"0000-0000-0000-0000-0000-0000-00\"", () => {
    // All-zero input -> value 0 -> <<2 is still 0 -> every one of the 26
    // 5-bit groups is 0b00000 -> alphabet[0] = '0', 26 times.
    const zeroBytes = new Uint8Array(16);
    const code = "0000-0000-0000-0000-0000-0000-00";

    // Decode direction: a hand-picked string decodes to the hand-picked bytes.
    expect(Array.from(decodeOneTimeCode(code))).toEqual(Array.from(zeroBytes));

    // Encode+format direction: generateOneTimeCode's only entropy source is
    // crypto.getRandomValues, so pinning it to the known vector anchors the
    // encode + dash-formatting path without needing the private encoder.
    vi.spyOn(crypto, "getRandomValues").mockImplementation(((arr: Uint8Array) => {
      arr.set(zeroBytes);
      return arr;
    }) as typeof crypto.getRandomValues);
    expect(generateOneTimeCode()).toBe(code);
  });

  it("KAV-2: all-0xFF 16 bytes <-> \"ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZW\" (non-trivial vector)", () => {
    // Hand derivation: 16 bytes of 0xFF is a 128-bit integer of all 1s.
    // <<2 (multiply by 4) produces a 130-bit integer: the top 128 bits stay
    // 1, and two 0 bits are appended at the LSB end. Splitting into 26
    // groups of 5 bits MSB-first: the first 25 groups (125 bits) fall
    // entirely within the all-1s region, so each is 0b11111 = 31 = 'Z'
    // (the alphabet's last character). The 26th (final) group covers the
    // remaining 5 bits: the last three original 1-bits followed by the two
    // appended 0-bits = 0b11100 = 28 = 'W'.
    const ffBytes = new Uint8Array(16).fill(0xff);
    const code = "ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZW";

    expect(Array.from(decodeOneTimeCode(code))).toEqual(Array.from(ffBytes));

    vi.spyOn(crypto, "getRandomValues").mockImplementation(((arr: Uint8Array) => {
      arr.set(ffBytes);
      return arr;
    }) as typeof crypto.getRandomValues);
    expect(generateOneTimeCode()).toBe(code);
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

// ── assemble credential bundle ────────────────────────────────────────────────

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

// ── proxy credential seal/unseal helpers ──────────────────────────────────────

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

describe("proxy — sealCredentialBundle / unsealCredentialBundle", () => {
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

// ── buildEncryptedCredentialsSection (encrypt-then-seal) ───────────────────────

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

// ── resolveImportedCredentials ────────────────────────────────────────────────

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

// ── commitImportedSettings ────────────────────────────────────────────────────

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

  it("pre-auth import resets transient view keys that setAuthFromCredential's (inert) identity-switch cascade would otherwise leave stale", async () => {
    // Seed a prior session's transient view state, as if a token expired on this
    // browser while these were set — NOT part of the curated export/import set,
    // so setConfig/applyImportedViewState alone would never touch them.
    updateViewState({
      lastActiveTab: "actions",
      globalSort: { field: "title", direction: "asc" },
      globalFilter: { org: "prior-org", repo: "prior-repo" },
    });

    vi.spyOn(authStore, "user").mockReturnValue(null); // pre-auth (Login-page import path)

    await commitImportedSettings(
      { bundle: { github: { token: "ghp_x", method: "pat" }, jira: null }, identity },
      ConfigSchema.parse({}),
      { jiraCustomOrder: ["NEW-1"] } // a curated key, to prove it's still applied post-reset
    );

    // Transient/non-curated keys reset to defaults — no bleed from the prior session.
    expect(viewState.lastActiveTab).toBe("issues");
    expect(viewState.globalSort).toEqual({ field: "updatedAt", direction: "desc" });
    expect(viewState.globalFilter).toEqual({ org: null, repo: null });
    // The curated key from the import is still applied AFTER the reset.
    expect(viewState.jiraCustomOrder).toEqual(["NEW-1"]);
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

  it("a non-positive expires_in yields a sane future expiresAt (default 3600s), not past/NaN", async () => {
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

  it("aligns the imported config's jira.authMethod with the tamper-proof bundle authMethod", async () => {
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

// ── full export -> import round-trip for view preferences ─────────────────────

describe("commitImportedSettings — view preferences round-trip", () => {
  const identity = { login: "newuser", avatar_url: "https://avatars/new", name: "New User" };

  beforeEach(() => {
    localStorage.clear();
    vi.mocked(cacheStore.clearCache).mockResolvedValue(undefined);
    authStore.clearAuth(); // clean baseline: token/user null, config/view reset
  });

  it("restores every curated view preference and scrubs item content, leaving transient keys at their post-import defaults", async () => {
    // ── Arrange: one non-default value per curated key, on the "exporting" side.
    updateViewState({
      jiraCustomOrder: ["PROJ-1", "PROJ-2"],
      expandedRepos: { issues: { "org/repo": true }, pullRequests: {}, actions: {}, jiraAssigned: {} },
      lockedRepos: { issues: ["org/locked"], pullRequests: [], actions: [], jiraAssigned: [] },
      tabFilters: {
        issues: { scope: "all", role: "author", comments: "has", user: "someone" },
        pullRequests: { scope: "involves_me", role: "all", reviewDecision: "all", draft: "all", checkStatus: "all", sizeCategory: "all", user: "all" },
        actions: { conclusion: "all", event: "all" },
        jiraAssigned: { scope: "assigned", statusCategory: "all", priority: "all", sortField: "custom", sortDirection: "asc" },
        dependencies: { updateType: "all", bot: "all" },
      },
      customTabFilters: { "custom-1": { status: "open" } },
      dependencyExpandedGroups: ["major", "minor"],
      showPrRuns: true,
      hideDepDashboard: false,
      ignoredItems: [{ id: 1, type: "issue", repo: "org/repo", title: "Secret ignored title", ignoredAt: 1000 }],
      trackedItems: [
        { id: 2, number: 42, type: "issue", source: "github", repoFullName: "org/repo", title: "Secret tracked title", addedAt: 2000, htmlUrl: "https://github.com/org/repo/issues/42" },
      ],
      // Deliberately non-default so a leak of these excluded keys would be caught.
      lastActiveTab: "actions",
      globalSort: { field: "title", direction: "asc" },
      globalFilter: { org: "some-org", repo: "some-repo" },
    });

    const payload = buildExportPayload(ConfigSchema.parse({}), viewState);
    const fileText = JSON.stringify(payload);

    // ── Simulate importing on a fresh machine with no prior view state.
    resetViewState();
    expect(viewState.jiraCustomOrder).toEqual([]); // sanity: reset actually cleared it

    const parsed = parseImportFile(fileText);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const rawViewPreferences = (parsed.rawJson as Record<string, unknown>)._viewPreferences;

    // user() mocked to the SAME identity being "imported" so setAuthFromCredential's
    // identity-switch reset cascade doesn't fire and reset viewState out from under
    // this test's own assertions (mirrors the "commits identity strictly before
    // config" tests above).
    vi.spyOn(authStore, "user").mockReturnValue(identity);
    await commitImportedSettings(
      { bundle: { github: { token: "ghp_x", method: "pat" }, jira: null }, identity },
      parsed.config,
      rawViewPreferences
    );

    // ── Assert: every curated key restored...
    expect(viewState.jiraCustomOrder).toEqual(["PROJ-1", "PROJ-2"]);
    expect(viewState.expandedRepos.issues).toEqual({ "org/repo": true });
    expect(viewState.lockedRepos.issues).toEqual(["org/locked"]);
    expect(viewState.tabFilters.issues).toMatchObject({ scope: "all", role: "author", comments: "has", user: "someone" });
    expect(viewState.customTabFilters).toEqual({ "custom-1": { status: "open" } });
    expect(viewState.dependencyExpandedGroups).toEqual(["major", "minor"]);
    expect(viewState.showPrRuns).toBe(true);
    expect(viewState.hideDepDashboard).toBe(false);

    // ...ignored/tracked items restored as REFERENCES ONLY — title stripped on
    // export, defaulted back to "" on import (not the original secret content).
    expect(viewState.ignoredItems).toEqual([
      { id: 1, type: "issue", repo: "org/repo", ignoredAt: 1000, title: "" },
    ]);
    expect(viewState.trackedItems).toHaveLength(1);
    expect(viewState.trackedItems[0]).toMatchObject({
      id: 2, number: 42, type: "issue", source: "github", repoFullName: "org/repo", addedAt: 2000, title: "",
    });
    expect("htmlUrl" in viewState.trackedItems[0]).toBe(false);

    // ...while the excluded/transient keys stay at their POST-RESET defaults —
    // never restored, proving they were never in the export in the first place.
    expect(viewState.lastActiveTab).toBe("issues");
    expect(viewState.globalSort).toEqual({ field: "updatedAt", direction: "desc" });
    expect(viewState.globalFilter).toEqual({ org: null, repo: null });
  });
});

// ── import-side stripped-item backfill guard ──────────────────────────────────
//
// buildExportPayload strips ignoredItems/trackedItems down to
// TRACKED_ITEM_EXPORT_KEEP_LIST / IGNORED_ITEM_EXPORT_KEEP_LIST (allowlists,
// enforced by the schema-drift guard tests at the top of this file). The
// IMPORT side (applyImportedViewState -> coerceStrippedItemEntry, in
// src/app/stores/view.ts) only hardcodes backfilling ONE field: a missing
// `title` defaults to `""`. If a schema ever gains a new REQUIRED field that
// also gets left off the export keep-list, the stripped entry re-validates as
// invalid on import and the whole item is silently dropped (per-key
// safeParse in applyImportedViewState skips the whole array on one bad
// element). This test derives, for both item schemas, which required fields
// are actually stripped by the current keep-lists, then proves a
// stripped-then-reimported entry survives — so it fails loudly the moment a
// newly-required field is stripped without an accompanying coerce fix.
describe("import-side stripped-item backfill guard", () => {
  beforeEach(() => resetViewState());
  afterEach(() => resetViewState());

  /** Fields a schema requires — i.e. omitting them (passing `undefined`) fails validation. Optional/`.default()` fields pass `undefined` and are excluded. */
  function requiredKeys(shape: Record<string, z.ZodTypeAny>): string[] {
    return Object.keys(shape).filter((key) => !shape[key].safeParse(undefined).success);
  }

  it("TrackedItemSchema: every stripped-and-required field is backfilled on import (coerceStrippedItemEntry)", () => {
    // A full item populating every TrackedItemSchema field, so exporting it
    // reveals exactly which fields the CURRENT keep-list actually keeps.
    updateViewState({
      trackedItems: [
        {
          id: 1,
          number: 42,
          type: "issue",
          source: "github",
          repoFullName: "org/repo",
          title: "Secret title",
          addedAt: 1000,
          jiraKey: "PROJ-1",
          jiraProjectKey: "PROJ",
          jiraStatus: "In Progress",
          htmlUrl: "https://github.com/org/repo/issues/1",
        },
      ],
    });
    const exported = buildExportPayload(ConfigSchema.parse({}), viewState);
    const strippedEntries = (exported._viewPreferences as Record<string, unknown>)
      .trackedItems as Record<string, unknown>[];
    const kept = Object.keys(strippedEntries[0]);

    const required = requiredKeys(TrackedItemSchema.shape);
    const strippedRequired = required.filter((key) => !kept.includes(key));
    // Sanity: the guard is only meaningful if the current keep-list actually
    // strips at least one required field (it does — `title`).
    expect(strippedRequired.length).toBeGreaterThan(0);

    resetViewState();
    applyImportedViewState({ trackedItems: strippedEntries });
    const restored = viewState.trackedItems[0] as Record<string, unknown> | undefined;

    expect(
      restored !== undefined && TrackedItemSchema.safeParse(restored).success,
      `TrackedItemSchema field(s) [${strippedRequired.join(", ")}] are required, stripped by ` +
        "TRACKED_ITEM_EXPORT_KEEP_LIST (src/app/lib/settings-transfer.ts), but NOT backfilled by " +
        "coerceStrippedItemEntry (src/app/stores/view.ts) — the stripped import fails schema " +
        "validation and the whole item is silently dropped. Extend coerceStrippedItemEntry to " +
        "backfill the new field (or add it to the keep-list if it isn't actually PII/content)."
    ).toBe(true);
  });

  it("IgnoredItemSchema: every stripped-and-required field is backfilled on import (coerceStrippedItemEntry)", () => {
    updateViewState({
      ignoredItems: [{ id: 1, type: "issue", repo: "org/repo", title: "Secret title", ignoredAt: 1000 }],
    });
    const exported = buildExportPayload(ConfigSchema.parse({}), viewState);
    const strippedEntries = (exported._viewPreferences as Record<string, unknown>)
      .ignoredItems as Record<string, unknown>[];
    const kept = Object.keys(strippedEntries[0]);

    const required = requiredKeys(IgnoredItemSchema.shape);
    const strippedRequired = required.filter((key) => !kept.includes(key));
    expect(strippedRequired.length).toBeGreaterThan(0);

    resetViewState();
    applyImportedViewState({ ignoredItems: strippedEntries });
    const restored = viewState.ignoredItems[0] as Record<string, unknown> | undefined;

    expect(
      restored !== undefined && IgnoredItemSchema.safeParse(restored).success,
      `IgnoredItemSchema field(s) [${strippedRequired.join(", ")}] are required, stripped by ` +
        "IGNORED_ITEM_EXPORT_KEEP_LIST (src/app/lib/settings-transfer.ts), but NOT backfilled by " +
        "coerceStrippedItemEntry (src/app/stores/view.ts) — the stripped import fails schema " +
        "validation and the whole item is silently dropped. Extend coerceStrippedItemEntry to " +
        "backfill the new field (or add it to the keep-list if it isn't actually content)."
    ).toBe(true);
  });
});

// ── hasExistingLocalConfig (Login-page confirmation-skip detector) ─────────────

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
