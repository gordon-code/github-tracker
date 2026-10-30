import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  fetchDepPRBodies,
  raceWithTimeout,
  GRAPHQL_BODY_FETCH_TIMEOUT_MS,
  BODY_FETCH_BATCH_SIZE,
  BODY_FETCH_NOTIFICATION_THRESHOLD,
  resetPREnrichmentCache,
  resetBodyFetchFailures,
} from "../../src/app/services/api";
import { getClient } from "../../src/app/services/github";
import { pushNotification, dismissNotificationBySource } from "../../src/app/lib/errors";
import { captureException } from "@sentry/solid";

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

const NODES_BATCH_SIZE = BODY_FETCH_BATCH_SIZE;

function makeRateLimit() {
  return { cost: 1, limit: 5000, remaining: 4999, resetAt: "2026-01-01T01:00:00Z" };
}

function makeOctokit(graphqlImpl: (query: string, variables: unknown) => Promise<unknown>) {
  return {
    graphql: vi.fn(graphqlImpl),
    request: vi.fn(),
    paginate: { iterator: vi.fn() },
  } as unknown as Parameters<typeof fetchDepPRBodies>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  resetPREnrichmentCache();
});

describe("fetchDepPRBodies — empty input", () => {
  it("returns an empty Map without calling graphql", async () => {
    const octokit = makeOctokit(async () => ({}));
    const result = await fetchDepPRBodies(octokit, []);
    expect(result.bodies).toBeInstanceOf(Map);
    expect(result.bodies.size).toBe(0);
    expect(result.failedIds.size).toBe(0);
    expect(octokit.graphql).not.toHaveBeenCalled();
  });
});

describe("fetchDepPRBodies — single batch", () => {
  it("returns a Map keyed by databaseId (number)", async () => {
    const octokit = makeOctokit(async () => ({
      nodes: [
        { databaseId: 42, body: "## Updates\n| pkg | from | to |\n|---|---|---|\n| lodash | 4.0.0 | 5.0.0 |" },
        { databaseId: 99, body: "Some PR body" },
      ],
      rateLimit: makeRateLimit(),
    }));

    const result = await fetchDepPRBodies(octokit, ["PR_node_1", "PR_node_2"]);

    expect(result.bodies.size).toBe(2);
    expect(result.bodies.get(42)).toContain("lodash");
    expect(result.bodies.get(99)).toBe("Some PR body");
  });

  it("skips nodes with null body", async () => {
    const octokit = makeOctokit(async () => ({
      nodes: [
        { databaseId: 1, body: "has body" },
        { databaseId: 2, body: null },
      ],
      rateLimit: makeRateLimit(),
    }));

    const result = await fetchDepPRBodies(octokit, ["N_1", "N_2"]);

    expect(result.bodies.size).toBe(1);
    expect(result.bodies.get(1)).toBe("has body");
    expect(result.bodies.has(2)).toBe(false);
  });

  it("skips nodes with empty string body", async () => {
    const octokit = makeOctokit(async () => ({
      nodes: [
        { databaseId: 1, body: "" },
        { databaseId: 2, body: "content" },
      ],
      rateLimit: makeRateLimit(),
    }));

    const result = await fetchDepPRBodies(octokit, ["N_1", "N_2"]);

    expect(result.bodies.size).toBe(1);
    expect(result.bodies.has(1)).toBe(false);
    expect(result.bodies.get(2)).toBe("content");
  });

  it("skips null nodes in the response array", async () => {
    const octokit = makeOctokit(async () => ({
      nodes: [null, { databaseId: 5, body: "valid" }, null],
      rateLimit: makeRateLimit(),
    }));

    const result = await fetchDepPRBodies(octokit, ["N_1", "N_2", "N_3"]);

    expect(result.bodies.size).toBe(1);
    expect(result.bodies.get(5)).toBe("valid");
  });

  it("skips nodes with null databaseId", async () => {
    const octokit = makeOctokit(async () => ({
      nodes: [
        { databaseId: null, body: "orphan body" },
        { databaseId: 10, body: "good" },
      ],
      rateLimit: makeRateLimit(),
    }));

    const result = await fetchDepPRBodies(octokit, ["N_1", "N_2"]);

    expect(result.bodies.size).toBe(1);
    expect(result.bodies.get(10)).toBe("good");
  });

  it("updates graphql rate limit from response", async () => {
    const rl = makeRateLimit();
    const octokit = makeOctokit(async () => ({
      nodes: [{ databaseId: 1, body: "x" }],
      rateLimit: rl,
    }));

    await fetchDepPRBodies(octokit, ["N_1"]);

    expect(mockUpdateGraphqlRateLimit).toHaveBeenCalledWith(rl);
  });
});

