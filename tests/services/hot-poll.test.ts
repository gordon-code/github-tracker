import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot } from "solid-js";
import { makePullRequest, makeWorkflowRun } from "../helpers/index";

// ── Mocks ─────────────────────────────────────────────────────────────────────

// Mock github module so getClient returns our fake octokit
const mockGetClient = vi.fn();
vi.mock("../../src/app/services/github", () => ({
  getClient: () => mockGetClient(),
  cachedRequest: vi.fn(),
  updateGraphqlRateLimit: vi.fn(),
  updateRateLimitFromHeaders: vi.fn(),
}));

// Mock errors/notifications so poll.ts module doesn't crash
vi.mock("../../src/app/lib/errors", () => ({
  pushError: vi.fn(),
  clearErrors: vi.fn(),
  getErrors: vi.fn(() => []),
  getNotifications: vi.fn(() => []),
  dismissNotificationBySource: vi.fn(),
  startCycleTracking: vi.fn(),
  endCycleTracking: vi.fn(() => new Set<string>()),
  pushNotification: vi.fn(),
  clearNotifications: vi.fn(),
  resetNotificationState: vi.fn(),
  addMutedSource: vi.fn(),
  isMuted: vi.fn(() => false),
  clearMutedSources: vi.fn(),
}));

vi.mock("../../src/app/lib/notifications", () => ({
  detectNewItems: vi.fn(() => []),
  dispatchNotifications: vi.fn(),
  _resetNotificationState: vi.fn(),
}));

vi.mock("../../src/app/stores/config", () => ({
  config: {
    selectedRepos: [],
    maxWorkflowsPerRepo: 5,
    maxRunsPerWorkflow: 3,
    hotPollInterval: 30,
  },
}));

vi.mock("../../src/app/stores/auth", () => ({
  user: vi.fn(() => null),
  onAuthCleared: vi.fn(),
}));

// Import AFTER mocks are set up
import {
  resetPollState,
  rebuildHotSets,
  fetchHotData,
  createHotPollCoordinator,
  getHotPollGeneration,
  type DashboardData,
} from "../../src/app/services/poll";

import {
  fetchHotPRStatus,
  fetchWorkflowRunById,
} from "../../src/app/services/api";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeOctokit(
  requestImpl?: (...args: unknown[]) => unknown,
  graphqlImpl?: (...args: unknown[]) => unknown,
) {
  return {
    request: vi.fn(requestImpl ?? (() => Promise.resolve({ data: {}, headers: {} }))),
    graphql: vi.fn(graphqlImpl ?? (() => Promise.resolve({ nodes: [], rateLimit: { remaining: 4999, resetAt: "2026-01-01T00:00:00Z" } }))),
    hook: { before: vi.fn() },
  };
}

