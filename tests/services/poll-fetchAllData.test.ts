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

// Mock the fetch functions (combined issues+PRs and workflow runs)
vi.mock("../../src/app/services/api", () => ({
  fetchIssuesAndPullRequests: vi.fn(),
  fetchWorkflowRuns: vi.fn(),
  resetEmptyActionRepos: vi.fn(),
}));

// Mock notifications
vi.mock("../../src/app/lib/notifications", () => ({
  detectNewItems: vi.fn(() => []),
  dispatchNotifications: vi.fn(),
  _resetNotificationState: vi.fn(),
}));

// Mock errors store
vi.mock("../../src/app/lib/errors", () => ({
  pushError: vi.fn(),
  pushNotification: vi.fn(),
  clearErrors: vi.fn(),
  clearNotifications: vi.fn(),
  getErrors: vi.fn(() => []),
  getNotifications: vi.fn(() => []),
  dismissNotificationBySource: vi.fn(),
  startCycleTracking: vi.fn(),
  endCycleTracking: vi.fn(() => new Set()),
  resetNotificationState: vi.fn(),
  addMutedSource: vi.fn(),
  isMuted: vi.fn(() => false),
  clearMutedSources: vi.fn(),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const emptyIssuesAndPrsResult = { issues: [], pullRequests: [], errors: [] };
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

  it("returns data from all fetches on first call", async () => {
    vi.resetModules();

    const { getClient } = await import("../../src/app/services/github");
    const { fetchIssuesAndPullRequests, fetchWorkflowRuns } = await import("../../src/app/services/api");
    const mockOctokit = makeMockOctokit();
    vi.mocked(getClient).mockReturnValue(mockOctokit as unknown as ReturnType<typeof getClient>);
    vi.mocked(fetchIssuesAndPullRequests).mockResolvedValue(emptyIssuesAndPrsResult);
    vi.mocked(fetchWorkflowRuns).mockResolvedValue(emptyRunResult);


    const { fetchAllData } = await import("../../src/app/services/poll");

    const result = await fetchAllData();

    expect(result.issues).toEqual([]);
    expect(result.pullRequests).toEqual([]);
    expect(result.workflowRuns).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.skipped).toBeUndefined();
  });

  it("calls both fetch functions on first call (no notification gate)", async () => {
    vi.resetModules();

    const { getClient } = await import("../../src/app/services/github");
    const { fetchIssuesAndPullRequests, fetchWorkflowRuns } = await import("../../src/app/services/api");
    const mockOctokit = makeMockOctokit();
    vi.mocked(getClient).mockReturnValue(mockOctokit as unknown as ReturnType<typeof getClient>);
    vi.mocked(fetchIssuesAndPullRequests).mockResolvedValue(emptyIssuesAndPrsResult);
    vi.mocked(fetchWorkflowRuns).mockResolvedValue(emptyRunResult);


    const { fetchAllData } = await import("../../src/app/services/poll");

    await fetchAllData();

    // First call: no _lastSuccessfulFetch, so notifications gate is skipped
    expect(mockOctokit.request).not.toHaveBeenCalled();
    // Both data fetches should run
    expect(fetchIssuesAndPullRequests).toHaveBeenCalledOnce();
    expect(fetchWorkflowRuns).toHaveBeenCalledOnce();
  });

  it("uses correct arguments: repo list, userLogin from user(), and config maxWorkflows/maxRuns", async () => {
    vi.resetModules();

    const { getClient } = await import("../../src/app/services/github");
    const { fetchIssuesAndPullRequests, fetchWorkflowRuns } = await import("../../src/app/services/api");
    const { config } = await import("../../src/app/stores/config");
    const mockOctokit = makeMockOctokit();
    vi.mocked(getClient).mockReturnValue(mockOctokit as unknown as ReturnType<typeof getClient>);
    vi.mocked(fetchIssuesAndPullRequests).mockResolvedValue(emptyIssuesAndPrsResult);
    vi.mocked(fetchWorkflowRuns).mockResolvedValue(emptyRunResult);


    const { fetchAllData } = await import("../../src/app/services/poll");

    await fetchAllData();

    expect(fetchIssuesAndPullRequests).toHaveBeenCalledWith(mockOctokit, config.selectedRepos, "octocat");
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
    const { fetchIssuesAndPullRequests, fetchWorkflowRuns } = await import("../../src/app/services/api");
    const mockOctokit = makeMockOctokit();
    vi.mocked(getClient).mockReturnValue(mockOctokit as unknown as ReturnType<typeof getClient>);
    vi.mocked(fetchIssuesAndPullRequests).mockResolvedValue(emptyIssuesAndPrsResult);
    vi.mocked(fetchWorkflowRuns).mockResolvedValue(emptyRunResult);


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
    const { fetchIssuesAndPullRequests, fetchWorkflowRuns } = await import("../../src/app/services/api");
    const mockOctokit = makeMockOctokit();
    vi.mocked(getClient).mockReturnValue(mockOctokit as unknown as ReturnType<typeof getClient>);
    vi.mocked(fetchIssuesAndPullRequests).mockResolvedValue(emptyIssuesAndPrsResult);
    vi.mocked(fetchWorkflowRuns).mockResolvedValue(emptyRunResult);


    const { fetchAllData } = await import("../../src/app/services/poll");

    // First call to set _lastSuccessfulFetch
    await fetchAllData();

    vi.mocked(fetchIssuesAndPullRequests).mockClear();
    vi.mocked(fetchWorkflowRuns).mockClear();

    // Simulate 304 from notifications — nothing changed
    mockOctokit.request.mockRejectedValueOnce({ status: 304 });

    const result = await fetchAllData();

    expect(result.skipped).toBe(true);
    // Data fetches should NOT have been called
    expect(fetchIssuesAndPullRequests).not.toHaveBeenCalled();
    expect(fetchWorkflowRuns).not.toHaveBeenCalled();
  });

  it("forces full fetch when staleness exceeds 10 minutes even if gate would skip", async () => {
    vi.useFakeTimers();
    vi.resetModules();

    const { getClient } = await import("../../src/app/services/github");
    const { fetchIssuesAndPullRequests, fetchWorkflowRuns } = await import("../../src/app/services/api");
    const mockOctokit = makeMockOctokit();
    vi.mocked(getClient).mockReturnValue(mockOctokit as unknown as ReturnType<typeof getClient>);
    vi.mocked(fetchIssuesAndPullRequests).mockResolvedValue(emptyIssuesAndPrsResult);
    vi.mocked(fetchWorkflowRuns).mockResolvedValue(emptyRunResult);


    const { fetchAllData } = await import("../../src/app/services/poll");

    // First call — sets _lastSuccessfulFetch
    await fetchAllData();
    vi.mocked(fetchIssuesAndPullRequests).mockClear();

    // Advance time past 10 minutes
    vi.advanceTimersByTime(11 * 60 * 1000);

    // Even though notifications would 304, staleness cap forces a full fetch
    mockOctokit.request.mockRejectedValueOnce({ status: 304 });

    const result = await fetchAllData();

    // Should NOT be skipped — staleness cap bypasses the gate
    expect(result.skipped).toBeUndefined();
    expect(fetchIssuesAndPullRequests).toHaveBeenCalled();
  });
});

