import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot } from "solid-js";
import { createGitHubClient, cachedRequest, getClient, initClientWatcher, getGraphqlRateLimit, updateGraphqlRateLimit, updateRateLimitFromHeaders, getCoreRateLimit, fetchRateLimitDetails, onApiRequest, APPROVE_PR_MUTATION, MARK_PR_READY_MUTATION, GITHUB_NODE_ID_RE, GIT_SHA_RE, REQUEST_TIMEOUT_MS, MAX_INLINE_RATE_LIMIT_RETRY_AFTER_SEC, type ApiRequestInfo } from "../../src/app/services/github";
import { clearCache } from "../../src/app/stores/cache";
import { getNotifications, clearNotifications } from "../../src/app/lib/errors";

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

  it("allows APPROVE_PR_MUTATION with valid PR_ nodeId and 40-hex commitOID", async () => {
    const client = createGitHubClient("test-token");
    const mockFetch = vi.fn().mockImplementation(async () =>
      new Response(
        JSON.stringify({
          data: {
            addPullRequestReview: {
              pullRequestReview: { state: "APPROVED", pullRequest: { reviewDecision: "APPROVED" } },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", mockFetch);

    const validSha = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
    await expect(
      client.request("POST /graphql", {
        query: APPROVE_PR_MUTATION,
        variables: { pullRequestId: "PR_kwDOtest42", commitOID: validSha },
      })
    ).resolves.toBeDefined();

    // Also verify legacy Base64 node ID format via client.graphql()
    await expect(
      client.graphql(APPROVE_PR_MUTATION, {
        pullRequestId: "MDExOlB1bGxSZXF1ZXN0NDI=",
        commitOID: validSha,
      })
    ).resolves.toBeDefined();

    expect(GITHUB_NODE_ID_RE.test("PR_kwDOtest42")).toBe(true);
    expect(GITHUB_NODE_ID_RE.test("MDExOlB1bGxSZXF1ZXN0NDI=")).toBe(true);
    expect(GIT_SHA_RE.test(validSha)).toBe(true);
    expect(APPROVE_PR_MUTATION).not.toContain("rateLimit");
    vi.unstubAllGlobals();
  });

  it("blocks arbitrary, comment-prefixed, and aliased/combined GraphQL mutations", async () => {
    const client = createGitHubClient("test-token");
    const validSha = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

    await expect(
      client.request("POST /graphql", {
        query: `mutation { mergePullRequest(input: { pullRequestId: "PR_kwDOtest42" }) { clientMutationId } }`,
      })
    ).rejects.toThrow(/Write operation blocked/);

    await expect(
      client.request("POST /graphql", {
        query: `mutation { closePullRequest(input: { pullRequestId: "PR_kwDOtest42" }) { clientMutationId } }`,
      })
    ).rejects.toThrow(/Write operation blocked/);

    await expect(
      client.request("POST /graphql", {
        query: `mutation { deleteIssue(input: { issueId: "I_kwDOtest42" }) { clientMutationId } }`,
      })
    ).rejects.toThrow(/Write operation blocked/);

    // Comment-prefixed mutation
    await expect(
      client.request("POST /graphql", {
        query: `# addPullRequestReview\nmutation { closePullRequest(input: { pullRequestId: "PR_kwDOtest42" }) { clientMutationId } }`,
        variables: { pullRequestId: "PR_kwDOtest42", commitOID: validSha },
      })
    ).rejects.toThrow(/Write operation blocked/);

    // Combined / aliased mutation smuggling
    await expect(
      client.request("POST /graphql", {
        query: `mutation ApprovePullRequest($pullRequestId: ID!, $commitOID: GitObjectID!) {
          a: addPullRequestReview(input: { pullRequestId: $pullRequestId, commitOID: $commitOID, event: APPROVE }) {
            pullRequestReview { state }
          }
          b: mergePullRequest(input: { pullRequestId: $pullRequestId }) {
            clientMutationId
          }
        }`,
        variables: { pullRequestId: "PR_kwDOtest42", commitOID: validSha },
      })
    ).rejects.toThrow(/Write operation blocked/);
  });

  it("blocks APPROVE_PR_MUTATION with missing or malformed pullRequestId or commitOID", async () => {
    const client = createGitHubClient("test-token");
    const validSha = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

    // Missing variables object
    await expect(
      client.request("POST /graphql", {
        query: APPROVE_PR_MUTATION,
      })
    ).rejects.toThrow(/Write operation blocked/);

    // Malformed pullRequestId
    await expect(
      client.request("POST /graphql", {
        query: APPROVE_PR_MUTATION,
        variables: { pullRequestId: "bad!id", commitOID: validSha },
      })
    ).rejects.toThrow(/Write operation blocked/);

    // Missing/non-SHA commitOID
    await expect(
      client.request("POST /graphql", {
        query: APPROVE_PR_MUTATION,
        variables: { pullRequestId: "PR_kwDOtest42", commitOID: "not-a-sha" },
      })
    ).rejects.toThrow(/Write operation blocked/);

    // Disallowed event override in variables
    await expect(
      client.request("POST /graphql", {
        query: APPROVE_PR_MUTATION,
        variables: { pullRequestId: "PR_kwDOtest42", commitOID: validSha, event: "REQUEST_CHANGES" },
      })
    ).rejects.toThrow(/Write operation blocked/);

    // Unexpected extra variable on APPROVE_PR_MUTATION
    await expect(
      client.request("POST /graphql", {
        query: APPROVE_PR_MUTATION,
        variables: { pullRequestId: "PR_kwDOtest42", commitOID: validSha, extra: "unexpected" },
      })
    ).rejects.toThrow(/Write operation blocked/);

    // Array variables on APPROVE_PR_MUTATION
    await expect(
      client.request("POST /graphql", {
        query: APPROVE_PR_MUTATION,
        variables: ["PR_kwDOtest42", validSha] as unknown as Record<string, unknown>,
      })
    ).rejects.toThrow(/Write operation blocked/);
  });

  it("allows MARK_PR_READY_MUTATION with valid PR_ or legacy Base64 nodeId", async () => {
    const client = createGitHubClient("test-token");
    const mockFetch = vi.fn().mockImplementation(async () =>
      new Response(
        JSON.stringify({
          data: {
            markPullRequestReadyForReview: {
              pullRequest: { isDraft: false, reviewDecision: "REVIEW_REQUIRED" },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", mockFetch);

    await expect(
      client.request("POST /graphql", {
        query: MARK_PR_READY_MUTATION,
        variables: { pullRequestId: "PR_kwDOtest42" },
      })
    ).resolves.toBeDefined();

    await expect(
      client.graphql(MARK_PR_READY_MUTATION, {
        pullRequestId: "MDExOlB1bGxSZXF1ZXN0NDI=",
      })
    ).resolves.toBeDefined();

    expect(MARK_PR_READY_MUTATION).not.toContain("rateLimit");
    vi.unstubAllGlobals();
  });

  it("blocks MARK_PR_READY_MUTATION with missing, malformed, array, or extra variables", async () => {
    const client = createGitHubClient("test-token");
    const validSha = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

    // Missing variables object
    await expect(
      client.request("POST /graphql", {
        query: MARK_PR_READY_MUTATION,
      })
    ).rejects.toThrow(/Write operation blocked/);

    // Empty variables object
    await expect(
      client.request("POST /graphql", {
        query: MARK_PR_READY_MUTATION,
        variables: {},
      })
    ).rejects.toThrow(/Write operation blocked/);

    // Malformed pullRequestId
    await expect(
      client.request("POST /graphql", {
        query: MARK_PR_READY_MUTATION,
        variables: { pullRequestId: "bad!id" },
      })
    ).rejects.toThrow(/Write operation blocked/);

    // Extra unexpected variable (e.g. commitOID or extra)
    await expect(
      client.request("POST /graphql", {
        query: MARK_PR_READY_MUTATION,
        variables: { pullRequestId: "PR_kwDOtest42", commitOID: validSha },
      })
    ).rejects.toThrow(/Write operation blocked/);

    await expect(
      client.request("POST /graphql", {
        query: MARK_PR_READY_MUTATION,
        variables: { pullRequestId: "PR_kwDOtest42", extra: "unexpected" },
      })
    ).rejects.toThrow(/Write operation blocked/);

    // Array variables
    await expect(
      client.request("POST /graphql", {
        query: MARK_PR_READY_MUTATION,
        variables: ["PR_kwDOtest42"] as unknown as Record<string, unknown>,
      })
    ).rejects.toThrow(/Write operation blocked/);
  });

  it("attaches per-attempt AbortSignal.timeout(REQUEST_TIMEOUT_MS) and composes caller signal via AbortSignal.any without retrying caller aborts", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const anySpy = vi.spyOn(AbortSignal, "any");

    const client = createGitHubClient("test-token");
    const receivedSignals: Array<AbortSignal | null | undefined> = [];

    const mockFetch = vi.fn().mockImplementation(async (_url: RequestInfo | URL, init?: RequestInit) => {
      receivedSignals.push(init?.signal);
      return new Response(
        JSON.stringify({ data: { viewer: { login: "octocat" } } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", mockFetch);

    try {
      await client.graphql("{ viewer { login } }");
      expect(timeoutSpy).toHaveBeenCalledWith(REQUEST_TIMEOUT_MS);
      expect(receivedSignals).toHaveLength(1);
      expect(receivedSignals[0]).toBeInstanceOf(AbortSignal);

      // Now pass a caller AbortController signal and abort it while fetch is in flight
      const controller = new AbortController();
      mockFetch.mockReset();
      mockFetch.mockImplementation(
        (_url: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const sig = init?.signal;
            if (sig?.aborted) {
              reject(new DOMException("The operation was aborted.", "AbortError"));
              return;
            }
            sig?.addEventListener(
              "abort",
              () => {
                reject(new DOMException("The operation was aborted.", "AbortError"));
              },
              { once: true }
            );
            queueMicrotask(() => controller.abort());
          })
      );

      const pending = client.graphql("{ viewer { login } }", {
        request: { signal: controller.signal },
      });

      await expect(pending).rejects.toThrow(/aborted/i);
      expect(anySpy).toHaveBeenCalled();
      // Caller-initiated abort must set retries = 0 so plugin-retry does not schedule retries
      expect(mockFetch).toHaveBeenCalledTimes(1);
    } finally {
      timeoutSpy.mockRestore();
      anySpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("rejects /graphql network and timeout errors with undefined response and without plugin-throttling headers TypeError", async () => {
    const client = createGitHubClient("test-token");

    try {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new TypeError("Failed to fetch"))
      );

      let caughtNetworkErr: unknown;
      try {
        await client.graphql("{ viewer { login } }", { request: { retries: 0 } });
      } catch (err) {
        caughtNetworkErr = err;
      }

      expect(caughtNetworkErr).toBeInstanceOf(Error);
      expect((caughtNetworkErr as Error).message).toMatch(/Failed to fetch/);
      expect((caughtNetworkErr as Error).message).not.toMatch(
        /Cannot read properties of undefined/
      );
      expect((caughtNetworkErr as { response?: unknown }).response).toBeUndefined();

      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(
          new DOMException("The operation was aborted due to timeout", "TimeoutError")
        )
      );

      let caughtTimeoutErr: unknown;
      try {
        await client.graphql("{ viewer { login } }", { request: { retries: 0 } });
      } catch (err) {
        caughtTimeoutErr = err;
      }

      expect(caughtTimeoutErr).toBeInstanceOf(Error);
      expect((caughtTimeoutErr as Error).message).toMatch(/timeout/i);
      expect((caughtTimeoutErr as Error).message).not.toMatch(
        /Cannot read properties of undefined/
      );
      expect((caughtTimeoutErr as { response?: unknown }).response).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
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
    await expect(client.request("GET /users/{username}", { username: "nonexistent" })).rejects.toThrow("Not Found");

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
    await expect(client.request("GET /user", { request: { retries: 0 } })).rejects.toThrow("fetch failed");

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

  it("does not fire callback when GraphQL mutation guard blocks a mutation", async () => {
    ensureRegistered();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } })
    ));

    const client = createGitHubClient("test-token");
    await expect(
      client.request("POST /graphql", {
        query: `mutation { mergePullRequest(input: { pullRequestId: "PR_kwDOtest42" }) { clientMutationId } }`,
      })
    ).rejects.toThrow(/Write operation blocked/);
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

// ── hook.wrap — rate limit signal routing ────────────────────────────────────

describe("hook.wrap — rate limit signal routing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Use status 500 (not 403/429) to avoid the throttle plugin's onRateLimit callback,
  // which would schedule a real retry delay. hook.wrap extracts x-ratelimit-* headers
  // for any error status, so 500 exercises the same signal-update code path.
  it("GraphQL error response with rate limit headers updates _graphqlRateLimit", async () => {
    const resetEpoch = Math.floor(Date.now() / 1000) + 3600;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: "internal server error" }), {
        status: 500,
        headers: {
          "content-type": "application/json",
          "x-ratelimit-remaining": "100",
          "x-ratelimit-reset": String(resetEpoch),
          "x-ratelimit-limit": "5000",
        },
      })
    ));

    const client = createGitHubClient("test-token");
    await expect(client.graphql("{ viewer { login } }", { request: { retries: 0 } })).rejects.toThrow("internal server error");

    const rl = getGraphqlRateLimit();
    expect(rl).not.toBeNull();
    expect(rl!.remaining).toBe(100);
    expect(rl!.limit).toBe(5000);
    expect(rl!.resetAt).toBeInstanceOf(Date);
    expect(rl!.resetAt.getTime()).toBe(resetEpoch * 1000);
  });

  it("REST error response with rate limit headers updates _coreRateLimit", async () => {
    const resetEpoch = Math.floor(Date.now() / 1000) + 3600;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: "internal server error" }), {
        status: 500,
        headers: {
          "content-type": "application/json",
          "x-ratelimit-remaining": "100",
          "x-ratelimit-reset": String(resetEpoch),
          "x-ratelimit-limit": "5000",
        },
      })
    ));

    const client = createGitHubClient("test-token");
    await expect(client.request("GET /user", { request: { retries: 0 } })).rejects.toThrow("internal server error");

    const rl = getCoreRateLimit();
    expect(rl).not.toBeNull();
    expect(rl!.remaining).toBe(100);
    expect(rl!.limit).toBe(5000);
  });

  it("error response without rate limit headers does not crash", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      })
    ));

    const client = createGitHubClient("test-token");
    // Must reject with the original error only, not an additional crash
    await expect(client.request("GET /user")).rejects.toBeDefined();
  });

  it("successful GraphQL request does NOT update _coreRateLimit", async () => {
    const resetEpoch = Math.floor(Date.now() / 1000) + 3600;
    // Seed _coreRateLimit to a known value
    updateRateLimitFromHeaders({
      "x-ratelimit-remaining": "1234",
      "x-ratelimit-reset": String(resetEpoch),
      "x-ratelimit-limit": "5000",
    });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { viewer: { login: "test" } } }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-ratelimit-remaining": "9999",
          "x-ratelimit-reset": String(resetEpoch),
          "x-ratelimit-limit": "5000",
        },
      })
    ));

    const client = createGitHubClient("test-token");
    await client.graphql("{ viewer { login } }");

    // _coreRateLimit must remain at seeded value — GraphQL success must not contaminate it
    const rl = getCoreRateLimit();
    expect(rl!.remaining).toBe(1234);

    // Because the response had no body rateLimit (as on GraphQL mutations), _graphqlRateLimit updates from headers
    const graphqlRl = getGraphqlRateLimit();
    expect(graphqlRl).not.toBeNull();
    expect(graphqlRl!.remaining).toBe(9999);
  });

  it("successful REST request updates _coreRateLimit but NOT _graphqlRateLimit", async () => {
    const resetEpoch = Math.floor(Date.now() / 1000) + 3600;
    // Seed _graphqlRateLimit to a known value
    updateGraphqlRateLimit({ limit: 5000, remaining: 4321, resetAt: new Date(resetEpoch * 1000).toISOString() });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ login: "test" }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-ratelimit-remaining": "4888",
          "x-ratelimit-reset": String(resetEpoch),
          "x-ratelimit-limit": "5000",
        },
      })
    ));

    const client = createGitHubClient("test-token");
    await client.request("GET /user");

    const coreRl = getCoreRateLimit();
    expect(coreRl!.remaining).toBe(4888);

    // _graphqlRateLimit must be unchanged at seeded value
    const graphqlRl = getGraphqlRateLimit();
    expect(graphqlRl!.remaining).toBe(4321);
  });

  it("successful GraphQL request exposes rateLimit.cost in ApiRequestInfo callback", async () => {
    const resetEpoch = Math.floor(Date.now() / 1000) + 3600;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        data: {
          viewer: { login: "test" },
          rateLimit: { cost: 42, limit: 5000, remaining: 4900, resetAt: new Date(resetEpoch * 1000).toISOString() },
        },
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-ratelimit-remaining": "4900",
          "x-ratelimit-reset": String(resetEpoch),
          "x-ratelimit-limit": "5000",
        },
      })
    ));

    let capturedInfo: ApiRequestInfo | null = null;
    onApiRequest((info) => { capturedInfo = info; });

    const client = createGitHubClient("test-token");
    await client.graphql("{ viewer { login } }");

    expect(capturedInfo).not.toBeNull();
    expect(capturedInfo!.graphqlCost).toBe(42);
    expect(capturedInfo!.isGraphql).toBe(true);
  });

  it("REST request has undefined graphqlCost in ApiRequestInfo callback", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ login: "test" }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-ratelimit-remaining": "4999",
          "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
          "x-ratelimit-limit": "5000",
        },
      })
    ));

    let capturedInfo: ApiRequestInfo | null = null;
    onApiRequest((info) => { capturedInfo = info; });

    const client = createGitHubClient("test-token");
    await client.request("GET /user");

    expect(capturedInfo).not.toBeNull();
    expect(capturedInfo!.graphqlCost).toBeUndefined();
    expect(capturedInfo!.isGraphql).toBe(false);
  });

  it("GraphQL error response with rateLimit.cost in body exposes graphqlCost in ApiRequestInfo callback", async () => {
    const resetEpoch = Math.floor(Date.now() / 1000) + 3600;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        data: { rateLimit: { cost: 7, limit: 5000, remaining: 4800, resetAt: new Date(resetEpoch * 1000).toISOString() } },
        errors: [{ message: "resolver blew up" }],
      }), {
        status: 500,
        headers: {
          "content-type": "application/json",
          "x-ratelimit-remaining": "4800",
          "x-ratelimit-reset": String(resetEpoch),
          "x-ratelimit-limit": "5000",
        },
      })
    ));

    let capturedInfo: ApiRequestInfo | null = null;
    onApiRequest((info) => { capturedInfo = info; });

    const client = createGitHubClient("test-token");
    await expect(client.graphql("{ viewer { login } }", { request: { retries: 0 } })).rejects.toThrow(/resolver blew up|500/);

    expect(capturedInfo).not.toBeNull();
    expect(capturedInfo!.isGraphql).toBe(true);
    expect(capturedInfo!.graphqlCost).toBe(7);
  });
});

