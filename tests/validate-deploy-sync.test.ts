// Ensures validate-deploy.sh stays in sync with the TypeScript Env interfaces.
// If a new Worker secret is added to an Env interface, this test fails until
// the deploy validation script is updated to check for it.

import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, it, expect } from "vitest";

const ROOT = resolve(__dirname, "..");

function readFile(relPath: string): string {
  return readFileSync(resolve(ROOT, relPath), "utf-8");
}

// ── Extract string fields from a TypeScript interface ────────────────────────
// Matches lines like `FIELD_NAME: string;` or `FIELD_NAME?: string;`
// Skips non-string fields (CF bindings like ASSETS, PROXY_RATE_LIMITER).

interface EnvField {
  name: string;
  optional: boolean;
}

function extractInterfaceBody(source: string, interfaceName: string): string | null {
  const headerRegex = new RegExp(
    `(?:export\\s+)?interface\\s+${interfaceName}\\s*(?:extends[^{]*)?\\{`,
  );
  const headerMatch = source.match(headerRegex);
  if (!headerMatch) return null;

  // Walk from the opening brace, counting depth to find the matching close
  const start = headerMatch.index! + headerMatch[0].length;
  let depth = 1;
  for (let i = start; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}") depth--;
    if (depth === 0) return source.slice(start, i);
  }
  return null;
}

function extractStringFields(source: string, interfaceName: string): EnvField[] {
  const body = extractInterfaceBody(source, interfaceName);
  if (!body) return [];

  const fields: EnvField[] = [];
  for (const line of body.split("\n")) {
    // Match: FIELD_NAME?: string; or FIELD_NAME: string;
    // Also handles inline comments: FIELD_NAME?: string; // comment
    const fieldMatch = line.match(/^\s*(\w+)(\??):\s*string\s*;/);
    if (fieldMatch) {
      fields.push({ name: fieldMatch[1], optional: !!fieldMatch[2] });
    }
  }
  return fields;
}

// ── Extract parent interfaces from `extends` clause ──────────────────────────

function extractExtends(source: string, interfaceName: string): string[] {
  const regex = new RegExp(
    `(?:export\\s+)?interface\\s+${interfaceName}\\s+extends\\s+([^{]+)\\{`,
  );
  const match = source.match(regex);
  if (!match) return [];
  return match[1].split(",").map((s) => s.trim()).filter(Boolean);
}

// ── Extract checked variables from validate-deploy.sh ────────────────────────

interface ScriptChecks {
  required: Set<string>;
  warned: Set<string>;
}

function extractScriptChecks(source: string): {
  local: ScriptChecks;
  ci: ScriptChecks;
} {
  const local: ScriptChecks = { required: new Set(), warned: new Set() };
  const ci: ScriptChecks = { required: new Set(), warned: new Set() };

  // Local mode — `for s in VAR1 VAR2 ...; do`
  const forMatch = source.match(/for s in ([^;]+);/);
  if (forMatch) {
    for (const name of forMatch[1].trim().split(/\s+/)) {
      local.required.add(name);
    }
  }

  // Local mode — `grep -q '"name":"VAR"' || warn ...`
  for (const m of source.matchAll(/grep -q[^"]*"name":"(\w+)".*\|\|\s*warn/g)) {
    local.warned.add(m[1]);
  }

  // CI mode — `[[ -z "${VAR:-}" ]] && fail`
  for (const m of source.matchAll(/\$\{(\w+):-\}.*&&\s*fail/g)) {
    ci.required.add(m[1]);
  }

  // CI mode — `[[ -z "${VAR:-}" ]] && warn`
  for (const m of source.matchAll(/\$\{(\w+):-\}.*&&\s*warn/g)) {
    ci.warned.add(m[1]);
  }

  return { local, ci };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("validate-deploy.sh stays in sync with Env interfaces", () => {
  // Map each Env interface to its source file
  const envInterfaceFiles: Record<string, string> = {
    Env: "src/worker/index.ts",
    CryptoEnv: "src/worker/crypto.ts",
    SessionEnv: "src/worker/session.ts",
    TurnstileEnv: "src/worker/turnstile.ts",
  };

  // Build the full field list from the Env interface hierarchy
  const allFields: EnvField[] = [];
  const envSource = readFile(envInterfaceFiles.Env);
  allFields.push(...extractStringFields(envSource, "Env"));

  const parents = extractExtends(envSource, "Env");
  for (const parent of parents) {
    const file = envInterfaceFiles[parent];
    if (!file) throw new Error(`Unknown parent interface: ${parent} — add it to envInterfaceFiles`);
    allFields.push(...extractStringFields(readFile(file), parent));
  }

  const requiredFields = allFields.filter((f) => !f.optional).map((f) => f.name);
  const optionalFields = allFields.filter((f) => f.optional).map((f) => f.name);

  const script = readFile("scripts/validate-deploy.sh");
  const checks = extractScriptChecks(script);

  it("every required Env field is checked as required in local mode", () => {
    const missing = requiredFields.filter((f) => !checks.local.required.has(f));
    expect(missing, `Add these to the 'for s in ...' loop in validate-deploy.sh`).toEqual([]);
  });

  it("every optional Env field is warned about in local mode", () => {
    const allChecked = new Set([...checks.local.required, ...checks.local.warned]);
    const missing = optionalFields.filter((f) => !allChecked.has(f));
    expect(missing, `Add 'grep ... || warn' lines for these in validate-deploy.sh`).toEqual([]);
  });

  it("script doesn't check for fields removed from Env", () => {
    const allFieldNames = new Set(allFields.map((f) => f.name));
    const allScriptVars = new Set([...checks.local.required, ...checks.local.warned]);
    const stale = [...allScriptVars].filter((v) => !allFieldNames.has(v));
    expect(stale, `Remove these from validate-deploy.sh — they no longer exist in Env`).toEqual([]);
  });

  it("every VITE_ variable used in source is checked in CI mode", () => {
    const viteFiles = [
      "src/app/lib/oauth.ts",
      "src/app/lib/sentry.ts",
      "src/app/lib/proxy.ts",
    ];
    const viteVars = new Set<string>();
    for (const file of viteFiles) {
      for (const m of readFile(file).matchAll(/import\.meta\.env\.(VITE_\w+)/g)) {
        viteVars.add(m[1]);
      }
    }
    const allCiVars = new Set([...checks.ci.required, ...checks.ci.warned]);
    const missing = [...viteVars].filter((v) => !allCiVars.has(v));
    expect(missing, `Add CI-mode checks for these VITE_ vars in validate-deploy.sh`).toEqual([]);
  });

  it("Env extends chain is fully covered", () => {
    const uncovered = parents.filter((p) => !envInterfaceFiles[p]);
    expect(uncovered, `Add these to envInterfaceFiles in this test`).toEqual([]);
  });
});
