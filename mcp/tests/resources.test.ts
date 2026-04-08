// ── MCP resources.ts unit tests ───────────────────────────────────────────────
// Tests each of the 2 resources using a mock DataSource. Resources are tested
// by calling the registered readCallback directly via server._registeredResources.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerResources } from "../src/resources.js";
import type { DataSource } from "../src/data-source.js";
import type { CachedConfig } from "../src/data-source.js";
import type { RepoRef } from "../../src/shared/types.js";

// ── Mock DataSource ────────────────────────────────────────────────────────────

function makeMockDataSource(overrides: Partial<DataSource> = {}): DataSource {
  return {
    getDashboardSummary: vi.fn().mockResolvedValue(null),
    getOpenPRs: vi.fn().mockResolvedValue([]),
    getOpenIssues: vi.fn().mockResolvedValue([]),
    getFailingActions: vi.fn().mockResolvedValue([]),
    getPRDetails: vi.fn().mockResolvedValue(null),
    getRateLimit: vi.fn().mockResolvedValue(null),
    getConfig: vi.fn().mockResolvedValue(null),
    getRepos: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

// ── Helper: call a registered resource readCallback directly ──────────────────

type ResourceRegistry = Record<
  string,
  { readCallback: (uri: URL, extra: Record<string, unknown>) => Promise<unknown> }
>;

async function callResource(
  server: McpServer,
  uri: string
): Promise<{ contents: { uri: string; mimeType: string; text: string }[] }> {
  const resources = (server as unknown as { _registeredResources: ResourceRegistry })
    ._registeredResources;
  const resource = resources[uri];
  if (!resource) throw new Error(`Resource not found: ${uri}`);
  return resource.readCallback(new URL(uri), {}) as Promise<{
    contents: { uri: string; mimeType: string; text: string }[];
  }>;
}

// ── Sample fixtures ───────────────────────────────────────────────────────────

function makeRepoRef(fullName: string): RepoRef {
  const [owner, name] = fullName.split("/");
  return { owner, name, fullName };
}

function makeConfig(overrides: Partial<CachedConfig> = {}): CachedConfig {
  return {
    selectedRepos: [],
    trackedUsers: [],
    upstreamRepos: [],
    monitoredRepos: [],
    ...overrides,
  };
}

// ── Tests: tracker://config ───────────────────────────────────────────────────

describe("tracker://config", () => {
  let server: McpServer;
  let ds: DataSource;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "0.0.0" });
    ds = makeMockDataSource();
    registerResources(server, ds);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns JSON config when config is available", async () => {
    const config = makeConfig({
      selectedRepos: [makeRepoRef("owner/repo")],
    });
    vi.mocked(ds.getConfig).mockResolvedValueOnce(config);

    const result = await callResource(server, "tracker://config");

    expect(result.contents).toHaveLength(1);
    const content = result.contents[0];
    expect(content.uri).toBe("tracker://config");
    expect(content.mimeType).toBe("application/json");

    const parsed = JSON.parse(content.text);
    expect(parsed.selectedRepos).toHaveLength(1);
    expect(parsed.selectedRepos[0].fullName).toBe("owner/repo");
  });

  it("returns placeholder when config is null", async () => {
    vi.mocked(ds.getConfig).mockResolvedValueOnce(null);

    const result = await callResource(server, "tracker://config");

    expect(result.contents).toHaveLength(1);
    const content = result.contents[0];
    expect(content.uri).toBe("tracker://config");
    expect(content.mimeType).toBe("application/json");

    const parsed = JSON.parse(content.text);
    expect(parsed.status).toContain("No configuration available");
  });

  it("calls getConfig on the data source", async () => {
    await callResource(server, "tracker://config");
    expect(ds.getConfig).toHaveBeenCalledOnce();
  });

  it("returns valid JSON in both cases", async () => {
    // null case
    const nullResult = await callResource(server, "tracker://config");
    expect(() => JSON.parse(nullResult.contents[0].text)).not.toThrow();

    // config case
    vi.mocked(ds.getConfig).mockResolvedValueOnce(makeConfig());
    const configResult = await callResource(server, "tracker://config");
    expect(() => JSON.parse(configResult.contents[0].text)).not.toThrow();
  });

  it("serializes config with all fields", async () => {
    const config = makeConfig({
      selectedRepos: [makeRepoRef("org/app")],
      upstreamRepos: [makeRepoRef("upstream/lib")],
      trackedUsers: [],
      monitoredRepos: [],
    });
    vi.mocked(ds.getConfig).mockResolvedValueOnce(config);

    const result = await callResource(server, "tracker://config");
    const parsed = JSON.parse(result.contents[0].text);

    expect(parsed).toHaveProperty("selectedRepos");
    expect(parsed).toHaveProperty("upstreamRepos");
    expect(parsed).toHaveProperty("trackedUsers");
    expect(parsed).toHaveProperty("monitoredRepos");
    expect(parsed.upstreamRepos[0].fullName).toBe("upstream/lib");
  });
});

