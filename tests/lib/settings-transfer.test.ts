import { describe, it, expect, vi, afterEach } from "vitest";
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
} from "../../src/app/lib/settings-transfer";

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
});

// ── Task 4: client-side envelope encryption ──────────────────────────────────

const CODE_DISPLAY_RE = /^[0-9a-f]{4}(-[0-9a-f]{4}){7}$/;

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
  it("produces the display format (8 dash-separated groups of 4 hex chars)", () => {
    expect(generateOneTimeCode()).toMatch(CODE_DISPLAY_RE);
  });

  it("produces a different code on consecutive calls", () => {
    expect(generateOneTimeCode()).not.toBe(generateOneTimeCode());
  });

  it("round-trips: decodeOneTimeCode(generateOneTimeCode()) is the original 16 bytes", () => {
    const code = generateOneTimeCode();
    const bytes = decodeOneTimeCode(code);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(16);
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    expect(hex).toBe(code.replace(/-/g, "").toLowerCase());
  });

  it("normalizes a manually-perturbed code (uppercased, whitespace, dashes removed) to the same bytes", () => {
    const code = generateOneTimeCode();
    const original = decodeOneTimeCode(code);
    const perturbed = `  ${code.toUpperCase().replace(/-/g, "")}  `;
    expect(Array.from(decodeOneTimeCode(perturbed))).toEqual(Array.from(original));
  });
});

describe("deriveEnvelopeKey — secure-context guard", () => {
  it("rejects with the secure-context message when crypto.subtle is unavailable", async () => {
    const realCrypto = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: realCrypto.getRandomValues.bind(realCrypto) });
    await expect(
      deriveEnvelopeKey("0000-0000-0000-0000-0000-0000-0000-0000", new Uint8Array(16))
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
