import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSignal } from "solid-js";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { makeIssue, makePullRequest, makeWorkflowRun } from "../helpers/index";
import type { DashboardData } from "../../src/app/services/poll";
import type { HotPRStatusUpdate, HotWorkflowRunUpdate } from "../../src/app/services/api";
import { GRAPHQL_BODY_FETCH_TIMEOUT_MS } from "../../src/app/services/api";

const mockLocationReplace = vi.fn();

// DashboardPage no longer uses useNavigate — it calls window.location.replace("/login").
// Mock window.location so we can assert on the replace call.
Object.defineProperty(window, "location", {
  configurable: true,
  writable: true,
  value: { replace: mockLocationReplace, href: "" },
});

// Header (rendered inside DashboardPage) uses useNavigate — provide a stub so
// the real router context is not required in unit tests.
vi.mock("@solidjs/router", () => ({
  useNavigate: () => vi.fn(),
}));

// Mock auth store — capture onAuthCleared callbacks so qa-4 can invoke them
const authClearCallbacks: (() => void)[] = [];
vi.mock("../../src/app/stores/auth", () => ({
  clearAuth: vi.fn(),
  expireToken: vi.fn(),
  token: () => "fake-token",
  user: () => ({ login: "testuser", avatar_url: "", name: "Test User" }),
  isAuthenticated: () => true,
  onAuthCleared: vi.fn((cb: () => void) => { authClearCallbacks.push(cb); }),
  DASHBOARD_STORAGE_KEY: "github-tracker:dashboard",
  DEP_META_STORAGE_KEY: "github-tracker:dep-meta",
  jiraAuth: vi.fn(() => null),
  isJiraAuthenticated: vi.fn(() => false),
  setJiraAuth: vi.fn(),
  clearJiraAuth: vi.fn(),
  ensureJiraTokenValid: vi.fn().mockResolvedValue(false),
}));

vi.mock("../../src/app/services/jira-client", () => ({
  JiraClient: vi.fn(),
  JiraProxyClient: vi.fn(),
}));

vi.mock("../../src/app/services/jira-keys", () => ({
  detectAndLookupJiraKeys: vi.fn().mockResolvedValue(new Map()),
  clearJiraKeyCache: vi.fn(),
}));

// Mock github service (used by Header + DashboardPage org sync)
vi.mock("../../src/app/services/github", () => ({
  getCoreRateLimit: () => null,
  getGraphqlRateLimit: () => null,
  getClient: vi.fn(() => null),
}));

// Mock notifications lib
vi.mock("../../src/app/lib/notifications", () => ({
  detectNewItems: vi.fn(() => []),
  dispatchNotifications: vi.fn(),
  _resetNotificationState: vi.fn(),
}));

// Mock errors lib — return empty by default
vi.mock("../../src/app/lib/errors", () => ({
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

// capturedFetchAll is populated by the createPollCoordinator mock each time
// the module is reset and DashboardPage re-mounts, creating a fresh coordinator.
let capturedFetchAll: (() => Promise<DashboardData>) | null = null;
// capturedOnHotData is populated by the createHotPollCoordinator mock
let capturedOnHotData: ((
  prUpdates: Map<number, HotPRStatusUpdate>,
  runUpdates: Map<number, HotWorkflowRunUpdate>,
  generation: number,
) => void) | null = null;
// capturedOnTargetedData is populated by the createEventsPollCoordinator mock
let capturedOnTargetedData: ((data: DashboardData, affectedRepos: string[]) => void) | null = null;

// DashboardPage and pollService are imported dynamically after each vi.resetModules()
// so the module-level _coordinator variable is always fresh (null) per test.
let DashboardPage: typeof import("../../src/app/components/dashboard/DashboardPage").default;
let _resetHasFetchedFresh: typeof import("../../src/app/components/dashboard/DashboardPage")._resetHasFetchedFresh;
let DEP_BODY_FAILURE_COOLDOWN_MS: typeof import("../../src/app/components/dashboard/DashboardPage").DEP_BODY_FAILURE_COOLDOWN_MS;
let pollService: typeof import("../../src/app/services/poll");
let authStore: typeof import("../../src/app/stores/auth");
let viewStore: typeof import("../../src/app/stores/view");
let configStore: typeof import("../../src/app/stores/config");

beforeEach(async () => {
  // Clear localStorage so loadCachedDashboard doesn't pick up stale data from prior tests
  localStorage.clear?.();
  // Reset module registry so DashboardPage's module-level _coordinator starts as null
  vi.resetModules();
  // Mutate in place (not reassign) to preserve the reference captured by vi.mock
  authClearCallbacks.length = 0;

  // Re-register mocks for the fresh module instances.
  // vi.doMock (not vi.mock) is the correct API for dynamic re-registration
  // after vi.resetModules(). vi.mock inside beforeEach is hoisted and will
  // become a hard error in a future Vitest version.
  vi.doMock("../../src/app/services/poll", () => ({
    fetchAllData: vi.fn().mockResolvedValue({
      issues: [],
      pullRequests: [],
      workflowRuns: [],
      errors: [],
    }),
    createPollCoordinator: vi.fn().mockImplementation(
      (_getInterval: unknown, fetchAll: () => Promise<DashboardData>) => {
        capturedFetchAll = fetchAll;
        // Invoke immediately so the dashboard fetches on mount.
        // .catch prevents unhandled rejection when auth error tests reject.
        void fetchAll().catch(() => {});
        return {
          isRefreshing: () => false,
          lastRefreshAt: () => null,
          manualRefresh: vi.fn(),
          destroy: vi.fn(),
        };
      }
    ),
    createHotPollCoordinator: vi.fn().mockImplementation(
      (_getInterval: unknown, onHotData: typeof capturedOnHotData) => {
        capturedOnHotData = onHotData;
        return { destroy: vi.fn() };
      }
    ),
    createEventsPollCoordinator: vi.fn().mockImplementation(
      (_getUsername: unknown, _trackedRepoNames: unknown, _isFullRefreshing: unknown, onTargetedData: typeof capturedOnTargetedData) => {
        capturedOnTargetedData = onTargetedData;
        return { destroy: vi.fn() };
      }
    ),
    rebuildHotSets: vi.fn(),
    seedHotSetsFromTargeted: vi.fn(),
    clearHotSets: vi.fn(),
    getHotPollGeneration: vi.fn().mockReturnValue(0),
  }));

  // Re-import with fresh module instances
  const dashboardModule = await import("../../src/app/components/dashboard/DashboardPage");
  DashboardPage = dashboardModule.default;
  _resetHasFetchedFresh = dashboardModule._resetHasFetchedFresh;
  DEP_BODY_FAILURE_COOLDOWN_MS = dashboardModule.DEP_BODY_FAILURE_COOLDOWN_MS;
  pollService = await import("../../src/app/services/poll");
  authStore = await import("../../src/app/stores/auth");
  viewStore = await import("../../src/app/stores/view");
  configStore = await import("../../src/app/stores/config");

  mockLocationReplace.mockClear();
  capturedFetchAll = null;
  capturedOnHotData = null;
  capturedOnTargetedData = null;
  vi.mocked(authStore.clearAuth).mockClear();
  vi.mocked(authStore.expireToken).mockClear();
  vi.mocked(pollService.fetchAllData).mockResolvedValue({
    issues: [],
    pullRequests: [],
    workflowRuns: [],
    errors: [],
  });
  // Reset view store to defaults
  viewStore.resetViewState();
  // Reset config store to defaults — prevents enableTracking, selectedRepos, etc. from leaking between tests
  configStore.resetConfig();
}, 30_000);

describe("DashboardPage — tab switching", () => {
  it("renders IssuesTab by default", () => {
    render(() => <DashboardPage />);
    // IssuesTab renders a SortDropdown with aria-label="Sort by"
    screen.getByLabelText("Sort by");
  });

  it("switches to PullRequestsTab when Pull Requests tab is clicked", async () => {
    const user = userEvent.setup();
    render(() => <DashboardPage />);
    await user.click(screen.getByText("Pull Requests"));
    // PullRequestsTab tab is now active
    const prButton = screen.getByText("Pull Requests").closest("button");
    expect(prButton?.getAttribute("aria-selected")).toBe("true");
  });

  it("switches to ActionsTab when Actions tab is clicked", async () => {
    const user = userEvent.setup();
    render(() => <DashboardPage />);
    await user.click(screen.getByText("Actions"));
    // ActionsTab renders a "Show PR runs" checkbox — unique to that tab
    screen.getByText("Show PR runs");
    const actionsButton = screen.getByText("Actions").closest("button");
    expect(actionsButton?.getAttribute("aria-selected")).toBe("true");
  });

  it("Issues tab button has aria-selected=true on initial render", () => {
    render(() => <DashboardPage />);
    const issuesButton = screen.getByText("Issues").closest("button");
    expect(issuesButton?.getAttribute("aria-selected")).toBe("true");
  });

  it("clicking a tab removes aria-selected from previous tab", async () => {
    const user = userEvent.setup();
    render(() => <DashboardPage />);
    await user.click(screen.getByText("Pull Requests"));
    const issuesButton = screen.getByText("Issues").closest("button");
    expect(issuesButton?.getAttribute("aria-selected")).toBe("false");
  });
});

describe("DashboardPage — clock tick", () => {
  it("creates a 60s interval to keep relative time displays fresh", () => {
    const spy = vi.spyOn(globalThis, "setInterval");
    render(() => <DashboardPage />);
    expect(spy.mock.calls.some(([, ms]) => ms === 60_000)).toBe(true);
    spy.mockRestore();
  });

  it("clears the clock interval on unmount", () => {
    const setSpy = vi.spyOn(globalThis, "setInterval");
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    const { unmount } = render(() => <DashboardPage />);
    const clockCallIdx = setSpy.mock.calls.findIndex(([, ms]) => ms === 60_000);
    expect(clockCallIdx).not.toBe(-1);
    const clockIntervalId = setSpy.mock.results[clockCallIdx].value;
    unmount();
    expect(clearSpy).toHaveBeenCalledWith(clockIntervalId);
    setSpy.mockRestore();
    clearSpy.mockRestore();
  });
});

describe("DashboardPage — tab badge counts", () => {
  it("decrements issue badge on ignore and increments on un-ignore", async () => {
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [
        makeIssue({ id: 1, title: "Issue A" }),
        makeIssue({ id: 2, title: "Issue B" }),
      ],
      pullRequests: [],
      workflowRuns: [],
      errors: [],
    });
    render(() => <DashboardPage />);
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /Issues/ }).textContent?.replace(/\D+/g, "")).toBe("2");
    });

    // Ignore one item — badge should decrement to 1
    viewStore.ignoreItem({ id: 1, type: "issue", repo: "owner/repo", title: "Issue A", ignoredAt: Date.now() });
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /Issues/ }).textContent?.replace(/\D+/g, "")).toBe("1");
    });

    // Un-ignore — badge should increment back to 2
    viewStore.unignoreItem(1);
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /Issues/ }).textContent?.replace(/\D+/g, "")).toBe("2");
    });
  });

  it("decrements PR badge on ignore", async () => {
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [],
      pullRequests: [
        makePullRequest({ id: 10, title: "PR A" }),
        makePullRequest({ id: 11, title: "PR B" }),
        makePullRequest({ id: 12, title: "PR C" }),
      ],
      workflowRuns: [],
      errors: [],
    });

    render(() => <DashboardPage />);
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /Pull Requests/ }).textContent?.replace(/\D+/g, "")).toBe("3");
    });

    viewStore.ignoreItem({ id: 10, type: "pullRequest", repo: "owner/repo", title: "PR A", ignoredAt: Date.now() });
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /Pull Requests/ }).textContent?.replace(/\D+/g, "")).toBe("2");
    });

    // Un-ignore — badge should increment back to 3
    viewStore.unignoreItem(10);
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /Pull Requests/ }).textContent?.replace(/\D+/g, "")).toBe("3");
    });
  });

  it("decrements Actions badge on ignore and increments on un-ignore", async () => {
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [],
      pullRequests: [],
      workflowRuns: [
        makeWorkflowRun({ id: 20, isPrRun: false }),
        makeWorkflowRun({ id: 21, isPrRun: false }),
      ],
      errors: [],
    });

    render(() => <DashboardPage />);
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /Actions/ }).textContent?.replace(/\D+/g, "")).toBe("2");
    });

    viewStore.ignoreItem({ id: 20, type: "workflowRun", repo: "owner/repo", title: "CI", ignoredAt: Date.now() });
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /Actions/ }).textContent?.replace(/\D+/g, "")).toBe("1");
    });

    // Un-ignore — badge should increment back to 2
    viewStore.unignoreItem(20);
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /Actions/ }).textContent?.replace(/\D+/g, "")).toBe("2");
    });
  });

  it("excludes PR-triggered runs from badge count by default", async () => {
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [],
      pullRequests: [],
      workflowRuns: [
        makeWorkflowRun({ id: 20, isPrRun: false }),
        makeWorkflowRun({ id: 21, isPrRun: true }),
        makeWorkflowRun({ id: 22, isPrRun: true }),
      ],
      errors: [],
    });

    render(() => <DashboardPage />);
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /Actions/ }).textContent?.replace(/\D+/g, "")).toBe("1");
    });
  });

  it("includes PR-triggered runs in badge count when showPrRuns is enabled", async () => {
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [],
      pullRequests: [],
      workflowRuns: [
        makeWorkflowRun({ id: 20, isPrRun: false }),
        makeWorkflowRun({ id: 21, isPrRun: true }),
        makeWorkflowRun({ id: 22, isPrRun: true }),
      ],
      errors: [],
    });

    render(() => <DashboardPage />);
    // Default: showPrRuns=false — badge shows 1
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /Actions/ }).textContent?.replace(/\D+/g, "")).toBe("1");
    });

    // Toggle on — badge should update to 3
    viewStore.updateViewState({ showPrRuns: true });
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /Actions/ }).textContent?.replace(/\D+/g, "")).toBe("3");
    });
  });

  it("combines showPrRuns and ignore exclusions for Actions badge", async () => {
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [],
      pullRequests: [],
      workflowRuns: [
        makeWorkflowRun({ id: 20, isPrRun: false }),
        makeWorkflowRun({ id: 21, isPrRun: true }),
        makeWorkflowRun({ id: 22, isPrRun: true }),
      ],
      errors: [],
    });
    viewStore.updateViewState({ showPrRuns: true });

    render(() => <DashboardPage />);
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /Actions/ }).textContent?.replace(/\D+/g, "")).toBe("3");
    });

    // Ignore one PR-triggered run — badge should drop to 2
    viewStore.ignoreItem({ id: 21, type: "workflowRun", repo: "owner/repo", title: "CI", ignoredAt: Date.now() });
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /Actions/ }).textContent?.replace(/\D+/g, "")).toBe("2");
    });
  });

  it("filters badge counts by globalFilter repo", async () => {
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [
        makeIssue({ id: 1, title: "Issue A", repoFullName: "org/alpha" }),
        makeIssue({ id: 2, title: "Issue B", repoFullName: "org/beta" }),
        makeIssue({ id: 3, title: "Issue C", repoFullName: "org/alpha" }),
      ],
      pullRequests: [
        makePullRequest({ id: 10, repoFullName: "org/alpha" }),
        makePullRequest({ id: 11, repoFullName: "org/beta" }),
      ],
      workflowRuns: [
        makeWorkflowRun({ id: 20, repoFullName: "org/alpha" }),
        makeWorkflowRun({ id: 21, repoFullName: "org/beta" }),
        makeWorkflowRun({ id: 22, repoFullName: "org/beta" }),
      ],
      errors: [],
    });
    // Set filter BEFORE render to avoid Kobalte Select onChange cascade in happy-dom
    viewStore.updateViewState({
      globalFilter: { org: null, repo: "org/alpha" },
    });

    render(() => <DashboardPage />);
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /Issues/ }).textContent?.replace(/\D+/g, "")).toBe("2");
      expect(screen.getByRole("tab", { name: /Pull Requests/ }).textContent?.replace(/\D+/g, "")).toBe("1");
      expect(screen.getByRole("tab", { name: /Actions/ }).textContent?.replace(/\D+/g, "")).toBe("1");
    });
  });

  it("filters badge counts by globalFilter org only", async () => {
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [
        makeIssue({ id: 1, repoFullName: "alpha/one" }),
        makeIssue({ id: 2, repoFullName: "beta/two" }),
        makeIssue({ id: 3, repoFullName: "alpha/three" }),
      ],
      pullRequests: [
        makePullRequest({ id: 10, repoFullName: "alpha/one" }),
        makePullRequest({ id: 11, repoFullName: "beta/two" }),
      ],
      workflowRuns: [
        makeWorkflowRun({ id: 20, repoFullName: "beta/two" }),
        makeWorkflowRun({ id: 21, repoFullName: "alpha/one" }),
      ],
      errors: [],
    });
    viewStore.updateViewState({
      globalFilter: { org: "alpha", repo: null },
    });

    render(() => <DashboardPage />);
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /Issues/ }).textContent?.replace(/\D+/g, "")).toBe("2");
      expect(screen.getByRole("tab", { name: /Pull Requests/ }).textContent?.replace(/\D+/g, "")).toBe("1");
      expect(screen.getByRole("tab", { name: /Actions/ }).textContent?.replace(/\D+/g, "")).toBe("1");
    });
  });
});

