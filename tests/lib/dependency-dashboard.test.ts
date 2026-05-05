import { describe, it, expect } from "vitest";
import {
  findDashboardIssues,
  parseAbandonedSection,
  matchAbandonedToPr,
  resetAbandonedPatternCache,
  escapeRegex,
} from "../../src/app/lib/dependency-dashboard.js";
import { makeIssue, makePullRequest } from "../helpers/factories.js";

const NO_BOT_LOGINS = new Set<string>();

describe("escapeRegex", () => {
  it("escapes regex metacharacters", () => {
    expect(escapeRegex("@scope/pkg.name")).toBe("@scope/pkg\\.name");
    expect(escapeRegex("a+b*c")).toBe("a\\+b\\*c");
    expect(escapeRegex("(foo|bar)")).toBe("\\(foo\\|bar\\)");
    expect(escapeRegex("a[0]")).toBe("a\\[0\\]");
    expect(escapeRegex("a{1,3}")).toBe("a\\{1,3\\}");
    expect(escapeRegex("a^b$c")).toBe("a\\^b\\$c");
    expect(escapeRegex("a?b")).toBe("a\\?b");
    expect(escapeRegex("a\\b")).toBe("a\\\\b");
  });

  it("leaves plain strings unchanged", () => {
    expect(escapeRegex("lodash")).toBe("lodash");
    expect(escapeRegex("react-dom")).toBe("react-dom");
  });
});

describe("findDashboardIssues", () => {
  it("finds open Dependency Dashboard issues from known bot logins", () => {
    const issue = makeIssue({
      title: "Dependency Dashboard",
      state: "OPEN",
      userLogin: "renovate[bot]",
      nodeId: "I_renovate_dash_1",
      htmlUrl: "https://github.com/owner/repo/issues/42",
      repoFullName: "owner/repo",
      number: 42,
    });
    const result = findDashboardIssues([issue], NO_BOT_LOGINS);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      issueNumber: 42,
      nodeId: "I_renovate_dash_1",
      repoFullName: "owner/repo",
      htmlUrl: "https://github.com/owner/repo/issues/42",
    });
  });

  it("finds issues from tracked bot logins", () => {
    const issue = makeIssue({
      title: "Dependency Dashboard",
      state: "OPEN",
      userLogin: "my-custom-bot",
      nodeId: "I_custom_bot_dash",
    });
    const result = findDashboardIssues([issue], new Set(["my-custom-bot"]));
    expect(result).toHaveLength(1);
  });

  it("is case-insensitive for title matching", () => {
    const issue = makeIssue({
      title: "dependency dashboard",
      state: "OPEN",
      userLogin: "renovate[bot]",
      nodeId: "I_case_test",
    });
    const result = findDashboardIssues([issue], NO_BOT_LOGINS);
    expect(result).toHaveLength(1);
  });

  it("rejects issues without nodeId", () => {
    const issue = makeIssue({
      title: "Dependency Dashboard",
      state: "OPEN",
      userLogin: "renovate[bot]",
      nodeId: undefined,
    });
    const result = findDashboardIssues([issue], NO_BOT_LOGINS);
    expect(result).toHaveLength(0);
  });

  it("rejects closed issues", () => {
    const issue = makeIssue({
      title: "Dependency Dashboard",
      state: "CLOSED",
      userLogin: "renovate[bot]",
      nodeId: "I_closed",
    });
    const result = findDashboardIssues([issue], NO_BOT_LOGINS);
    expect(result).toHaveLength(0);
  });

  it("rejects non-bot author", () => {
    const issue = makeIssue({
      title: "Dependency Dashboard",
      state: "OPEN",
      userLogin: "octocat",
      nodeId: "I_human_author",
    });
    const result = findDashboardIssues([issue], NO_BOT_LOGINS);
    expect(result).toHaveLength(0);
  });

  it("rejects wrong title", () => {
    const issue = makeIssue({
      title: "Dependencies",
      state: "OPEN",
      userLogin: "renovate[bot]",
      nodeId: "I_wrong_title",
    });
    const result = findDashboardIssues([issue], NO_BOT_LOGINS);
    expect(result).toHaveLength(0);
  });

  it("returns empty array for empty input", () => {
    expect(findDashboardIssues([], NO_BOT_LOGINS)).toHaveLength(0);
  });
});

// A realistic Renovate Dashboard body excerpt with an Abandoned section
const RENOVATE_BODY_WITH_ABANDONED = `
## Rate-Limited

Nothing yet.

## Abandoned

<details>
<summary>Packages are abandoned</summary>

| Datasource | Package | Last Updated |
|------------|---------|--------------|
| npm | lodash | 2023-01-15 |
| pypi | requests | 2022-11-20 |
| npm | @scope/utils | 2023-03-01 |

</details>

## Open
`;

