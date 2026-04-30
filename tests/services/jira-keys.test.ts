import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { IJiraClient } from "../../src/app/services/jira-client";
import { JiraApiError } from "../../src/app/services/jira-client";
import type { JiraIssue, JiraBulkFetchResult } from "../../src/shared/jira-types";

// ── Module under test (imported after mock setup) ─────────────────────────────
// We import after each reset so the module-level cache is fresh.

function makeIssue(key = "PROJ-1"): JiraIssue {
  return {
    id: "10001",
    key,
    self: `https://api.atlassian.com/ex/jira/cloud-id/rest/api/3/issue/${key}`,
    fields: {
      summary: `Summary for ${key}`,
      status: {
        id: "1",
        name: "In Progress",
        statusCategory: { id: 4, key: "indeterminate", name: "In Progress" },
      },
      priority: { id: "2", name: "High" },
      assignee: { accountId: "abc123", displayName: "Test User" },
      project: { id: "10000", key: "PROJ", name: "My Project" },
    },
  };
}

function makeBulkResult(issues: JiraIssue[], errorKeys: string[] = []): JiraBulkFetchResult {
  return {
    issues,
    errors: errorKeys.length > 0 ? [{ issueIdsOrKeys: errorKeys, status: 404 }] : [],
  };
}

function makeClient(overrides: Partial<IJiraClient> = {}): IJiraClient {
  return {
    getIssue: vi.fn().mockResolvedValue(null),
    bulkFetch: vi.fn().mockResolvedValue(makeBulkResult([])),
    searchJql: vi.fn().mockResolvedValue({ issues: [], total: 0, maxResults: 50, startAt: 0 }),
    ...overrides,
  };
}

// ── lookupKeys ────────────────────────────────────────────────────────────────

describe("lookupKeys", () => {
  let lookupKeys: (typeof import("../../src/app/services/jira-keys"))["lookupKeys"];
  let clearJiraKeyCache: (typeof import("../../src/app/services/jira-keys"))["clearJiraKeyCache"];

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../../src/app/services/jira-keys");
    lookupKeys = mod.lookupKeys;
    clearJiraKeyCache = mod.clearJiraKeyCache;
    clearJiraKeyCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns empty map when called with empty keys array", async () => {
    const client = makeClient();
    const result = await lookupKeys([], client);
    expect(result.size).toBe(0);
    expect(client.bulkFetch).not.toHaveBeenCalled();
  });

  it("calls bulkFetch for uncached keys", async () => {
    const issue = makeIssue("PROJ-1");
    const client = makeClient({
      bulkFetch: vi.fn().mockResolvedValue(makeBulkResult([issue])),
    });

    const result = await lookupKeys(["PROJ-1"], client);

    expect(client.bulkFetch).toHaveBeenCalledWith(["PROJ-1"]);
    expect(result.get("PROJ-1")).toEqual(issue);
  });

  it("returns cached result on second call without re-fetching", async () => {
    const issue = makeIssue("PROJ-2");
    const client = makeClient({
      bulkFetch: vi.fn().mockResolvedValue(makeBulkResult([issue])),
    });

    await lookupKeys(["PROJ-2"], client);
    const result = await lookupKeys(["PROJ-2"], client);

    // bulkFetch called once only — second call hits cache
    expect(client.bulkFetch).toHaveBeenCalledTimes(1);
    expect(result.get("PROJ-2")).toEqual(issue);
  });

  it("caches null for keys returned in errors array", async () => {
    const client = makeClient({
      bulkFetch: vi.fn().mockResolvedValue(makeBulkResult([], ["PROJ-99"])),
    });

    const result = await lookupKeys(["PROJ-99"], client);

    expect(result.get("PROJ-99")).toBeNull();
  });

  it("caches null for keys not in result or errors (unknown key)", async () => {
    const client = makeClient({
      bulkFetch: vi.fn().mockResolvedValue(makeBulkResult([])),
    });

    const result = await lookupKeys(["UNKN-1"], client);

    expect(result.get("UNKN-1")).toBeNull();
  });

  it("caches null for all keys in batch on JiraApiError", async () => {
    const client = makeClient({
      bulkFetch: vi.fn().mockRejectedValue(new JiraApiError(403, null, "Forbidden")),
    });

    const result = await lookupKeys(["PROJ-1", "PROJ-2"], client);

    expect(result.get("PROJ-1")).toBeNull();
    expect(result.get("PROJ-2")).toBeNull();
  });

  it("falls back to getIssue per-key on CORS/network error (non-JiraApiError)", async () => {
    const issue = makeIssue("PROJ-5");
    const client = makeClient({
      bulkFetch: vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
      getIssue: vi.fn().mockResolvedValue(issue),
    });

    const result = await lookupKeys(["PROJ-5"], client);

    expect(client.getIssue).toHaveBeenCalledWith("PROJ-5");
    expect(result.get("PROJ-5")).toEqual(issue);
  });

  it("only fetches uncached keys (mix of cached and uncached)", async () => {
    const issue1 = makeIssue("PROJ-1");
    const issue2 = makeIssue("PROJ-2");
    const client = makeClient({
      bulkFetch: vi.fn()
        .mockResolvedValueOnce(makeBulkResult([issue1]))
        .mockResolvedValueOnce(makeBulkResult([issue2])),
    });

    await lookupKeys(["PROJ-1"], client);
    const result = await lookupKeys(["PROJ-1", "PROJ-2"], client);

    // Only PROJ-2 fetched in second call
    expect(vi.mocked(client.bulkFetch).mock.calls[1]).toEqual([["PROJ-2"]]);
    expect(result.get("PROJ-1")).toEqual(issue1);
    expect(result.get("PROJ-2")).toEqual(issue2);
  });
});