// ── qa-1: All fetches fail — errors aggregated, _lastSuccessfulFetch not updated ──

describe("fetchAllData — all fetches fail", () => {
  it("aggregates top-level errors when all fetches reject", async () => {
    vi.resetModules();

    const { getClient } = await import("../../src/app/services/github");
    const { fetchIssuesAndPullRequests, fetchWorkflowRuns } = await import("../../src/app/services/api");
    const mockOctokit = makeMockOctokit();
    vi.mocked(getClient).mockReturnValue(mockOctokit as unknown as ReturnType<typeof getClient>);

    vi.mocked(fetchIssuesAndPullRequests).mockRejectedValue(Object.assign(new Error("Issues+PRs failed"), { status: 500 }));
    vi.mocked(fetchWorkflowRuns).mockRejectedValue(Object.assign(new Error("Runs failed"), { status: 500 }));

    const topLevelErrors = [
      { repo: "issues-and-prs", statusCode: 500, message: "Issues+PRs failed", retryable: true },
      { repo: "workflow-runs", statusCode: 500, message: "Runs failed", retryable: true },
    ];
    const { fetchAllData } = await import("../../src/app/services/poll");

    const result = await fetchAllData();

    expect(result.errors).toEqual(topLevelErrors);
    expect(result.issues).toEqual([]);
    expect(result.pullRequests).toEqual([]);
    expect(result.workflowRuns).toEqual([]);
    expect(result.skipped).toBeUndefined();
  });

  it("does NOT update _lastSuccessfulFetch when all fetches reject", async () => {
    vi.resetModules();

    const { getClient } = await import("../../src/app/services/github");
    const { fetchIssuesAndPullRequests, fetchWorkflowRuns } = await import("../../src/app/services/api");
    const mockOctokit = makeMockOctokit();
    vi.mocked(getClient).mockReturnValue(mockOctokit as unknown as ReturnType<typeof getClient>);

    vi.mocked(fetchIssuesAndPullRequests).mockRejectedValue(new Error("fail"));
    vi.mocked(fetchWorkflowRuns).mockRejectedValue(new Error("fail"));

    const { fetchAllData } = await import("../../src/app/services/poll");

    // First call — all fail, so _lastSuccessfulFetch should NOT be set
    await fetchAllData();

    // Second call — if _lastSuccessfulFetch were set, a notification request would be made
    // Since all failed, it should NOT be set → no notification request
    mockOctokit.request.mockClear();
    vi.mocked(fetchIssuesAndPullRequests).mockRejectedValue(new Error("fail"));
    vi.mocked(fetchWorkflowRuns).mockRejectedValue(new Error("fail"));


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
    const { fetchIssuesAndPullRequests, fetchWorkflowRuns } = await import("../../src/app/services/api");
    const mockOctokit = makeMockOctokit();
    vi.mocked(getClient).mockReturnValue(mockOctokit as unknown as ReturnType<typeof getClient>);

    const issues = [{
      id: 1, number: 1, title: "Issue 1", state: "open",
      htmlUrl: "https://github.com/o/r/issues/1",
      createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-01T00:00:00Z",
      userLogin: "octocat", userAvatarUrl: "", labels: [], assigneeLogins: [],
      repoFullName: "o/r", comments: 0,
    }];
    vi.mocked(fetchIssuesAndPullRequests).mockResolvedValue({ issues, pullRequests: [], errors: [] });
    vi.mocked(fetchWorkflowRuns).mockRejectedValue(Object.assign(new Error("Runs failed"), { status: 503 }));
    const { fetchAllData } = await import("../../src/app/services/poll");

    const result = await fetchAllData();

    expect(result.issues).toEqual(issues);
    expect(result.pullRequests).toEqual([]);
    expect(result.workflowRuns).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].repo).toBe("workflow-runs");
  });
});

