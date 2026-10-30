import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { relativeTime, shortRelativeTime, labelTextColor, formatDuration, prSizeCategory, deriveInvolvementRoles, formatCount, formatStarCount, formatScopeSummary, canApprovePR, canMarkPRReady } from "../../src/app/lib/format";
import { makePullRequest } from "../helpers/factories";

describe("relativeTime", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(new Date("2026-03-21T12:00:00.000Z").getTime());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("formats seconds ago", () => {
    const isoString = new Date(Date.now() - 30 * 1000).toISOString();
    const result = relativeTime(isoString);
    expect(result).toMatch(/30 seconds? ago/);
  });

  it("formats minutes ago", () => {
    const isoString = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const result = relativeTime(isoString);
    expect(result).toMatch(/5 minutes? ago/);
  });

  it("formats hours ago", () => {
    const isoString = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const result = relativeTime(isoString);
    expect(result).toMatch(/3 hours? ago/);
  });

  it("formats days ago", () => {
    const isoString = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const result = relativeTime(isoString);
    expect(result).toMatch(/7 days? ago/);
  });

  it("formats months ago", () => {
    const isoString = new Date(Date.now() - 2 * 30 * 24 * 60 * 60 * 1000).toISOString();
    const result = relativeTime(isoString);
    expect(result).toMatch(/2 months? ago/);
  });

  it("formats years ago", () => {
    const isoString = new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000).toISOString();
    const result = relativeTime(isoString);
    expect(result).toMatch(/2 years? ago/);
  });

  it("uses 'now' or 'just now' wording for 0 seconds", () => {
    const isoString = new Date(Date.now()).toISOString();
    const result = relativeTime(isoString);
    // Intl.RelativeTimeFormat with numeric:'auto' outputs 'now' for 0 seconds
    expect(result).toMatch(/now/i);
  });

  it("returns empty string for invalid date input", () => {
    expect(relativeTime("not-a-date")).toBe("");
    expect(relativeTime("")).toBe("");
    expect(relativeTime("garbage-2026-13-99")).toBe("");
  });

  it("clamps future timestamps to 'now' (clock skew)", () => {
    const future = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    expect(relativeTime(future)).toMatch(/now/i);
  });
});

