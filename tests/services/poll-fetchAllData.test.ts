import "fake-indexeddb/auto";
import { describe, it, expect, vi, afterEach } from "vitest";

// ── Module mocks ──────────────────────────────────────────────────────────────

// Mock github client — factory must not reference hoisted consts
vi.mock("../../src/app/services/github", () => ({
  getClient: vi.fn(),
}));

// Mock config store
vi.mock("../../src/app/stores/config", () => ({
  config: {
    selectedRepos: [{ owner: "octocat", name: "Hello-World", fullName: "octocat/Hello-World" }],
    maxWorkflowsPerRepo: 5,
    maxRunsPerWorkflow: 3,
  },
}));

// Mock auth store — onAuthCleared is called at poll.ts module scope
vi.mock("../../src/app/stores/auth", () => ({
  user: vi.fn(() => ({ login: "octocat", avatar_url: "https://github.com/images/error/octocat_happy.gif", name: "Octocat" })),
  onAuthCleared: vi.fn(),
}));

// Mock the three fetch functions
vi.mock("../../src/app/services/api", () => ({
  fetchIssues: vi.fn(),
  fetchPullRequests: vi.fn(),
  fetchWorkflowRuns: vi.fn(),
  aggregateErrors: vi.fn(),
}));

// Mock notifications
vi.mock("../../src/app/lib/notifications", () => ({
  detectNewItems: vi.fn(() => []),
  dispatchNotifications: vi.fn(),
}));