const emptyData: DashboardData = {
  issues: [],
  pullRequests: [],
  workflowRuns: [],
  errors: [],
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("fetchHotPRStatus", () => {
  it("returns empty map for empty nodeIds", async () => {
    const octokit = makeOctokit();
    const result = await fetchHotPRStatus(octokit as never, []);
    expect(result.size).toBe(0);
    expect(octokit.graphql).not.toHaveBeenCalled();
  });

  it("maps databaseId to HotPRStatusUpdate correctly", async () => {
    const octokit = makeOctokit(undefined, () => Promise.resolve({
      nodes: [{
        databaseId: 42,
        state: "OPEN",
        mergeStateStatus: "CLEAN",
        reviewDecision: "APPROVED",
        commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
      }],
      rateLimit: { remaining: 4999, resetAt: "2026-01-01T00:00:00Z" },
    }));

    const result = await fetchHotPRStatus(octokit as never, ["PR_node1"]);
    expect(result.size).toBe(1);
    const update = result.get(42)!;
    expect(update.state).toBe("OPEN");
    expect(update.checkStatus).toBe("success");
    expect(update.mergeStateStatus).toBe("CLEAN");
    expect(update.reviewDecision).toBe("APPROVED");
  });

  it("applies mergeStateStatus overrides: DIRTY -> conflict", async () => {
    const octokit = makeOctokit(undefined, () => Promise.resolve({
      nodes: [{
        databaseId: 43,
        state: "OPEN",
        mergeStateStatus: "DIRTY",
        reviewDecision: null,
        commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
      }],
      rateLimit: { remaining: 4999, resetAt: "2026-01-01T00:00:00Z" },
    }));

    const result = await fetchHotPRStatus(octokit as never, ["PR_node2"]);
    expect(result.get(43)!.checkStatus).toBe("conflict");
  });

  it("applies mergeStateStatus overrides: UNSTABLE -> failure", async () => {
    const octokit = makeOctokit(undefined, () => Promise.resolve({
      nodes: [{
        databaseId: 44,
        state: "OPEN",
        mergeStateStatus: "UNSTABLE",
        reviewDecision: null,
        commits: { nodes: [{ commit: { statusCheckRollup: { state: "PENDING" } } }] },
      }],
      rateLimit: { remaining: 4999, resetAt: "2026-01-01T00:00:00Z" },
    }));

    const result = await fetchHotPRStatus(octokit as never, ["PR_node3"]);
    expect(result.get(44)!.checkStatus).toBe("failure");
  });
});

describe("fetchWorkflowRunById", () => {
  it("maps snake_case response to camelCase", async () => {
    const octokit = makeOctokit(() => Promise.resolve({
      data: {
        id: 100,
        status: "in_progress",
        conclusion: null,
        updated_at: "2026-03-29T10:00:00Z",
        completed_at: null,
      },
      headers: {},
    }));

    const result = await fetchWorkflowRunById(octokit as never, {
      id: 100,
      owner: "org",
      repo: "my-repo",
    });

    expect(result.id).toBe(100);
    expect(result.status).toBe("in_progress");
    expect(result.conclusion).toBeNull();
    expect(result.updatedAt).toBe("2026-03-29T10:00:00Z");
    expect(result.completedAt).toBeNull();
  });

  it("calls octokit.request with correct route and params", async () => {
    const octokit = makeOctokit(() => Promise.resolve({
      data: { id: 200, status: "completed", conclusion: "success", updated_at: "2026-01-01T00:00:00Z", completed_at: "2026-01-01T00:05:00Z" },
      headers: {},
    }));

    await fetchWorkflowRunById(octokit as never, { id: 200, owner: "myorg", repo: "myrepo" });
    expect(octokit.request).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/actions/runs/{run_id}",
      { owner: "myorg", repo: "myrepo", run_id: 200 },
    );
  });
});

