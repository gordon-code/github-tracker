import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { makeIssue, makePullRequest, makeWorkflowRun } from "../../helpers/index";
import PersonalSummaryStrip from "../../../src/app/components/dashboard/PersonalSummaryStrip";
import type { Issue, PullRequest, WorkflowRun } from "../../../src/app/services/api";

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
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

  it("clicking running actions calls onTabChange with 'actions'", () => {
    const onTabChange = vi.fn();
    const runs = [makeWorkflowRun({ status: "in_progress" })];

    renderStrip({ workflowRuns: runs, onTabChange });

    const button = screen.getByText(/running/);
    fireEvent.click(button);
    expect(onTabChange).toHaveBeenCalledWith("actions");
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
