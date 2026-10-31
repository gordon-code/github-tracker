import { describe, it, expect, vi, beforeEach } from "vitest";
import { createStore, reconcile, unwrap } from "solid-js/store";
import { render, screen, waitFor } from "@solidjs/testing-library";
import { makeIssue, makePullRequest, makeWorkflowRun } from "../../helpers/index";
import { fallbackToPreviousEnrichment } from "../../../src/app/services/api";
import type { DashboardData } from "../../../src/app/services/poll";
import type { HotPRStatusUpdate, HotWorkflowRunUpdate, PullRequest } from "../../../src/app/services/api";

const mockLocationReplace = vi.fn();

Object.defineProperty(window, "location", {
  configurable: true,
  writable: true,
  value: { replace: mockLocationReplace, href: "" },
});

vi.mock("@solidjs/router", () => ({
  useNavigate: () => vi.fn(),
}));

const authClearCallbacks: (() => void)[] = [];
vi.mock("../../../src/app/stores/auth", () => ({
  clearAuth: vi.fn(),
  expireToken: vi.fn(),
  token: () => "fake-token",
  user: () => ({ login: "testuser", avatar_url: "", name: "Test User" }),
  isAuthenticated: () => true,
  onAuthCleared: vi.fn((cb: () => void) => {
    authClearCallbacks.push(cb);
  }),
  DASHBOARD_STORAGE_KEY: "github-tracker:dashboard",
  DEP_META_STORAGE_KEY: "github-tracker:dep-meta",
  jiraAuth: vi.fn(() => null),
  isJiraAuthenticated: vi.fn(() => false),
  setJiraAuth: vi.fn(),
  clearJiraAuth: vi.fn(),
  ensureJiraTokenValid: vi.fn().mockResolvedValue(false),
  identityEpoch: () => 0,
}));

