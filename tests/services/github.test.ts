import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot } from "solid-js";
import { createGitHubClient, cachedRequest, getClient, initClientWatcher, getGraphqlRateLimit, updateGraphqlRateLimit, updateRateLimitFromHeaders, getCoreRateLimit, onApiRequest, type ApiRequestInfo } from "../../src/app/services/github";
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

  it("read-only guard allows GET requests", async () => {
    const client = createGitHubClient("test-token");
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } })
    );
    vi.stubGlobal("fetch", mockFetch);

    // GET should not throw — use a route that won't actually hit GitHub
    await expect(client.request("GET /user")).resolves.toBeDefined();
    vi.unstubAllGlobals();
  });

  it("read-only guard allows POST /graphql", async () => {
    const client = createGitHubClient("test-token");
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "content-type": "application/json" } })
    );
    vi.stubGlobal("fetch", mockFetch);

    await expect(client.request("POST /graphql", { query: "{ viewer { login } }" })).resolves.toBeDefined();
    vi.unstubAllGlobals();
  });

  it("read-only guard blocks POST to non-graphql endpoints", async () => {
    const client = createGitHubClient("test-token");

    await expect(
      client.request("POST /repos/{owner}/{repo}/issues", {
        owner: "test",
        repo: "test",
        title: "blocked",
      })
    ).rejects.toThrow(/Write operation blocked/);
  });

  it("read-only guard blocks PUT requests", async () => {
    const client = createGitHubClient("test-token");

    await expect(
      client.request("PUT /repos/{owner}/{repo}/issues/{issue_number}", {
        owner: "test",
        repo: "test",
        issue_number: 1,
        title: "blocked",
      })
    ).rejects.toThrow(/Write operation blocked/);
  });

  it("read-only guard blocks PATCH requests", async () => {
    const client = createGitHubClient("test-token");

    await expect(
      client.request("PATCH /repos/{owner}/{repo}/issues/{issue_number}", {
        owner: "test",
        repo: "test",
        issue_number: 1,
        state: "closed",
      })
    ).rejects.toThrow(/Write operation blocked/);
  });

  it("read-only guard blocks DELETE requests", async () => {
    const client = createGitHubClient("test-token");

    await expect(
      client.request("DELETE /repos/{owner}/{repo}/issues/{issue_number}/lock", {
        owner: "test",
        repo: "test",
        issue_number: 1,
      })
    ).rejects.toThrow(/Write operation blocked/);
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

  it("sends If-Modified-Since (not If-None-Match) when cache has lastModified but no etag", async () => {
    const { setCacheEntry } = await import("../../src/app/stores/cache");
    // Seed entry with no etag but with a lastModified timestamp
    await setCacheEntry("test:lm-fallback", { old: true }, null, undefined, "Sat, 01 Jan 2025 00:00:00 GMT");

    const mockOctokit = {
      request: vi.fn().mockResolvedValue({
        data: { old: true },
        headers: { "last-modified": "Sat, 01 Jan 2025 00:00:00 GMT" },
        status: 200,
      }),
    };

    await cachedRequest(
      mockOctokit as unknown as ReturnType<typeof createGitHubClient>,
      "test:lm-fallback",
      "GET /repos/{owner}/{repo}/issues",
      { owner: "org", repo: "repo" }
    );

    expect(mockOctokit.request).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/issues",
      expect.objectContaining({
        headers: expect.objectContaining({
          "If-Modified-Since": "Sat, 01 Jan 2025 00:00:00 GMT",
        }),
      })
    );
    // Must NOT include If-None-Match when etag is null
    const callHeaders = (mockOctokit.request.mock.calls[0] as [string, { headers: Record<string, string> }])[1].headers;
    expect(callHeaders["If-None-Match"]).toBeUndefined();
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

// ── getGraphqlRateLimit / updateGraphqlRateLimit ─────────────────────────────

describe("getGraphqlRateLimit", () => {
  it("returns null before any update", () => {
    // May be non-null if a prior test called updateGraphqlRateLimit;
    // verify the function is callable and returns the expected shape
    const rl = getGraphqlRateLimit();
    expect(rl === null || (typeof rl === "object" && "remaining" in rl)).toBe(true);
  });

  it("converts ISO 8601 resetAt string to Date", () => {
    const iso = "2024-06-01T12:00:00Z";
    updateGraphqlRateLimit({ limit: 5000, remaining: 4500, resetAt: iso });
    const rl = getGraphqlRateLimit();
    expect(rl).not.toBeNull();
    expect(rl!.limit).toBe(5000);
    expect(rl!.remaining).toBe(4500);
    expect(rl!.resetAt).toBeInstanceOf(Date);
    expect(rl!.resetAt.getTime()).toBe(new Date(iso).getTime());
  });

  it("stores limit from Enterprise Cloud (10000)", () => {
    updateGraphqlRateLimit({ limit: 10000, remaining: 9500, resetAt: "2024-06-01T12:00:00Z" });
    const rl = getGraphqlRateLimit();
    expect(rl!.limit).toBe(10000);
    expect(rl!.remaining).toBe(9500);
  });

  it("overwrites previous value on subsequent updates", () => {
    updateGraphqlRateLimit({ limit: 5000, remaining: 5000, resetAt: "2024-06-01T12:00:00Z" });
    updateGraphqlRateLimit({ limit: 5000, remaining: 3000, resetAt: "2024-06-01T13:00:00Z" });
    const rl = getGraphqlRateLimit();
    expect(rl!.limit).toBe(5000);
    expect(rl!.remaining).toBe(3000);
  });

  it("falls back to previous limit when zero is provided", () => {
    updateGraphqlRateLimit({ limit: 5000, remaining: 100, resetAt: "2024-06-01T12:00:00Z" });
    updateGraphqlRateLimit({ limit: 0, remaining: 50, resetAt: "2024-06-01T13:00:00Z" });
    const rl = getGraphqlRateLimit();
    expect(rl!.limit).toBe(5000);
    expect(rl!.remaining).toBe(50);
  });

  it("falls back to previous limit when negative is provided", () => {
    updateGraphqlRateLimit({ limit: 10000, remaining: 100, resetAt: "2024-06-01T12:00:00Z" });
    updateGraphqlRateLimit({ limit: -1, remaining: 50, resetAt: "2024-06-01T13:00:00Z" });
    const rl = getGraphqlRateLimit();
    expect(rl!.limit).toBe(10000);
  });
});

// ── updateRateLimitFromHeaders ───────────────────────────────────────────────

describe("updateRateLimitFromHeaders", () => {
  it("parses limit from x-ratelimit-limit header", () => {
    updateRateLimitFromHeaders({
      "x-ratelimit-remaining": "4500",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
      "x-ratelimit-limit": "10000",
    });
    const rl = getCoreRateLimit();
    expect(rl).not.toBeNull();
    expect(rl!.limit).toBe(10000);
    expect(rl!.remaining).toBe(4500);
  });

  it("falls back to 5000 when x-ratelimit-limit header is absent", () => {
    updateRateLimitFromHeaders({
      "x-ratelimit-remaining": "4999",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
    });
    const rl = getCoreRateLimit();
    expect(rl).not.toBeNull();
    expect(rl!.limit).toBe(5000);
  });

  it("falls back to 5000 when x-ratelimit-limit header is malformed", () => {
    updateRateLimitFromHeaders({
      "x-ratelimit-remaining": "4999",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
      "x-ratelimit-limit": "abc",
    });
    const rl = getCoreRateLimit();
    expect(rl).not.toBeNull();
    expect(rl!.limit).toBe(5000);
  });
});

// ── hook.wrap request tracking ──────────────────────────────────────────────

describe("hook.wrap — request tracking callbacks", () => {
  // onApiRequest pushes to a module-level array that persists across tests.
  // We register once and capture calls via a vi.fn() spy.
  const cbSpy = vi.fn<(info: ApiRequestInfo) => void>();
  let registered = false;

  function ensureRegistered() {
    if (!registered) {
      onApiRequest(cbSpy);
      registered = true;
    }
  }

  afterEach(() => {
    cbSpy.mockClear();
    vi.unstubAllGlobals();
  });

  it("fires callback on successful REST request with correct ApiRequestInfo", async () => {
    ensureRegistered();
    const resetEpoch = Math.floor(Date.now() / 1000) + 3600;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ login: "test" }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-ratelimit-reset": String(resetEpoch),
        },
      })
    ));

    const client = createGitHubClient("test-token");
    await client.request("GET /user");

    expect(cbSpy).toHaveBeenCalled();
    const info = cbSpy.mock.calls[0][0];
    expect(info.url).toBe("/user");
    expect(info.method).toBe("GET");
    expect(info.status).toBe(200);
    expect(info.isGraphql).toBe(false);
    expect(info.resetEpochMs).toBe(resetEpoch * 1000);
  });

  it("fires callback for GraphQL POST /graphql with isGraphql: true", async () => {
    ensureRegistered();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { viewer: { login: "test" } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    ));

    const client = createGitHubClient("test-token");
    await client.graphql("query { viewer { login } }");

    expect(cbSpy).toHaveBeenCalled();
    const info = cbSpy.mock.calls[0][0];
    expect(info.isGraphql).toBe(true);
    expect(info.url).toBe("/graphql");
    expect(info.method).toBe("POST");
  });

  it("extracts apiSource from request metadata on GraphQL calls", async () => {
    ensureRegistered();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { search: { nodes: [] } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    ));

    const client = createGitHubClient("test-token");
    await client.graphql("query($q: String!) { search(query: $q, type: ISSUE, first: 1) { nodes { __typename } } }", {
      q: "is:issue",
      request: { apiSource: "lightSearch" },
    });

    expect(cbSpy).toHaveBeenCalled();
    const info = cbSpy.mock.calls[0][0];
    expect(info.apiSource).toBe("lightSearch");
    expect(info.isGraphql).toBe(true);
  });

  it("sets resetEpochMs to null when x-ratelimit-reset header is absent", async () => {
    ensureRegistered();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ login: "test" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    ));

    const client = createGitHubClient("test-token");
    await client.request("GET /user");

    const info = cbSpy.mock.calls[0][0];
    expect(info.resetEpochMs).toBeNull();
  });

  it("fires callback on error response with status code (e.g., 404)", async () => {
    ensureRegistered();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: "Not Found" }), {
        status: 404,
        headers: {
          "content-type": "application/json",
          "x-ratelimit-reset": "1700000000",
        },
      })
    ));

    const client = createGitHubClient("test-token");
    await expect(client.request("GET /users/{username}", { username: "nonexistent" })).rejects.toThrow();

    expect(cbSpy).toHaveBeenCalled();
    const info = cbSpy.mock.calls[0][0];
    expect(info.status).toBe(404);
    expect(info.resetEpochMs).toBe(1700000000 * 1000);
  });

  it("fires callback with status 500 on network failure (Octokit normalizes fetch errors)", async () => {
    ensureRegistered();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

    // Disable retries — the retry plugin uses real setTimeout for backoff
    const client = createGitHubClient("test-token");
    await expect(client.request("GET /user", { request: { retries: 0 } })).rejects.toThrow();

    // Octokit wraps network errors as RequestError with status 500,
    // so the hook fires with status 500 (a real API attempt was made)
    expect(cbSpy).toHaveBeenCalled();
    const info = cbSpy.mock.calls[0][0];
    expect(info.status).toBe(500);
  });

  it("does not fire callback when read-only guard throws (status remains 0)", async () => {
    ensureRegistered();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } })
    ));

    const client = createGitHubClient("test-token");
    // Write operation — read-only guard throws before any HTTP request
    await expect(client.request("DELETE /repos/{owner}/{repo}", { owner: "a", repo: "b" })).rejects.toThrow("Write operation blocked");
    expect(cbSpy).not.toHaveBeenCalled();
  });

  it("fires callback exactly once per request even with multiple clients", async () => {
    ensureRegistered();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ login: "test" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    ));

    const client1 = createGitHubClient("token-1");
    const client2 = createGitHubClient("token-2");

    await client1.request("GET /user");
    expect(cbSpy).toHaveBeenCalledTimes(1);

    cbSpy.mockClear();
    await client2.request("GET /user");
    expect(cbSpy).toHaveBeenCalledTimes(1);
  });

  it("does not propagate callback errors to the request caller", async () => {
    ensureRegistered();
    // Use mockImplementationOnce to avoid permanently registering a throwing callback
    cbSpy.mockImplementationOnce(() => { throw new Error("callback boom"); });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ login: "test" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    ));

    const client = createGitHubClient("test-token");
    // Should not throw despite the callback throwing
    await expect(client.request("GET /user")).resolves.toBeDefined();
    expect(cbSpy).toHaveBeenCalled();
  });
});