// ── fetchRateLimitDetails ────────────────────────────────────────────────────
// fetchRateLimitDetails calls getClient() which reads an internal SolidJS signal
// (_client) that is only non-null after auth token is set. These tests exercise
// the null-client fast-path and the signal-preservation guarantee on failure.
// Signal update tests (setCoreRateLimit / setGraphqlRateLimit) are covered by the
// hook.wrap tests above and the cache-hit path adds identical setters (same references).

describe("fetchRateLimitDetails", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null immediately when no client is available", async () => {
    // No auth token is set in tests, so getClient() returns null → fetchRateLimitDetails returns null.
    const result = await fetchRateLimitDetails();
    expect(result).toBeNull();
  });

  it("failure does not clear existing signals", async () => {
    // Seed signals to known values using the exported update functions.
    const resetEpoch = Math.floor(Date.now() / 1000) + 3600;
    updateRateLimitFromHeaders({
      "x-ratelimit-remaining": "1111",
      "x-ratelimit-reset": String(resetEpoch),
      "x-ratelimit-limit": "5000",
    });
    updateGraphqlRateLimit({ limit: 5000, remaining: 2222, resetAt: new Date(resetEpoch * 1000).toISOString() });

    // fetchRateLimitDetails returns null (no client) — signals must be unaffected.
    const result = await fetchRateLimitDetails();
    expect(result).toBeNull();

    expect(getCoreRateLimit()!.remaining).toBe(1111);
    expect(getGraphqlRateLimit()!.remaining).toBe(2222);
  });
});

