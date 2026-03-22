import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  canNotify,
  detectNewItems,
  dispatchNotifications,
  _resetNotificationState,
  type NewItems,
} from "../../src/app/lib/notifications";
import type { Config } from "../../src/app/stores/config";
import type { DashboardData } from "../../src/app/services/poll";
import type { Issue, PullRequest, WorkflowRun } from "../../src/app/services/api";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<Config["notifications"]> = {}): Config {
  return {
    selectedOrgs: [],
    selectedRepos: [],
    refreshInterval: 300,
    maxWorkflowsPerRepo: 5,
    maxRunsPerWorkflow: 3,
    notifications: {
      enabled: true,
      issues: true,
      pullRequests: true,
      workflowRuns: true,
      ...overrides,
    },
    theme: "system",
    viewDensity: "comfortable",
    itemsPerPage: 25,
    defaultTab: "issues",
    rememberLastTab: true,
    onboardingComplete: false,
  };
}

function makeIssue(id: number): Issue {
  return {
    id,
    number: id,
    title: `Issue ${id}`,
    state: "open",
    htmlUrl: `https://github.com/owner/repo/issues/${id}`,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    userLogin: "user",
    userAvatarUrl: "https://github.com/images/error/octocat_happy.gif",
    labels: [],
    assigneeLogins: [],
    repoFullName: "owner/repo",
    comments: 0,
  };
}

function makePr(id: number): PullRequest {
  return {
    id,
    number: id,
    title: `PR ${id}`,
    state: "open",
    draft: false,
    htmlUrl: `https://github.com/owner/repo/pull/${id}`,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    userLogin: "user",
    userAvatarUrl: "https://github.com/images/error/octocat_happy.gif",
    headSha: "abc123",
    headRef: "feat/branch",
    baseRef: "main",
    assigneeLogins: [],
    reviewerLogins: [],
    repoFullName: "owner/repo",
    checkStatus: null,
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    comments: 0,
    reviewComments: 0,
    labels: [],
    reviewDecision: null,
    totalReviewCount: 0,
  };
}

function makeRun(id: number): WorkflowRun {
  return {
    id,
    name: `Workflow ${id}`,
    status: "completed",
    conclusion: "success",
    event: "push",
    workflowId: 1,
    headSha: "abc123",
    headBranch: "main",
    runNumber: id,
    htmlUrl: `https://github.com/owner/repo/actions/runs/${id}`,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    repoFullName: "owner/repo",
    isPrRun: false,
    runStartedAt: "2024-01-01T00:00:00Z",
    completedAt: "2024-01-01T00:05:00Z",
    runAttempt: 1,
    displayTitle: `Workflow ${id}`,
    actorLogin: "user",
  };
}

function makeData(
  issues: Issue[] = [],
  pullRequests: PullRequest[] = [],
  workflowRuns: WorkflowRun[] = []
): DashboardData {
  return { issues, pullRequests, workflowRuns, errors: [] };
}

// ── canNotify ─────────────────────────────────────────────────────────────────

describe("canNotify", () => {
  beforeEach(() => {
    Object.defineProperty(window, "Notification", {
      value: { permission: "granted" },
      writable: true,
      configurable: true,
    });
  });

  it("returns true when permission granted and enabled", () => {
    expect(canNotify(makeConfig())).toBe(true);
  });

  it("returns false when permission denied", () => {
    Object.defineProperty(window, "Notification", {
      value: { permission: "denied" },
      writable: true,
      configurable: true,
    });
    expect(canNotify(makeConfig())).toBe(false);
  });

  it("returns false when notifications disabled in config", () => {
    expect(canNotify(makeConfig({ enabled: false }))).toBe(false);
  });
});

// ── detectNewItems ────────────────────────────────────────────────────────────

describe("detectNewItems", () => {
  beforeEach(() => {
    _resetNotificationState();
  });

  it("returns no new items on first call (initialization pass)", () => {
    const result = detectNewItems(makeData([makeIssue(1)], [makePr(1)], [makeRun(1)]));
    expect(result.issues).toHaveLength(0);
    expect(result.pullRequests).toHaveLength(0);
    expect(result.workflowRuns).toHaveLength(0);
  });

  it("detects new items on second call", () => {
    // First call: initialize
    detectNewItems(makeData([makeIssue(1)]));
    // Second call: new item
    const result = detectNewItems(makeData([makeIssue(1), makeIssue(2)]));
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].id).toBe(2);
  });

  it("does not report same item twice", () => {
    detectNewItems(makeData([makeIssue(1)]));
    detectNewItems(makeData([makeIssue(1), makeIssue(2)]));
    const result = detectNewItems(makeData([makeIssue(1), makeIssue(2)]));
    expect(result.issues).toHaveLength(0);
  });

  it("detects new PRs independently from issues", () => {
    detectNewItems(makeData([], [makePr(10)]));
    const result = detectNewItems(makeData([], [makePr(10), makePr(11)]));
    expect(result.pullRequests).toHaveLength(1);
    expect(result.pullRequests[0].id).toBe(11);
  });

  it("detects new workflow runs", () => {
    detectNewItems(makeData([], [], [makeRun(100)]));
    const result = detectNewItems(makeData([], [], [makeRun(100), makeRun(101)]));
    expect(result.workflowRuns).toHaveLength(1);
    expect(result.workflowRuns[0].id).toBe(101);
  });

  it("handles all three types simultaneously", () => {
    detectNewItems(makeData([makeIssue(1)], [makePr(1)], [makeRun(1)]));
    const result = detectNewItems(
      makeData([makeIssue(1), makeIssue(2)], [makePr(1), makePr(2)], [makeRun(1), makeRun(2)])
    );
    expect(result.issues).toHaveLength(1);
    expect(result.pullRequests).toHaveLength(1);
    expect(result.workflowRuns).toHaveLength(1);
  });
});

