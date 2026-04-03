import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { makeIssue, makePullRequest, makeWorkflowRun, resetViewStore } from "../../helpers/index";
import PersonalSummaryStrip from "../../../src/app/components/dashboard/PersonalSummaryStrip";
import IssuesTab from "../../../src/app/components/dashboard/IssuesTab";
import PullRequestsTab from "../../../src/app/components/dashboard/PullRequestsTab";
import type { Issue, PullRequest, WorkflowRun } from "../../../src/app/services/api";
import { viewState, updateViewState, setAllExpanded, ignoreItem } from "../../../src/app/stores/view";

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  resetViewStore();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function renderStrip(opts: {
  issues?: Issue[];
  pullRequests?: PullRequest[];
  workflowRuns?: WorkflowRun[];
  userLogin?: string;
  onTabChange?: (tab: "issues" | "pullRequests" | "actions") => void;
}) {
  const onTabChange = opts.onTabChange ?? vi.fn();
  return render(() => (
    <PersonalSummaryStrip
      issues={opts.issues ?? []}
      pullRequests={opts.pullRequests ?? []}
      workflowRuns={opts.workflowRuns ?? []}
      userLogin={opts.userLogin ?? "me"}
      onTabChange={onTabChange}
    />
  ));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("PersonalSummaryStrip — empty state", () => {
  it("renders nothing when there are no actionable counts", () => {
    const { container } = renderStrip({});
    // Strip should not render when all counts are zero — container inner div is empty
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when issues have no assignees", () => {
    const issues = [makeIssue({ assigneeLogins: [] })];
    const { container } = renderStrip({ issues });
    expect(container.innerHTML).toBe("");
  });
});

describe("PersonalSummaryStrip — assigned issues", () => {
  it("shows assigned issues count when user is assigned", () => {
    const issues = [
      makeIssue({ assigneeLogins: ["me"] }),
      makeIssue({ assigneeLogins: ["me"] }),
    ];

    renderStrip({ issues });

    expect(screen.getByText("2")).toBeDefined();
    expect(screen.getByText(/assigned/)).toBeDefined();
  });

  it("does not count issues where user is not assigned", () => {
    const issues = [
      makeIssue({ assigneeLogins: ["other-user"] }),
    ];

    const { container } = renderStrip({ issues });
    expect(container.innerHTML).toBe("");
  });

  it("uses case-insensitive comparison for assignee login", () => {
    const issues = [makeIssue({ assigneeLogins: ["ME"] })];

    renderStrip({ issues, userLogin: "me" });
    expect(screen.getByText(/assigned/)).toBeDefined();
  });
});

describe("PersonalSummaryStrip — PRs awaiting review", () => {
  it("shows awaiting review count for enriched PRs where user is reviewer with REVIEW_REQUIRED", () => {
    const prs = [
      makePullRequest({
        enriched: true,
        reviewDecision: "REVIEW_REQUIRED",
        reviewerLogins: ["me"],
        userLogin: "author",
      }),
    ];

    renderStrip({ pullRequests: prs });
    expect(screen.getByText(/awaiting review/)).toBeDefined();
  });

  it("does not count unenriched PRs for awaiting review (enrichment gate)", () => {
    const prs = [
      makePullRequest({
        enriched: false,
        reviewDecision: "REVIEW_REQUIRED",
        reviewerLogins: ["me"],
        userLogin: "author",
      }),
    ];

    const { container } = renderStrip({ pullRequests: prs });
    expect(container.innerHTML).toBe("");
  });

  it("does not count PRs where user is not a reviewer", () => {
    const prs = [
      makePullRequest({
        enriched: true,
        reviewDecision: "REVIEW_REQUIRED",
        reviewerLogins: ["other"],
        userLogin: "author",
      }),
    ];

    const { container } = renderStrip({ pullRequests: prs });
    expect(container.innerHTML).toBe("");
  });

  it("does not count PRs with non-REVIEW_REQUIRED decision", () => {
    const prs = [
      makePullRequest({
        enriched: true,
        reviewDecision: "APPROVED",
        reviewerLogins: ["me"],
        userLogin: "author",
      }),
    ];

    const { container } = renderStrip({ pullRequests: prs });
    expect(container.innerHTML).toBe("");
  });
});

describe("PersonalSummaryStrip — PRs ready to merge", () => {
  it("shows ready to merge count for user's authored PRs with checkStatus=success and APPROVED", () => {
    const prs = [
      makePullRequest({
        userLogin: "me",
        draft: false,
        checkStatus: "success",
        reviewDecision: "APPROVED",
      }),
    ];

    renderStrip({ pullRequests: prs });
    expect(screen.getByText(/ready to merge/)).toBeDefined();
  });

  it("shows ready to merge when reviewDecision is null (no review policy)", () => {
    const prs = [
      makePullRequest({
        userLogin: "me",
        draft: false,
        checkStatus: "success",
        reviewDecision: null,
      }),
    ];

    renderStrip({ pullRequests: prs });
    expect(screen.getByText(/ready to merge/)).toBeDefined();
  });

  it("does not count PRs authored by other users", () => {
    const prs = [
      makePullRequest({
        userLogin: "other-user",
        draft: false,
        checkStatus: "success",
        reviewDecision: "APPROVED",
      }),
    ];

    const { container } = renderStrip({ pullRequests: prs });
    expect(container.innerHTML).toBe("");
  });

  it("does not count draft PRs as ready to merge", () => {
    const prs = [
      makePullRequest({
        userLogin: "me",
        draft: true,
        checkStatus: "success",
        reviewDecision: "APPROVED",
      }),
    ];

    const { container } = renderStrip({ pullRequests: prs });
    expect(container.innerHTML).toBe("");
  });

  it("does not count PRs with non-success checkStatus", () => {
    const prs = [
      makePullRequest({
        userLogin: "me",
        draft: false,
        checkStatus: "failure",
        reviewDecision: "APPROVED",
      }),
    ];

    renderStrip({ pullRequests: prs });
    // Should show blocked, not ready to merge
    expect(screen.queryByText(/ready to merge/)).toBeNull();
  });
});

describe("PersonalSummaryStrip — PRs blocked", () => {
  it("shows blocked count for user's authored non-draft PRs with checkStatus=failure", () => {
    const prs = [
      makePullRequest({
        userLogin: "me",
        draft: false,
        checkStatus: "failure",
      }),
    ];

    renderStrip({ pullRequests: prs });
    expect(screen.getByText(/blocked/)).toBeDefined();
  });

  it("shows blocked count for user's authored non-draft PRs with checkStatus=conflict", () => {
    const prs = [
      makePullRequest({
        userLogin: "me",
        draft: false,
        checkStatus: "conflict",
      }),
    ];

    renderStrip({ pullRequests: prs });
    expect(screen.getByText(/blocked/)).toBeDefined();
  });

  it("does not count draft PRs with failing CI as blocked", () => {
    const prs = [
      makePullRequest({
        userLogin: "me",
        draft: true,
        checkStatus: "failure",
      }),
    ];

    const { container } = renderStrip({ pullRequests: prs });
    expect(container.innerHTML).toBe("");
  });

  it("does not count other user's blocked PRs", () => {
    const prs = [
      makePullRequest({
        userLogin: "other",
        draft: false,
        checkStatus: "failure",
      }),
    ];

    const { container } = renderStrip({ pullRequests: prs });
    expect(container.innerHTML).toBe("");
  });
});

describe("PersonalSummaryStrip — running actions", () => {
  it("shows running count for in_progress workflow runs", () => {
    const runs = [
      makeWorkflowRun({ status: "in_progress" }),
      makeWorkflowRun({ status: "in_progress" }),
    ];

    renderStrip({ workflowRuns: runs });
    expect(screen.getByText(/running/)).toBeDefined();
    // Count is 2
    expect(screen.getByText("2")).toBeDefined();
  });

  it("does not count completed workflow runs", () => {
    const runs = [
      makeWorkflowRun({ status: "completed" }),
    ];

    const { container } = renderStrip({ workflowRuns: runs });
    expect(container.innerHTML).toBe("");
  });
});

describe("PersonalSummaryStrip — click behavior", () => {
  it("clicking assigned count calls onTabChange with 'issues'", () => {
    const onTabChange = vi.fn();
    const issues = [makeIssue({ assigneeLogins: ["me"] })];

    renderStrip({ issues, onTabChange });

    const button = screen.getByText(/assigned/);
    fireEvent.click(button);
    expect(onTabChange).toHaveBeenCalledWith("issues");
  });

  it("clicking awaiting review calls onTabChange with 'pullRequests'", () => {
    const onTabChange = vi.fn();
    const prs = [
      makePullRequest({
        enriched: true,
        reviewDecision: "REVIEW_REQUIRED",
        reviewerLogins: ["me"],
        userLogin: "author",
      }),
    ];

    renderStrip({ pullRequests: prs, onTabChange });

    const button = screen.getByText(/awaiting review/);
    fireEvent.click(button);
    expect(onTabChange).toHaveBeenCalledWith("pullRequests");
  });

  it("clicking running actions calls onTabChange with 'actions' and sets conclusion=running", () => {
    const onTabChange = vi.fn();
    const runs = [makeWorkflowRun({ status: "in_progress" })];

    renderStrip({ workflowRuns: runs, onTabChange });

    const button = screen.getByText(/running/);
    fireEvent.click(button);
    expect(onTabChange).toHaveBeenCalledWith("actions");
    expect(viewState.tabFilters.actions.conclusion).toBe("running");
  });
});

describe("PersonalSummaryStrip — mixed state", () => {
  it("only shows non-zero counts", () => {
    const issues = [makeIssue({ assigneeLogins: ["me"] })];
    // No blocked PRs, no awaiting review, no running actions

    renderStrip({ issues });

    expect(screen.getByText(/assigned/)).toBeDefined();
    expect(screen.queryByText(/awaiting review/)).toBeNull();
    expect(screen.queryByText(/ready to merge/)).toBeNull();
    expect(screen.queryByText(/blocked/)).toBeNull();
    expect(screen.queryByText(/running/)).toBeNull();
  });

  it("shows multiple counts when they are all non-zero", () => {
    const issues = [makeIssue({ assigneeLogins: ["me"] })];
    const runs = [makeWorkflowRun({ status: "in_progress" })];

    renderStrip({ issues, workflowRuns: runs });

    expect(screen.getByText(/assigned/)).toBeDefined();
    expect(screen.getByText(/running/)).toBeDefined();
  });
});

describe("PersonalSummaryStrip — label context", () => {
  it("shows 'issue assigned' (singular) for 1 assigned issue", () => {
    const issues = [makeIssue({ assigneeLogins: ["me"] })];
    renderStrip({ issues });
    screen.getByText(/issue assigned/);
  });

  it("shows 'issues assigned' (plural) for multiple assigned issues", () => {
    const issues = [
      makeIssue({ id: 1, assigneeLogins: ["me"] }),
      makeIssue({ id: 2, assigneeLogins: ["me"] }),
    ];
    renderStrip({ issues });
    screen.getByText(/issues assigned/);
  });

  it("shows 'PR awaiting review' for 1 PR", () => {
    const prs = [makePullRequest({ enriched: true, reviewDecision: "REVIEW_REQUIRED", reviewerLogins: ["me"], userLogin: "author" })];
    renderStrip({ pullRequests: prs });
    screen.getByText(/PR awaiting review/);
  });

  it("shows 'PRs blocked' for multiple blocked PRs", () => {
    const prs = [
      makePullRequest({ id: 1, userLogin: "me", draft: false, checkStatus: "failure" }),
      makePullRequest({ id: 2, userLogin: "me", draft: false, checkStatus: "conflict" }),
    ];
    renderStrip({ pullRequests: prs });
    screen.getByText(/PRs blocked/);
  });

  it("shows 'action running' for 1 running action", () => {
    const runs = [makeWorkflowRun({ status: "in_progress" })];
    renderStrip({ workflowRuns: runs });
    screen.getByText(/action running/);
  });
});

describe("PersonalSummaryStrip — cor-2: excludes self-authored PRs from awaiting review", () => {
  it("does not count PRs authored by the user as awaiting review even if user is in reviewerLogins", () => {
    const prs = [
      makePullRequest({
        enriched: true,
        reviewDecision: "REVIEW_REQUIRED",
        reviewerLogins: ["me"],
        userLogin: "me",
      }),
    ];

    const { container } = renderStrip({ pullRequests: prs });
    expect(container.textContent).not.toContain("awaiting review");
  });
});

describe("PersonalSummaryStrip — empty userLogin", () => {
  it("renders nothing for issue/PR counts when userLogin is empty", () => {
    const issues = [makeIssue({ assigneeLogins: ["me"] })];
    const { container } = renderStrip({ issues, userLogin: "" });
    expect(container.innerHTML).toBe("");
  });

  it("still shows running actions count when userLogin is empty", () => {
    const runs = [makeWorkflowRun({ status: "in_progress" })];
    renderStrip({ workflowRuns: runs, userLogin: "" });
    screen.getByText(/running/);
  });
});

describe("PersonalSummaryStrip — click applies filters", () => {
  it("clicking assigned issues sets scope=all and role=assignee", () => {
    const onTabChange = vi.fn();
    const issues = [makeIssue({ assigneeLogins: ["me"] })];

    renderStrip({ issues, onTabChange });

    const button = screen.getByText(/assigned/);
    fireEvent.click(button);

    expect(onTabChange).toHaveBeenCalledWith("issues");
    expect(viewState.tabFilters.issues.scope).toBe("all");
    expect(viewState.tabFilters.issues.role).toBe("assignee");
  });

  it("clicking awaiting review sets scope=all, role=reviewer, reviewDecision=REVIEW_REQUIRED", () => {
    const onTabChange = vi.fn();
    const prs = [makePullRequest({ enriched: true, reviewDecision: "REVIEW_REQUIRED", reviewerLogins: ["me"], userLogin: "author" })];

    renderStrip({ pullRequests: prs, onTabChange });

    const button = screen.getByText(/awaiting review/);
    fireEvent.click(button);

    expect(onTabChange).toHaveBeenCalledWith("pullRequests");
    expect(viewState.tabFilters.pullRequests.scope).toBe("all");
    expect(viewState.tabFilters.pullRequests.role).toBe("reviewer");
    expect(viewState.tabFilters.pullRequests.reviewDecision).toBe("REVIEW_REQUIRED");
  });

  it("clicking ready to merge sets scope=all, role=author, draft=ready, checkStatus=success, reviewDecision=mergeable", () => {
    const onTabChange = vi.fn();
    const prs = [makePullRequest({ userLogin: "me", draft: false, checkStatus: "success", reviewDecision: "APPROVED" })];

    renderStrip({ pullRequests: prs, onTabChange });

    const button = screen.getByText(/ready to merge/);
    fireEvent.click(button);

    expect(onTabChange).toHaveBeenCalledWith("pullRequests");
    expect(viewState.tabFilters.pullRequests.scope).toBe("all");
    expect(viewState.tabFilters.pullRequests.role).toBe("author");
    expect(viewState.tabFilters.pullRequests.draft).toBe("ready");
    expect(viewState.tabFilters.pullRequests.checkStatus).toBe("success");
    expect(viewState.tabFilters.pullRequests.reviewDecision).toBe("mergeable");
  });

  it("clicking blocked sets scope=all, role=author, draft=ready, checkStatus=blocked", () => {
    const onTabChange = vi.fn();
    const prs = [makePullRequest({ userLogin: "me", draft: false, checkStatus: "failure" })];

    renderStrip({ pullRequests: prs, onTabChange });

    const button = screen.getByText(/blocked/);
    fireEvent.click(button);

    expect(onTabChange).toHaveBeenCalledWith("pullRequests");
    expect(viewState.tabFilters.pullRequests.scope).toBe("all");
    expect(viewState.tabFilters.pullRequests.role).toBe("author");
    expect(viewState.tabFilters.pullRequests.draft).toBe("ready");
    expect(viewState.tabFilters.pullRequests.checkStatus).toBe("blocked");
  });
});

// ── Integration: summary count matches filtered tab view ──────────────────
// These tests render the summary strip, click a count, then render the tab
// with the same data and verify the number of visible items matches the count.

describe("PersonalSummaryStrip — count-to-filter contract", () => {
  const userLogin = "me";

  // Realistic mixed dataset
  const mixedPRs: PullRequest[] = [
    // PR authored by me, passing CI, approved → ready to merge
    makePullRequest({ id: 1, title: "Ready PR", repoFullName: "org/repo-a", userLogin: "me", draft: false, checkStatus: "success", reviewDecision: "APPROVED", surfacedBy: ["me"], enriched: true, reviewerLogins: [] }),
    // PR authored by me, conflict → blocked
    makePullRequest({ id: 2, title: "Conflict PR", repoFullName: "org/repo-a", userLogin: "me", draft: false, checkStatus: "conflict", reviewDecision: null, surfacedBy: ["me"], enriched: true, reviewerLogins: [] }),
    // PR authored by me, failing CI → blocked
    makePullRequest({ id: 3, title: "Failing PR", repoFullName: "org/repo-b", userLogin: "me", draft: false, checkStatus: "failure", reviewDecision: null, surfacedBy: ["me"], enriched: true, reviewerLogins: [] }),
    // PR authored by someone else, I'm a reviewer, needs review → awaiting review
    makePullRequest({ id: 4, title: "Review PR", repoFullName: "org/repo-c", userLogin: "other-author", draft: false, checkStatus: "pending", reviewDecision: "REVIEW_REQUIRED", surfacedBy: ["other-author"], enriched: true, reviewerLogins: ["me"] }),
    // PR authored by me, draft with failing CI → NOT blocked (draft excluded)
    makePullRequest({ id: 5, title: "Draft PR", repoFullName: "org/repo-a", userLogin: "me", draft: true, checkStatus: "failure", reviewDecision: null, surfacedBy: ["me"], enriched: true, reviewerLogins: [] }),
    // PR authored by me, passing CI, but CHANGES_REQUESTED → NOT ready to merge
    makePullRequest({ id: 7, title: "Changes Requested PR", repoFullName: "org/repo-a", userLogin: "me", draft: false, checkStatus: "success", reviewDecision: "CHANGES_REQUESTED", surfacedBy: ["me"], enriched: true, reviewerLogins: [] }),
    // PR from tracked user, user not involved → only visible in scope=all
    makePullRequest({ id: 6, title: "Tracked PR", repoFullName: "org/repo-d", userLogin: "tracked-user", draft: false, checkStatus: "success", reviewDecision: "APPROVED", surfacedBy: ["tracked-user"], enriched: true, reviewerLogins: [] }),
  ];

  const mixedIssues: Issue[] = [
    // Issue where me is assignee
    makeIssue({ id: 101, title: "Assigned issue", repoFullName: "org/repo-a", assigneeLogins: ["me"], surfacedBy: ["me"] }),
    // Issue where me is NOT assignee
    makeIssue({ id: 102, title: "Other issue", repoFullName: "org/repo-b", assigneeLogins: ["other"], surfacedBy: ["me"] }),
  ];

  it("'blocked' count matches PullRequestsTab filtered view (failure + conflict, non-draft)", () => {
    const onTabChange = vi.fn();
    const { unmount } = render(() => (
      <PersonalSummaryStrip
        issues={[]} pullRequests={mixedPRs} workflowRuns={[]}
        userLogin={userLogin} onTabChange={onTabChange}
      />
    ));

    // Summary should show 2 blocked (ids 2 + 3, not draft id 5)
    const blockedButton = screen.getByText(/blocked/);
    expect(blockedButton.textContent).toContain("2");

    // Click it — applies filters
    fireEvent.click(blockedButton);
    unmount();

    // Render PullRequestsTab with same data and applied filters
    setAllExpanded("pullRequests", ["org/repo-a", "org/repo-b", "org/repo-c", "org/repo-d"], true);
    render(() => (
      <PullRequestsTab pullRequests={mixedPRs} userLogin={userLogin} monitoredRepos={[]} />
    ));

    // Should see exactly the 2 blocked PRs
    screen.getByText("Conflict PR");
    screen.getByText("Failing PR");
    expect(screen.queryByText("Ready PR")).toBeNull();
    expect(screen.queryByText("Draft PR")).toBeNull();
    expect(screen.queryByText("Tracked PR")).toBeNull();
    expect(screen.queryByText("Review PR")).toBeNull();
  });

  it("'awaiting review' count matches PullRequestsTab filtered view", () => {
    const onTabChange = vi.fn();
    const { unmount } = render(() => (
      <PersonalSummaryStrip
        issues={[]} pullRequests={mixedPRs} workflowRuns={[]}
        userLogin={userLogin} onTabChange={onTabChange}
      />
    ));

    const reviewButton = screen.getByText(/awaiting review/);
    expect(reviewButton.textContent).toContain("1");
    fireEvent.click(reviewButton);
    unmount();

    setAllExpanded("pullRequests", ["org/repo-a", "org/repo-b", "org/repo-c", "org/repo-d"], true);
    render(() => (
      <PullRequestsTab pullRequests={mixedPRs} userLogin={userLogin} monitoredRepos={[]}
        allUsers={[{ login: "me", label: "Me" }, { login: "other-author", label: "other-author" }]}
      />
    ));

    screen.getByText("Review PR");
    expect(screen.queryByText("Ready PR")).toBeNull();
    expect(screen.queryByText("Conflict PR")).toBeNull();
  });

  it("'ready to merge' count matches PullRequestsTab filtered view", () => {
    const onTabChange = vi.fn();
    const { unmount } = render(() => (
      <PersonalSummaryStrip
        issues={[]} pullRequests={mixedPRs} workflowRuns={[]}
        userLogin={userLogin} onTabChange={onTabChange}
      />
    ));

    const mergeButton = screen.getByText(/ready to merge/);
    expect(mergeButton.textContent).toContain("1");
    fireEvent.click(mergeButton);
    unmount();

    setAllExpanded("pullRequests", ["org/repo-a", "org/repo-b", "org/repo-c", "org/repo-d"], true);
    render(() => (
      <PullRequestsTab pullRequests={mixedPRs} userLogin={userLogin} monitoredRepos={[]} />
    ));

    screen.getByText("Ready PR");
    expect(screen.queryByText("Conflict PR")).toBeNull();
    expect(screen.queryByText("Failing PR")).toBeNull();
    expect(screen.queryByText("Changes Requested PR")).toBeNull();
  });

  it("'assigned' count matches IssuesTab filtered view", () => {
    const onTabChange = vi.fn();
    const { unmount } = render(() => (
      <PersonalSummaryStrip
        issues={mixedIssues} pullRequests={[]} workflowRuns={[]}
        userLogin={userLogin} onTabChange={onTabChange}
      />
    ));

    const assignedButton = screen.getByText(/assigned/);
    expect(assignedButton.textContent).toContain("1");
    fireEvent.click(assignedButton);
    unmount();

    setAllExpanded("issues", ["org/repo-a", "org/repo-b"], true);
    render(() => (
      <IssuesTab issues={mixedIssues} userLogin={userLogin} monitoredRepos={[]} />
    ));

    screen.getByText("Assigned issue");
    expect(screen.queryByText("Other issue")).toBeNull();
  });

  it("'blocked' count includes PRs from tracked-user-only repos (surfacedBy excludes current user)", () => {
    // PR authored by me in a repo only surfaced by a tracked user
    const trackedOnlyPRs: PullRequest[] = [
      makePullRequest({ id: 10, title: "Tracked-only blocked PR", repoFullName: "org/tracked-repo", userLogin: "me", draft: false, checkStatus: "conflict", surfacedBy: ["tracked-user"], enriched: true, reviewerLogins: [] }),
    ];

    const onTabChange = vi.fn();
    const { unmount } = render(() => (
      <PersonalSummaryStrip
        issues={[]} pullRequests={trackedOnlyPRs} workflowRuns={[]}
        userLogin={userLogin} onTabChange={onTabChange}
      />
    ));

    const blockedButton = screen.getByText(/blocked/);
    expect(blockedButton.textContent).toContain("1");
    fireEvent.click(blockedButton);
    unmount();

    setAllExpanded("pullRequests", ["org/tracked-repo"], true);
    render(() => (
      <PullRequestsTab pullRequests={trackedOnlyPRs} userLogin={userLogin} monitoredRepos={[]}
        allUsers={[{ login: "me", label: "Me" }, { login: "tracked-user", label: "tracked-user" }]}
      />
    ));

    // Must be visible — scope=all ensures surfacedBy doesn't filter it out
    screen.getByText("Tracked-only blocked PR");
  });
});

// ── Ignored items exclusion ───────────────────────────────────────────────

describe("PersonalSummaryStrip — excludes ignored items", () => {
  it("does not count ignored PRs in awaiting review", () => {
    const prs = [
      makePullRequest({ id: 99, enriched: true, reviewDecision: "REVIEW_REQUIRED", reviewerLogins: ["me"], userLogin: "author" }),
    ];
    ignoreItem({ id: "99", type: "pullRequest", repo: "org/repo", title: "Ignored PR", ignoredAt: Date.now() });

    const { container } = renderStrip({ pullRequests: prs });
    expect(container.textContent).not.toContain("awaiting review");
  });

  it("does not count ignored PRs in blocked", () => {
    const prs = [
      makePullRequest({ id: 50, userLogin: "me", draft: false, checkStatus: "failure" }),
    ];
    ignoreItem({ id: "50", type: "pullRequest", repo: "org/repo", title: "Ignored blocked", ignoredAt: Date.now() });

    const { container } = renderStrip({ pullRequests: prs });
    expect(container.textContent).not.toContain("blocked");
  });

  it("does not count ignored issues in assigned", () => {
    const issues = [
      makeIssue({ id: 200, assigneeLogins: ["me"] }),
    ];
    ignoreItem({ id: "200", type: "issue", repo: "org/repo", title: "Ignored issue", ignoredAt: Date.now() });

    const { container } = renderStrip({ issues });
    expect(container.innerHTML).toBe("");
  });

  it("still counts non-ignored items when some are ignored", () => {
    const prs = [
      makePullRequest({ id: 1, userLogin: "me", draft: false, checkStatus: "failure" }),
      makePullRequest({ id: 2, userLogin: "me", draft: false, checkStatus: "conflict" }),
    ];
    ignoreItem({ id: "1", type: "pullRequest", repo: "org/repo", title: "Ignored", ignoredAt: Date.now() });

    renderStrip({ pullRequests: prs });
    const blockedButton = screen.getByText(/blocked/);
    expect(blockedButton.textContent).toContain("1");
  });
});

describe("PersonalSummaryStrip — hideDepDashboard exclusion", () => {
  it("excludes Dependency Dashboard issues from assigned count when hideDepDashboard is true", () => {
    const issues = [
      makeIssue({ id: 1, title: "Dependency Dashboard", assigneeLogins: ["me"] }),
    ];
    // hideDepDashboard defaults to true via resetViewStore

    const { container } = renderStrip({ issues });
    expect(container.innerHTML).toBe("");
  });

  it("includes Dependency Dashboard issues when hideDepDashboard is false", () => {
    updateViewState({ hideDepDashboard: false });
    const issues = [
      makeIssue({ id: 1, title: "Dependency Dashboard", assigneeLogins: ["me"] }),
    ];

    renderStrip({ issues });
    screen.getByText(/assigned/);
  });
});