describe("shortRelativeTime", () => {
  const MOCK_NOW = new Date("2026-03-21T12:00:00.000Z").getTime();

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(MOCK_NOW);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 'now' for under 60 seconds ago", () => {
    const isoString = new Date(MOCK_NOW - 30 * 1000).toISOString();
    expect(shortRelativeTime(isoString)).toBe("now");
  });

  it("returns compact minutes for 5 minutes ago", () => {
    const isoString = new Date(MOCK_NOW - 5 * 60 * 1000).toISOString();
    expect(shortRelativeTime(isoString)).toBe("5m");
  });

  it("returns compact hours for 3 hours ago", () => {
    const isoString = new Date(MOCK_NOW - 3 * 60 * 60 * 1000).toISOString();
    expect(shortRelativeTime(isoString)).toBe("3h");
  });

  it("returns compact days for 7 days ago", () => {
    const isoString = new Date(MOCK_NOW - 7 * 24 * 60 * 60 * 1000).toISOString();
    expect(shortRelativeTime(isoString)).toBe("7d");
  });

  it("returns 'now' for exactly 59 seconds ago", () => {
    const isoString = new Date(MOCK_NOW - 59 * 1000).toISOString();
    expect(shortRelativeTime(isoString)).toBe("now");
  });

  it("returns '1m' for exactly 60 seconds ago", () => {
    const isoString = new Date(MOCK_NOW - 60 * 1000).toISOString();
    expect(shortRelativeTime(isoString)).toBe("1m");
  });

  it("returns '29d' for 29 days ago", () => {
    const isoString = new Date(MOCK_NOW - 29 * 24 * 60 * 60 * 1000).toISOString();
    expect(shortRelativeTime(isoString)).toBe("29d");
  });

  it("returns '1mo' for 30 days ago", () => {
    const isoString = new Date(MOCK_NOW - 30 * 24 * 60 * 60 * 1000).toISOString();
    expect(shortRelativeTime(isoString)).toBe("1mo");
  });

  it("returns compact months for 45 days ago", () => {
    const isoString = new Date(MOCK_NOW - 45 * 24 * 60 * 60 * 1000).toISOString();
    expect(shortRelativeTime(isoString)).toBe("1mo");
  });

  it("returns '2mo' for 2 months ago", () => {
    const isoString = new Date(MOCK_NOW - 2 * 30 * 24 * 60 * 60 * 1000).toISOString();
    expect(shortRelativeTime(isoString)).toBe("2mo");
  });

  it("returns '11mo' for 11 months ago", () => {
    const isoString = new Date(MOCK_NOW - 11 * 30 * 24 * 60 * 60 * 1000).toISOString();
    expect(shortRelativeTime(isoString)).toBe("11mo");
  });

  it("returns '1y' for 12 months ago", () => {
    const isoString = new Date(MOCK_NOW - 12 * 30 * 24 * 60 * 60 * 1000).toISOString();
    expect(shortRelativeTime(isoString)).toBe("1y");
  });

  it("returns '11mo' for 359 days ago (just before year boundary)", () => {
    const isoString = new Date(MOCK_NOW - 359 * 24 * 60 * 60 * 1000).toISOString();
    expect(shortRelativeTime(isoString)).toBe("11mo");
  });

  it("returns '1y' for 360 days ago (exact year boundary at 12×30)", () => {
    const isoString = new Date(MOCK_NOW - 360 * 24 * 60 * 60 * 1000).toISOString();
    expect(shortRelativeTime(isoString)).toBe("1y");
  });

  it("returns compact years for 400 days ago", () => {
    const isoString = new Date(MOCK_NOW - 400 * 24 * 60 * 60 * 1000).toISOString();
    expect(shortRelativeTime(isoString)).toBe("1y");
  });

  it("returns 'now' for future timestamps (clock skew)", () => {
    const isoString = new Date(MOCK_NOW + 60 * 1000).toISOString();
    expect(shortRelativeTime(isoString)).toBe("now");
  });

  it("returns 'now' for future timestamps beyond 60s", () => {
    const future = new Date(MOCK_NOW + 5 * 60 * 1000).toISOString();
    expect(shortRelativeTime(future)).toBe("now");
  });

  it("returns empty string for invalid input", () => {
    expect(shortRelativeTime("not-a-date")).toBe("");
    expect(shortRelativeTime("")).toBe("");
  });
});

describe("labelTextColor", () => {
  it("returns #000000 for white (#ffffff)", () => {
    expect(labelTextColor("ffffff")).toBe("#000000");
  });

  it("returns #000000 for yellow (#ffff00)", () => {
    expect(labelTextColor("ffff00")).toBe("#000000");
  });

  it("returns #000000 for a light green", () => {
    expect(labelTextColor("0075ca")).toBe("#ffffff");
  });

  it("returns #ffffff for black (#000000)", () => {
    expect(labelTextColor("000000")).toBe("#ffffff");
  });

  it("returns #ffffff for a dark red (#d73a4a)", () => {
    // luminance = (0.299*215 + 0.587*58 + 0.114*74) / 255 ≈ 0.41 — dark
    expect(labelTextColor("d73a4a")).toBe("#ffffff");
  });

  it("returns #ffffff for a dark navy blue", () => {
    expect(labelTextColor("0d1117")).toBe("#ffffff");
  });

  it("returns #000000 for a light grey (#e4e4e4)", () => {
    expect(labelTextColor("e4e4e4")).toBe("#000000");
  });
});

