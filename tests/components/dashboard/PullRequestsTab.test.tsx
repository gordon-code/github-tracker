import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { makePullRequest, makeTrackedItem } from "../../helpers/index";

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
import { viewState, setTabFilter, setAllExpanded, resetViewState, updateViewState } from "../../../src/app/stores/view";
import type { TrackedUser } from "../../../src/app/stores/config";
import { updateConfig, resetConfig } from "../../../src/app/stores/config";

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  localStorageMock.clear();
  resetViewState();
  resetConfig();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("PullRequestsTab — user filter", () => {
  it("does not show User filter when allUsers has only 1 entry", () => {
    render(() => (
      <PullRequestsTab
        pullRequests={[makePullRequest()]}
        userLogin="me"
        allUsers={[{ login: "me", label: "Me" }]}
      />
    ));
    expect(screen.queryByLabelText("Filter by User")).toBeNull();
  });

  it("shows User filter when allUsers has > 1 entry", () => {
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
    screen.getByLabelText("Filter by User");
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
  it("default scope shows items surfaced by tracked users (surfacedBy present)", () => {
    const prs = [
      makePullRequest({ id: 1, title: "My PR", repoFullName: "org/repo", surfacedBy: ["me"] }),
      makePullRequest({ id: 2, title: "Tracked User PR", repoFullName: "org/repo", surfacedBy: ["other"] }),
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
    screen.getByText("Tracked User PR");
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

  it("does not add border-l-primary to untracked monitored repo PRs in 'all' scope", () => {
    const prs = [
      makePullRequest({ id: 1, title: "Community PR", repoFullName: "org/monitored", userLogin: "other", assigneeLogins: [], reviewerLogins: [] }),
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

// ── PullRequestsTab — scope toggle visibility ──────────────────────────────

describe("PullRequestsTab — scope toggle visibility", () => {
  it("does not show Scope toggle when no monitored repos and no tracked users", () => {
    const prs = [makePullRequest({ id: 1, title: "PR", repoFullName: "org/repo", surfacedBy: ["me"] })];

    render(() => (
      <PullRequestsTab pullRequests={prs} userLogin="me" monitoredRepos={[]} />
    ));

    expect(screen.queryByRole("checkbox", { name: /Scope filter/i })).toBeNull();
  });

  it("shows Scope toggle when monitored repos exist", () => {
    const prs = [makePullRequest({ id: 1, title: "PR", repoFullName: "org/repo", surfacedBy: ["me"] })];

    render(() => (
      <PullRequestsTab pullRequests={prs} userLogin="me"
        monitoredRepos={[{ owner: "org", name: "mon", fullName: "org/mon" }]}
      />
    ));

    expect(screen.queryByRole("checkbox", { name: /Scope filter/i })).not.toBeNull();
  });

  it("shows Scope toggle when allUsers > 1", () => {
    const prs = [makePullRequest({ id: 1, title: "PR", repoFullName: "org/repo", surfacedBy: ["me"] })];

    render(() => (
      <PullRequestsTab pullRequests={prs} userLogin="me" monitoredRepos={[]}
        allUsers={[{ login: "me", label: "Me" }, { login: "other", label: "other" }]}
      />
    ));

    expect(screen.queryByRole("checkbox", { name: /Scope filter/i })).not.toBeNull();
  });

  it("auto-resets user filter to 'all' when allUsers drops to 1", () => {
    setTabFilter("pullRequests", "user", "tracked1");
    expect(viewState.tabFilters.pullRequests.user).toBe("tracked1");

    render(() => (
      <PullRequestsTab pullRequests={[]} userLogin="me" monitoredRepos={[]}
        allUsers={[{ login: "me", label: "Me" }]}
      />
    ));

    expect(viewState.tabFilters.pullRequests.user).toBe("all");
  });

  it("auto-resets scope to involves_me when scope toggle becomes hidden", () => {
    setTabFilter("pullRequests", "scope", "all");
    expect(viewState.tabFilters.pullRequests.scope).toBe("all");

    render(() => (
      <PullRequestsTab pullRequests={[]} userLogin="me" monitoredRepos={[]} />
    ));

    expect(viewState.tabFilters.pullRequests.scope).toBe("involves_me");
  });
});

// ── PullRequestsTab — blocked composite filter ────────────────────────────

describe("PullRequestsTab — checkStatus=blocked filter", () => {
  it("shows both failure and conflict PRs when checkStatus=blocked", () => {
    const prs = [
      makePullRequest({ id: 1, title: "Failing PR", repoFullName: "org/repo", checkStatus: "failure", surfacedBy: ["me"], enriched: true }),
      makePullRequest({ id: 2, title: "Conflict PR", repoFullName: "org/repo", checkStatus: "conflict", surfacedBy: ["me"], enriched: true }),
      makePullRequest({ id: 3, title: "Passing PR", repoFullName: "org/repo", checkStatus: "success", surfacedBy: ["me"], enriched: true }),
    ];
    setTabFilter("pullRequests", "checkStatus", "blocked");
    setAllExpanded("pullRequests", ["org/repo"], true);

    render(() => (
      <PullRequestsTab pullRequests={prs} userLogin="me" monitoredRepos={[]} />
    ));

    screen.getByText("Failing PR");
    screen.getByText("Conflict PR");
    expect(screen.queryByText("Passing PR")).toBeNull();
  });
});

describe("PullRequestsTab — reviewDecision=mergeable filter", () => {
  it("shows APPROVED and null-review PRs, excludes CHANGES_REQUESTED", () => {
    const prs = [
      makePullRequest({ id: 1, title: "Approved PR", repoFullName: "org/repo", reviewDecision: "APPROVED", surfacedBy: ["me"], enriched: true }),
      makePullRequest({ id: 2, title: "No Review PR", repoFullName: "org/repo", reviewDecision: null, surfacedBy: ["me"], enriched: true }),
      makePullRequest({ id: 3, title: "Changes PR", repoFullName: "org/repo", reviewDecision: "CHANGES_REQUESTED", surfacedBy: ["me"], enriched: true }),
    ];
    setTabFilter("pullRequests", "reviewDecision", "mergeable");
    setAllExpanded("pullRequests", ["org/repo"], true);

    render(() => (
      <PullRequestsTab pullRequests={prs} userLogin="me" monitoredRepos={[]} />
    ));

    screen.getByText("Approved PR");
    screen.getByText("No Review PR");
    expect(screen.queryByText("Changes PR")).toBeNull();
  });
});

// ── PullRequestsTab — pin button wiring ───────────────────────────────────────

describe("PullRequestsTab — pin button wiring", () => {
  it("pin button not rendered when enableTracking is false", () => {
    updateConfig({ enableTracking: false });
    const pr = makePullRequest({ id: 1, title: "Pin test PR", repoFullName: "owner/repo", surfacedBy: ["me"] });
    setAllExpanded("pullRequests", ["owner/repo"], true);

    render(() => (
      <PullRequestsTab pullRequests={[pr]} userLogin="me" />
    ));

    expect(screen.queryByLabelText(/^Pin #/)).toBeNull();
    expect(screen.queryByLabelText(/^Unpin #/)).toBeNull();
  });

  it("pin button rendered when enableTracking is true", () => {
    updateConfig({ enableTracking: true });
    const pr = makePullRequest({ id: 1, title: "Pin test PR", repoFullName: "owner/repo", surfacedBy: ["me"] });
    setAllExpanded("pullRequests", ["owner/repo"], true);

    render(() => (
      <PullRequestsTab pullRequests={[pr]} userLogin="me" />
    ));

    expect(screen.getByLabelText(/^Pin #/)).not.toBeNull();
  });

  it("clicking pin button on untracked PR tracks it", async () => {
    const user = userEvent.setup();
    updateConfig({ enableTracking: true });
    const pr = makePullRequest({ id: 60, title: "My PR", repoFullName: "owner/repo", surfacedBy: ["me"] });
    setAllExpanded("pullRequests", ["owner/repo"], true);

    render(() => (
      <PullRequestsTab pullRequests={[pr]} userLogin="me" />
    ));

    const pinBtn = screen.getByLabelText(/^Pin #/);
    await user.click(pinBtn);

    expect(viewState.trackedItems.some(t => t.id === 60 && t.type === "pullRequest")).toBe(true);
  });

  it("clicking pin button on tracked PR untracks it", async () => {
    const user = userEvent.setup();
    updateConfig({ enableTracking: true });
    const pr = makePullRequest({ id: 61, title: "Already tracked PR", repoFullName: "owner/repo", surfacedBy: ["me"] });
    updateViewState({ trackedItems: [makeTrackedItem({ id: 61, type: "pullRequest", repoFullName: "owner/repo", title: "Already tracked PR" })] });
    setAllExpanded("pullRequests", ["owner/repo"], true);

    render(() => (
      <PullRequestsTab pullRequests={[pr]} userLogin="me" />
    ));

    const unpinBtn = screen.getByLabelText(/^Unpin #/);
    await user.click(unpinBtn);

    expect(viewState.trackedItems.some(t => t.id === 61 && t.type === "pullRequest")).toBe(false);
  });

  it("ignoring a PR also untracks it", async () => {
    const user = userEvent.setup();
    updateConfig({ enableTracking: true });
    const pr = makePullRequest({ id: 62, title: "Tracked and ignored PR", repoFullName: "owner/repo", surfacedBy: ["me"] });
    updateViewState({ trackedItems: [makeTrackedItem({ id: 62, type: "pullRequest", repoFullName: "owner/repo", title: "Tracked and ignored PR" })] });
    setAllExpanded("pullRequests", ["owner/repo"], true);

    render(() => (
      <PullRequestsTab pullRequests={[pr]} userLogin="me" />
    ));

    const ignoreBtn = screen.getByLabelText(/Ignore #/);
    await user.click(ignoreBtn);

    expect(viewState.trackedItems.some(t => t.id === 62 && t.type === "pullRequest")).toBe(false);
  });
});
