import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../..");

interface PackageJson {
  name: string;
  version: string;
}

interface ReleasePleaseManifest {
  ".": string;
  mcp: string;
}

interface ReleasePleasePackageConfig {
  component?: string;
  "release-as"?: string;
  "extra-files"?: string[];
  "exclude-paths"?: string[];
}

interface ReleasePleaseConfig {
  "separate-pull-requests"?: boolean;
  packages: {
    ".": ReleasePleasePackageConfig;
    mcp: ReleasePleasePackageConfig;
  };
}

function readFile(relPath: string): string {
  return readFileSync(resolve(ROOT, relPath), "utf-8");
}

function readJson(relPath: string): unknown {
  return JSON.parse(readFile(relPath));
}

describe("MCP and release-please version synchronization", () => {
  it("keeps McpServer version annotated for release-please and synced with mcp/package.json and manifest", () => {
    const indexSource = readFile("mcp/src/index.ts");
    const mcpPkg = readJson("mcp/package.json") as PackageJson;
    const manifest = readJson(".release-please-manifest.json") as ReleasePleaseManifest;

    const serverBlockMatch = indexSource.match(
      /new\s+McpServer\(\s*\{[\s\S]*?version:\s*"([^"]+)",\s*\/\/\s*x-release-please-version[\s\S]*?\}\s*\)/,
    );

    expect(serverBlockMatch).not.toBeNull();
    const serverVersion = serverBlockMatch?.[1];
    expect(serverVersion).toBe(mcpPkg.version);
    expect(serverVersion).toBe(manifest.mcp);
  });

  it("keeps root package.json version synced with manifest and registers mcp/src/index.ts in extra-files", () => {
    const rootPkg = readJson("package.json") as PackageJson;
    const mcpPkg = readJson("mcp/package.json") as PackageJson;
    const manifest = readJson(".release-please-manifest.json") as ReleasePleaseManifest;
    const config = readJson("release-please-config.json") as ReleasePleaseConfig;

    expect(rootPkg.version).toBe(manifest["."]);
    expect(config["separate-pull-requests"]).toBe(true);
    expect(config.packages["."]?.component).toBe(rootPkg.name);
    expect(config.packages["."]["release-as"]).toBeUndefined();
    expect(config.packages.mcp?.component).toBe(mcpPkg.name);
    expect(config.packages.mcp["extra-files"]).toContain("src/index.ts");
    expect(config.packages["."]["exclude-paths"]).toContain("mcp");
  });

  it("retires legacy publish-mcp.yml workflow in favor of release.yml and gates deploy.yml on releases", () => {
    expect(existsSync(resolve(ROOT, ".github/workflows/publish-mcp.yml"))).toBe(false);
    expect(existsSync(resolve(ROOT, ".github/workflows/release.yml"))).toBe(true);

    const releaseYml = readFile(".github/workflows/release.yml");
    const deployYml = readFile(".github/workflows/deploy.yml");

    expect(releaseYml).toContain("app_release_created: ${{ steps.rp.outputs.release_created }}");
    expect(releaseYml).toContain("uses: ./.github/workflows/deploy.yml");
    expect(deployYml).toContain("workflow_call:");
    expect(deployYml).toContain("workflow_dispatch:");
    expect(deployYml).not.toMatch(/^\s*push:/m);
  });
});
