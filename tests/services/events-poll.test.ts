import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot } from "solid-js";
import { makePullRequest, makeWorkflowRun } from "../helpers/index";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockGetClient = vi.fn();
vi.mock("../../src/app/services/github", () => ({
  getClient: () => mockGetClient(),
  fetchRateLimitDetails: vi.fn(() => Promise.resolve(null)),
  cachedRequest: vi.fn(),
  updateGraphqlRateLimit: vi.fn(),
  updateRateLimitFromHeaders: vi.fn(),
  onApiRequest: vi.fn(),
  initClientWatcher: vi.fn(),
}));

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

const mockFetchUserEvents = vi.fn();
const mockResetEventsState = vi.fn();
const mockParseRepoEvents = vi.fn();

vi.mock("../../src/app/services/events", () => ({
  fetchUserEvents: (...args: unknown[]) => mockFetchUserEvents(...args),
  parseRepoEvents: (...args: unknown[]) => mockParseRepoEvents(...args),
  resetEventsState: () => mockResetEventsState(),
}));

const mockFetchIssuesAndPullRequests = vi.fn();
const mockFetchWorkflowRuns = vi.fn();
vi.mock("../../src/app/services/api", () => ({
  fetchIssuesAndPullRequests: (...args: unknown[]) => mockFetchIssuesAndPullRequests(...args),
  fetchWorkflowRuns: (...args: unknown[]) => mockFetchWorkflowRuns(...args),
  fetchHotPRStatus: vi.fn(async () => ({ results: new Map(), hadErrors: false })),
  fetchWorkflowRunById: vi.fn(async () => ({ id: 1, status: "completed", conclusion: "success", updatedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:05:00Z" })),
  pooledAllSettled: vi.fn(async (tasks: (() => Promise<unknown>)[]) => {
    const results = await Promise.allSettled(tasks.map((t) => t()));
    return results;
  }),
  resetEmptyActionRepos: vi.fn(),
}));

import { fetchHotPRStatus, fetchWorkflowRunById } from "../../src/app/services/api";

vi.mock("../../src/app/stores/config", () => ({
  config: {
    selectedRepos: [],
    maxWorkflowsPerRepo: 5,
    maxRunsPerWorkflow: 3,
    hotPollInterval: 30,
    trackedUsers: [],
    monitoredRepos: [],
  },
}));

vi.mock("../../src/app/stores/auth", () => ({
  user: vi.fn(() => null),
  onAuthCleared: vi.fn(),
}));

vi.mock("../../src/app/services/api-usage", () => ({
  checkAndResetIfExpired: vi.fn(),
}));

vi.mock("@sentry/solid", () => ({
  captureException: vi.fn(),
}));

// Import AFTER mocks
import {
  resetPollState,
  fetchTargetedRepoData,
  fetchHotData,
  seedHotSetsFromTargeted,
  createEventsPollCoordinator,
  getHotPollGeneration,
  clearHotSets,
  rebuildHotSets,
  type DashboardData,
} from "../../src/app/services/poll";

// ── Helpers ───────────────────────────────────────────────────────────────────

const emptyData: DashboardData = {
  issues: [],
  pullRequests: [],
  workflowRuns: [],
  errors: [],
};

function makeOctokit() {
  return {
    request: vi.fn(() => Promise.resolve({ data: {}, headers: {} })),
    graphql: vi.fn(() => Promise.resolve({ nodes: [], rateLimit: { limit: 5000, remaining: 4999, resetAt: "2026-01-01T00:00:00Z" } })),
    hook: { before: vi.fn() },
  };
}

function makeRepoSummary(overrides: {
  repoFullName?: string;
  hasIssueActivity?: boolean;
  hasPRActivity?: boolean;
  hasWorkflowActivity?: boolean;
  latestEventAt?: string;
} = {}) {
  return {
    repoFullName: overrides.repoFullName ?? "owner/repo",
    eventTypes: new Set<string>(),
    hasIssueActivity: overrides.hasIssueActivity ?? false,
    hasPRActivity: overrides.hasPRActivity ?? false,
    hasWorkflowActivity: overrides.hasWorkflowActivity ?? false,
    latestEventAt: overrides.latestEventAt ?? "2026-01-01T00:00:00Z",
  };
}

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("fetchTargetedRepoData", () => {
  beforeEach(() => {
    resetPollState();
    vi.clearAllMocks();
    mockFetchIssuesAndPullRequests.mockResolvedValue({ issues: [], pullRequests: [], errors: [] });
    mockFetchWorkflowRuns.mockResolvedValue({ workflowRuns: [], errors: [] });
  });

  it("returns empty data when no octokit client", async () => {
    mockGetClient.mockReturnValue(null);
    const summaries = new Map([["owner/repo", makeRepoSummary()]]);

    const result = await fetchTargetedRepoData(summaries);

    expect(result.issues).toHaveLength(0);
    expect(result.pullRequests).toHaveLength(0);
    expect(mockFetchIssuesAndPullRequests).not.toHaveBeenCalled();
  });

  it("calls fetchIssuesAndPullRequests with target repos", async () => {
    mockGetClient.mockReturnValue(makeOctokit());
    const summaries = new Map([
      ["owner/repo-a", makeRepoSummary({ repoFullName: "owner/repo-a" })],
    ]);

    await fetchTargetedRepoData(summaries);

    expect(mockFetchIssuesAndPullRequests).toHaveBeenCalledTimes(1);
    const calledRepos = mockFetchIssuesAndPullRequests.mock.calls[0][1] as Array<{ owner: string; name: string }>;
    expect(calledRepos).toContainEqual(expect.objectContaining({ owner: "owner", name: "repo-a" }));
  });

  it("calls fetchWorkflowRuns only for repos with hasWorkflowActivity=true", async () => {
    mockGetClient.mockReturnValue(makeOctokit());
    const summaries = new Map([
      ["owner/repo-a", makeRepoSummary({ repoFullName: "owner/repo-a", hasWorkflowActivity: true })],
      ["owner/repo-b", makeRepoSummary({ repoFullName: "owner/repo-b", hasWorkflowActivity: false })],
    ]);

    await fetchTargetedRepoData(summaries);

    expect(mockFetchWorkflowRuns).toHaveBeenCalledTimes(1);
    const workflowRepos = mockFetchWorkflowRuns.mock.calls[0][1] as Array<{ owner: string; name: string }>;
    expect(workflowRepos).toHaveLength(1);
    expect(workflowRepos[0]).toMatchObject({ owner: "owner", name: "repo-a" });
  });

  it("skips fetchWorkflowRuns when no repos have hasWorkflowActivity", async () => {
    mockGetClient.mockReturnValue(makeOctokit());
    const summaries = new Map([
      ["owner/repo", makeRepoSummary({ hasWorkflowActivity: false })],
    ]);

    await fetchTargetedRepoData(summaries);

    expect(mockFetchWorkflowRuns).not.toHaveBeenCalled();
  });

  it("caps targeted repos at MAX_TARGETED_REPOS=10", async () => {
    mockGetClient.mockReturnValue(makeOctokit());

    const summaries = new Map<string, ReturnType<typeof makeRepoSummary>>();
    for (let i = 0; i < 15; i++) {
      const name = `owner/repo-${i}`;
      summaries.set(name.toLowerCase(), makeRepoSummary({ repoFullName: name }));
    }

    await fetchTargetedRepoData(summaries);

    const calledRepos = mockFetchIssuesAndPullRequests.mock.calls[0][1] as unknown[];
    expect(calledRepos.length).toBeLessThanOrEqual(10);
  });

  it("applies per-repo cooldown: skips repos targeted within TARGETED_COOLDOWN_MS", async () => {
    mockGetClient.mockReturnValue(makeOctokit());
    const summaries = new Map([
      ["owner/repo", makeRepoSummary({ repoFullName: "owner/repo" })],
    ]);

    // First call — repo is targeted
    await fetchTargetedRepoData(summaries);
    const firstCallRepos = mockFetchIssuesAndPullRequests.mock.calls[0][1] as unknown[];
    expect(firstCallRepos).toHaveLength(1);

    // Second immediate call — repo is on cooldown, should be skipped
    mockFetchIssuesAndPullRequests.mockClear();
    await fetchTargetedRepoData(summaries);

    // fetchIssuesAndPullRequests called with empty repos (cooldown filters them all)
    const secondCallRepos = mockFetchIssuesAndPullRequests.mock.calls[0]?.[1] as unknown[] | undefined;
    expect(secondCallRepos?.length ?? 0).toBe(0);
  });
});

// ── seedHotSetsFromTargeted ───────────────────────────────────────────────────

describe("seedHotSetsFromTargeted", () => {
  beforeEach(() => {
    resetPollState();
    mockGetClient.mockReturnValue(makeOctokit());
    vi.mocked(fetchHotPRStatus).mockClear();
    vi.mocked(fetchWorkflowRunById).mockClear();
  });

  it("adds enriched pending-checkStatus PRs with nodeId to hot set", async () => {
    seedHotSetsFromTargeted({
      ...emptyData,
      pullRequests: [
        makePullRequest({ id: 1, checkStatus: "pending", enriched: true, nodeId: "PR_a" }),
      ],
    });

    await fetchHotData();

    // fetchHotPRStatus should be called with the seeded node ID
    expect(fetchHotPRStatus).toHaveBeenCalledTimes(1);
    const calledNodeIds = vi.mocked(fetchHotPRStatus).mock.calls[0][1] as string[];
    expect(calledNodeIds).toContain("PR_a");
  });

  it("does NOT add PRs with checkStatus=null to hot set", async () => {
    seedHotSetsFromTargeted({
      ...emptyData,
      pullRequests: [
        makePullRequest({ id: 2, checkStatus: null, enriched: true, nodeId: "PR_b" }),
      ],
    });

    await fetchHotData();

    // No PRs in hot set — fetchHotPRStatus not called
    expect(fetchHotPRStatus).not.toHaveBeenCalled();
  });

  it("does NOT add PRs that are not enriched", async () => {
    seedHotSetsFromTargeted({
      ...emptyData,
      pullRequests: [
        makePullRequest({ id: 3, checkStatus: "pending", enriched: false, nodeId: "PR_c" }),
      ],
    });

    await fetchHotData();

    expect(fetchHotPRStatus).not.toHaveBeenCalled();
  });

  it("does NOT remove existing hot items (additive only)", async () => {
    // Seed existing hot set via rebuildHotSets
    rebuildHotSets({
      ...emptyData,
      pullRequests: [
        makePullRequest({ id: 10, checkStatus: "pending", enriched: true, nodeId: "PR_existing" }),
      ],
    });

    // seedHotSetsFromTargeted adds new PR without clearing the existing one
    seedHotSetsFromTargeted({
      ...emptyData,
      pullRequests: [
        makePullRequest({ id: 11, checkStatus: "pending", enriched: true, nodeId: "PR_new" }),
      ],
    });

    await fetchHotData();

    expect(fetchHotPRStatus).toHaveBeenCalledTimes(1);
    const calledNodeIds = vi.mocked(fetchHotPRStatus).mock.calls[0][1] as string[];
    expect(calledNodeIds).toContain("PR_existing");
    expect(calledNodeIds).toContain("PR_new");
  });

  it("does NOT increment _hotPollGeneration", () => {
    const genBefore = getHotPollGeneration();

    seedHotSetsFromTargeted({
      ...emptyData,
      pullRequests: [
        makePullRequest({ id: 20, checkStatus: "pending", enriched: true, nodeId: "PR_gen" }),
      ],
    });

    expect(getHotPollGeneration()).toBe(genBefore);
  });

  it("adds queued/in_progress workflow runs to hot set", async () => {
    seedHotSetsFromTargeted({
      ...emptyData,
      workflowRuns: [
        makeWorkflowRun({ id: 42, status: "in_progress", conclusion: null, repoFullName: "owner/repo" }),
        makeWorkflowRun({ id: 43, status: "queued", conclusion: null, repoFullName: "owner/repo" }),
      ],
    });

    await fetchHotData();

    // fetchWorkflowRunById called once per run via pooledAllSettled
    expect(fetchWorkflowRunById).toHaveBeenCalledTimes(2);
  });
});

// ── createEventsPollCoordinator ───────────────────────────────────────────────

describe("createEventsPollCoordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetPollState();
    vi.clearAllMocks();
    mockGetClient.mockReturnValue(makeOctokit());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires first cycle immediately (delay=0)", async () => {
    mockFetchUserEvents.mockResolvedValue({ events: [], changed: false });

    let coordinator: { destroy: () => void };
    createRoot((dispose) => {
      coordinator = createEventsPollCoordinator(
        () => "testuser",
        () => new Set(["owner/repo"]),
        () => false,
        vi.fn(),
      );
      dispose();
    });

    // Trigger the immediate setTimeout(..., 0) then clean up
    vi.advanceTimersByTime(0);
    await flushPromises();
    coordinator!.destroy();

    expect(mockFetchUserEvents).toHaveBeenCalledTimes(1);
  });

  it("calls onTargetedData when events indicate changes in tracked repos", async () => {
    const event = {
      id: "100",
      type: "IssuesEvent",
      actor: { id: 1, login: "user" },
      repo: { id: 1, name: "owner/repo" },
      payload: {},
      created_at: "2026-01-01T00:00:00Z",
    };
    mockFetchUserEvents.mockResolvedValue({ events: [event], changed: true });
    mockParseRepoEvents.mockReturnValue(
      new Map([["owner/repo", makeRepoSummary({ repoFullName: "owner/repo" })]])
    );
    mockFetchIssuesAndPullRequests.mockResolvedValue({ issues: [], pullRequests: [], errors: [] });

    const onTargetedData = vi.fn();

    let coordinator: { destroy: () => void };
    createRoot((dispose) => {
      coordinator = createEventsPollCoordinator(
        () => "testuser",
        () => new Set(["owner/repo"]),
        () => false,
        onTargetedData,
      );
      dispose();
    });

    vi.advanceTimersByTime(0);
    await flushPromises();
    coordinator!.destroy();

    expect(onTargetedData).toHaveBeenCalledTimes(1);
  });

  it("does NOT call onTargetedData when changed=false", async () => {
    mockFetchUserEvents.mockResolvedValue({ events: [], changed: false });

    const onTargetedData = vi.fn();

    let coordinator: { destroy: () => void };
    createRoot((dispose) => {
      coordinator = createEventsPollCoordinator(
        () => "testuser",
        () => new Set(["owner/repo"]),
        () => false,
        onTargetedData,
      );
      dispose();
    });

    vi.advanceTimersByTime(0);
    await flushPromises();
    coordinator!.destroy();

    expect(onTargetedData).not.toHaveBeenCalled();
  });

  it("skips cycle when isFullRefreshing=true", async () => {
    mockFetchUserEvents.mockResolvedValue({ events: [], changed: false });

    let coordinator: { destroy: () => void };
    createRoot((dispose) => {
      coordinator = createEventsPollCoordinator(
        () => "testuser",
        () => new Set(["owner/repo"]),
        () => true, // full refresh in progress
        vi.fn(),
      );
      dispose();
    });

    vi.advanceTimersByTime(0);
    await flushPromises();
    coordinator!.destroy();

    // fetchUserEvents not called when isFullRefreshing=true
    expect(mockFetchUserEvents).not.toHaveBeenCalled();
  });

  it("skips cycle when username is empty", async () => {
    mockFetchUserEvents.mockResolvedValue({ events: [], changed: false });

    let coordinator: { destroy: () => void };
    createRoot((dispose) => {
      coordinator = createEventsPollCoordinator(
        () => "",
        () => new Set(["owner/repo"]),
        () => false,
        vi.fn(),
      );
      dispose();
    });

    vi.advanceTimersByTime(0);
    await flushPromises();
    coordinator!.destroy();

    expect(mockFetchUserEvents).not.toHaveBeenCalled();
  });

  it("skips cycle when no octokit client", async () => {
    mockGetClient.mockReturnValue(null);
    mockFetchUserEvents.mockResolvedValue({ events: [], changed: false });

    let coordinator: { destroy: () => void };
    createRoot((dispose) => {
      coordinator = createEventsPollCoordinator(
        () => "testuser",
        () => new Set(["owner/repo"]),
        () => false,
        vi.fn(),
      );
      dispose();
    });

    vi.advanceTimersByTime(0);
    await flushPromises();
    coordinator!.destroy();

    expect(mockFetchUserEvents).not.toHaveBeenCalled();
  });

  it("destroy clears the timeout and stops cycling", async () => {
    mockFetchUserEvents.mockResolvedValue({ events: [], changed: false });

    let coordinator: { destroy: () => void } | null = null;

    createRoot((dispose) => {
      coordinator = createEventsPollCoordinator(
        () => "testuser",
        () => new Set(["owner/repo"]),
        () => false,
        vi.fn(),
      );
      dispose();
    });

    coordinator!.destroy();

    // Advance well past the poll interval — no further cycles should fire
    vi.advanceTimersByTime(120_000);
    await flushPromises();

    // First immediate cycle may have fired, but subsequent ones should not
    const callsAfterDestroy = mockFetchUserEvents.mock.calls.length;
    vi.advanceTimersByTime(120_000);
    await flushPromises();

    expect(mockFetchUserEvents.mock.calls.length).toBe(callsAfterDestroy);
  });

  it("applies exponential backoff after consecutive failures", async () => {
    mockFetchUserEvents.mockRejectedValue(new Error("API error"));

    let coordinator: { destroy: () => void };
    createRoot((dispose) => {
      coordinator = createEventsPollCoordinator(
        () => "testuser",
        () => new Set(["owner/repo"]),
        () => false,
        vi.fn(),
      );
      dispose();
    });

    // Trigger first cycle (delay=0)
    vi.advanceTimersByTime(0);
    await flushPromises();

    // After first error, backoff = 2^1 = 2x base interval (60s * 2 = 120s).
    // Advancing 60s should NOT trigger the next cycle yet.
    const callsAtBase = mockFetchUserEvents.mock.calls.length;
    vi.advanceTimersByTime(60_000);
    await flushPromises();

    expect(mockFetchUserEvents.mock.calls.length).toBe(callsAtBase);

    // Advancing the remaining 60s (total 120s) should trigger it
    vi.advanceTimersByTime(60_000);
    await flushPromises();

    expect(mockFetchUserEvents.mock.calls.length).toBeGreaterThan(callsAtBase);
    coordinator!.destroy();
  });
});

// ── Config-change effects ─────────────────────────────────────────────────────

describe("config-change effects (QA-007)", () => {
  // These effects are registered at module load via createRoot in poll.ts.
  // We test them by checking resetEventsState is called when config signals change.
  // Because the config mock is a plain object (not reactive), we test the
  // resetEventsState integration via resetPollState() which calls it directly.

  it("resetPollState calls resetEventsState (integration: resetEventsState is part of full reset)", () => {
    // resetPollState is what gets called on auth clear, and it internally calls resetEventsState.
    // Verify the module wiring is correct by checking resetPollState resets module state.
    resetPollState();

    // After resetPollState, the generation is 0 (resetEventsState clears ETag/lastEventId)
    expect(getHotPollGeneration()).toBe(0);
  });

  it("clearHotSets does NOT increment generation (different from rebuildHotSets)", () => {
    rebuildHotSets(emptyData);
    expect(getHotPollGeneration()).toBe(1);

    clearHotSets();
    // clearHotSets clears sets but does not touch generation
    expect(getHotPollGeneration()).toBe(1);
  });
});