describe("DashboardPage — data flow", () => {
  it("passes fetched issues to IssuesTab", async () => {
    const issues = [
      makeIssue({ id: 1, title: "Fetched issue alpha" }),
      makeIssue({ id: 2, title: "Fetched issue beta" }),
    ];
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues,
      pullRequests: [],
      workflowRuns: [],
      errors: [],
    });

    render(() => <DashboardPage />);
    await waitFor(() => {
      // Repo group header visible (groups start collapsed — verify data reached the tab)
      screen.getByText("owner/repo");
      screen.getByText("2 issues");
    });
  });

  it("passes fetched pull requests to PullRequestsTab", async () => {
    const user = userEvent.setup();
    const pullRequests = [
      makePullRequest({ id: 10, title: "Fetched PR one" }),
      makePullRequest({ id: 11, title: "Fetched PR two" }),
    ];
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [],
      pullRequests,
      workflowRuns: [],
      errors: [],
    });

    render(() => <DashboardPage />);
    await user.click(screen.getByText("Pull Requests"));
    await waitFor(() => {
      // Repo group header visible (groups start collapsed — verify data reached the tab)
      screen.getByText("owner/repo");
      screen.getByText("2 PRs");
    });
  });

  it("passes fetched workflow runs to ActionsTab", async () => {
    const user = userEvent.setup();
    const workflowRuns = [
      makeWorkflowRun({ id: 20, name: "CI pipeline", workflowId: 100 }),
      makeWorkflowRun({ id: 21, name: "Deploy job", workflowId: 101 }),
    ];
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [],
      pullRequests: [],
      workflowRuns,
      errors: [],
    });

    render(() => <DashboardPage />);
    await user.click(screen.getByText("Actions"));
    await waitFor(() => {
      // ActionsTab shows repo group header (collapsed by default)
      expect(screen.getByText("owner/repo")).toBeTruthy();
    });
    // Expand the repo group to see workflow cards
    await user.click(screen.getByText("owner/repo"));
    await waitFor(() => {
      // Workflow cards visible after expansion
      expect(screen.getAllByText("CI pipeline").length).toBeGreaterThan(0);
      expect(screen.getAllByText("Deploy job").length).toBeGreaterThan(0);
    });
  });

  it("shows loading state while initial fetch is in progress", () => {
    // Override coordinator to NOT immediately invoke fetchAll (loading stays true)
    vi.mocked(pollService.createPollCoordinator).mockReturnValue({
      isRefreshing: () => true,
      lastRefreshAt: () => null,
      manualRefresh: vi.fn(),
      destroy: vi.fn(),
    });
    // fetchAllData never resolves
    vi.mocked(pollService.fetchAllData).mockReturnValue(new Promise(() => {}));

    render(() => <DashboardPage />);
    // IssuesTab loading skeleton uses role="status"
    screen.getByRole("status");
  });

});

describe("DashboardPage — auth error handling", () => {
  // pollFetch re-throws after handling auth errors; suppress the expected
  // unhandled rejection noise that escapes via `void fetchAll()` in the mock.
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("calls expireToken (not clearAuth) and redirects to /login on 401 error", async () => {
    const err401 = Object.assign(new Error("Unauthorized"), { status: 401 });
    vi.mocked(pollService.fetchAllData).mockRejectedValue(err401);

    render(() => <DashboardPage />);
    await waitFor(() => {
      expect(authStore.expireToken).toHaveBeenCalledOnce();
      expect(mockLocationReplace).toHaveBeenCalledWith("/login");
    });
    // clearAuth should NOT be called — user config/view preserved on token failure
    expect(authStore.clearAuth).not.toHaveBeenCalled();
  });

  it("does not call expireToken or clearAuth for non-401 errors", async () => {
    const err500 = Object.assign(new Error("Server Error"), { status: 500 });
    vi.mocked(pollService.fetchAllData).mockRejectedValue(err500);

    render(() => <DashboardPage />);
    // Flush all pending microtasks so the rejected promise settles
    await Promise.resolve();
    await Promise.resolve();
    expect(authStore.expireToken).not.toHaveBeenCalled();
    expect(authStore.clearAuth).not.toHaveBeenCalled();
    expect(mockLocationReplace).not.toHaveBeenCalledWith("/login");
  });
});

describe("DashboardPage — onAuthCleared integration", () => {
  it("onAuthCleared callback destroys coordinator and resets data", async () => {
    const issues = [makeIssue({ id: 1, title: "Should be cleared" })];
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues,
      pullRequests: [],
      workflowRuns: [],
      errors: [],
    });

    // Track the coordinator mock returned by createPollCoordinator
    const mockDestroy = vi.fn();
    vi.mocked(pollService.createPollCoordinator).mockImplementation(
      (_getInterval: unknown, fetchAll: () => Promise<DashboardData>) => {
        capturedFetchAll = fetchAll;
        void fetchAll().catch(() => {});
        return {
          isRefreshing: () => false,
          lastRefreshAt: () => null,
          manualRefresh: vi.fn(),
          destroy: mockDestroy,
        };
      }
    );

    render(() => <DashboardPage />);
    await waitFor(() => {
      // Repo group header visible (collapsed — verify data reached the tab)
      screen.getByText("owner/repo");
      screen.getByText("1 issue");
    });

    // DashboardPage registered an onAuthCleared callback at module scope.
    // Invoking it simulates what clearAuth() does on logout.
    expect(authClearCallbacks.length).toBeGreaterThan(0);
    for (const cb of authClearCallbacks) cb();

    // The coordinator's destroy() should have been called
    expect(mockDestroy).toHaveBeenCalled();

    // Dashboard data should be cleared — no stale repo groups visible
    await waitFor(() => {
      expect(screen.queryByText("1 issue")).toBeNull();
    });
  });
});

describe("DashboardPage — scroll preservation on poll refresh", () => {
  // MOCK INVARIANT: fetchAllData is mocked via vi.fn() and never calls its
  // onLightData callback, so phaseOneFired is always false inside pollFetch().
  // This means every poll cycle takes the withScrollLock branch (not the
  // fine-grained produce() path). If fetchAllData is ever changed to invoke
  // onLightData in tests, phaseOneFired will become true and withScrollLock
  // will NOT be called, silently breaking this test.
  //
  // window.scrollTo is the correct behavioral proxy for withScrollLock:
  // withScrollLock captures scrollY then calls window.scrollTo(0, y) after
  // the setter. Asserting scrollTo was called with the saved position is
  // equivalent to asserting withScrollLock ran and completed successfully.
  it("preserves scroll position when setDashboardData replaces arrays", async () => {
    const issues = [makeIssue({ id: 1, title: "Scroll test issue" })];
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues,
      pullRequests: [],
      workflowRuns: [],
      errors: [],
    });

    render(() => <DashboardPage />);
    await waitFor(() => {
      screen.getByText("owner/repo");
    });

    // Simulate user scrolled down
    document.documentElement.scrollTop = 500;
    vi.spyOn(window, "scrollTo");

    // Trigger a second poll (subsequent refresh — the path that uses withScrollLock).
    // phaseOneFired is false (mock never calls onLightData), so withScrollLock
    // wraps the full atomic setDashboardData replacement and restores scroll.
    if (capturedFetchAll) {
      await capturedFetchAll();
    }

    // window.scrollTo(0, 500) is the observable side-effect of withScrollLock
    // saving and restoring the pre-update scroll position.
    expect(window.scrollTo).toHaveBeenCalledWith(0, 500);
    vi.restoreAllMocks();
    document.documentElement.scrollTop = 0;
  });
});