describe("formatDuration", () => {
  it("formats minutes and seconds", () => {
    expect(formatDuration("2026-03-21T10:00:00Z", "2026-03-21T10:02:34Z")).toBe("2m 34s");
  });

  it("formats hours and minutes", () => {
    expect(formatDuration("2026-03-21T10:00:00Z", "2026-03-21T11:12:00Z")).toBe("1h 12m");
  });

  it("formats seconds only", () => {
    expect(formatDuration("2026-03-21T10:00:00Z", "2026-03-21T10:00:45Z")).toBe("45s");
  });

  it("returns '--' for same timestamps", () => {
    expect(formatDuration("2026-03-21T10:00:00Z", "2026-03-21T10:00:00Z")).toBe("--");
  });

  it("returns '--' for falsy startedAt", () => {
    expect(formatDuration("", "2026-03-21T10:00:00Z")).toBe("--");
  });

  it("returns '--' for negative diff (completedAt before startedAt)", () => {
    expect(formatDuration("2026-03-21T11:00:00Z", "2026-03-21T10:00:00Z")).toBe("--");
  });

  it("returns '<1s' for sub-second duration", () => {
    expect(formatDuration("2026-03-21T10:00:00.000Z", "2026-03-21T10:00:00.500Z")).toBe("<1s");
  });

  it("returns '--' for invalid date strings", () => {
    expect(formatDuration("not-a-date", "2026-03-21T10:00:00Z")).toBe("--");
    expect(formatDuration("2026-03-21T10:00:00Z", "not-a-date")).toBe("--");
  });
});

describe("prSizeCategory", () => {
  it("returns XS for total < 10", () => {
    expect(prSizeCategory(3, 2)).toBe("XS");
  });

  it("returns S for total 10-29", () => {
    expect(prSizeCategory(10, 5)).toBe("S");
  });

  it("returns M for total 30-99", () => {
    expect(prSizeCategory(50, 30)).toBe("M");
  });

  it("returns L for total 100-499", () => {
    expect(prSizeCategory(200, 100)).toBe("L");
  });

  it("returns XL for total 500-999", () => {
    expect(prSizeCategory(600, 200)).toBe("XL");
  });

  it("returns XXL for total >= 1000", () => {
    expect(prSizeCategory(800, 500)).toBe("XXL");
  });

  it("returns XS for (0, 0)", () => {
    expect(prSizeCategory(0, 0)).toBe("XS");
  });

  it("returns XS for total 9 (boundary below 10)", () => {
    expect(prSizeCategory(5, 4)).toBe("XS");
  });

  it("returns S for total 10 (boundary at 10)", () => {
    expect(prSizeCategory(5, 5)).toBe("S");
  });

  it("returns S for total 29 (boundary below 30)", () => {
    expect(prSizeCategory(15, 14)).toBe("S");
  });

  it("returns M for total 30 (boundary at 30)", () => {
    expect(prSizeCategory(15, 15)).toBe("M");
  });

  it("returns M for total 99 (boundary below 100)", () => {
    expect(prSizeCategory(50, 49)).toBe("M");
  });

  it("returns L for total 100 (boundary at 100)", () => {
    expect(prSizeCategory(50, 50)).toBe("L");
  });

  it("returns L for total 499 (boundary below 500)", () => {
    expect(prSizeCategory(250, 249)).toBe("L");
  });

  it("returns XL for total 500 (boundary at 500)", () => {
    expect(prSizeCategory(250, 250)).toBe("XL");
  });

  it("returns XL for total 999 (boundary below 1000)", () => {
    expect(prSizeCategory(500, 499)).toBe("XL");
  });

  it("returns XXL for total 1000 (boundary at 1000)", () => {
    expect(prSizeCategory(500, 500)).toBe("XXL");
  });

  it("handles NaN/undefined gracefully — defaults to XS", () => {
    expect(prSizeCategory(NaN, 0)).toBe("XS");
    expect(prSizeCategory(0, NaN)).toBe("XS");
    expect(prSizeCategory(NaN, NaN)).toBe("XS");
  });
});

