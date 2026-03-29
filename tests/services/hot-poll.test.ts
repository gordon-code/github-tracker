import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, createSignal } from "solid-js";
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
  clearHotSets,
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
    const { results, hadErrors } = await fetchHotPRStatus(octokit as never, []);
    expect(results.size).toBe(0);
    expect(hadErrors).toBe(false);
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

    const { results } = await fetchHotPRStatus(octokit as never, ["PR_node1"]);
    expect(results.size).toBe(1);
    const update = results.get(42)!;
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

    const { results } = await fetchHotPRStatus(octokit as never, ["PR_node2"]);
    expect(results.get(43)!.checkStatus).toBe("conflict");
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

    const { results } = await fetchHotPRStatus(octokit as never, ["PR_node3"]);
    expect(results.get(44)!.checkStatus).toBe("failure");
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

  it("calls updateRateLimitFromHeaders after request", async () => {
    const { updateRateLimitFromHeaders } = await import("../../src/app/services/github");
    const octokit = makeOctokit(() => Promise.resolve({
      data: { id: 300, status: "completed", conclusion: "success", updated_at: "2026-01-01T00:00:00Z", completed_at: "2026-01-01T00:05:00Z" },
      headers: { "x-ratelimit-remaining": "4999" },
    }));

    await fetchWorkflowRunById(octokit as never, { id: 300, owner: "org", repo: "repo" });
    expect(updateRateLimitFromHeaders).toHaveBeenCalledWith({ "x-ratelimit-remaining": "4999" });
  });
});

