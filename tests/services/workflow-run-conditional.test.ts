import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { clearCache, getCacheEntry } from "../../src/app/stores/cache";
import { fetchWorkflowRunById } from "../../src/app/services/api";

vi.mock("../../src/app/lib/dashboard-snapshot", () => ({
  clearSnapshot: vi.fn().mockResolvedValue(undefined),
  loadSnapshot: vi.fn().mockResolvedValue(null),
  writeSnapshot: vi.fn(),
  flushSnapshot: vi.fn().mockResolvedValue(undefined),
}));

describe("fetchWorkflowRunById conditional ETag requests", () => {
  beforeEach(async () => {
    await clearCache();
    vi.clearAllMocks();
  });

  it("sends no If-None-Match on the first call, sends the stored ETag on the second, returns the cached mapped update on 304, and deletes the cache entry on completed status", async () => {
    const rawInProgress = {
      id: 101,
      status: "in_progress",
      conclusion: null,
      updated_at: "2026-11-01T15:52:22Z",
      completed_at: null,
    };

    const requestFn = vi.fn().mockResolvedValueOnce({
      data: rawInProgress,
      headers: { etag: 'W/"etag-run-101"' },
      status: 200,
    });
    const octokit = { request: requestFn } as never;
    const descriptor = { id: 101, owner: "org", repo: "repo" };
    const cacheKey = "run:org/repo:101";

    // 1. First call: no If-None-Match header sent; ETag + payload stored in IndexedDB
    const first = await fetchWorkflowRunById(octokit, descriptor);
    expect(requestFn).toHaveBeenCalledTimes(1);
    expect(requestFn).toHaveBeenNthCalledWith(
      1,
      "GET /repos/{owner}/{repo}/actions/runs/{run_id}",
      {
        owner: "org",
        repo: "repo",
        run_id: 101,
        headers: {},
      },
    );
    expect(first).toEqual({
      id: 101,
      status: "in_progress",
      conclusion: null,
      updatedAt: "2026-11-01T15:52:22Z",
      completedAt: null,
    });

    const cachedAfterFirst = await getCacheEntry(cacheKey);
    expect(cachedAfterFirst).toBeDefined();
    expect(cachedAfterFirst?.etag).toBe('W/"etag-run-101"');

    // 2. Second call: sends stored If-None-Match; 304 returns the cached mapped update
    const err304 = Object.assign(new Error("Not Modified"), { status: 304 });
    requestFn.mockRejectedValueOnce(err304);

    const second = await fetchWorkflowRunById(octokit, descriptor);
    expect(requestFn).toHaveBeenCalledTimes(2);
    expect(requestFn).toHaveBeenNthCalledWith(
      2,
      "GET /repos/{owner}/{repo}/actions/runs/{run_id}",
      {
        owner: "org",
        repo: "repo",
        run_id: 101,
        headers: { "If-None-Match": 'W/"etag-run-101"' },
      },
    );
    expect(second).toEqual({
      id: 101,
      status: "in_progress",
      conclusion: null,
      updatedAt: "2026-11-01T15:52:22Z",
      completedAt: null,
    });
    expect(await getCacheEntry(cacheKey)).toBeDefined();

    // 3. Third call: run completes with 200 -> returns mapped completed update and deletes cache entry
    requestFn.mockResolvedValueOnce({
      data: {
        id: 101,
        status: "completed",
        conclusion: "success",
        updated_at: "2026-11-01T15:54:33Z",
        completed_at: "2026-11-01T15:54:33Z",
      },
      headers: { etag: 'W/"etag-run-101-completed"' },
      status: 200,
    });

    const third = await fetchWorkflowRunById(octokit, descriptor);
    expect(requestFn).toHaveBeenCalledTimes(3);
    expect(requestFn).toHaveBeenNthCalledWith(
      3,
      "GET /repos/{owner}/{repo}/actions/runs/{run_id}",
      {
        owner: "org",
        repo: "repo",
        run_id: 101,
        headers: { "If-None-Match": 'W/"etag-run-101"' },
      },
    );
    expect(third).toEqual({
      id: 101,
      status: "completed",
      conclusion: "success",
      updatedAt: "2026-11-01T15:54:33Z",
      completedAt: "2026-11-01T15:54:33Z",
    });

    // Terminal status deletes the entry from IndexedDB
    expect(await getCacheEntry(cacheKey)).toBeUndefined();
  });
});
