import { describe, it, expect } from "vitest";
import { extractJiraKeys, isReadOnlyGraphqlQuery } from "../../src/shared/validation";

// ── Jira key pattern (via extractJiraKeys) ───────────────────────────────────

describe("Jira key pattern", () => {
  it("matches a standard Jira key", () => {
    expect(extractJiraKeys("PROJ-123")).toEqual(["PROJ-123"]);
  });

  it("does not match lowercase keys", () => {
    expect(extractJiraKeys("proj-123")).toEqual([]);
  });

  it("does not match a key that is a substring within a word boundary", () => {
    expect(extractJiraKeys("NOPROJ-1X")).toEqual([]);
  });

  it("matches project prefix of 2 characters minimum", () => {
    expect(extractJiraKeys("AB-1 ZZ-99")).toEqual(["AB-1", "ZZ-99"]);
  });

  it("matches project prefix up to 10 characters", () => {
    expect(extractJiraKeys("ABCDEFGHIJ-1")).toEqual(["ABCDEFGHIJ-1"]);
  });

  it("does not match project prefix exceeding 10 characters", () => {
    expect(extractJiraKeys("ABCDEFGHIJK-1")).not.toContain("ABCDEFGHIJK-1");
  });

  it("does not match a single uppercase letter prefix (less than 2)", () => {
    expect(extractJiraKeys("A-1")).toEqual([]);
  });
});

// ── extractJiraKeys ───────────────────────────────────────────────────────────

describe("extractJiraKeys", () => {
  it("extracts a single key from text", () => {
    expect(extractJiraKeys("PROJ-123 fix login")).toEqual(["PROJ-123"]);
  });

  it("extracts multiple distinct keys from text", () => {
    const result = extractJiraKeys("PROJ-1 and TEAM-42 need review");
    expect(result).toEqual(["PROJ-1", "TEAM-42"]);
  });

  it("deduplicates repeated keys", () => {
    expect(extractJiraKeys("PROJ-1 PROJ-1 PROJ-1")).toEqual(["PROJ-1"]);
  });

  it("deduplicates keys that appear in different positions", () => {
    const result = extractJiraKeys("fixes PROJ-1 and also PROJ-1");
    expect(result).toEqual(["PROJ-1"]);
  });

  it("returns empty array when no keys are present", () => {
    expect(extractJiraKeys("no jira keys here")).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(extractJiraKeys("")).toEqual([]);
  });

  it("does not match lowercase key format", () => {
    expect(extractJiraKeys("proj-123 fix")).toEqual([]);
  });

  it("does not match mixed-case key (lowercase suffix)", () => {
    expect(extractJiraKeys("Proj-123 fix")).toEqual([]);
  });

  it("does not match key embedded inside a longer word (boundary test)", () => {
    // NOPROJ-1X: no word boundary after the digit sequence
    expect(extractJiraKeys("NOPROJ-1X")).toEqual([]);
  });

  it("extracts key from branch name format", () => {
    expect(extractJiraKeys("feat/PROJ-123-fix-login")).toEqual(["PROJ-123"]);
  });

  it("extracts multiple keys from a branch name with multiple keys", () => {
    expect(extractJiraKeys("feat/PROJ-1-and-TEAM-42-work")).toEqual(["PROJ-1", "TEAM-42"]);
  });

  it("extracts key from a PR title with surrounding text", () => {
    expect(extractJiraKeys("[PROJ-456] Fix authentication bug")).toEqual(["PROJ-456"]);
  });

  it("handles text with no word boundary after digits correctly (valid boundary)", () => {
    // PROJ-1 followed by space — valid word boundary on right
    expect(extractJiraKeys("fix PROJ-1 now")).toEqual(["PROJ-1"]);
  });

  it("resets regex lastIndex so repeated calls return correct results", () => {
    // Call twice to verify the global regex lastIndex is reset between calls
    const first = extractJiraKeys("PROJ-1 TEAM-2");
    const second = extractJiraKeys("PROJ-1 TEAM-2");
    expect(first).toEqual(second);
    expect(second).toEqual(["PROJ-1", "TEAM-2"]);
  });

  it("returns keys in order of first appearance", () => {
    const result = extractJiraKeys("TEAM-42 PROJ-1 TEAM-42");
    expect(result[0]).toBe("TEAM-42");
    expect(result[1]).toBe("PROJ-1");
  });
});

// ── isReadOnlyGraphqlQuery ────────────────────────────────────────────────────

describe("isReadOnlyGraphqlQuery", () => {
  it("allows shorthand and named query operations", () => {
    expect(isReadOnlyGraphqlQuery("{ viewer { login } }")).toBe(true);
    expect(isReadOnlyGraphqlQuery("query GetViewer { viewer { login } }")).toBe(true);
  });

  it("ignores mutation/subscription keywords inside comments and string literals", () => {
    expect(
      isReadOnlyGraphqlQuery(
        '# mutation fake\nquery { search(query: "mutation subscription", type: ISSUE, first: 1) { issueCount } }'
      )
    ).toBe(true);
    expect(
      isReadOnlyGraphqlQuery(
        'query { search(query: """mutation { closePullRequest }""", type: ISSUE, first: 1) { issueCount } }'
      )
    ).toBe(true);
  });

  it("rejects mutations, comment-prefixed mutations, subscriptions, empty queries, and non-strings", () => {
    expect(
      isReadOnlyGraphqlQuery('mutation { closePullRequest(input: { pullRequestId: "PR_1" }) { clientMutationId } }')
    ).toBe(false);
    expect(
      isReadOnlyGraphqlQuery(
        '# query { viewer { login } }\nmutation { closePullRequest(input: { pullRequestId: "PR_1" }) { clientMutationId } }'
      )
    ).toBe(false);
    expect(isReadOnlyGraphqlQuery("subscription { viewer { login } }")).toBe(false);
    expect(isReadOnlyGraphqlQuery("# only a comment")).toBe(false);
    expect(isReadOnlyGraphqlQuery("   ")).toBe(false);
    expect(isReadOnlyGraphqlQuery(undefined)).toBe(false);
    expect(isReadOnlyGraphqlQuery(null)).toBe(false);
  });
});
