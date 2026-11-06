import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const mockExecFileSync = vi.hoisted(() => vi.fn());
const mockReadFileSync = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) =>
      mockReadFileSync.getMockImplementation()
        ? mockReadFileSync(...args)
        : actual.readFileSync(...args),
  };
});

import {
  buildMeta,
  resolveBuildMetadata,
  resolveGitSha,
  resolvePackageVersion,
} from "../../vite-plugins/build-meta";

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
    });
  });

  it("returns define plugin that sets JSON-encoded __APP_VERSION__, __GIT_SHA__, and __BUILD_TIME__", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-14T12:34:56.789Z"));
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
        __BUILD_TIME__: JSON.stringify("2026-04-14T12:34:56.789Z"),
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

  it("emits version.json at the client root with exact keys ['version', 'sha', 'builtAt']", () => {
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
    expect(Object.keys(parsed)).toEqual(["version", "sha", "builtAt"]);
    expect(parsed).toEqual({
      version: pkgVersion,
      sha: "abcdef012345",
      builtAt: "2026-04-14T12:34:56.789Z",
    });
  });
});
