import { describe, it, expect, vi, afterEach } from "vitest";
import { createSignal } from "solid-js";
import { render, fireEvent } from "@solidjs/testing-library";
import { rateLimitCssClass } from "../../../src/app/lib/format";
import { applyHotPollPRUpdates } from "../../../src/app/components/dashboard/DashboardPage";
import { makeIssue, makePullRequest } from "../../helpers/index";
import type { PullRequest } from "../../../src/shared/types";
import type { HotPRStatusUpdate } from "../../../src/app/services/api";
import type { DashboardData } from "../../../src/app/services/poll";

describe("rateLimitCssClass", () => {
  it("remaining: 0 gives text-error", () => {
    expect(rateLimitCssClass(0, 5000)).toBe("text-error");
  });

  it("remaining < 10% of limit gives text-warning", () => {
    expect(rateLimitCssClass(100, 5000)).toBe("text-warning");
  });

  it("remaining >= 10% of limit gives empty string", () => {
    expect(rateLimitCssClass(3000, 5000)).toBe("");
  });

  it("remaining exactly at 10% threshold gives empty string (strict less-than)", () => {
    expect(rateLimitCssClass(500, 5000)).toBe("");
  });

  it("remaining just below 10% threshold gives text-warning", () => {
    expect(rateLimitCssClass(499, 5000)).toBe("text-warning");
  });
});

// ── PA-008: Hot poll terminal PR splice ───────────────────────────────────────

