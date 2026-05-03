import { describe, it, expect } from "vitest";
import {
  isDependencyPr,
  extractVersionInfo,
  classifyDepStatus,
  isRebasing,
  KNOWN_DEP_BOT_LOGINS,
  DEP_BRANCH_PREFIXES,
  DEP_TITLE_PATTERN,
  DEP_TOOL_LABEL_NAMES,
  ALL_DEP_STATUSES,
} from "../../src/app/lib/dependency-detection.js";
import { makePullRequest } from "../helpers/factories.js";

const NO_TRACKED_BOTS = new Set<string>();

describe("isDependencyPr", () => {
  it("returns true for known dep bot login (exact)", () => {
    const pr = makePullRequest({ userLogin: "dependabot[bot]" });
    expect(isDependencyPr(pr, NO_TRACKED_BOTS)).toBe(true);
  });

  it("returns true for known dep bot login (case-insensitive)", () => {
    const pr = makePullRequest({ userLogin: "Renovate[bot]" });
    expect(isDependencyPr(pr, NO_TRACKED_BOTS)).toBe(true);
  });

  it("returns true for tracked bot login", () => {
    const pr = makePullRequest({ userLogin: "my-custom-bot" });
    const tracked = new Set(["my-custom-bot"]);
    expect(isDependencyPr(pr, tracked)).toBe(true);
  });

  it("returns true for tracked bot login (case-insensitive)", () => {
    const pr = makePullRequest({ userLogin: "My-Custom-Bot" });
    const tracked = new Set(["my-custom-bot"]);
    expect(isDependencyPr(pr, tracked)).toBe(true);
  });

  it("returns true for dependabot branch prefix", () => {
    const pr = makePullRequest({ headRef: "dependabot/npm_and_yarn/lodash-4.0.0" });
    expect(isDependencyPr(pr, NO_TRACKED_BOTS)).toBe(true);
  });

  it("returns true for renovate branch prefix", () => {
    const pr = makePullRequest({ headRef: "renovate/react-18.x" });
    expect(isDependencyPr(pr, NO_TRACKED_BOTS)).toBe(true);
  });

  it("returns true for snyk branch prefix", () => {
    const pr = makePullRequest({ headRef: "snyk-fix-abc123" });
    expect(isDependencyPr(pr, NO_TRACKED_BOTS)).toBe(true);
  });

  it("returns true for branch prefix (case-insensitive)", () => {
    const pr = makePullRequest({ headRef: "Renovate/something" });
    expect(isDependencyPr(pr, NO_TRACKED_BOTS)).toBe(true);
  });

  it("returns true for 'Bump' title pattern", () => {
    const pr = makePullRequest({ title: "Bump lodash from 4.0.0 to 4.17.21" });
    expect(isDependencyPr(pr, NO_TRACKED_BOTS)).toBe(true);
  });

  it("returns true for chore(deps title pattern", () => {
    const pr = makePullRequest({ title: "chore(deps): update all major dependencies" });
    expect(isDependencyPr(pr, NO_TRACKED_BOTS)).toBe(true);
  });

  it("returns true for [Snyk] title pattern", () => {
    const pr = makePullRequest({ title: "[Snyk] Security patch for lodash" });
    expect(isDependencyPr(pr, NO_TRACKED_BOTS)).toBe(true);
  });

  it("returns true for 'dependencies' label (case-insensitive)", () => {
    const pr = makePullRequest({ labels: [{ name: "Dependencies", color: "0075ca" }] });
    expect(isDependencyPr(pr, NO_TRACKED_BOTS)).toBe(true);
  });

  it("returns false for regular PR", () => {
    const pr = makePullRequest({
      userLogin: "octocat",
      headRef: "feature/my-feature",
      title: "Add new feature",
      labels: [],
    });
    expect(isDependencyPr(pr, NO_TRACKED_BOTS)).toBe(false);
  });

  it("returns false for regular PR even with tracked users of type user", () => {
    const pr = makePullRequest({ userLogin: "alice" });
    const tracked = new Set(["bob"]);
    expect(isDependencyPr(pr, tracked)).toBe(false);
  });
});

