import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import { makePullRequest } from "../../helpers/index";

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

import PullRequestsTab from "../../../src/app/components/dashboard/PullRequestsTab";
import { setTabFilter, setAllExpanded, resetViewState } from "../../../src/app/stores/view";
import type { TrackedUser } from "../../../src/app/stores/config";

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  localStorageMock.clear();
  resetViewState();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("PullRequestsTab — user filter chip", () => {
  it("does not show User filter chip when allUsers has only 1 entry", () => {
    render(() => (
      <PullRequestsTab
        pullRequests={[makePullRequest()]}
        userLogin="me"
        allUsers={[{ login: "me", label: "Me" }]}
      />
    ));
    expect(screen.queryByText("User:")).toBeNull();
  });

  it("shows User filter chip when allUsers has > 1 entry", () => {
    render(() => (
      <PullRequestsTab
        pullRequests={[makePullRequest()]}
        userLogin="me"
        allUsers={[
          { login: "me", label: "Me" },
          { login: "tracked1", label: "tracked1" },
        ]}
      />
    ));
    screen.getByText("User:");
  });
});

describe("PullRequestsTab — user filter logic", () => {
  it("shows all PRs when user filter is 'all'", () => {
    const prs = [
      makePullRequest({ id: 1, title: "My PR", repoFullName: "owner/repo-a", surfacedBy: ["me"] }),
      makePullRequest({ id: 2, title: "Tracked PR", repoFullName: "owner/repo-b", surfacedBy: ["tracked1"] }),
    ];
    setTabFilter("pullRequests", "scope", "all");
    setAllExpanded("pullRequests", ["owner/repo-a", "owner/repo-b"], true);

    render(() => (
      <PullRequestsTab
        pullRequests={prs}
        userLogin="me"
        allUsers={[
          { login: "me", label: "Me" },
          { login: "tracked1", label: "tracked1" },
        ]}
      />
    ));

    screen.getByText("My PR");
    screen.getByText("Tracked PR");
  });

  it("filters PRs to only the tracked user's items when user filter is set", () => {
    const prs = [
      makePullRequest({ id: 1, title: "My PR", repoFullName: "owner/repo-a", surfacedBy: ["me"] }),
      makePullRequest({ id: 2, title: "Tracked PR", repoFullName: "owner/repo-b", surfacedBy: ["tracked1"] }),
    ];

    setTabFilter("pullRequests", "scope", "all");
    setTabFilter("pullRequests", "user", "tracked1");
    setAllExpanded("pullRequests", ["owner/repo-a", "owner/repo-b"], true);

    render(() => (
      <PullRequestsTab
        pullRequests={prs}
        userLogin="me"
        allUsers={[
          { login: "me", label: "Me" },
          { login: "tracked1", label: "tracked1" },
        ]}
      />
    ));

    expect(screen.queryByText("My PR")).toBeNull();
    screen.getByText("Tracked PR");
  });

  it("uses userLogin as fallback surfacedBy for items with undefined surfacedBy", () => {
    const prs = [
      makePullRequest({ id: 1, title: "Legacy PR", repoFullName: "owner/repo", surfacedBy: undefined }),
    ];

    setTabFilter("pullRequests", "user", "me");
    setAllExpanded("pullRequests", ["owner/repo"], true);

    render(() => (
      <PullRequestsTab
        pullRequests={prs}
        userLogin="me"
        allUsers={[
          { login: "me", label: "Me" },
          { login: "tracked1", label: "tracked1" },
        ]}
      />
    ));

    screen.getByText("Legacy PR");
  });

  it("hides legacy PRs (no surfacedBy) when filtered to tracked user", () => {
    const prs = [
      makePullRequest({ id: 1, title: "Legacy PR", repoFullName: "owner/repo", surfacedBy: undefined }),
    ];

    setTabFilter("pullRequests", "user", "tracked1");
    setAllExpanded("pullRequests", ["owner/repo"], true);

    render(() => (
      <PullRequestsTab
        pullRequests={prs}
        userLogin="me"
        allUsers={[
          { login: "me", label: "Me" },
          { login: "tracked1", label: "tracked1" },
        ]}
      />
    ));

    expect(screen.queryByText("Legacy PR")).toBeNull();
  });
});

describe("PullRequestsTab — avatar badge", () => {
  it("renders avatar img for PRs surfaced by tracked users", () => {
    const trackedUsers: TrackedUser[] = [
      { login: "tracked1", avatarUrl: "https://avatars.githubusercontent.com/u/1", name: "Tracked One", type: "user" as const },
    ];
    const prs = [
      makePullRequest({ id: 1, title: "Tracked PR", repoFullName: "owner/repo", surfacedBy: ["tracked1"] }),
    ];

    setTabFilter("pullRequests", "scope", "all");
    setAllExpanded("pullRequests", ["owner/repo"], true);

    render(() => (
      <PullRequestsTab
        pullRequests={prs}
        userLogin="me"
        trackedUsers={trackedUsers}
        allUsers={[
          { login: "me", label: "Me" },
          { login: "tracked1", label: "tracked1" },
        ]}
      />
    ));

    const img = screen.getByAltText("tracked1");
    expect(img.getAttribute("src")).toBe("https://avatars.githubusercontent.com/u/1");
  });
});

