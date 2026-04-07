/**
 * True data pipeline integration test.
 *
 * Exercises the full fetch → cachedRequest → IDB → return pipeline.
 * Only the HTTP layer (octokit.request / octokit.graphql) is mocked.
 * Cache (cachedFetch, cachedRequest) and IDB (via fake-indexeddb) are real.
 *
 * Pipeline under test:
 *   fetchWorkflowRuns → cachedRequest → cachedFetch → IDB (fake-indexeddb)
 */
import "fake-indexeddb/auto"; // Must be first import
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { fetchWorkflowRuns, type RepoRef } from "../../src/app/services/api";
import { clearCache, getCacheEntry } from "../../src/app/stores/cache";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const testRepo: RepoRef = {
  owner: "octocat",
  name: "Hello-World",
  fullName: "octocat/Hello-World",
};

const rawRun = {
  id: 9001,
  name: "CI",
  status: "completed",
  conclusion: "success",
  event: "push",
  workflow_id: 101,
  head_sha: "abc1234",
  head_branch: "main",
  run_number: 1,
  run_attempt: 1,
  html_url: "https://github.com/octocat/Hello-World/actions/runs/9001",
  created_at: "2024-01-15T09:00:00Z",
  updated_at: "2024-01-15T09:10:00Z",
  run_started_at: "2024-01-15T09:00:00Z",
  completed_at: "2024-01-15T09:10:00Z",
  display_title: "CI",
  actor: { login: "octocat", avatar_url: "https://avatars.githubusercontent.com/u/583231?v=4" },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

type OctokitLike = {
  request: ReturnType<typeof vi.fn>;
  graphql: ReturnType<typeof vi.fn>;
  paginate: { iterator: ReturnType<typeof vi.fn> };
};

function makeOctokit(
  requestImpl: (route: string, params?: unknown) => Promise<unknown>,
): OctokitLike {
  return {
    request: vi.fn(requestImpl),
    graphql: vi.fn(async () => ({})),
    paginate: { iterator: vi.fn() },
  };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(async () => {
  await clearCache();
  vi.resetAllMocks();
});

afterAll(async () => {
  await clearCache();
});

// ── Test suite ────────────────────────────────────────────────────────────────

describe("data pipeline: fetch → IDB cache → return", () => {
  /**
   * Test 1 — Fresh fetch.
   * First call with no cache entry: API returns data, pipeline stores it in IDB
   * and returns correctly-shaped output.
   */
  it("fresh fetch: API data flows through cachedRequest into IDB and is returned", async () => {
    const octokit = makeOctokit(async (route) => {
      if (route === "GET /repos/{owner}/{repo}/actions/runs") {
        return {
          data: { workflow_runs: [rawRun], total_count: 1 },
          headers: { etag: '"etag-v1"' },
        };
      }
      return { data: { workflow_runs: [], total_count: 0 }, headers: {} };
    });

    const { workflowRuns, errors } = await fetchWorkflowRuns(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      5,
      3
    );

    // Data should be returned correctly
    expect(errors).toEqual([]);
    expect(workflowRuns).toHaveLength(1);
    expect(workflowRuns[0].id).toBe(9001);
    expect(workflowRuns[0].name).toBe("CI");
    expect(workflowRuns[0].repoFullName).toBe("octocat/Hello-World");

    // IDB should have been written with the ETag
    const cacheEntry = await getCacheEntry("runs:octocat/Hello-World:p1");
    expect(cacheEntry).toBeDefined();
    expect(cacheEntry!.etag).toBe('"etag-v1"');
    expect((cacheEntry!.data as { workflow_runs: unknown[] }).workflow_runs).toHaveLength(1);
  });

  /**
   * Test 2 — Cached fetch (ETag / 304).
   * Second call sends If-None-Match; API throws 304 (Octokit behavior).
   * Pipeline returns data from IDB without re-storing it.
   */
  it("cached fetch (ETag/304): second call uses If-None-Match and serves data from IDB", async () => {
    // First call populates IDB
    const firstOctokit = makeOctokit(async () => ({
      data: { workflow_runs: [rawRun], total_count: 1 },
      headers: { etag: '"etag-v1"' },
    }));

    await fetchWorkflowRuns(
      firstOctokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      5,
      3
    );

    // Second call: Octokit throws 304 (Not Modified)
    const err304 = Object.assign(new Error("Not Modified"), { status: 304 });
    const secondOctokit = makeOctokit(async () => {
      throw err304;
    });

    const { workflowRuns, errors } = await fetchWorkflowRuns(
      secondOctokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      5,
      3
    );

    // Data comes from IDB cache
    expect(errors).toEqual([]);
    expect(workflowRuns).toHaveLength(1);
    expect(workflowRuns[0].id).toBe(9001);

    // Second octokit should have sent If-None-Match
    const callArgs = secondOctokit.request.mock.calls[0];
    const headers = (callArgs[1] as { headers: Record<string, string> }).headers;
    expect(headers["If-None-Match"]).toBe('"etag-v1"');
  });

  /**
   * Test 3 — Cache miss after eviction.
   * After clearCache(), the next fetch goes back to the API.
   */
  it("cache miss after eviction: re-fetches from API when IDB is cleared", async () => {
    // Seed IDB via first fetch
    const firstOctokit = makeOctokit(async () => ({
      data: { workflow_runs: [rawRun], total_count: 1 },
      headers: { etag: '"etag-v1"' },
    }));

    await fetchWorkflowRuns(
      firstOctokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      5,
      3
    );

    // Verify it's in IDB
    expect(await getCacheEntry("runs:octocat/Hello-World:p1")).toBeDefined();

    // Evict the cache
    await clearCache();
    expect(await getCacheEntry("runs:octocat/Hello-World:p1")).toBeUndefined();

    // Second fetch should go back to API (no 304 this time)
    const updatedRun = { ...rawRun, id: 9002, run_number: 2 };
    const secondOctokit = makeOctokit(async () => ({
      data: { workflow_runs: [updatedRun], total_count: 1 },
      headers: { etag: '"etag-v2"' },
    }));

    const { workflowRuns, errors } = await fetchWorkflowRuns(
      secondOctokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      5,
      3
    );

    // Returns fresh data from API, not stale cached data
    expect(errors).toEqual([]);
    expect(workflowRuns).toHaveLength(1);
    expect(workflowRuns[0].id).toBe(9002);

    // New ETag stored in IDB
    const entry = await getCacheEntry("runs:octocat/Hello-World:p1");
    expect(entry!.etag).toBe('"etag-v2"');

    // Second call should NOT have sent If-None-Match (cache was empty)
    const callArgs = secondOctokit.request.mock.calls[0];
    const headers = (callArgs[1] as { headers: Record<string, string> }).headers;
    expect(headers["If-None-Match"]).toBeUndefined();
  });

  /**
   * Test 4 — Error handling.
   * API returns a 5xx error; pipeline surfaces it as an ApiError and does NOT
   * write a cache entry to IDB.
   */
  it("error handling: API 5xx error surfaces as ApiError without caching", async () => {
    const err500 = Object.assign(new Error("Internal Server Error"), { status: 500 });
    const octokit = makeOctokit(async () => {
      throw err500;
    });

    const { workflowRuns, errors } = await fetchWorkflowRuns(
      octokit as unknown as ReturnType<typeof import("../../src/app/services/github").getClient>,
      [testRepo],
      5,
      3
    );

    // No data returned
    expect(workflowRuns).toEqual([]);

    // Error is surfaced
    expect(errors).toHaveLength(1);
    expect(errors[0].statusCode).toBe(500);
    expect(errors[0].retryable).toBe(true);

    // IDB should NOT have been written
    const entry = await getCacheEntry("runs:octocat/Hello-World:p1");
    expect(entry).toBeUndefined();
  });
});
