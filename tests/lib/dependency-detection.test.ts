import { describe, it, expect } from "vitest";
import {
  isDependencyPr,
  extractVersionInfo,
  parseRenovateBody,
  needsBodyFallback,
  classifyDepStatus,
  isRebasing,
  isKnownDepBot,
  expandBotLogins,
  stripVersionSpecifier,
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

  it("returns false for human fix(deps) PR that is not a bot update", () => {
    const pr = makePullRequest({
      userLogin: "octocat",
      headRef: "fix/deps-tab-fixes",
      title: "fix(deps): post-deploy dependency tab fixes",
      labels: [],
    });
    expect(isDependencyPr(pr, NO_TRACKED_BOTS)).toBe(false);
  });

  it("returns true for bot fix(deps) PR with update action", () => {
    const pr = makePullRequest({ title: "fix(deps): update all non-major dependencies" });
    expect(isDependencyPr(pr, NO_TRACKED_BOTS)).toBe(true);
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

  it("extracts package and versions from Python requirement update", () => {
    const result = extractVersionInfo("chore(deps-dev): update ruff requirement from >=0.9.4 to >=0.15.10");
    expect(result).toEqual({ packageName: "ruff", from: "0.9.4", to: "0.15.10", updateType: "minor" });
  });

  it("handles various pip requirement operators", () => {
    const result = extractVersionInfo("chore(deps): update mypy requirement from ~=1.15.0 to ~=1.20.1");
    expect(result).toEqual({ packageName: "mypy", from: "1.15.0", to: "1.20.1", updateType: "minor" });
  });

  it("handles pinned == pip requirement specifier", () => {
    const result = extractVersionInfo("update boto3 requirement from ==1.26.0 to ==1.34.0");
    expect(result).toEqual({ packageName: "boto3", from: "1.26.0", to: "1.34.0", updateType: "minor" });
  });

  it("returns null for unrecognized title format", () => {
    expect(extractVersionInfo("Fix a bug in auth flow")).toBeNull();
  });

  it("returns null updateType when from and to are identical versions", () => {
    const result = extractVersionInfo("Bump lodash from 4.17.21 to 4.17.21");
    expect(result).toEqual({ packageName: "lodash", from: "4.17.21", to: "4.17.21", updateType: undefined });
  });
});

describe("stripVersionSpecifier", () => {
  it("strips == prefix", () => {
    expect(stripVersionSpecifier("==9.0.2")).toBe("9.0.2");
  });

  it("strips >= prefix", () => {
    expect(stripVersionSpecifier(">=1.5.0")).toBe("1.5.0");
  });

  it("strips ~= prefix", () => {
    expect(stripVersionSpecifier("~=1.15.0")).toBe("1.15.0");
  });

  it("strips ^ prefix (npm caret)", () => {
    expect(stripVersionSpecifier("^1.2.3")).toBe("1.2.3");
  });

  it("strips <= prefix", () => {
    expect(stripVersionSpecifier("<=2.0.0")).toBe("2.0.0");
  });

  it("leaves plain versions unchanged", () => {
    expect(stripVersionSpecifier("4.17.21")).toBe("4.17.21");
    expect(stripVersionSpecifier("v2.0.0")).toBe("v2.0.0");
  });

  it("returns empty string for empty input", () => {
    expect(stripVersionSpecifier("")).toBe("");
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

  it("returns stale for approved PR that has not been updated in over 14 days", () => {
    const pr = makePullRequest({
      enriched: true,
      draft: false,
      checkStatus: "success",
      reviewDecision: "APPROVED",
      updatedAt: OLD,
    });
    expect(classifyDepStatus(pr, "", 14)).toBe("stale");
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

describe("isKnownDepBot", () => {
  it("returns true for exact match with [bot] suffix", () => {
    expect(isKnownDepBot("dependabot[bot]")).toBe(true);
    expect(isKnownDepBot("renovate[bot]")).toBe(true);
  });

  it("returns true for base name without [bot] suffix", () => {
    expect(isKnownDepBot("dependabot")).toBe(true);
    expect(isKnownDepBot("renovate")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isKnownDepBot("Dependabot[bot]")).toBe(true);
    expect(isKnownDepBot("RENOVATE")).toBe(true);
  });

  it("returns true for bots without [bot] in known list", () => {
    expect(isKnownDepBot("snyk-bot")).toBe(true);
    expect(isKnownDepBot("scala-steward")).toBe(true);
  });

  it("returns false for unknown logins", () => {
    expect(isKnownDepBot("octocat")).toBe(false);
    expect(isKnownDepBot("my-custom-bot")).toBe(false);
  });
});

describe("expandBotLogins", () => {
  it("includes both base and [bot] variant for plain login", () => {
    const set = expandBotLogins(["khepri-bot"]);
    expect(set.has("khepri-bot")).toBe(true);
    expect(set.has("khepri-bot[bot]")).toBe(true);
  });

  it("includes both base and [bot] variant for [bot] login", () => {
    const set = expandBotLogins(["renovate[bot]"]);
    expect(set.has("renovate[bot]")).toBe(true);
    expect(set.has("renovate")).toBe(true);
  });

  it("handles mixed logins", () => {
    const set = expandBotLogins(["my-bot", "other[bot]"]);
    expect(set.has("my-bot")).toBe(true);
    expect(set.has("my-bot[bot]")).toBe(true);
    expect(set.has("other[bot]")).toBe(true);
    expect(set.has("other")).toBe(true);
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

describe("parseRenovateBody", () => {
  it("parses 4-column table (Package | Type | Update | Change)", () => {
    const body = [
      "| Package | Type | Update | Change |",
      "|---|---|---|---|",
      "| [determinatesystems/nix-installer-action](https://example.com) | action | major | `v21` → `v22` |",
    ].join("\n");
    expect(parseRenovateBody(body)).toEqual({
      packageName: "determinatesystems/nix-installer-action",
      updateType: "major",
      from: "v21",
      to: "v22",
    });
  });

  it("parses 3-column table (Package | Update | Change)", () => {
    const body = [
      "| Package | Update | Change |",
      "|---|---|---|",
      "| [gitleaks/gitleaks](url) | patch | `v8.30.0` → `v8.30.1` |",
    ].join("\n");
    expect(parseRenovateBody(body)).toEqual({
      packageName: "gitleaks/gitleaks",
      updateType: "patch",
      from: "v8.30.0",
      to: "v8.30.1",
    });
  });

  it("derives updateType from semver when no Update column (Package | Change | Age | Confidence)", () => {
    const body = [
      "| Package | Change | [Age](https://docs.renovatebot.com/merge-confidence/) | [Confidence](https://docs.renovatebot.com/merge-confidence/) |",
      "|---|---|---|---|",
      "| [pytest](url) ([changelog](url2)) | `8.3.4` → `9.0.3` | ![age](img) | ![confidence](img) |",
    ].join("\n");
    expect(parseRenovateBody(body)).toEqual({
      packageName: "pytest",
      updateType: "major",
      from: "8.3.4",
      to: "9.0.3",
    });
  });

  it("parses minor update", () => {
    const body = [
      "| Package | Update | Change |",
      "|---|---|---|",
      "| [react](url) | minor | `18.2.0` → `18.3.0` |",
    ].join("\n");
    expect(parseRenovateBody(body)).toEqual({
      packageName: "react",
      updateType: "minor",
      from: "18.2.0",
      to: "18.3.0",
    });
  });

  it("parses pin update", () => {
    const body = [
      "| Package | Update | Change |",
      "|---|---|---|",
      "| [actions/checkout](url) | pin | `abc1234` → `def5678` |",
    ].join("\n");
    expect(parseRenovateBody(body)).toEqual({
      packageName: "actions/checkout",
      updateType: "pin",
      from: "abc1234",
      to: "def5678",
    });
  });

  it("strips Python version specifiers (==, >=, ~=) from versions", () => {
    const body = [
      "| Package | Change | [Age](url) | [Confidence](url) |",
      "|---|---|---|---|",
      "| [stamina](url) ([changelog](url2)) | `==25.2.0` → `==26.1.0` | ![age](img) | ![confidence](img) |",
    ].join("\n");
    expect(parseRenovateBody(body)).toEqual({
      packageName: "stamina",
      updateType: "major",
      from: "25.2.0",
      to: "26.1.0",
    });
  });

  it("parses digest update", () => {
    const body = [
      "| Package | Update | Change |",
      "|---|---|---|",
      "| [node](url) | digest | `sha256:abc` → `sha256:def` |",
    ].join("\n");
    expect(parseRenovateBody(body)).toEqual({
      packageName: "node",
      updateType: "digest",
      from: "sha256:abc",
      to: "sha256:def",
    });
  });

  it("handles plain text package name (no markdown link)", () => {
    const body = [
      "| Package | Update | Change |",
      "|---|---|---|",
      "| some-package | major | `1.0.0` → `2.0.0` |",
    ].join("\n");
    expect(parseRenovateBody(body)).toEqual({
      packageName: "some-package",
      updateType: "major",
      from: "1.0.0",
      to: "2.0.0",
    });
  });

  it("returns null when no valid table row found", () => {
    expect(parseRenovateBody("This is just a PR description with no table.")).toBeNull();
  });

  it("returns null for header/separator rows only", () => {
    const body = [
      "| Package | Update | Change |",
      "|---|---|---|",
    ].join("\n");
    expect(parseRenovateBody(body)).toBeNull();
  });

  it("handles body with surrounding text before table", () => {
    const body = [
      "This PR updates dependencies.",
      "",
      "| Package | Type | Update | Change |",
      "|---|---|---|---|",
      "| [webpack](url) | devDependencies | minor | `5.90.0` → `5.91.0` |",
    ].join("\n");
    expect(parseRenovateBody(body)).toEqual({
      packageName: "webpack",
      updateType: "minor",
      from: "5.90.0",
      to: "5.91.0",
    });
  });

  it("returns result without from/to when Change column has no arrow", () => {
    const body = [
      "| Package | Update | Change |",
      "|---|---|---|",
      "| [pkg](url) | major | see notes |",
    ].join("\n");
    expect(parseRenovateBody(body)).toEqual({ packageName: "pkg", updateType: "major" });
  });

  it("finds version arrow in any cell when no Change column exists", () => {
    const body = [
      "| Package | Version |",
      "|---|---|",
      "| [lodash](url) | `4.17.20` → `4.17.21` |",
    ].join("\n");
    expect(parseRenovateBody(body)).toEqual({
      packageName: "lodash",
      updateType: "patch",
      from: "4.17.20",
      to: "4.17.21",
    });
  });

  it("strips markdown links from header cells", () => {
    const body = [
      "| Package | Change | [Age](https://example.com) |",
      "|---|---|---|",
      "| [pkg](url) | `1.0.0` → `2.0.0` | ![age](img) |",
    ].join("\n");
    expect(parseRenovateBody(body)).toEqual({
      packageName: "pkg",
      updateType: "major",
      from: "1.0.0",
      to: "2.0.0",
    });
  });
});

describe("needsBodyFallback", () => {
  it("returns true when title gives no updateType and no labels help", () => {
    const pr = makePullRequest({
      title: "chore(deps): update determinatesystems/nix-installer-action action to v22",
      nodeId: "PR_abc",
    });
    expect(needsBodyFallback(pr)).toBe(true);
  });

  it("returns false when title gives updateType", () => {
    const pr = makePullRequest({
      title: "Bump lodash from 3.0.0 to 4.0.0",
      nodeId: "PR_abc",
    });
    expect(needsBodyFallback(pr)).toBe(false);
  });

  it("returns false when no nodeId", () => {
    const pr = makePullRequest({
      title: "chore(deps): update something action to v5",
    });
    expect(needsBodyFallback(pr)).toBe(false);
  });

  it("returns false for pin dependencies title", () => {
    const pr = makePullRequest({
      title: "chore(deps): pin dependencies",
      nodeId: "PR_abc",
    });
    expect(needsBodyFallback(pr)).toBe(false);
  });

  it("returns false for lock file maintenance title", () => {
    const pr = makePullRequest({
      title: "chore(deps): lock file maintenance",
      nodeId: "PR_abc",
    });
    expect(needsBodyFallback(pr)).toBe(false);
  });

  it("returns false when major label present", () => {
    const pr = makePullRequest({
      title: "chore(deps): update something action to v5",
      nodeId: "PR_abc",
      labels: [{ name: "major", color: "ff0000" }],
    });
    expect(needsBodyFallback(pr)).toBe(false);
  });
});
