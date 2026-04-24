import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { makeIssue, makePullRequest, makeTrackedItem } from "../../helpers/index";

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

import TrackedTab from "../../../src/app/components/dashboard/TrackedTab";
import { viewState, resetViewState, updateViewState, untrackJiraItem } from "../../../src/app/stores/view";

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  localStorageMock.clear();
  resetViewState();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("TrackedTab — empty state", () => {
  it("renders empty state when no items tracked", () => {
    render(() => <TrackedTab issues={[]} pullRequests={[]} userLogin="testuser" />);
    expect(screen.getByText(/No tracked items/)).toBeTruthy();
  });
});

describe("TrackedTab — type badges", () => {
  it("renders tracked issues with type badge", () => {
    const issue = makeIssue({ id: 1, title: "My issue" });
    const tracked = makeTrackedItem({ id: 1, type: "issue", title: "My issue" });
    updateViewState({ trackedItems: [tracked] });

    render(() => <TrackedTab issues={[issue]} pullRequests={[]} userLogin="testuser" />);

    const badges = screen.getAllByText("Issue");
    expect(badges.length).toBeGreaterThan(0);
  });

  it("renders tracked PRs with type badge", () => {
    const pr = makePullRequest({ id: 2, title: "My PR" });
    const tracked = makeTrackedItem({ id: 2, type: "pullRequest", title: "My PR" });
    updateViewState({ trackedItems: [tracked] });

    render(() => <TrackedTab issues={[]} pullRequests={[pr]} userLogin="testuser" />);

    const badges = screen.getAllByText("PR");
    expect(badges.length).toBeGreaterThan(0);
  });
});