// ── qa-1: Returns empty data when no client available ────────────────────────

describe("fetchAllData — no client", () => {
  it("returns empty data when getClient returns null", async () => {
    vi.resetModules();

    const { getClient } = await import("../../src/app/services/github");
    const { fetchIssuesAndPullRequests } = await import("../../src/app/services/api");
    vi.mocked(getClient).mockReturnValue(null);

    const { fetchAllData } = await import("../../src/app/services/poll");

    const result = await fetchAllData();

    expect(result.issues).toEqual([]);
    expect(result.pullRequests).toEqual([]);
    expect(result.workflowRuns).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(fetchIssuesAndPullRequests).not.toHaveBeenCalled();
  });
});

// ── qa-4: resetPollState after logout re-enables notification gate ────────────

describe("fetchAllData — resetPollState via onAuthCleared", () => {
  it("re-enables notification gate after logout (onAuthCleared callback invocation)", async () => {
    vi.resetModules();

    const { getClient } = await import("../../src/app/services/github");
    const { fetchIssuesAndPullRequests, fetchWorkflowRuns } = await import("../../src/app/services/api");
    const { onAuthCleared } = await import("../../src/app/stores/auth");
    const mockOctokit = makeMockOctokit();
    vi.mocked(getClient).mockReturnValue(mockOctokit as unknown as ReturnType<typeof getClient>);
    vi.mocked(fetchIssuesAndPullRequests).mockResolvedValue(emptyIssuesAndPrsResult);
    vi.mocked(fetchWorkflowRuns).mockResolvedValue(emptyRunResult);


    // Import poll.ts — this triggers onAuthCleared(resetPollState) at module scope
    const { fetchAllData } = await import("../../src/app/services/poll");

    // onAuthCleared mock must have been called with the resetPollState callback
    expect(vi.mocked(onAuthCleared)).toHaveBeenCalledOnce();
    const capturedAuthClearedCb = vi.mocked(onAuthCleared).mock.calls[0][0] as () => void;
    expect(typeof capturedAuthClearedCb).toBe("function");

    // First call — sets _lastSuccessfulFetch
    await fetchAllData();

    // Second call — gate fires a 403, which sets _notifGateDisabled = true
    mockOctokit.request.mockRejectedValueOnce({ status: 403 });
    await fetchAllData();

    // Gate is now disabled; third call should NOT call GET /notifications
    mockOctokit.request.mockClear();
    vi.mocked(fetchIssuesAndPullRequests).mockResolvedValue(emptyIssuesAndPrsResult);
    vi.mocked(fetchWorkflowRuns).mockResolvedValue(emptyRunResult);
    await fetchAllData();
    expect(mockOctokit.request).not.toHaveBeenCalled();

    // Invoke the logout callback — resets _notifGateDisabled and _lastSuccessfulFetch
    capturedAuthClearedCb();

    // First call after logout: _lastSuccessfulFetch is null → no gate check
    mockOctokit.request.mockClear();
    vi.mocked(fetchIssuesAndPullRequests).mockResolvedValue(emptyIssuesAndPrsResult);
    vi.mocked(fetchWorkflowRuns).mockResolvedValue(emptyRunResult);
    await fetchAllData();
    // No notification gate on first call after reset (no _lastSuccessfulFetch)
    expect(mockOctokit.request).not.toHaveBeenCalled();

    // Second call after logout: _lastSuccessfulFetch is now set, gate fires again
    mockOctokit.request.mockResolvedValueOnce({
      data: [],
      headers: { "last-modified": "Thu, 20 Mar 2026 12:00:00 GMT" },
    });
    vi.mocked(fetchIssuesAndPullRequests).mockResolvedValue(emptyIssuesAndPrsResult);
    vi.mocked(fetchWorkflowRuns).mockResolvedValue(emptyRunResult);
    await fetchAllData();
    // GET /notifications was called — gate is active again (not disabled)
    expect(mockOctokit.request).toHaveBeenCalledWith(
      "GET /notifications",
      expect.objectContaining({ per_page: 1 })
    );
  });
});

