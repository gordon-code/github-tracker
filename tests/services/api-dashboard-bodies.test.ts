import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  fetchDashboardIssueBodies,
  GRAPHQL_BODY_FETCH_TIMEOUT_MS,
  BODY_FETCH_BATCH_SIZE,
  BODY_FETCH_NOTIFICATION_THRESHOLD,
  MIN_SPLIT_BATCH_SIZE,
  resetPREnrichmentCache,
  resetBodyFetchFailures,
  GraphqlFetchTimeoutError,
} from "../../src/app/services/api";
import { getClient } from "../../src/app/services/github";
import { pushNotification, dismissNotificationBySource } from "../../src/app/lib/errors";
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
  dismissNotificationBySource: vi.fn(),
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

const NODES_BATCH_SIZE = BODY_FETCH_BATCH_SIZE;

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
  resetPREnrichmentCache();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("fetchDashboardIssueBodies — empty input", () => {
  it("returns an empty Map immediately without calling graphql", async () => {
    const octokit = makeOctokit(async () => ({}));
    const result = await fetchDashboardIssueBodies(octokit, []);
    expect(result.bodies).toBeInstanceOf(Map);
    expect(result.bodies.size).toBe(0);
    expect(result.failedIds.size).toBe(0);
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

    expect(result.bodies.get("N_1")).toBe("Dashboard body text");
    expect(result.bodies.get("N_2")).toBeNull();
    expect(result.bodies.size).toBe(2);
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

    expect(result.bodies.size).toBe(1);
    expect(result.bodies.get("N_2")).toBe("valid body");
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
    expect(result.bodies.size).toBe(NODES_BATCH_SIZE + 1);
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

    expect(result.bodies.size).toBe(NODES_BATCH_SIZE + 2);
    expect(result.bodies.get("A_0")).toBe("body-A_0");
    expect(result.bodies.get("B_1")).toBe("body-B_1");
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

    expect(result.bodies.get("N_ok")).toBe("good body");
    expect(result.bodies.size).toBe(1);
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
    expect(result.bodies.get("N_valid")).toBe("kept");
    expect(result.bodies.size).toBe(1);
  });
});