// ── Tests: tracker://repos ────────────────────────────────────────────────────

describe("tracker://repos", () => {
  let server: McpServer;
  let ds: DataSource;

  beforeEach(() => {
    server = new McpServer({ name: "test", version: "0.0.0" });
    ds = makeMockDataSource();
    registerResources(server, ds);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns empty list with count 0 when no repos", async () => {
    vi.mocked(ds.getRepos).mockResolvedValueOnce([]);

    const result = await callResource(server, "tracker://repos");

    expect(result.contents).toHaveLength(1);
    const content = result.contents[0];
    expect(content.uri).toBe("tracker://repos");
    expect(content.mimeType).toBe("application/json");

    const parsed = JSON.parse(content.text);
    expect(parsed.count).toBe(0);
    expect(parsed.repos).toHaveLength(0);
  });

  it("returns repo list with correct count", async () => {
    const repos = [makeRepoRef("owner/alpha"), makeRepoRef("owner/beta")];
    vi.mocked(ds.getRepos).mockResolvedValueOnce(repos);

    const result = await callResource(server, "tracker://repos");
    const parsed = JSON.parse(result.contents[0].text);

    expect(parsed.count).toBe(2);
    expect(parsed.repos).toHaveLength(2);
  });

  it("includes fullName, owner, and name fields per repo", async () => {
    vi.mocked(ds.getRepos).mockResolvedValueOnce([makeRepoRef("acme/widget")]);

    const result = await callResource(server, "tracker://repos");
    const parsed = JSON.parse(result.contents[0].text);
    const repo = parsed.repos[0];

    expect(repo.fullName).toBe("acme/widget");
    expect(repo.owner).toBe("acme");
    expect(repo.name).toBe("widget");
  });

  it("calls getRepos on the data source", async () => {
    await callResource(server, "tracker://repos");
    expect(ds.getRepos).toHaveBeenCalledOnce();
  });

  it("returns valid JSON", async () => {
    vi.mocked(ds.getRepos).mockResolvedValueOnce([makeRepoRef("x/y")]);
    const result = await callResource(server, "tracker://repos");
    expect(() => JSON.parse(result.contents[0].text)).not.toThrow();
  });

  it("preserves order of repos from data source", async () => {
    const repos = [
      makeRepoRef("a/first"),
      makeRepoRef("b/second"),
      makeRepoRef("c/third"),
    ];
    vi.mocked(ds.getRepos).mockResolvedValueOnce(repos);

    const result = await callResource(server, "tracker://repos");
    const parsed = JSON.parse(result.contents[0].text);

    expect(parsed.repos[0].fullName).toBe("a/first");
    expect(parsed.repos[1].fullName).toBe("b/second");
    expect(parsed.repos[2].fullName).toBe("c/third");
  });
});