describe("deriveInvolvementRoles", () => {
  it("returns ['author'] when user is author", () => {
    expect(deriveInvolvementRoles("alice", "alice", [], [])).toEqual(["author"]);
  });

  it("returns ['reviewer'] when user is reviewer", () => {
    expect(deriveInvolvementRoles("bob", "alice", [], ["bob"])).toEqual(["reviewer"]);
  });

  it("returns ['assignee'] when user is assignee", () => {
    expect(deriveInvolvementRoles("carol", "alice", ["carol"], [])).toEqual(["assignee"]);
  });

  it("returns ['author', 'reviewer'] when user is both", () => {
    expect(deriveInvolvementRoles("alice", "alice", [], ["alice"])).toEqual(["author", "reviewer"]);
  });

  it("returns all three roles when user is author, reviewer, and assignee", () => {
    expect(deriveInvolvementRoles("alice", "alice", ["alice"], ["alice"])).toEqual(["author", "reviewer", "assignee"]);
  });

  it("returns [] when user has no role", () => {
    expect(deriveInvolvementRoles("dave", "alice", [], [])).toEqual([]);
  });

  it("returns [] for empty userLogin", () => {
    expect(deriveInvolvementRoles("", "alice", [], [])).toEqual([]);
  });

  it("is case-insensitive for author", () => {
    expect(deriveInvolvementRoles("Alice", "alice", [], [])).toEqual(["author"]);
  });

  it("is case-insensitive for reviewer", () => {
    expect(deriveInvolvementRoles("Alice", "bob", [], ["ALICE"])).toEqual(["reviewer"]);
  });

  it("is case-insensitive for assignee", () => {
    expect(deriveInvolvementRoles("Alice", "bob", ["alice"], [])).toEqual(["assignee"]);
  });
});

describe("formatCount", () => {
  it("returns '0' for 0", () => {
    expect(formatCount(0)).toBe("0");
  });

  it("returns '42' for 42", () => {
    expect(formatCount(42)).toBe("42");
  });

  it("returns '999' for 999", () => {
    expect(formatCount(999)).toBe("999");
  });

  it("returns '1k' for 1000", () => {
    expect(formatCount(1000)).toBe("1k");
  });

  it("returns '1.5k' for 1500", () => {
    expect(formatCount(1500)).toBe("1.5k");
  });

  it("returns '10k' for 10000", () => {
    expect(formatCount(10000)).toBe("10k");
  });
});

describe("formatScopeSummary", () => {
  it("returns 'No repos selected' when both orgCount and repoCount are 0", () => {
    expect(formatScopeSummary(0, 0)).toBe("No repos selected");
  });

  it("elideZero=true with only orgCount returns '1 org'", () => {
    expect(formatScopeSummary(1, 0, true)).toBe("1 org");
  });

  it("elideZero=true with only repoCount returns '1 repo'", () => {
    expect(formatScopeSummary(0, 1, true)).toBe("1 repo");
  });

  it("elideZero=true with both nonzero returns '2 orgs, 3 repos'", () => {
    expect(formatScopeSummary(2, 3, true)).toBe("2 orgs, 3 repos");
  });

  it("elideZero=false (default) with orgCount=1 returns '1 org, 0 repos'", () => {
    expect(formatScopeSummary(1, 0, false)).toBe("1 org, 0 repos");
  });

  it("elideZero=false with repoCount=1 returns '0 orgs, 1 repo'", () => {
    expect(formatScopeSummary(0, 1, false)).toBe("0 orgs, 1 repo");
  });

  it("elideZero=false with both nonzero returns '2 orgs, 3 repos'", () => {
    expect(formatScopeSummary(2, 3, false)).toBe("2 orgs, 3 repos");
  });
});

describe("formatStarCount", () => {
  it("returns '0' for 0", () => {
    expect(formatStarCount(0)).toBe("0");
  });

  it("returns '42' for 42", () => {
    expect(formatStarCount(42)).toBe("42");
  });

  it("returns '999' for 999", () => {
    expect(formatStarCount(999)).toBe("999");
  });

  it("returns '1k' for 1000", () => {
    expect(formatStarCount(1000)).toBe("1k");
  });

  it("returns '1.2k' for 1234", () => {
    expect(formatStarCount(1234)).toBe("1.2k");
  });

  it("returns '10k' for 9999", () => {
    expect(formatStarCount(9999)).toBe("10k");
  });

  it("returns '15k' for 15000", () => {
    expect(formatStarCount(15000)).toBe("15k");
  });

  it("returns '1M' for 1000000", () => {
    expect(formatStarCount(1000000)).toBe("1M");
  });

  it("returns '1.2M' for 1234567", () => {
    expect(formatStarCount(1234567)).toBe("1.2M");
  });
});