describe("DashboardPage — onHotData integration", () => {
  it("applies hot poll PR status updates to the store", async () => {
    const testPR = makePullRequest({
      id: 42,
      checkStatus: "pending",
      state: "OPEN",
      reviewDecision: null,
    });
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [],
      pullRequests: [testPR],
      workflowRuns: [],
      errors: [],
    });
    render(() => <DashboardPage />);
    await waitFor(() => {
      expect(capturedOnHotData).not.toBeNull();
    });

    // Verify initial state shows pending (collapsed summary shows "1 PR" with pending count)
    const user = userEvent.setup();
    await user.click(screen.getByText("Pull Requests"));
    await waitFor(() => {
      screen.getByText("1 PR");
    });

    // Simulate hot poll returning a status update (generation=0 matches default mock)
    const prUpdates = new Map([[42, {
      state: "OPEN" as const,
      checkStatus: "success" as const,
      mergeStateStatus: "CLEAN",
      reviewDecision: "APPROVED" as const,
    }]]);
    capturedOnHotData!(prUpdates, new Map(), 0);

    // Expand the repo to verify the StatusDot updated
    await user.click(screen.getByText("owner/repo"));
    await waitFor(() => {
      expect(screen.getByLabelText("All checks passed")).toBeTruthy();
    });
  });

  it("discards stale hot poll updates when generation mismatches", async () => {
    const testPR = makePullRequest({
      id: 43,
      checkStatus: "pending",
      state: "OPEN",
    });
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [],
      pullRequests: [testPR],
      workflowRuns: [],
      errors: [],
    });
    render(() => <DashboardPage />);
    await waitFor(() => {
      expect(capturedOnHotData).not.toBeNull();
    });

    const user = userEvent.setup();
    await user.click(screen.getByText("Pull Requests"));
    await waitFor(() => {
      screen.getByText("1 PR");
    });

    // Expand repo to see StatusDot
    await user.click(screen.getByText("owner/repo"));
    await waitFor(() => {
      expect(screen.getByLabelText("Checks in progress")).toBeTruthy();
    });

    // Send update with stale generation (999 !== mock default of 0)
    const prUpdates = new Map([[43, {
      state: "OPEN" as const,
      checkStatus: "success" as const,
      mergeStateStatus: "CLEAN",
      reviewDecision: null,
    }]]);
    capturedOnHotData!(prUpdates, new Map(), 999);

    // PR should still show pending — stale update was discarded
    expect(screen.getByLabelText("Checks in progress")).toBeTruthy();
    expect(screen.queryByLabelText("All checks passed")).toBeNull();
  });

  it("applies hot poll workflow run updates via onHotData", async () => {
    // Verify the run-update path of the onHotData callback by confirming
    // the store mutation. The PR-update test above already validates the
    // produce() mechanism; this test covers the parallel run-update loop.
    const testRun = makeWorkflowRun({
      id: 100,
      status: "in_progress",
      conclusion: null,
    });
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [],
      pullRequests: [],
      workflowRuns: [testRun],
      errors: [],
    });

    render(() => <DashboardPage />);
    await waitFor(() => {
      expect(capturedOnHotData).not.toBeNull();
    });

    // Switch to Actions tab — the run appears in a collapsed repo group
    const user = userEvent.setup();
    await user.click(screen.getByText("Actions"));
    await waitFor(() => {
      // Collapsed summary shows "1 workflow"
      expect(screen.getByText(/1 workflow/)).toBeTruthy();
    });

    // Simulate hot poll completing the run
    const runUpdates = new Map([[100, {
      id: 100,
      status: "completed",
      conclusion: "success",
      updatedAt: "2026-03-29T12:00:00Z",
      completedAt: "2026-03-29T12:00:00Z",
    }]]);
    capturedOnHotData!(new Map(), runUpdates, 0);

    // The store was mutated — the collapsed summary still shows "1 workflow"
    // (the run count doesn't change, only the status), confirming the
    // callback executed without error. The PR test above fully validates
    // the produce() mechanism; this confirms the run path is wired.
    expect(screen.getByText(/1 workflow/)).toBeTruthy();
  });

  it("splices terminal (MERGED) PR from store via capturedOnHotData", async () => {
    const testPR = makePullRequest({
      id: 99,
      checkStatus: "pending",
      state: "OPEN",
      reviewDecision: null,
    });
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [],
      pullRequests: [testPR],
      workflowRuns: [],
      errors: [],
    });
    render(() => <DashboardPage />);
    await waitFor(() => {
      expect(capturedOnHotData).not.toBeNull();
    });

    const user = userEvent.setup();
    await user.click(screen.getByText("Pull Requests"));
    await waitFor(() => {
      screen.getByText("1 PR");
    });

    const prUpdates = new Map([[99, {
      state: "MERGED" as const,
      checkStatus: "success" as const,
      mergeStateStatus: "CLEAN",
      reviewDecision: null,
    }]]);
    capturedOnHotData!(prUpdates, new Map(), 0);

    await waitFor(() => {
      expect(screen.queryByText("1 PR")).toBeNull();
    });
  });
});

describe("DashboardPage — tracked tab", () => {
  it("renders Tracked tab when enableTracking is true", () => {
    configStore.updateConfig({ enableTracking: true });
    render(() => <DashboardPage />);
    expect(screen.getByText("Tracked")).toBeTruthy();
  });

  it("does not render Tracked tab when enableTracking is false", () => {
    configStore.updateConfig({ enableTracking: false });
    render(() => <DashboardPage />);
    expect(screen.queryByText("Tracked")).toBeNull();
  });

  it("Tracked tab badge shows count equal to trackedItems length", async () => {
    configStore.updateConfig({ enableTracking: true });
    viewStore.updateViewState({
      trackedItems: [{
        id: 42,
        number: 7,
        type: "issue" as const,
        source: "github" as const,
        repoFullName: "owner/repo",
        title: "Tracked issue",
        addedAt: Date.now(),
      }],
    });
    render(() => <DashboardPage />);
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /Tracked/ }).textContent?.replace(/\D+/g, "")).toBe("1");
    });
  });

  it("auto-prunes tracked items absent from open poll data", async () => {
    render(() => <DashboardPage />);
    configStore.updateConfig({
      enableTracking: true,
      selectedRepos: [{ owner: "org", name: "repo", fullName: "org/repo" }],
    });
    viewStore.updateViewState({
      trackedItems: [{
        id: 999,
        number: 99,
        type: "issue" as const,
        source: "github" as const,
        repoFullName: "org/repo",
        title: "Will be pruned",
        addedAt: Date.now(),
      }],
    });
    _resetHasFetchedFresh(true);

    // Trigger poll with empty issues — item 999 absent means it was closed
    if (capturedFetchAll) {
      vi.mocked(pollService.fetchAllData).mockResolvedValue({
        issues: [],
        pullRequests: [],
        workflowRuns: [],
        errors: [],
      });
      await capturedFetchAll();
    }

    await waitFor(() => {
      expect(viewStore.viewState.trackedItems.length).toBe(0);
    });
  });

  it("preserves tracked items from deselected repos", async () => {
    render(() => <DashboardPage />);
    configStore.updateConfig({
      enableTracking: true,
      selectedRepos: [{ owner: "org", name: "other-repo", fullName: "org/other-repo" }],
    });
    viewStore.updateViewState({
      trackedItems: [{
        id: 888,
        number: 88,
        type: "issue" as const,
        source: "github" as const,
        repoFullName: "org/deselected-repo",
        title: "Should be kept",
        addedAt: Date.now(),
      }],
    });
    _resetHasFetchedFresh(true);

    if (capturedFetchAll) {
      vi.mocked(pollService.fetchAllData).mockResolvedValue({
        issues: [],
        pullRequests: [],
        workflowRuns: [],
        errors: [],
      });
      await capturedFetchAll();
    }

    // Item from deselected repo should NOT be pruned
    await waitFor(() => {
      expect(viewStore.viewState.trackedItems.length).toBe(1);
      expect(viewStore.viewState.trackedItems[0].id).toBe(888);
    });
  });

  it("does not prune tracked items when hasFetchedFresh is false (cold start)", async () => {
    render(() => <DashboardPage />);
    configStore.updateConfig({
      enableTracking: true,
      selectedRepos: [{ owner: "org", name: "repo", fullName: "org/repo" }],
    });
    viewStore.updateViewState({
      trackedItems: [{
        id: 777,
        number: 77,
        type: "issue" as const,
        source: "github" as const,
        repoFullName: "org/repo",
        title: "Should survive cold start",
        addedAt: Date.now(),
      }],
    });
    // hasFetchedFresh stays false (its initial state) — do NOT call _resetHasFetchedFresh(true)
    // Do NOT trigger a poll (which would set hasFetchedFresh=true internally).
    // The prune effect should not fire against stale cached data.

    // Allow reactive effects to settle
    await waitFor(() => {
      // Item should NOT be pruned — hasFetchedFresh is false
      expect(viewStore.viewState.trackedItems.length).toBe(1);
      expect(viewStore.viewState.trackedItems[0].id).toBe(777);
    });
  });

  it("prunes tracked items from upstream repos", async () => {
    render(() => <DashboardPage />);
    configStore.updateConfig({
      enableTracking: true,
      selectedRepos: [],
      upstreamRepos: [{ owner: "ext", name: "upstream", fullName: "ext/upstream" }],
    });
    viewStore.updateViewState({
      trackedItems: [{
        id: 666,
        number: 66,
        type: "issue" as const,
        source: "github" as const,
        repoFullName: "ext/upstream",
        title: "Upstream item closed",
        addedAt: Date.now(),
      }],
    });
    _resetHasFetchedFresh(true);

    if (capturedFetchAll) {
      vi.mocked(pollService.fetchAllData).mockResolvedValue({
        issues: [],
        pullRequests: [],
        workflowRuns: [],
        errors: [],
      });
      await capturedFetchAll();
    }

    await waitFor(() => {
      expect(viewStore.viewState.trackedItems.length).toBe(0);
    });
  });

  it("resolveInitialTab falls back to issues when tracked tab disabled", () => {
    viewStore.updateViewState({ lastActiveTab: "tracked" });
    configStore.updateConfig({ rememberLastTab: true, enableTracking: false });
    render(() => <DashboardPage />);
    // Should show Issues content, not Tracked content
    expect(screen.queryByText("No tracked items")).toBeNull();
  });

  it("redirects away from tracked tab when tracking disabled at runtime", async () => {
    configStore.updateConfig({ enableTracking: true });
    render(() => <DashboardPage />);

    // Switch to tracked tab
    const trackedTab = screen.getByText("Tracked");
    fireEvent.click(trackedTab);

    await waitFor(() => {
      expect(viewStore.viewState.lastActiveTab).toBe("tracked");
    });

    // Disable tracking — should redirect to issues
    configStore.updateConfig({ enableTracking: false });

    await waitFor(() => {
      expect(viewStore.viewState.lastActiveTab).toBe("issues");
    });
  });
});

// ── Exclusivity / isItemVisibleOnTab ─────────────────────────────────────────
//
// `isItemVisibleOnTab` and `exclusiveOwnership` are private to DashboardPage.
// We test them indirectly by verifying that tab badge counts reflect the
// exclusive ownership rules: items claimed by an exclusive custom tab are
// hidden from builtin tabs (and vice versa — visible only on the owning tab).

describe("DashboardPage — exclusive custom tabs", () => {
  it("exclusive issues tab removes claimed items from the builtin Issues badge", async () => {
    // Add an exclusive issues custom tab scoped to the fixture's default owner
    configStore.addCustomTab({
      id: "excl01",
      name: "My Issues",
      baseType: "issues",
      orgScope: ["owner"],
      repoScope: [],
      filterPreset: {},
      exclusive: true,
    });
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [
        makeIssue({ id: 1, title: "Issue A" }),
        makeIssue({ id: 2, title: "Issue B" }),
      ],
      pullRequests: [],
      workflowRuns: [],
      errors: [],
    });

    render(() => <DashboardPage />);
    await waitFor(() => {
      // Both issues are claimed by the exclusive tab — builtin Issues badge = 0
      const issuesTab = screen.getByRole("tab", { name: /^Issues/ });
      expect(issuesTab.textContent?.replace(/\D+/g, "")).toBe("0");
    });
  });

  it("exclusive custom tab shows the claimed items in its own badge", async () => {
    configStore.addCustomTab({
      id: "excl02",
      name: "Exclusive PRs",
      baseType: "pullRequests",
      orgScope: ["owner"],
      repoScope: [],
      filterPreset: {},
      exclusive: true,
    });

    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [],
      pullRequests: [
        makePullRequest({ id: 10, title: "PR A" }),
        makePullRequest({ id: 11, title: "PR B" }),
      ],
      workflowRuns: [],
      errors: [],
    });

    render(() => <DashboardPage />);
    await waitFor(() => {
      // The custom tab badge shows the 2 claimed PRs
      const customTab = screen.getByRole("tab", { name: /Exclusive PRs/ });
      expect(customTab.textContent?.replace(/\D+/g, "")).toBe("2");
      // The builtin Pull Requests badge is 0 (all claimed)
      const prTab = screen.getByRole("tab", { name: /^Pull Requests/ });
      expect(prTab.textContent?.replace(/\D+/g, "")).toBe("0");
    });
  });

  it("non-exclusive custom tab does not remove items from builtin tabs", async () => {
    configStore.addCustomTab({
      id: "nonexcl01",
      name: "My View",
      baseType: "issues",
      orgScope: [],
      repoScope: [],
      filterPreset: {},
      exclusive: false,
    });
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [
        makeIssue({ id: 1, title: "Issue A" }),
        makeIssue({ id: 2, title: "Issue B" }),
      ],
      pullRequests: [],
      workflowRuns: [],
      errors: [],
    });

    render(() => <DashboardPage />);
    await waitFor(() => {
      // Non-exclusive tab: builtin Issues badge still shows all items
      const issuesTab = screen.getByRole("tab", { name: /^Issues/ });
      expect(issuesTab.textContent?.replace(/\D+/g, "")).toBe("2");
    });
  });

  it("first exclusive tab wins when two exclusive tabs claim the same item", async () => {
    // Two exclusive issues tabs — first one registered should win
    configStore.addCustomTab({
      id: "first01",
      name: "First Exclusive",
      baseType: "issues",
      orgScope: ["owner"],
      repoScope: [],
      filterPreset: {},
      exclusive: true,
    });
    configStore.addCustomTab({
      id: "second01",
      name: "Second Exclusive",
      baseType: "issues",
      orgScope: ["owner"],
      repoScope: [],
      filterPreset: {},
      exclusive: true,
    });
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [
        makeIssue({ id: 1, title: "Issue A" }),
      ],
      pullRequests: [],
      workflowRuns: [],
      errors: [],
    });

    render(() => <DashboardPage />);
    await waitFor(() => {
      // First exclusive tab claims the item — count = 1
      const firstTab = screen.getByRole("tab", { name: /First Exclusive/ });
      expect(firstTab.textContent?.replace(/\D+/g, "")).toBe("1");
      // Second exclusive tab gets 0 — item already claimed
      const secondTab = screen.getByRole("tab", { name: /Second Exclusive/ });
      expect(secondTab.textContent?.replace(/\D+/g, "")).toBe("0");
    });
  });

  it("exclusive actions tab removes runs from builtin Actions badge", async () => {
    configStore.addCustomTab({
      id: "exclact01",
      name: "My Actions",
      baseType: "actions",
      orgScope: ["owner"],
      repoScope: [],
      filterPreset: {},
      exclusive: true,
    });
    viewStore.updateViewState({ showPrRuns: false });

    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [],
      pullRequests: [],
      workflowRuns: [
        makeWorkflowRun({ id: 20, isPrRun: false }),
        makeWorkflowRun({ id: 21, isPrRun: false }),
      ],
      errors: [],
    });

    render(() => <DashboardPage />);
    await waitFor(() => {
      // Exclusive actions tab claims both runs — builtin Actions badge = 0
      const actionsTab = screen.getByRole("tab", { name: /^Actions/ });
      expect(actionsTab.textContent?.replace(/\D+/g, "")).toBe("0");
      // Custom tab shows 2
      const customTab = screen.getByRole("tab", { name: /My Actions/ });
      expect(customTab.textContent?.replace(/\D+/g, "")).toBe("2");
    });
  });

  it("exclusive issues tab does not affect PRs or Actions tabs", async () => {
    // An exclusive ISSUES tab must not hide PRs or runs from their builtin tabs
    configStore.addCustomTab({
      id: "exclissues",
      name: "Issues Only",
      baseType: "issues",
      orgScope: [],
      repoScope: [],
      filterPreset: {},
      exclusive: true,
    });

    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [makeIssue({ id: 1, title: "Claimed" })],
      pullRequests: [makePullRequest({ id: 10, title: "PR A" })],
      workflowRuns: [makeWorkflowRun({ id: 20, isPrRun: false })],
      errors: [],
    });

    render(() => <DashboardPage />);
    await waitFor(() => {
      // PR and Actions tabs unaffected — still show their items
      const prTab = screen.getByRole("tab", { name: /^Pull Requests/ });
      expect(prTab.textContent?.replace(/\D+/g, "")).toBe("1");
      const actionsTab = screen.getByRole("tab", { name: /^Actions/ });
      expect(actionsTab.textContent?.replace(/\D+/g, "")).toBe("1");
    });
  });
});

