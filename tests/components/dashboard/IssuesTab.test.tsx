import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { makeIssue, makeTrackedItem } from "../../helpers/index";

// ── localStorage mock ─────────────────────────────────────────────────────────

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, val: string) => { store[key] = val; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
  };
})();

Object.defineProperty(globalThis, "localStorage", {
  value: localStorageMock,
  writable: true,
  configurable: true,
});

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("../../../src/app/lib/url", () => ({
  isSafeGitHubUrl: () => true,
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { produce } from "solid-js/store";
import IssuesTab from "../../../src/app/components/dashboard/IssuesTab";
import { viewState, setViewState, setTabFilter, setAllExpanded, resetViewState, updateViewState } from "../../../src/app/stores/view";
import { updateConfig, resetConfig } from "../../../src/app/stores/config";
import type { TrackedUser } from "../../../src/app/stores/config";

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  localStorageMock.clear();
  resetViewState();
  resetConfig();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("IssuesTab — user filter", () => {
  it("does not show User filter when allUsers has only 1 entry (no tracked users)", () => {
    render(() => (
      <IssuesTab
        issues={[makeIssue()]}
        userLogin="me"
        allUsers={[{ login: "me", label: "Me" }]}
      />
    ));
    // FilterToolbar renders a popover trigger — absent when only 1 user
    expect(screen.queryByLabelText("Filter by User")).toBeNull();
  });

  it("shows User filter when allUsers has > 1 entry", () => {
    render(() => (
      <IssuesTab
        issues={[makeIssue()]}
        userLogin="me"
        allUsers={[
          { login: "me", label: "Me" },
          { login: "tracked1", label: "tracked1" },
        ]}
      />
    ));
    screen.getByLabelText("Filter by User");
  });

  it("does not show User filter when allUsers is undefined", () => {
    render(() => (
      <IssuesTab issues={[makeIssue()]} userLogin="me" />
    ));
    expect(screen.queryByLabelText("Filter by User")).toBeNull();
  });
});

describe("IssuesTab — user filter logic", () => {
  it("shows all issues when user filter is 'all'", () => {
    // Use distinct repos so expand state can be set per repo
    const issues = [
      makeIssue({ id: 1, title: "Main issue", repoFullName: "owner/repo-a", surfacedBy: ["me"] }),
      makeIssue({ id: 2, title: "Tracked issue", repoFullName: "owner/repo-b", surfacedBy: ["tracked1"] }),
    ];
    setTabFilter("issues", "scope", "all");
    setAllExpanded("issues", ["owner/repo-a", "owner/repo-b"], true);

    render(() => (
      <IssuesTab
        issues={issues}
        userLogin="me"
        allUsers={[
          { login: "me", label: "Me" },
          { login: "tracked1", label: "tracked1" },
        ]}
      />
    ));

    screen.getByText("Main issue");
    screen.getByText("Tracked issue");
  });

  it("filters issues to only the tracked user's items when user filter is set", () => {
    const issues = [
      makeIssue({ id: 1, title: "Main issue", repoFullName: "owner/repo-a", surfacedBy: ["me"] }),
      makeIssue({ id: 2, title: "Tracked issue", repoFullName: "owner/repo-b", surfacedBy: ["tracked1"] }),
    ];

    setTabFilter("issues", "scope", "all");
    setTabFilter("issues", "user", "tracked1");
    setAllExpanded("issues", ["owner/repo-a", "owner/repo-b"], true);

    render(() => (
      <IssuesTab
        issues={issues}
        userLogin="me"
        allUsers={[
          { login: "me", label: "Me" },
          { login: "tracked1", label: "tracked1" },
        ]}
      />
    ));

    expect(screen.queryByText("Main issue")).toBeNull();
    screen.getByText("Tracked issue");
  });

  it("uses userLogin as fallback surfacedBy for items with undefined surfacedBy", () => {
    const issues = [
      makeIssue({ id: 1, title: "Legacy issue", repoFullName: "owner/repo", surfacedBy: undefined }),
    ];

    // Filter to "me" — legacy items without surfacedBy should show as belonging to the main user
    setTabFilter("issues", "user", "me");
    setAllExpanded("issues", ["owner/repo"], true);

    render(() => (
      <IssuesTab
        issues={issues}
        userLogin="me"
        allUsers={[
          { login: "me", label: "Me" },
          { login: "tracked1", label: "tracked1" },
        ]}
      />
    ));

    screen.getByText("Legacy issue");
  });

  it("hides legacy issues (no surfacedBy) when filtered to tracked user", () => {
    const issues = [
      makeIssue({ id: 1, title: "Legacy issue", repoFullName: "owner/repo", surfacedBy: undefined }),
    ];

    setTabFilter("issues", "user", "tracked1");
    setAllExpanded("issues", ["owner/repo"], true);

    render(() => (
      <IssuesTab
        issues={issues}
        userLogin="me"
        allUsers={[
          { login: "me", label: "Me" },
          { login: "tracked1", label: "tracked1" },
        ]}
      />
    ));

    expect(screen.queryByText("Legacy issue")).toBeNull();
  });

  it("shows all items when user filter references a removed tracked user (stale filter)", () => {
    const issues = [
      makeIssue({ id: 1, title: "My issue", repoFullName: "owner/repo", surfacedBy: ["me"] }),
    ];

    // Set filter to a user that no longer exists in allUsers
    setTabFilter("issues", "user", "removed-user");
    setAllExpanded("issues", ["owner/repo"], true);

    render(() => (
      <IssuesTab
        issues={issues}
        userLogin="me"
        allUsers={[{ login: "me", label: "Me" }]}
      />
    ));

    // Stale filter value should be ignored — items still visible
    screen.getByText("My issue");
  });
});

describe("IssuesTab — avatar badge", () => {
  it("renders avatar img for items surfaced by tracked users", () => {
    const trackedUsers: TrackedUser[] = [
      { login: "tracked1", avatarUrl: "https://avatars.githubusercontent.com/u/1", name: "Tracked One", type: "user" as const },
    ];
    const issues = [
      makeIssue({ id: 1, title: "Tracked issue", repoFullName: "owner/repo", surfacedBy: ["tracked1"] }),
    ];

    setTabFilter("issues", "scope", "all");
    setAllExpanded("issues", ["owner/repo"], true);

    render(() => (
      <IssuesTab
        issues={issues}
        userLogin="me"
        trackedUsers={trackedUsers}
        allUsers={[
          { login: "me", label: "Me" },
          { login: "tracked1", label: "tracked1" },
        ]}
      />
    ));

    // Avatar img should be present (tracked1 is not the current user "me")
    const img = screen.getByAltText("tracked1");
    expect(img.getAttribute("src")).toBe("https://avatars.githubusercontent.com/u/1");
  });

  it("does not render avatar badge when trackedUsers is empty", () => {
    const issues = [
      makeIssue({ id: 1, title: "My issue", repoFullName: "owner/repo", surfacedBy: ["me"] }),
    ];

    setAllExpanded("issues", ["owner/repo"], true);

    const { container } = render(() => (
      <IssuesTab
        issues={issues}
        userLogin="me"
        trackedUsers={[]}
      />
    ));

    expect(container.querySelector(".avatar")).toBeNull();
  });
});

// ── IssuesTab — monitored repos bypass (C6) ───────────────────────────────────

describe("IssuesTab — monitored repos filter bypass", () => {
  it("shows issue from monitored repo even when user filter excludes it", () => {
    const issues = [
      makeIssue({ id: 1, title: "Monitored issue", repoFullName: "org/monitored", surfacedBy: ["other-user"] }),
    ];
    setTabFilter("issues", "scope", "all");
    setTabFilter("issues", "user", "me");
    setAllExpanded("issues", ["org/monitored"], true);

    render(() => (
      <IssuesTab
        issues={issues}
        userLogin="me"
        allUsers={[{ login: "me", label: "Me" }, { login: "other-user", label: "other-user" }]}
        monitoredRepos={[{ owner: "org", name: "monitored", fullName: "org/monitored" }]}
      />
    ));

    screen.getByText("Monitored issue");
  });

  it("hides issue from non-monitored repo when user filter excludes it", () => {
    const issues = [
      makeIssue({ id: 100, title: "Non-monitored issue", repoFullName: "org/regular", surfacedBy: ["other-user"] }),
    ];
    setTabFilter("issues", "user", "me");

    render(() => (
      <IssuesTab
        issues={issues}
        userLogin="me"
        allUsers={[{ login: "me", label: "Me" }, { login: "other-user", label: "other-user" }]}
        monitoredRepos={[]}
      />
    ));

    expect(screen.queryByText("Non-monitored issue")).toBeNull();
  });

  it("renders 'Monitoring all' badge on monitored repo group header", () => {
    const issues = [
      makeIssue({ id: 200, title: "Issue in monitored repo", repoFullName: "org/monitored", surfacedBy: ["me"] }),
    ];

    render(() => (
      <IssuesTab
        issues={issues}
        userLogin="me"
        monitoredRepos={[{ owner: "org", name: "monitored", fullName: "org/monitored" }]}
      />
    ));

    screen.getByText("Monitoring all");
  });

  it("does not render 'Monitoring all' badge on non-monitored repo group header", () => {
    const issues = [
      makeIssue({ id: 300, title: "Issue in regular repo", repoFullName: "org/regular", surfacedBy: ["me"] }),
    ];

    render(() => (
      <IssuesTab
        issues={issues}
        userLogin="me"
        monitoredRepos={[]}
      />
    ));

    expect(screen.queryByText("Monitoring all")).toBeNull();
  });
});

// ── IssuesTab — scope filter ───────────────────────────────────────────────────

describe("IssuesTab — scope filter", () => {
  it("default scope shows items surfaced by tracked users (surfacedBy present)", () => {
    const issues = [
      makeIssue({ id: 1, title: "My issue", repoFullName: "org/repo", surfacedBy: ["me"] }),
      makeIssue({ id: 2, title: "Tracked User issue", repoFullName: "org/repo", surfacedBy: ["other"] }),
    ];
    setAllExpanded("issues", ["org/repo"], true);

    render(() => (
      <IssuesTab
        issues={issues}
        userLogin="me"
        allUsers={[{ login: "me", label: "Me" }, { login: "other", label: "other" }]}
        monitoredRepos={[]}
      />
    ));

    screen.getByText("My issue");
    screen.getByText("Tracked User issue");
  });

  it("scope 'all' shows all items including community items", () => {
    const issues = [
      makeIssue({ id: 1, title: "My issue", repoFullName: "org/repo", surfacedBy: ["me"] }),
      makeIssue({ id: 2, title: "Community issue", repoFullName: "org/repo", surfacedBy: ["other"] }),
    ];
    setTabFilter("issues", "scope", "all");
    setAllExpanded("issues", ["org/repo"], true);

    render(() => (
      <IssuesTab
        issues={issues}
        userLogin="me"
        allUsers={[{ login: "me", label: "Me" }, { login: "other", label: "other" }]}
        monitoredRepos={[]}
      />
    ));

    screen.getByText("My issue");
    screen.getByText("Community issue");
  });

  it("scope 'involves_me' with monitored repo shows items where user is author", () => {
    const issues = [
      makeIssue({ id: 1, title: "My monitored issue", repoFullName: "org/monitored", userLogin: "me" }),
    ];
    setAllExpanded("issues", ["org/monitored"], true);

    render(() => (
      <IssuesTab
        issues={issues}
        userLogin="me"
        monitoredRepos={[{ owner: "org", name: "monitored", fullName: "org/monitored" }]}
      />
    ));

    screen.getByText("My monitored issue");
  });

  it("scope 'involves_me' with monitored repo hides community items (user not author/assignee)", () => {
    const issues = [
      makeIssue({ id: 1, title: "Community monitored issue", repoFullName: "org/monitored", userLogin: "other-user", assigneeLogins: [] }),
    ];
    setAllExpanded("issues", ["org/monitored"], true);

    render(() => (
      <IssuesTab
        issues={issues}
        userLogin="me"
        monitoredRepos={[{ owner: "org", name: "monitored", fullName: "org/monitored" }]}
      />
    ));

    expect(screen.queryByText("Community monitored issue")).toBeNull();
  });

  it("scope 'involves_me' with monitored repo shows items where user is assignee", () => {
    const issues = [
      makeIssue({ id: 1, title: "Assigned monitored issue", repoFullName: "org/monitored", userLogin: "other-user", assigneeLogins: ["me"] }),
    ];
    setAllExpanded("issues", ["org/monitored"], true);

    render(() => (
      <IssuesTab
        issues={issues}
        userLogin="me"
        monitoredRepos={[{ owner: "org", name: "monitored", fullName: "org/monitored" }]}
      />
    ));

    screen.getByText("Assigned monitored issue");
  });
});

// ── IssuesTab — left border accent ────────────────────────────────────────────

describe("IssuesTab — left border accent in 'all' scope", () => {
  it("adds border-l-2 class to items involving the user in 'all' scope", () => {
    const issues = [
      makeIssue({ id: 1, title: "My issue", repoFullName: "org/repo", surfacedBy: ["me"] }),
    ];
    setTabFilter("issues", "scope", "all");
    setAllExpanded("issues", ["org/repo"], true);

    const { container } = render(() => (
      <IssuesTab
        issues={issues}
        userLogin="me"
        monitoredRepos={[{ owner: "org", name: "repo", fullName: "org/repo" }]}
      />
    ));

    const listitem = container.querySelector('[role="listitem"]');
    expect(listitem?.className).toContain("border-l-primary");
  });

  it("does not add border-l-2 to untracked monitored repo items in 'all' scope", () => {
    const issues = [
      makeIssue({ id: 1, title: "Community issue", repoFullName: "org/monitored", userLogin: "other", assigneeLogins: [] }),
    ];
    setTabFilter("issues", "scope", "all");
    setAllExpanded("issues", ["org/monitored"], true);

    const { container } = render(() => (
      <IssuesTab
        issues={issues}
        userLogin="me"
        monitoredRepos={[{ owner: "org", name: "monitored", fullName: "org/monitored" }]}
      />
    ));

    const listitem = container.querySelector('[role="listitem"]');
    expect(listitem?.className).not.toContain("border-l-primary");
  });

  it("adds border-l-primary to tracked user issue in monitored repo in 'all' scope", () => {
    const issues = [
      makeIssue({ id: 1, title: "Bot issue", repoFullName: "org/monitored", surfacedBy: ["tracked-bot[bot]"] }),
    ];
    setTabFilter("issues", "scope", "all");
    setAllExpanded("issues", ["org/monitored"], true);

    const { container } = render(() => (
      <IssuesTab
        issues={issues}
        userLogin="me"
        monitoredRepos={[{ owner: "org", name: "monitored", fullName: "org/monitored" }]}
      />
    ));

    const listitem = container.querySelector('[role="listitem"]');
    expect(listitem?.className).toContain("border-l-primary");
  });

  it("does not add border-l-2 in default 'involves_me' scope", () => {
    const issues = [
      makeIssue({ id: 1, title: "My issue", repoFullName: "org/repo", surfacedBy: ["me"] }),
    ];
    setAllExpanded("issues", ["org/repo"], true);

    const { container } = render(() => (
      <IssuesTab
        issues={issues}
        userLogin="me"
        monitoredRepos={[]}
      />
    ));

    const listitem = container.querySelector('[role="listitem"]');
    expect(listitem?.className).not.toContain("border-l-primary");
  });
});

// ── IssuesTab — star count in repo headers ────────────────────────────────────

describe("IssuesTab — star count in repo headers", () => {
  it("shows star count in repo header when starCount is present", () => {
    const issues = [
      makeIssue({ id: 1, title: "Issue", repoFullName: "org/repo", surfacedBy: ["me"], starCount: 1234 }),
    ];

    render(() => (
      <IssuesTab
        issues={issues}
        userLogin="me"
        monitoredRepos={[]}
      />
    ));

    screen.getByLabelText("1234 stars");
  });

  it("does not show star display when starCount is undefined", () => {
    const issues = [
      makeIssue({ id: 1, title: "Issue", repoFullName: "org/repo", surfacedBy: ["me"] }),
    ];

    const { container } = render(() => (
      <IssuesTab
        issues={issues}
        userLogin="me"
        monitoredRepos={[]}
      />
    ));

    // No star character should be present
    expect(container.textContent).not.toContain("★");
  });

  it("does not show star display when starCount is 0", () => {
    const issues = [
      makeIssue({ id: 1, title: "Issue", repoFullName: "org/repo", surfacedBy: ["me"], starCount: 0 }),
    ];

    const { container } = render(() => (
      <IssuesTab
        issues={issues}
        userLogin="me"
        monitoredRepos={[]}
      />
    ));

    expect(container.textContent).not.toContain("★");
  });
});

// ── IssuesTab — scope filter fallback path ─────────────────────────────────

describe("IssuesTab — scope filter with undefined surfacedBy (non-monitored repo)", () => {
  it("scope 'involves_me' passes items with undefined surfacedBy from non-monitored repos", () => {
    const issues = [
      makeIssue({ id: 1, title: "Legacy issue", repoFullName: "org/repo" }),
    ];
    setAllExpanded("issues", ["org/repo"], true);

    render(() => (
      <IssuesTab
        issues={issues}
        userLogin="me"
        monitoredRepos={[]}
      />
    ));

    screen.getByText("Legacy issue");
  });
});

// ── IssuesTab — scope toggle visibility ────────────────────────────────────

describe("IssuesTab — scope toggle visibility", () => {
  it("does not show Scope toggle when no monitored repos and no tracked users", () => {
    const issues = [makeIssue({ id: 1, title: "Issue", repoFullName: "org/repo", surfacedBy: ["me"] })];

    render(() => (
      <IssuesTab issues={issues} userLogin="me" monitoredRepos={[]} />
    ));

    expect(screen.queryByRole("checkbox", { name: /Scope filter/i })).toBeNull();
  });

  it("shows Scope toggle when monitored repos exist", () => {
    const issues = [makeIssue({ id: 1, title: "Issue", repoFullName: "org/repo", surfacedBy: ["me"] })];

    render(() => (
      <IssuesTab issues={issues} userLogin="me" monitoredRepos={[{ owner: "org", name: "mon", fullName: "org/mon" }]} />
    ));

    expect(screen.queryByRole("checkbox", { name: /Scope filter/i })).not.toBeNull();
  });

  it("shows Scope toggle when tracked users exist (allUsers > 1)", () => {
    const issues = [makeIssue({ id: 1, title: "Issue", repoFullName: "org/repo", surfacedBy: ["me"] })];

    render(() => (
      <IssuesTab issues={issues} userLogin="me" monitoredRepos={[]}
        allUsers={[{ login: "me", label: "Me" }, { login: "other", label: "other" }]}
      />
    ));

    expect(screen.queryByRole("checkbox", { name: /Scope filter/i })).not.toBeNull();
  });

  it("auto-resets user filter to 'all' when allUsers drops to 1", () => {
    setTabFilter("issues", "user", "tracked1");
    expect(viewState.tabFilters.issues.user).toBe("tracked1");

    render(() => (
      <IssuesTab issues={[]} userLogin="me" monitoredRepos={[]}
        allUsers={[{ login: "me", label: "Me" }]}
      />
    ));

    expect(viewState.tabFilters.issues.user).toBe("all");
  });

  it("auto-resets scope to involves_me when scope toggle becomes hidden", () => {
    setTabFilter("issues", "scope", "all");
    expect(viewState.tabFilters.issues.scope).toBe("all");

    // Render with no monitored repos and no tracked users — scope toggle hidden, effect should reset
    render(() => (
      <IssuesTab issues={[]} userLogin="me" monitoredRepos={[]} />
    ));

    expect(viewState.tabFilters.issues.scope).toBe("involves_me");
  });
});

// ── IssuesTab — pin button wiring ─────────────────────────────────────────────

describe("IssuesTab — pin button wiring", () => {
  it("pin button not rendered when enableTracking is false", () => {
    updateConfig({ enableTracking: false });
    const issue = makeIssue({ id: 1, title: "Pin test issue", repoFullName: "owner/repo", surfacedBy: ["me"] });
    setAllExpanded("issues", ["owner/repo"], true);

    render(() => (
      <IssuesTab issues={[issue]} userLogin="me" />
    ));

    expect(screen.queryByLabelText(/^Pin #/)).toBeNull();
    expect(screen.queryByLabelText(/^Unpin #/)).toBeNull();
  });

  it("pin button rendered when enableTracking is true", async () => {
    updateConfig({ enableTracking: true });
    const issue = makeIssue({ id: 1, title: "Pin test issue", repoFullName: "owner/repo", surfacedBy: ["me"] });
    setAllExpanded("issues", ["owner/repo"], true);

    render(() => (
      <IssuesTab issues={[issue]} userLogin="me" />
    ));

    expect(screen.getByLabelText(/^Pin #/)).not.toBeNull();
  });

  it("clicking pin button on untracked issue tracks it", async () => {
    const user = userEvent.setup();
    updateConfig({ enableTracking: true });
    const issue = makeIssue({ id: 50, title: "My issue", repoFullName: "owner/repo", surfacedBy: ["me"] });
    setAllExpanded("issues", ["owner/repo"], true);

    render(() => (
      <IssuesTab issues={[issue]} userLogin="me" />
    ));

    const pinBtn = screen.getByLabelText(/^Pin #/);
    await user.click(pinBtn);

    expect(viewState.trackedItems.some(t => t.id === 50 && t.type === "issue")).toBe(true);
  });

  it("clicking pin button on tracked issue untracks it", async () => {
    const user = userEvent.setup();
    updateConfig({ enableTracking: true });
    const issue = makeIssue({ id: 51, title: "Already tracked", repoFullName: "owner/repo", surfacedBy: ["me"] });
    updateViewState({ trackedItems: [makeTrackedItem({ id: 51, type: "issue", repoFullName: "owner/repo", title: "Already tracked" })] });
    setAllExpanded("issues", ["owner/repo"], true);

    render(() => (
      <IssuesTab issues={[issue]} userLogin="me" />
    ));

    const unpinBtn = screen.getByLabelText(/^Unpin #/);
    await user.click(unpinBtn);

    expect(viewState.trackedItems.some(t => t.id === 51 && t.type === "issue")).toBe(false);
  });

  it("ignoring an issue also untracks it", async () => {
    const user = userEvent.setup();
    updateConfig({ enableTracking: true });
    const issue = makeIssue({ id: 52, title: "Tracked and ignored", repoFullName: "owner/repo", surfacedBy: ["me"] });
    updateViewState({ trackedItems: [makeTrackedItem({ id: 52, type: "issue", repoFullName: "owner/repo", title: "Tracked and ignored" })] });
    setAllExpanded("issues", ["owner/repo"], true);

    render(() => (
      <IssuesTab issues={[issue]} userLogin="me" />
    ));

    const ignoreBtn = screen.getByLabelText(/Ignore #/);
    await user.click(ignoreBtn);

    expect(viewState.trackedItems.some(t => t.id === 52 && t.type === "issue")).toBe(false);
  });
});

describe("IssuesTab — empty-repo state preservation", () => {
  it("preserves expand/lock state for empty repos in configRepoNames", () => {
    setViewState(produce((s) => {
      s.expandedRepos.issues["owner/empty-repo"] = true;
      s.expandedRepos.issues["owner/stale-repo"] = true;
      s.lockedRepos = ["owner/empty-repo", "owner/stale-repo"];
    }));

    render(() => (
      <IssuesTab
        issues={[makeIssue({ id: 1, repoFullName: "owner/active-repo", surfacedBy: ["me"] })]}
        userLogin="me"
        configRepoNames={["owner/active-repo", "owner/empty-repo"]}
      />
    ));

    // Empty repo preserved (in configRepoNames but no items)
    expect(viewState.expandedRepos.issues["owner/empty-repo"]).toBe(true);
    expect(viewState.lockedRepos).toContain("owner/empty-repo");
    // Stale repo pruned (not in configRepoNames)
    expect(viewState.expandedRepos.issues["owner/stale-repo"]).toBeUndefined();
    expect(viewState.lockedRepos).not.toContain("owner/stale-repo");
  });

  it("falls back to item-derived names when configRepoNames not provided", () => {
    render(() => (
      <IssuesTab issues={[]} userLogin="me" />
    ));
    // With empty items and no configRepoNames, guard returns early — no pruning
    expect(viewState.lockedRepos).toEqual([]);
  });
});
