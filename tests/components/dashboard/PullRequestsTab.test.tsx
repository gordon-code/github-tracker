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
      { login: "tracked1", avatarUrl: "https://avatars.githubusercontent.com/u/1", name: "Tracked One" },
    ];
    const prs = [
      makePullRequest({ id: 1, title: "Tracked PR", repoFullName: "owner/repo", surfacedBy: ["tracked1"] }),
    ];

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