describe("resetPollState", () => {
  it("clears hot sets and resets generation", async () => {
    rebuildHotSets({
      ...emptyData,
      pullRequests: [makePullRequest({ id: 1, checkStatus: "pending", nodeId: "PR_x" })],
      workflowRuns: [makeWorkflowRun({ id: 10, status: "in_progress", conclusion: null, repoFullName: "o/r" })],
    });
    expect(getHotPollGeneration()).toBe(1);

    resetPollState();
    expect(getHotPollGeneration()).toBe(0);

    // After reset, fetchHotData should have nothing to fetch
    mockGetClient.mockReturnValue(makeOctokit());
    const { prUpdates, runUpdates } = await fetchHotData();
    expect(prUpdates.size).toBe(0);
    expect(runUpdates.size).toBe(0);
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

  it("silently skips runs with malformed repoFullName", async () => {
    const requestFn = vi.fn(() => Promise.resolve({
      data: { id: 1, status: "in_progress", conclusion: null, updated_at: "2026-01-01T00:00:00Z", completed_at: null },
      headers: {},
    }));
    const octokit = makeOctokit(requestFn);
    mockGetClient.mockReturnValue(octokit);

    rebuildHotSets({
      ...emptyData,
      workflowRuns: [
        makeWorkflowRun({ id: 10, status: "in_progress", conclusion: null, repoFullName: "noslash" }),
        makeWorkflowRun({ id: 11, status: "in_progress", conclusion: null, repoFullName: "" }),
        makeWorkflowRun({ id: 12, status: "in_progress", conclusion: null, repoFullName: "org/repo" }),
      ],
    });

    await fetchHotData();
    // Only the valid "org/repo" run should be fetched
    expect(requestFn).toHaveBeenCalledTimes(1);
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
    const requestFn = vi.fn(() => Promise.resolve({
      data: { id: 1, status: "in_progress", conclusion: null, updated_at: "2026-01-01T00:00:00Z", completed_at: null },
      headers: {},
    }));
    mockGetClient.mockReturnValue(makeOctokit(requestFn));

    rebuildHotSets({
      ...emptyData,
      workflowRuns: [makeWorkflowRun({ id: 1, status: "in_progress", conclusion: null, repoFullName: "o/r" })],
    });

    await createRoot(async (dispose) => {
      createHotPollCoordinator(() => 30, onHotData);
      // First cycle fires after 30s
      await vi.advanceTimersByTimeAsync(30_000);
      expect(onHotData).toHaveBeenCalled();
      dispose();
    });
  });

  it("skips onHotData when no client is available", async () => {
    const onHotData = vi.fn();
    mockGetClient.mockReturnValue(null);

    rebuildHotSets({
      ...emptyData,
      workflowRuns: [makeWorkflowRun({ id: 1, status: "in_progress", conclusion: null, repoFullName: "o/r" })],
    });

    await createRoot(async (dispose) => {
      createHotPollCoordinator(() => 10, onHotData);
      await vi.advanceTimersByTimeAsync(10_000);
      // No client → cycle skips fetch and onHotData
      expect(onHotData).not.toHaveBeenCalled();
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

  it("skips fetch when document is hidden", async () => {
    const onHotData = vi.fn();
    mockGetClient.mockReturnValue(makeOctokit());

    rebuildHotSets({
      ...emptyData,
      workflowRuns: [makeWorkflowRun({ id: 1, status: "in_progress", conclusion: null, repoFullName: "o/r" })],
    });

    await createRoot(async (dispose) => {
      createHotPollCoordinator(() => 10, onHotData);
      Object.defineProperty(document, "visibilityState", { value: "hidden", writable: true, configurable: true });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(onHotData).not.toHaveBeenCalled();
      Object.defineProperty(document, "visibilityState", { value: "visible", writable: true, configurable: true });
      dispose();
    });
  });

  it("resets backoff counter on successful cycle", async () => {
    const onHotData = vi.fn();
    const requestFn = vi.fn(() => Promise.resolve({
      data: { id: 1, status: "in_progress", conclusion: null, updated_at: "2026-01-01T00:00:00Z", completed_at: null },
      headers: {},
    }));
    mockGetClient.mockReturnValue(makeOctokit(requestFn));

    rebuildHotSets({
      ...emptyData,
      workflowRuns: [makeWorkflowRun({ id: 1, status: "in_progress", conclusion: null, repoFullName: "o/r" })],
    });

    await createRoot(async (dispose) => {
      createHotPollCoordinator(() => 10, onHotData);
      // Cycle 1 at 10s
      await vi.advanceTimersByTimeAsync(10_000);
      expect(onHotData).toHaveBeenCalledTimes(1);
      // Cycle 2 at 20s (no backoff because previous succeeded)
      await vi.advanceTimersByTimeAsync(10_000);
      expect(onHotData).toHaveBeenCalledTimes(2);
      dispose();
    });
  });

  it("restarts chain when interval signal changes", async () => {
    const onHotData = vi.fn();
    const requestFn = vi.fn(() => Promise.resolve({
      data: { id: 1, status: "in_progress", conclusion: null, updated_at: "2026-01-01T00:00:00Z", completed_at: null },
      headers: {},
    }));
    mockGetClient.mockReturnValue(makeOctokit(requestFn));

    rebuildHotSets({
      ...emptyData,
      workflowRuns: [makeWorkflowRun({ id: 1, status: "in_progress", conclusion: null, repoFullName: "o/r" })],
    });

    await createRoot(async (dispose) => {
      const [interval, setInterval] = createSignal(30);
      createHotPollCoordinator(interval, onHotData);

      // Advance 15s into the 30s cycle — no callback yet
      await vi.advanceTimersByTimeAsync(15_000);
      expect(onHotData).not.toHaveBeenCalled();

      // Change interval to 10s — destroys old chain, starts new one
      setInterval(10);
      // Need a microtask tick for SolidJS effect to re-run
      await vi.advanceTimersByTimeAsync(0);
      // The new chain should fire at 10s from now
      await vi.advanceTimersByTimeAsync(10_000);
      expect(onHotData).toHaveBeenCalledTimes(1);
      dispose();
    });
  });

  it("applies exponential backoff on errors", async () => {
    const onHotData = vi.fn();
    // fetchHotPRStatus uses Promise.allSettled, so graphql errors set hadErrors=true
    // without throwing — consecutiveFailures increments via the hadErrors path
    const graphqlFn = vi.fn(() => Promise.reject(new Error("api error")));
    const octokit = makeOctokit(undefined, graphqlFn);
    mockGetClient.mockReturnValue(octokit);

    rebuildHotSets({
      ...emptyData,
      pullRequests: [makePullRequest({ id: 1, checkStatus: "pending", nodeId: "PR_a" })],
    });

    await createRoot(async (dispose) => {
      createHotPollCoordinator(() => 10, onHotData);

      // First cycle at 10s — hadErrors=true, consecutiveFailures=1
      await vi.advanceTimersByTimeAsync(10_000);
      const callsAfterFirst = graphqlFn.mock.calls.length;
      expect(callsAfterFirst).toBe(1);

      // Next cycle should be at 10s * 2^1 = 20s from first cycle
      // Advance 10s — should NOT have fired another fetch yet
      await vi.advanceTimersByTimeAsync(10_000);
      expect(graphqlFn.mock.calls.length).toBe(callsAfterFirst); // still 1

      // Advance another 10s (20s total since first cycle) — second fetch fires
      await vi.advanceTimersByTimeAsync(10_000);
      expect(graphqlFn.mock.calls.length).toBe(callsAfterFirst + 1); // now 2
      dispose();
    });
  });

  it("calls pushError when cycle throws", async () => {
    const onHotData = vi.fn();
    // Make getClient() throw (now inside the try block) to trigger the catch path
    mockGetClient.mockImplementation(() => { throw new Error("auth crash"); });

    rebuildHotSets({
      ...emptyData,
      workflowRuns: [makeWorkflowRun({ id: 1, status: "in_progress", conclusion: null, repoFullName: "o/r" })],
    });

    const { pushError } = await import("../../src/app/lib/errors");
    (pushError as ReturnType<typeof vi.fn>).mockClear();

    await createRoot(async (dispose) => {
      createHotPollCoordinator(() => 10, onHotData);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(pushError).toHaveBeenCalledWith("hot-poll", "auth crash", true);
      expect(onHotData).not.toHaveBeenCalled();
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

describe("fetchHotPRStatus null/missing nodes", () => {
  it("skips null nodes and processes valid ones", async () => {
    const octokit = makeOctokit(undefined, () => Promise.resolve({
      nodes: [
        null,
        {
          databaseId: 99,
          state: "OPEN",
          mergeStateStatus: "CLEAN",
          reviewDecision: null,
          commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
        },
      ],
      rateLimit: { remaining: 4999, resetAt: "2026-01-01T00:00:00Z" },
    }));

    const { results } = await fetchHotPRStatus(octokit as never, ["PR_null", "PR_valid"]);
    expect(results.size).toBe(1);
    expect(results.get(99)!.checkStatus).toBe("success");
  });

  it("skips nodes with null databaseId", async () => {
    const octokit = makeOctokit(undefined, () => Promise.resolve({
      nodes: [
        { databaseId: null, state: "OPEN", mergeStateStatus: "CLEAN", reviewDecision: null, commits: { nodes: [] } },
        { databaseId: 77, state: "OPEN", mergeStateStatus: "CLEAN", reviewDecision: null, commits: { nodes: [{ commit: { statusCheckRollup: { state: "PENDING" } } }] } },
      ],
      rateLimit: { remaining: 4999, resetAt: "2026-01-01T00:00:00Z" },
    }));

    const { results } = await fetchHotPRStatus(octokit as never, ["PR_nulldb", "PR_ok"]);
    expect(results.size).toBe(1);
    expect(results.has(77)).toBe(true);
  });
});

describe("fetchHotPRStatus edge cases", () => {
  it("applies BEHIND mergeStateStatus override to conflict", async () => {
    const octokit = makeOctokit(undefined, () => Promise.resolve({
      nodes: [{
        databaseId: 50,
        state: "OPEN",
        mergeStateStatus: "BEHIND",
        reviewDecision: null,
        commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
      }],
      rateLimit: { remaining: 4999, resetAt: "2026-01-01T00:00:00Z" },
    }));

    const { results } = await fetchHotPRStatus(octokit as never, ["PR_behind"]);
    expect(results.get(50)!.checkStatus).toBe("conflict");
  });

  it("returns partial results and hadErrors when one batch fails", async () => {
    let callCount = 0;
    const octokit = makeOctokit(undefined, () => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          nodes: [{
            databaseId: 1,
            state: "OPEN",
            mergeStateStatus: "CLEAN",
            reviewDecision: null,
            commits: { nodes: [{ commit: { statusCheckRollup: { state: "PENDING" } } }] },
          }],
          rateLimit: { remaining: 4999, resetAt: "2026-01-01T00:00:00Z" },
        });
      }
      return Promise.reject(new Error("rate limited"));
    });

    // Need >100 node IDs to trigger 2 batches
    const nodeIds = Array.from({ length: 101 }, (_, i) => `PR_${i}`);
    const { results, hadErrors } = await fetchHotPRStatus(octokit as never, nodeIds);
    // First batch succeeded with 1 result, second batch failed
    expect(results.size).toBe(1);
    expect(results.get(1)).toBeDefined();
    expect(hadErrors).toBe(true);
  });
});

describe("rebuildHotSets caps", () => {
  beforeEach(() => {
    resetPollState();
  });

  it("caps hot PRs at MAX_HOT_PRS (200)", async () => {
    const prs = Array.from({ length: 250 }, (_, i) =>
      makePullRequest({ id: i + 1, checkStatus: "pending", nodeId: `PR_${i}` })
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    rebuildHotSets({ ...emptyData, pullRequests: prs });

    const octokit = makeOctokit(undefined, () => Promise.resolve({
      nodes: [],
      rateLimit: { remaining: 4999, resetAt: "2026-01-01T00:00:00Z" },
    }));
    mockGetClient.mockReturnValue(octokit);

    await fetchHotData();
    // graphql should be called with at most 200 node IDs (batched at 100)
    const allIds = (octokit.graphql.mock.calls as Array<[string, { ids: string[] }]>)
      .flatMap(c => c[1].ids);
    expect(allIds.length).toBe(200);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("PR cap reached"));
    warnSpy.mockRestore();
  });

  it("caps hot runs at MAX_HOT_RUNS (30)", async () => {
    const runs = Array.from({ length: 40 }, (_, i) =>
      makeWorkflowRun({ id: i + 1, status: "in_progress", conclusion: null, repoFullName: `org/repo${i}` })
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    rebuildHotSets({ ...emptyData, workflowRuns: runs });

    const requestFn = vi.fn(() => Promise.resolve({
      data: { id: 1, status: "in_progress", conclusion: null, updated_at: "2026-01-01T00:00:00Z", completed_at: null },
      headers: {},
    }));
    const octokit = makeOctokit(requestFn);
    mockGetClient.mockReturnValue(octokit);

    await fetchHotData();
    expect(requestFn).toHaveBeenCalledTimes(30);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Run cap reached"));
    warnSpy.mockRestore();
  });
});

describe("fetchHotData eviction edge cases", () => {
  beforeEach(() => {
    resetPollState();
    mockGetClient.mockReset();
  });

  it("evicts one PR while retaining the other in a two-PR hot set", async () => {
    let callCount = 0;
    const graphqlFn = vi.fn(() => {
      callCount++;
      if (callCount === 1) {
        // First fetch: PR 1 resolved (success), PR 2 still pending
        return Promise.resolve({
          nodes: [
            { databaseId: 1, state: "OPEN", mergeStateStatus: "CLEAN", reviewDecision: null, commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] } },
            { databaseId: 2, state: "OPEN", mergeStateStatus: "CLEAN", reviewDecision: null, commits: { nodes: [{ commit: { statusCheckRollup: { state: "PENDING" } } }] } },
          ],
          rateLimit: { remaining: 4999, resetAt: "2026-01-01T00:00:00Z" },
        });
      }
      // Second fetch: only PR 2 should be queried
      return Promise.resolve({
        nodes: [
          { databaseId: 2, state: "OPEN", mergeStateStatus: "CLEAN", reviewDecision: null, commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] } },
        ],
        rateLimit: { remaining: 4999, resetAt: "2026-01-01T00:00:00Z" },
      });
    });
    const octokit = makeOctokit(undefined, graphqlFn);
    mockGetClient.mockReturnValue(octokit);

    rebuildHotSets({
      ...emptyData,
      pullRequests: [
        makePullRequest({ id: 1, checkStatus: "pending", nodeId: "PR_one" }),
        makePullRequest({ id: 2, checkStatus: "pending", nodeId: "PR_two" }),
      ],
    });

    // First fetch — PR 1 resolves, PR 2 stays pending
    const first = await fetchHotData();
    expect(first.prUpdates.size).toBe(2);

    // Second fetch — only PR 2 should be queried (PR 1 was evicted)
    const second = await fetchHotData();
    expect(second.prUpdates.size).toBe(1);
    expect(second.prUpdates.has(2)).toBe(true);
    // Verify graphql was called with only PR_two's nodeId
    const secondCallArgs = graphqlFn.mock.calls[1] as unknown as [string, { ids: string[] }];
    expect(secondCallArgs[1].ids).toEqual(["PR_two"]);
  });

  it("evicts PRs when state is MERGED even with pending checkStatus", async () => {
    const graphqlFn = vi.fn(() => Promise.resolve({
      nodes: [{
        databaseId: 1,
        state: "MERGED",
        mergeStateStatus: "CLEAN",
        reviewDecision: "APPROVED",
        commits: { nodes: [{ commit: { statusCheckRollup: { state: "PENDING" } } }] },
      }],
      rateLimit: { remaining: 4999, resetAt: "2026-01-01T00:00:00Z" },
    }));
    const octokit = makeOctokit(undefined, graphqlFn);
    mockGetClient.mockReturnValue(octokit);

    rebuildHotSets({
      ...emptyData,
      pullRequests: [makePullRequest({ id: 1, checkStatus: "pending", nodeId: "PR_merged" })],
    });

    const first = await fetchHotData();
    expect(first.prUpdates.get(1)!.state).toBe("MERGED");

    // Should be evicted — MERGED state takes priority over pending checks
    graphqlFn.mockClear();
    const second = await fetchHotData();
    expect(second.prUpdates.size).toBe(0);
    expect(graphqlFn).not.toHaveBeenCalled();
  });

  it("evicts PRs when state is CLOSED", async () => {
    const graphqlFn = vi.fn(() => Promise.resolve({
      nodes: [{
        databaseId: 2,
        state: "CLOSED",
        mergeStateStatus: "CLEAN",
        reviewDecision: null,
        commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
      }],
      rateLimit: { remaining: 4999, resetAt: "2026-01-01T00:00:00Z" },
    }));
    const octokit = makeOctokit(undefined, graphqlFn);
    mockGetClient.mockReturnValue(octokit);

    rebuildHotSets({
      ...emptyData,
      pullRequests: [makePullRequest({ id: 2, checkStatus: null, nodeId: "PR_closed" })],
    });

    await fetchHotData();
    graphqlFn.mockClear();
    const second = await fetchHotData();
    expect(second.prUpdates.size).toBe(0);
  });
});

describe("clearHotSets", () => {
  it("empties both hot maps so next fetchHotData is a no-op", async () => {
    rebuildHotSets({
      ...emptyData,
      pullRequests: [makePullRequest({ id: 1, checkStatus: "pending", nodeId: "PR_a" })],
      workflowRuns: [makeWorkflowRun({ id: 10, status: "in_progress", conclusion: null, repoFullName: "o/r" })],
    });

    clearHotSets();

    const octokit = makeOctokit();
    mockGetClient.mockReturnValue(octokit);
    const { prUpdates, runUpdates } = await fetchHotData();
    expect(prUpdates.size).toBe(0);
    expect(runUpdates.size).toBe(0);
    // Should not have made any API calls
    expect(octokit.graphql).not.toHaveBeenCalled();
    expect(octokit.request).not.toHaveBeenCalled();
  });
});

describe("fetchHotData hadErrors", () => {
  beforeEach(() => {
    resetPollState();
    mockGetClient.mockReset();
  });

  it("returns hadErrors=false when all fetches succeed", async () => {
    const octokit = makeOctokit(
      () => Promise.resolve({
        data: { id: 10, status: "in_progress", conclusion: null, updated_at: "2026-01-01T00:00:00Z", completed_at: null },
        headers: {},
      }),
      () => Promise.resolve({
        nodes: [{ databaseId: 1, state: "OPEN", mergeStateStatus: "CLEAN", reviewDecision: null, commits: { nodes: [{ commit: { statusCheckRollup: { state: "PENDING" } } }] } }],
        rateLimit: { remaining: 4999, resetAt: "2026-01-01T00:00:00Z" },
      }),
    );
    mockGetClient.mockReturnValue(octokit);

    rebuildHotSets({
      ...emptyData,
      pullRequests: [makePullRequest({ id: 1, checkStatus: "pending", nodeId: "PR_a" })],
      workflowRuns: [makeWorkflowRun({ id: 10, status: "in_progress", conclusion: null, repoFullName: "o/r" })],
    });

    const { hadErrors } = await fetchHotData();
    expect(hadErrors).toBe(false);
  });

  it("returns hadErrors=true when PR fetch fails", async () => {
    const octokit = makeOctokit(undefined, () => Promise.reject(new Error("graphql error")));
    mockGetClient.mockReturnValue(octokit);

    rebuildHotSets({
      ...emptyData,
      pullRequests: [makePullRequest({ id: 1, checkStatus: "pending", nodeId: "PR_a" })],
    });

    const { hadErrors, prUpdates } = await fetchHotData();
    expect(hadErrors).toBe(true);
    expect(prUpdates.size).toBe(0); // failed, no results
  });

  it("returns hadErrors=true when a run fetch fails", async () => {
    const octokit = makeOctokit(
      () => Promise.reject(new Error("network error")),
      () => Promise.resolve({ nodes: [], rateLimit: { remaining: 4999, resetAt: "2026-01-01T00:00:00Z" } }),
    );
    mockGetClient.mockReturnValue(octokit);

    rebuildHotSets({
      ...emptyData,
      workflowRuns: [makeWorkflowRun({ id: 10, status: "in_progress", conclusion: null, repoFullName: "o/r" })],
    });

    const { hadErrors, runUpdates } = await fetchHotData();
    expect(hadErrors).toBe(true);
    expect(runUpdates.size).toBe(0); // failed, no results
  });
});

describe("fetchHotPRStatus updateGraphqlRateLimit", () => {
  it("calls updateGraphqlRateLimit when response includes rateLimit", async () => {
    const { updateGraphqlRateLimit } = await import("../../src/app/services/github");
    const octokit = makeOctokit(undefined, () => Promise.resolve({
      nodes: [{ databaseId: 1, state: "OPEN", mergeStateStatus: "CLEAN", reviewDecision: null, commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] } }],
      rateLimit: { remaining: 4200, resetAt: "2026-01-01T01:00:00Z" },
    }));

    await fetchHotPRStatus(octokit as never, ["PR_rl"]);
    expect(updateGraphqlRateLimit).toHaveBeenCalledWith({ remaining: 4200, resetAt: "2026-01-01T01:00:00Z" });
  });
});