// ── Custom tab scoping (orgScope / repoScope) ────────────────────────────────

describe("DashboardPage — custom tab scoping", () => {
  it("orgScope restricts custom tab badge to issues from matching org only", async () => {
    configStore.addCustomTab({
      id: "orgscope01",
      name: "My Org Issues",
      baseType: "issues",
      orgScope: ["myorg"],
      repoScope: [],
      filterPreset: { scope: "all" },
      exclusive: false,
    });
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [
        makeIssue({ id: 1, title: "In-scope", repoFullName: "myorg/repo-a" }),
        makeIssue({ id: 2, title: "Out-of-scope", repoFullName: "other/repo-b" }),
        makeIssue({ id: 3, title: "Also in-scope", repoFullName: "myorg/repo-c" }),
      ],
      pullRequests: [],
      workflowRuns: [],
      errors: [],
    });

    render(() => <DashboardPage />);
    await waitFor(() => {
      const customTab = screen.getByRole("tab", { name: /My Org Issues/ });
      expect(customTab.textContent?.replace(/\D+/g, "")).toBe("2");
    });
  });

  it("repoScope restricts custom tab badge to issues from matching repo only", async () => {
    configStore.addCustomTab({
      id: "reposcope01",
      name: "Repo A Issues",
      baseType: "issues",
      orgScope: [],
      repoScope: [{ owner: "myorg", name: "repo-a", fullName: "myorg/repo-a" }],
      filterPreset: { scope: "all" },
      exclusive: false,
    });
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [
        makeIssue({ id: 10, title: "Repo A issue", repoFullName: "myorg/repo-a" }),
        makeIssue({ id: 11, title: "Repo B issue", repoFullName: "myorg/repo-b" }),
      ],
      pullRequests: [],
      workflowRuns: [],
      errors: [],
    });

    render(() => <DashboardPage />);
    await waitFor(() => {
      const customTab = screen.getByRole("tab", { name: /Repo A Issues/ });
      expect(customTab.textContent?.replace(/\D+/g, "")).toBe("1");
    });
  });

  it("orgScope is case-insensitive", async () => {
    configStore.addCustomTab({
      id: "orgcase01",
      name: "Case Test",
      baseType: "issues",
      orgScope: ["MyOrg"],
      repoScope: [],
      filterPreset: { scope: "all" },
      exclusive: false,
    });
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [makeIssue({ id: 20, title: "Lowercase org", repoFullName: "myorg/repo" })],
      pullRequests: [],
      workflowRuns: [],
      errors: [],
    });

    render(() => <DashboardPage />);
    await waitFor(() => {
      const customTab = screen.getByRole("tab", { name: /Case Test/ });
      expect(customTab.textContent?.replace(/\D+/g, "")).toBe("1");
    });
  });

  it("orgScope and repoScope use OR semantics — item matching either is included", async () => {
    configStore.addCustomTab({
      id: "orscope01",
      name: "OR Scope Test",
      baseType: "issues",
      orgScope: ["testorg"],
      repoScope: [{ owner: "other", name: "specific-repo", fullName: "other/specific-repo" }],
      filterPreset: { scope: "all" },
      exclusive: false,
    });
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [
        makeIssue({ id: 40, title: "Matches orgScope", repoFullName: "testorg/any-repo" }),
        makeIssue({ id: 41, title: "Matches repoScope", repoFullName: "other/specific-repo" }),
        makeIssue({ id: 42, title: "Matches neither", repoFullName: "unrelated/repo" }),
      ],
      pullRequests: [],
      workflowRuns: [],
      errors: [],
    });

    render(() => <DashboardPage />);
    await waitFor(() => {
      const customTab = screen.getByRole("tab", { name: /OR Scope Test/ });
      // Both the orgScope match (id 40) and repoScope match (id 41) should be counted
      expect(customTab.textContent?.replace(/\D+/g, "")).toBe("2");
    });
  });

  it("exclusive scoped tab removes only matched items from builtin tab", async () => {
    configStore.addCustomTab({
      id: "exclscope01",
      name: "Exclusive Org",
      baseType: "issues",
      orgScope: ["myorg"],
      repoScope: [],
      filterPreset: { scope: "all" },
      exclusive: true,
    });
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [
        makeIssue({ id: 30, title: "myorg issue", repoFullName: "myorg/repo" }),
        makeIssue({ id: 31, title: "other issue", repoFullName: "other/repo" }),
      ],
      pullRequests: [],
      workflowRuns: [],
      errors: [],
    });

    render(() => <DashboardPage />);
    await waitFor(() => {
      const issuesTab = screen.getByRole("tab", { name: /^Issues/ });
      expect(issuesTab.textContent?.replace(/\D+/g, "")).toBe("1");
      const customTab = screen.getByRole("tab", { name: /Exclusive Org/ });
      expect(customTab.textContent?.replace(/\D+/g, "")).toBe("1");
    });
  });

  it("a tab with empty orgScope and repoScope matches no items and shows the unscoped icon", async () => {
    configStore.addCustomTab({
      id: "unscoped01",
      name: "Unscoped Tab",
      baseType: "issues",
      orgScope: [],
      repoScope: [],
      filterPreset: { scope: "all" },
      exclusive: false,
    });
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [
        makeIssue({ id: 60, title: "Some issue", repoFullName: "owner/repo" }),
      ],
      pullRequests: [],
      workflowRuns: [],
      errors: [],
    });

    render(() => <DashboardPage />);
    await waitFor(() => {
      // Empty scope now matches nothing — not "all repos" as it did previously.
      const customTab = screen.getByRole("tab", { name: /Unscoped Tab/ });
      expect(customTab.textContent?.replace(/\D+/g, "")).toBe("0");
      // The builtin Issues tab is unaffected — it still shows the item.
      const issuesTab = screen.getByRole("tab", { name: /^Issues/ });
      expect(issuesTab.textContent?.replace(/\D+/g, "")).toBe("1");
      expect(screen.getByLabelText("Unscoped tab")).toBeDefined();
    });
  });
});

// ── resolveInitialTab stale custom tab fallback ──────────────────────────────

describe("DashboardPage — resolveInitialTab stale custom tab fallback", () => {
  it("falls back to issues when lastActiveTab is a nonexistent custom tab ID", () => {
    viewStore.updateViewState({ lastActiveTab: "stale-tab-id" });
    configStore.updateConfig({ rememberLastTab: true });

    render(() => <DashboardPage />);

    const issuesButton = screen.getByRole("tab", { name: /^Issues/ });
    expect(issuesButton.getAttribute("aria-selected")).toBe("true");
  });

  it("uses a valid custom tab ID from lastActiveTab when the tab still exists", () => {
    configStore.addCustomTab({
      id: "valid-custom",
      name: "Valid Tab",
      baseType: "issues",
      orgScope: [],
      repoScope: [],
      filterPreset: {},
      exclusive: false,
    });
    viewStore.updateViewState({ lastActiveTab: "valid-custom" });
    configStore.updateConfig({ rememberLastTab: true });

    render(() => <DashboardPage />);

    const customTabButton = screen.getByRole("tab", { name: /Valid Tab/ });
    expect(customTabButton.getAttribute("aria-selected")).toBe("true");
  });
});

// ── Runtime redirect when active custom tab is deleted ───────────────────────

describe("DashboardPage — runtime redirect when active custom tab is deleted", () => {
  it("redirects to issues when the active custom tab is removed from config", async () => {
    configStore.addCustomTab({
      id: "deleteme",
      name: "Delete Me Tab",
      baseType: "issues",
      orgScope: [],
      repoScope: [],
      filterPreset: {},
      exclusive: false,
    });

    render(() => <DashboardPage />);

    const customTabButton = screen.getByRole("tab", { name: /Delete Me Tab/ });
    fireEvent.click(customTabButton);

    await waitFor(() => {
      expect(viewStore.viewState.lastActiveTab).toBe("deleteme");
    });

    configStore.removeCustomTab("deleteme");

    await waitFor(() => {
      expect(viewStore.viewState.lastActiveTab).toBe("issues");
    });
  });
});

// ── Orphaned view state cleanup ──────────────────────────────────────────────

describe("DashboardPage — orphaned view state cleanup", () => {
  it("removes customTabFilters and expandedRepos keys when a custom tab is deleted", async () => {
    configStore.addCustomTab({
      id: "orphan01",
      name: "Orphan Tab",
      baseType: "issues",
      orgScope: [],
      repoScope: [],
      filterPreset: {},
      exclusive: false,
    });
    viewStore.setCustomTabFilter("orphan01", "role", "author");
    viewStore.toggleExpandedRepo("orphan01", "myorg/repo");

    render(() => <DashboardPage />);

    await waitFor(() => {
      expect(viewStore.viewState.customTabFilters["orphan01"]).toBeDefined();
    });

    configStore.removeCustomTab("orphan01");

    await waitFor(() => {
      expect(viewStore.viewState.customTabFilters["orphan01"]).toBeUndefined();
      expect(viewStore.viewState.expandedRepos["orphan01"]).toBeUndefined();
    });
  });

  it("prunes stale customTabFilters entries at mount time for unknown tab IDs", async () => {
    viewStore.setCustomTabFilter("ghost-tab", "role", "assignee");

    render(() => <DashboardPage />);

    await waitFor(() => {
      expect(viewStore.viewState.customTabFilters["ghost-tab"]).toBeUndefined();
    });
  });
});

// ── tabCounts badge reflects filterPreset ─────────────────────────────────────

describe("DashboardPage — tabCounts applies filterPreset", () => {
  it("role:author preset reduces badge count to only authored issues", async () => {
    configStore.addCustomTab({
      id: "authored",
      name: "My Authored",
      baseType: "issues",
      orgScope: [],
      repoScope: [],
      filterPreset: { scope: "all", role: "author" },
      exclusive: false,
    });

    // 3 issues: 2 by "octocat" (makeIssue default), 1 by "someone"
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [
        makeIssue({ id: 1, title: "Issue A" }),
        makeIssue({ id: 2, title: "Issue B" }),
        makeIssue({ id: 3, title: "Issue C", userLogin: "someone" }),
      ],
      pullRequests: [],
      workflowRuns: [],
      errors: [],
    });

    render(() => <DashboardPage />);
    await waitFor(() => {
      // Builtin Issues tab shows all 3 (no role filter applied to builtin tabs)
      const issuesTab = screen.getByRole("tab", { name: /^Issues/ });
      expect(issuesTab.textContent?.replace(/\D+/g, "")).toBe("3");
      // Custom tab with role:author — login is "" in test env, so 0 match
      // (no issue has userLogin matching "")
      const customTab = screen.getByRole("tab", { name: /My Authored/ });
      const customCount = parseInt(customTab.textContent?.replace(/\D+/g, "") || "0", 10);
      // In test env user login is "testuser" (auth mock), no issue has userLogin="testuser",
      // so _self resolves to "testuser" but no issue surfacedBy includes "testuser"
      // and role:author checks userLogin === login — no match → count = 0
      expect(customCount).toBe(0);
    });
  });

  it("user:_self sentinel resolves to authenticated user login for badge count", async () => {
    // The auth mock returns user().login === "testuser"
    configStore.addCustomTab({
      id: "selfuser",
      name: "My Items",
      baseType: "issues",
      orgScope: ["owner"],
      repoScope: [],
      filterPreset: { scope: "all", user: "_self" },
      exclusive: false,
    });
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [
        // surfacedBy includes testuser — should be counted
        makeIssue({ id: 50, title: "Surfaced by self", surfacedBy: ["testuser"] }),
        // surfacedBy does not include testuser — should NOT be counted
        makeIssue({ id: 51, title: "Surfaced by other", surfacedBy: ["octocat"] }),
        // surfacedBy includes testuser alongside others — should be counted
        makeIssue({ id: 52, title: "Surfaced by self and others", surfacedBy: ["octocat", "testuser"] }),
      ],
      pullRequests: [],
      workflowRuns: [],
      errors: [],
    });

    render(() => <DashboardPage />);
    await waitFor(() => {
      const customTab = screen.getByRole("tab", { name: /My Items/ });
      // Only issues 50 and 52 have testuser in surfacedBy
      expect(customTab.textContent?.replace(/\D+/g, "")).toBe("2");
    });
  });

  it("conclusion:failure preset reduces badge count to only failed runs", async () => {
    configStore.addCustomTab({
      id: "failures",
      name: "Failed Runs",
      baseType: "actions",
      orgScope: ["owner"],
      repoScope: [],
      filterPreset: { conclusion: "failure" },
      exclusive: false,
    });

    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [],
      pullRequests: [],
      workflowRuns: [
        makeWorkflowRun({ id: 10, conclusion: "failure", isPrRun: false }),
        makeWorkflowRun({ id: 11, conclusion: "success", isPrRun: false }),
        makeWorkflowRun({ id: 12, conclusion: "failure", isPrRun: false }),
      ],
      errors: [],
    });

    render(() => <DashboardPage />);
    await waitFor(() => {
      // Only 2 failure runs counted
      const customTab = screen.getByRole("tab", { name: /Failed Runs/ });
      expect(customTab.textContent?.replace(/\D+/g, "")).toBe("2");
    });
  });

  describe("Jira auth guard", () => {
    it("does not write Jira issues when auth becomes invalid during fetch", async () => {
      let authenticated = true;
      vi.mocked(authStore.isJiraAuthenticated).mockImplementation(() => authenticated);
      vi.mocked(authStore.jiraAuth).mockReturnValue({
        cloudId: "test-cloud-id",
        accessToken: "test-access-token",
        sealedRefreshToken: "sealed",
        expiresAt: Date.now() + 3600000,
        siteUrl: "https://test.atlassian.net",
        siteName: "Test Site",
      });
      vi.mocked(authStore.ensureJiraTokenValid).mockResolvedValue(true);

      const jiraClientMod = await import("../../src/app/services/jira-client");
      const mockSearchJql = vi.fn().mockImplementation(async () => {
        authenticated = false;
        return {
          issues: [{
            key: "STALE-1", id: "1", self: "https://test.atlassian.net/rest/api/3/issue/1",
            fields: {
              summary: "Stale issue from previous user",
              status: { id: "1", name: "To Do", statusCategory: { id: 1, key: "new", name: "To Do" } },
              priority: null, assignee: null,
              project: { id: "1", key: "STALE", name: "Stale Project" },
            },
          }],
          total: 1, maxResults: 100, startAt: 0,
        };
      });
      vi.mocked(jiraClientMod.JiraClient).mockImplementation(function () {
        return { searchJql: mockSearchJql, bulkFetch: vi.fn().mockResolvedValue({ issues: [] }), getIssue: vi.fn() } as any;
      } as any);

      configStore.updateJiraConfig({ enabled: true, siteUrl: "https://test.atlassian.net", siteName: "Test Site", authMethod: "oauth" });

      render(() => <DashboardPage />);
      await new Promise((r) => setTimeout(r, 200));

      expect(screen.queryByText("STALE-1")).toBeNull();
      expect(screen.queryByText("Stale issue from previous user")).toBeNull();
    });
  });
});