// ── clearJiraKeyCache ─────────────────────────────────────────────────────────

describe("clearJiraKeyCache", () => {
  let lookupKeys: (typeof import("../../src/app/services/jira-keys"))["lookupKeys"];
  let clearJiraKeyCache: (typeof import("../../src/app/services/jira-keys"))["clearJiraKeyCache"];

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../../src/app/services/jira-keys");
    lookupKeys = mod.lookupKeys;
    clearJiraKeyCache = mod.clearJiraKeyCache;
    clearJiraKeyCache();
  });

  it("evicts all cached entries so next call fetches again", async () => {
    const issue = makeIssue("PROJ-1");
    const client = makeClient({
      bulkFetch: vi.fn().mockResolvedValue(makeBulkResult([issue])),
    });

    await lookupKeys(["PROJ-1"], client);
    clearJiraKeyCache();
    await lookupKeys(["PROJ-1"], client);

    expect(client.bulkFetch).toHaveBeenCalledTimes(2);
  });
});

// ── detectAndLookupJiraKeys ───────────────────────────────────────────────────

describe("detectAndLookupJiraKeys", () => {
  let detectAndLookupJiraKeys: (typeof import("../../src/app/services/jira-keys"))["detectAndLookupJiraKeys"];
  let clearJiraKeyCache: (typeof import("../../src/app/services/jira-keys"))["clearJiraKeyCache"];

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../../src/app/services/jira-keys");
    detectAndLookupJiraKeys = mod.detectAndLookupJiraKeys;
    clearJiraKeyCache = mod.clearJiraKeyCache;
    clearJiraKeyCache();
  });

  it("extracts Jira keys from issue titles", async () => {
    const issue = makeIssue("PROJ-123");
    const client = makeClient({
      bulkFetch: vi.fn().mockResolvedValue(makeBulkResult([issue])),
    });

    await detectAndLookupJiraKeys(
      [{ title: "Fix PROJ-123: null pointer exception" }],
      client
    );

    expect(client.bulkFetch).toHaveBeenCalledWith(["PROJ-123"]);
  });

  it("extracts Jira keys from PR headRef (branch names)", async () => {
    const issue = makeIssue("FEAT-42");
    const client = makeClient({
      bulkFetch: vi.fn().mockResolvedValue(makeBulkResult([issue])),
    });

    await detectAndLookupJiraKeys(
      [{ title: "Update README", headRef: "feat/FEAT-42-add-widget" }],
      client
    );

    const calls = vi.mocked(client.bulkFetch).mock.calls;
    expect(calls.some((c) => (c[0] as string[]).includes("FEAT-42"))).toBe(true);
  });

  it("deduplicates keys found in multiple items", async () => {
    const client = makeClient({
      bulkFetch: vi.fn().mockResolvedValue(makeBulkResult([])),
    });

    await detectAndLookupJiraKeys(
      [
        { title: "Fix PROJ-1" },
        { title: "Also fixes PROJ-1" },
      ],
      client
    );

    // Should only call bulkFetch once with PROJ-1 (not duplicated)
    const keys = vi.mocked(client.bulkFetch).mock.calls[0]?.[0] as string[];
    expect(keys.filter((k) => k === "PROJ-1")).toHaveLength(1);
  });

  it("returns empty map when no Jira keys are found in titles", async () => {
    const client = makeClient({
      bulkFetch: vi.fn().mockResolvedValue(makeBulkResult([])),
    });

    const result = await detectAndLookupJiraKeys(
      [{ title: "No jira key here" }, { title: "Just a plain PR" }],
      client
    );

    expect(client.bulkFetch).not.toHaveBeenCalled();
    expect(result.size).toBe(0);
  });
});

// ── Cache cap at 500 ──────────────────────────────────────────────────────────

describe("cache cap at 500", () => {
  let lookupKeys: (typeof import("../../src/app/services/jira-keys"))["lookupKeys"];
  let clearJiraKeyCache: (typeof import("../../src/app/services/jira-keys"))["clearJiraKeyCache"];

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../../src/app/services/jira-keys");
    lookupKeys = mod.lookupKeys;
    clearJiraKeyCache = mod.clearJiraKeyCache;
    clearJiraKeyCache();
  });

  it("evicts oldest entry when cache reaches cap (500)", async () => {
    // Fill cache with exactly 500 unique keys (KEY-A-1 ... KEY-A-500)
    const keys500 = Array.from({ length: 500 }, (_, i) => `KEY-A-${i + 1}`);
    const client = makeClient({
      bulkFetch: vi.fn().mockImplementation((ks: string[]) =>
        Promise.resolve(makeBulkResult(ks.map(makeIssue)))
      ),
    });

    // Batch-fill all 500 keys at once — cache is now exactly at cap
    await lookupKeys(keys500, client);

    // Adding a 501st unique key triggers eviction of KEY-A-1 (oldest)
    vi.mocked(client.bulkFetch).mockClear();
    await lookupKeys(["KEY-A-501"], client);

    // Now KEY-A-1 should have been evicted — requesting it again calls bulkFetch
    vi.mocked(client.bulkFetch).mockClear();
    await lookupKeys(["KEY-A-1"], client);

    // KEY-A-1 was evicted, so bulkFetch called again
    expect(client.bulkFetch).toHaveBeenCalledWith(["KEY-A-1"]);
  }, 10000);
});