describe("extractVersionInfo", () => {
  it("extracts major update from Dependabot bump title", () => {
    const result = extractVersionInfo("Bump lodash from 3.0.0 to 4.0.0");
    expect(result).toEqual({ packageName: "lodash", from: "3.0.0", to: "4.0.0", updateType: "major" });
  });

  it("extracts minor update from Dependabot bump title", () => {
    const result = extractVersionInfo("Bump lodash from 4.0.0 to 4.1.0");
    expect(result).toEqual({ packageName: "lodash", from: "4.0.0", to: "4.1.0", updateType: "minor" });
  });

  it("extracts patch update from Dependabot bump title", () => {
    const result = extractVersionInfo("Bump lodash from 4.17.20 to 4.17.21");
    expect(result).toEqual({ packageName: "lodash", from: "4.17.20", to: "4.17.21", updateType: "patch" });
  });

  it("extracts package name from chore(deps) bump title", () => {
    const result = extractVersionInfo("chore(deps): bump webpack from 5.90.0 to 5.90.1");
    expect(result).toEqual({ packageName: "webpack", from: "5.90.0", to: "5.90.1", updateType: "patch" });
  });

  it("returns major for Renovate 'update all major dependencies'", () => {
    const result = extractVersionInfo("chore(deps): update all major dependencies");
    expect(result).toEqual({ updateType: "major" });
  });

  it("returns minor for Renovate 'update all non-major dependencies'", () => {
    const result = extractVersionInfo("chore(deps): update all non-major dependencies");
    expect(result).toEqual({ updateType: "minor" });
  });

  it("returns minor for fix(deps) non-major variant", () => {
    const result = extractVersionInfo("fix(deps): update all non-major dependencies");
    expect(result).toEqual({ updateType: "minor" });
  });

  it("extracts package name and to-version for Renovate single-dep title", () => {
    const result = extractVersionInfo("chore(deps): update dependency pytest to v9");
    expect(result).toEqual({ packageName: "pytest", to: "v9" });
  });

  it("extracts package name and to-version for Renovate action title", () => {
    const result = extractVersionInfo("chore(deps): update astral-sh/setup-uv action to v8");
    expect(result).toEqual({ packageName: "astral-sh/setup-uv", to: "v8" });
  });

  it("extracts to-version for plain Renovate dependency title (no chore prefix)", () => {
    const result = extractVersionInfo("Update dependency @types/node to v20.11.5");
    expect(result).toEqual({ packageName: "@types/node", to: "v20.11.5" });
  });

  it("returns null for 'pin dependencies'", () => {
    expect(extractVersionInfo("chore(deps): pin dependencies")).toBeNull();
  });

  it("returns null for 'lock file maintenance'", () => {
    expect(extractVersionInfo("chore(deps): lock file maintenance")).toBeNull();
  });

  it("returns null for 'fix(deps): pin dependencies'", () => {
    expect(extractVersionInfo("fix(deps): pin dependencies")).toBeNull();
  });

  it("strips [security] suffix before parsing", () => {
    const result = extractVersionInfo("chore(deps): update dependency pytest to v9 [security]");
    expect(result).toEqual({ packageName: "pytest", to: "v9" });
  });

  it("does not throw for non-semver bump (date-based version)", () => {
    expect(() => extractVersionInfo("Bump ubuntu from 22.04 to 24.04")).not.toThrow();
  });

  it("returns null for unrecognized title format", () => {
    expect(extractVersionInfo("Fix a bug in auth flow")).toBeNull();
  });

  it("returns null updateType when from and to are identical versions", () => {
    const result = extractVersionInfo("Bump lodash from 4.17.21 to 4.17.21");
    expect(result).toEqual({ packageName: "lodash", from: "4.17.21", to: "4.17.21", updateType: undefined });
  });
});

describe("isRebasing", () => {
  it("returns true when rebase label matches exactly", () => {
    const pr = makePullRequest({ labels: [{ name: "rebase", color: "ffffff" }] });
    expect(isRebasing(pr, "rebase")).toBe(true);
  });

  it("returns true for case-insensitive label match", () => {
    const pr = makePullRequest({ labels: [{ name: "Rebase", color: "ffffff" }] });
    expect(isRebasing(pr, "rebase")).toBe(true);
  });

  it("returns true with custom rebase label", () => {
    const pr = makePullRequest({ labels: [{ name: "needs-rebase", color: "ffffff" }] });
    expect(isRebasing(pr, "needs-rebase")).toBe(true);
  });

  it("returns false when label does not match", () => {
    const pr = makePullRequest({ labels: [{ name: "bug", color: "d73a4a" }] });
    expect(isRebasing(pr, "rebase")).toBe(false);
  });

  it("returns false when no labels", () => {
    const pr = makePullRequest({ labels: [] });
    expect(isRebasing(pr, "rebase")).toBe(false);
  });
});