describe("fetchDashboardIssueBodies — GraphQL error handling", () => {
  it("returns empty Map when graphql rejects (no partial data)", async () => {
    const octokit = makeOctokit(async () => {
      throw new Error("GraphQL network error");
    });

    const result = await fetchDashboardIssueBodies(octokit, ["N_1"]);

    expect(result.bodies).toBeInstanceOf(Map);
    expect(result.bodies.size).toBe(0);
    expect(result.failedIds.has("N_1")).toBe(true);
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
    const ids = Array.from({ length: NODES_BATCH_SIZE + 1 }, (_, i) => `N_${i}`);
    const octokit = makeOctokit(async (_query: string, variables: unknown) => {
      const { ids: batchIds } = variables as { ids: string[] };
      if (batchIds.some((id) => id !== `N_${BODY_FETCH_BATCH_SIZE}`)) {
        throw new Error("first batch failed");
      }
      return { nodes: batchIds.map((id) => ({ id, body: `body-${id}` })) };
    });

    const result = await fetchDashboardIssueBodies(octokit, ids);

    // Second batch (1 item) should succeed despite first failing
    expect(result.bodies.size).toBe(1);
    expect(result.bodies.get(`N_${NODES_BATCH_SIZE}`)).toBe(`body-N_${NODES_BATCH_SIZE}`);
    expect(result.failedIds.size).toBe(NODES_BATCH_SIZE);
  });

  it("exports GRAPHQL_BODY_FETCH_TIMEOUT_MS === 45_000, BODY_FETCH_BATCH_SIZE === 25, and BODY_FETCH_NOTIFICATION_THRESHOLD === 3", () => {
    expect(GRAPHQL_BODY_FETCH_TIMEOUT_MS).toBe(45_000);
    expect(BODY_FETCH_BATCH_SIZE).toBe(25);
    expect(BODY_FETCH_NOTIFICATION_THRESHOLD).toBe(3);
  });

  it("recursively binary-splits a 25-node batch (25 -> [12, 13] -> [6, 6] / [6, 7]) on retryable failure, recovering healthy siblings and capturing Sentry once", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ids = Array.from({ length: BODY_FETCH_BATCH_SIZE }, (_, i) => `N_${i}`);
      const poisonId = "N_14"; // in second half (indices 12..24 -> leaf 12..17 of size 6)
      const observedRetries: Array<number | undefined> = [];

      const octokit = makeOctokit(async (_query: string, variables: unknown) => {
        const { ids: batchIds, request } = variables as {
          ids: string[];
          request?: { retries?: number };
        };
        observedRetries.push(request?.retries);
        if (batchIds.includes(poisonId)) {
          const err = Object.assign(new Error("502 Bad Gateway"), { status: 502 });
          throw err;
        }
        return {
          nodes: batchIds.map((id) => ({ id, body: `body-${id}` })),
        };
      });

      const result = await fetchDashboardIssueBodies(octokit, ids);

      // Splittable (> 6) top-level batch and split sub-batches all use retries: 0 so 502/504 splits immediately
      expect(observedRetries.every((r) => r === 0)).toBe(true);

      // Non-splittable (<= 6) top-level batch uses retries: 1
      observedRetries.length = 0;
      await fetchDashboardIssueBodies(octokit, ["N_0"]);
      expect(observedRetries).toEqual([1]);

      // 25 -> [0..11 (12 ok), 12..24 (13 fail)] -> [12..17 (6 fail leaf), 18..24 (7 ok)]
      // 19 healthy nodes recovered, 6 leaf nodes in failedIds
      expect(result.bodies.size).toBe(19);
      expect(result.failedIds.size).toBe(6);
      expect(result.failedIds.has(poisonId)).toBe(true);
      expect(result.bodies.get("N_0")).toBe("body-N_0");
      expect(result.bodies.get("N_24")).toBe("body-N_24");
      expect(captureException).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("short-circuits without binary splitting when batch fails with a non-retryable 403 status", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ids = Array.from({ length: BODY_FETCH_BATCH_SIZE }, (_, i) => `N_${i}`);
      const octokit = makeOctokit(async () => {
        throw Object.assign(new Error("Forbidden"), { status: 403 });
      });

      const result = await fetchDashboardIssueBodies(octokit, ids);

      expect(octokit.graphql).toHaveBeenCalledTimes(1);
      expect(result.bodies.size).toBe(0);
      expect(result.failedIds.size).toBe(BODY_FETCH_BATCH_SIZE);
      expect(captureException).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it.each([
    [
      "status-500 RequestError with a TypeError cause",
      () => Object.assign(new Error("Failed to fetch", { cause: new TypeError("Failed to fetch") }), { status: 500 }),
    ],
    ["bare TypeError", () => new TypeError("Failed to fetch")],
  ])(
    "binary-splits a batch that fails with 'Failed to fetch' (CORS-masked gateway 502/504) as a %s",
    async (_label, makeError) => {
      const ids = Array.from({ length: BODY_FETCH_BATCH_SIZE }, (_, i) => `N_${i}`);
      const batchSizes: number[] = [];
      const octokit = makeOctokit(async (_query: string, variables: unknown) => {
        const batchIds = (variables as { ids: string[] }).ids;
        batchSizes.push(batchIds.length);
        if (batchIds.length > MIN_SPLIT_BATCH_SIZE) throw makeError();
        return { nodes: batchIds.map((id) => ({ id, body: `body-${id}` })), rateLimit: null };
      });

      const result = await fetchDashboardIssueBodies(octokit, ids);

      expect(batchSizes).toContain(12);
      expect(batchSizes).toContain(13);
      expect(result.bodies.size).toBe(BODY_FETCH_BATCH_SIZE);
      expect(result.failedIds.size).toBe(0);
    }
  );

  it("salvages resolved nodes from partial err.data.nodes before computing remainingIds", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ids = Array.from({ length: 10 }, (_, i) => `N_${i}`);
      const octokit = makeOctokit(async (_query: string, variables: unknown) => {
        const { ids: batchIds } = variables as { ids: string[] };
        if (batchIds.length === 10) {
          // 6 of the 10 nodes resolved in partial err.data.nodes; only 4 remain (<= MIN_SPLIT_BATCH_SIZE = 6)
          throw Object.assign(new Error("Partial GraphQL failure"), {
            status: 502,
            data: {
              nodes: batchIds.slice(0, 6).map((id) => ({ id, body: `salvaged-${id}` })),
            },
          });
        }
        return { nodes: [] };
      });

      const result = await fetchDashboardIssueBodies(octokit, ids);

      // Because 6 nodes were salvaged, remainingIds had length 4 (<= 6), so no split retry was needed
      expect(octokit.graphql).toHaveBeenCalledTimes(1);
      expect(result.bodies.size).toBe(6);
      expect(result.bodies.get("N_0")).toBe("salvaged-N_0");
      expect(result.bodies.get("N_5")).toBe("salvaged-N_5");
      expect([...result.failedIds]).toEqual(["N_6", "N_7", "N_8", "N_9"]);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("fetchDashboardIssueBodies — hung request timeout", () => {
  it("times out a never-resolving batch, warns, reports to Sentry on each failure, and notifies with silentToast only after 3 consecutive failures (dismissing on recovery)", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const octokit = makeOctokit(() => new Promise(() => {}));
      vi.mocked(getClient).mockReturnValue(octokit);

      // Failure 1: records failedIds & Sentry, but does NOT push notification (< 3 threshold)
      const p1 = fetchDashboardIssueBodies(octokit, ["N_1"]);
      await vi.advanceTimersByTimeAsync(GRAPHQL_BODY_FETCH_TIMEOUT_MS);
      const result1 = await p1;

      expect(result1.bodies).toBeInstanceOf(Map);
      expect(result1.bodies.size).toBe(0);
      expect(result1.failedIds.has("N_1")).toBe(true);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(captureException).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "GraphqlFetchTimeoutError",
          message: `GraphQL request exceeded ${GRAPHQL_BODY_FETCH_TIMEOUT_MS}ms`,
        }),
        { tags: { source: "dashboardBodies" } }
      );
      const capturedErr = vi.mocked(captureException).mock.calls[0]?.[0];
      expect(capturedErr).toBeInstanceOf(GraphqlFetchTimeoutError);
      expect((capturedErr as Error).name).toBe("GraphqlFetchTimeoutError");
      expect(pushNotification).not.toHaveBeenCalled();

      // Failure 2: still below threshold (2 < 3)
      const p2 = fetchDashboardIssueBodies(octokit, ["N_1"]);
      await vi.advanceTimersByTimeAsync(GRAPHQL_BODY_FETCH_TIMEOUT_MS);
      await p2;
      expect(pushNotification).not.toHaveBeenCalled();

      // Failure 3: reaches BODY_FETCH_NOTIFICATION_THRESHOLD (3) -> pushes silent drawer warning
      const p3 = fetchDashboardIssueBodies(octokit, ["N_1"]);
      await vi.advanceTimersByTimeAsync(GRAPHQL_BODY_FETCH_TIMEOUT_MS);
      await p3;
      expect(pushNotification).toHaveBeenCalledTimes(1);
      expect(pushNotification).toHaveBeenCalledWith(
        "dashboardBodies",
        expect.stringContaining("could not be loaded"),
        "warning",
        true,
        undefined,
        { silentToast: true }
      );

      // Subsequent recovery resets failure counter and dismisses notification by source
      const healthyOctokit = makeOctokit(async () => ({
        nodes: [{ id: "N_1", body: "recovered body" }],
      }));
      vi.mocked(getClient).mockReturnValue(healthyOctokit);
      const recovered = await fetchDashboardIssueBodies(healthyOctokit, ["N_1"]);
      expect(recovered.failedIds.size).toBe(0);
      expect(dismissNotificationBySource).toHaveBeenCalledWith("dashboardBodies");

      // And resetBodyFetchFailures("dashboardBodies") also dismisses directly when invoked
      vi.mocked(dismissNotificationBySource).mockClear();
      resetBodyFetchFailures("dashboardBodies");
      expect(dismissNotificationBySource).toHaveBeenCalledWith("dashboardBodies");
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

  it("aborts a hung multi-node batch on timeout and marks every id failed without binary-splitting", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ids = Array.from({ length: BODY_FETCH_BATCH_SIZE }, (_, i) => `N_${i}`);
      const requests: Array<{ signal?: AbortSignal; retries?: number }> = [];
      const octokit = makeOctokit((_query: string, variables: unknown) => {
        const { request } = variables as { request?: { signal?: AbortSignal; retries?: number } };
        requests.push(request ?? {});
        return new Promise(() => {});
      });
      vi.mocked(getClient).mockReturnValue(null);

      const resultPromise = fetchDashboardIssueBodies(octokit, ids);
      await vi.advanceTimersByTimeAsync(GRAPHQL_BODY_FETCH_TIMEOUT_MS);
      const result = await resultPromise;

      expect(octokit.graphql).toHaveBeenCalledTimes(1);
      expect(requests[0].retries).toBe(0);
      expect(requests[0].signal?.aborted).toBe(true);
      expect(result.bodies.size).toBe(0);
      expect([...result.failedIds]).toEqual(ids);
      expect(captureException).toHaveBeenCalledTimes(1);
      expect(captureException).toHaveBeenCalledWith(
        expect.any(GraphqlFetchTimeoutError),
        { tags: { source: "dashboardBodies" } }
      );
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