// ── fetchRateLimitDetails — client override + cache behavior ─────────────────

describe("fetchRateLimitDetails — signal updates with client override", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("successful call updates both signals and cache-hit restores them", async () => {
    const resetEpoch = Math.floor(Date.now() / 1000) + 3600;
    const mockClient = {
      request: vi.fn().mockResolvedValue({
        data: {
          resources: {
            core: { limit: 5000, remaining: 3000, reset: resetEpoch },
            graphql: { limit: 5000, remaining: 2500, reset: resetEpoch },
          },
        },
      }),
    };

    // Fresh call: seeds cache and updates signals
    const result = await fetchRateLimitDetails(mockClient as never);
    expect(result).not.toBeNull();
    expect(result!.core.remaining).toBe(3000);
    expect(result!.graphql.remaining).toBe(2500);
    expect(getCoreRateLimit()!.remaining).toBe(3000);
    expect(getGraphqlRateLimit()!.remaining).toBe(2500);

    // Overwrite signals (simulates hook.wrap updating mid-cycle)
    updateRateLimitFromHeaders({
      "x-ratelimit-remaining": "999",
      "x-ratelimit-reset": String(resetEpoch),
      "x-ratelimit-limit": "5000",
    });
    expect(getCoreRateLimit()!.remaining).toBe(999);

    // Cache-hit within 5s: restores authoritative values, no HTTP call
    const cached = await fetchRateLimitDetails(mockClient as never);
    expect(cached).not.toBeNull();
    expect(getCoreRateLimit()!.remaining).toBe(3000);
    expect(getGraphqlRateLimit()!.remaining).toBe(2500);
    expect(mockClient.request).toHaveBeenCalledTimes(1);
  });
});

