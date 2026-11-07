import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const mockExecFileSync = vi.hoisted(() => vi.fn());
const mockReadFileSync = vi.hoisted(() => vi.fn());
const mockExistsSync = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (...args: Parameters<typeof actual.existsSync>) =>
      mockExistsSync.getMockImplementation()
        ? mockExistsSync(...args)
        : actual.existsSync(...args),
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) =>
      mockReadFileSync.getMockImplementation()
        ? mockReadFileSync(...args)
        : actual.readFileSync(...args),
  };
});

import * as z from "zod/mini";
import {
  buildMeta,
  computeSchemaFingerprint,
  parseChangelog,
  resolveBuildMetadata,
  resolveGitSha,
  resolvePackageVersion,
} from "../../vite-plugins/build-meta";
import { ConfigSchema } from "../../src/shared/schemas";
import { PERSISTED_LIMITS, ViewStateSchema } from "../../src/shared/view-schema";

const pkgVersion = (
  JSON.parse(
    readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
  ) as { version: string }
).version;

describe("buildMeta Vite plugin", () => {
  const originalGithubSha = process.env.GITHUB_SHA;

  beforeEach(() => {
    mockExecFileSync.mockReset();
    mockReadFileSync.mockReset();
    mockExistsSync.mockReset();
    delete process.env.GITHUB_SHA;
  });

  afterEach(() => {
    if (originalGithubSha === undefined) {
      delete process.env.GITHUB_SHA;
    } else {
      process.env.GITHUB_SHA = originalGithubSha;
    }
    vi.useRealTimers();
  });

  it("prefers GITHUB_SHA over git rev-parse HEAD and slices to 12 hex characters", () => {
    process.env.GITHUB_SHA = "  1234567890ABCDEF1234567890abcdef12345678\n";
    mockExecFileSync.mockReturnValue("ffffffffffffffffffffffffffffffffffffffff\n");

    const sha = resolveGitSha();
    expect(sha).toBe("1234567890ab");
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("falls back to git rev-parse HEAD when GITHUB_SHA is unset or blank and slices to 12 chars", () => {
    process.env.GITHUB_SHA = "   ";
    mockExecFileSync.mockReturnValue("fedcba9876543210fedcba9876543210fedcba98\n");

    const sha = resolveGitSha();
    expect(sha).toBe("fedcba987654");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "git",
      ["rev-parse", "HEAD"],
      expect.objectContaining({
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  });

  it("falls back to 'dev' when git rev-parse HEAD throws or returns non-hex output", () => {
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error("fatal: not a git repository");
    });
    expect(resolveGitSha()).toBe("dev");

    mockExecFileSync.mockReturnValueOnce("not-a-valid-sha\n");
    expect(resolveGitSha()).toBe("dev");

    mockExecFileSync.mockReturnValueOnce("\n");
    expect(resolveGitSha()).toBe("dev");
  });

  it("validates GITHUB_SHA length and hex characters and accepts 7-char short SHAs", () => {
    process.env.GITHUB_SHA = "123456"; // < 7 chars
    expect(resolveGitSha()).toBe("dev");
    expect(mockExecFileSync).not.toHaveBeenCalled();

    process.env.GITHUB_SHA = "a".repeat(41); // > 40 chars
    expect(resolveGitSha()).toBe("dev");
    expect(mockExecFileSync).not.toHaveBeenCalled();

    process.env.GITHUB_SHA = "1234567g"; // non-hex character
    expect(resolveGitSha()).toBe("dev");
    expect(mockExecFileSync).not.toHaveBeenCalled();

    process.env.GITHUB_SHA = "ABCDEF1"; // minimum valid 7-char short SHA
    expect(resolveGitSha()).toBe("abcdef1");
  });

  it("resolves trimmed package.json version and falls back to '0.0.0' when missing, blank, or non-string", () => {
    expect(resolvePackageVersion()).toBe(pkgVersion);

    mockReadFileSync.mockImplementation(() => JSON.stringify({ version: "  2.3.4-beta.1  " }));
    expect(resolvePackageVersion()).toBe("2.3.4-beta.1");

    mockReadFileSync.mockImplementation(() => JSON.stringify({}));
    expect(resolvePackageVersion()).toBe("0.0.0");

    mockReadFileSync.mockImplementation(() => JSON.stringify({ version: "   " }));
    expect(resolvePackageVersion()).toBe("0.0.0");

    mockReadFileSync.mockImplementation(() => JSON.stringify({ version: 123 }));
    expect(resolvePackageVersion()).toBe("0.0.0");
  });

  it("resolveBuildMetadata() combines package version, resolved git SHA, and ISO timestamp", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-14T12:34:56.789Z"));
    process.env.GITHUB_SHA = "abcdef0123456789abcdef0123456789abcdef01";

    expect(resolveBuildMetadata()).toEqual({
      version: pkgVersion,
      sha: "abcdef012345",
      builtAt: "2026-04-14T12:34:56.789Z",
      schemaFp: computeSchemaFingerprint(),
    });
  });

  describe("computeSchemaFingerprint", () => {
    it("is a stable 12-character hex digest of the persisted config and view schema shape", () => {
      const fingerprint = computeSchemaFingerprint();
      expect(fingerprint).toMatch(/^[0-9a-f]{12}$/);
      expect(computeSchemaFingerprint()).toBe(fingerprint);
    });

    it("represents transformed fields, so a piped field shows its stored shape and limits", () => {
      const view = z.toJSONSchema(ViewStateSchema, { unrepresentable: "any", io: "input" });
      const jiraCustomOrder = (view.properties as Record<string, Record<string, unknown>>).jiraCustomOrder;
      expect(Object.keys(jiraCustomOrder).length).toBeGreaterThan(0);
      expect(jiraCustomOrder.maxItems).toBe(500);
    });

    it("does not depend on the text of the schema sources (comments, formatting, helper code)", () => {
      const original = computeSchemaFingerprint();
      mockReadFileSync.mockImplementation(() => {
        throw new Error("the fingerprint must not read source files");
      });
      expect(computeSchemaFingerprint()).toBe(original);
    });

    it("does not depend on the order of keys in the schemas", () => {
      const original = computeSchemaFingerprint();
      for (const schema of [ConfigSchema, ViewStateSchema]) {
        const shape = schema.shape as Record<string, unknown>;
        const entries = Object.entries(shape);
        try {
          for (const [key] of entries) delete shape[key];
          for (const [key, value] of entries.toReversed()) shape[key] = value;
          expect(computeSchemaFingerprint()).toBe(original);
        } finally {
          for (const [key] of Object.entries(shape)) delete shape[key];
          for (const [key, value] of entries) shape[key] = value;
        }
      }
      expect(computeSchemaFingerprint()).toBe(original);
    });

    it.each(Object.keys(PERSISTED_LIMITS))("changes when the %s limit changes", (limit) => {
      const original = computeSchemaFingerprint();
      const limits = PERSISTED_LIMITS as Record<string, number>;
      const previous = limits[limit];
      try {
        limits[limit] = previous + 1;
        expect(computeSchemaFingerprint()).not.toBe(original);
      } finally {
        limits[limit] = previous;
      }
      expect(computeSchemaFingerprint()).toBe(original);
    });

    it("changes when a stored enum value or default changes", () => {
      const original = computeSchemaFingerprint();
      const configShape = ConfigSchema.shape as Record<string, unknown>;
      const previous = configShape.refreshInterval;
      try {
        configShape.refreshInterval = z._default(z.int(), 301);
        expect(computeSchemaFingerprint()).not.toBe(original);
      } finally {
        configShape.refreshInterval = previous;
      }
      expect(computeSchemaFingerprint()).toBe(original);
    });

    it("accounts for every refine in the persisted schemas (add new refine limits to PERSISTED_LIMITS)", () => {
      const sources = ["src/shared/schemas.ts", "src/shared/view-schema.ts"].map((file) =>
        readFileSync(resolve(process.cwd(), file), "utf8"),
      );
      const refines = sources.join("\n").match(/\bz\.(refine|superRefine|custom)\(/g) ?? [];
      // 4 limits in PERSISTED_LIMITS + the tracked-user avatar prefix. A new refine whose rule is not
      // exposed as data in the fingerprint would let an older tab write data the newer build rejects.
      expect(refines).toHaveLength(5);
    });

    it("changes when a persisted key is added to either schema", () => {
      const original = computeSchemaFingerprint();
      const configShape = ConfigSchema.shape as Record<string, unknown>;
      const viewShape = ViewStateSchema.shape as Record<string, unknown>;
      try {
        configShape.fingerprintProbe = z.string();
        expect(computeSchemaFingerprint()).not.toBe(original);
      } finally {
        delete configShape.fingerprintProbe;
      }
      expect(computeSchemaFingerprint()).toBe(original);
      try {
        viewShape.fingerprintProbe = z.string();
        expect(computeSchemaFingerprint()).not.toBe(original);
      } finally {
        delete viewShape.fingerprintProbe;
      }
      expect(computeSchemaFingerprint()).toBe(original);
    });
  });

  it("returns define plugin that sets only JSON-encoded __APP_VERSION__, __GIT_SHA__ and __SCHEMA_FP__", () => {
    process.env.GITHUB_SHA = "abcdef0123456789abcdef0123456789abcdef01";

    const [definePlugin] = buildMeta();
    expect(definePlugin.name).toBe("github-tracker:build-meta-define");

    const configFn = definePlugin.config as unknown as () => {
      define: Record<string, string>;
    };
    const result = configFn();

    expect(result).toEqual({
      define: {
        __APP_VERSION__: JSON.stringify(pkgVersion),
        __GIT_SHA__: JSON.stringify("abcdef012345"),
        __SCHEMA_FP__: JSON.stringify(computeSchemaFingerprint()),
      },
    });
  });

  it("scopes the emit plugin to the client environment only", () => {
    mockExecFileSync.mockReturnValue("abcdef0123456789abcdef0123456789abcdef01\n");
    const [, emitPlugin] = buildMeta();
    expect(emitPlugin.name).toBe("github-tracker:build-meta-emit");

    const applyToEnvironment = emitPlugin.applyToEnvironment as unknown as (env: {
      name: string;
    }) => boolean;
    expect(applyToEnvironment({ name: "client" })).toBe(true);
    expect(applyToEnvironment({ name: "ssr" })).toBe(false);
    expect(applyToEnvironment({ name: "worker" })).toBe(false);
  });

  it("emits version.json at the client root with exact keys ['version', 'sha', 'builtAt', 'schemaFp']", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-14T12:34:56.789Z"));
    process.env.GITHUB_SHA = "abcdef0123456789abcdef0123456789abcdef01";

    const [, emitPlugin] = buildMeta();
    const emitFile = vi.fn();
    const generateBundle = emitPlugin.generateBundle as unknown as (this: {
      emitFile: typeof emitFile;
    }) => void;

    generateBundle.call({ emitFile });

    expect(emitFile).toHaveBeenCalledOnce();
    const emitted = emitFile.mock.calls[0][0] as {
      type: string;
      fileName: string;
      source: string;
    };
    expect(emitted.type).toBe("asset");
    expect(emitted.fileName).toBe("version.json");

    const parsed = JSON.parse(emitted.source) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["version", "sha", "builtAt", "schemaFp"]);
    expect(parsed).toEqual({
      version: pkgVersion,
      sha: "abcdef012345",
      builtAt: "2026-04-14T12:34:56.789Z",
      schemaFp: computeSchemaFingerprint(),
    });
  });

  describe("parseChangelog and virtual:changelog", () => {
    it("parses linked ## headings, unlinked ## headings, legacy ### patch headings, bold-scope and plain bullets, BREAKING CHANGES, PR numbers, and hex SHAs", () => {
      const md = [
        "# Changelog",
        "",
        "## [0.2.0](https://github.com/gordon-code/github-tracker/compare/github-tracker@0.1.1...github-tracker@0.2.0) (2026-11-10)",
        "",
        "### ⚠ BREAKING CHANGES",
        "",
        "* **api:** drop legacy v1 endpoint",
        "",
        "### Features",
        "",
        "* **dashboard:** add keyboard navigation ([#190](https://github.com/gordon-code/github-tracker/issues/190)) ([1a2b3c4](https://github.com/gordon-code/github-tracker/commit/1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b))",
        "- plain bullet with unlinked PR (#191) ([ABCDEF1](https://github.com/gordon-code/github-tracker/commit/abcdef1))",
        "",
        "### [0.1.1](https://github.com/gordon-code/github-tracker/compare/github-tracker@0.1.0...github-tracker@0.1.1) (2026-11-06)",
        "",
        "### Bug Fixes",
        "",
        "* **release:** sync MCP version ([#183](https://github.com/gordon-code/github-tracker/issues/183)) ([97050e3](https://github.com/gordon-code/github-tracker/commit/97050e373da849c1863a08ce1b0c44fa12f17507))",
        "",
        "## 0.1.0 (2026-11-01)",
        "",
        "### Features",
        "",
        "* initial release ([deadbeef](https://github.com/gordon-code/github-tracker/commit/deadbeef))",
      ].join("\n");

      const entries = parseChangelog(md);
      expect(entries).toEqual([
        {
          version: "0.2.0",
          date: "2026-11-10",
          sections: [
            {
              title: "⚠ BREAKING CHANGES",
              items: [{ text: "api: drop legacy v1 endpoint" }],
            },
            {
              title: "Features",
              items: [
                {
                  text: "dashboard: add keyboard navigation",
                  pr: 190,
                  sha: "1a2b3c4",
                },
                {
                  text: "plain bullet with unlinked PR",
                  pr: 191,
                  sha: "abcdef1",
                },
              ],
            },
          ],
        },
        {
          version: "0.1.1",
          date: "2026-11-06",
          sections: [
            {
              title: "Bug Fixes",
              items: [
                {
                  text: "release: sync MCP version",
                  pr: 183,
                  sha: "97050e3",
                },
              ],
            },
          ],
        },
        {
          version: "0.1.0",
          date: "2026-11-01",
          sections: [
            {
              title: "Features",
              items: [
                {
                  text: "initial release",
                  sha: "deadbeef",
                },
              ],
            },
          ],
        },
      ]);
    });

    it("strips markdown link syntax (discarding URLs) and preserves raw HTML/XSS strings only as plain text", () => {
      const md = [
        "## 0.1.0 (2026-11-01)",
        "",
        "### Security",
        "",
        "* **xss:** sanitize [click here](javascript:alert(1)) and <script>alert('xss')</script> plus <img src=x onerror=alert(1)> and [docs](https://evil.example/phish) ([#42](https://github.com/gordon-code/github-tracker/pull/42))",
      ].join("\n");

      const entries = parseChangelog(md);
      expect(entries).toHaveLength(1);
      const item = entries[0].sections[0].items[0];
      expect(item.text).toBe(
        "xss: sanitize click here and <script>alert('xss')</script> plus <img src=x onerror=alert(1)> and docs",
      );
      expect(item.text).not.toContain("javascript:");
      expect(item.text).not.toContain("https://evil.example");
      expect(item.pr).toBe(42);
    });

    it("falls back to 'Changes' when bullets appear before any ### section heading, merges duplicate section headings, and filters out empty sections", () => {
      const md = [
        "## 0.3.0 (2026-11-12)",
        "",
        "* top-level change before any section heading (#200)",
        "",
        "### Empty Section",
        "",
        "* (#201)",
        "",
        "### Features",
        "",
        "* first feature",
        "",
        "### Features",
        "",
        "* second feature under duplicate heading",
      ].join("\n");

      const entries = parseChangelog(md);
      expect(entries).toEqual([
        {
          version: "0.3.0",
          date: "2026-11-12",
          sections: [
            {
              title: "Changes",
              items: [
                {
                  text: "top-level change before any section heading",
                  pr: 200,
                },
              ],
            },
            {
              title: "Features",
              items: [
                { text: "first feature" },
                { text: "second feature under duplicate heading" },
              ],
            },
          ],
        },
      ]);
    });

    it("caps output at 20 releases and truncates bullet item text at 300 characters", () => {
      const releaseBlocks: string[] = [];
      for (let i = 25; i >= 1; i--) {
        const longText = `item-${i}-` + "x".repeat(350);
        releaseBlocks.push(
          `## 0.${i}.0 (2026-10-${String((i % 28) + 1).padStart(2, "0")})\n\n### Features\n\n* ${longText} (#${i})`,
        );
      }
      const entries = parseChangelog(releaseBlocks.join("\n\n"));
      expect(entries).toHaveLength(20);
      expect(entries[0].version).toBe("0.25.0");
      expect(entries[19].version).toBe("0.6.0");
      for (const entry of entries) {
        for (const section of entry.sections) {
          for (const item of section.items) {
            expect(item.text.length).toBeLessThanOrEqual(300);
          }
        }
      }
    });

    it("resolves virtual:changelog and loads parsed CHANGELOG.md or returns empty array when CHANGELOG.md is absent", () => {
      const [, emitPlugin] = buildMeta();
      const resolveId = emitPlugin.resolveId as unknown as (id: string) => string | null;
      const load = emitPlugin.load as unknown as (
        this: { addWatchFile: (p: string) => void },
        id: string,
      ) => string | null;

      expect(resolveId("virtual:changelog")).toBe("\0virtual:changelog");
      expect(resolveId("other-module")).toBeNull();
      expect(load.call({ addWatchFile: vi.fn() }, "other-id")).toBeNull();

      // Real CHANGELOG.md exists on disk
      const watchSpy = vi.fn();
      const loadedReal = load.call({ addWatchFile: watchSpy }, "\0virtual:changelog");
      expect(watchSpy).toHaveBeenCalledWith(resolve(process.cwd(), "CHANGELOG.md"));
      // The committed release-please format must parse into real entries, not fall back to `[]`.
      expect(loadedReal).toMatch(/^export default \[.*\];$/);
      expect(loadedReal).not.toBe("export default [];");
      const realEntries = JSON.parse(
        (loadedReal ?? "").replace(/^export default /, "").replace(/;$/, ""),
      ) as Array<{ version: string; sections: unknown[] }>;
      expect(realEntries.length).toBeGreaterThan(0);
      expect(realEntries[0].version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(realEntries[0].sections.length).toBeGreaterThan(0);

      // Missing CHANGELOG.md returns "export default [];"
      mockExistsSync.mockReturnValue(false);
      const loadedMissing = load.call({ addWatchFile: vi.fn() }, "\0virtual:changelog");
      expect(loadedMissing).toBe("export default [];");
    });
  });
});