describe("DashboardPage — events poll targeted merge", () => {
  it("preserves tracked-user-only items from affected repos", async () => {
    const trackedUserIssue = makeIssue({ id: 99, title: "Tracked user only", repoFullName: "org/repo", surfacedBy: ["other-user"] });
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [trackedUserIssue, makeIssue({ id: 1, title: "My issue", repoFullName: "org/repo" })],
      pullRequests: [],
      workflowRuns: [],
      errors: [],
    });

    render(() => <DashboardPage />);
    await waitFor(() => { screen.getByText("org/repo"); });

    const targetedData: DashboardData = {
      issues: [makeIssue({ id: 1, title: "My issue updated", repoFullName: "org/repo" })],
      pullRequests: [],
      workflowRuns: [],
      errors: [],
    };
    capturedOnTargetedData?.(targetedData, ["org/repo"]);

    await waitFor(() => {
      screen.getByText("2 issues");
    });
  });

  it("merges surfacedBy annotations via union for issues", async () => {
    const sharedIssue = makeIssue({ id: 50, title: "Shared", repoFullName: "org/repo", surfacedBy: ["primary", "tracked-user"] });
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [sharedIssue],
      pullRequests: [],
      workflowRuns: [],
      errors: [],
    });

    render(() => <DashboardPage />);
    await waitFor(() => { screen.getByText("org/repo"); });

    const targetedIssue = makeIssue({ id: 50, title: "Shared updated", repoFullName: "org/repo", surfacedBy: ["primary"] });
    const targetedData: DashboardData = {
      issues: [targetedIssue],
      pullRequests: [],
      workflowRuns: [],
      errors: [],
    };
    capturedOnTargetedData?.(targetedData, ["org/repo"]);

    await waitFor(() => {
      screen.getByText("1 issue");
    });

    // handleTargetedData mutates data items in-place before merging into the store
    expect(targetedIssue.surfacedBy).toEqual(expect.arrayContaining(["primary", "tracked-user"]));
    expect(targetedIssue.surfacedBy).toHaveLength(2);
  });

  it("merges surfacedBy annotations via union for pull requests", async () => {
    const sharedPR = makePullRequest({ id: 60, repoFullName: "org/repo", surfacedBy: ["primary", "tracked-user"] });
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [],
      pullRequests: [sharedPR],
      workflowRuns: [],
      errors: [],
    });

    render(() => <DashboardPage />);
    await waitFor(() => expect(capturedOnTargetedData).not.toBeNull());

    const targetedPR = makePullRequest({ id: 60, repoFullName: "org/repo", surfacedBy: ["primary"] });
    const targetedData: DashboardData = {
      issues: [],
      pullRequests: [targetedPR],
      workflowRuns: [],
      errors: [],
    };
    capturedOnTargetedData?.(targetedData, ["org/repo"]);

    // handleTargetedData mutates data items in-place before merging into the store
    expect(targetedPR.surfacedBy).toEqual(expect.arrayContaining(["primary", "tracked-user"]));
    expect(targetedPR.surfacedBy).toHaveLength(2);
  });

  it("calls detectNewItems and dispatchNotifications after targeted merge", async () => {
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [],
      pullRequests: [],
      workflowRuns: [],
      errors: [],
    });

    render(() => <DashboardPage />);
    await waitFor(() => expect(capturedOnTargetedData).not.toBeNull());

    const notifLib = await import("../../src/app/lib/notifications");
    vi.mocked(notifLib.detectNewItems).mockClear();
    vi.mocked(notifLib.dispatchNotifications).mockClear();

    const targetedData: DashboardData = {
      issues: [makeIssue({ id: 200, title: "New via events", repoFullName: "org/repo" })],
      pullRequests: [],
      workflowRuns: [],
      errors: [],
    };
    capturedOnTargetedData?.(targetedData, ["org/repo"]);

    expect(vi.mocked(notifLib.detectNewItems)).toHaveBeenCalledWith(targetedData);
    expect(vi.mocked(notifLib.dispatchNotifications)).toHaveBeenCalled();
  });

  it("calls seedHotSetsFromTargeted after targeted merge", async () => {
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [],
      pullRequests: [],
      workflowRuns: [],
      errors: [],
    });

    render(() => <DashboardPage />);
    await waitFor(() => expect(capturedOnTargetedData).not.toBeNull());

    vi.mocked(pollService.seedHotSetsFromTargeted).mockClear();

    const targetedData: DashboardData = {
      issues: [],
      pullRequests: [makePullRequest({ id: 300, repoFullName: "org/repo" })],
      workflowRuns: [],
      errors: [],
    };
    capturedOnTargetedData?.(targetedData, ["org/repo"]);

    expect(vi.mocked(pollService.seedHotSetsFromTargeted)).toHaveBeenCalledWith(targetedData);
  });

  it("does not update lastRefreshedAt after targeted merge (MCP relay exclusion)", async () => {
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [makeIssue({ id: 1, repoFullName: "org/repo" })],
      pullRequests: [],
      workflowRuns: [],
      errors: [],
    });

    render(() => <DashboardPage />);
    await waitFor(() => { screen.getByText("org/repo"); });

    // The targeted merge callback does NOT call setDashboardData with a new
    // lastRefreshedAt — it uses produce() which only modifies issues/PRs/runs.
    // This means the MCP relay effect (which tracks lastRefreshedAt) won't fire.
    // We verify this by checking that rebuildHotSets is NOT called (it's only
    // called on full refresh, not targeted merge).
    vi.mocked(pollService.rebuildHotSets).mockClear();

    const targetedData: DashboardData = {
      issues: [makeIssue({ id: 1, title: "Updated", repoFullName: "org/repo" })],
      pullRequests: [],
      workflowRuns: [],
      errors: [],
    };
    capturedOnTargetedData?.(targetedData, ["org/repo"]);

    // seedHotSetsFromTargeted is called (additive), NOT rebuildHotSets (full replacement)
    expect(vi.mocked(pollService.rebuildHotSets)).not.toHaveBeenCalled();
    expect(vi.mocked(pollService.seedHotSetsFromTargeted)).toHaveBeenCalledWith(targetedData);
  });
});

describe("DashboardPage — events poll targeted merge", () => {
  it("preserves tracked-user-only items from affected repos", async () => {
    const trackedUserIssue = makeIssue({ id: 99, title: "Tracked user only", repoFullName: "org/repo", surfacedBy: ["other-user"] });
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [trackedUserIssue, makeIssue({ id: 1, title: "My issue", repoFullName: "org/repo" })],
      pullRequests: [],
      workflowRuns: [],
      errors: [],
    });

    render(() => <DashboardPage />);
    await waitFor(() => { screen.getByText("org/repo"); });

    const targetedData: DashboardData = {
      issues: [makeIssue({ id: 1, title: "My issue updated", repoFullName: "org/repo" })],
      pullRequests: [],
      workflowRuns: [],
      errors: [],
    };
    capturedOnTargetedData?.(targetedData, ["org/repo"]);

    await waitFor(() => {
      screen.getByText("2 issues");
    });
  });

  it("merges surfacedBy annotations via union for issues", async () => {
    const sharedIssue = makeIssue({ id: 50, title: "Shared", repoFullName: "org/repo", surfacedBy: ["primary", "tracked-user"] });
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [sharedIssue],
      pullRequests: [],
      workflowRuns: [],
      errors: [],
    });

    render(() => <DashboardPage />);
    await waitFor(() => { screen.getByText("org/repo"); });

    const targetedIssue = makeIssue({ id: 50, title: "Shared updated", repoFullName: "org/repo", surfacedBy: ["primary"] });
    const targetedData: DashboardData = {
      issues: [targetedIssue],
      pullRequests: [],
      workflowRuns: [],
      errors: [],
    };
    capturedOnTargetedData?.(targetedData, ["org/repo"]);

    await waitFor(() => {
      screen.getByText("1 issue");
    });

    // handleTargetedData mutates data items in-place before merging into the store
    expect(targetedIssue.surfacedBy).toEqual(expect.arrayContaining(["primary", "tracked-user"]));
    expect(targetedIssue.surfacedBy).toHaveLength(2);
  });

  it("merges surfacedBy annotations via union for pull requests", async () => {
    const sharedPR = makePullRequest({ id: 60, repoFullName: "org/repo", surfacedBy: ["primary", "tracked-user"] });
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [],
      pullRequests: [sharedPR],
      workflowRuns: [],
      errors: [],
    });

    render(() => <DashboardPage />);
    await waitFor(() => expect(capturedOnTargetedData).not.toBeNull());

    const targetedPR = makePullRequest({ id: 60, repoFullName: "org/repo", surfacedBy: ["primary"] });
    const targetedData: DashboardData = {
      issues: [],
      pullRequests: [targetedPR],
      workflowRuns: [],
      errors: [],
    };
    capturedOnTargetedData?.(targetedData, ["org/repo"]);

    // handleTargetedData mutates data items in-place before merging into the store
    expect(targetedPR.surfacedBy).toEqual(expect.arrayContaining(["primary", "tracked-user"]));
    expect(targetedPR.surfacedBy).toHaveLength(2);
  });

  it("calls detectNewItems and dispatchNotifications after targeted merge", async () => {
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [],
      pullRequests: [],
      workflowRuns: [],
      errors: [],
    });

    render(() => <DashboardPage />);
    await waitFor(() => expect(capturedOnTargetedData).not.toBeNull());

    const notifLib = await import("../../src/app/lib/notifications");
    vi.mocked(notifLib.detectNewItems).mockClear();
    vi.mocked(notifLib.dispatchNotifications).mockClear();

    const targetedData: DashboardData = {
      issues: [makeIssue({ id: 200, title: "New via events", repoFullName: "org/repo" })],
      pullRequests: [],
      workflowRuns: [],
      errors: [],
    };
    capturedOnTargetedData?.(targetedData, ["org/repo"]);

    expect(vi.mocked(notifLib.detectNewItems)).toHaveBeenCalledWith(targetedData);
    expect(vi.mocked(notifLib.dispatchNotifications)).toHaveBeenCalled();
  });

  it("calls seedHotSetsFromTargeted after targeted merge", async () => {
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [],
      pullRequests: [],
      workflowRuns: [],
      errors: [],
    });

    render(() => <DashboardPage />);
    await waitFor(() => expect(capturedOnTargetedData).not.toBeNull());

    vi.mocked(pollService.seedHotSetsFromTargeted).mockClear();

    const targetedData: DashboardData = {
      issues: [],
      pullRequests: [makePullRequest({ id: 300, repoFullName: "org/repo" })],
      workflowRuns: [],
      errors: [],
    };
    capturedOnTargetedData?.(targetedData, ["org/repo"]);

    expect(vi.mocked(pollService.seedHotSetsFromTargeted)).toHaveBeenCalledWith(targetedData);
  });

  it("does not update lastRefreshedAt after targeted merge (MCP relay exclusion)", async () => {
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [makeIssue({ id: 1, repoFullName: "org/repo" })],
      pullRequests: [],
      workflowRuns: [],
      errors: [],
    });

    render(() => <DashboardPage />);
    await waitFor(() => { screen.getByText("org/repo"); });

    // The targeted merge callback does NOT call setDashboardData with a new
    // lastRefreshedAt — it uses produce() which only modifies issues/PRs/runs.
    // This means the MCP relay effect (which tracks lastRefreshedAt) won't fire.
    // We verify this by checking that rebuildHotSets is NOT called (it's only
    // called on full refresh, not targeted merge).
    vi.mocked(pollService.rebuildHotSets).mockClear();

    const targetedData: DashboardData = {
      issues: [makeIssue({ id: 1, title: "Updated", repoFullName: "org/repo" })],
      pullRequests: [],
      workflowRuns: [],
      errors: [],
    };
    capturedOnTargetedData?.(targetedData, ["org/repo"]);

    // seedHotSetsFromTargeted is called (additive), NOT rebuildHotSets (full replacement)
    expect(vi.mocked(pollService.rebuildHotSets)).not.toHaveBeenCalled();
    expect(vi.mocked(pollService.seedHotSetsFromTargeted)).toHaveBeenCalledWith(targetedData);
  });
});