const RENOVATE_BODY_NO_ABANDONED = `
## Rate-Limited

Nothing yet.

## Open

Some PRs here.
`;

describe("parseAbandonedSection", () => {
  it("parses valid abandoned deps table", () => {
    const result = parseAbandonedSection(RENOVATE_BODY_WITH_ABANDONED);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ datasource: "npm", packageName: "lodash", lastUpdated: "2023-01-15" });
    expect(result[1]).toEqual({ datasource: "pypi", packageName: "requests", lastUpdated: "2022-11-20" });
    expect(result[2]).toEqual({ datasource: "npm", packageName: "@scope/utils", lastUpdated: "2023-03-01" });
  });

  it("returns empty array when no Abandoned section", () => {
    expect(parseAbandonedSection(RENOVATE_BODY_NO_ABANDONED)).toEqual([]);
  });

  it("returns empty array for empty body", () => {
    expect(parseAbandonedSection("")).toEqual([]);
  });

  it("returns empty array for malformed table (too few rows)", () => {
    const body = `## Abandoned\n| Datasource | Package | Last Updated |\n`;
    expect(parseAbandonedSection(body)).toEqual([]);
  });

  it("returns empty array for body with no table rows after separator", () => {
    const body = `## Abandoned\n| Datasource | Package | Last Updated |\n|---|---|---|\n`;
    expect(parseAbandonedSection(body)).toEqual([]);
  });

  it("is fault-tolerant on truncated body", () => {
    const truncated = RENOVATE_BODY_WITH_ABANDONED.slice(0, 80);
    expect(() => parseAbandonedSection(truncated)).not.toThrow();
  });

  it("handles ### header variant", () => {
    const body = `### Abandoned\n\n| Datasource | Package | Last Updated |\n|---|---|---|\n| npm | lodash | 2023-01-15 |\n`;
    const result = parseAbandonedSection(body);
    expect(result).toHaveLength(1);
    expect(result[0]?.packageName).toBe("lodash");
  });

  it("returns empty array on completely invalid input", () => {
    expect(parseAbandonedSection("not markdown at all")).toEqual([]);
    expect(parseAbandonedSection("## Abandoned\nno table here")).toEqual([]);
  });
});

describe("matchAbandonedToPr", () => {
  const deps = [
    { datasource: "npm", packageName: "lodash", lastUpdated: "2023-01-15" },
    { datasource: "pypi", packageName: "requests", lastUpdated: "2022-11-20" },
    { datasource: "npm", packageName: "@scope/utils", lastUpdated: "2023-03-01" },
  ];

  it("returns matching dep when PR title contains package name", () => {
    const pr = makePullRequest({ title: "Bump lodash from 4.0.0 to 4.17.21" });
    const result = matchAbandonedToPr(pr, deps);
    expect(result).toEqual(deps[0]);
  });

  it("is case-insensitive", () => {
    const pr = makePullRequest({ title: "Bump Lodash from 4.0.0 to 4.17.21" });
    expect(matchAbandonedToPr(pr, deps)).toEqual(deps[0]);
  });

  it("returns null when no package matches", () => {
    const pr = makePullRequest({ title: "Bump axios from 0.27 to 1.0.0" });
    expect(matchAbandonedToPr(pr, deps)).toBeNull();
  });

  it("returns null for empty abandoned deps list", () => {
    const pr = makePullRequest({ title: "Bump lodash from 4.0.0 to 4.17.21" });
    expect(matchAbandonedToPr(pr, [])).toBeNull();
  });

  it("handles package names with regex metacharacters (@scope/utils)", () => {
    const pr = makePullRequest({ title: "chore(deps): update dependency @scope/utils to v2" });
    const result = matchAbandonedToPr(pr, deps);
    expect(result).toEqual(deps[2]);
  });

  it("does not throw on adversarial package names with metacharacters", () => {
    const adversarial = [{ datasource: "npm", packageName: "a+b*c?d", lastUpdated: "2023-01-01" }];
    const pr = makePullRequest({ title: "Bump something from 1.0 to 2.0" });
    expect(() => matchAbandonedToPr(pr, adversarial)).not.toThrow();
  });
});

describe("resetAbandonedPatternCache", () => {
  it("clears the regex cache without breaking subsequent matches", () => {
    const deps = [{ datasource: "npm", packageName: "lodash", lastUpdated: "2023-01-15" }];
    const pr = makePullRequest({ title: "Bump lodash from 4.0.0 to 4.17.21" });

    // Populate the cache
    expect(matchAbandonedToPr(pr, deps)).toEqual(deps[0]);

    // Clear it
    resetAbandonedPatternCache();

    // Matching still works (cache rebuilt on demand, not stale)
    expect(matchAbandonedToPr(pr, deps)).toEqual(deps[0]);
  });
});