describe("TrackedTab — ordering", () => {
  it("renders items in tracked order (not alphabetical)", () => {
    const issue1 = makeIssue({ id: 10, title: "Zebra Issue" });
    const issue2 = makeIssue({ id: 11, title: "Apple Issue" });
    const issue3 = makeIssue({ id: 12, title: "Mango Issue" });

    updateViewState({
      trackedItems: [
        makeTrackedItem({ id: 10, type: "issue", title: "Zebra Issue" }),
        makeTrackedItem({ id: 11, type: "issue", title: "Apple Issue" }),
        makeTrackedItem({ id: 12, type: "issue", title: "Mango Issue" }),
      ],
    });

    render(() => <TrackedTab issues={[issue1, issue2, issue3]} pullRequests={[]} userLogin="testuser" />);

    // The items should appear in tracked order: Zebra, Apple, Mango
    const zebra = screen.getByText("Zebra Issue");
    const apple = screen.getByText("Apple Issue");
    const mango = screen.getByText("Mango Issue");

    // Verify DOM order: Zebra comes before Apple, Apple comes before Mango
    expect(
      zebra.compareDocumentPosition(apple) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      apple.compareDocumentPosition(mango) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });
});

describe("TrackedTab — fallback row", () => {
  it("shows minimal row when live data not found", () => {
    const tracked = makeTrackedItem({ id: 999, type: "issue", title: "Missing Issue" });
    updateViewState({ trackedItems: [tracked] });

    // Don't pass the issue with id 999 in props — simulating it's not in current data
    render(() => <TrackedTab issues={[]} pullRequests={[]} userLogin="testuser" />);

    expect(screen.getByText(/not in current data/)).toBeTruthy();
    expect(screen.getByText("Missing Issue")).toBeTruthy();
  });

  it("clicking fallback unpin button untracks item", () => {
    const tracked = makeTrackedItem({ id: 888, type: "issue", title: "Stale Item" });
    updateViewState({ trackedItems: [tracked] });

    render(() => <TrackedTab issues={[]} pullRequests={[]} userLogin="testuser" />);

    const unpinBtn = screen.getByLabelText("Unpin #888 Stale Item");
    fireEvent.click(unpinBtn);

    expect(viewState.trackedItems).toHaveLength(0);
  });
});

describe("TrackedTab — move button disabled states", () => {
  it("move up button disabled on first item", () => {
    const issue1 = makeIssue({ id: 20, title: "First Item" });
    const issue2 = makeIssue({ id: 21, title: "Second Item" });

    updateViewState({
      trackedItems: [
        makeTrackedItem({ id: 20, type: "issue", title: "First Item" }),
        makeTrackedItem({ id: 21, type: "issue", title: "Second Item" }),
      ],
    });

    render(() => <TrackedTab issues={[issue1, issue2]} pullRequests={[]} userLogin="testuser" />);

    const upButtons = screen.getAllByLabelText(/^Move up:/);
    expect((upButtons[0] as HTMLButtonElement).disabled).toBe(true);
    expect((upButtons[1] as HTMLButtonElement).disabled).toBe(false);
  });

  it("move down button disabled on last item", () => {
    const issue1 = makeIssue({ id: 30, title: "First Item" });
    const issue2 = makeIssue({ id: 31, title: "Second Item" });

    updateViewState({
      trackedItems: [
        makeTrackedItem({ id: 30, type: "issue", title: "First Item" }),
        makeTrackedItem({ id: 31, type: "issue", title: "Second Item" }),
      ],
    });

    render(() => <TrackedTab issues={[issue1, issue2]} pullRequests={[]} userLogin="testuser" />);

    const downButtons = screen.getAllByLabelText(/^Move down:/);
    expect((downButtons[0] as HTMLButtonElement).disabled).toBe(false);
    expect((downButtons[1] as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("TrackedTab — reordering", () => {
  it("clicking move up reorders items", () => {
    const issue1 = makeIssue({ id: 40, title: "First Item" });
    const issue2 = makeIssue({ id: 41, title: "Second Item" });

    updateViewState({
      trackedItems: [
        makeTrackedItem({ id: 40, type: "issue", title: "First Item" }),
        makeTrackedItem({ id: 41, type: "issue", title: "Second Item" }),
      ],
    });

    render(() => <TrackedTab issues={[issue1, issue2]} pullRequests={[]} userLogin="testuser" />);

    const upButtons = screen.getAllByLabelText(/^Move up:/);
    // Click move up on second item
    fireEvent.click(upButtons[1]);

    // Second item (id=41) should now be first
    expect(viewState.trackedItems[0].id).toBe(41);
    expect(viewState.trackedItems[1].id).toBe(40);
  });

  it("clicking move down reorders items", () => {
    const issue1 = makeIssue({ id: 50, title: "First Item" });
    const issue2 = makeIssue({ id: 51, title: "Second Item" });

    updateViewState({
      trackedItems: [
        makeTrackedItem({ id: 50, type: "issue", title: "First Item" }),
        makeTrackedItem({ id: 51, type: "issue", title: "Second Item" }),
      ],
    });

    render(() => <TrackedTab issues={[issue1, issue2]} pullRequests={[]} userLogin="testuser" />);

    const downButtons = screen.getAllByLabelText(/^Move down:/);
    // Click move down on first item
    fireEvent.click(downButtons[0]);

    // First item (id=50) should now be second
    expect(viewState.trackedItems[0].id).toBe(51);
    expect(viewState.trackedItems[1].id).toBe(50);
  });
});

describe("TrackedTab — mixed types", () => {
  it("renders both issues and PRs with correct type badges", () => {
    const issue = makeIssue({ id: 80, title: "Mixed Issue" });
    const pr = makePullRequest({ id: 81, title: "Mixed PR" });

    updateViewState({
      trackedItems: [
        makeTrackedItem({ id: 80, type: "issue", title: "Mixed Issue" }),
        makeTrackedItem({ id: 81, type: "pullRequest", title: "Mixed PR" }),
      ],
    });

    render(() => <TrackedTab issues={[issue]} pullRequests={[pr]} userLogin="testuser" />);

    expect(screen.getByText("Mixed Issue")).toBeTruthy();
    expect(screen.getByText("Mixed PR")).toBeTruthy();

    const issueBadges = screen.getAllByText("Issue");
    const prBadges = screen.getAllByText("PR");
    expect(issueBadges.length).toBeGreaterThan(0);
    expect(prBadges.length).toBeGreaterThan(0);
  });
});

describe("TrackedTab — pin button", () => {
  it("clicking pin button untracks item", () => {
    const issue = makeIssue({ id: 60, title: "Tracked Issue" });
    const tracked = makeTrackedItem({ id: 60, type: "issue", title: "Tracked Issue" });
    updateViewState({ trackedItems: [tracked] });

    render(() => <TrackedTab issues={[issue]} pullRequests={[]} userLogin="testuser" />);

    // Find the Unpin button (pin button in TrackedTab always has isTracked=true)
    const unpinBtn = screen.getByLabelText(`Unpin #${issue.number} ${issue.title}`);
    fireEvent.click(unpinBtn);

    expect(viewState.trackedItems).toHaveLength(0);
  });
});

describe("TrackedTab — no ignore action", () => {
  it("does not render ignore button on tracked items", () => {
    const issue = makeIssue({ id: 70, title: "Ignorable Issue" });
    const tracked = makeTrackedItem({ id: 70, type: "issue", title: "Ignorable Issue" });
    updateViewState({ trackedItems: [tracked] });

    render(() => <TrackedTab issues={[issue]} pullRequests={[]} userLogin="testuser" />);

    // Ignore button should NOT be present — TrackedTab only allows untracking
    expect(screen.queryByLabelText(`Ignore #${issue.number} ${issue.title}`)).toBeNull();
  });
});

describe("TrackedTab — Jira items", () => {
  const jiraTracked = makeTrackedItem({
    id: -42,
    type: "jiraIssue",
    source: "jira",
    jiraKey: "PROJ-42",
    jiraProjectKey: "PROJ",
    jiraStatus: "In Progress",
    repoFullName: "mysite.atlassian.net/PROJ",
    title: "Fix login flow",
    htmlUrl: "https://mysite.atlassian.net/browse/PROJ-42",
    number: undefined,
  });

  it("renders Jira tracked item with key and title", () => {
    updateViewState({ trackedItems: [jiraTracked] });
    render(() => <TrackedTab issues={[]} pullRequests={[]} userLogin="testuser" />);

    expect(screen.getByText("PROJ-42")).toBeTruthy();
    expect(screen.getByText("Fix login flow")).toBeTruthy();
  });

  it("Jira item links to correct URL via htmlUrl", () => {
    updateViewState({ trackedItems: [jiraTracked] });
    render(() => <TrackedTab issues={[]} pullRequests={[]} userLogin="testuser" />);

    const link = screen.getByText("PROJ-42").closest("a");
    expect(link?.getAttribute("href")).toBe("https://mysite.atlassian.net/browse/PROJ-42");
  });

  it("Jira item shows status label", () => {
    updateViewState({ trackedItems: [jiraTracked] });
    render(() => <TrackedTab issues={[]} pullRequests={[]} userLogin="testuser" />);

    expect(screen.getByText("In Progress")).toBeTruthy();
  });

  it("mixed GitHub + Jira items render together", () => {
    const issue = makeIssue({ id: 80, title: "GitHub Issue" });
    const githubTracked = makeTrackedItem({ id: 80, type: "issue", title: "GitHub Issue" });
    updateViewState({ trackedItems: [githubTracked, jiraTracked] });

    render(() => <TrackedTab issues={[issue]} pullRequests={[]} userLogin="testuser" />);

    expect(screen.getByText("GitHub Issue")).toBeTruthy();
    expect(screen.getByText("Fix login flow")).toBeTruthy();
  });

  it("unpinning Jira item via untrackJiraItem removes it", () => {
    updateViewState({ trackedItems: [jiraTracked] });
    render(() => <TrackedTab issues={[]} pullRequests={[]} userLogin="testuser" />);

    untrackJiraItem("PROJ-42");
    expect(viewState.trackedItems).toHaveLength(0);
  });

  it("removing Jira item does not affect GitHub items", () => {
    const githubTracked = makeTrackedItem({ id: 90, type: "issue", title: "Stays" });
    updateViewState({ trackedItems: [githubTracked, jiraTracked] });

    untrackJiraItem("PROJ-42");
    expect(viewState.trackedItems).toHaveLength(1);
    expect(viewState.trackedItems[0].source).toBe("github");
  });

  it("Jira item does not render issue number prefix", () => {
    updateViewState({ trackedItems: [jiraTracked] });
    render(() => <TrackedTab issues={[]} pullRequests={[]} userLogin="testuser" />);

    // Should NOT show "#-42" or any number prefix — Jira items have number: undefined
    expect(screen.queryByText(/#-42/)).toBeNull();
  });
});