// ── dispatchNotifications ─────────────────────────────────────────────────────

describe("dispatchNotifications", () => {
  let NotificationMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    NotificationMock = vi.fn();
    // Mock onclick assignment
    NotificationMock.prototype = { onclick: null };

    Object.defineProperty(window, "Notification", {
      value: Object.assign(NotificationMock, { permission: "granted" }),
      writable: true,
      configurable: true,
    });
  });

  function makeNewItems(overrides: Partial<NewItems> = {}): NewItems {
    return {
      issues: [],
      pullRequests: [],
      workflowRuns: [],
      ...overrides,
    };
  }

  it("does nothing when canNotify is false", () => {
    const config = makeConfig({ enabled: false });
    dispatchNotifications(makeNewItems({ issues: [makeIssue(1)] }), config);
    expect(NotificationMock).not.toHaveBeenCalled();
  });

  it("fires individual notification for a single new issue", () => {
    dispatchNotifications(makeNewItems({ issues: [makeIssue(1)] }), makeConfig());
    expect(NotificationMock).toHaveBeenCalledTimes(1);
    expect(NotificationMock.mock.calls[0][0]).toContain("Issue 1");
  });

  it("fires batch notification when issues exceed threshold (>5)", () => {
    const issues = [1, 2, 3, 4, 5, 6].map(makeIssue);
    dispatchNotifications(makeNewItems({ issues }), makeConfig());
    expect(NotificationMock).toHaveBeenCalledTimes(1);
    expect(NotificationMock.mock.calls[0][0]).toMatch(/6 new issues/);
  });

  it("does not fire issue notifications when issues toggle is off", () => {
    dispatchNotifications(
      makeNewItems({ issues: [makeIssue(1)] }),
      makeConfig({ issues: false })
    );
    expect(NotificationMock).not.toHaveBeenCalled();
  });

  it("fires individual notification for a single new PR", () => {
    dispatchNotifications(makeNewItems({ pullRequests: [makePr(1)] }), makeConfig());
    expect(NotificationMock).toHaveBeenCalledTimes(1);
    expect(NotificationMock.mock.calls[0][0]).toContain("PR 1");
  });

  it("fires batch notification when PRs exceed threshold (>5)", () => {
    const prs = [1, 2, 3, 4, 5, 6].map(makePr);
    dispatchNotifications(makeNewItems({ pullRequests: prs }), makeConfig());
    expect(NotificationMock).toHaveBeenCalledTimes(1);
    expect(NotificationMock.mock.calls[0][0]).toMatch(/6 new pull requests/);
  });

  it("fires individual notification for a single new workflow run", () => {
    dispatchNotifications(makeNewItems({ workflowRuns: [makeRun(1)] }), makeConfig());
    expect(NotificationMock).toHaveBeenCalledTimes(1);
    expect(NotificationMock.mock.calls[0][0]).toContain("Workflow 1");
  });

  it("fires batch notification when runs exceed threshold (>5)", () => {
    const runs = [1, 2, 3, 4, 5, 6].map(makeRun);
    dispatchNotifications(makeNewItems({ workflowRuns: runs }), makeConfig());
    expect(NotificationMock).toHaveBeenCalledTimes(1);
    expect(NotificationMock.mock.calls[0][0]).toMatch(/6 new workflow runs/);
  });

  it("does not fire run notifications when workflowRuns toggle is off", () => {
    dispatchNotifications(
      makeNewItems({ workflowRuns: [makeRun(1)] }),
      makeConfig({ workflowRuns: false })
    );
    expect(NotificationMock).not.toHaveBeenCalled();
  });

  it("onclick handler opens github.com URL", () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    const focusSpy = vi.spyOn(window, "focus").mockImplementation(() => undefined);

    let capturedOnClick: (() => void) | undefined;
    NotificationMock.mockImplementation(function (this: { onclick: unknown }) {
      Object.defineProperty(this, "onclick", {
        get: () => capturedOnClick,
        set: (fn: () => void) => { capturedOnClick = fn; },
        configurable: true,
      });
    });

    dispatchNotifications(makeNewItems({ issues: [makeIssue(1)] }), makeConfig());

    expect(capturedOnClick).toBeDefined();
    capturedOnClick!();
    expect(focusSpy).toHaveBeenCalled();
    expect(openSpy).toHaveBeenCalledWith(
      "https://github.com/owner/repo/issues/1",
      "_blank",
      "noopener,noreferrer"
    );

    openSpy.mockRestore();
    focusSpy.mockRestore();
  });
});
