import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchDashboardIssueBodies, GRAPHQL_BODY_FETCH_TIMEOUT_MS } from "../../src/app/services/api";
import { getClient } from "../../src/app/services/github";
import { pushNotification } from "../../src/app/lib/errors";
import { captureException } from "@sentry/solid";

// ── Mocks ─────────────────────────────────────────────────────────────────────

// updateGraphqlRateLimit lives in github.ts — mock the whole module
const mockUpdateGraphqlRateLimit = vi.fn();
vi.mock("../../src/app/services/github", () => ({
  getClient: vi.fn(),
  cachedRequest: vi.fn(),
  updateGraphqlRateLimit: (...args: unknown[]) => mockUpdateGraphqlRateLimit(...args),
  fetchRateLimitDetails: vi.fn(),
  onApiRequest: vi.fn(),
  initClientWatcher: vi.fn(),
  getCoreRateLimit: vi.fn(() => null),
  getGraphqlRateLimit: vi.fn(() => null),
}));

vi.mock("../../src/app/lib/errors", () => ({
  pushNotification: vi.fn(),
  pushError: vi.fn(),
  getErrors: vi.fn().mockReturnValue([]),
  dismissError: vi.fn(),
  getNotifications: vi.fn().mockReturnValue([]),
  getUnreadCount: vi.fn().mockReturnValue(0),
  markAllAsRead: vi.fn(),
  isMuted: vi.fn(() => false),
}));

