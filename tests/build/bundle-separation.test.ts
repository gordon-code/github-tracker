import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../..");

function readFile(relPath: string): string {
  return readFileSync(resolve(ROOT, relPath), "utf-8");
}

function collectSourceFiles(dirRelPath: string): string[] {
  const absDir = resolve(ROOT, dirRelPath);
  const results: string[] = [];

  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    const absEntry = join(absDir, entry.name);
    const relEntry = relative(ROOT, absEntry).replaceAll("\\", "/");
    if (entry.isDirectory()) {
      results.push(...collectSourceFiles(relEntry));
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
      results.push(relEntry);
    }
  }

  return results.toSorted();
}

/**
 * Extracts module specifiers from static value import/export statements,
 * excluding `import type ...` and `export type ...` statements and imports
 * where every named specifier is `type Foo`.
 */
function extractStaticValueImports(source: string): string[] {
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

  const imports: string[] = [];
  const staticImportRe =
    /\b(?:import|export)\s+(?!type\b)([\s\S]*?)\s+from\s+["']([^"']+)["']/g;

  for (const match of stripped.matchAll(staticImportRe)) {
    const clause = match[1].trim();
    const specifier = match[2];

    if (clause.startsWith("{") && clause.endsWith("}")) {
      const inner = clause
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (inner.length > 0 && inner.every((s) => /^type\s+/.test(s))) {
        continue;
      }
    }

    imports.push(specifier);
  }

  const sideEffectImportRe = /\bimport\s+["']([^"']+)["']/g;
  for (const match of stripped.matchAll(sideEffectImportRe)) {
    imports.push(match[1]);
  }

  return imports;
}

describe("bundle module separation & anti-bloat guardrails", () => {
  const appFiles = collectSourceFiles("src/app");

  it("forbids value imports of @sentry/solid outside src/app/lib/sentry-init.ts", () => {
    const offenders: string[] = [];
    for (const file of appFiles) {
      if (file === "src/app/lib/sentry-init.ts") continue;
      const source = readFile(file);
      const staticValueImports = extractStaticValueImports(source);
      const hasDynamicSentrySolid = /\bimport\s*\(\s*["']@sentry\/solid["']\s*\)/.test(source);
      if (staticValueImports.includes("@sentry/solid") || hasDynamicSentrySolid) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("forbids static value imports of heavy or classic-zod modules on the boot path", () => {
    const bootPathFiles = [
      "src/shared/schemas.ts",
      "src/app/index.tsx",
      "src/app/App.tsx",
      "src/app/stores/auth.ts",
      "src/app/stores/config.ts",
      "src/app/stores/view.ts",
      "src/app/pages/LoginPage.tsx",
      "src/app/pages/JiraCallback.tsx",
      "src/app/pages/OAuthCallback.tsx",
      "src/app/lib/use-credential-import.ts",
    ];

    const forbiddenMatchers = [
      (spec: string) => spec === "zod",
      (spec: string) => spec.startsWith("@octokit/"),
      (spec: string) => spec === "bottleneck",
      (spec: string) => /(?:^|\/)services\/github$/.test(spec),
      (spec: string) => /(?:^|\/)lib\/mcp-relay$/.test(spec),
      (spec: string) => /(?:^|\/)(?:lib\/)?settings-transfer$/.test(spec),
    ];

    const violations: Array<{ file: string; specifier: string }> = [];

    for (const file of bootPathFiles) {
      const staticImports = extractStaticValueImports(readFile(file));
      for (const specifier of staticImports) {
        if (forbiddenMatchers.some((fn) => fn(specifier))) {
          violations.push({ file, specifier });
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("lazy-loads CustomTabModal and restricts github-emoji-map.json to src/app/lib/emoji.ts", () => {
    for (const file of [
      "src/app/components/dashboard/DashboardPage.tsx",
      "src/app/components/settings/CustomTabsSection.tsx",
    ]) {
      const staticImports = extractStaticValueImports(readFile(file));
      const modalImports = staticImports.filter((s) => s.endsWith("CustomTabModal"));
      expect(modalImports, `${file} must lazy-load CustomTabModal`).toEqual([]);
    }

    const emojiImporters: string[] = [];
    for (const file of appFiles) {
      const source = readFile(file);
      if (source.includes("github-emoji-map.json")) {
        const stripped = source
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/\/\/.*$/gm, "");
        if (stripped.includes("github-emoji-map.json")) {
          emojiImporters.push(file);
        }
      }
    }
    expect(emojiImporters).toEqual(["src/app/lib/emoji.ts"]);
    expect(extractStaticValueImports(readFile("src/app/lib/emoji.ts"))).not.toContain(
      "./github-emoji-map.json",
    );
  });

  it("enforces no-restricted-imports in .oxlintrc.json and bundle:report in verify action", () => {
    const oxlintConfig = JSON.parse(readFile(".oxlintrc.json")) as {
      overrides?: Array<{
        files?: string[];
        rules?: Record<string, unknown>;
      }>;
    };

    const restrictedOverrides = (oxlintConfig.overrides ?? []).filter(
      (o) => o.rules && "no-restricted-imports" in o.rules,
    );
    expect(restrictedOverrides.length).toBeGreaterThanOrEqual(3);

    const verifyAction = readFile(".github/actions/verify/action.yml");
    expect(verifyAction).toContain("pnpm bundle:report");

    const bundleReportScript = readFile("scripts/bundle-report.sh");
    expect(bundleReportScript).toContain("Bundle Budget & Separation Verification");
    expect(bundleReportScript).toContain("process.exit(1)");
  });
});