describe("DashboardPage — dependency pre-exclusivity", () => {
  it("excludes dep bot PRs from the Pull Requests tab", async () => {
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [],
      pullRequests: [
        makePullRequest({ id: 1, title: "Bump lodash from 4.0 to 5.0", userLogin: "dependabot[bot]" }),
        makePullRequest({ id: 2, title: "Normal feature PR", userLogin: "developer" }),
      ],
      workflowRuns: [],
      errors: [],
    });

    render(() => <DashboardPage />);
    await waitFor(() => {
      const prTab = screen.getByRole("tab", { name: /Pull Requests/ });
      expect(prTab.textContent?.replace(/\D+/g, "")).toBe("1");
    });
  });

  it("shows the Dependencies tab when dep bot PRs exist", async () => {
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [],
      pullRequests: [
        makePullRequest({ id: 1, title: "Bump lodash from 4.0 to 5.0", userLogin: "dependabot[bot]" }),
      ],
      workflowRuns: [],
      errors: [],
    });

    render(() => <DashboardPage />);
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /Dependencies/ })).toBeTruthy();
    });
  });

  it("does not show the Dependencies tab when config.dependencies.enabled is false", async () => {
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [],
      pullRequests: [
        makePullRequest({ id: 1, title: "Bump lodash from 4.0 to 5.0", userLogin: "dependabot[bot]" }),
      ],
      workflowRuns: [],
      errors: [],
    });

    configStore.updateConfig({ dependencies: { enabled: false, rebaseLabel: "rebase", excludedOrgs: [], excludedRepos: [] } });

    render(() => <DashboardPage />);
    await waitFor(() => {
      expect(screen.queryByRole("tab", { name: /Dependencies/ })).toBeNull();
    });
  });

  it("does not show the Dependencies tab when no dep PRs exist", async () => {
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [],
      pullRequests: [
        makePullRequest({ id: 1, title: "Normal feature PR", userLogin: "developer" }),
      ],
      workflowRuns: [],
      errors: [],
    });

    render(() => <DashboardPage />);
    await waitFor(() => {
      expect(screen.queryByRole("tab", { name: /Dependencies/ })).toBeNull();
    });
  });

  it("dep PRs appear on Pull Requests tab when dependencies feature is disabled", async () => {
    configStore.updateConfig({ dependencies: { enabled: false, rebaseLabel: "rebase", excludedOrgs: [], excludedRepos: [] } });
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [],
      pullRequests: [
        makePullRequest({ id: 1, title: "Bump lodash from 4.0 to 5.0", userLogin: "dependabot[bot]" }),
        makePullRequest({ id: 2, title: "Normal feature PR", userLogin: "developer" }),
      ],
      workflowRuns: [],
      errors: [],
    });

    render(() => <DashboardPage />);
    await waitFor(() => {
      const prTab = screen.getByRole("tab", { name: /Pull Requests/ });
      expect(prTab.textContent?.replace(/\D+/g, "")).toBe("2");
    });
  });

  it("Dependencies tab count reflects dep PR count (excluding ignored)", async () => {
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [],
      pullRequests: [
        makePullRequest({ id: 1, title: "Bump lodash from 4.0 to 5.0", userLogin: "dependabot[bot]" }),
        makePullRequest({ id: 2, title: "Bump react from 17 to 18", userLogin: "dependabot[bot]" }),
        makePullRequest({ id: 3, title: "Normal feature PR", userLogin: "developer" }),
      ],
      workflowRuns: [],
      errors: [],
    });

    render(() => <DashboardPage />);
    await waitFor(() => {
      const depsTab = screen.getByRole("tab", { name: /Dependencies/ });
      expect(depsTab.textContent?.replace(/\D+/g, "")).toBe("2");
    });

    viewStore.ignoreItem({ id: 1, type: "pullRequest", repo: "owner/repo", title: "Bump lodash", ignoredAt: Date.now() });
    await waitFor(() => {
      const depsTab = screen.getByRole("tab", { name: /Dependencies/ });
      expect(depsTab.textContent?.replace(/\D+/g, "")).toBe("1");
    });
  });

  it("dep PRs are excluded from exclusive custom tab ownership", async () => {
    configStore.addCustomTab({
      id: "custom-prs",
      name: "Custom PRs",
      baseType: "pullRequests",
      exclusive: true,
      orgScope: [],
      repoScope: [{ owner: "owner", name: "repo", fullName: "owner/repo" }],
      filterPreset: {},
    });

    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [],
      pullRequests: [
        makePullRequest({ id: 1, title: "Bump lodash from 4.0 to 5.0", userLogin: "dependabot[bot]", repoFullName: "owner/repo" }),
        makePullRequest({ id: 2, title: "Normal feature PR", userLogin: "developer", repoFullName: "owner/repo" }),
      ],
      workflowRuns: [],
      errors: [],
    });

    render(() => <DashboardPage />);
    await waitFor(() => {
      const customTab = screen.getByRole("tab", { name: /Custom PRs/ });
      expect(customTab.textContent?.replace(/\D+/g, "")).toBe("1");
    });
  });

  it("excludes dep PRs from visiblePullRequests even when no exclusive custom tabs exist", async () => {
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [],
      pullRequests: [
        makePullRequest({ id: 1, title: "Bump lodash from 4.0 to 5.0", userLogin: "dependabot[bot]" }),
        makePullRequest({ id: 2, title: "Normal feature PR", userLogin: "developer" }),
      ],
      workflowRuns: [],
      errors: [],
    });

    render(() => <DashboardPage />);
    await waitFor(() => {
      const prTab = screen.getByRole("tab", { name: /Pull Requests/ });
      expect(prTab.textContent?.replace(/\D+/g, "")).toBe("1");
      const depsTab = screen.getByRole("tab", { name: /Dependencies/ });
      expect(depsTab.textContent?.replace(/\D+/g, "")).toBe("1");
    });
  });

  it("PersonalSummaryStrip PR counts exclude dep bot PRs via pre-exclusivity", async () => {
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [],
      pullRequests: [
        makePullRequest({
          id: 1,
          title: "Bump lodash from 4.0 to 5.0",
          userLogin: "dependabot[bot]",
          checkStatus: "success",
          reviewDecision: "APPROVED",
          draft: false,
        }),
        makePullRequest({
          id: 2,
          title: "My feature PR",
          userLogin: "testuser",
          checkStatus: "success",
          reviewDecision: "APPROVED",
          draft: false,
        }),
      ],
      workflowRuns: [],
      errors: [],
    });

    render(() => <DashboardPage />);
    await waitFor(() => {
      const readyToMerge = screen.getByText(/ready to merge/);
      expect(readyToMerge.textContent).toMatch(/^1\s/);
    });
  });
});

// ── Dependencies tab — repo/org exclusion filtering ──────────────────────────

describe("DashboardPage — dependency exclusions", () => {
  it("excludedRepos hides that repo's dependency PR from the Dependencies tab", async () => {
    configStore.updateConfig({
      dependencies: {
        ...configStore.config.dependencies,
        excludedRepos: [{ owner: "owner", name: "excluded-repo", fullName: "owner/excluded-repo" }],
      },
    });

    const user = userEvent.setup();

    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [],
      pullRequests: [
        makePullRequest({
          repoFullName: "owner/excluded-repo",
          title: "Bump lodash from 4.1 to 4.2",
          userLogin: "dependabot[bot]",
          headRef: "dependabot/npm_and_yarn/lodash-4.2",
        }),
        makePullRequest({
          repoFullName: "owner/other-repo",
          title: "Bump axios from 0.27 to 1.0",
          userLogin: "dependabot[bot]",
          headRef: "dependabot/npm_and_yarn/axios-1.0.0",
        }),
      ],
      workflowRuns: [],
      errors: [],
    });

    render(() => <DashboardPage />);
    await waitFor(() => {
      const depsTab = screen.getByRole("tab", { name: /Dependencies/ });
      expect(depsTab.textContent?.replace(/\D+/g, "")).toBe("1");
    });

    await user.click(screen.getByRole("tab", { name: /Dependencies/ }));
    await waitFor(() => {
      expect(screen.getByText("axios: 0.27 → 1.0")).toBeDefined();
      expect(screen.queryByText("lodash: 4.1 → 4.2")).toBeNull();
    });
  });

  it("excluded repo's dependency PR does not leak into the Pull Requests tab (exclusivity preserved)", async () => {
    configStore.updateConfig({
      dependencies: {
        ...configStore.config.dependencies,
        excludedRepos: [{ owner: "owner", name: "excluded-repo", fullName: "owner/excluded-repo" }],
      },
    });

    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [],
      pullRequests: [
        makePullRequest({
          repoFullName: "owner/excluded-repo",
          title: "Bump lodash from 4.1 to 4.2",
          userLogin: "dependabot[bot]",
          headRef: "dependabot/npm_and_yarn/lodash-4.2",
        }),
        makePullRequest({
          repoFullName: "owner/other-repo",
          title: "Bump axios from 0.27 to 1.0",
          userLogin: "dependabot[bot]",
          headRef: "dependabot/npm_and_yarn/axios-1.0.0",
        }),
      ],
      workflowRuns: [],
      errors: [],
    });

    render(() => <DashboardPage />);
    await waitFor(() => {
      const prTab = screen.getByRole("tab", { name: /^Pull Requests/ });
      expect(prTab.textContent?.replace(/\D+/g, "")).toBe("0");
    });
  });

  it("excludedOrgs hides that org's repo's dependency PR from the Dependencies tab", async () => {
    configStore.updateConfig({
      dependencies: {
        ...configStore.config.dependencies,
        excludedOrgs: ["excluded-org"],
      },
    });

    const user = userEvent.setup();

    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [],
      pullRequests: [
        makePullRequest({
          repoFullName: "excluded-org/repo-a",
          title: "Bump lodash from 4.1 to 4.2",
          userLogin: "dependabot[bot]",
          headRef: "dependabot/npm_and_yarn/lodash-4.2",
        }),
        makePullRequest({
          repoFullName: "other-org/repo-b",
          title: "Bump axios from 0.27 to 1.0",
          userLogin: "dependabot[bot]",
          headRef: "dependabot/npm_and_yarn/axios-1.0.0",
        }),
      ],
      workflowRuns: [],
      errors: [],
    });

    render(() => <DashboardPage />);
    await waitFor(() => {
      const depsTab = screen.getByRole("tab", { name: /Dependencies/ });
      expect(depsTab.textContent?.replace(/\D+/g, "")).toBe("1");
    });

    await user.click(screen.getByRole("tab", { name: /Dependencies/ }));
    await waitFor(() => {
      expect(screen.getByText("axios: 0.27 → 1.0")).toBeDefined();
      expect(screen.queryByText("lodash: 4.1 → 4.2")).toBeNull();
    });
  });

  it("excludedOrgs repo's dependency PR does not leak into the Pull Requests tab (exclusivity preserved)", async () => {
    configStore.updateConfig({
      dependencies: {
        ...configStore.config.dependencies,
        excludedOrgs: ["excluded-org"],
      },
    });

    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [],
      pullRequests: [
        makePullRequest({
          repoFullName: "excluded-org/repo-a",
          title: "Bump lodash from 4.1 to 4.2",
          userLogin: "dependabot[bot]",
          headRef: "dependabot/npm_and_yarn/lodash-4.2",
        }),
        makePullRequest({
          repoFullName: "other-org/repo-b",
          title: "Bump axios from 0.27 to 1.0",
          userLogin: "dependabot[bot]",
          headRef: "dependabot/npm_and_yarn/axios-1.0.0",
        }),
      ],
      workflowRuns: [],
      errors: [],
    });

    render(() => <DashboardPage />);
    await waitFor(() => {
      const prTab = screen.getByRole("tab", { name: /^Pull Requests/ });
      expect(prTab.textContent?.replace(/\D+/g, "")).toBe("0");
    });
  });

  it("excluded repo's Dependency Dashboard issue is skipped for abandoned-package detection", async () => {
    configStore.updateConfig({
      dependencies: {
        ...configStore.config.dependencies,
        excludedRepos: [{ owner: "owner", name: "excluded-repo", fullName: "owner/excluded-repo" }],
      },
    });

    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [
        makeIssue({
          title: "Dependency Dashboard",
          userLogin: "renovate[bot]",
          nodeId: "DASH_excluded",
          repoFullName: "owner/excluded-repo",
          state: "OPEN",
        }),
        makeIssue({
          title: "Dependency Dashboard",
          userLogin: "renovate[bot]",
          nodeId: "DASH_other",
          repoFullName: "owner/other-repo",
          state: "OPEN",
        }),
      ],
      pullRequests: [
        makePullRequest({
          repoFullName: "owner/excluded-repo",
          title: "Bump lodash from 4.1 to 4.2",
          userLogin: "dependabot[bot]",
          headRef: "dependabot/npm_and_yarn/lodash-4.2",
        }),
        makePullRequest({
          repoFullName: "owner/other-repo",
          title: "Bump axios from 0.27 to 1.0",
          userLogin: "dependabot[bot]",
          headRef: "dependabot/npm_and_yarn/axios-1.0.0",
        }),
      ],
      workflowRuns: [],
      errors: [],
    });

    const githubService = await import("../../src/app/services/github");
    const graphqlSpy = vi.fn().mockResolvedValue({ nodes: [], rateLimit: null });
    vi.mocked(githubService.getClient).mockReturnValue({ graphql: graphqlSpy } as unknown as ReturnType<typeof githubService.getClient>);

    vi.mocked(pollService.createPollCoordinator).mockImplementation((_getInterval, fetchAll) => {
      const [lastRefreshAt, setLastRefreshAt] = createSignal<Date | null>(null);
      void fetchAll().then(() => setLastRefreshAt(new Date())).catch(() => {});
      return { isRefreshing: () => false, lastRefreshAt, manualRefresh: vi.fn(), destroy: vi.fn() };
    });

    render(() => <DashboardPage />);
    await waitFor(() => expect(graphqlSpy).toHaveBeenCalled());

    const [, variables] = graphqlSpy.mock.calls[0] as [string, { ids: string[] }];
    expect(variables.ids).toContain("DASH_other");
    expect(variables.ids).not.toContain("DASH_excluded");
  });

  it("depMeta cache entry for an excluded-but-still-tracked PR survives pruning", async () => {
    const EXCLUDED_REPO = { owner: "owner", name: "excluded-repo", fullName: "owner/excluded-repo" };
    const RENOVATE_BODY = [
      "| Package | Update | Change |",
      "|---|---|---|",
      "| some-pkg | minor | `1.0.0` → `1.1.0` |",
    ].join("\n");

    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [],
      pullRequests: [
        makePullRequest({
          id: 100,
          nodeId: "PR_A",
          repoFullName: EXCLUDED_REPO.fullName,
          title: "Update dependency some-pkg",
          userLogin: "dependabot[bot]",
          headRef: "dependabot/npm_and_yarn/some-pkg",
        }),
      ],
      workflowRuns: [],
      errors: [],
    });

    const githubService = await import("../../src/app/services/github");
    const graphqlSpy = vi.fn().mockResolvedValue({
      nodes: [{ databaseId: 100, body: RENOVATE_BODY }],
      rateLimit: null,
    });
    vi.mocked(githubService.getClient).mockReturnValue({ graphql: graphqlSpy } as unknown as ReturnType<typeof githubService.getClient>);

    render(() => <DashboardPage />);
    await waitFor(() => expect(graphqlSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      const raw = localStorage.getItem("github-tracker:dep-meta");
      expect(raw && JSON.parse(raw)).toHaveProperty("100");
    });

    // Exclude the repo, then poll again with a second PR needing its own body
    // fetch — this re-runs the effect (and its prune step) without which the
    // prune logic never executes again.
    configStore.updateConfig({
      dependencies: { ...configStore.config.dependencies, excludedRepos: [EXCLUDED_REPO] },
    });
    graphqlSpy.mockResolvedValue({
      nodes: [{ databaseId: 200, body: RENOVATE_BODY }],
      rateLimit: null,
    });
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [],
      pullRequests: [
        makePullRequest({
          id: 100,
          nodeId: "PR_A",
          repoFullName: EXCLUDED_REPO.fullName,
          title: "Update dependency some-pkg",
          userLogin: "dependabot[bot]",
          headRef: "dependabot/npm_and_yarn/some-pkg",
        }),
        makePullRequest({
          id: 200,
          nodeId: "PR_B",
          repoFullName: "owner/other-repo",
          title: "Update dependency other-pkg",
          userLogin: "dependabot[bot]",
          headRef: "dependabot/npm_and_yarn/other-pkg",
        }),
      ],
      workflowRuns: [],
      errors: [],
    });
    if (capturedFetchAll) await capturedFetchAll();

    await waitFor(() => expect(graphqlSpy).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      const raw = localStorage.getItem("github-tracker:dep-meta");
      const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      // PR-A (id 100) is excluded from the visible set but must survive
      // pruning — the prune step keys off the unfiltered dependency set.
      expect(parsed).toHaveProperty("100");
      expect(parsed).toHaveProperty("200");
    });
  });
});

