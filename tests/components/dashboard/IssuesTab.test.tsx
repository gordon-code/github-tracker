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
});

describe("IssuesTab — avatar badge", () => {
  it("renders avatar img for items surfaced by tracked users", () => {
    const trackedUsers: TrackedUser[] = [
      { login: "tracked1", avatarUrl: "https://avatars.githubusercontent.com/u/1", name: "Tracked One" },
    ];
    const issues = [
      makeIssue({ id: 1, title: "Tracked issue", repoFullName: "owner/repo", surfacedBy: ["tracked1"] }),
    ];

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
