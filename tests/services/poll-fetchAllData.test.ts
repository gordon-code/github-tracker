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

    expect(fetchIssuesAndPullRequests).toHaveBeenCalledWith(mockOctokit, config.selectedRepos, "octocat", undefined, [], []);
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

  it("shows PAT-specific 403 notification when authMethod is 'pat'", async () => {
    vi.resetModules();

    // Override config mock to include authMethod: "pat" for this test
    vi.doMock("../../src/app/stores/config", () => ({
      config: {
        selectedRepos: [{ owner: "octocat", name: "Hello-World", fullName: "octocat/Hello-World" }],
        maxWorkflowsPerRepo: 5,
        maxRunsPerWorkflow: 3,
        authMethod: "pat",
      },
    }));

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

    // Second call — gate fires a 403
    mockOctokit.request.mockRejectedValueOnce({ status: 403 });
    await fetchAllData();

    // PAT-specific message should mention fine-grained tokens
    expect(pushNotification).toHaveBeenCalledWith(
      "notifications",
      expect.stringContaining("fine-grained tokens do not support notifications"),
      "warning"
    );
  });
});

// ── Upstream repos + tracked users integration ────────────────────────────────

describe("fetchAllData — upstream repos and tracked users", () => {

  it("passes combined (selectedRepos + upstreamRepos) deduplicated to fetchIssuesAndPullRequests", async () => {
    vi.resetModules();

    // Override config mock to include upstreamRepos
    vi.doMock("../../src/app/stores/config", () => ({
      config: {
        selectedRepos: [{ owner: "octocat", name: "Hello-World", fullName: "octocat/Hello-World" }],
        upstreamRepos: [
          { owner: "other-org", name: "upstream-repo", fullName: "other-org/upstream-repo" },
          // Duplicate of selectedRepos — should be filtered out
          { owner: "octocat", name: "Hello-World", fullName: "octocat/Hello-World" },
        ],
        trackedUsers: [],
        maxWorkflowsPerRepo: 5,
        maxRunsPerWorkflow: 3,
      },
    }));

    const { getClient } = await import("../../src/app/services/github");
    const { fetchIssuesAndPullRequests, fetchWorkflowRuns } = await import("../../src/app/services/api");
    const mockOctokit = makeMockOctokit();
    vi.mocked(getClient).mockReturnValue(mockOctokit as unknown as ReturnType<typeof getClient>);
    vi.mocked(fetchIssuesAndPullRequests).mockResolvedValue(emptyIssuesAndPrsResult);
    vi.mocked(fetchWorkflowRuns).mockResolvedValue(emptyRunResult);

    const { fetchAllData } = await import("../../src/app/services/poll");
    await fetchAllData();

    // Should be called with combined repos (2, not 3 — duplicate removed)
    const callArgs = vi.mocked(fetchIssuesAndPullRequests).mock.calls[0];
    const passedRepos = callArgs[1] as Array<{ fullName: string }>;
    expect(passedRepos).toHaveLength(2);
    expect(passedRepos.map((r) => r.fullName)).toContain("octocat/Hello-World");
    expect(passedRepos.map((r) => r.fullName)).toContain("other-org/upstream-repo");
  });

  it("passes only selectedRepos to fetchWorkflowRuns (upstream repos excluded)", async () => {
    vi.resetModules();

    vi.doMock("../../src/app/stores/config", () => ({
      config: {
        selectedRepos: [{ owner: "octocat", name: "Hello-World", fullName: "octocat/Hello-World" }],
        upstreamRepos: [{ owner: "other-org", name: "upstream-repo", fullName: "other-org/upstream-repo" }],
        trackedUsers: [],
        maxWorkflowsPerRepo: 5,
        maxRunsPerWorkflow: 3,
      },
    }));

    const { getClient } = await import("../../src/app/services/github");
    const { fetchIssuesAndPullRequests, fetchWorkflowRuns } = await import("../../src/app/services/api");
    const mockOctokit = makeMockOctokit();
    vi.mocked(getClient).mockReturnValue(mockOctokit as unknown as ReturnType<typeof getClient>);
    vi.mocked(fetchIssuesAndPullRequests).mockResolvedValue(emptyIssuesAndPrsResult);
    vi.mocked(fetchWorkflowRuns).mockResolvedValue(emptyRunResult);

    const { fetchAllData } = await import("../../src/app/services/poll");
    await fetchAllData();

    // fetchWorkflowRuns should only get selectedRepos, not upstream
    const callArgs = vi.mocked(fetchWorkflowRuns).mock.calls[0];
    const passedRepos = callArgs[1] as Array<{ fullName: string }>;
    expect(passedRepos).toHaveLength(1);
    expect(passedRepos[0].fullName).toBe("octocat/Hello-World");
  });

  it("passes trackedUsers to fetchIssuesAndPullRequests", async () => {
    vi.resetModules();

    const trackedUsers = [
      { login: "tracked-alice", avatarUrl: "https://avatars.githubusercontent.com/u/1", name: "Alice" },
    ];

    vi.doMock("../../src/app/stores/config", () => ({
      config: {
        selectedRepos: [{ owner: "octocat", name: "Hello-World", fullName: "octocat/Hello-World" }],
        upstreamRepos: [],
        trackedUsers,
        maxWorkflowsPerRepo: 5,
        maxRunsPerWorkflow: 3,
      },
    }));

    const { getClient } = await import("../../src/app/services/github");
    const { fetchIssuesAndPullRequests, fetchWorkflowRuns } = await import("../../src/app/services/api");
    const mockOctokit = makeMockOctokit();
    vi.mocked(getClient).mockReturnValue(mockOctokit as unknown as ReturnType<typeof getClient>);
    vi.mocked(fetchIssuesAndPullRequests).mockResolvedValue(emptyIssuesAndPrsResult);
    vi.mocked(fetchWorkflowRuns).mockResolvedValue(emptyRunResult);

    const { fetchAllData } = await import("../../src/app/services/poll");
    await fetchAllData();

    // 5th argument to fetchIssuesAndPullRequests should be trackedUsers
    const callArgs = vi.mocked(fetchIssuesAndPullRequests).mock.calls[0];
    expect(callArgs[4]).toEqual(trackedUsers);
  });

  it("empty upstreamRepos and trackedUsers produces identical behavior (backward compat)", async () => {
    vi.resetModules();

    const selectedRepos = [{ owner: "octocat", name: "Hello-World", fullName: "octocat/Hello-World" }];
    vi.doMock("../../src/app/stores/config", () => ({
      config: {
        selectedRepos,
        upstreamRepos: [],
        trackedUsers: [],
        maxWorkflowsPerRepo: 5,
        maxRunsPerWorkflow: 3,
      },
    }));

    const { getClient } = await import("../../src/app/services/github");
    const { fetchIssuesAndPullRequests, fetchWorkflowRuns } = await import("../../src/app/services/api");
    const mockOctokit = makeMockOctokit();
    vi.mocked(getClient).mockReturnValue(mockOctokit as unknown as ReturnType<typeof getClient>);
    vi.mocked(fetchIssuesAndPullRequests).mockResolvedValue(emptyIssuesAndPrsResult);
    vi.mocked(fetchWorkflowRuns).mockResolvedValue(emptyRunResult);

    const { fetchAllData } = await import("../../src/app/services/poll");
    await fetchAllData();

    // Combined repos == selectedRepos when no upstream repos
    expect(fetchIssuesAndPullRequests).toHaveBeenCalledWith(
      mockOctokit,
      selectedRepos,
      "octocat",
      undefined,
      [],
      []
    );
    expect(fetchWorkflowRuns).toHaveBeenCalledWith(
      mockOctokit,
      selectedRepos,
      5,
      3
    );
  });

  it("duplicate repo in both selectedRepos and upstreamRepos is deduplicated (first occurrence wins)", async () => {
    vi.resetModules();

    vi.doMock("../../src/app/stores/config", () => ({
      config: {
        selectedRepos: [
          { owner: "octocat", name: "Hello-World", fullName: "octocat/Hello-World" },
          { owner: "octocat", name: "Other", fullName: "octocat/Other" },
        ],
        upstreamRepos: [
          // Both are already in selectedRepos
          { owner: "octocat", name: "Hello-World", fullName: "octocat/Hello-World" },
          { owner: "octocat", name: "Other", fullName: "octocat/Other" },
          // This one is new
          { owner: "new-org", name: "new-repo", fullName: "new-org/new-repo" },
        ],
        trackedUsers: [],
        maxWorkflowsPerRepo: 5,
        maxRunsPerWorkflow: 3,
      },
    }));

    const { getClient } = await import("../../src/app/services/github");
    const { fetchIssuesAndPullRequests, fetchWorkflowRuns } = await import("../../src/app/services/api");
    const mockOctokit = makeMockOctokit();
    vi.mocked(getClient).mockReturnValue(mockOctokit as unknown as ReturnType<typeof getClient>);
    vi.mocked(fetchIssuesAndPullRequests).mockResolvedValue(emptyIssuesAndPrsResult);
    vi.mocked(fetchWorkflowRuns).mockResolvedValue(emptyRunResult);

    const { fetchAllData } = await import("../../src/app/services/poll");
    await fetchAllData();

    const callArgs = vi.mocked(fetchIssuesAndPullRequests).mock.calls[0];
    const passedRepos = callArgs[1] as Array<{ fullName: string }>;
    // 2 selected + 1 new upstream (2 duplicates filtered)
    expect(passedRepos).toHaveLength(3);
    const names = passedRepos.map((r) => r.fullName);
    expect(names.filter((n) => n === "octocat/Hello-World")).toHaveLength(1);
    expect(names.filter((n) => n === "octocat/Other")).toHaveLength(1);
    expect(names).toContain("new-org/new-repo");
  });
});

