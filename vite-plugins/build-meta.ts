import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";

const HEX_SHA_RE = /^[0-9a-f]{7,40}$/i;

export interface BuildMetadata {
  version: string;
  sha: string;
  builtAt: string;
}

export function resolveGitSha(): string {
  const envSha = process.env.GITHUB_SHA?.trim();
  let rawSha: string;
  if (envSha) {
    rawSha = envSha;
  } else {
    try {
      rawSha = execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      rawSha = "dev";
    }
  }
  if (!HEX_SHA_RE.test(rawSha)) {
    return "dev";
  }
  return rawSha.toLowerCase().slice(0, 12);
}

export function resolvePackageVersion(): string {
  const pkgPath = resolve(process.cwd(), "package.json");
  const raw = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
  return typeof raw.version === "string" && raw.version.trim() !== ""
    ? raw.version.trim()
    : "0.0.0";
}

export function resolveBuildMetadata(): BuildMetadata {
  return {
    version: resolvePackageVersion(),
    sha: resolveGitSha(),
    builtAt: new Date().toISOString(),
  };
}

export function buildMeta(): Plugin[] {
  const { version, sha, builtAt } = resolveBuildMetadata();

  return [
    {
      name: "github-tracker:build-meta-define",
      config() {
        return {
          define: {
            __APP_VERSION__: JSON.stringify(version),
            __GIT_SHA__: JSON.stringify(sha),
            __BUILD_TIME__: JSON.stringify(builtAt),
          },
        };
      },
    },
    {
      name: "github-tracker:build-meta-emit",
      applyToEnvironment(environment) {
        return environment.name === "client";
      },
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "version.json",
          source: JSON.stringify({ version, sha, builtAt }),
        });
      },
    },
  ];
}