// Mock errors store
vi.mock("../../src/app/lib/errors", () => ({
  pushError: vi.fn(),
  clearErrors: vi.fn(),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const emptyIssueResult = { issues: [], errors: [] };
const emptyPrResult = { pullRequests: [], errors: [] };
const emptyRunResult = { workflowRuns: [], errors: [] };

function makeMockOctokit() {
  return {
    request: vi.fn(),
    graphql: vi.fn(),
    paginate: { iterator: vi.fn() },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

// ── qa-1: First call returns data and updates _lastSuccessfulFetch ────────────

describe("fetchAllData — first call", () => {

  it("returns data from all three fetches on first call", async () => {
    vi.resetModules();

    // Re-import mocked modules after reset
    const { getClient } = await import("../../src/app/services/github");
    const { fetchIssues, fetchPullRequests, fetchWorkflowRuns, aggregateErrors } = await import("../../src/app/services/api");
    const mockOctokit = makeMockOctokit();
    vi.mocked(getClient).mockReturnValue(mockOctokit as unknown as ReturnType<typeof getClient>);
    vi.mocked(fetchIssues).mockResolvedValue(emptyIssueResult);
    vi.mocked(fetchPullRequests).mockResolvedValue(emptyPrResult);
    vi.mocked(fetchWorkflowRuns).mockResolvedValue(emptyRunResult);
    vi.mocked(aggregateErrors).mockReturnValue([]);

    const { fetchAllData } = await import("../../src/app/services/poll");

    const result = await fetchAllData();

    expect(result.issues).toEqual([]);
    expect(result.pullRequests).toEqual([]);
    expect(result.workflowRuns).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.skipped).toBeUndefined();
  });

  it("calls all three fetch functions on first call (no notification gate)", async () => {
    vi.resetModules();

    const { getClient } = await import("../../src/app/services/github");
    const { fetchIssues, fetchPullRequests, fetchWorkflowRuns, aggregateErrors } = await import("../../src/app/services/api");
    const mockOctokit = makeMockOctokit();
    vi.mocked(getClient).mockReturnValue(mockOctokit as unknown as ReturnType<typeof getClient>);
    vi.mocked(fetchIssues).mockResolvedValue(emptyIssueResult);
    vi.mocked(fetchPullRequests).mockResolvedValue(emptyPrResult);
    vi.mocked(fetchWorkflowRuns).mockResolvedValue(emptyRunResult);
    vi.mocked(aggregateErrors).mockReturnValue([]);

    const { fetchAllData } = await import("../../src/app/services/poll");

    await fetchAllData();

    // First call: no _lastSuccessfulFetch, so notifications gate is skipped
    expect(mockOctokit.request).not.toHaveBeenCalled();
    // All three data fetches should run
    expect(fetchIssues).toHaveBeenCalledOnce();
    expect(fetchPullRequests).toHaveBeenCalledOnce();
    expect(fetchWorkflowRuns).toHaveBeenCalledOnce();
  });

  it("uses correct arguments: repo list, userLogin from user(), and config maxWorkflows/maxRuns", async () => {
    vi.resetModules();

    const { getClient } = await import("../../src/app/services/github");
    const { fetchIssues, fetchPullRequests, fetchWorkflowRuns, aggregateErrors } = await import("../../src/app/services/api");
    const { config } = await import("../../src/app/stores/config");
    const mockOctokit = makeMockOctokit();
    vi.mocked(getClient).mockReturnValue(mockOctokit as unknown as ReturnType<typeof getClient>);
    vi.mocked(fetchIssues).mockResolvedValue(emptyIssueResult);
    vi.mocked(fetchPullRequests).mockResolvedValue(emptyPrResult);
    vi.mocked(fetchWorkflowRuns).mockResolvedValue(emptyRunResult);
    vi.mocked(aggregateErrors).mockReturnValue([]);

    const { fetchAllData } = await import("../../src/app/services/poll");

    await fetchAllData();

    expect(fetchIssues).toHaveBeenCalledWith(mockOctokit, config.selectedRepos, "octocat");
    expect(fetchPullRequests).toHaveBeenCalledWith(mockOctokit, config.selectedRepos, "octocat");
    expect(fetchWorkflowRuns).toHaveBeenCalledWith(
      mockOctokit,
      config.selectedRepos,
      config.maxWorkflowsPerRepo,
      config.maxRunsPerWorkflow
    );
  });

  it("sets _lastSuccessfulFetch so second call checks notification gate", async () => {
    vi.resetModules();

    const { getClient } = await import("../../src/app/services/github");
    const { fetchIssues, fetchPullRequests, fetchWorkflowRuns, aggregateErrors } = await import("../../src/app/services/api");
    const mockOctokit = makeMockOctokit();
    vi.mocked(getClient).mockReturnValue(mockOctokit as unknown as ReturnType<typeof getClient>);
    vi.mocked(fetchIssues).mockResolvedValue(emptyIssueResult);
    vi.mocked(fetchPullRequests).mockResolvedValue(emptyPrResult);
    vi.mocked(fetchWorkflowRuns).mockResolvedValue(emptyRunResult);
    vi.mocked(aggregateErrors).mockReturnValue([]);

    const { fetchAllData } = await import("../../src/app/services/poll");

    // First call — no gate check
    await fetchAllData();
    expect(mockOctokit.request).not.toHaveBeenCalled();

    // Second call — _lastSuccessfulFetch is set, gate checks notifications
    // Return 200 for notifications (something changed)
    mockOctokit.request.mockResolvedValueOnce({
      data: [],
      headers: { "last-modified": "Thu, 20 Mar 2026 12:00:00 GMT" },
    });

    await fetchAllData();

    expect(mockOctokit.request).toHaveBeenCalledOnce();
    expect(mockOctokit.request).toHaveBeenCalledWith(
      "GET /notifications",
      expect.objectContaining({ per_page: 1 })
    );
  });
});

// ── qa-1: Notification gate skips full fetch when nothing changed ─────────────

describe("fetchAllData — notification gate skip", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns { skipped: true } when hasNotificationChanges returns false (304)", async () => {
    vi.resetModules();

    const { getClient } = await import("../../src/app/services/github");
    const { fetchIssues, fetchPullRequests, fetchWorkflowRuns, aggregateErrors } = await import("../../src/app/services/api");
    const mockOctokit = makeMockOctokit();
    vi.mocked(getClient).mockReturnValue(mockOctokit as unknown as ReturnType<typeof getClient>);
    vi.mocked(fetchIssues).mockResolvedValue(emptyIssueResult);
    vi.mocked(fetchPullRequests).mockResolvedValue(emptyPrResult);
    vi.mocked(fetchWorkflowRuns).mockResolvedValue(emptyRunResult);
    vi.mocked(aggregateErrors).mockReturnValue([]);

    const { fetchAllData } = await import("../../src/app/services/poll");

    // First call to set _lastSuccessfulFetch
    await fetchAllData();

    vi.mocked(fetchIssues).mockClear();
    vi.mocked(fetchPullRequests).mockClear();
    vi.mocked(fetchWorkflowRuns).mockClear();

    // Simulate 304 from notifications — nothing changed
    mockOctokit.request.mockRejectedValueOnce({ status: 304 });

    const result = await fetchAllData();

    expect(result.skipped).toBe(true);
    // Data fetches should NOT have been called
    expect(fetchIssues).not.toHaveBeenCalled();
    expect(fetchPullRequests).not.toHaveBeenCalled();
    expect(fetchWorkflowRuns).not.toHaveBeenCalled();
  });

  it("forces full fetch when staleness exceeds 10 minutes even if gate would skip", async () => {
    vi.useFakeTimers();
    vi.resetModules();

    const { getClient } = await import("../../src/app/services/github");
    const { fetchIssues, fetchPullRequests, fetchWorkflowRuns, aggregateErrors } = await import("../../src/app/services/api");
    const mockOctokit = makeMockOctokit();
    vi.mocked(getClient).mockReturnValue(mockOctokit as unknown as ReturnType<typeof getClient>);
    vi.mocked(fetchIssues).mockResolvedValue(emptyIssueResult);
    vi.mocked(fetchPullRequests).mockResolvedValue(emptyPrResult);
    vi.mocked(fetchWorkflowRuns).mockResolvedValue(emptyRunResult);
    vi.mocked(aggregateErrors).mockReturnValue([]);

    const { fetchAllData } = await import("../../src/app/services/poll");

    // First call — sets _lastSuccessfulFetch
    await fetchAllData();
    vi.mocked(fetchIssues).mockClear();

    // Advance time past 10 minutes
    vi.advanceTimersByTime(11 * 60 * 1000);

    // Even though notifications would 304, staleness cap forces a full fetch
    mockOctokit.request.mockRejectedValueOnce({ status: 304 });

    const result = await fetchAllData();

    // Should NOT be skipped — staleness cap bypasses the gate
    expect(result.skipped).toBeUndefined();
    expect(fetchIssues).toHaveBeenCalled();
  });
});

// ── qa-1: All three fetches fail — errors aggregated, _lastSuccessfulFetch not updated ──

describe("fetchAllData — all fetches fail", () => {
  it("aggregates top-level errors when all three fetches reject", async () => {
    vi.resetModules();

    const { getClient } = await import("../../src/app/services/github");
    const { fetchIssues, fetchPullRequests, fetchWorkflowRuns, aggregateErrors } = await import("../../src/app/services/api");
    const mockOctokit = makeMockOctokit();
    vi.mocked(getClient).mockReturnValue(mockOctokit as unknown as ReturnType<typeof getClient>);

    vi.mocked(fetchIssues).mockRejectedValue(Object.assign(new Error("Issues failed"), { status: 500 }));
    vi.mocked(fetchPullRequests).mockRejectedValue(Object.assign(new Error("PRs failed"), { status: 500 }));
    vi.mocked(fetchWorkflowRuns).mockRejectedValue(Object.assign(new Error("Runs failed"), { status: 500 }));

    const topLevelErrors = [
      { repo: "issues", statusCode: 500, message: "Issues failed", retryable: true },
      { repo: "pull-requests", statusCode: 500, message: "PRs failed", retryable: true },
      { repo: "workflow-runs", statusCode: 500, message: "Runs failed", retryable: true },
    ];
    vi.mocked(aggregateErrors).mockReturnValue(topLevelErrors);

    const { fetchAllData } = await import("../../src/app/services/poll");

    const result = await fetchAllData();

    expect(result.errors).toEqual(topLevelErrors);
    expect(result.issues).toEqual([]);
    expect(result.pullRequests).toEqual([]);
    expect(result.workflowRuns).toEqual([]);
    expect(result.skipped).toBeUndefined();
  });

  it("does NOT update _lastSuccessfulFetch when all three fetches reject", async () => {
    vi.resetModules();

    const { getClient } = await import("../../src/app/services/github");
    const { fetchIssues, fetchPullRequests, fetchWorkflowRuns, aggregateErrors } = await import("../../src/app/services/api");
    const mockOctokit = makeMockOctokit();
    vi.mocked(getClient).mockReturnValue(mockOctokit as unknown as ReturnType<typeof getClient>);

    vi.mocked(fetchIssues).mockRejectedValue(new Error("fail"));
    vi.mocked(fetchPullRequests).mockRejectedValue(new Error("fail"));
    vi.mocked(fetchWorkflowRuns).mockRejectedValue(new Error("fail"));
    vi.mocked(aggregateErrors).mockReturnValue([
      { repo: "issues", statusCode: null, message: "fail", retryable: true },
      { repo: "pull-requests", statusCode: null, message: "fail", retryable: true },
      { repo: "workflow-runs", statusCode: null, message: "fail", retryable: true },
    ]);

    const { fetchAllData } = await import("../../src/app/services/poll");

    // First call — all fail, so _lastSuccessfulFetch should NOT be set
    await fetchAllData();

    // Second call — if _lastSuccessfulFetch were set, a notification request would be made
    // Since all failed, it should NOT be set → no notification request
    mockOctokit.request.mockClear();
    vi.mocked(fetchIssues).mockRejectedValue(new Error("fail"));
    vi.mocked(fetchPullRequests).mockRejectedValue(new Error("fail"));
    vi.mocked(fetchWorkflowRuns).mockRejectedValue(new Error("fail"));
    vi.mocked(aggregateErrors).mockReturnValue([]);

    await fetchAllData();

    // No notification gate check — _lastSuccessfulFetch was never set
    expect(mockOctokit.request).not.toHaveBeenCalled();
  });
});

// ── qa-1: Partial success returns data from successful fetches ────────────────

describe("fetchAllData — partial success", () => {
  it("returns data from successful fetches and errors from failed ones", async () => {
    vi.resetModules();

    const { getClient } = await import("../../src/app/services/github");
    const { fetchIssues, fetchPullRequests, fetchWorkflowRuns, aggregateErrors } = await import("../../src/app/services/api");
    const mockOctokit = makeMockOctokit();
    vi.mocked(getClient).mockReturnValue(mockOctokit as unknown as ReturnType<typeof getClient>);

    const issues = [{
      id: 1, number: 1, title: "Issue 1", state: "open",
      htmlUrl: "https://github.com/o/r/issues/1",
      createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z",
      userLogin: "octocat", userAvatarUrl: "", labels: [], assigneeLogins: [],
      repoFullName: "o/r", comments: 0,
    }];
    vi.mocked(fetchIssues).mockResolvedValue({ issues, errors: [] });
    vi.mocked(fetchPullRequests).mockRejectedValue(Object.assign(new Error("PR fetch failed"), { status: 503 }));
    vi.mocked(fetchWorkflowRuns).mockResolvedValue({ workflowRuns: [], errors: [] });
    vi.mocked(aggregateErrors).mockReturnValue([
      { repo: "pull-requests", statusCode: 503, message: "PR fetch failed", retryable: true },
    ]);

    const { fetchAllData } = await import("../../src/app/services/poll");

    const result = await fetchAllData();

    expect(result.issues).toEqual(issues);
    expect(result.pullRequests).toEqual([]);
    expect(result.workflowRuns).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].repo).toBe("pull-requests");
  });
});