// ── DashboardPage fine-grained merge: surfacedBy preserved ────────────────────

describe("DashboardPage pollFetch — fine-grained merge preserves surfacedBy", () => {
  it("surfacedBy is copied into the store during the canMerge path", () => {
    // Test the canMerge loop logic directly (same code as DashboardPage.tsx pollFetch).
    // Using Record<string, unknown> to avoid the 'never' collapse from conflicting
    // enriched: false vs enriched: true literal types.
    type MutablePR = Record<string, unknown> & { id: number };

    const pr: MutablePR = {
      id: 5001,
      surfacedBy: ["mainuser", "trackeduser"],
      enriched: false,
    };

    const enriched: MutablePR = {
      id: 5001,
      headSha: "abc123",
      assigneeLogins: [],
      reviewerLogins: [],
      checkStatus: "success",
      additions: 5,
      deletions: 2,
      changedFiles: 1,
      comments: 0,
      reviewThreads: 0,
      totalReviewCount: 0,
      enriched: true,
      nodeId: "PR_node_5001",
      surfacedBy: ["mainuser", "trackeduser"],
    };

    const state = { pullRequests: [pr] };
    const enrichedMap = new Map([[5001, enriched]]);

    // Simulate the canMerge loop from DashboardPage.tsx
    for (let i = 0; i < state.pullRequests.length; i++) {
      const e = enrichedMap.get(state.pullRequests[i].id)!;
      const p = state.pullRequests[i];
      p["headSha"] = e["headSha"];
      p["assigneeLogins"] = e["assigneeLogins"];
      p["reviewerLogins"] = e["reviewerLogins"];
      p["checkStatus"] = e["checkStatus"];
      p["additions"] = e["additions"];
      p["deletions"] = e["deletions"];
      p["changedFiles"] = e["changedFiles"];
      p["comments"] = e["comments"];
      p["reviewThreads"] = e["reviewThreads"];
      p["totalReviewCount"] = e["totalReviewCount"];
      p["enriched"] = e["enriched"];
      p["nodeId"] = e["nodeId"];
      p["surfacedBy"] = e["surfacedBy"];
    }

    expect(state.pullRequests[0]["surfacedBy"]).toEqual(["mainuser", "trackeduser"]);
    expect(state.pullRequests[0]["enriched"]).toBe(true);
    expect(state.pullRequests[0]["checkStatus"]).toBe("success");
  });
});

