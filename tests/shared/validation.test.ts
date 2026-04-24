import { describe, it, expect } from "vitest";
import { JIRA_KEY_REGEX, extractJiraKeys } from "../../src/shared/validation";

// ── JIRA_KEY_REGEX ────────────────────────────────────────────────────────────

describe("JIRA_KEY_REGEX", () => {
  it("matches a standard Jira key", () => {
    JIRA_KEY_REGEX.lastIndex = 0;
    const matches = "PROJ-123".matchAll(JIRA_KEY_REGEX);
    expect([...matches].map((m) => m[1])).toEqual(["PROJ-123"]);
  });

  it("does not match lowercase keys", () => {
    JIRA_KEY_REGEX.lastIndex = 0;
    const matches = "proj-123".matchAll(JIRA_KEY_REGEX);
    expect([...matches]).toHaveLength(0);
  });

  it("does not match a key that is a substring within a word boundary", () => {
    // NOPROJ-1X: the X after the digits means it's not at a word boundary
    JIRA_KEY_REGEX.lastIndex = 0;
    const matches = "NOPROJ-1X".matchAll(JIRA_KEY_REGEX);
    // NOPROJ-1 should not match because NOPROJ-1X is one token (no word boundary after 1)
    expect([...matches]).toHaveLength(0);
  });

  it("matches project prefix of 2 characters minimum", () => {
    JIRA_KEY_REGEX.lastIndex = 0;
    const matches = "AB-1 ZZ-99".matchAll(JIRA_KEY_REGEX);
    expect([...matches].map((m) => m[1])).toEqual(["AB-1", "ZZ-99"]);
  });

  it("matches project prefix up to 10 characters", () => {
    JIRA_KEY_REGEX.lastIndex = 0;
    const matches = "ABCDEFGHIJ-1".matchAll(JIRA_KEY_REGEX);
    expect([...matches].map((m) => m[1])).toEqual(["ABCDEFGHIJ-1"]);
  });

  it("does not match project prefix exceeding 10 characters", () => {
    JIRA_KEY_REGEX.lastIndex = 0;
    const matches = "ABCDEFGHIJK-1".matchAll(JIRA_KEY_REGEX);
    // May match a 10-char sub-prefix; we just confirm ABCDEFGHIJK-1 isn't captured as a whole
    const allMatches = [...matches].map((m) => m[1]);
    expect(allMatches).not.toContain("ABCDEFGHIJK-1");
  });

  it("does not match a single uppercase letter prefix (less than 2)", () => {
    JIRA_KEY_REGEX.lastIndex = 0;
    const matches = "A-1".matchAll(JIRA_KEY_REGEX);
    expect([...matches]).toHaveLength(0);
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