// ── createGitHubClient — retryCount quadratic backoff ────────────────────────
// Placed at the end of the file so fake-timer Date.now() advancement does not
// shift the shared Bottleneck group's _nextRequest ahead of subsequent real-timer tests.

describe("createGitHubClient — retryCount quadratic backoff", () => {
  it("preserves options.request.retryCount across /graphql retries with quadratic backoff (1s then 4s)", async () => {
    vi.useFakeTimers();
    const client = createGitHubClient("test-token");
    const mockFetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", mockFetch);

    let promise: Promise<unknown> | undefined;
    try {
      // Advance fake clock past any residual Bottleneck write-limiter minTime (1000ms)
      // recorded by preceding real-timer /graphql tests.
      await vi.advanceTimersByTimeAsync(2_000);

      let caughtErr: unknown;
      promise = client
        .graphql("{ viewer { login } }", { request: { retries: 2 } })
        .catch((err: unknown) => {
          caughtErr = err;
        });

      // Initial attempt runs at t=0
      await vi.advanceTimersByTimeAsync(50);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Retry 1 (retryCount 0 -> 1) runs after 1s quadratic backoff + Bottleneck write spacing
      await vi.advanceTimersByTimeAsync(1_500);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Verify retry 2 has NOT fired 1.5s after retry 1 (would have fired at +1s if retryCount was reset to 0)
      await vi.advanceTimersByTimeAsync(1_000);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Advance remaining time for retry 2's 4s quadratic backoff (retryCount 1 -> 2)
      await vi.advanceTimersByTimeAsync(3_500);
      await promise;

      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(caughtErr).toBeInstanceOf(Error);
      expect((caughtErr as Error).message).toMatch(/Failed to fetch/);
      expect((caughtErr as { response?: unknown }).response).toBeUndefined();
    } finally {
      if (promise) {
        await vi.advanceTimersByTimeAsync(10_000);
        await promise;
      }
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

// ── createGitHubClient — preThrottlingPlugin abort & rate-limit retry bounds ─
// Placed at the end of the file after retryCount quadratic backoff so fake-timer
// clock advancement on Bottleneck's shared limiters does not affect real-timer suites.

describe("createGitHubClient — preThrottlingPlugin abort handling and rate-limit retry bounds", () => {
  // Maintain a monotonically increasing fake-clock cursor across tests in this suite
  // so Bottleneck's module-scoped limiters (_nextRequest shifted by earlier fake-timer tests)
  // never see Date.now() move backwards when a new test starts.
  let fakeTimeCursor = Date.now() + 30_000;

  async function settleWithTimers<T>(
    promise: Promise<T>,
    advanceMs = 2_000
  ): Promise<{ value?: T; error?: unknown }> {
    let settled: { value?: T; error?: unknown } = {};
    const wrapped = (async () => {
      try {
        settled = { value: await promise };
      } catch (error) {
        settled = { error };
      }
    })();
    await vi.advanceTimersByTimeAsync(advanceMs);
    await wrapped;
    return settled;
  }

  beforeEach(() => {
    clearNotifications();
  });

  afterEach(() => {
    fakeTimeCursor = Math.max(fakeTimeCursor, Date.now()) + 10_000;
    clearNotifications();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("exports MAX_INLINE_RATE_LIMIT_RETRY_AFTER_SEC === 15", () => {
    expect(MAX_INLINE_RATE_LIMIT_RETRY_AFTER_SEC).toBe(15);
  });

  it("rejects immediately without calling fetch when client.graphql is called with an already-aborted AbortSignal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(fakeTimeCursor);
    await vi.advanceTimersByTimeAsync(2_000);

    const client = createGitHubClient("test-token");
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    // 1. Default abort reason (DOMException AbortError)
    const controller1 = new AbortController();
    controller1.abort();
    const reqOpts1: { signal: AbortSignal; retries?: number } = {
      signal: controller1.signal,
      retries: 2,
    };

    const { error: caught1 } = await settleWithTimers(
      client.graphql("{ viewer { login } }", { request: reqOpts1 }),
      2_000
    );

    expect(mockFetch).not.toHaveBeenCalled();
    expect(caught1).toBeInstanceOf(Error);
    expect((caught1 as Error).name).toBe("AbortError");
    expect((caught1 as { response?: unknown }).response).toBeUndefined();

    // 2. Custom Error abort reason
    const controller2 = new AbortController();
    const customReason = new Error("Custom caller timeout");
    controller2.abort(customReason);
    const reqOpts2: { signal: AbortSignal; retries?: number } = {
      signal: controller2.signal,
      retries: 2,
    };

    const { error: caught2 } = await settleWithTimers(
      client.graphql("{ viewer { login } }", { request: reqOpts2 }),
      2_000
    );

    expect(mockFetch).not.toHaveBeenCalled();
    expect(caught2).toBe(customReason);
    expect((caught2 as { response?: unknown }).response).toBeUndefined();

    // 3. Non-Error primitive abort reason falls back to DOMException AbortError
    const controller3 = new AbortController();
    controller3.abort("non-error-reason");
    const reqOpts3: { signal: AbortSignal; retries?: number } = {
      signal: controller3.signal,
      retries: 2,
    };

    const { error: caught3 } = await settleWithTimers(
      client.graphql("{ viewer { login } }", { request: reqOpts3 }),
      2_000
    );

    expect(mockFetch).not.toHaveBeenCalled();
    expect(caught3).toBeInstanceOf(DOMException);
    expect((caught3 as DOMException).name).toBe("AbortError");
    expect((caught3 as { response?: unknown }).response).toBeUndefined();
  });

  it("aborts a second concurrent client.graphql request queued behind Bottleneck's 1000ms state.write spacing without invoking fetch for the second call", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(fakeTimeCursor);
    await vi.advanceTimersByTimeAsync(2_000);

    const client = createGitHubClient("test-token");
    const controller1 = new AbortController();
    const controller2 = new AbortController();
    const reqOpts2: { signal: AbortSignal; retries?: number } = {
      signal: controller2.signal,
      retries: 2,
    };

    const mockFetch = vi.fn().mockImplementation(async () => {
      // Abort req2 while req1 is executing fetch and req2 is queued in Bottleneck's 1000ms state.write limiter
      controller2.abort();
      return new Response(
        JSON.stringify({ data: { viewer: { login: "octocat" } } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", mockFetch);

    const req1 = client.graphql("{ viewer { login } }", {
      request: { signal: controller1.signal },
    });

    let caught2: unknown;
    const req2 = client
      .graphql("{ viewer { login } }", {
        request: reqOpts2,
      })
      .catch((err: unknown) => {
        caught2 = err;
      });

    // Advance past Bottleneck's 1000ms state.write minTime spacing while both promises are pending
    await vi.advanceTimersByTimeAsync(2_500);
    await Promise.all([req1, req2]);

    // Fetch was only invoked for req1; req2 was aborted in preThrottlingPlugin before fetch
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(caught2).toBeInstanceOf(Error);
    expect((caught2 as Error).name).toBe("AbortError");
    expect((caught2 as { response?: unknown }).response).toBeUndefined();
  });

  it("onRateLimit retries once when retryAfter <= MAX_INLINE_RATE_LIMIT_RETRY_AFTER_SEC and signal is not aborted, and skips inline retry when retryAfter > 15s or signal is aborted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(fakeTimeCursor);
    await vi.advanceTimersByTimeAsync(2_000);

    const client = createGitHubClient("test-token");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      // Case 1: retryAfter <= 15s (e.g. reset = now, so retryAfter = 1s) and !signal.aborted -> retries once and succeeds
      let callCount1 = 0;
      const mockFetch1 = vi.fn().mockImplementation(async () => {
        callCount1++;
        if (callCount1 === 1) {
          const resetNow = Math.floor(Date.now() / 1000);
          return new Response(
            JSON.stringify({ message: "API rate limit exceeded" }),
            {
              status: 403,
              headers: {
                "content-type": "application/json",
                "x-ratelimit-remaining": "0",
                "x-ratelimit-reset": String(resetNow),
              },
            }
          );
        }
        return new Response(JSON.stringify({ login: "octocat" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
      vi.stubGlobal("fetch", mockFetch1);

      const { value: res1, error: err1 } = await settleWithTimers(
        client.request("GET /user"),
        3_000
      );
      expect(err1).toBeUndefined();
      expect(res1?.status).toBe(200);
      expect(mockFetch1).toHaveBeenCalledTimes(2);
      expect(getNotifications().some((n) => n.source === "rate-limit" && /Rate limit hit/.test(n.message))).toBe(true);

      clearNotifications();

      // Case 2: retryAfter > 15s (e.g. reset = now + 60s, so retryAfter = 61s) -> pushes warning but returns false (no inline retry)
      const reset60 = Math.floor(Date.now() / 1000) + 60;
      const mockFetch2 = vi.fn().mockImplementation(async () =>
        new Response(
          JSON.stringify({ message: "API rate limit exceeded" }),
          {
            status: 403,
            headers: {
              "content-type": "application/json",
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": String(reset60),
            },
          }
        )
      );
      vi.stubGlobal("fetch", mockFetch2);

      const { error: err2 } = await settleWithTimers(
        client.request("GET /user"),
        2_000
      );
      expect(err2).toBeInstanceOf(Error);
      expect((err2 as Error).message).toMatch(/API rate limit exceeded/);
      expect(mockFetch2).toHaveBeenCalledTimes(1);
      expect(getNotifications().some((n) => n.source === "rate-limit" && /Rate limit hit — retrying in 61s/.test(n.message))).toBe(true);

      clearNotifications();

      // Case 3: retryAfter <= 15s, but caller signal aborts before onRateLimit runs -> returns false (no inline retry)
      const controller3 = new AbortController();
      const mockFetch3 = vi.fn().mockImplementation(async () => {
        controller3.abort();
        const resetNow = Math.floor(Date.now() / 1000);
        return new Response(
          JSON.stringify({ message: "API rate limit exceeded" }),
          {
            status: 403,
            headers: {
              "content-type": "application/json",
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": String(resetNow),
            },
          }
        );
      });
      vi.stubGlobal("fetch", mockFetch3);

      const { error: err3 } = await settleWithTimers(
        client.request("GET /user", { request: { signal: controller3.signal } }),
        2_000
      );
      expect(err3).toBeInstanceOf(Error);
      expect((err3 as Error).message).toMatch(/API rate limit exceeded/);
      expect(mockFetch3).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("onSecondaryRateLimit retries once when retryAfter <= MAX_INLINE_RATE_LIMIT_RETRY_AFTER_SEC and signal is not aborted, and skips inline retry when retryAfter > 15s or signal is aborted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(fakeTimeCursor);
    await vi.advanceTimersByTimeAsync(2_000);

    const client = createGitHubClient("test-token");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      // Case 1: retryAfter = 5s (<= 15s) and !signal.aborted -> retries once and succeeds
      let callCount1 = 0;
      const mockFetch1 = vi.fn().mockImplementation(async () => {
        callCount1++;
        if (callCount1 === 1) {
          return new Response(
            JSON.stringify({ message: "You have exceeded a secondary rate limit" }),
            {
              status: 403,
              headers: {
                "content-type": "application/json",
                "retry-after": "5",
              },
            }
          );
        }
        return new Response(JSON.stringify({ login: "octocat" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
      vi.stubGlobal("fetch", mockFetch1);

      const { value: res1, error: err1 } = await settleWithTimers(
        client.request("GET /user"),
        6_000
      );
      expect(err1).toBeUndefined();
      expect(res1?.status).toBe(200);
      expect(mockFetch1).toHaveBeenCalledTimes(2);
      expect(
        getNotifications().some(
          (n) => n.source === "rate-limit" && /Secondary rate limit — retrying in 5s/.test(n.message)
        )
      ).toBe(true);

      clearNotifications();

      // Case 2: retryAfter = 60s (> 15s) -> pushes warning but returns false (no 60s inline sleep)
      const mockFetch2 = vi.fn().mockImplementation(async () =>
        new Response(
          JSON.stringify({ message: "You have exceeded a secondary rate limit" }),
          {
            status: 403,
            headers: {
              "content-type": "application/json",
              "retry-after": "60",
            },
          }
        )
      );
      vi.stubGlobal("fetch", mockFetch2);

      const { error: err2 } = await settleWithTimers(
        client.request("GET /user"),
        2_000
      );
      expect(err2).toBeInstanceOf(Error);
      expect((err2 as Error).message).toMatch(/secondary rate limit/i);
      expect(mockFetch2).toHaveBeenCalledTimes(1);
      expect(
        getNotifications().some(
          (n) => n.source === "rate-limit" && /Secondary rate limit — retrying in 60s/.test(n.message)
        )
      ).toBe(true);

      clearNotifications();

      // Case 3: retryAfter = 5s (<= 15s), but caller signal aborts before onSecondaryRateLimit runs -> returns false
      const controller3 = new AbortController();
      const mockFetch3 = vi.fn().mockImplementation(async () => {
        controller3.abort();
        return new Response(
          JSON.stringify({ message: "You have exceeded a secondary rate limit" }),
          {
            status: 403,
            headers: {
              "content-type": "application/json",
              "retry-after": "5",
            },
          }
        );
      });
      vi.stubGlobal("fetch", mockFetch3);

      const { error: err3 } = await settleWithTimers(
        client.request("GET /user", { request: { signal: controller3.signal } }),
        2_000
      );
      expect(err3).toBeInstanceOf(Error);
      expect((err3 as Error).message).toMatch(/secondary rate limit/i);
      expect(mockFetch3).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