describe("canApprovePR", () => {
  const validSha = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

  it("returns true when reviewDecision is REVIEW_REQUIRED on an open enriched non-draft PR by another author", () => {
    const pr = makePullRequest({
      nodeId: "PR_kwDOtest0001",
      headSha: validSha,
      userLogin: "author",
      reviewDecision: "REVIEW_REQUIRED",
    });
    expect(canApprovePR(pr, "reviewer")).toBe(true);
  });

  it("returns true when viewerReviewRequested is true even if reviewDecision is null or CHANGES_REQUESTED", () => {
    const prNullDecision = makePullRequest({
      nodeId: "PR_kwDOtest0001",
      headSha: validSha,
      userLogin: "author",
      reviewDecision: null,
      viewerReviewRequested: true,
    });
    const prChangesRequested = makePullRequest({
      nodeId: "PR_kwDOtest0002",
      headSha: validSha,
      userLogin: "author",
      reviewDecision: "CHANGES_REQUESTED",
      viewerReviewRequested: true,
    });
    expect(canApprovePR(prNullDecision, "reviewer")).toBe(true);
    expect(canApprovePR(prChangesRequested, "reviewer")).toBe(true);
  });

  it("returns false for self-authored PR (case-insensitive)", () => {
    const pr = makePullRequest({
      nodeId: "PR_kwDOtest0001",
      headSha: validSha,
      userLogin: "OctoCat",
      reviewDecision: "REVIEW_REQUIRED",
      viewerReviewRequested: true,
    });
    expect(canApprovePR(pr, "octocat")).toBe(false);
  });

  it("returns false when viewerLatestReviewState is APPROVED and viewerReviewRequested is false", () => {
    const pr = makePullRequest({
      nodeId: "PR_kwDOtest0001",
      headSha: validSha,
      userLogin: "author",
      reviewDecision: "REVIEW_REQUIRED",
      viewerLatestReviewState: "APPROVED",
      viewerReviewRequested: false,
    });
    expect(canApprovePR(pr, "reviewer")).toBe(false);
  });

  it("returns true when viewerLatestReviewState is APPROVED but viewerReviewRequested is true (re-requested review)", () => {
    const pr = makePullRequest({
      nodeId: "PR_kwDOtest0001",
      headSha: validSha,
      userLogin: "author",
      reviewDecision: "REVIEW_REQUIRED",
      viewerLatestReviewState: "APPROVED",
      viewerReviewRequested: true,
    });
    expect(canApprovePR(pr, "reviewer")).toBe(true);
  });

  it("returns false when PR is a draft", () => {
    const pr = makePullRequest({
      nodeId: "PR_kwDOtest0001",
      headSha: validSha,
      userLogin: "author",
      draft: true,
      reviewDecision: "REVIEW_REQUIRED",
    });
    expect(canApprovePR(pr, "reviewer")).toBe(false);
  });

  it("returns false when PR state is CLOSED or MERGED", () => {
    const closedPr = makePullRequest({
      nodeId: "PR_kwDOtest0001",
      headSha: validSha,
      userLogin: "author",
      state: "CLOSED",
      reviewDecision: "REVIEW_REQUIRED",
    });
    const mergedPr = makePullRequest({
      nodeId: "PR_kwDOtest0002",
      headSha: validSha,
      userLogin: "author",
      state: "MERGED",
      reviewDecision: "REVIEW_REQUIRED",
    });
    expect(canApprovePR(closedPr, "reviewer")).toBe(false);
    expect(canApprovePR(mergedPr, "reviewer")).toBe(false);
  });

  it("returns false when PR is not yet enriched (enriched === false)", () => {
    const pr = makePullRequest({
      nodeId: "PR_kwDOtest0001",
      headSha: validSha,
      userLogin: "author",
      enriched: false,
      reviewDecision: "REVIEW_REQUIRED",
    });
    expect(canApprovePR(pr, "reviewer")).toBe(false);
  });

  it("returns false when nodeId, headSha, or userLogin is missing", () => {
    const noNodeId = makePullRequest({
      nodeId: undefined,
      headSha: validSha,
      userLogin: "author",
      reviewDecision: "REVIEW_REQUIRED",
    });
    const noHeadSha = makePullRequest({
      nodeId: "PR_kwDOtest0001",
      headSha: "",
      userLogin: "author",
      reviewDecision: "REVIEW_REQUIRED",
    });
    const validPr = makePullRequest({
      nodeId: "PR_kwDOtest0001",
      headSha: validSha,
      userLogin: "author",
      reviewDecision: "REVIEW_REQUIRED",
    });
    expect(canApprovePR(noNodeId, "reviewer")).toBe(false);
    expect(canApprovePR(noHeadSha, "reviewer")).toBe(false);
    expect(canApprovePR(validPr, "")).toBe(false);
  });

  it("returns false when checkStatus is failure and true for success, pending, conflict, or null", () => {
    const base = {
      nodeId: "PR_kwDOtest0001",
      headSha: validSha,
      userLogin: "author",
      reviewDecision: "REVIEW_REQUIRED" as const,
    };

    expect(canApprovePR(makePullRequest({ ...base, checkStatus: "failure" }), "reviewer")).toBe(false);
    expect(canApprovePR(makePullRequest({ ...base, checkStatus: "success" }), "reviewer")).toBe(true);
    expect(canApprovePR(makePullRequest({ ...base, checkStatus: "pending" }), "reviewer")).toBe(true);
    expect(canApprovePR(makePullRequest({ ...base, checkStatus: "conflict" }), "reviewer")).toBe(true);
    expect(canApprovePR(makePullRequest({ ...base, checkStatus: null }), "reviewer")).toBe(true);
  });

  it("returns false while checkStatusStale is true and true once checkStatusStale is false", () => {
    const base = {
      nodeId: "PR_kwDOtest0001",
      headSha: validSha,
      userLogin: "author",
      reviewDecision: "REVIEW_REQUIRED" as const,
    };

    expect(canApprovePR(makePullRequest({ ...base, checkStatus: null, checkStatusStale: true }), "reviewer")).toBe(false);
    expect(canApprovePR(makePullRequest({ ...base, checkStatus: "success", checkStatusStale: true }), "reviewer")).toBe(false);
    expect(canApprovePR(makePullRequest({ ...base, checkStatus: null, checkStatusStale: false }), "reviewer")).toBe(true);
  });
});

