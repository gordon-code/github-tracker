import { describe, it, expect, vi, afterEach } from "vitest";
import "fake-indexeddb/auto";

// ── Mocks ─────────────────────────────────────────────────────────────────────

// Mock auth with a real-looking token so the eager client creation succeeds.
vi.mock("../../src/app/stores/auth", () => ({
  token: () => "fake-token-for-rate-limit-tests",
  onAuthCleared: vi.fn(),
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import { fetchRateLimitDetails } from "../../src/app/services/github";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSuccessResponse(coreRemaining = 4800, graphqlRemaining = 4900) {
  const reset = Math.floor(Date.now() / 1000) + 3600;
  return new Response(
    JSON.stringify({
      resources: {
        core: { limit: 5000, remaining: coreRemaining, reset, used: 200 },
        graphql: { limit: 5000, remaining: graphqlRemaining, reset, used: 100 },
        search: { limit: 30, remaining: 30, reset, used: 0 },
      },
      rate: { limit: 5000, remaining: coreRemaining, reset, used: 200 },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

// NOTE: fetchRateLimitDetails has module-level _lastFetchTime/_lastFetchResult cache.
// Tests run in sequence within a single module instance. Each test that needs a
// fresh (uncached) result must first call the function with a success response to
// populate the cache OR account for the shared state.
//
// LIMITATION: Testing fake-timer-dependent behavior (5s expiry) is not feasible
// with this module architecture + Octokit retry plugin (which uses real setTimeout
// even for throttle checks). Instead, we verify:
//   1. Success/failure behavior of the function itself
//   2. Object identity for cache hit (two calls in rapid succession return same ref)

describe("fetchRateLimitDetails — success response", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns core and graphql RateLimitInfo with correct shape on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeSuccessResponse(4800, 4900)));

    const result = await fetchRateLimitDetails();
    expect(result).not.toBeNull();
    expect(result!.core.limit).toBe(5000);
    expect(result!.core.remaining).toBe(4800);
    expect(result!.core.resetAt).toBeInstanceOf(Date);
    expect(result!.graphql.limit).toBe(5000);
    expect(result!.graphql.remaining).toBe(4900);
    expect(result!.graphql.resetAt).toBeInstanceOf(Date);
  });

  it("returns null when response body is missing the graphql key", async () => {
    // Use fresh module to bypass staleness cache
    vi.resetModules();
    vi.doMock("../../src/app/stores/auth", () => ({
      token: () => "fake-token-for-rate-limit-tests",
      onAuthCleared: vi.fn(),
    }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ resources: { core: { limit: 5000, remaining: 4800, reset: 99999, used: 0 } } }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    ));

    const { fetchRateLimitDetails: freshFetch } = await import("../../src/app/services/github");
    const result = await freshFetch();
    expect(result).toBeNull();
  });
});

describe("fetchRateLimitDetails — staleness cache", () => {
  it("returns the same data for two calls within 5 seconds (cache hit)", async () => {
    // Fresh module for hermetic test — no cross-test cache dependency
    vi.resetModules();
    vi.doMock("../../src/app/stores/auth", () => ({
      token: () => "fake-token-for-staleness-test",
      onAuthCleared: vi.fn(),
    }));
    const mockFetch = vi.fn().mockResolvedValue(makeSuccessResponse());
    vi.stubGlobal("fetch", mockFetch);

    const { fetchRateLimitDetails: freshFetch } = await import("../../src/app/services/github");

    const result1 = await freshFetch();
    expect(result1).not.toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Second call immediately — must not make a new network request
    const result2 = await freshFetch();
    expect(result2).not.toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1); // no extra calls
    expect(result2!.core.remaining).toBe(result1!.core.remaining);

    vi.unstubAllGlobals();
  });
});

describe("fetchRateLimitDetails — null client", () => {
  it("returns null when getClient() returns null", async () => {
    // Use vi.resetModules() for clean module state (clears staleness cache).
    // Mock auth to return null token so no eager client is created.
    vi.resetModules();
    vi.doMock("../../src/app/stores/auth", () => ({
      token: () => null,
      onAuthCleared: vi.fn(),
    }));

    const { fetchRateLimitDetails: freshFetch } = await import("../../src/app/services/github");
    const result = await freshFetch();
    expect(result).toBeNull();
  });
});