// ── 401 propagation from Promise.allSettled ───────────────────────────────────

describe("fetchAllData — 401 propagation from allSettled", () => {
  it("re-throws 401 from fetchIssuesAndPullRequests instead of absorbing it", async () => {
    vi.resetModules();

    const { getClient } = await import("../../src/app/services/github");
    const { fetchIssuesAndPullRequests, fetchWorkflowRuns } = await import("../../src/app/services/api");
    const mockOctokit = makeMockOctokit();
    vi.mocked(getClient).mockReturnValue(mockOctokit as unknown as ReturnType<typeof getClient>);

    vi.mocked(fetchIssuesAndPullRequests).mockRejectedValue({ status: 401, message: "Unauthorized" });
    vi.mocked(fetchWorkflowRuns).mockResolvedValue(emptyRunResult);

    const { fetchAllData } = await import("../../src/app/services/poll");

    await expect(fetchAllData()).rejects.toMatchObject({ status: 401 });
  });

  it("re-throws 401 with response.status shape from fetchWorkflowRuns", async () => {
    vi.resetModules();

    const { getClient } = await import("../../src/app/services/github");
    const { fetchIssuesAndPullRequests, fetchWorkflowRuns } = await import("../../src/app/services/api");
    const mockOctokit = makeMockOctokit();
    vi.mocked(getClient).mockReturnValue(mockOctokit as unknown as ReturnType<typeof getClient>);

    vi.mocked(fetchIssuesAndPullRequests).mockResolvedValue(emptyIssuesAndPrsResult);
    vi.mocked(fetchWorkflowRuns).mockRejectedValue({ response: { status: 401 }, message: "Bad credentials" });

    const { fetchAllData } = await import("../../src/app/services/poll");

    await expect(fetchAllData()).rejects.toMatchObject({ response: { status: 401 } });
  });

  it("does NOT re-throw non-401 errors (500 is absorbed)", async () => {
    vi.resetModules();

    const { getClient } = await import("../../src/app/services/github");
    const { fetchIssuesAndPullRequests, fetchWorkflowRuns } = await import("../../src/app/services/api");
    const mockOctokit = makeMockOctokit();
    vi.mocked(getClient).mockReturnValue(mockOctokit as unknown as ReturnType<typeof getClient>);

    vi.mocked(fetchIssuesAndPullRequests).mockRejectedValue(Object.assign(new Error("Internal Server Error"), { status: 500 }));
    vi.mocked(fetchWorkflowRuns).mockResolvedValue(emptyRunResult);

    const { fetchAllData } = await import("../../src/app/services/poll");

    // Should resolve (not throw) — 500 is absorbed as a top-level error entry
    const result = await fetchAllData();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].repo).toBe("issues-and-prs");
    expect(result.errors[0].statusCode).toBe(500);
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