// ── qa-5: If-Modified-Since header on second notification call ────────────────

describe("fetchAllData — If-Modified-Since header", () => {
  it("sends If-Modified-Since header from first response on second GET /notifications call", async () => {
    vi.resetModules();

    const { getClient } = await import("../../src/app/services/github");
    const { fetchIssuesAndPullRequests, fetchWorkflowRuns } = await import("../../src/app/services/api");
    const mockOctokit = makeMockOctokit();
    vi.mocked(getClient).mockReturnValue(mockOctokit as unknown as ReturnType<typeof getClient>);
    vi.mocked(fetchIssuesAndPullRequests).mockResolvedValue(emptyIssuesAndPrsResult);
    vi.mocked(fetchWorkflowRuns).mockResolvedValue(emptyRunResult);


    const { fetchAllData } = await import("../../src/app/services/poll");

    // First call — no gate (no _lastSuccessfulFetch), sets _lastSuccessfulFetch
    await fetchAllData();

    // Second call — gate fires 200 response with last-modified header
    const lastModified = "Fri, 21 Mar 2026 08:00:00 GMT";
    mockOctokit.request.mockResolvedValueOnce({
      data: [],
      headers: { "last-modified": lastModified },
    });
    vi.mocked(fetchIssuesAndPullRequests).mockResolvedValue(emptyIssuesAndPrsResult);
    vi.mocked(fetchWorkflowRuns).mockResolvedValue(emptyRunResult);
    await fetchAllData();

    // Third call — gate should send If-Modified-Since from the second call's response
    mockOctokit.request.mockResolvedValueOnce({
      data: [],
      headers: {},
    });
    vi.mocked(fetchIssuesAndPullRequests).mockResolvedValue(emptyIssuesAndPrsResult);
    vi.mocked(fetchWorkflowRuns).mockResolvedValue(emptyRunResult);
    await fetchAllData();

    // Inspect the third GET /notifications call for the If-Modified-Since header
    const notifCalls = mockOctokit.request.mock.calls.filter(
      (c) => c[0] === "GET /notifications"
    );
    expect(notifCalls.length).toBeGreaterThanOrEqual(2);
    const thirdCallParams = (notifCalls[notifCalls.length - 1] as unknown[])[1] as Record<string, unknown>;
    expect((thirdCallParams["headers"] as Record<string, string>)["If-Modified-Since"]).toBe(lastModified);
  });
});

// ── qa-2: hasNotificationChanges 403 auto-disable ────────────────────────────

