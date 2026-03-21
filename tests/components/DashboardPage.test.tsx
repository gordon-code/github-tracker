import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { makeIssue, makePullRequest, makeWorkflowRun } from "../helpers/index";
import * as viewStore from "../../src/app/stores/view";
import type { DashboardData } from "../../src/app/services/poll";

const mockNavigate = vi.fn();

// Mock the entire router — vi.importActual with SolidJS Vite plugin causes
// empty renders. DashboardPage only needs useNavigate for 401 redirect.
vi.mock("@solidjs/router", () => ({
  useNavigate: () => mockNavigate,
}));

// Mock poll service.
// createPollCoordinator captures the fetchAll callback and calls it immediately
// so that pollFetch (which calls fetchAllData) actually runs during tests.
// This is the only way to test data flow and error handling — without invoking
// the callback, the dashboard store never updates.
let capturedFetchAll: (() => Promise<DashboardData>) | null = null;

vi.mock("../../src/app/services/poll", () => ({
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
      };
    }
  ),
}));

// Mock auth store
vi.mock("../../src/app/stores/auth", () => ({
  refreshAccessToken: vi.fn().mockResolvedValue(true),
  clearAuth: vi.fn(),
  token: () => "fake-token",
  user: () => ({ login: "testuser", avatar_url: "", name: "Test User" }),
  isAuthenticated: () => true,
  onAuthCleared: vi.fn(),
}));

// Mock github service (used by Header)
vi.mock("../../src/app/services/github", () => ({
  getRateLimit: () => null,
}));

// Mock errors lib — return empty by default
vi.mock("../../src/app/lib/errors", () => ({
  getErrors: vi.fn().mockReturnValue([]),
  dismissError: vi.fn(),
  pushError: vi.fn(),
  clearErrors: vi.fn(),
}));

import DashboardPage from "../../src/app/components/dashboard/DashboardPage";
import * as pollService from "../../src/app/services/poll";
import * as authStore from "../../src/app/stores/auth";

beforeEach(() => {
  mockNavigate.mockClear();
  capturedFetchAll = null;
  vi.mocked(authStore.clearAuth).mockClear();
  vi.mocked(authStore.refreshAccessToken).mockClear();
  vi.mocked(authStore.refreshAccessToken).mockResolvedValue(true);
  vi.mocked(pollService.fetchAllData).mockResolvedValue({
    issues: [],
    pullRequests: [],
    workflowRuns: [],
    errors: [],
  });
  vi.mocked(pollService.createPollCoordinator).mockImplementation(
    (_getInterval: unknown, fetchAll: () => Promise<DashboardData>) => {
      capturedFetchAll = fetchAll;
      void fetchAll().catch(() => {});
      return {
        isRefreshing: () => false,
        lastRefreshAt: () => null,
        manualRefresh: vi.fn(),
      };
    }
  );
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
    // IssuesTab column headers are always rendered (even while loading)
    screen.getByLabelText("Sort by Title");
  });

  it("switches to PullRequestsTab when Pull Requests tab is clicked", async () => {
    const user = userEvent.setup();
    render(() => <DashboardPage />);
    await user.click(screen.getByText("Pull Requests"));
    // PullRequestsTab renders its own "Sort by Title" column header
    screen.getByLabelText("Sort by Title");
    // The PR tab button is now active
    const prButton = screen.getByText("Pull Requests").closest("button");
    expect(prButton?.getAttribute("aria-current")).toBe("page");
  });

  it("switches to ActionsTab when Actions tab is clicked", async () => {
    const user = userEvent.setup();
    render(() => <DashboardPage />);
    await user.click(screen.getByText("Actions"));
    // ActionsTab renders a "Show PR runs" checkbox — unique to that tab
    screen.getByText("Show PR runs");
    const actionsButton = screen.getByText("Actions").closest("button");
    expect(actionsButton?.getAttribute("aria-current")).toBe("page");
  });

  it("Issues tab button has aria-current=page on initial render", () => {
    render(() => <DashboardPage />);
    const issuesButton = screen.getByText("Issues").closest("button");
    expect(issuesButton?.getAttribute("aria-current")).toBe("page");
  });

  it("clicking a tab removes aria-current from previous tab", async () => {
    const user = userEvent.setup();
    render(() => <DashboardPage />);
    await user.click(screen.getByText("Pull Requests"));
    const issuesButton = screen.getByText("Issues").closest("button");
    expect(issuesButton?.getAttribute("aria-current")).toBeNull();
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
      // ActionsTab shows workflow names as group headers (may appear in header button + run row)
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

  it("calls refreshAccessToken on 401 error from fetchAllData", async () => {
    const err401 = Object.assign(new Error("Unauthorized"), { status: 401 });
    vi.mocked(pollService.fetchAllData).mockRejectedValue(err401);

    render(() => <DashboardPage />);
    await waitFor(() => {
      expect(authStore.refreshAccessToken).toHaveBeenCalledOnce();
    });
  });

  it("calls clearAuth and navigates to /login when refresh fails", async () => {
    const err401 = Object.assign(new Error("Unauthorized"), { status: 401 });
    vi.mocked(pollService.fetchAllData).mockRejectedValue(err401);
    vi.mocked(authStore.refreshAccessToken).mockResolvedValue(false);

    render(() => <DashboardPage />);
    await waitFor(() => {
      expect(authStore.clearAuth).toHaveBeenCalledOnce();
      expect(mockNavigate).toHaveBeenCalledWith("/login");
    });
  });

  it("does not call clearAuth when refresh succeeds after 401", async () => {
    const err401 = Object.assign(new Error("Unauthorized"), { status: 401 });
    vi.mocked(pollService.fetchAllData).mockRejectedValue(err401);
    vi.mocked(authStore.refreshAccessToken).mockResolvedValue(true);

    render(() => <DashboardPage />);
    await waitFor(() => {
      expect(authStore.refreshAccessToken).toHaveBeenCalledOnce();
    });
    expect(authStore.clearAuth).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalledWith("/login");
  });

  it("does not call refreshAccessToken for non-401 errors", async () => {
    const err500 = Object.assign(new Error("Server Error"), { status: 500 });
    vi.mocked(pollService.fetchAllData).mockRejectedValue(err500);

    render(() => <DashboardPage />);
    // Flush all pending microtasks so the rejected promise settles
    await Promise.resolve();
    await Promise.resolve();
    expect(authStore.refreshAccessToken).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalledWith("/login");
  });
});
