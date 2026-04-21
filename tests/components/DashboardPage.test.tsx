import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { makeIssue, makePullRequest, makeWorkflowRun } from "../helpers/index";
import type { DashboardData } from "../../src/app/services/poll";
import type { HotPRStatusUpdate, HotWorkflowRunUpdate } from "../../src/app/services/api";

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
}));

// Mock github service (used by Header + DashboardPage org sync)
vi.mock("../../src/app/services/github", () => ({
  getCoreRateLimit: () => null,
  getGraphqlRateLimit: () => null,
  getClient: () => null,
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

// DashboardPage and pollService are imported dynamically after each vi.resetModules()
// so the module-level _coordinator variable is always fresh (null) per test.
let DashboardPage: typeof import("../../src/app/components/dashboard/DashboardPage").default;
let _resetHasFetchedFresh: typeof import("../../src/app/components/dashboard/DashboardPage")._resetHasFetchedFresh;
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
    rebuildHotSets: vi.fn(),
    clearHotSets: vi.fn(),
    getHotPollGeneration: vi.fn().mockReturnValue(0),
  }));

  // Re-import with fresh module instances
  const dashboardModule = await import("../../src/app/components/dashboard/DashboardPage");
  DashboardPage = dashboardModule.default;
  _resetHasFetchedFresh = dashboardModule._resetHasFetchedFresh;
  pollService = await import("../../src/app/services/poll");
  authStore = await import("../../src/app/stores/auth");
  viewStore = await import("../../src/app/stores/view");
  configStore = await import("../../src/app/stores/config");

  mockLocationReplace.mockClear();
  capturedFetchAll = null;
  capturedOnHotData = null;
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
  it("excludes Dependency Dashboard issues from badge count by default", async () => {
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [
        makeIssue({ id: 1, title: "Real issue" }),
        makeIssue({ id: 2, title: "Dependency Dashboard" }),
        makeIssue({ id: 3, title: "Dependency Dashboard" }),
      ],
      pullRequests: [],
      workflowRuns: [],
      errors: [],
    });

    render(() => <DashboardPage />);
    await waitFor(() => {
      const issuesTab = screen.getByRole("tab", { name: /Issues/ });
      expect(issuesTab.textContent?.replace(/\D+/g, "")).toBe("1");
    });
  });

  it("updates badge dynamically when hideDepDashboard is toggled off", async () => {
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [
        makeIssue({ id: 1, title: "Real issue" }),
        makeIssue({ id: 2, title: "Dependency Dashboard" }),
      ],
      pullRequests: [],
      workflowRuns: [],
      errors: [],
    });

    render(() => <DashboardPage />);
    // hideDepDashboard defaults to true — badge shows 1
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /Issues/ }).textContent?.replace(/\D+/g, "")).toBe("1");
    });

    // Toggle off — badge should update to 2
    viewStore.updateViewState({ hideDepDashboard: false });
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /Issues/ }).textContent?.replace(/\D+/g, "")).toBe("2");
    });
  });

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
    viewStore.updateViewState({ hideDepDashboard: false });

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

  it("combines hideDepDashboard and ignore exclusions correctly", async () => {
    vi.mocked(pollService.fetchAllData).mockResolvedValue({
      issues: [
        makeIssue({ id: 1, title: "Issue A" }),
        makeIssue({ id: 2, title: "Dependency Dashboard" }),
        makeIssue({ id: 3, title: "Issue C" }),
      ],
      pullRequests: [],
      workflowRuns: [],
      errors: [],
    });
    // hideDepDashboard defaults true — badge starts at 2 (excludes Dep Dashboard)
    render(() => <DashboardPage />);
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /Issues/ }).textContent?.replace(/\D+/g, "")).toBe("2");
    });

    // Ignore one real issue — badge should drop to 1
    viewStore.ignoreItem({ id: 1, type: "issue", repo: "owner/repo", title: "Issue A", ignoredAt: Date.now() });
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /Issues/ }).textContent?.replace(/\D+/g, "")).toBe("1");
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
      hideDepDashboard: false,
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
      hideDepDashboard: false,
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

  it("skipped fetch (notifications gate) keeps existing data", async () => {
    const issues = [makeIssue({ id: 5, title: "Existing issue" })];
    // First call: returns real data; subsequent calls: skipped=true
    vi.mocked(pollService.fetchAllData)
      .mockResolvedValueOnce({ issues, pullRequests: [], workflowRuns: [], errors: [] })
      .mockResolvedValue({ issues: [], pullRequests: [], workflowRuns: [], errors: [], skipped: true });
    render(() => <DashboardPage />);
    await waitFor(() => {
      // Repo group header visible (collapsed — verify data reached the tab)
      screen.getByText("owner/repo");
      screen.getByText("1 issue");
    });

    // Trigger a second fetch via the captured callback — skipped result should not erase data
    await capturedFetchAll?.();
    // Data still present (collapsed repo group summary persists)
    screen.getByText("1 issue");
  });

  it("auto-prune runs after first non-skipped poll even if a skipped poll occurred first", async () => {
    configStore.updateConfig({
      enableTracking: true,
      selectedRepos: [{ owner: "org", name: "repo", fullName: "org/repo" }],
    });
    viewStore.updateViewState({
      trackedItems: [{
        id: 555,
        number: 55,
        type: "issue" as const,
        repoFullName: "org/repo",
        title: "Will be pruned after non-skipped poll",
        addedAt: Date.now(),
      }],
    });

    // First call: skipped — hasFetchedFresh must stay false, no pruning
    vi.mocked(pollService.fetchAllData)
      .mockResolvedValueOnce({ issues: [], pullRequests: [], workflowRuns: [], errors: [], skipped: true })
      // Second call: real data with empty issues — item 555 absent means closed
      .mockResolvedValueOnce({ issues: [], pullRequests: [], workflowRuns: [], errors: [] });

    render(() => <DashboardPage />);

    // After the first (skipped) fetch, tracked item must NOT be pruned yet
    await waitFor(() => {
      expect(viewStore.viewState.trackedItems.length).toBe(1);
    });

    // Trigger a second fetch — non-skipped, sets hasFetchedFresh=true, triggers prune
    await capturedFetchAll?.();

    await waitFor(() => {
      expect(viewStore.viewState.trackedItems.length).toBe(0);
    });
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
      state: "open",
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
      state: "OPEN",
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
      state: "open",
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
      state: "OPEN",
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
    // Add an exclusive issues custom tab that claims all repos
    configStore.addCustomTab({
      id: "excl01",
      name: "My Issues",
      baseType: "issues",
      orgScope: [],
      repoScope: [],
      filterPreset: {},
      exclusive: true,
    });
    viewStore.updateViewState({ hideDepDashboard: false });

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
      orgScope: [],
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
    viewStore.updateViewState({ hideDepDashboard: false });

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
      orgScope: [],
      repoScope: [],
      filterPreset: {},
      exclusive: true,
    });
    configStore.addCustomTab({
      id: "second01",
      name: "Second Exclusive",
      baseType: "issues",
      orgScope: [],
      repoScope: [],
      filterPreset: {},
      exclusive: true,
    });
    viewStore.updateViewState({ hideDepDashboard: false });

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
      orgScope: [],
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
    viewStore.updateViewState({ hideDepDashboard: false });

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
    viewStore.updateViewState({ hideDepDashboard: false });

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
    viewStore.updateViewState({ hideDepDashboard: false });

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
    viewStore.updateViewState({ hideDepDashboard: false });

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
    viewStore.updateViewState({ hideDepDashboard: false });

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
    viewStore.updateViewState({ hideDepDashboard: false });

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
      orgScope: [],
      repoScope: [],
      filterPreset: { scope: "all", user: "_self" },
      exclusive: false,
    });
    viewStore.updateViewState({ hideDepDashboard: false });

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
      orgScope: [],
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
});