// ── PullRequestsTab — monitored repos bypass (C6) ─────────────────────────────

describe("PullRequestsTab — monitored repos filter bypass", () => {
  it("shows PR from monitored repo even when user filter excludes it", () => {
    const prs = [
      makePullRequest({ id: 1, title: "Monitored PR", repoFullName: "org/monitored", surfacedBy: ["other-user"] }),
    ];
    setTabFilter("pullRequests", "scope", "all");
    setTabFilter("pullRequests", "user", "me");
    setAllExpanded("pullRequests", ["org/monitored"], true);

    render(() => (
      <PullRequestsTab
        pullRequests={prs}
        userLogin="me"
        allUsers={[{ login: "me", label: "Me" }, { login: "other-user", label: "other-user" }]}
        monitoredRepos={[{ owner: "org", name: "monitored", fullName: "org/monitored" }]}
      />
    ));

    screen.getByText("Monitored PR");
  });

  it("hides PR from non-monitored repo when user filter excludes it", () => {
    const prs = [
      makePullRequest({ id: 100, title: "Non-monitored PR", repoFullName: "org/regular", surfacedBy: ["other-user"] }),
    ];
    setTabFilter("pullRequests", "user", "me");

    render(() => (
      <PullRequestsTab
        pullRequests={prs}
        userLogin="me"
        allUsers={[{ login: "me", label: "Me" }, { login: "other-user", label: "other-user" }]}
        monitoredRepos={[]}
      />
    ));

    expect(screen.queryByText("Non-monitored PR")).toBeNull();
  });

  it("renders 'Monitoring all' badge on monitored PR repo group header", () => {
    const prs = [
      makePullRequest({ id: 200, title: "PR in monitored repo", repoFullName: "org/monitored", surfacedBy: ["me"] }),
    ];

    render(() => (
      <PullRequestsTab
        pullRequests={prs}
        userLogin="me"
        monitoredRepos={[{ owner: "org", name: "monitored", fullName: "org/monitored" }]}
      />
    ));

    screen.getByText("Monitoring all");
  });

  it("does not render 'Monitoring all' badge on non-monitored PR repo group header", () => {
    const prs = [
      makePullRequest({ id: 300, title: "PR in regular repo", repoFullName: "org/regular", surfacedBy: ["me"] }),
    ];

    render(() => (
      <PullRequestsTab
        pullRequests={prs}
        userLogin="me"
        monitoredRepos={[]}
      />
    ));

    expect(screen.queryByText("Monitoring all")).toBeNull();
  });
});

// ── PullRequestsTab — scope filter ────────────────────────────────────────────

describe("PullRequestsTab — scope filter", () => {
  it("default scope shows only items involving the user (surfacedBy includes userLogin)", () => {
    const prs = [
      makePullRequest({ id: 1, title: "My PR", repoFullName: "org/repo", surfacedBy: ["me"] }),
      makePullRequest({ id: 2, title: "Community PR", repoFullName: "org/repo", surfacedBy: ["other"] }),
    ];
    setAllExpanded("pullRequests", ["org/repo"], true);

    render(() => (
      <PullRequestsTab
        pullRequests={prs}
        userLogin="me"
        allUsers={[{ login: "me", label: "Me" }, { login: "other", label: "other" }]}
        monitoredRepos={[]}
      />
    ));

    screen.getByText("My PR");
    expect(screen.queryByText("Community PR")).toBeNull();
  });

  it("scope 'all' shows all PRs including community items", () => {
    const prs = [
      makePullRequest({ id: 1, title: "My PR", repoFullName: "org/repo", surfacedBy: ["me"] }),
      makePullRequest({ id: 2, title: "Community PR", repoFullName: "org/repo", surfacedBy: ["other"] }),
    ];
    setTabFilter("pullRequests", "scope", "all");
    setAllExpanded("pullRequests", ["org/repo"], true);

    render(() => (
      <PullRequestsTab
        pullRequests={prs}
        userLogin="me"
        allUsers={[{ login: "me", label: "Me" }, { login: "other", label: "other" }]}
        monitoredRepos={[]}
      />
    ));

    screen.getByText("My PR");
    screen.getByText("Community PR");
  });

  it("scope 'involves_me' with monitored repo shows PRs where user is author", () => {
    const prs = [
      makePullRequest({ id: 1, title: "My monitored PR", repoFullName: "org/monitored", userLogin: "me" }),
    ];
    setAllExpanded("pullRequests", ["org/monitored"], true);

    render(() => (
      <PullRequestsTab
        pullRequests={prs}
        userLogin="me"
        monitoredRepos={[{ owner: "org", name: "monitored", fullName: "org/monitored" }]}
      />
    ));

    screen.getByText("My monitored PR");
  });

  it("scope 'involves_me' with monitored repo hides community PRs (user not author/assignee/reviewer)", () => {
    const prs = [
      makePullRequest({ id: 1, title: "Community monitored PR", repoFullName: "org/monitored", userLogin: "other-user", assigneeLogins: [], reviewerLogins: [] }),
    ];
    setAllExpanded("pullRequests", ["org/monitored"], true);

    render(() => (
      <PullRequestsTab
        pullRequests={prs}
        userLogin="me"
        monitoredRepos={[{ owner: "org", name: "monitored", fullName: "org/monitored" }]}
      />
    ));

    expect(screen.queryByText("Community monitored PR")).toBeNull();
  });

  it("scope 'involves_me' with monitored repo shows PRs where user is reviewer (enriched)", () => {
    const prs = [
      makePullRequest({ id: 1, title: "Review monitored PR", repoFullName: "org/monitored", userLogin: "other-user", assigneeLogins: [], reviewerLogins: ["me"], enriched: true }),
    ];
    setAllExpanded("pullRequests", ["org/monitored"], true);

    render(() => (
      <PullRequestsTab
        pullRequests={prs}
        userLogin="me"
        monitoredRepos={[{ owner: "org", name: "monitored", fullName: "org/monitored" }]}
      />
    ));

    screen.getByText("Review monitored PR");
  });
});