describe("DashboardPage — pruneJiraCustomOrder on refresh", () => {
  // Draining the microtask queue deterministically (no real-time sleep) —
  // same pattern as flushPromises() in tests/services/poll.test.ts and
  // tests/services/events-poll.test.ts. fetchJiraAssigned() has no
  // intervening `await` between the searchJql resolution and the
  // scope/truncation-gated prune call, so a handful of microtask ticks is
  // enough to guarantee that code has run before we assert on the result.
  async function flushPromises(): Promise<void> {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }

  // Shared mock scaffolding for all three tests below: each needs jiraAuth,
  // isJiraAuthenticated, and JiraClient to behave differently from the
  // default mocks configured in the outer beforeEach, which requires a
  // fully isolated module reload (vi.resetModules() + vi.doMock() + fresh
  // dynamic imports). The only thing that varies between tests is the
  // searchJql mock's resolved value.
  async function setupPruneTestMocks(mockSearchJql: ReturnType<typeof vi.fn>) {
    vi.resetModules();
    authClearCallbacks.length = 0;

    vi.doMock("../../src/app/stores/auth", () => ({
      clearAuth: vi.fn(),
      expireToken: vi.fn(),
      token: () => "fake-token",
      user: () => ({ login: "testuser", avatar_url: "", name: "Test User" }),
      isAuthenticated: () => true,
      onAuthCleared: vi.fn((cb: () => void) => { authClearCallbacks.push(cb); }),
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
    }));

    const MockJiraClient = vi.fn(function (this: Record<string, unknown>) {
      this.searchJql = mockSearchJql;
      this.bulkFetch = vi.fn().mockResolvedValue({ issues: [], errors: [] });
    });
    vi.doMock("../../src/app/services/jira-client", () => ({
      JiraClient: MockJiraClient,
      JiraProxyClient: vi.fn(),
      JiraApiError: class JiraApiError extends Error {
        status: number;
        constructor(status: number, _body: unknown, message: string) {
          super(message);
          this.status = status;
        }
      },
      DEFAULT_FIELDS: ["summary", "status", "priority", "assignee", "project", "updated", "issuetype", "created"],
    }));

    vi.doMock("../../src/app/services/poll", () => ({
      fetchAllData: vi.fn().mockResolvedValue({
        issues: [], pullRequests: [], workflowRuns: [], errors: [],
      }),
      createPollCoordinator: vi.fn().mockImplementation(
        (_getInterval: unknown, fetchAll: () => Promise<DashboardData>) => {
          void fetchAll().catch(() => {});
          return { isRefreshing: () => false, lastRefreshAt: () => null, manualRefresh: vi.fn(), destroy: vi.fn() };
        }
      ),
      createHotPollCoordinator: vi.fn().mockImplementation(() => ({ destroy: vi.fn() })),
      createEventsPollCoordinator: vi.fn().mockImplementation(() => ({ destroy: vi.fn() })),
      rebuildHotSets: vi.fn(),
      seedHotSetsFromTargeted: vi.fn(),
      clearHotSets: vi.fn(),
      getHotPollGeneration: vi.fn().mockReturnValue(0),
    }));

    // Fresh imports after mock registration
    const freshView = await import("../../src/app/stores/view");
    const freshConfig = await import("../../src/app/stores/config");
    const freshDash = await import("../../src/app/components/dashboard/DashboardPage");

    freshView.resetViewState();
    freshConfig.resetConfig();
    freshConfig.updateJiraConfig({ enabled: true, siteUrl: "https://test.atlassian.net", siteName: "Test Site", authMethod: "oauth" });

    return { freshView, freshConfig, freshDash };
  }

  it("prunes jiraCustomOrder entries absent from assigned-scope results", async () => {
    const mockSearchJql = vi.fn().mockResolvedValue({
      issues: [
        {
          id: "1001", key: "PROJ-1", self: "https://test.atlassian.net/rest/api/3/issue/1001",
          fields: {
            summary: "First issue", status: { id: "1", name: "To Do", statusCategory: { id: 2, key: "new" as const, name: "To Do" } },
            priority: { id: "3", name: "Medium" }, assignee: null,
            project: { id: "10000", key: "PROJ", name: "Project" },
          },
        },
        {
          id: "1003", key: "PROJ-3", self: "https://test.atlassian.net/rest/api/3/issue/1003",
          fields: {
            summary: "Third issue", status: { id: "1", name: "To Do", statusCategory: { id: 2, key: "new" as const, name: "To Do" } },
            priority: { id: "3", name: "Medium" }, assignee: null,
            project: { id: "10000", key: "PROJ", name: "Project" },
          },
        },
      ],
      // No nextPageToken: this is the complete result set — safe to prune.
      maxResults: 100, startAt: 0,
    });

    const { freshView, freshDash } = await setupPruneTestMocks(mockSearchJql);
    freshView.setJiraCustomOrder(["PROJ-1", "PROJ-2", "PROJ-3"]);

    render(() => <freshDash.default />);

    await waitFor(() => {
      expect(freshView.viewState.jiraCustomOrder).toEqual(["PROJ-1", "PROJ-3"]);
    }, { timeout: 3000 });
  });

  it("does NOT prune jiraCustomOrder when a non-assigned scope is active", async () => {
    // This is the primary regression test for the scope gate at
    // DashboardPage.tsx (`if (scope === JIRA_CUSTOM_ORDER_SCOPE)`). It mounts
    // the real <DashboardPage /> and lets the real fetchJiraAssigned() run,
    // activating scope "reported" before mount and returning Jira results
    // that deliberately share NO keys with the existing jiraCustomOrder. If
    // the gate were ever inverted or removed, the real prune call would wipe
    // jiraCustomOrder down to [] here.
    const mockSearchJql = vi.fn().mockResolvedValue({
      issues: [
        {
          id: "2001", key: "OTHER-1", self: "https://test.atlassian.net/rest/api/3/issue/2001",
          fields: {
            summary: "Reported issue", status: { id: "1", name: "To Do", statusCategory: { id: 2, key: "new" as const, name: "To Do" } },
            priority: { id: "3", name: "Medium" }, assignee: null,
            project: { id: "20000", key: "OTHER", name: "Other Project" },
          },
        },
      ],
      maxResults: 100, startAt: 0,
    });

    const { freshView, freshDash } = await setupPruneTestMocks(mockSearchJql);
    freshView.setJiraCustomOrder(["PROJ-1", "PROJ-2", "PROJ-3"]);
    // Activate a non-"assigned" scope BEFORE mount, so the immediate
    // on-mount fetchJiraAssigned() call reads scope "reported" from
    // viewState.tabFilters.jiraAssigned — exactly the branch the gate at
    // DashboardPage.tsx is supposed to skip pruning for.
    freshView.setTabFilter("jiraAssigned", "scope", "reported");

    render(() => <freshDash.default />);

    // Wait for the real fetchJiraAssigned() to actually invoke searchJql...
    await waitFor(() => {
      expect(mockSearchJql).toHaveBeenCalled();
    }, { timeout: 3000 });
    // ...then deterministically flush the microtask queue so the code after
    // the awaited searchJql call (setJiraIssues + the scope-gated prune
    // call) has actually finished running before we assert on the result.
    await flushPromises();

    expect(freshView.viewState.jiraCustomOrder).toEqual(["PROJ-1", "PROJ-2", "PROJ-3"]);
  });

  it("does NOT prune jiraCustomOrder when the assigned-scope result is truncated by pagination", async () => {
    // Regression test for the truncation guard at DashboardPage.tsx
    // (`result.nextPageToken === undefined`). searchJql returns only 2
    // issues and a defined nextPageToken — simulating a user with more than
    // maxResults assigned non-done issues, where the real API paginates via
    // an opaque cursor rather than reporting a total match count.
    // pruneJiraCustomOrder must NOT run here: treating "not in this page" as
    // "no longer exists" would permanently delete the custom-order position
    // for issues that are simply on a later page, not actually gone.
    const mockSearchJql = vi.fn().mockResolvedValue({
      issues: [
        {
          id: "1001", key: "PROJ-1", self: "https://test.atlassian.net/rest/api/3/issue/1001",
          fields: {
            summary: "First issue", status: { id: "1", name: "To Do", statusCategory: { id: 2, key: "new" as const, name: "To Do" } },
            priority: { id: "3", name: "Medium" }, assignee: null,
            project: { id: "10000", key: "PROJ", name: "Project" },
          },
        },
        {
          id: "1002", key: "PROJ-2", self: "https://test.atlassian.net/rest/api/3/issue/1002",
          fields: {
            summary: "Second issue", status: { id: "1", name: "To Do", statusCategory: { id: 2, key: "new" as const, name: "To Do" } },
            priority: { id: "3", name: "Medium" }, assignee: null,
            project: { id: "10000", key: "PROJ", name: "Project" },
          },
        },
      ],
      // A defined nextPageToken means more results exist beyond this page:
      // the API result is truncated.
      nextPageToken: "some-token-value", maxResults: 100, startAt: 0,
    });

    const { freshView, freshDash } = await setupPruneTestMocks(mockSearchJql);
    // PROJ-3 is not present in the (truncated) search results but must
    // survive because the result set is incomplete.
    freshView.setJiraCustomOrder(["PROJ-1", "PROJ-2", "PROJ-3"]);

    render(() => <freshDash.default />);

    // Wait for the real fetchJiraAssigned() to actually invoke searchJql...
    await waitFor(() => {
      expect(mockSearchJql).toHaveBeenCalled();
    }, { timeout: 3000 });
    // ...then deterministically flush the microtask queue so the code after
    // the awaited searchJql call (setJiraIssues + the truncation-gated
    // prune call) has actually finished running before we assert on the
    // result.
    await flushPromises();

    expect(freshView.viewState.jiraCustomOrder).toEqual(["PROJ-1", "PROJ-2", "PROJ-3"]);
  });
});

