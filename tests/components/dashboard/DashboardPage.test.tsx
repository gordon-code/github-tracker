import { describe, it, expect } from "vitest";
import { rateLimitCssClass } from "../../../src/app/lib/format";
import { applyHotPollPRUpdates } from "../../../src/app/components/dashboard/DashboardPage";
import { makePullRequest } from "../../helpers/index";
import type { PullRequest } from "../../../src/shared/types";
import type { HotPRStatusUpdate } from "../../../src/app/services/api";

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
});