vi.mock("@sentry/solid", () => ({
  captureException: vi.fn(),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

// NODES_BATCH_SIZE is 100 (internal to api.ts — confirmed from fetchPREnrichment usage)
const NODES_BATCH_SIZE = 100;

function makeRateLimit() {
  return { cost: 1, limit: 5000, remaining: 4999, resetAt: "2026-01-01T01:00:00Z" };
}

function makeOctokit(graphqlImpl: (query: string, variables: unknown) => Promise<unknown>) {
  return {
    graphql: vi.fn(graphqlImpl),
    request: vi.fn(),
    paginate: { iterator: vi.fn() },
  } as unknown as Parameters<typeof fetchDashboardIssueBodies>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("fetchDashboardIssueBodies — empty input", () => {
  it("returns an empty Map immediately without calling graphql", async () => {
    const octokit = makeOctokit(async () => ({}));
    const result = await fetchDashboardIssueBodies(octokit, []);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
    expect(octokit.graphql).not.toHaveBeenCalled();
  });
});

describe("fetchDashboardIssueBodies — single batch", () => {
  it("fetches bodies for a list of node IDs and returns a Map keyed by nodeId", async () => {
    const nodes = [
      { id: "N_1", body: "Dashboard body text" },
      { id: "N_2", body: null },
    ];
    const octokit = makeOctokit(async () => ({
      nodes,
      rateLimit: makeRateLimit(),
    }));

    const result = await fetchDashboardIssueBodies(octokit, ["N_1", "N_2"]);

    expect(result.get("N_1")).toBe("Dashboard body text");
    expect(result.get("N_2")).toBeNull();
    expect(result.size).toBe(2);
  });

  it("calls updateGraphqlRateLimit when rateLimit is in response", async () => {
    const rl = makeRateLimit();
    const octokit = makeOctokit(async () => ({
      nodes: [{ id: "N_1", body: "body" }],
      rateLimit: rl,
    }));

    await fetchDashboardIssueBodies(octokit, ["N_1"]);

    expect(mockUpdateGraphqlRateLimit).toHaveBeenCalledWith(rl);
  });

  it("does not call updateGraphqlRateLimit when rateLimit is absent", async () => {
    const octokit = makeOctokit(async () => ({
      nodes: [{ id: "N_1", body: "body" }],
      // no rateLimit field
    }));

    await fetchDashboardIssueBodies(octokit, ["N_1"]);

    expect(mockUpdateGraphqlRateLimit).not.toHaveBeenCalled();
  });

  it("skips null nodes (items that are not Issues)", async () => {
    const octokit = makeOctokit(async () => ({
      nodes: [null, { id: "N_2", body: "valid body" }, null],
    }));

    const result = await fetchDashboardIssueBodies(octokit, ["N_1", "N_2", "N_3"]);

    expect(result.size).toBe(1);
    expect(result.get("N_2")).toBe("valid body");
  });
});

describe("fetchDashboardIssueBodies — batch splitting", () => {
  it("issues two graphql calls when input exceeds NODES_BATCH_SIZE", async () => {
    const ids = Array.from({ length: NODES_BATCH_SIZE + 1 }, (_, i) => `N_${i}`);
    const octokit = makeOctokit(async (_query: string, variables: unknown) => {
      const { ids: batchIds } = variables as { ids: string[] };
      return {
        nodes: batchIds.map((id) => ({ id, body: `body-${id}` })),
      };
    });

    const result = await fetchDashboardIssueBodies(octokit, ids);

    expect(octokit.graphql).toHaveBeenCalledTimes(2);
    expect(result.size).toBe(NODES_BATCH_SIZE + 1);
  });

  it("first batch has exactly NODES_BATCH_SIZE items", async () => {
    const ids = Array.from({ length: NODES_BATCH_SIZE + 5 }, (_, i) => `N_${i}`);
    const batchSizes: number[] = [];
    const octokit = makeOctokit(async (_query: string, variables: unknown) => {
      const { ids: batchIds } = variables as { ids: string[] };
      batchSizes.push(batchIds.length);
      return { nodes: batchIds.map((id) => ({ id, body: null })) };
    });

    await fetchDashboardIssueBodies(octokit, ids);

    expect(batchSizes[0]).toBe(NODES_BATCH_SIZE);
    expect(batchSizes[1]).toBe(5);
  });

  it("collects results from both batches into a single Map", async () => {
    const firstBatch = Array.from({ length: NODES_BATCH_SIZE }, (_, i) => `A_${i}`);
    const secondBatch = ["B_0", "B_1"];
    const allIds = [...firstBatch, ...secondBatch];

    const octokit = makeOctokit(async (_query: string, variables: unknown) => {
      const { ids: batchIds } = variables as { ids: string[] };
      return {
        nodes: batchIds.map((id) => ({ id, body: `body-${id}` })),
      };
    });

    const result = await fetchDashboardIssueBodies(octokit, allIds);

    expect(result.size).toBe(NODES_BATCH_SIZE + 2);
    expect(result.get("A_0")).toBe("body-A_0");
    expect(result.get("B_1")).toBe("body-B_1");
  });
});

describe("fetchDashboardIssueBodies — partial error handling", () => {
  it("returns successfully fetched nodes even when some are null", async () => {
    const octokit = makeOctokit(async () => ({
      nodes: [
        null,
        { id: "N_ok", body: "good body" },
        null,
      ],
    }));

    const result = await fetchDashboardIssueBodies(octokit, ["N_null1", "N_ok", "N_null2"]);

    expect(result.get("N_ok")).toBe("good body");
    expect(result.size).toBe(1);
  });

  it("gracefully ignores nodes missing an id field", async () => {
    const octokit = makeOctokit(async () => ({
      nodes: [
        { id: "", body: "should be skipped" },
        { id: "N_valid", body: "kept" },
      ],
    }));

    const result = await fetchDashboardIssueBodies(octokit, ["N_empty", "N_valid"]);

    // Node with empty id is skipped (falsy guard: !node.id)
    expect(result.get("N_valid")).toBe("kept");
    expect(result.size).toBe(1);
  });
});

describe("fetchDashboardIssueBodies — GraphQL error handling", () => {
  it("returns empty Map when graphql rejects (no partial data)", async () => {
    const octokit = makeOctokit(async () => {
      throw new Error("GraphQL network error");
    });

    const result = await fetchDashboardIssueBodies(octokit, ["N_1"]);

    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  it("calls updateGraphqlRateLimit from partial data on GraphQL error", async () => {
    const rl = makeRateLimit();
    const err = Object.assign(new Error("Partial"), {
      data: { rateLimit: rl, nodes: [] },
    });
    const octokit = makeOctokit(async () => { throw err; });

    await fetchDashboardIssueBodies(octokit, ["N_1"]);

    expect(mockUpdateGraphqlRateLimit).toHaveBeenCalledWith(rl);
  });

  it("does not call updateGraphqlRateLimit when error has no partial data", async () => {
    const octokit = makeOctokit(async () => {
      throw new Error("Hard failure, no data");
    });

    await fetchDashboardIssueBodies(octokit, ["N_1"]);

    expect(mockUpdateGraphqlRateLimit).not.toHaveBeenCalled();
  });

  it("Promise.allSettled: second batch succeeds even if first batch throws", async () => {
    let callCount = 0;
    const ids = Array.from({ length: NODES_BATCH_SIZE + 1 }, (_, i) => `N_${i}`);
    const octokit = makeOctokit(async (_query: string, variables: unknown) => {
      callCount++;
      const { ids: batchIds } = variables as { ids: string[] };
      if (callCount === 1) throw new Error("first batch failed");
      return { nodes: batchIds.map((id) => ({ id, body: `body-${id}` })) };
    });

    const result = await fetchDashboardIssueBodies(octokit, ids);

    // Second batch (1 item) should succeed despite first failing
    expect(result.size).toBe(1);
    expect(result.get(`N_${NODES_BATCH_SIZE}`)).toBe(`body-N_${NODES_BATCH_SIZE}`);
  });
});

describe("fetchDashboardIssueBodies — hung request timeout", () => {
  it("times out a never-resolving batch, warns, reports to Sentry, and notifies the user", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const octokit = makeOctokit(() => new Promise(() => {}));
      vi.mocked(getClient).mockReturnValue(octokit);

      const resultPromise = fetchDashboardIssueBodies(octokit, ["N_1"]);
      await vi.advanceTimersByTimeAsync(GRAPHQL_BODY_FETCH_TIMEOUT_MS);
      const result = await resultPromise;

      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
      expect(warnSpy).toHaveBeenCalled();
      expect(captureException).toHaveBeenCalledWith(
        expect.any(Error),
        { tags: { source: "dashboardBodies" } }
      );
      expect(pushNotification).toHaveBeenCalledWith(
        "dashboardBodies",
        expect.stringContaining("could not be loaded"),
        "warning"
      );
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("suppresses the notification (but keeps diagnostics) when the client changed before the timeout fired", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const octokit = makeOctokit(() => new Promise(() => {}));
      vi.mocked(getClient).mockReturnValue(octokit);

      const resultPromise = fetchDashboardIssueBodies(octokit, ["N_1"]);
      vi.mocked(getClient).mockReturnValue(null);
      await vi.advanceTimersByTimeAsync(GRAPHQL_BODY_FETCH_TIMEOUT_MS);
      await resultPromise;

      expect(warnSpy).toHaveBeenCalled();
      expect(captureException).toHaveBeenCalled();
      expect(pushNotification).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