// ── PullRequestsTab — left border accent ──────────────────────────────────────

describe("PullRequestsTab — left border accent in 'all' scope", () => {
  it("adds border-l-2 class to PRs involving the user in 'all' scope", () => {
    const prs = [
      makePullRequest({ id: 1, title: "My PR", repoFullName: "org/repo", surfacedBy: ["me"] }),
    ];
    setTabFilter("pullRequests", "scope", "all");
    setAllExpanded("pullRequests", ["org/repo"], true);

    const { container } = render(() => (
      <PullRequestsTab
        pullRequests={prs}
        userLogin="me"
        monitoredRepos={[{ owner: "org", name: "repo", fullName: "org/repo" }]}
      />
    ));

    const listitem = container.querySelector('[role="listitem"]');
    expect(listitem?.className).toContain("border-l-primary");
  });

  it("does not add border-l-primary to community PRs in 'all' scope", () => {
    const prs = [
      makePullRequest({ id: 1, title: "Community PR", repoFullName: "org/monitored", surfacedBy: ["other"], userLogin: "other", assigneeLogins: [], reviewerLogins: [] }),
    ];
    setTabFilter("pullRequests", "scope", "all");
    setAllExpanded("pullRequests", ["org/monitored"], true);

    const { container } = render(() => (
      <PullRequestsTab
        pullRequests={prs}
        userLogin="me"
        monitoredRepos={[{ owner: "org", name: "monitored", fullName: "org/monitored" }]}
      />
    ));

    const listitem = container.querySelector('[role="listitem"]');
    expect(listitem?.className).not.toContain("border-l-primary");
  });

  it("does not add border-l-primary in default 'involves_me' scope", () => {
    const prs = [
      makePullRequest({ id: 1, title: "My PR", repoFullName: "org/repo", surfacedBy: ["me"] }),
    ];
    setAllExpanded("pullRequests", ["org/repo"], true);

    const { container } = render(() => (
      <PullRequestsTab
        pullRequests={prs}
        userLogin="me"
        monitoredRepos={[]}
      />
    ));

    const listitem = container.querySelector('[role="listitem"]');
    expect(listitem?.className).not.toContain("border-l-primary");
  });
});

// ── PullRequestsTab — star count in repo headers ──────────────────────────────

describe("PullRequestsTab — star count in repo headers", () => {
  it("shows star count in repo header when starCount is present", () => {
    const prs = [
      makePullRequest({ id: 1, title: "PR", repoFullName: "org/repo", surfacedBy: ["me"], starCount: 1234 }),
    ];

    render(() => (
      <PullRequestsTab
        pullRequests={prs}
        userLogin="me"
        monitoredRepos={[]}
      />
    ));

    screen.getByText("★ 1.2k");
  });

  it("does not show star display when starCount is undefined", () => {
    const prs = [
      makePullRequest({ id: 1, title: "PR", repoFullName: "org/repo", surfacedBy: ["me"] }),
    ];

    const { container } = render(() => (
      <PullRequestsTab
        pullRequests={prs}
        userLogin="me"
        monitoredRepos={[]}
      />
    ));

    expect(container.textContent).not.toContain("★");
  });

  it("does not show star display when starCount is 0", () => {
    const prs = [
      makePullRequest({ id: 1, title: "PR", repoFullName: "org/repo", surfacedBy: ["me"], starCount: 0 }),
    ];

    const { container } = render(() => (
      <PullRequestsTab
        pullRequests={prs}
        userLogin="me"
        monitoredRepos={[]}
      />
    ));

    expect(container.textContent).not.toContain("★");
  });
});
