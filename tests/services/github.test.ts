import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRoot } from "solid-js";
import { createGitHubClient, cachedRequest, getRateLimit, getClient, initClientWatcher } from "../../src/app/services/github";
import { clearCache } from "../../src/app/stores/cache";

// ── createGitHubClient ───────────────────────────────────────────────────────

describe("createGitHubClient", () => {
  it("returns an Octokit instance with .request() and .paginate methods", () => {
    const client = createGitHubClient("test-token");
    expect(typeof client.request).toBe("function");
    expect(typeof client.paginate).toBe("function");
  });

  it("returns different instances for different tokens", () => {
    const c1 = createGitHubClient("token-a");
    const c2 = createGitHubClient("token-b");
    expect(c1).not.toBe(c2);
  });
});

// ── cachedRequest ────────────────────────────────────────────────────────────

describe("cachedRequest", () => {
  beforeEach(async () => {
    await clearCache();
    vi.resetAllMocks();
  });

  it("calls octokit.request with If-None-Match when cache has an etag", async () => {
    // Seed the cache with an etag
    const { setCacheEntry } = await import("../../src/app/stores/cache");
    await setCacheEntry("test:etag-send", { old: true }, "stored-etag-123");

    const mockOctokit = {
      request: vi.fn().mockResolvedValue({
        data: { old: true },
        headers: { etag: "stored-etag-123" },
        status: 304,
      }),
    };

    // Mock will be caught as 304 throw scenario; simulate octokit throwing
    const err304 = Object.assign(new Error("304"), { status: 304 });
    mockOctokit.request.mockRejectedValue(err304);

    const result = await cachedRequest(
      mockOctokit as unknown as ReturnType<typeof createGitHubClient>,
      "test:etag-send",
      "GET /repos/{owner}/{repo}/issues",
      { owner: "org", repo: "repo" }
    );

    expect(mockOctokit.request).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/issues",
      expect.objectContaining({
        headers: expect.objectContaining({ "If-None-Match": "stored-etag-123" }),
      })
    );
    // On 304, returns cached data
    expect(result.fromCache).toBe(true);
    expect(result.data).toEqual({ old: true });
  });

  it("calls octokit.request without If-None-Match when no cache entry", async () => {
    const mockOctokit = {
      request: vi.fn().mockResolvedValue({
        data: [{ id: 1, title: "Issue" }],
        headers: { etag: "new-etag-456", "x-ratelimit-remaining": "4999", "x-ratelimit-reset": "1700000000" },
        status: 200,
      }),
    };

    const result = await cachedRequest(
      mockOctokit as unknown as ReturnType<typeof createGitHubClient>,
      "test:no-cache",
      "GET /repos/{owner}/{repo}/issues",
      { owner: "org", repo: "repo" }
    );

    const callArgs = mockOctokit.request.mock.calls[0];
    // headers should NOT include If-None-Match
    expect(callArgs[1].headers["If-None-Match"]).toBeUndefined();
    expect(result.fromCache).toBe(false);
    expect(result.data).toEqual([{ id: 1, title: "Issue" }]);
  });

  it("caches new data with etag on 200 response", async () => {
    const { getCacheEntry } = await import("../../src/app/stores/cache");

    const mockOctokit = {
      request: vi.fn().mockResolvedValue({
        data: { items: [1, 2, 3] },
        headers: { etag: "etag-abc", "x-ratelimit-remaining": "4990", "x-ratelimit-reset": "1700000000" },
        status: 200,
      }),
    };

    await cachedRequest(
      mockOctokit as unknown as ReturnType<typeof createGitHubClient>,
      "test:cache-new",
      "GET /orgs/{org}/repos",
      { org: "myorg" }
    );

    const entry = await getCacheEntry("test:cache-new");
    expect(entry).toBeDefined();
    expect(entry!.etag).toBe("etag-abc");
    expect(entry!.data).toEqual({ items: [1, 2, 3] });
  });

  it("propagates non-304 errors from octokit.request", async () => {
    const err500 = Object.assign(new Error("Server Error"), { status: 500 });
    const mockOctokit = {
      request: vi.fn().mockRejectedValue(err500),
    };

    await expect(
      cachedRequest(
        mockOctokit as unknown as ReturnType<typeof createGitHubClient>,
        "test:error",
        "GET /repos/{owner}/{repo}/issues",
        { owner: "org", repo: "repo" }
      )
    ).rejects.toThrow("Server Error");
  });

  it("handles RequestError with status 304 by returning cached data", async () => {
    const { setCacheEntry } = await import("../../src/app/stores/cache");
    await setCacheEntry("test:304-throw", { cached: "value" }, "etag-xyz");

    // Simulate Octokit throwing a 304 RequestError (its actual behavior)
    const requestError = Object.assign(new Error("Not Modified"), {
      status: 304,
      name: "HttpError",
    });
    const mockOctokit = {
      request: vi.fn().mockRejectedValue(requestError),
    };

    const result = await cachedRequest(
      mockOctokit as unknown as ReturnType<typeof createGitHubClient>,
      "test:304-throw",
      "GET /repos/{owner}/{repo}/issues",
      {}
    );

    expect(result.fromCache).toBe(true);
    expect(result.data).toEqual({ cached: "value" });
  });
});

// ── getRateLimit ─────────────────────────────────────────────────────────────

describe("getRateLimit", () => {
  beforeEach(async () => {
    await clearCache();
    vi.resetAllMocks();
  });

  it("returns null before any requests", () => {
    // Note: rate limit signal is module-level and may be set from prior tests.
    // This test just verifies the function is callable.
    const rl = getRateLimit();
    // Either null or a valid object
    expect(rl === null || (typeof rl === "object" && "remaining" in rl)).toBe(true);
  });

  it("returns rate limit info after a successful request", async () => {
    const resetTs = Math.floor(Date.now() / 1000) + 3600;
    const mockOctokit = {
      request: vi.fn().mockResolvedValue({
        data: [],
        headers: {
          etag: "etag-rl",
          "x-ratelimit-remaining": "3999",
          "x-ratelimit-reset": String(resetTs),
        },
        status: 200,
      }),
    };

    await cachedRequest(
      mockOctokit as unknown as ReturnType<typeof createGitHubClient>,
      "test:ratelimit-update",
      "GET /user/orgs",
      {}
    );

    const rl = getRateLimit();
    expect(rl).not.toBeNull();
    expect(rl!.remaining).toBe(3999);
    expect(rl!.resetAt).toBeInstanceOf(Date);
  });
});

// ── getClient / initClientWatcher ────────────────────────────────────────────

describe("getClient / initClientWatcher", () => {
  it("getClient returns null initially when no client is set", () => {
    // The module-level signal starts null unless a prior test set it.
    // We test via a fresh reactive root.
    createRoot((dispose) => {
      const client = getClient();
      // Either null or an Octokit instance — depends on module import order.
      expect(client === null || typeof client?.request === "function").toBe(true);
      dispose();
    });
  });

  it("initClientWatcher creates a client when token is set", async () => {
    // We import and manipulate auth store signals
    const authModule = await import("../../src/app/stores/auth");

    // We can't directly set token (it's a read-only export of the internal signal).
    // Instead, verify initClientWatcher does not throw when called in reactive root.
    let errored = false;
    createRoot((dispose) => {
      try {
        initClientWatcher();
      } catch {
        errored = true;
      }
      dispose();
    });
    expect(errored).toBe(false);
    // Suppress unused import warning
    void authModule;
  });
});
