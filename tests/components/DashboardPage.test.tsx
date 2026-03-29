import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { makeIssue, makePullRequest, makeWorkflowRun } from "../helpers/index";
import * as viewStore from "../../src/app/stores/view";
import type { DashboardData } from "../../src/app/services/poll";

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
  prUpdates: Map<number, { state: string; checkStatus: string; mergeStateStatus: string; reviewDecision: string | null }>,
  runUpdates: Map<number, { id: number; status: string; conclusion: string | null; updatedAt: string; completedAt: string | null }>,
  generation: number,
) => void) | null = null;

// DashboardPage and pollService are imported dynamically after each vi.resetModules()
// so the module-level _coordinator variable is always fresh (null) per test.
let DashboardPage: typeof import("../../src/app/components/dashboard/DashboardPage").default;
let pollService: typeof import("../../src/app/services/poll");
let authStore: typeof import("../../src/app/stores/auth");

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
  pollService = await import("../../src/app/services/poll");
  authStore = await import("../../src/app/stores/auth");

  mockLocationReplace.mockClear();
  capturedFetchAll = null;
  capturedOnHotData = null;
  vi.mocked(authStore.clearAuth).mockClear();
  vi.mocked(pollService.fetchAllData).mockResolvedValue({
    issues: [],
    pullRequests: [],
    workflowRuns: [],
    errors: [],
  });
  // Reset view store to defaults
  viewStore.updateViewState({
    lastActiveTab: "issues",
    sortPreferences: {},
    ignoredItems: [],
    globalFilter: { org: null, repo: null },
  });
});

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
      screen.getByText("Fetched issue alpha");
      screen.getByText("Fetched issue beta");
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
      screen.getByText("Fetched PR one");
      screen.getByText("Fetched PR two");
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
      screen.getByText("Existing issue");
    });

    // Trigger a second fetch via the captured callback — skipped result should not erase data
    await capturedFetchAll?.();
    screen.getByText("Existing issue");
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

  it("calls clearAuth and redirects to /login on 401 error (permanent token revoked)", async () => {
    const err401 = Object.assign(new Error("Unauthorized"), { status: 401 });
    vi.mocked(pollService.fetchAllData).mockRejectedValue(err401);

    render(() => <DashboardPage />);
    await waitFor(() => {
      expect(authStore.clearAuth).toHaveBeenCalledOnce();
      expect(mockLocationReplace).toHaveBeenCalledWith("/login");
    });
  });

  it("does not call clearAuth for non-401 errors", async () => {
    const err500 = Object.assign(new Error("Server Error"), { status: 500 });
    vi.mocked(pollService.fetchAllData).mockRejectedValue(err500);

    render(() => <DashboardPage />);
    // Flush all pending microtasks so the rejected promise settles
    await Promise.resolve();
    await Promise.resolve();
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
      screen.getByText("Should be cleared");
    });

    // DashboardPage registered an onAuthCleared callback at module scope.
    // Invoking it simulates what clearAuth() does on logout.
    expect(authClearCallbacks.length).toBeGreaterThan(0);
    for (const cb of authClearCallbacks) cb();

    // The coordinator's destroy() should have been called
    expect(mockDestroy).toHaveBeenCalled();

    // Dashboard data should be cleared — no stale items visible
    await waitFor(() => {
      expect(screen.queryByText("Should be cleared")).toBeNull();
    });
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

    // Verify initial state shows pending
    const user = userEvent.setup();
    await user.click(screen.getByText("Pull Requests"));
    await waitFor(() => {
      expect(screen.getByLabelText("Checks in progress")).toBeTruthy();
    });

    // Simulate hot poll returning a status update (generation=0 matches default mock)
    const prUpdates = new Map([[42, {
      state: "OPEN",
      checkStatus: "success" as const,
      mergeStateStatus: "CLEAN",
      reviewDecision: "APPROVED" as const,
    }]]);
    capturedOnHotData!(prUpdates, new Map(), 0);

    // The StatusDot should update from "Checks in progress" to "All checks passed"
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
});
