import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import { makeIssue } from "../../helpers/index";

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

import IssuesTab from "../../../src/app/components/dashboard/IssuesTab";
import { setTabFilter, setAllExpanded, resetViewState } from "../../../src/app/stores/view";
import type { TrackedUser } from "../../../src/app/stores/config";

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  localStorageMock.clear();
  resetViewState();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("IssuesTab — user filter chip", () => {
  it("does not show User filter chip when allUsers has only 1 entry (no tracked users)", () => {
    render(() => (
      <IssuesTab
        issues={[makeIssue()]}
        userLogin="me"
        allUsers={[{ login: "me", label: "Me" }]}
      />
    ));
    // FilterChips renders "User:" label — absent when only 1 user
    expect(screen.queryByText("User:")).toBeNull();
  });

  it("shows User filter chip when allUsers has > 1 entry", () => {
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
    screen.getByText("User:");
  });

  it("does not show User filter chip when allUsers is undefined", () => {
    render(() => (
      <IssuesTab issues={[makeIssue()]} userLogin="me" />
    ));
    expect(screen.queryByText("User:")).toBeNull();
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
  it("default scope shows only items involving the user (surfacedBy includes userLogin)", () => {
    const issues = [
      makeIssue({ id: 1, title: "My issue", repoFullName: "org/repo", surfacedBy: ["me"] }),
      makeIssue({ id: 2, title: "Community issue", repoFullName: "org/repo", surfacedBy: ["other"] }),
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
    expect(screen.queryByText("Community issue")).toBeNull();
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
    expect(listitem?.className).toContain("border-l-2");
  });

  it("does not add border-l-2 to community items in 'all' scope", () => {
    const issues = [
      makeIssue({ id: 1, title: "Community issue", repoFullName: "org/monitored", surfacedBy: ["other"], userLogin: "other", assigneeLogins: [] }),
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
    expect(listitem?.className).not.toContain("border-l-2");
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
    expect(listitem?.className).not.toContain("border-l-2");
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

    screen.getByText("★ 1.2k");
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