describe("classifyDepStatus", () => {
  const RECENT = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const OLD = new Date(Date.now() - 31 * 86_400_000).toISOString();

  it("returns mergeable for enriched, non-draft, passing CI, not approved", () => {
    const pr = makePullRequest({
      enriched: true,
      draft: false,
      checkStatus: "success",
      reviewDecision: null,
      updatedAt: RECENT,
    });
    expect(classifyDepStatus(pr, "", 14)).toBe("mergeable");
  });

  it("returns mergeable even for old PR if CI passing and not approved", () => {
    const pr = makePullRequest({
      enriched: true,
      draft: false,
      checkStatus: "success",
      reviewDecision: null,
      updatedAt: OLD,
    });
    expect(classifyDepStatus(pr, "", 14)).toBe("mergeable");
  });

  it("returns pending-rebase when PR has rebase label", () => {
    const pr = makePullRequest({
      enriched: true,
      draft: false,
      checkStatus: "success",
      reviewDecision: null,
      labels: [{ name: "rebase", color: "ffffff" }],
      updatedAt: RECENT,
    });
    expect(classifyDepStatus(pr, "rebase", 14)).toBe("pending-rebase");
  });

  it("pending-rebase takes priority over mergeable", () => {
    const pr = makePullRequest({
      enriched: true,
      draft: false,
      checkStatus: "success",
      reviewDecision: null,
      labels: [{ name: "rebase", color: "ffffff" }],
      updatedAt: RECENT,
    });
    expect(classifyDepStatus(pr, "rebase")).toBe("pending-rebase");
  });

  it("pending-rebase takes priority over stale", () => {
    const pr = makePullRequest({
      draft: true,
      labels: [{ name: "rebase", color: "ffffff" }],
      updatedAt: OLD,
    });
    expect(classifyDepStatus(pr, "rebase")).toBe("pending-rebase");
  });

  it("returns stale for old PR that is not mergeable", () => {
    const pr = makePullRequest({
      enriched: true,
      draft: false,
      checkStatus: "failure",
      reviewDecision: null,
      updatedAt: OLD,
    });
    expect(classifyDepStatus(pr, "", 14)).toBe("stale");
  });

  it("returns stale for old draft PR", () => {
    const pr = makePullRequest({
      draft: true,
      updatedAt: OLD,
    });
    expect(classifyDepStatus(pr, "", 14)).toBe("stale");
  });

  it("returns needs-action for recent draft PR", () => {
    const pr = makePullRequest({
      draft: true,
      updatedAt: RECENT,
    });
    expect(classifyDepStatus(pr, "", 14)).toBe("needs-action");
  });

  it("returns needs-action for recent PR with pending CI", () => {
    const pr = makePullRequest({
      enriched: true,
      draft: false,
      checkStatus: "pending",
      reviewDecision: null,
      updatedAt: RECENT,
    });
    expect(classifyDepStatus(pr, "", 14)).toBe("needs-action");
  });

  it("returns needs-action for unenriched PR (enriched=false, checkStatus is null)", () => {
    const pr = makePullRequest({
      enriched: false,
      checkStatus: null,
      updatedAt: RECENT,
    });
    expect(classifyDepStatus(pr, "", 14)).toBe("needs-action");
  });

  it("returns needs-action for approved PR (already handled, not mergeable)", () => {
    const pr = makePullRequest({
      enriched: true,
      draft: false,
      checkStatus: "success",
      reviewDecision: "APPROVED",
      updatedAt: RECENT,
    });
    expect(classifyDepStatus(pr, "", 14)).toBe("needs-action");
  });

  it("uses default stale threshold of 14 days when not provided", () => {
    const thirteenDaysAgo = new Date(Date.now() - 13 * 86_400_000).toISOString();
    const fifteenDaysAgo = new Date(Date.now() - 15 * 86_400_000).toISOString();

    const recent = makePullRequest({ draft: true, updatedAt: thirteenDaysAgo });
    const old = makePullRequest({ draft: true, updatedAt: fifteenDaysAgo });

    expect(classifyDepStatus(recent)).toBe("needs-action");
    expect(classifyDepStatus(old)).toBe("stale");
  });

  it("skips rebase check when rebaseLabel is empty", () => {
    const pr = makePullRequest({
      labels: [{ name: "rebase", color: "ffffff" }],
      enriched: true,
      draft: false,
      checkStatus: "success",
      reviewDecision: null,
      updatedAt: RECENT,
    });
    expect(classifyDepStatus(pr)).toBe("mergeable");
  });
});

describe("ALL_DEP_STATUSES", () => {
  it("contains all status values in render order", () => {
    expect(ALL_DEP_STATUSES).toEqual(["mergeable", "pending-rebase", "needs-action", "stale"]);
  });
});

describe("DEP_TOOL_LABEL_NAMES", () => {
  it("contains known dep tool label names", () => {
    expect(DEP_TOOL_LABEL_NAMES.has("dependencies")).toBe(true);
    expect(DEP_TOOL_LABEL_NAMES.has("renovate")).toBe(true);
  });

  it("does not contain non-dep labels", () => {
    expect(DEP_TOOL_LABEL_NAMES.has("bug")).toBe(false);
  });
});

describe("KNOWN_DEP_BOT_LOGINS", () => {
  it("contains expected bot logins", () => {
    expect(KNOWN_DEP_BOT_LOGINS.has("dependabot[bot]")).toBe(true);
    expect(KNOWN_DEP_BOT_LOGINS.has("renovate[bot]")).toBe(true);
    expect(KNOWN_DEP_BOT_LOGINS.has("snyk-bot")).toBe(true);
  });
});

describe("DEP_BRANCH_PREFIXES", () => {
  it("includes dependabot/ and renovate/ prefixes", () => {
    expect(DEP_BRANCH_PREFIXES).toContain("dependabot/");
    expect(DEP_BRANCH_PREFIXES).toContain("renovate/");
  });
});

describe("DEP_TITLE_PATTERN", () => {
  it("matches Bump prefix", () => {
    expect(DEP_TITLE_PATTERN.test("Bump lodash from 1.0 to 2.0")).toBe(true);
  });

  it("does not match unrelated title", () => {
    expect(DEP_TITLE_PATTERN.test("Fix authentication bug")).toBe(false);
  });
});