vi.mock("../../../src/app/lib/dashboard-snapshot", () => ({
  loadSnapshot: vi.fn().mockResolvedValue(null),
  writeSnapshot: vi.fn(),
  flushSnapshot: vi.fn().mockResolvedValue(undefined),
  clearSnapshot: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/app/services/jira-client", () => ({
  JiraClient: vi.fn(),
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

vi.mock("../../../src/app/services/jira-keys", () => ({
  detectAndLookupJiraKeys: vi.fn().mockResolvedValue(new Map()),
  clearJiraKeyCache: vi.fn(),
}));

vi.mock("../../../src/app/services/github", () => ({
  getCoreRateLimit: () => null,
  getGraphqlRateLimit: () => null,
  getClient: vi.fn(() => null),
  updateGraphqlRateLimit: vi.fn(),
}));

vi.mock("../../../src/app/lib/notifications", () => ({
  detectNewItems: vi.fn(() => []),
  dispatchNotifications: vi.fn(),
  _resetNotificationState: vi.fn(),
}));

vi.mock("../../../src/app/lib/errors", () => ({
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

let capturedFetchAll: (() => Promise<DashboardData>) | null = null;
let capturedOnHotData:
  | ((
      prUpdates: Map<number, HotPRStatusUpdate>,
      runUpdates: Map<number, HotWorkflowRunUpdate>,
      generation: number,
      epoch: number,
    ) => void)
  | null = null;
let capturedOnTargetedData: ((data: DashboardData, affectedRepos: string[], epoch: number) => void) | null = null;

let DashboardPage: typeof import("../../../src/app/components/dashboard/DashboardPage").default;
let pollService: typeof import("../../../src/app/services/poll");
let viewStore: typeof import("../../../src/app/stores/view");
let configStore: typeof import("../../../src/app/stores/config");

beforeEach(async () => {
  localStorage.clear?.();
  vi.resetModules();
  authClearCallbacks.length = 0;

  vi.doMock("../../../src/app/services/poll", () => ({
    fetchAllData: vi.fn().mockResolvedValue({
      issues: [],
      pullRequests: [],
      workflowRuns: [],
      errors: [],
    }),
    createPollCoordinator: vi.fn().mockImplementation(
      (_getInterval: unknown, fetchAll: () => Promise<DashboardData>) => {
        capturedFetchAll = fetchAll;
        void fetchAll().catch(() => {});
        return {
          isRefreshing: () => false,
          lastRefreshAt: () => null,
          manualRefresh: vi.fn(),
          destroy: vi.fn(),
        };
      },
    ),
    createHotPollCoordinator: vi.fn().mockImplementation(
      (_getInterval: unknown, onHotData: typeof capturedOnHotData) => {
        capturedOnHotData = onHotData;
        return { destroy: vi.fn() };
      },
    ),
    createEventsPollCoordinator: vi.fn().mockImplementation(
      (
        _getUsername: unknown,
        _trackedRepoNames: unknown,
        _isFullRefreshing: unknown,
        onTargetedData: typeof capturedOnTargetedData,
      ) => {
        capturedOnTargetedData = onTargetedData;
        return { destroy: vi.fn() };
      },
    ),
    rebuildHotSets: vi.fn(),
    seedHotSetsFromTargeted: vi.fn(),
    clearHotSets: vi.fn(),
    getHotPollGeneration: vi.fn().mockReturnValue(0),
    StaleIdentityError: class StaleIdentityError extends Error {
      constructor() {
        super("Stale identity");
        this.name = "StaleIdentityError";
      }
    },
  }));

  const dashboardModule = await import("../../../src/app/components/dashboard/DashboardPage");
  DashboardPage = dashboardModule.default;
  pollService = await import("../../../src/app/services/poll");
  viewStore = await import("../../../src/app/stores/view");
  configStore = await import("../../../src/app/stores/config");

  capturedFetchAll = null;
  capturedOnHotData = null;
  capturedOnTargetedData = null;
  viewStore.resetViewState();
  configStore.resetConfig();
}, 30_000);

describe("render stability — keyed reconcile store writes and stable group identity", () => {
  it("preserves PR row and repo group DOM nodes across a full poll when another PR's checkStatus changes", async () => {
    viewStore.updateViewState({ lastActiveTab: "pullRequests" });
    viewStore.setAllExpanded("pullRequests", true);

    let cycle = 0;
    vi.mocked(pollService.fetchAllData).mockImplementation(() => {
      cycle++;
      // Return freshly constructed plain arrays on every poll cycle
      return Promise.resolve({
        issues: [],
        pullRequests: [
          makePullRequest({
            id: 101,
            number: 101,
            title: "Stable PR Alpha",
            repoFullName: "owner/repo-a",
            checkStatus: "success",
            enriched: true,
          }),
          makePullRequest({
            id: 102,
            number: 102,
            title: "Changing PR Beta",
            repoFullName: "owner/repo-a",
            checkStatus: cycle === 1 ? "pending" : "failure",
            enriched: true,
          }),
          makePullRequest({
            id: 103,
            number: 103,
            title: "Other Repo PR Gamma",
            repoFullName: "owner/repo-b",
            checkStatus: "success",
            enriched: true,
          }),
        ],
        workflowRuns: [],
        errors: [],
      });
    });

    render(() => <DashboardPage />);
    await waitFor(() => {
      screen.getByText("Stable PR Alpha");
      screen.getByText("Changing PR Beta");
      screen.getByText("Other Repo PR Gamma");
    });

    const groupANode = document.querySelector('[data-repo-group="owner/repo-a"]');
    const groupBNode = document.querySelector('[data-repo-group="owner/repo-b"]');
    const alphaRow = screen.getByText("Stable PR Alpha").closest('[role="listitem"]');
    const betaRow = screen.getByText("Changing PR Beta").closest('[role="listitem"]');
    const gammaRow = screen.getByText("Other Repo PR Gamma").closest('[role="listitem"]');

    expect(groupANode).not.toBeNull();
    expect(groupBNode).not.toBeNull();
    expect(alphaRow).not.toBeNull();
    expect(betaRow).not.toBeNull();
    expect(gammaRow).not.toBeNull();
    expect(betaRow?.querySelector('[aria-label="Checks in progress"]')).not.toBeNull();

    expect(capturedFetchAll).not.toBeNull();
    await capturedFetchAll!();

    expect(document.querySelector('[data-repo-group="owner/repo-a"]')).toBe(groupANode);
    expect(document.querySelector('[data-repo-group="owner/repo-b"]')).toBe(groupBNode);
    expect(screen.getByText("Stable PR Alpha").closest('[role="listitem"]')).toBe(alphaRow);
    expect(screen.getByText("Changing PR Beta").closest('[role="listitem"]')).toBe(betaRow);
    expect(screen.getByText("Other Repo PR Gamma").closest('[role="listitem"]')).toBe(gammaRow);
    expect(betaRow?.querySelector('[aria-label="Checks failing"]')).not.toBeNull();
    expect(betaRow?.querySelector('[aria-label="Checks in progress"]')).toBeNull();
  });

  it("preserves PR row DOM nodes across the Phase 1 light-data to Phase 2 enriched transition", async () => {
    viewStore.updateViewState({ lastActiveTab: "pullRequests" });
    viewStore.setAllExpanded("pullRequests", true);

    let resolvePhaseTwo: ((data: DashboardData) => void) | null = null;
    vi.mocked(pollService.fetchAllData).mockImplementation((onLightData) => {
      onLightData?.({
        issues: [],
        pullRequests: [
          makePullRequest({
            id: 150,
            number: 150,
            title: "Two-phase PR",
            repoFullName: "owner/repo-a",
            enriched: false,
            checkStatus: null,
          }),
        ],
        workflowRuns: [],
        errors: [],
      });
      return new Promise<DashboardData>((resolve) => {
        resolvePhaseTwo = resolve;
      });
    });

    render(() => <DashboardPage />);
    await waitFor(() => {
      screen.getByText("Two-phase PR");
    });

    const rowAfterPhaseOne = screen.getByText("Two-phase PR").closest('[role="listitem"]');
    expect(rowAfterPhaseOne).not.toBeNull();
    expect(rowAfterPhaseOne?.querySelector('[aria-label="All checks passed"]')).toBeNull();

    resolvePhaseTwo!({
      issues: [],
      pullRequests: [
        makePullRequest({
          id: 150,
          number: 150,
          title: "Two-phase PR",
          repoFullName: "owner/repo-a",
          enriched: true,
          checkStatus: "success",
        }),
      ],
      workflowRuns: [],
      errors: [],
    });

    await waitFor(() => {
      expect(rowAfterPhaseOne?.querySelector('[aria-label="All checks passed"]')).not.toBeNull();
    });
    expect(screen.getByText("Two-phase PR").closest('[role="listitem"]')).toBe(rowAfterPhaseOne);
  });

  it("preserves PR row and repo group DOM nodes across a targeted-refresh (events) update", async () => {
    viewStore.updateViewState({ lastActiveTab: "pullRequests" });
    viewStore.setAllExpanded("pullRequests", true);

    vi.mocked(pollService.fetchAllData).mockImplementation(() =>
      Promise.resolve({
        issues: [],
        pullRequests: [
          makePullRequest({
            id: 101,
            number: 101,
            title: "Stable PR Alpha",
            repoFullName: "owner/repo-a",
            checkStatus: "success",
            enriched: true,
          }),
          makePullRequest({
            id: 102,
            number: 102,
            title: "Targeted PR Beta",
            repoFullName: "owner/repo-a",
            checkStatus: "pending",
            enriched: true,
          }),
          makePullRequest({
            id: 103,
            number: 103,
            title: "Unaffected PR Gamma",
            repoFullName: "owner/repo-b",
            checkStatus: "success",
            enriched: true,
          }),
        ],
        workflowRuns: [],
        errors: [],
      }),
    );

    render(() => <DashboardPage />);
    await waitFor(() => {
      screen.getByText("Stable PR Alpha");
      screen.getByText("Targeted PR Beta");
      screen.getByText("Unaffected PR Gamma");
    });

    const groupANode = document.querySelector('[data-repo-group="owner/repo-a"]');
    const groupBNode = document.querySelector('[data-repo-group="owner/repo-b"]');
    const alphaRow = screen.getByText("Stable PR Alpha").closest('[role="listitem"]');
    const betaRow = screen.getByText("Targeted PR Beta").closest('[role="listitem"]');
    const gammaRow = screen.getByText("Unaffected PR Gamma").closest('[role="listitem"]');

    expect(betaRow?.querySelector('[aria-label="Checks in progress"]')).not.toBeNull();
    expect(capturedOnTargetedData).not.toBeNull();

    // Targeted refresh for owner/repo-a with freshly constructed plain objects
    capturedOnTargetedData!(
      {
        issues: [],
        pullRequests: [
          makePullRequest({
            id: 101,
            number: 101,
            title: "Stable PR Alpha",
            repoFullName: "owner/repo-a",
            checkStatus: "success",
            enriched: true,
          }),
          makePullRequest({
            id: 102,
            number: 102,
            title: "Targeted PR Beta",
            repoFullName: "owner/repo-a",
            checkStatus: "success",
            enriched: true,
          }),
        ],
        workflowRuns: [],
        errors: [],
      },
      ["owner/repo-a"],
      0,
    );

    expect(document.querySelector('[data-repo-group="owner/repo-a"]')).toBe(groupANode);
    expect(document.querySelector('[data-repo-group="owner/repo-b"]')).toBe(groupBNode);
    expect(screen.getByText("Stable PR Alpha").closest('[role="listitem"]')).toBe(alphaRow);
    expect(screen.getByText("Targeted PR Beta").closest('[role="listitem"]')).toBe(betaRow);
    expect(screen.getByText("Unaffected PR Gamma").closest('[role="listitem"]')).toBe(gammaRow);
    expect(betaRow?.querySelector('[aria-label="All checks passed"]')).not.toBeNull();
  });

  it("preserves IssuesTab row and repo group DOM nodes across full poll and targeted refreshes", async () => {
    viewStore.updateViewState({ lastActiveTab: "issues" });
    viewStore.setAllExpanded("issues", true);

    let cycle = 0;
    vi.mocked(pollService.fetchAllData).mockImplementation(() => {
      cycle++;
      return Promise.resolve({
        issues: [
          makeIssue({
            id: 201,
            number: 201,
            title: "Stable Issue One",
            repoFullName: "owner/repo-a",
            comments: 2,
          }),
          makeIssue({
            id: 202,
            number: 202,
            title: "Updating Issue Two",
            repoFullName: "owner/repo-a",
            comments: cycle === 1 ? 3 : 9,
          }),
        ],
        pullRequests: [],
        workflowRuns: [],
        errors: [],
      });
    });

    render(() => <DashboardPage />);
    await waitFor(() => {
      screen.getByText("Stable Issue One");
      screen.getByText("Updating Issue Two");
    });

    const repoGroupNode = document.querySelector('[data-repo-group="owner/repo-a"]');
    const issue1Row = screen.getByText("Stable Issue One").closest('[role="listitem"]');
    const issue2Row = screen.getByText("Updating Issue Two").closest('[role="listitem"]');

    expect(repoGroupNode).not.toBeNull();
    expect(issue1Row).not.toBeNull();
    expect(issue2Row).not.toBeNull();

    await capturedFetchAll!();

    expect(document.querySelector('[data-repo-group="owner/repo-a"]')).toBe(repoGroupNode);
    expect(screen.getByText("Stable Issue One").closest('[role="listitem"]')).toBe(issue1Row);
    expect(screen.getByText("Updating Issue Two").closest('[role="listitem"]')).toBe(issue2Row);
    expect(issue2Row?.textContent).toContain("9");

    capturedOnTargetedData!(
      {
        issues: [
          makeIssue({
            id: 201,
            number: 201,
            title: "Stable Issue One",
            repoFullName: "owner/repo-a",
            comments: 7,
          }),
          makeIssue({
            id: 202,
            number: 202,
            title: "Updating Issue Two",
            repoFullName: "owner/repo-a",
            comments: 9,
          }),
        ],
        pullRequests: [],
        workflowRuns: [],
        errors: [],
      },
      ["owner/repo-a"],
      0,
    );

    expect(document.querySelector('[data-repo-group="owner/repo-a"]')).toBe(repoGroupNode);
    expect(screen.getByText("Stable Issue One").closest('[role="listitem"]')).toBe(issue1Row);
    expect(screen.getByText("Updating Issue Two").closest('[role="listitem"]')).toBe(issue2Row);
    expect(issue1Row?.textContent).toContain("7");
  });

  it("preserves ActionsTab workflow card and repo group DOM nodes across a run status change", async () => {
    viewStore.updateViewState({ lastActiveTab: "actions" });
    viewStore.setAllExpanded("actions", true);

    let cycle = 0;
    vi.mocked(pollService.fetchAllData).mockImplementation(() => {
      cycle++;
      return Promise.resolve({
        issues: [],
        pullRequests: [],
        workflowRuns: [
          makeWorkflowRun({
            id: 301,
            workflowId: 10,
            name: "CI Pipeline",
            repoFullName: "owner/repo-a",
            status: cycle === 1 ? "in_progress" : "completed",
            conclusion: cycle === 1 ? null : "failure",
            event: "push",
            createdAt: "2026-03-01T12:00:00Z",
          }),
          makeWorkflowRun({
            id: 302,
            workflowId: 20,
            name: "Release Build",
            repoFullName: "owner/repo-a",
            status: "completed",
            conclusion: "success",
            event: "push",
            createdAt: "2026-03-01T11:00:00Z",
          }),
        ],
        errors: [],
      });
    });

    render(() => <DashboardPage />);
    await waitFor(() => {
      screen.getByRole("button", { name: "CI Pipeline" });
      screen.getByRole("button", { name: "Release Build" });
    });

    const repoGroupNode = document.querySelector('[data-repo-group="owner/repo-a"]');
    const ciCard = screen.getByRole("button", { name: "CI Pipeline" });
    const releaseCard = screen.getByRole("button", { name: "Release Build" });

    expect(repoGroupNode).not.toBeNull();
    expect(ciCard.querySelector('[aria-label="1 running"]')).not.toBeNull();

    await capturedFetchAll!();

    expect(document.querySelector('[data-repo-group="owner/repo-a"]')).toBe(repoGroupNode);
    expect(screen.getByRole("button", { name: "CI Pipeline" })).toBe(ciCard);
    expect(screen.getByRole("button", { name: "Release Build" })).toBe(releaseCard);
    expect(ciCard.querySelector('[aria-label="1 failed"]')).not.toBeNull();
    expect(ciCard.querySelector('[aria-label="1 running"]')).toBeNull();
  });

  it("round-trips enrichment fields copied from a previous store proxy via fallbackToPreviousEnrichment through reconcile with identical values", async () => {
    // 1. Direct SolidJS store proxy -> fallbackToPreviousEnrichment -> reconcile round-trip
    const initialEnriched = makePullRequest({
      id: 401,
      number: 401,
      title: "Enriched PR",
      repoFullName: "owner/repo-a",
      updatedAt: "2026-03-01T00:00:00Z",
      enriched: true,
      additions: 42,
      deletions: 7,
      changedFiles: 3,
      comments: 4,
      reviewThreads: 2,
      checkStatus: "success",
      reviewDecision: "APPROVED",
      headSha: "abc1234def5678",
      autoMergeMethod: "SQUASH",
      reviewerLogins: ["alice", "bob"],
      totalReviewCount: 2,
      viewerReviewRequested: true,
      viewerLatestReviewState: "APPROVED",
    });

    const [store, setStore] = createStore<{ pullRequests: PullRequest[] }>({
      pullRequests: [initialEnriched],
    });
    const proxyRef = store.pullRequests[0];

    const unenrichedNext = makePullRequest({
      id: 401,
      number: 401,
      title: "Enriched PR",
      repoFullName: "owner/repo-a",
      updatedAt: "2026-03-01T00:00:00Z",
      enriched: false,
      additions: 0,
      deletions: 0,
      changedFiles: 0,
      comments: 0,
      reviewThreads: 0,
      checkStatus: null,
      reviewDecision: null,
      headSha: undefined,
      autoMergeMethod: null,
      reviewerLogins: [],
      totalReviewCount: 0,
      viewerReviewRequested: false,
      viewerLatestReviewState: null,
    });

    // Pass store proxies directly into fallbackToPreviousEnrichment, then reconcile back into the store
    const merged = fallbackToPreviousEnrichment(store.pullRequests, [unenrichedNext]);
    setStore("pullRequests", reconcile(merged, { key: "id", merge: true }));

    expect(store.pullRequests[0]).toBe(proxyRef);
    expect(unwrap(store.pullRequests[0])).toEqual(initialEnriched);

    // 2. End-to-end through DashboardPage pollFetch
    viewStore.updateViewState({ lastActiveTab: "pullRequests" });
    viewStore.setAllExpanded("pullRequests", true);

    let cycle = 0;
    vi.mocked(pollService.fetchAllData).mockImplementation(() => {
      cycle++;
      return Promise.resolve({
        issues: [],
        pullRequests: [cycle === 1 ? { ...initialEnriched, reviewerLogins: [...initialEnriched.reviewerLogins] } : { ...unenrichedNext }],
        workflowRuns: [],
        errors: [],
      });
    });

    render(() => <DashboardPage />);
    await waitFor(() => {
      screen.getByText("Enriched PR");
    });

    const rowBefore = screen.getByText("Enriched PR").closest('[role="listitem"]');
    expect(rowBefore).not.toBeNull();
    expect(rowBefore?.querySelector('[aria-label="All checks passed"]')).not.toBeNull();

    const poll2Result = await capturedFetchAll!();

    expect(screen.getByText("Enriched PR").closest('[role="listitem"]')).toBe(rowBefore);
    expect(rowBefore?.querySelector('[aria-label="All checks passed"]')).not.toBeNull();
    expect(poll2Result.pullRequests[0]).toEqual(initialEnriched);
  });
});