// ── qa-1: Returns empty data when no client available ────────────────────────

describe("fetchAllData — no client", () => {
  it("returns empty data when getClient returns null", async () => {
    vi.resetModules();

    const { getClient } = await import("../../src/app/services/github");
    const { fetchIssues } = await import("../../src/app/services/api");
    vi.mocked(getClient).mockReturnValue(null);

    const { fetchAllData } = await import("../../src/app/services/poll");

    const result = await fetchAllData();

    expect(result.issues).toEqual([]);
    expect(result.pullRequests).toEqual([]);
    expect(result.workflowRuns).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(fetchIssues).not.toHaveBeenCalled();
  });
});

// ── qa-2: hasNotificationChanges 403 auto-disable ────────────────────────────

describe("fetchAllData — notification gate 403 auto-disable", () => {
  it("disables notification gate after 403 and skips it on subsequent calls", async () => {
    vi.resetModules();

    const { getClient } = await import("../../src/app/services/github");
    const { fetchIssues, fetchPullRequests, fetchWorkflowRuns, aggregateErrors } = await import("../../src/app/services/api");
    const { pushError } = await import("../../src/app/lib/errors");
    const mockOctokit = makeMockOctokit();
    vi.mocked(getClient).mockReturnValue(mockOctokit as unknown as ReturnType<typeof getClient>);
    vi.mocked(fetchIssues).mockResolvedValue(emptyIssueResult);
    vi.mocked(fetchPullRequests).mockResolvedValue(emptyPrResult);
    vi.mocked(fetchWorkflowRuns).mockResolvedValue(emptyRunResult);
    vi.mocked(aggregateErrors).mockReturnValue([]);

    const { fetchAllData } = await import("../../src/app/services/poll");

    // First call — sets _lastSuccessfulFetch
    await fetchAllData();
    vi.mocked(fetchIssues).mockClear();

    // Second call — gate checks notifications, gets 403
    mockOctokit.request.mockRejectedValueOnce({ status: 403 });
    await fetchAllData();

    // Gate received 403 → _notifGateDisabled = true → pushError called
    expect(pushError).toHaveBeenCalledWith(
      "notifications",
      expect.stringContaining("403"),
      false
    );

    // Third call — gate should be DISABLED, no notifications request
    mockOctokit.request.mockClear();
    vi.mocked(fetchIssues).mockClear();
    vi.mocked(fetchPullRequests).mockClear();
    vi.mocked(fetchWorkflowRuns).mockClear();
    vi.mocked(fetchIssues).mockResolvedValue(emptyIssueResult);
    vi.mocked(fetchPullRequests).mockResolvedValue(emptyPrResult);
    vi.mocked(fetchWorkflowRuns).mockResolvedValue(emptyRunResult);

    await fetchAllData();

    expect(mockOctokit.request).not.toHaveBeenCalled();
    // The three data fetches still run
    expect(fetchIssues).toHaveBeenCalled();
    expect(fetchPullRequests).toHaveBeenCalled();
    expect(fetchWorkflowRuns).toHaveBeenCalled();
  });

  it("still fetches data on the same call that triggers the 403", async () => {
    vi.resetModules();

    const { getClient } = await import("../../src/app/services/github");
    const { fetchIssues, fetchPullRequests, fetchWorkflowRuns, aggregateErrors } = await import("../../src/app/services/api");
    const mockOctokit = makeMockOctokit();
    vi.mocked(getClient).mockReturnValue(mockOctokit as unknown as ReturnType<typeof getClient>);
    vi.mocked(fetchIssues).mockResolvedValue(emptyIssueResult);
    vi.mocked(fetchPullRequests).mockResolvedValue(emptyPrResult);
    vi.mocked(fetchWorkflowRuns).mockResolvedValue(emptyRunResult);
    vi.mocked(aggregateErrors).mockReturnValue([]);

    const { fetchAllData } = await import("../../src/app/services/poll");

    // First call — sets _lastSuccessfulFetch
    await fetchAllData();
    vi.mocked(fetchIssues).mockClear();
    vi.mocked(fetchPullRequests).mockClear();
    vi.mocked(fetchWorkflowRuns).mockClear();

    // Second call — gate returns 403; hasNotificationChanges returns true → full fetch runs
    mockOctokit.request.mockRejectedValueOnce({ status: 403 });

    const result = await fetchAllData();

    expect(result.skipped).toBeUndefined();
    expect(fetchIssues).toHaveBeenCalled();
    expect(fetchPullRequests).toHaveBeenCalled();
    expect(fetchWorkflowRuns).toHaveBeenCalled();
  });
});
