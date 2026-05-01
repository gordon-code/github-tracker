import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@solidjs/testing-library";

// ── Module mocks ──────────────────────────────────────────────────────────────

let mockTrackedItems: Array<{ source: string; jiraKey?: string }> = [];
let mockJiraFilters: { scope: string; statusCategory: string; priority: string; sortField: string; sortDirection: string } = { scope: "assigned", statusCategory: "all", priority: "all", sortField: "status", sortDirection: "asc" };

vi.mock("../../../src/app/stores/view", () => ({
  viewState: new Proxy({} as Record<string, unknown>, {
    get(_t, key: string) {
      if (key === "trackedItems") return mockTrackedItems;
      if (key === "tabFilters") return { jiraAssigned: mockJiraFilters };
      if (key === "lockedRepos") return {};
      if (key === "expandedRepos") return { jiraAssigned: new Proxy({}, { get: () => true }) };
      return undefined;
    },
  }),
  setTabFilter: vi.fn(),
  resetAllTabFilters: vi.fn(),
  JiraFiltersSchema: { parse: vi.fn((_x: unknown) => ({ scope: "assigned", statusCategory: "all", priority: "all", sortField: "status", sortDirection: "asc" })) },
  trackItem: vi.fn(),
  untrackJiraItem: vi.fn(),
  setAllExpanded: vi.fn(),
}));

vi.mock("../../../src/app/stores/config", () => ({
  config: { enableTracking: false },
}));

import JiraAssignedTab, { _resetJiraTabState } from "../../../src/app/components/dashboard/JiraAssignedTab";
import type { JiraIssue } from "../../../src/shared/jira-types";
import { config } from "../../../src/app/stores/config";
import { trackItem, untrackJiraItem, setAllExpanded, setTabFilter } from "../../../src/app/stores/view";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeIssue(
  key: string,
  projectKey = "PROJ",
  statusCategory: "new" | "indeterminate" | "done" = "indeterminate",
  priority = "Medium"
): JiraIssue {
  return {
    id: `id-${key}`,
    key,
    self: `https://api.atlassian.com/ex/jira/cloud/rest/api/3/issue/${key}`,
    fields: {
      summary: `Summary for ${key}`,
      status: {
        id: "1",
        name: statusCategory === "new" ? "To Do" : statusCategory === "done" ? "Done" : "In Progress",
        statusCategory: {
          id: statusCategory === "new" ? 2 : statusCategory === "done" ? 3 : 4,
          key: statusCategory,
          name: statusCategory === "new" ? "To Do" : statusCategory === "done" ? "Done" : "In Progress",
        },
      },
      priority: { id: "2", name: priority },
      assignee: { accountId: "u1", displayName: "Alice" },
      project: { id: "p1", key: projectKey, name: `${projectKey} Project` },
      updated: "2026-04-24T12:00:00.000+0000",
    },
  };
}

