import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchDepPRBodies } from "../../src/app/services/api";

const mockUpdateGraphqlRateLimit = vi.fn();
vi.mock("../../src/app/services/github", () => ({
  getClient: vi.fn(() => null),
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

const NODES_BATCH_SIZE = 100;

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
});

describe("fetchDepPRBodies — empty input", () => {
  it("returns an empty Map without calling graphql", async () => {
    const octokit = makeOctokit(async () => ({}));
    const result = await fetchDepPRBodies(octokit, []);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
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

    expect(result.size).toBe(2);
    expect(result.get(42)).toContain("lodash");
    expect(result.get(99)).toBe("Some PR body");
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

    expect(result.size).toBe(1);
    expect(result.get(1)).toBe("has body");
    expect(result.has(2)).toBe(false);
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

    expect(result.size).toBe(1);
    expect(result.has(1)).toBe(false);
    expect(result.get(2)).toBe("content");
  });

  it("skips null nodes in the response array", async () => {
    const octokit = makeOctokit(async () => ({
      nodes: [null, { databaseId: 5, body: "valid" }, null],
      rateLimit: makeRateLimit(),
    }));

    const result = await fetchDepPRBodies(octokit, ["N_1", "N_2", "N_3"]);

    expect(result.size).toBe(1);
    expect(result.get(5)).toBe("valid");
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

    expect(result.size).toBe(1);
    expect(result.get(10)).toBe("good");
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

    expect(result.size).toBe(1);
    expect(result.get(1)).toBe("batch1");
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
});