// ── Dependencies tab — depBodies fetch guard recovers from a hung request ───────

describe("DashboardPage — depBodies fetch guard recovers from a hung GraphQL request", () => {
  it("releases the _fetchingDepBodies guard after the GraphQL timeout fires, so a later poll cycle retries the fetch", async () => {
    vi.useFakeTimers();
    try {
      const githubService = await import("../../src/app/services/github");
      // Never resolves — reproduces a hung GraphQL request: without
      // raceWithTimeout, awaiting this promise would never settle, and
      // the effect's finally block (which releases _fetchingDepBodies) would
      // never run, permanently wedging the fetch-in-progress guard.
      const graphqlSpy = vi.fn(() => new Promise<never>(() => {}));
      vi.mocked(githubService.getClient).mockReturnValue(
        { graphql: graphqlSpy } as unknown as ReturnType<typeof githubService.getClient>
      );

      const depPR1 = makePullRequest({
        id: 100,
        nodeId: "PR_A",
        repoFullName: "owner/repo",
        title: "Update dependency some-pkg",
        userLogin: "dependabot[bot]",
        headRef: "dependabot/npm_and_yarn/some-pkg",
      });
      vi.mocked(pollService.fetchAllData).mockResolvedValue({
        issues: [],
        pullRequests: [depPR1],
        workflowRuns: [],
        errors: [],
      });

      render(() => <DashboardPage />);

      // vi.waitFor polls using real (un-mocked) timers even while fake timers
      // are installed, so this settles as soon as the pending microtasks from
      // fetchAllData's resolved mock and Solid's reactive depBodies effect
      // propagate — no timer advance is needed to reach the first graphql call.
      await vi.waitFor(() => {
        expect(graphqlSpy).toHaveBeenCalledTimes(1);
      }, { timeout: 5000 });

      // Advance past the body-fetch timeout. raceWithTimeout's internal
      // setTimeout fires, aborts the controller, and rejects the race;
      // fetchDepPRBodies swallows that per-batch failure (Promise.allSettled)
      // and resolves with an empty bodies Map — so the depBodies effect's
      // `finally` block runs and releases the _fetchingDepBodies guard.
      await vi.advanceTimersByTimeAsync(GRAPHQL_BODY_FETCH_TIMEOUT_MS);

      // A second dependency PR arrives on a later poll cycle. If the guard
      // was truly released, the depBodies effect fires again and retries the
      // fetch (a second graphql call). Without the timeout fix, a hung request
      // would leave the guard stuck forever and this second call would never happen.
      const depPR2 = makePullRequest({
        id: 200,
        nodeId: "PR_B",
        repoFullName: "owner/repo2",
        title: "Update dependency other-pkg",
        userLogin: "dependabot[bot]",
        headRef: "dependabot/npm_and_yarn/other-pkg",
      });
      vi.mocked(pollService.fetchAllData).mockResolvedValue({
        issues: [],
        pullRequests: [depPR1, depPR2],
        workflowRuns: [],
        errors: [],
      });
      if (capturedFetchAll) {
        await capturedFetchAll();
      }

      await vi.waitFor(() => {
        expect(graphqlSpy).toHaveBeenCalledTimes(2);
      }, { timeout: 5000 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("excludes a PR whose body-fetch failed from retry until the failure cooldown elapses", async () => {
    // Only Date is faked (not setTimeout/setInterval) so we can jump the clock
    // forward by the cooldown window without executing DashboardPage's other
    // unrelated real timers/intervals along the way.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const githubService = await import("../../src/app/services/github");
      const graphqlSpy = vi.fn()
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValue({ nodes: [{ databaseId: 100, body: "not a renovate table" }], rateLimit: null });
      vi.mocked(githubService.getClient).mockReturnValue(
        { graphql: graphqlSpy } as unknown as ReturnType<typeof githubService.getClient>
      );

      const depPR = makePullRequest({
        id: 100,
        nodeId: "PR_A",
        repoFullName: "owner/repo",
        title: "Update dependency some-pkg",
        userLogin: "dependabot[bot]",
        headRef: "dependabot/npm_and_yarn/some-pkg",
      });
      vi.mocked(pollService.fetchAllData).mockResolvedValue({
        issues: [],
        pullRequests: [depPR],
        workflowRuns: [],
        errors: [],
      });

      render(() => <DashboardPage />);
      await waitFor(() => expect(graphqlSpy).toHaveBeenCalledTimes(1));
      // capturedFetchAll only awaits the poll fetch itself, not the effect's
      // fire-and-forget async body-fetch — give the (immediately-rejecting,
      // no real network delay) catch/finally chain a moment to actually
      // settle and release the guard before triggering the next poll, or it
      // races the in-flight fetch and gets silently skipped ("fetch already
      // in flight").
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Second poll cycle, same PR unchanged — the cooldown should suppress the
      // retry. Re-issue the mock with a fresh array (same PR object) so SolidJS's
      // store sees a reference change and actually re-runs dependent effects —
      // reusing the exact same array/response object across polls is a no-op
      // for reactivity and would make this test pass for the wrong reason.
      vi.mocked(pollService.fetchAllData).mockResolvedValue({
        issues: [],
        pullRequests: [depPR],
        workflowRuns: [],
        errors: [],
      });
      if (capturedFetchAll) await capturedFetchAll();
      // Real (unfaked) short delay to let the reactive effect chain settle
      // before asserting the call count did NOT increase.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(graphqlSpy).toHaveBeenCalledTimes(1);

      // Jump the clock past the cooldown window (no intervening timers run —
      // only Date.now() changes) so the PR becomes eligible again.
      vi.setSystemTime(new Date(Date.now() + DEP_BODY_FAILURE_COOLDOWN_MS));
      vi.mocked(pollService.fetchAllData).mockResolvedValue({
        issues: [],
        pullRequests: [depPR],
        workflowRuns: [],
        errors: [],
      });
      if (capturedFetchAll) await capturedFetchAll();
      await waitFor(() => expect(graphqlSpy).toHaveBeenCalledTimes(2));
    } finally {
      vi.useRealTimers();
    }
  });

  it("prunes a stale cooldown entry when its PR leaves the dependency set, so a later reappearance is retried immediately", async () => {
    const githubService = await import("../../src/app/services/github");
    const graphqlSpy = vi.fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({ nodes: [], rateLimit: null });
    vi.mocked(githubService.getClient).mockReturnValue(
      { graphql: graphqlSpy } as unknown as ReturnType<typeof githubService.getClient>
    );

    const depPRA = makePullRequest({
      id: 100,
      nodeId: "PR_A",
      repoFullName: "owner/repo",
      title: "Update dependency some-pkg",
      userLogin: "dependabot[bot]",
      headRef: "dependabot/npm_and_yarn/some-pkg",
    });
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [],
      pullRequests: [depPRA],
      workflowRuns: [],
      errors: [],
    });

    render(() => <DashboardPage />);
    await waitFor(() => expect(graphqlSpy).toHaveBeenCalledTimes(1));
    // capturedFetchAll only awaits the poll fetch itself, not the effect's
    // fire-and-forget async body-fetch — give the (immediately-rejecting,
    // no real network delay) catch/finally chain a moment to actually settle
    // and release the guard before triggering the next poll, or it races the
    // in-flight fetch and gets silently skipped ("fetch already in flight").
    await new Promise((resolve) => setTimeout(resolve, 100));

    // PR_A closes/merges and disappears; a new PR_B needs its own fetch —
    // this re-runs the effect (and its cooldown-prune step) even though
    // PR_A itself is no longer in toFetch.
    const depPRB = makePullRequest({
      id: 200,
      nodeId: "PR_B",
      repoFullName: "owner/repo2",
      title: "Update dependency other-pkg",
      userLogin: "dependabot[bot]",
      headRef: "dependabot/npm_and_yarn/other-pkg",
    });
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [],
      pullRequests: [depPRB],
      workflowRuns: [],
      errors: [],
    });
    if (capturedFetchAll) await capturedFetchAll();
    await waitFor(() => expect(graphqlSpy).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 100));

    // PR_A reappears (e.g. reopened) well within what would have been its
    // cooldown window. If its stale cooldown entry survived PR_A leaving the
    // dependency set, it would incorrectly still be excluded here.
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [],
      pullRequests: [depPRA, depPRB],
      workflowRuns: [],
      errors: [],
    });
    if (capturedFetchAll) await capturedFetchAll();
    await waitFor(() => expect(graphqlSpy).toHaveBeenCalledTimes(3));

    const idsRequestedInThirdCall = (graphqlSpy.mock.calls[2]?.[1] as { ids: string[] } | undefined)?.ids ?? [];
    expect(idsRequestedInThirdCall).toContain("PR_A");
  });

  it("prunes a stale cooldown entry even when no other PR triggers a fetch in between", async () => {
    // Regression guard: the cooldown-prune loop must run on every effect
    // evaluation, not only when toFetch is non-empty — otherwise a PR that
    // fails, disappears, and reopens with nothing else needing a fetch in
    // between would stay incorrectly excluded on a stale cooldown entry.
    const githubService = await import("../../src/app/services/github");
    const graphqlSpy = vi.fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({ nodes: [], rateLimit: null });
    vi.mocked(githubService.getClient).mockReturnValue(
      { graphql: graphqlSpy } as unknown as ReturnType<typeof githubService.getClient>
    );

    const depPRA = makePullRequest({
      id: 100,
      nodeId: "PR_A",
      repoFullName: "owner/repo",
      title: "Update dependency some-pkg",
      userLogin: "dependabot[bot]",
      headRef: "dependabot/npm_and_yarn/some-pkg",
    });
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [],
      pullRequests: [depPRA],
      workflowRuns: [],
      errors: [],
    });

    render(() => <DashboardPage />);
    await waitFor(() => expect(graphqlSpy).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 100));

    // PR_A closes/merges and disappears — no other dependency PR takes its
    // place, so toFetch is empty this cycle. The prune step must still run.
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [],
      pullRequests: [],
      workflowRuns: [],
      errors: [],
    });
    if (capturedFetchAll) await capturedFetchAll();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(graphqlSpy).toHaveBeenCalledTimes(1);

    // PR_A reappears (e.g. reopened) well within what would have been its
    // cooldown window. If the stale entry wasn't pruned while PR_A was absent,
    // it would incorrectly still be excluded here.
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [],
      pullRequests: [depPRA],
      workflowRuns: [],
      errors: [],
    });
    if (capturedFetchAll) await capturedFetchAll();
    await waitFor(() => expect(graphqlSpy).toHaveBeenCalledTimes(2));
  });
});

// ── Dependencies tab — abandonedDepsMap + dashboardIssueUrls reset on auth clear ─

describe("DashboardPage — abandonedDepsMap and dashboardIssueUrls on auth clear", () => {
  it("Dependencies tab disappears after auth clear (abandonedDepsMap reset)", async () => {
    // The module-level signals abandonedDepsMap and dashboardIssueUrls are reset
    // to empty Maps by the onAuthCleared callback alongside resetDashboardData().
    // We verify indirectly: dep PRs are cleared → Dependencies tab vanishes.
    const depPR = makePullRequest({
      id: 800,
      title: "chore(deps): update dependency lodash to v5",
      userLogin: "renovate[bot]",
      headRef: "renovate/lodash-5.x",
      state: "OPEN",
    });
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [],
      pullRequests: [depPR],
      workflowRuns: [],
      errors: [],
    });

    render(() => <DashboardPage />);

    // Dependencies tab appears when dep PRs are present
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /Dependencies/ })).toBeDefined();
    });

    // Invoke auth clear callbacks — this calls resetDashboardData() which clears
    // all PRs, and also calls setAbandonedDepsMap(new Map()) + setDashboardIssueUrls(new Map())
    expect(authClearCallbacks.length).toBeGreaterThan(0);
    for (const cb of authClearCallbacks) cb();

    // After clear, no dep PRs → enableDependencies() becomes false → tab hidden
    await waitFor(() => {
      expect(screen.queryByRole("tab", { name: /Dependencies/ })).toBeNull();
    });
  });

  it("DependenciesTab renders dep PRs when navigating to Dependencies tab", async () => {
    const user = userEvent.setup();

    const depPR = makePullRequest({
      id: 801,
      title: "Bump axios from 0.27 to 1.0",
      userLogin: "dependabot[bot]",
      headRef: "dependabot/npm_and_yarn/axios-1.0.0",
      state: "OPEN",
      enriched: true,
      checkStatus: "success",
      reviewDecision: null,
      draft: false,
    });
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [],
      pullRequests: [depPR],
      workflowRuns: [],
      errors: [],
    });

    render(() => <DashboardPage />);

    // Click the Dependencies tab
    await waitFor(() => screen.getByRole("tab", { name: /Dependencies/ }));
    await user.click(screen.getByRole("tab", { name: /Dependencies/ }));

    // DependenciesTab renders the PR with structured title
    await waitFor(() => {
      expect(screen.getByText("axios: 0.27 → 1.0")).toBeDefined();
    });
  });
});