const SITE_URL = "https://mysite.atlassian.net";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("JiraAssignedTab", () => {
  beforeEach(() => {
    mockTrackedItems = [];
    mockJiraFilters = { scope: "assigned", statusCategory: "all", priority: "all", sortField: "status", sortDirection: "asc" };
    _resetJiraTabState();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Rendering basic issue list ────────────────────────────────────────────

  it("renders issue key and summary for each issue", () => {
    const issues = [makeIssue("PROJ-1"), makeIssue("PROJ-2")];
    render(() => <JiraAssignedTab issues={issues} loading={false} siteUrl={SITE_URL} />);

    expect(screen.getByText("PROJ-1")).toBeTruthy();
    expect(screen.getByText("Summary for PROJ-1")).toBeTruthy();
    expect(screen.getByText("PROJ-2")).toBeTruthy();
    expect(screen.getByText("Summary for PROJ-2")).toBeTruthy();
  });

  it("issue key links to the correct browse URL", () => {
    const issues = [makeIssue("PROJ-42")];
    render(() => <JiraAssignedTab issues={issues} loading={false} siteUrl={SITE_URL} />);

    const links = screen.getAllByRole("link");
    const keyLink = links.find((l) => l.textContent === "PROJ-42");
    expect(keyLink).toBeTruthy();
    expect(keyLink!.getAttribute("href")).toBe(`${SITE_URL}/browse/PROJ-42`);
  });

  it("summary text element has title attribute for truncated hover", () => {
    const issues = [makeIssue("PROJ-1")];
    render(() => <JiraAssignedTab issues={issues} loading={false} siteUrl={SITE_URL} />);
    const summary = screen.getByText("Summary for PROJ-1");
    expect(summary.getAttribute("title")).toBe("Summary for PROJ-1");
  });

  // ── Grouping by project ──────────────────────────────────────────────────

  it("groups issues by project key as section headers", () => {
    const issues = [
      makeIssue("ALPHA-1", "ALPHA"),
      makeIssue("BETA-1", "BETA"),
      makeIssue("ALPHA-2", "ALPHA"),
    ];
    render(() => <JiraAssignedTab issues={issues} loading={false} siteUrl={SITE_URL} />);

    expect(screen.getByText("ALPHA")).toBeTruthy();
    expect(screen.getByText("BETA")).toBeTruthy();
  });

  it("renders issues under their correct project group", () => {
    const issues = [
      makeIssue("ALPHA-1", "ALPHA"),
      makeIssue("BETA-1", "BETA"),
    ];
    render(() => <JiraAssignedTab issues={issues} loading={false} siteUrl={SITE_URL} />);

    expect(screen.getByText("ALPHA-1")).toBeTruthy();
    expect(screen.getByText("BETA-1")).toBeTruthy();
  });

  // ── Status badge colors ───────────────────────────────────────────────────

  it("renders status badge for each issue", () => {
    const issues = [makeIssue("PROJ-1", "PROJ", "new")];
    render(() => <JiraAssignedTab issues={issues} loading={false} siteUrl={SITE_URL} />);
    expect(screen.getByText("To Do")).toBeTruthy();
  });

  it("renders In Progress status badge", () => {
    const issues = [makeIssue("PROJ-1", "PROJ", "indeterminate")];
    render(() => <JiraAssignedTab issues={issues} loading={false} siteUrl={SITE_URL} />);
    expect(screen.getByText("In Progress")).toBeTruthy();
  });

  // ── Filter by statusCategory ─────────────────────────────────────────────

  it("shows all issues when no filters are active (default all/all)", () => {
    const issues = [makeIssue("PROJ-1", "PROJ", "indeterminate")];
    render(() => <JiraAssignedTab issues={issues} loading={false} siteUrl={SITE_URL} />);

    expect(screen.getByText("PROJ-1")).toBeTruthy();
  });

  it("filters out issues that do not match active statusCategory filter", () => {
    mockJiraFilters = { scope: "assigned", statusCategory: "new", priority: "all", sortField: "status", sortDirection: "asc" };
    const issues = [
      makeIssue("PROJ-1", "PROJ", "new"),
      makeIssue("PROJ-2", "PROJ", "indeterminate"),
    ];
    render(() => <JiraAssignedTab issues={issues} loading={false} siteUrl={SITE_URL} />);

    expect(screen.getByText("PROJ-1")).toBeTruthy();
    expect(screen.queryByText("PROJ-2")).toBeNull();
  });

  it("filters out issues that do not match active priority filter", () => {
    mockJiraFilters = { scope: "assigned", statusCategory: "all", priority: "High", sortField: "status", sortDirection: "asc" };
    const issues = [
      makeIssue("PROJ-1", "PROJ", "indeterminate", "High"),
      makeIssue("PROJ-2", "PROJ", "indeterminate", "Medium"),
    ];
    render(() => <JiraAssignedTab issues={issues} loading={false} siteUrl={SITE_URL} />);

    expect(screen.getByText("PROJ-1")).toBeTruthy();
    expect(screen.queryByText("PROJ-2")).toBeNull();
  });

  it("shows empty state when active filter matches nothing", () => {
    mockJiraFilters = { scope: "assigned", statusCategory: "new", priority: "all", sortField: "status", sortDirection: "asc" };
    const issues = [makeIssue("PROJ-1", "PROJ", "indeterminate")];
    render(() => <JiraAssignedTab issues={issues} loading={false} siteUrl={SITE_URL} />);

    expect(screen.queryByText("PROJ-1")).toBeNull();
    expect(screen.getByText(/No issues match current filters/i)).toBeTruthy();
  });

  it("shows 'No Assigned to me Jira issues' when no filters active and list is empty", () => {
    render(() => <JiraAssignedTab issues={[]} loading={false} siteUrl={SITE_URL} />);
    expect(screen.getByText(/No Assigned to me Jira issues/i)).toBeTruthy();
  });

  // ── Empty state ───────────────────────────────────────────────────────────

  it("shows loading spinner when loading=true and no issues yet", () => {
    render(() => <JiraAssignedTab issues={[]} loading={true} siteUrl={SITE_URL} />);
    // LoadingSpinner renders with label text
    expect(screen.getByText(/Loading Jira issues/i)).toBeTruthy();
  });

  it("does not show loading spinner when issues are already present", () => {
    const issues = [makeIssue("PROJ-1")];
    render(() => <JiraAssignedTab issues={issues} loading={true} siteUrl={SITE_URL} />);
    expect(screen.queryByText(/Loading Jira issues/i)).toBeNull();
  });

  // ── Pagination ────────────────────────────────────────────────────────────

  it("does not show pagination when items fit on one page (≤25)", () => {
    const issues = Array.from({ length: 10 }, (_, i) => makeIssue(`PROJ-${i + 1}`));
    render(() => <JiraAssignedTab issues={issues} loading={false} siteUrl={SITE_URL} />);
    expect(screen.queryByRole("button", { name: /next/i })).toBeNull();
  });

  it("shows pagination controls when groups exceed page size", () => {
    const issues = [
      ...Array.from({ length: 15 }, (_, i) => makeIssue(`ALPHA-${i + 1}`, "ALPHA")),
      ...Array.from({ length: 15 }, (_, i) => makeIssue(`BETA-${i + 1}`, "BETA")),
    ];
    render(() => <JiraAssignedTab issues={issues} loading={false} siteUrl={SITE_URL} />);
    expect(screen.getByRole("button", { name: /next/i })).toBeTruthy();
  });

  // ── No atl-paas.net images ────────────────────────────────────────────────

  it("does not render any img with atl-paas.net src", () => {
    const issues = [makeIssue("PROJ-1"), makeIssue("PROJ-2")];
    const { container } = render(() => (
      <JiraAssignedTab issues={issues} loading={false} siteUrl={SITE_URL} />
    ));
    const images = container.querySelectorAll("img");
    for (const img of images) {
      expect(img.getAttribute("src") ?? "").not.toContain("atl-paas.net");
    }
  });

  // ── Priority badge ────────────────────────────────────────────────────────

  it("shows priority badge for non-Medium priorities", () => {
    const issues = [makeIssue("PROJ-1", "PROJ", "indeterminate", "High")];
    render(() => <JiraAssignedTab issues={issues} loading={false} siteUrl={SITE_URL} />);
    expect(screen.getByText("High")).toBeTruthy();
  });

  it("does not show priority badge for Medium priority", () => {
    const issues = [makeIssue("PROJ-1", "PROJ", "indeterminate", "Medium")];
    render(() => <JiraAssignedTab issues={issues} loading={false} siteUrl={SITE_URL} />);
    expect(screen.queryByText("Medium")).toBeNull();
  });

  // ── Issue count ───────────────────────────────────────────────────────────

  it("shows correct issue count in filter toolbar", () => {
    const issues = [makeIssue("PROJ-1"), makeIssue("PROJ-2")];
    render(() => <JiraAssignedTab issues={issues} loading={false} siteUrl={SITE_URL} />);
    expect(screen.getByText("2 issues")).toBeTruthy();
  });

  it("shows '1 issue' (singular) for single issue", () => {
    const issues = [makeIssue("PROJ-1")];
    render(() => <JiraAssignedTab issues={issues} loading={false} siteUrl={SITE_URL} />);
    expect(screen.getByText("1 issue")).toBeTruthy();
  });

  // ── Clear filter button ───────────────────────────────────────────────────

  it("does not show Clear button when no filters are active (default state)", () => {
    const issues = [makeIssue("PROJ-1")];
    render(() => <JiraAssignedTab issues={issues} loading={false} siteUrl={SITE_URL} />);
    expect(screen.queryByRole("button", { name: /clear/i })).toBeNull();
  });

  // ── Pin / unpin tracking (enableTracking: true) ───────────────────────────

  describe("pin/unpin tracking with config.enableTracking: true", () => {
    beforeEach(() => {
      (config as { enableTracking: boolean }).enableTracking = true;
    });

    afterEach(() => {
      (config as { enableTracking: boolean }).enableTracking = false;
    });

    it("renders pin button when tracking is enabled", () => {
      const issues = [makeIssue("PROJ-1")];
      render(() => <JiraAssignedTab issues={issues} loading={false} siteUrl={SITE_URL} />);
      expect(screen.getByRole("button", { name: /pin PROJ-1/i })).toBeTruthy();
    });

    it("calls trackItem when pin button is clicked on an unpinned issue", () => {
      const issue = makeIssue("PROJ-1");
      render(() => <JiraAssignedTab issues={[issue]} loading={false} siteUrl={SITE_URL} />);

      const pinButton = screen.getByRole("button", { name: /pin PROJ-1/i });
      pinButton.click();

      expect(vi.mocked(trackItem)).toHaveBeenCalledOnce();
      const callArg = vi.mocked(trackItem).mock.calls[0][0];
      expect(callArg.id).toBe(parseInt(issue.id, 10));
      expect(callArg.source).toBe("jira");
      expect(callArg.jiraKey).toBe("PROJ-1");
      expect(callArg.type).toBe("jiraIssue");
    });

    it("calls untrackJiraItem when unpinning a pinned issue", () => {
      const issue = makeIssue("PROJ-1");
      // Seed viewState.trackedItems with a matching jira item so isPinned() is true
      mockTrackedItems = [{ source: "jira", jiraKey: "PROJ-1" }];

      render(() => <JiraAssignedTab issues={[issue]} loading={false} siteUrl={SITE_URL} />);

      const unpinButton = screen.getByRole("button", { name: /unpin PROJ-1/i });
      unpinButton.click();

      expect(vi.mocked(untrackJiraItem)).toHaveBeenCalledOnce();
      expect(vi.mocked(untrackJiraItem)).toHaveBeenCalledWith("PROJ-1");
    });
  });

  // ── Sort ordering ──────────────────────────────────────────────────────────

  it("renders issues in status SDLC order by default (To Do → Done)", () => {
    const issues = [
      makeIssue("PROJ-1", "PROJ", "done"),
      makeIssue("PROJ-2", "PROJ", "new"),
      makeIssue("PROJ-3", "PROJ", "indeterminate"),
    ];
    render(() => <JiraAssignedTab issues={issues} loading={false} siteUrl={SITE_URL} />);

    const items = screen.getAllByRole("listitem");
    const keys = items.map((el) => el.querySelector(".font-mono")?.textContent).filter(Boolean);
    expect(keys).toEqual(["PROJ-2", "PROJ-3", "PROJ-1"]);
  });

  it("renders sort dropdown", () => {
    const issues = [makeIssue("PROJ-1")];
    render(() => <JiraAssignedTab issues={issues} loading={false} siteUrl={SITE_URL} />);
    const sortButtons = screen.getAllByRole("button").filter((b) => /sort by/i.test(b.getAttribute("aria-label") ?? ""));
    expect(sortButtons.length).toBeGreaterThan(0);
  });

  // ── Expand / collapse ──────────────────────────────────────────────────────

  it("renders project group header with expand toggle button", () => {
    const issues = [makeIssue("PROJ-1")];
    render(() => <JiraAssignedTab issues={issues} loading={false} siteUrl={SITE_URL} />);

    const toggleButton = screen.getByRole("button", { expanded: true });
    expect(toggleButton).toBeTruthy();
    expect(toggleButton.textContent).toContain("PROJ");
  });

  it("calls setAllExpanded when project header is clicked", () => {
    const issues = [makeIssue("PROJ-1")];
    render(() => <JiraAssignedTab issues={issues} loading={false} siteUrl={SITE_URL} />);

    const header = screen.getByRole("button", { expanded: true });
    header.click();

    expect(vi.mocked(setAllExpanded)).toHaveBeenCalled();
  });

  it("renders expand-all and collapse-all buttons", () => {
    const issues = [makeIssue("PROJ-1")];
    render(() => <JiraAssignedTab issues={issues} loading={false} siteUrl={SITE_URL} />);
    expect(screen.getByRole("button", { name: /expand all/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /collapse all/i })).toBeTruthy();
  });

  // ── View density ───────────────────────────────────────────────────────────

  it("does not show assignee name (redundant in assigned-to-me tab)", () => {
    const issues = [makeIssue("PROJ-1")];
    render(() => <JiraAssignedTab issues={issues} loading={false} siteUrl={SITE_URL} />);
    expect(screen.queryByText("Alice")).toBeNull();
  });

  it("renders summary as <p> in comfortable mode", () => {
    const issues = [makeIssue("PROJ-1")];
    render(() => <JiraAssignedTab issues={issues} loading={false} siteUrl={SITE_URL} />);
    const summary = screen.getByText("Summary for PROJ-1");
    expect(summary.tagName).toBe("P");
  });

  it("renders summary inline with key in compact mode", () => {
    (config as { viewDensity: string }).viewDensity = "compact";
    const issues = [makeIssue("PROJ-1")];
    render(() => <JiraAssignedTab issues={issues} loading={false} siteUrl={SITE_URL} />);
    const summary = screen.getByText("Summary for PROJ-1");
    expect(summary.tagName).toBe("SPAN");
    (config as { viewDensity: string }).viewDensity = "comfortable";
  });

  // ── URL validation ─────────────────────────────────────────────────────────

  it("uses # href when siteUrl is not a safe Jira URL", () => {
    const issues = [makeIssue("PROJ-1")];
    render(() => <JiraAssignedTab issues={issues} loading={false} siteUrl="javascript:alert(1)" />);

    const links = screen.getAllByRole("link");
    const keyLink = links.find((l) => l.textContent === "PROJ-1");
    expect(keyLink!.getAttribute("href")).toBe("#");
  });

  // ── Scope dropdown ─────────────────────────────────────────────────────────

  describe("scope dropdown", () => {
    it("scope filter button is present with label 'Scope'", () => {
      const issues = [makeIssue("PROJ-1")];
      render(() => <JiraAssignedTab issues={issues} loading={false} siteUrl={SITE_URL} />);
      // FilterPopover trigger has aria-label "Filter by Scope"
      expect(screen.getByRole("button", { name: /filter by scope/i })).toBeTruthy();
    });

    it("scope trigger shows built-in label 'Assigned to me' when scope=assigned", () => {
      mockJiraFilters = { scope: "assigned", statusCategory: "all", priority: "all", sortField: "status", sortDirection: "asc" };
      const issues = [makeIssue("PROJ-1")];
      render(() => <JiraAssignedTab issues={issues} loading={false} siteUrl={SITE_URL} />);
      // When non-default value, the trigger shows "Scope: <label>" — default is "assigned"
      // so the trigger just shows "Scope" (no colon)
      const trigger = screen.getByRole("button", { name: /filter by scope/i });
      expect(trigger.textContent).toContain("Scope");
    });

    it("scope trigger reflects 'Created by me' label when scope=reported", () => {
      mockJiraFilters = { scope: "reported", statusCategory: "all", priority: "all", sortField: "status", sortDirection: "asc" };
      const issues = [makeIssue("PROJ-1")];
      render(() => <JiraAssignedTab issues={issues} loading={false} siteUrl={SITE_URL} />);
      const trigger = screen.getByRole("button", { name: /filter by scope/i });
      // Non-default value → trigger shows "Scope: Created by me"
      expect(trigger.textContent).toContain("Created by me");
    });

    it("scope trigger reflects custom scope name when custom scope is active", () => {
      (config as Record<string, unknown>).jira = { customScopes: [{ id: "customfield_10001", name: "My Assignee Field" }] };
      mockJiraFilters = { scope: "customfield_10001", statusCategory: "all", priority: "all", sortField: "status", sortDirection: "asc" };
      const issues = [makeIssue("PROJ-1")];
      render(() => <JiraAssignedTab issues={issues} loading={false} siteUrl={SITE_URL} />);
      const trigger = screen.getByRole("button", { name: /filter by scope/i });
      expect(trigger.textContent).toContain("My Assignee Field");
      // Restore
      (config as Record<string, unknown>).jira = { customScopes: [] };
    });
  });

  // ── Expanded issue detail panel ────────────────────────────────────────────

  describe("expanded issue detail panel", () => {
    it("shows 'No custom fields configured' when no custom fields are set", () => {
      (config as Record<string, unknown>).jira = { customFields: [] };
      const issues = [makeIssue("PROJ-1")];
      render(() => <JiraAssignedTab issues={issues} loading={false} siteUrl={SITE_URL} />);

      // Click expand button for PROJ-1
      const expandBtn = screen.getByRole("button", { name: /expand PROJ-1 details/i });
      expandBtn.click();

      expect(screen.getByText(/No custom fields configured/i)).toBeTruthy();
      (config as Record<string, unknown>).jira = { customFields: [] };
    });

    it("multiple issues can be expanded simultaneously", () => {
      (config as Record<string, unknown>).jira = { customFields: [] };
      const issues = [makeIssue("PROJ-1"), makeIssue("PROJ-2")];
      render(() => <JiraAssignedTab issues={issues} loading={false} siteUrl={SITE_URL} />);

      screen.getByRole("button", { name: /expand PROJ-1 details/i }).click();
      screen.getByRole("button", { name: /expand PROJ-2 details/i }).click();

      // Both should now show the "No custom fields configured" message
      const msgs = screen.getAllByText(/No custom fields configured/i);
      expect(msgs.length).toBe(2);
      (config as Record<string, unknown>).jira = { customFields: [] };
    });

    it("chevron button has aria-expanded='false' initially", () => {
      (config as Record<string, unknown>).jira = { customFields: [] };
      const issues = [makeIssue("PROJ-1")];
      render(() => <JiraAssignedTab issues={issues} loading={false} siteUrl={SITE_URL} />);

      const expandBtn = screen.getByRole("button", { name: /expand PROJ-1 details/i });
      expect(expandBtn.getAttribute("aria-expanded")).toBe("false");
      (config as Record<string, unknown>).jira = { customFields: [] };
    });

    it("click chevron → aria-expanded becomes true and detail panel is visible", () => {
      (config as Record<string, unknown>).jira = { customFields: [] };
      const issues = [makeIssue("PROJ-1")];
      render(() => <JiraAssignedTab issues={issues} loading={false} siteUrl={SITE_URL} />);

      const expandBtn = screen.getByRole("button", { name: /expand PROJ-1 details/i });
      expandBtn.click();

      expect(expandBtn.getAttribute("aria-expanded")).toBe("true");
      expect(screen.getByText(/No custom fields configured/i)).toBeTruthy();
      (config as Record<string, unknown>).jira = { customFields: [] };
    });

    it("click chevron again collapses the panel", () => {
      (config as Record<string, unknown>).jira = { customFields: [] };
      const issues = [makeIssue("PROJ-1")];
      render(() => <JiraAssignedTab issues={issues} loading={false} siteUrl={SITE_URL} />);

      const expandBtn = screen.getByRole("button", { name: /expand PROJ-1 details/i });
      expandBtn.click();
      expect(screen.getByText(/No custom fields configured/i)).toBeTruthy();

      // After second click, label changes to "Expand" and panel is gone
      const collapseBtn = screen.getByRole("button", { name: /collapse PROJ-1 details/i });
      collapseBtn.click();

      expect(screen.queryByText(/No custom fields configured/i)).toBeNull();
      (config as Record<string, unknown>).jira = { customFields: [] };
    });

    it("expanded panel shows custom field names and values when fields are configured", () => {
      (config as Record<string, unknown>).jira = {
        customFields: [{ id: "customfield_10001", name: "Team" }],
      };
      const issue = makeIssue("PROJ-1");
      (issue.fields as Record<string, unknown>)["customfield_10001"] = "Platform";

      render(() => <JiraAssignedTab issues={[issue]} loading={false} siteUrl={SITE_URL} />);

      screen.getByRole("button", { name: /expand PROJ-1 details/i }).click();

      expect(screen.getByText("Team:")).toBeTruthy();
      expect(screen.getByText("Platform")).toBeTruthy();
      (config as Record<string, unknown>).jira = { customFields: [] };
    });
  });

  // ── Stale scope guard ──────────────────────────────────────────────────────

  describe("stale scope guard", () => {
    it("resets scope to 'assigned' when active scope is not in scopeOptions on mount", () => {
      // config has no custom scopes, but active filter has a custom scope ID.
      // On mount the stale guard fires: "customfield_10001" is not in built-in options → reset.
      (config as Record<string, unknown>).jira = { customScopes: [] };
      mockJiraFilters = { scope: "customfield_10001", statusCategory: "all", priority: "all", sortField: "status", sortDirection: "asc" };

      const issues = [makeIssue("PROJ-1")];
      render(() => <JiraAssignedTab issues={issues} loading={false} siteUrl={SITE_URL} />);

      // The createEffect on mount detects the invalid scope and calls setTabFilter
      expect(vi.mocked(setTabFilter)).toHaveBeenCalledWith("jiraAssigned", "scope", "assigned");
      (config as Record<string, unknown>).jira = { customScopes: [] };
    });
  });
});