describe("rebuildHotSets", () => {
  beforeEach(() => {
    resetPollState();
  });

  it("increments generation on each call", () => {
    expect(getHotPollGeneration()).toBe(0);
    rebuildHotSets(emptyData);
    expect(getHotPollGeneration()).toBe(1);
    rebuildHotSets(emptyData);
    expect(getHotPollGeneration()).toBe(2);
  });

  it("populates hot PRs for pending/null checkStatus with nodeId", async () => {
    const octokit = makeOctokit(undefined, () => Promise.resolve({
      nodes: [],
      rateLimit: { remaining: 4999, resetAt: "2026-01-01T00:00:00Z" },
    }));
    mockGetClient.mockReturnValue(octokit);

    rebuildHotSets({
      ...emptyData,
      pullRequests: [
        makePullRequest({ id: 1, checkStatus: "pending", nodeId: "PR_a" }),
        makePullRequest({ id: 2, checkStatus: null, nodeId: "PR_b" }),
        makePullRequest({ id: 3, checkStatus: "success", nodeId: "PR_c" }), // should be skipped
        makePullRequest({ id: 4, checkStatus: "pending" }), // no nodeId, should be skipped
      ],
    });

    await fetchHotData();
    // Verify graphql was called with only the 2 eligible node IDs
    expect(octokit.graphql).toHaveBeenCalledTimes(1);
    const calledIds = (octokit.graphql.mock.calls[0][1] as { ids: string[] }).ids;
    expect(calledIds).toHaveLength(2);
    expect(calledIds).toContain("PR_a");
    expect(calledIds).toContain("PR_b");
  });

  it("populates hot runs for queued/in_progress, skips completed", async () => {
    const requestFn = vi.fn(() => Promise.resolve({
      data: { id: 1, status: "in_progress", conclusion: null, updated_at: "2026-01-01T00:00:00Z", completed_at: null },
      headers: {},
    }));
    const octokit = makeOctokit(requestFn);
    mockGetClient.mockReturnValue(octokit);

    rebuildHotSets({
      ...emptyData,
      workflowRuns: [
        makeWorkflowRun({ id: 10, status: "in_progress", conclusion: null, repoFullName: "org/repo1" }),
        makeWorkflowRun({ id: 11, status: "queued", conclusion: null, repoFullName: "org/repo2" }),
        makeWorkflowRun({ id: 12, status: "completed", conclusion: "success", repoFullName: "org/repo3" }),
      ],
    });

    await fetchHotData();
    // Only 2 runs fetched (in_progress + queued), not the completed one
    expect(requestFn).toHaveBeenCalledTimes(2);
  });

  it("clears and replaces on each call", async () => {
    const octokit = makeOctokit(
      () => Promise.resolve({
        data: { id: 1, status: "in_progress", conclusion: null, updated_at: "2026-01-01T00:00:00Z", completed_at: null },
        headers: {},
      }),
      () => Promise.resolve({ nodes: [], rateLimit: { remaining: 4999, resetAt: "2026-01-01T00:00:00Z" } }),
    );
    mockGetClient.mockReturnValue(octokit);

    // First call with 2 runs
    rebuildHotSets({
      ...emptyData,
      workflowRuns: [
        makeWorkflowRun({ id: 10, status: "in_progress", conclusion: null, repoFullName: "org/repo1" }),
        makeWorkflowRun({ id: 11, status: "in_progress", conclusion: null, repoFullName: "org/repo2" }),
      ],
    });

    // Second call with only 1 run — should replace, not merge
    rebuildHotSets({
      ...emptyData,
      workflowRuns: [
        makeWorkflowRun({ id: 20, status: "queued", conclusion: null, repoFullName: "org/repo3" }),
      ],
    });

    await fetchHotData();
    // Should only fetch 1 run (from second call), not 3
    expect(octokit.request).toHaveBeenCalledTimes(1);
  });
});

describe("fetchHotData", () => {
  beforeEach(() => {
    resetPollState();
    mockGetClient.mockReset();
  });

  it("returns empty maps when both hot sets are empty", async () => {
    const { prUpdates, runUpdates } = await fetchHotData();
    expect(prUpdates.size).toBe(0);
    expect(runUpdates.size).toBe(0);
  });

  it("returns empty maps when no client available", async () => {
    mockGetClient.mockReturnValue(null);
    rebuildHotSets({
      ...emptyData,
      workflowRuns: [makeWorkflowRun({ id: 1, status: "in_progress", conclusion: null, repoFullName: "o/r" })],
    });
    const { prUpdates, runUpdates } = await fetchHotData();
    expect(prUpdates.size).toBe(0);
    expect(runUpdates.size).toBe(0);
  });

  it("evicts PRs from hot set when checkStatus resolves", async () => {
    const graphqlFn = vi.fn(() => Promise.resolve({
      nodes: [{
        databaseId: 1,
        state: "OPEN",
        mergeStateStatus: "CLEAN",
        reviewDecision: "APPROVED",
        commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
      }],
      rateLimit: { remaining: 4999, resetAt: "2026-01-01T00:00:00Z" },
    }));
    const octokit = makeOctokit(undefined, graphqlFn);
    mockGetClient.mockReturnValue(octokit);

    rebuildHotSets({
      ...emptyData,
      pullRequests: [makePullRequest({ id: 1, checkStatus: "pending", nodeId: "PR_x" })],
    });

    // First fetch — PR is hot, returns success -> evicts
    const first = await fetchHotData();
    expect(first.prUpdates.size).toBe(1);
    expect(first.prUpdates.get(1)!.checkStatus).toBe("success");

    // Second fetch — PR was evicted, should not query
    graphqlFn.mockClear();
    const second = await fetchHotData();
    expect(second.prUpdates.size).toBe(0);
    expect(graphqlFn).not.toHaveBeenCalled();
  });

  it("evicts runs from hot set when status becomes completed", async () => {
    const requestFn = vi.fn(() => Promise.resolve({
      data: { id: 10, status: "completed", conclusion: "success", updated_at: "2026-01-01T00:05:00Z", completed_at: "2026-01-01T00:05:00Z" },
      headers: {},
    }));
    const octokit = makeOctokit(requestFn);
    mockGetClient.mockReturnValue(octokit);

    rebuildHotSets({
      ...emptyData,
      workflowRuns: [makeWorkflowRun({ id: 10, status: "in_progress", conclusion: null, repoFullName: "o/r" })],
    });

    // First fetch — run completes -> evicts
    const first = await fetchHotData();
    expect(first.runUpdates.size).toBe(1);
    expect(first.runUpdates.get(10)!.status).toBe("completed");

    // Second fetch — run was evicted
    requestFn.mockClear();
    const second = await fetchHotData();
    expect(second.runUpdates.size).toBe(0);
    expect(requestFn).not.toHaveBeenCalled();
  });

  it("returns captured generation matching getHotPollGeneration at call time", async () => {
    mockGetClient.mockReturnValue(null); // skip actual fetch
    rebuildHotSets(emptyData); // gen = 1
    const { generation } = await fetchHotData();
    expect(generation).toBe(1);
    expect(generation).toBe(getHotPollGeneration());
  });
});

