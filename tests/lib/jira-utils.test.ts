import { describe, it, expect, vi } from "vitest";
import { mergeCustomFields, jiraJqlForScope } from "../../src/app/lib/jira-utils";
import { DEFAULT_FIELDS } from "../../src/app/services/jira-client";

// jira-utils imports from stores/auth which uses SolidJS signals — mock it out
vi.mock("../../src/app/stores/auth", () => ({
  jiraAuth: vi.fn().mockReturnValue(null),
  ensureJiraTokenValid: vi.fn().mockResolvedValue(true),
}));

// ── mergeCustomFields ─────────────────────────────────────────────────────────

describe("mergeCustomFields", () => {
  it("returns exactly DEFAULT_FIELDS when customFields is empty", () => {
    const result = mergeCustomFields([]);
    expect(result).toEqual(DEFAULT_FIELDS);
  });

  it("returns DEFAULT_FIELDS plus 3 custom field IDs", () => {
    const result = mergeCustomFields([
      { id: "customfield_10001" },
      { id: "customfield_10002" },
      { id: "customfield_10003" },
    ]);
    expect(result).toEqual([
      ...DEFAULT_FIELDS,
      "customfield_10001",
      "customfield_10002",
      "customfield_10003",
    ]);
  });

  it("filters out field IDs with invalid characters", () => {
    const result = mergeCustomFields([{ id: "custom;DROP" }]);
    expect(result).toEqual(DEFAULT_FIELDS);
    expect(result).not.toContain("custom;DROP");
  });

  it("filters out field IDs with spaces", () => {
    const result = mergeCustomFields([{ id: "custom field" }]);
    expect(result).toEqual(DEFAULT_FIELDS);
  });

  it("passes valid field IDs through unchanged", () => {
    const result = mergeCustomFields([{ id: "customfield_10001" }]);
    expect(result).toContain("customfield_10001");
    expect(result[result.length - 1]).toBe("customfield_10001");
  });

  it("keeps valid IDs and filters invalid ones in a mixed list", () => {
    const result = mergeCustomFields([
      { id: "customfield_10001" },
      { id: "bad;field" },
      { id: "customfield_10002" },
    ]);
    expect(result).toContain("customfield_10001");
    expect(result).toContain("customfield_10002");
    expect(result).not.toContain("bad;field");
  });

  it("does not duplicate DEFAULT_FIELDS entries", () => {
    const result = mergeCustomFields([]);
    const unique = new Set(result);
    expect(unique.size).toBe(result.length);
  });
});

// ── jiraJqlForScope ───────────────────────────────────────────────────────────

describe("jiraJqlForScope", () => {
  it("'assigned' contains 'assignee = currentUser()'", () => {
    const jql = jiraJqlForScope("assigned");
    expect(jql).toContain("assignee = currentUser()");
  });

  it("'reported' contains 'reporter = currentUser()'", () => {
    const jql = jiraJqlForScope("reported");
    expect(jql).toContain("reporter = currentUser()");
  });

  it("'watching' contains 'watcher = currentUser()'", () => {
    const jql = jiraJqlForScope("watching");
    expect(jql).toContain("watcher = currentUser()");
  });

  it("'customfield_10001' contains 'customfield_10001 in (currentUser())'", () => {
    const jql = jiraJqlForScope("customfield_10001");
    expect(jql).toContain("customfield_10001 in (currentUser())");
  });

  it("invalid scope 'custom;DROP' falls back to assignee = currentUser()", () => {
    const jql = jiraJqlForScope("custom;DROP");
    expect(jql).toContain("assignee = currentUser()");
    expect(jql).not.toContain("custom;DROP");
  });

  it("invalid scope with spaces falls back to assignee = currentUser()", () => {
    const jql = jiraJqlForScope("my bad scope");
    expect(jql).toContain("assignee = currentUser()");
  });

  it("all scopes include statusCategory != Done filter", () => {
    expect(jiraJqlForScope("assigned")).toContain("statusCategory != Done");
    expect(jiraJqlForScope("reported")).toContain("statusCategory != Done");
    expect(jiraJqlForScope("watching")).toContain("statusCategory != Done");
    expect(jiraJqlForScope("customfield_10001")).toContain("statusCategory != Done");
  });
});