describe("canMarkPRReady", () => {
  it("returns true for an OPEN draft PR authored by userLogin (case-insensitive)", () => {
    const pr = makePullRequest({
      nodeId: "PR_kwDOtest0001",
      state: "OPEN",
      draft: true,
      userLogin: "OctoCat",
    });
    expect(canMarkPRReady(pr, "octocat")).toBe(true);
    expect(canMarkPRReady(pr, "OCTOCAT")).toBe(true);
  });

  it("returns false when userLogin is not the PR author", () => {
    const pr = makePullRequest({
      nodeId: "PR_kwDOtest0001",
      state: "OPEN",
      draft: true,
      userLogin: "author",
    });
    expect(canMarkPRReady(pr, "reviewer")).toBe(false);
  });

  it("returns false when draft is false", () => {
    const pr = makePullRequest({
      nodeId: "PR_kwDOtest0001",
      state: "OPEN",
      draft: false,
      userLogin: "octocat",
    });
    expect(canMarkPRReady(pr, "octocat")).toBe(false);
  });

  it("returns false when PR state is CLOSED or MERGED", () => {
    const closedPr = makePullRequest({
      nodeId: "PR_kwDOtest0001",
      state: "CLOSED",
      draft: true,
      userLogin: "octocat",
    });
    const mergedPr = makePullRequest({
      nodeId: "PR_kwDOtest0002",
      state: "MERGED",
      draft: true,
      userLogin: "octocat",
    });
    expect(canMarkPRReady(closedPr, "octocat")).toBe(false);
    expect(canMarkPRReady(mergedPr, "octocat")).toBe(false);
  });

  it("returns false when nodeId is missing or userLogin is empty", () => {
    const noNodeId = makePullRequest({
      nodeId: undefined,
      state: "OPEN",
      draft: true,
      userLogin: "octocat",
    });
    const validDraft = makePullRequest({
      nodeId: "PR_kwDOtest0001",
      state: "OPEN",
      draft: true,
      userLogin: "octocat",
    });
    expect(canMarkPRReady(noNodeId, "octocat")).toBe(false);
    expect(canMarkPRReady(validDraft, "")).toBe(false);
  });
});
