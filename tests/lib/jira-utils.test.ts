import { describe, it, expect, vi, beforeEach } from "vitest";
import { mergeCustomFields, jiraJqlForScope, createJiraClient } from "../../src/app/lib/jira-utils";
import { DEFAULT_FIELDS, JiraClient, JiraProxyClient } from "../../src/app/services/jira-client";

// jira-utils imports from stores/auth which uses SolidJS signals — mock it out
// Note: vi.mock factories are hoisted before variable declarations, so we cannot
// reference module-level variables inside them. Use vi.fn() directly and access
// the mocked module via import after hoisting.
vi.mock("../../src/app/stores/auth", () => ({
  jiraAuth: vi.fn().mockReturnValue(null),
  ensureJiraTokenValid: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../src/app/services/jira-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/app/services/jira-client")>();
  // Must use function expressions (not arrow functions) so they can be called with `new`
  return {
    ...actual,
    JiraClient: vi.fn(function (this: Record<string, unknown>, ...args: unknown[]) { this._type = "JiraClient"; this.args = args; }),
    JiraProxyClient: vi.fn(function (this: Record<string, unknown>, ...args: unknown[]) { this._type = "JiraProxyClient"; this.args = args; }),
  };
});

import { jiraAuth as _jiraAuth, ensureJiraTokenValid as _ensureJiraTokenValid } from "../../src/app/stores/auth";

// vi.mocked() infers Accessor<...> for jiraAuth which lacks mock methods — cast to any-mock first
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockJiraAuth = _jiraAuth as unknown as ReturnType<typeof vi.fn>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockEnsureJiraTokenValid = _ensureJiraTokenValid as unknown as ReturnType<typeof vi.fn>;

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

// ── createJiraClient ──────────────────────────────────────────────────────────

describe("createJiraClient", () => {
  beforeEach(() => {
    mockJiraAuth.mockReturnValue(null);
    mockEnsureJiraTokenValid.mockResolvedValue(true);
    vi.mocked(JiraClient).mockClear();
    vi.mocked(JiraProxyClient).mockClear();
  });

  it("returns null when authMethod is undefined", () => {
    mockJiraAuth.mockReturnValue({ cloudId: "cloud1", email: "a@b.com", accessToken: "tok" });
    const result = createJiraClient(undefined);
    expect(result).toBeNull();
  });

  it("returns null when jiraAuth() is null", () => {
    mockJiraAuth.mockReturnValue(null);
    const result = createJiraClient("token");
    expect(result).toBeNull();
  });

  it("returns null when authMethod is 'token' but auth.email is missing", () => {
    mockJiraAuth.mockReturnValue({ cloudId: "cloud1", email: undefined, accessToken: "tok" });
    const result = createJiraClient("token");
    expect(result).toBeNull();
  });

  it("returns JiraProxyClient when authMethod is 'token' and email is present", () => {
    mockJiraAuth.mockReturnValue({ cloudId: "cloud1", email: "user@example.com", accessToken: "sealed-tok" });
    const result = createJiraClient("token");
    expect(result).not.toBeNull();
    expect(vi.mocked(JiraProxyClient)).toHaveBeenCalledOnce();
    expect(vi.mocked(JiraProxyClient)).toHaveBeenCalledWith("cloud1", "user@example.com", "sealed-tok", undefined);
  });

  it("returns JiraClient when authMethod is 'oauth'", () => {
    mockJiraAuth.mockReturnValue({ cloudId: "cloud1", email: "user@example.com", accessToken: "oauth-tok" });
    const result = createJiraClient("oauth");
    expect(result).not.toBeNull();
    expect(vi.mocked(JiraClient)).toHaveBeenCalledOnce();
    expect(vi.mocked(JiraClient).mock.calls[0][0]).toBe("cloud1");
    expect(typeof vi.mocked(JiraClient).mock.calls[0][1]).toBe("function");
  });

  it("oauth getAccessToken throws when jiraAuth() returns null mid-refresh", async () => {
    mockJiraAuth.mockReturnValue({ cloudId: "cloud1", email: "u@x.com", accessToken: "tok" });
    createJiraClient("oauth");
    expect(vi.mocked(JiraClient)).toHaveBeenCalledOnce();
    const getAccessToken = vi.mocked(JiraClient).mock.calls[0][1];

    // Simulate auth being cleared after ensureJiraTokenValid resolves
    mockEnsureJiraTokenValid.mockResolvedValue(true);
    mockJiraAuth.mockReturnValue(null);

    await expect(getAccessToken()).rejects.toThrow("Jira auth cleared during token refresh");
  });
});