describe("fetchDepPRBodies — batching", () => {
  it("splits large input into NODES_BATCH_SIZE batches", async () => {
    const ids = Array.from({ length: NODES_BATCH_SIZE + 5 }, (_, i) => `PR_node_${i}`);
    const octokit = makeOctokit(async () => ({
      nodes: [],
      rateLimit: makeRateLimit(),
    }));

    await fetchDepPRBodies(octokit, ids);

    expect(octokit.graphql).toHaveBeenCalledTimes(2);
  });
});

describe("fetchDepPRBodies — error resilience", () => {
  it("returns partial results when one batch fails", async () => {
    let callCount = 0;
    const octokit = makeOctokit(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          nodes: [{ databaseId: 1, body: "batch1" }],
          rateLimit: makeRateLimit(),
        };
      }
      throw new Error("GraphQL error");
    });

    const ids = [
      ...Array.from({ length: NODES_BATCH_SIZE }, (_, i) => `batch1_${i}`),
      "batch2_0",
    ];
    const result = await fetchDepPRBodies(octokit, ids);

    expect(result.bodies.size).toBe(1);
    expect(result.bodies.get(1)).toBe("batch1");
    expect(result.failedIds.has("batch2_0")).toBe(true);
    expect(result.failedIds.size).toBe(1);
  });

  it("updates rate limit from partial error response", async () => {
    const rl = makeRateLimit();
    const octokit = makeOctokit(async () => {
      const err = new Error("partial") as Error & { data: unknown };
      err.data = { rateLimit: rl };
      throw err;
    });

    await fetchDepPRBodies(octokit, ["N_1"]);

    expect(mockUpdateGraphqlRateLimit).toHaveBeenCalledWith(rl);
  });

  it("exports GRAPHQL_BODY_FETCH_TIMEOUT_MS === 45_000, BODY_FETCH_BATCH_SIZE === 25, and BODY_FETCH_NOTIFICATION_THRESHOLD === 3", () => {
    expect(GRAPHQL_BODY_FETCH_TIMEOUT_MS).toBe(45_000);
    expect(BODY_FETCH_BATCH_SIZE).toBe(25);
    expect(BODY_FETCH_NOTIFICATION_THRESHOLD).toBe(3);
  });

  it("recursively binary-splits a 25-node batch (25 -> [12, 13] -> [6, 6] / [6, 7]) on retryable failure, recovering healthy siblings and capturing Sentry once", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ids = Array.from({ length: BODY_FETCH_BATCH_SIZE }, (_, i) => `PR_${i}`);
      const poisonId = "PR_20"; // in second half (indices 12..24 -> leaf 18..24 of size 7)
      const observedRetries: Array<number | undefined> = [];

      const octokit = makeOctokit(async (_query: string, variables: unknown) => {
        const { ids: batchIds, request } = variables as {
          ids: string[];
          request?: { retries?: number };
        };
        observedRetries.push(request?.retries);
        if (batchIds.includes(poisonId)) {
          throw Object.assign(new Error("502 Bad Gateway"), { status: 502 });
        }
        return {
          nodes: batchIds.map((id) => ({
            id,
            databaseId: Number(id.replace("PR_", "")) + 100,
            body: `body-${id}`,
          })),
        };
      });

      const result = await fetchDepPRBodies(octokit, ids);

      // Splittable (> 6) top-level batch and split sub-batches all use retries: 0 so 502/504 splits immediately
      expect(observedRetries.every((r) => r === 0)).toBe(true);

      // Non-splittable (<= 6) top-level batch uses retries: 1
      observedRetries.length = 0;
      await fetchDepPRBodies(octokit, ["PR_0"]);
      expect(observedRetries).toEqual([1]);

      // 25 -> [0..11 (12 ok), 12..24 (13 fail)] -> [12..17 (6 ok), 18..24 (7 fail)]
      // Because 7 > MIN_SPLIT_BATCH_SIZE (6), [18..24] splits once more into [18..20 (3 fail leaf), 21..24 (4 ok)]
      // 22 healthy nodes recovered (12 + 6 + 4), 3 leaf nodes in failedIds (PR_18, PR_19, PR_20)
      expect(result.bodies.size).toBe(22);
      expect(result.failedIds.size).toBe(3);
      expect(result.failedIds.has(poisonId)).toBe(true);
      expect(result.bodies.get(100)).toBe("body-PR_0");
      expect(result.bodies.get(117)).toBe("body-PR_17");
      expect(result.bodies.get(124)).toBe("body-PR_24");
      expect(captureException).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("short-circuits without binary splitting when batch fails with a non-retryable 403 status", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ids = Array.from({ length: BODY_FETCH_BATCH_SIZE }, (_, i) => `PR_${i}`);
      const octokit = makeOctokit(async () => {
        throw Object.assign(new Error("Forbidden"), { status: 403 });
      });

      const result = await fetchDepPRBodies(octokit, ids);

      expect(octokit.graphql).toHaveBeenCalledTimes(1);
      expect(result.bodies.size).toBe(0);
      expect(result.failedIds.size).toBe(BODY_FETCH_BATCH_SIZE);
      expect(captureException).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("salvages resolved nodes with id from partial err.data.nodes before computing remainingIds", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ids = Array.from({ length: 10 }, (_, i) => `PR_${i}`);
      const octokit = makeOctokit(async (_query: string, variables: unknown) => {
        const { ids: batchIds } = variables as { ids: string[] };
        if (batchIds.length === 10) {
          throw Object.assign(new Error("Partial GraphQL failure"), {
            status: 502,
            data: {
              nodes: batchIds.slice(0, 6).map((id, idx) => ({
                id,
                databaseId: 500 + idx,
                body: `salvaged-${id}`,
              })),
            },
          });
        }
        return { nodes: [] };
      });

      const result = await fetchDepPRBodies(octokit, ids);

      // 6 nodes salvaged via node.id -> remainingIds has 4 items (<= MIN_SPLIT_BATCH_SIZE = 6), so no split retry
      expect(octokit.graphql).toHaveBeenCalledTimes(1);
      expect(result.bodies.size).toBe(6);
      expect(result.bodies.get(500)).toBe("salvaged-PR_0");
      expect(result.bodies.get(505)).toBe("salvaged-PR_5");
      expect([...result.failedIds]).toEqual(["PR_6", "PR_7", "PR_8", "PR_9"]);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("fetchDepPRBodies — hung request timeout", () => {
  it("times out a never-resolving batch, warns, reports to Sentry on each failure, and notifies with silentToast only after 3 consecutive failures (dismissing on recovery)", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const octokit = makeOctokit(() => new Promise(() => {}));
      vi.mocked(getClient).mockReturnValue(octokit);

      // Failure 1: records failedIds & Sentry, but does NOT push notification (< 3 threshold)
      const p1 = fetchDepPRBodies(octokit, ["N_1"]);
      await vi.advanceTimersByTimeAsync(GRAPHQL_BODY_FETCH_TIMEOUT_MS);
      const result1 = await p1;

      expect(result1.bodies).toBeInstanceOf(Map);
      expect(result1.bodies.size).toBe(0);
      expect(result1.failedIds.has("N_1")).toBe(true);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(captureException).toHaveBeenCalledWith(
        expect.any(Error),
        { tags: { source: "depPRBodies" } }
      );
      expect(pushNotification).not.toHaveBeenCalled();

      // Failure 2: still below threshold (2 < 3)
      const p2 = fetchDepPRBodies(octokit, ["N_1"]);
      await vi.advanceTimersByTimeAsync(GRAPHQL_BODY_FETCH_TIMEOUT_MS);
      await p2;
      expect(pushNotification).not.toHaveBeenCalled();

      // Failure 3: reaches BODY_FETCH_NOTIFICATION_THRESHOLD (3) -> pushes silent drawer warning
      const p3 = fetchDepPRBodies(octokit, ["N_1"]);
      await vi.advanceTimersByTimeAsync(GRAPHQL_BODY_FETCH_TIMEOUT_MS);
      await p3;
      expect(pushNotification).toHaveBeenCalledTimes(1);
      expect(pushNotification).toHaveBeenCalledWith(
        "depPRBodies",
        expect.stringContaining("could not be determined"),
        "warning",
        true,
        undefined,
        { silentToast: true }
      );

      // Subsequent recovery resets failure counter and dismisses notification by source
      const healthyOctokit = makeOctokit(async () => ({
        nodes: [{ id: "N_1", databaseId: 1, body: "recovered body" }],
      }));
      vi.mocked(getClient).mockReturnValue(healthyOctokit);
      const recovered = await fetchDepPRBodies(healthyOctokit, ["N_1"]);
      expect(recovered.failedIds.size).toBe(0);
      expect(dismissNotificationBySource).toHaveBeenCalledWith("depPRBodies");

      // And resetBodyFetchFailures("depPRBodies") also dismisses directly when invoked
      vi.mocked(dismissNotificationBySource).mockClear();
      resetBodyFetchFailures("depPRBodies");
      expect(dismissNotificationBySource).toHaveBeenCalledWith("depPRBodies");
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

      const resultPromise = fetchDepPRBodies(octokit, ["N_1"]);
      vi.mocked(getClient).mockReturnValue(null);
      await vi.advanceTimersByTimeAsync(GRAPHQL_BODY_FETCH_TIMEOUT_MS);
      const result = await resultPromise;

      expect(result.failedIds.has("N_1")).toBe(true);
      expect(warnSpy).toHaveBeenCalled();
      expect(captureException).toHaveBeenCalled();
      expect(pushNotification).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("raceWithTimeout", () => {
  it("clears the timeout once the wrapped promise wins, so it never fires afterward", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const result = await raceWithTimeout(Promise.resolve("done"), GRAPHQL_BODY_FETCH_TIMEOUT_MS, controller);
      expect(result).toBe("done");

      await vi.advanceTimersByTimeAsync(GRAPHQL_BODY_FETCH_TIMEOUT_MS);

      expect(controller.signal.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