describe("createHotPollCoordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetPollState();
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    mockGetClient.mockReset();
  });

  it("schedules cycle after interval", async () => {
    const onHotData = vi.fn();
    mockGetClient.mockReturnValue(null); // no client = no-op cycle

    // Put something in hot sets so it doesn't skip
    rebuildHotSets({
      ...emptyData,
      workflowRuns: [makeWorkflowRun({ id: 1, status: "in_progress", conclusion: null, repoFullName: "o/r" })],
    });

    await createRoot(async (dispose) => {
      createHotPollCoordinator(() => 30, onHotData);
      // First cycle fires after 30s
      await vi.advanceTimersByTimeAsync(30_000);
      // onHotData gets called with empty maps (no client)
      expect(onHotData).toHaveBeenCalled();
      dispose();
    });
  });

  it("no-op cycle when hot sets are empty", async () => {
    const onHotData = vi.fn();
    mockGetClient.mockReturnValue(makeOctokit());

    await createRoot(async (dispose) => {
      createHotPollCoordinator(() => 10, onHotData);
      await vi.advanceTimersByTimeAsync(10_000);
      // No hot items = no fetch = no callback
      expect(onHotData).not.toHaveBeenCalled();
      dispose();
    });
  });

  it("destroy() prevents further cycles after current one completes", async () => {
    const onHotData = vi.fn();
    mockGetClient.mockReturnValue(null);

    rebuildHotSets({
      ...emptyData,
      workflowRuns: [makeWorkflowRun({ id: 1, status: "in_progress", conclusion: null, repoFullName: "o/r" })],
    });

    await createRoot(async (dispose) => {
      const coord = createHotPollCoordinator(() => 10, onHotData);
      // Let the initial cycle fire
      await vi.advanceTimersByTimeAsync(10_000);
      const callsBefore = onHotData.mock.calls.length;
      coord.destroy();
      // Advance past several more intervals — no new calls
      await vi.advanceTimersByTimeAsync(30_000);
      expect(onHotData.mock.calls.length).toBe(callsBefore);
      dispose();
    });
  });

  it("does not schedule when interval is 0", async () => {
    const onHotData = vi.fn();
    mockGetClient.mockReturnValue(makeOctokit());

    rebuildHotSets({
      ...emptyData,
      workflowRuns: [makeWorkflowRun({ id: 1, status: "in_progress", conclusion: null, repoFullName: "o/r" })],
    });

    await createRoot(async (dispose) => {
      createHotPollCoordinator(() => 0, onHotData);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(onHotData).not.toHaveBeenCalled();
      dispose();
    });
  });
});
