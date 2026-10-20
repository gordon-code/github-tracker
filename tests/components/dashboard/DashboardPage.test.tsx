import { describe, it, expect } from "vitest";
import { rateLimitCssClass } from "../../../src/app/lib/format";
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
  function makeOpenPR(id: number): PullRequest {
    return {
      id,
      number: id,
      title: `PR ${id}`,
      state: "OPEN",
      draft: false,
      htmlUrl: `https://github.com/owner/repo/pull/${id}`,
      createdAt: "2024-01-10T08:00:00Z",
      updatedAt: "2024-01-12T14:30:00Z",
      userLogin: "octocat",
      userAvatarUrl: "https://github.com/images/error/octocat_happy.gif",
      headSha: "abc123",
      headRef: "feature",
      baseRef: "main",
      assigneeLogins: [],
      reviewerLogins: [],
      repoFullName: "owner/repo",
      checkStatus: null,
      additions: 0,
      deletions: 0,
      changedFiles: 0,
      comments: 0,
      reviewThreads: 0,
      labels: [],
      reviewDecision: null,
      totalReviewCount: 0,
      autoMergeMethod: null,
      viewerReviewRequested: false,
      viewerLatestReviewState: null,
      enriched: true,
    };
  }

  function simulateHotPollCallback(
    state: { pullRequests: PullRequest[] },
    prUpdates: Map<number, HotPRStatusUpdate>,
    currentLogin = ""
  ): void {
    // Mirrors the onHotData callback logic in DashboardPage.tsx (without SolidJS store produce)
    const terminalPrIds = new Set<number>();
    for (const [prId, update] of prUpdates) {
      if (update.state === "CLOSED" || update.state === "MERGED") {
        terminalPrIds.add(prId);
      }
    }
    const loginLower = currentLogin.toLowerCase();
    for (const pr of state.pullRequests) {
      const update = prUpdates.get(pr.id);
      if (!update) continue;
      pr.state = update.state;
      pr.checkStatus = update.checkStatus;
      pr.reviewDecision = update.reviewDecision;
      if (update.headSha) {
        pr.headSha = update.headSha;
      }
      if (update.autoMergeMethod !== undefined) {
        pr.autoMergeMethod = update.autoMergeMethod;
      }
      if (update.viewerLatestReviewState !== undefined) {
        pr.viewerLatestReviewState = update.viewerLatestReviewState;
      }
      if (update.viewerReviewRequested !== undefined) {
        if (update.viewerReviewRequested) {
          pr.viewerReviewRequested = true;
        } else if (update.viewerLatestReviewState === "APPROVED") {
          pr.viewerReviewRequested = false;
        }
      }
      if (
        loginLower &&
        (pr.viewerReviewRequested || pr.viewerLatestReviewState != null) &&
        !pr.reviewerLogins.some((r) => r.toLowerCase() === loginLower)
      ) {
        pr.reviewerLogins = [...pr.reviewerLogins, loginLower];
      }
    }
    if (terminalPrIds.size > 0) {
      state.pullRequests = state.pullRequests.filter((pr) => !terminalPrIds.has(pr.id));
    }
  }

  it("removes a MERGED PR from pullRequests when hot poll returns state:MERGED", () => {
    const state = { pullRequests: [makeOpenPR(1), makeOpenPR(2)] };

    const prUpdates = new Map<number, HotPRStatusUpdate>([
      [1, { state: "MERGED", checkStatus: null, mergeStateStatus: "MERGED", reviewDecision: null }],
    ]);

    simulateHotPollCallback(state, prUpdates);

    expect(state.pullRequests.map((p) => p.id)).toEqual([2]);
  });

  it("removes a CLOSED PR from pullRequests when hot poll returns state:CLOSED", () => {
    const state = { pullRequests: [makeOpenPR(10), makeOpenPR(20)] };

    const prUpdates = new Map<number, HotPRStatusUpdate>([
      [10, { state: "CLOSED", checkStatus: null, mergeStateStatus: "", reviewDecision: null }],
    ]);

    simulateHotPollCallback(state, prUpdates);

    expect(state.pullRequests.map((p) => p.id)).toEqual([20]);
  });

  it("keeps OPEN PRs in pullRequests after hot poll update", () => {
    const state = { pullRequests: [makeOpenPR(5)] };

    const prUpdates = new Map<number, HotPRStatusUpdate>([
      [5, { state: "OPEN", checkStatus: "success", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED" }],
    ]);

    simulateHotPollCallback(state, prUpdates);

    expect(state.pullRequests).toHaveLength(1);
    expect(state.pullRequests[0].id).toBe(5);
  });

  it("removes only the MERGED PR and leaves remaining PRs intact", () => {
    const state = { pullRequests: [makeOpenPR(100), makeOpenPR(101), makeOpenPR(102)] };

    const prUpdates = new Map<number, HotPRStatusUpdate>([
      [101, { state: "MERGED", checkStatus: null, mergeStateStatus: "MERGED", reviewDecision: null }],
    ]);

    simulateHotPollCallback(state, prUpdates);

    expect(state.pullRequests.map((p) => p.id)).toEqual([100, 102]);
  });

  it("updates headSha and autoMergeMethod while preserving Phase 1 team viewerReviewRequested and reviewerLogins until approved", () => {
    const teamRequestedPR: PullRequest = {
      ...makeOpenPR(7),
      viewerReviewRequested: true,
      reviewerLogins: [],
    };
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

    simulateHotPollCallback(state, prUpdates1, "TestUser");

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

    simulateHotPollCallback(state, prUpdates2, "TestUser");

    expect(state.pullRequests[0].viewerLatestReviewState).toBe("APPROVED");
    expect(state.pullRequests[0].viewerReviewRequested).toBe(false);
    expect(state.pullRequests[0].reviewerLogins).toEqual(["testuser"]);
  });
});