describe("fetchAllData — notification gate 403 auto-disable", () => {
  it("disables notification gate after 403 and skips it on subsequent calls", async () => {
    vi.resetModules();

    const { getClient } = await import("../../src/app/services/github");
    const { fetchIssuesAndPullRequests, fetchWorkflowRuns } = await import("../../src/app/services/api");
    const { pushNotification } = await import("../../src/app/lib/errors");
    const mockOctokit = makeMockOctokit();
    vi.mocked(getClient).mockReturnValue(mockOctokit as unknown as ReturnType<typeof getClient>);
    vi.mocked(fetchIssuesAndPullRequests).mockResolvedValue(emptyIssuesAndPrsResult);
    vi.mocked(fetchWorkflowRuns).mockResolvedValue(emptyRunResult);


    const { fetchAllData } = await import("../../src/app/services/poll");

    // First call — sets _lastSuccessfulFetch
    await fetchAllData();
    vi.mocked(fetchIssuesAndPullRequests).mockClear();

    // Second call — gate checks notifications, gets 403
    mockOctokit.request.mockRejectedValueOnce({ status: 403 });
    await fetchAllData();

    // Gate received 403 → _notifGateDisabled = true → pushNotification called
    expect(pushNotification).toHaveBeenCalledWith(
      "notifications",
      expect.stringContaining("403"),
      "warning"
    );

    // Third call — gate should be DISABLED, no notifications request
    mockOctokit.request.mockClear();
    vi.mocked(fetchIssuesAndPullRequests).mockClear();
    vi.mocked(fetchWorkflowRuns).mockClear();
    vi.mocked(fetchIssuesAndPullRequests).mockResolvedValue(emptyIssuesAndPrsResult);
    vi.mocked(fetchWorkflowRuns).mockResolvedValue(emptyRunResult);

    await fetchAllData();

    expect(mockOctokit.request).not.toHaveBeenCalled();
    // The data fetches still run
    expect(fetchIssuesAndPullRequests).toHaveBeenCalled();
    expect(fetchWorkflowRuns).toHaveBeenCalled();
  });

  it("still fetches data on the same call that triggers the 403", async () => {
    vi.resetModules();

    const { getClient } = await import("../../src/app/services/github");
    const { fetchIssuesAndPullRequests, fetchWorkflowRuns } = await import("../../src/app/services/api");
    const mockOctokit = makeMockOctokit();
    vi.mocked(getClient).mockReturnValue(mockOctokit as unknown as ReturnType<typeof getClient>);
    vi.mocked(fetchIssuesAndPullRequests).mockResolvedValue(emptyIssuesAndPrsResult);
    vi.mocked(fetchWorkflowRuns).mockResolvedValue(emptyRunResult);


    const { fetchAllData } = await import("../../src/app/services/poll");

    // First call — sets _lastSuccessfulFetch
    await fetchAllData();
    vi.mocked(fetchIssuesAndPullRequests).mockClear();
    vi.mocked(fetchWorkflowRuns).mockClear();

    // Second call — gate returns 403; hasNotificationChanges returns true → full fetch runs
    mockOctokit.request.mockRejectedValueOnce({ status: 403 });

    const result = await fetchAllData();

    expect(result.skipped).toBeUndefined();
    expect(fetchIssuesAndPullRequests).toHaveBeenCalled();
    expect(fetchWorkflowRuns).toHaveBeenCalled();
  });
});

// ── qa-4: Concurrency verification ────────────────────────────────────────────

describe("fetchAllData — parallel execution", () => {
  it("initiates both fetches before either resolves", async () => {
    vi.resetModules();

    const { getClient } = await import("../../src/app/services/github");
    const { fetchIssuesAndPullRequests, fetchWorkflowRuns } = await import("../../src/app/services/api");
    const mockOctokit = makeMockOctokit();
    vi.mocked(getClient).mockReturnValue(mockOctokit as unknown as ReturnType<typeof getClient>);

    const callOrder: string[] = [];
    const resolvers: Array<(v: unknown) => void> = [];

    // Each mock records when it's called but doesn't resolve until manually triggered
    vi.mocked(fetchIssuesAndPullRequests).mockImplementation(() => {
      callOrder.push("issues-and-prs-start");
      return new Promise((resolve) => { resolvers.push(() => resolve(emptyIssuesAndPrsResult)); });
    });
    vi.mocked(fetchWorkflowRuns).mockImplementation(() => {
      callOrder.push("runs-start");
      return new Promise((resolve) => { resolvers.push(() => resolve(emptyRunResult)); });
    });

    const { fetchAllData } = await import("../../src/app/services/poll");

    const promise = fetchAllData();

    // Yield to allow Promise.allSettled to initiate both
    await new Promise((r) => setTimeout(r, 0));

    // Both should have been called BEFORE either resolved
    expect(callOrder).toEqual(["issues-and-prs-start", "runs-start"]);
    expect(resolvers.length).toBe(2);

    // Now resolve both
    for (const resolve of resolvers) resolve(undefined);
    await promise;
  });
});