describe("hot poll terminal PR splice logic", () => {
  it("removes a MERGED PR from pullRequests when hot poll returns state:MERGED", () => {
    const state = { pullRequests: [makePullRequest({ id: 1 }), makePullRequest({ id: 2 })] };

    const prUpdates = new Map<number, HotPRStatusUpdate>([
      [1, { state: "MERGED", checkStatus: null, mergeStateStatus: "MERGED", reviewDecision: null }],
    ]);

    applyHotPollPRUpdates(state, prUpdates);

    expect(state.pullRequests.map((p) => p.id)).toEqual([2]);
  });

  it("removes a CLOSED PR from pullRequests when hot poll returns state:CLOSED", () => {
    const state = { pullRequests: [makePullRequest({ id: 10 }), makePullRequest({ id: 20 })] };

    const prUpdates = new Map<number, HotPRStatusUpdate>([
      [10, { state: "CLOSED", checkStatus: null, mergeStateStatus: "", reviewDecision: null }],
    ]);

    applyHotPollPRUpdates(state, prUpdates);

    expect(state.pullRequests.map((p) => p.id)).toEqual([20]);
  });

  it("keeps OPEN PRs in pullRequests after hot poll update", () => {
    const state = { pullRequests: [makePullRequest({ id: 5 })] };

    const prUpdates = new Map<number, HotPRStatusUpdate>([
      [5, { state: "OPEN", checkStatus: "success", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED" }],
    ]);

    applyHotPollPRUpdates(state, prUpdates);

    expect(state.pullRequests).toHaveLength(1);
    expect(state.pullRequests[0].id).toBe(5);
  });

  it("removes only the MERGED PR and leaves remaining PRs intact", () => {
    const state = {
      pullRequests: [makePullRequest({ id: 100 }), makePullRequest({ id: 101 }), makePullRequest({ id: 102 })],
    };

    const prUpdates = new Map<number, HotPRStatusUpdate>([
      [101, { state: "MERGED", checkStatus: null, mergeStateStatus: "MERGED", reviewDecision: null }],
    ]);

    applyHotPollPRUpdates(state, prUpdates);

    expect(state.pullRequests.map((p) => p.id)).toEqual([100, 102]);
  });

  it("updates headSha and autoMergeMethod while preserving Phase 1 team viewerReviewRequested and reviewerLogins until approved", () => {
    const teamRequestedPR: PullRequest = makePullRequest({
      id: 7,
      viewerReviewRequested: true,
      reviewerLogins: [],
    });
    const state = { pullRequests: [teamRequestedPR] };
    const newSha = "f0e1d2c3b4a5f0e1d2c3b4a5f0e1d2c3b4a5f0e1";

    // Hot poll returns direct viewerReviewRequested: false (because review was requested via a team),
    // updated headSha, and autoMergeMethod: "SQUASH", while viewer has not yet approved.
    const prUpdates1 = new Map<number, HotPRStatusUpdate>([
      [
        7,
        {
          state: "OPEN",
          checkStatus: "success",
          mergeStateStatus: "BLOCKED",
          reviewDecision: "REVIEW_REQUIRED",
          headSha: newSha,
          autoMergeMethod: "SQUASH",
          viewerReviewRequested: false,
          viewerLatestReviewState: null,
        },
      ],
    ]);

    applyHotPollPRUpdates(state, prUpdates1, "TestUser");

    expect(state.pullRequests[0].headSha).toBe(newSha);
    expect(state.pullRequests[0].autoMergeMethod).toBe("SQUASH");
    expect(state.pullRequests[0].viewerReviewRequested).toBe(true);
    expect(state.pullRequests[0].reviewerLogins).toEqual(["testuser"]);

    // Subsequent hot poll after viewer approves: viewerReviewRequested is cleared and viewer remains in reviewerLogins
    const prUpdates2 = new Map<number, HotPRStatusUpdate>([
      [
        7,
        {
          state: "OPEN",
          checkStatus: "success",
          mergeStateStatus: "CLEAN",
          reviewDecision: "APPROVED",
          headSha: newSha,
          autoMergeMethod: "SQUASH",
          viewerReviewRequested: false,
          viewerLatestReviewState: "APPROVED",
        },
      ],
    ]);

    applyHotPollPRUpdates(state, prUpdates2, "TestUser");

    expect(state.pullRequests[0].viewerLatestReviewState).toBe("APPROVED");
    expect(state.pullRequests[0].viewerReviewRequested).toBe(false);
    expect(state.pullRequests[0].reviewerLogins).toEqual(["testuser"]);
  });

  it("updates pr.draft when update.draft is boolean and preserves pr.draft when update.draft is undefined", () => {
    const state = {
      pullRequests: [
        makePullRequest({ id: 11, draft: true }),
        makePullRequest({ id: 12, draft: false }),
        makePullRequest({ id: 13, draft: true }),
      ],
    };

    const prUpdates = new Map<number, HotPRStatusUpdate>([
      [11, { state: "OPEN", draft: false, checkStatus: "pending", mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" }],
      [12, { state: "OPEN", draft: true, checkStatus: "pending", mergeStateStatus: "DRAFT", reviewDecision: null }],
      [13, { state: "OPEN", checkStatus: "success", mergeStateStatus: "CLEAN", reviewDecision: null }],
    ]);

    applyHotPollPRUpdates(state, prUpdates);

    expect(state.pullRequests[0].draft).toBe(false);
    expect(state.pullRequests[1].draft).toBe(true);
    expect(state.pullRequests[2].draft).toBe(true);
  });
});

// ── Jira duplicate-fetch deduplication on load ───────────────────────────────

describe("DashboardPage — Jira load fetch deduplication", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  async function setupJiraDedupeMocks(mockSearchJql: ReturnType<typeof vi.fn>) {
    vi.resetModules();

    let identityEpochVal = 0;
    const authClearCallbacks: (() => void)[] = [];
    const [lastRefreshAt, setLastRefreshAt] = createSignal<Date | null>(null);

    vi.doMock("@solidjs/router", () => ({
      useNavigate: () => vi.fn(),
    }));

    vi.doMock("../../../src/app/stores/auth", () => ({
      clearAuth: vi.fn(),
      expireToken: vi.fn(),
      token: () => "fake-token",
      user: () => ({ login: "testuser", avatar_url: "", name: "Test User" }),
      isAuthenticated: () => true,
      onAuthCleared: vi.fn((cb: () => void) => {
        authClearCallbacks.push(() => {
          identityEpochVal++;
          cb();
        });
      }),
      DASHBOARD_STORAGE_KEY: "github-tracker:dashboard",
      DEP_META_STORAGE_KEY: "github-tracker:dep-meta",
      jiraAuth: vi.fn(() => ({
        cloudId: "cloud-123",
        accessToken: "tok",
        siteUrl: "https://test.atlassian.net",
        siteName: "Test Site",
      })),
      isJiraAuthenticated: vi.fn(() => true),
      setJiraAuth: vi.fn(),
      clearJiraAuth: vi.fn(),
      ensureJiraTokenValid: vi.fn().mockResolvedValue(true),
      identityEpoch: () => identityEpochVal,
    }));

    vi.doMock("../../../src/app/lib/dashboard-snapshot", () => ({
      loadSnapshot: vi.fn().mockResolvedValue(null),
      writeSnapshot: vi.fn(),
      flushSnapshot: vi.fn().mockResolvedValue(undefined),
      clearSnapshot: vi.fn().mockResolvedValue(undefined),
    }));

    const MockJiraClient = vi.fn(function (this: Record<string, unknown>) {
      this.searchJql = mockSearchJql;
      this.bulkFetch = vi.fn().mockResolvedValue({ issues: [], errors: [] });
    });

    vi.doMock("../../../src/app/services/jira-client", () => ({
      JiraClient: MockJiraClient,
      JiraProxyClient: MockJiraClient,
      JiraApiError: class JiraApiError extends Error {
        status: number;
        constructor(status: number, _body: unknown, message: string) {
          super(message);
          this.status = status;
        }
      },
      DEFAULT_FIELDS: ["summary", "status", "priority", "assignee", "project", "updated", "issuetype", "created"],
    }));

    vi.doMock("../../../src/app/services/jira-keys", () => ({
      detectAndLookupJiraKeys: vi.fn().mockResolvedValue(new Map()),
      clearJiraKeyCache: vi.fn(),
    }));

    vi.doMock("../../../src/app/services/github", () => ({
      getCoreRateLimit: () => null,
      getGraphqlRateLimit: () => null,
      getClient: vi.fn(() => null),
      updateGraphqlRateLimit: vi.fn(),
    }));

    vi.doMock("../../../src/app/lib/notifications", () => ({
      detectNewItems: vi.fn(() => ({ issues: [], pullRequests: [], workflowRuns: [] })),
      dispatchNotifications: vi.fn(),
      _resetNotificationState: vi.fn(),
    }));

    vi.doMock("../../../src/app/lib/errors", () => ({
      getErrors: vi.fn().mockReturnValue([]),
      getNotifications: vi.fn().mockReturnValue([]),
      getUnreadCount: vi.fn().mockReturnValue(0),
      markAllAsRead: vi.fn(),
      dismissError: vi.fn(),
      dismissNotificationBySource: vi.fn(),
      pushError: vi.fn(),
      pushNotification: vi.fn(),
      clearErrors: vi.fn(),
      clearNotifications: vi.fn(),
      addMutedSource: vi.fn(),
      isMuted: vi.fn(() => false),
      clearMutedSources: vi.fn(),
    }));

    const mockFetchAllData = vi.fn().mockResolvedValue({
      issues: [],
      pullRequests: [],
      workflowRuns: [],
      errors: [],
    });
    let capturedFetchAll: (() => Promise<DashboardData>) | null = null;

    vi.doMock("../../../src/app/services/poll", () => ({
      fetchAllData: mockFetchAllData,
      createPollCoordinator: vi.fn().mockImplementation(
        (_getInterval: unknown, fetchAll: () => Promise<DashboardData>) => {
          capturedFetchAll = fetchAll;
          return {
            isRefreshing: () => false,
            lastRefreshAt,
            manualRefresh: vi.fn(() => {
              setLastRefreshAt(new Date());
            }),
            destroy: vi.fn(),
          };
        },
      ),
      createHotPollCoordinator: vi.fn().mockImplementation(() => ({ destroy: vi.fn() })),
      createEventsPollCoordinator: vi.fn().mockImplementation(() => ({ destroy: vi.fn() })),
      rebuildHotSets: vi.fn(),
      seedHotSetsFromTargeted: vi.fn(),
      clearHotSets: vi.fn(),
      getHotPollGeneration: vi.fn().mockReturnValue(0),
      StaleIdentityError: class StaleIdentityError extends Error {},
    }));

    const freshView = await import("../../../src/app/stores/view");
    const freshConfig = await import("../../../src/app/stores/config");
    const freshDash = await import("../../../src/app/components/dashboard/DashboardPage");

    freshView.resetViewState();
    freshConfig.resetConfig();
    freshConfig.updateJiraConfig({
      enabled: true,
      siteUrl: "https://test.atlassian.net",
      siteName: "Test Site",
      authMethod: "oauth",
    });

    return {
      DashboardPage: freshDash.default,
      _testCounters: freshDash._testCounters,
      freshConfig,
      freshView,
      mockFetchAllData,
      triggerPoll: () => capturedFetchAll!(),
      setLastRefreshAt,
      triggerAuthCleared: () => {
        for (const cb of authClearCallbacks) cb();
      },
    };
  }

  it("does not recompute exclusiveOwnership when switching between built-in and custom tabs and renders scoped custom-tab items", async () => {
    const mockSearchJql = vi.fn().mockResolvedValue({
      issues: [],
      maxResults: 100,
      startAt: 0,
    });

    const {
      DashboardPage: FreshDashboard,
      _testCounters,
      freshConfig,
      freshView,
      mockFetchAllData,
      triggerPoll,
    } = await setupJiraDedupeMocks(mockSearchJql);

    mockFetchAllData.mockResolvedValue({
      issues: [
        makeIssue({ id: 1, title: "Octocat Exclusive Issue", repoFullName: "octocat/Hello-World", userLogin: "testuser" }),
        makeIssue({ id: 2, title: "Other Repo Issue", repoFullName: "other/Repo", userLogin: "testuser" }),
      ],
      pullRequests: [
        makePullRequest({ id: 10, title: "Octocat Team PR", repoFullName: "octocat/Hello-World", userLogin: "testuser" }),
        makePullRequest({ id: 11, title: "Other Repo PR", repoFullName: "other/Repo", userLogin: "testuser" }),
      ],
      workflowRuns: [],
      errors: [],
    });

    freshConfig.updateConfig({
      selectedRepos: [
        { owner: "octocat", name: "Hello-World", fullName: "octocat/Hello-World" },
        { owner: "other", name: "Repo", fullName: "other/Repo" },
      ],
      customTabs: [
        {
          id: "exclusive-issues",
          name: "Exclusive Issues",
          baseType: "issues",
          orgScope: ["octocat"],
          repoScope: [],
          filterPreset: {},
          exclusive: true,
        },
        {
          id: "non-exclusive-prs",
          name: "Team PRs",
          baseType: "pullRequests",
          orgScope: ["octocat"],
          repoScope: [],
          filterPreset: {},
          exclusive: false,
        },
      ],
    });
    freshView.updateViewState({ lastActiveTab: "issues" });
    freshView.setAllExpanded("issues", true);
    freshView.setAllExpanded("pullRequests", true);
    freshView.setAllExpanded("non-exclusive-prs", true);
    freshView.setAllExpanded("exclusive-issues", true);

    _testCounters.exclusiveOwnershipRuns = 0;

    const { unmount, getByRole, queryByText } = render(() => <FreshDashboard />);
    try {
      await triggerPoll();

      // Built-in Issues tab shows only the non-claimed issue
      expect(queryByText("Other Repo Issue")).not.toBeNull();
      expect(queryByText("Octocat Exclusive Issue")).toBeNull();

      const runsAfterLoad = _testCounters.exclusiveOwnershipRuns;
      expect(runsAfterLoad).toBeGreaterThan(0);

      // Switch to Pull Requests tab via TabBar click and viewState
      const prTabBtn = getByRole("tab", { name: /^Pull Requests/i });
      fireEvent.click(prTabBtn);
      expect(freshView.viewState.lastActiveTab).toBe("pullRequests");
      expect(_testCounters.exclusiveOwnershipRuns).toBe(runsAfterLoad);
      expect(queryByText("Octocat Team PR")).not.toBeNull();
      expect(queryByText("Other Repo PR")).not.toBeNull();

      // Switch to non-exclusive custom tab ("Team PRs") — exercises activeCustomTabData()[tabId]
      const teamPrsTabBtn = getByRole("tab", { name: /Team PRs/i });
      fireEvent.click(teamPrsTabBtn);
      expect(freshView.viewState.lastActiveTab).toBe("non-exclusive-prs");
      expect(_testCounters.exclusiveOwnershipRuns).toBe(runsAfterLoad);
      expect(queryByText("Octocat Team PR")).not.toBeNull();
      expect(queryByText("Other Repo PR")).toBeNull();

      // Switch to exclusive custom tab ("Exclusive Issues") — exercises exclusiveCustomTabData()[tabId]
      const exclusiveIssuesTabBtn = getByRole("tab", { name: /Exclusive Issues/i });
      fireEvent.click(exclusiveIssuesTabBtn);
      expect(freshView.viewState.lastActiveTab).toBe("exclusive-issues");
      expect(_testCounters.exclusiveOwnershipRuns).toBe(runsAfterLoad);
      expect(queryByText("Octocat Exclusive Issue")).not.toBeNull();
      expect(queryByText("Other Repo Issue")).toBeNull();

      // Switch to Actions tab and back to Issues tab
      const actionsTabBtn = getByRole("tab", { name: /Actions/i });
      fireEvent.click(actionsTabBtn);
      expect(freshView.viewState.lastActiveTab).toBe("actions");
      expect(_testCounters.exclusiveOwnershipRuns).toBe(runsAfterLoad);

      const issuesTabBtn = getByRole("tab", { name: /^Issues/i });
      fireEvent.click(issuesTabBtn);
      expect(freshView.viewState.lastActiveTab).toBe("issues");
      expect(_testCounters.exclusiveOwnershipRuns).toBe(runsAfterLoad);
      expect(queryByText("Other Repo Issue")).not.toBeNull();
      expect(queryByText("Octocat Exclusive Issue")).toBeNull();
    } finally {
      unmount();
    }
  });

  it("skips the duplicate post-refresh Jira fetch when the first poll completes 5 s after mount, and fetches on the next poll at +60 s", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-01T12:00:00Z"));

    const mockSearchJql = vi.fn().mockResolvedValue({
      issues: [],
      maxResults: 100,
      startAt: 0,
    });

    const { DashboardPage: FreshDashboard, setLastRefreshAt } = await setupJiraDedupeMocks(mockSearchJql);

    const { unmount } = render(() => <FreshDashboard />);
    try {
      await vi.advanceTimersByTimeAsync(0);
      // Immediate mount fetch ran once at t = 0
      expect(mockSearchJql).toHaveBeenCalledTimes(1);

      // First GitHub poll completes 5 s later (within the 20 s deduplication window)
      await vi.advanceTimersByTimeAsync(5_000);
      setLastRefreshAt(new Date());
      await vi.advanceTimersByTimeAsync(0);

      expect(mockSearchJql).toHaveBeenCalledTimes(1);

      // Next GitHub poll completes at +60 s (55 s later, outside the 20 s window)
      await vi.advanceTimersByTimeAsync(55_000);
      setLastRefreshAt(new Date());
      await vi.advanceTimersByTimeAsync(0);

      expect(mockSearchJql).toHaveBeenCalledTimes(2);
    } finally {
      unmount();
    }
  });

  it("resets lastJiraFetchStartedAt on logout so the first post-login poll within 20 s fetches Jira issues", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-01T12:00:00Z"));

    const mockSearchJql = vi.fn().mockResolvedValue({
      issues: [],
      maxResults: 100,
      startAt: 0,
    });

    const { DashboardPage: FreshDashboard, setLastRefreshAt, triggerAuthCleared } =
      await setupJiraDedupeMocks(mockSearchJql);

    const { unmount } = render(() => <FreshDashboard />);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(mockSearchJql).toHaveBeenCalledTimes(1);

      // Logout/login within 20 s (at +5 s) resets lastJiraFetchStartedAt to 0
      await vi.advanceTimersByTimeAsync(5_000);
      triggerAuthCleared();

      // Re-mount for the newly logged-in session or trigger the first post-login poll within 20 s
      setLastRefreshAt(new Date());
      await vi.advanceTimersByTimeAsync(0);

      expect(mockSearchJql).toHaveBeenCalledTimes(2);
    } finally {
      unmount();
    }
  });

  it("retries Jira fetch on the first poll within 20 s if the initial mount fetch failed, and re-fetches on manual Refresh within 20 s", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-01T12:00:00Z"));

    const mockSearchJql = vi
      .fn()
      .mockRejectedValueOnce(new Error("Transient network failure"))
      .mockResolvedValue({
        issues: [],
        maxResults: 100,
        startAt: 0,
      });

    const { DashboardPage: FreshDashboard, setLastRefreshAt } = await setupJiraDedupeMocks(mockSearchJql);

    const { unmount, getByRole } = render(() => <FreshDashboard />);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(mockSearchJql).toHaveBeenCalledTimes(1);

      // First poll completes 5 s later -> retries because the mount fetch failed
      await vi.advanceTimersByTimeAsync(5_000);
      setLastRefreshAt(new Date());
      await vi.advanceTimersByTimeAsync(0);
      expect(mockSearchJql).toHaveBeenCalledTimes(2);

      // User clicks manual Refresh 3 s later (within 20 s of the successful retry) -> not suppressed
      await vi.advanceTimersByTimeAsync(3_000);
      const refreshBtn = getByRole("button", { name: /Refresh data/i });
      fireEvent.click(refreshBtn);
      await vi.advanceTimersByTimeAsync(0);
      expect(mockSearchJql).toHaveBeenCalledTimes(3);
    } finally {
      unmount();
    }
  });

  it("discards stale-scope issues and re-runs fetchJiraAssigned for the new scope when scope changes while a Jira fetch is in flight", async () => {
    const makeJiraIssue = (id: string, key: string, summary: string) => ({
      id,
      key,
      fields: {
        summary,
        status: { name: "To Do", statusCategory: { key: "new", name: "To Do" } },
        priority: { name: "High", id: "2" },
        assignee: { displayName: "Test User" },
        project: { key: "PROJ", name: "Project" },
        updated: "2026-11-01T12:00:00.000+0000",
        created: "2026-11-01T10:00:00.000+0000",
        issuetype: { name: "Bug", subtask: false },
      },
    });

    let resolveFirstFetch!: (value: { issues: unknown[]; maxResults: number; startAt: number }) => void;
    let resolveSecondFetch!: (value: { issues: unknown[]; maxResults: number; startAt: number }) => void;
    const mockSearchJql = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstFetch = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecondFetch = resolve;
          }),
      );

    const { DashboardPage: FreshDashboard, freshView } = await setupJiraDedupeMocks(mockSearchJql);
    freshView.updateViewState({ lastActiveTab: "jiraAssigned" });
    freshView.setAllExpanded("jiraAssigned", true);

    const { unmount, queryByText } = render(() => <FreshDashboard />);
    try {
      // Mount fetch is in flight for default "assigned" scope
      expect(mockSearchJql).toHaveBeenCalledTimes(1);
      expect(mockSearchJql.mock.calls[0][0]).toContain("assignee = currentUser()");

      // User switches scope to "reported" while the "assigned" fetch is still in flight
      freshView.setTabFilter("jiraAssigned", "scope", "reported");

      // Resolve the initial "assigned" fetch with a stale issue -> discarded and triggers a rerun for "reported"
      resolveFirstFetch({
        issues: [makeJiraIssue("101", "PROJ-1", "Stale Assigned Issue")],
        maxResults: 100,
        startAt: 0,
      });
      await new Promise((r) => setTimeout(r, 0));

      expect(mockSearchJql).toHaveBeenCalledTimes(2);
      expect(mockSearchJql.mock.calls[1][0]).toContain("reporter = currentUser()");
      expect(queryByText("Stale Assigned Issue")).toBeNull();

      // Resolve the "reported" fetch -> renders only the reported scope's issue
      resolveSecondFetch({
        issues: [makeJiraIssue("102", "PROJ-2", "Fresh Reported Issue")],
        maxResults: 100,
        startAt: 0,
      });
      await new Promise((r) => setTimeout(r, 0));

      expect(queryByText("Stale Assigned Issue")).toBeNull();
      expect(queryByText("Fresh Reported Issue")).not.toBeNull();
    } finally {
      unmount();
    }
  });
});
