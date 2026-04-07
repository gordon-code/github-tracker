import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { createSignal } from "solid-js";
import IssuesTab from "../../src/app/components/dashboard/IssuesTab";
import type { Issue } from "../../src/app/services/api";
import { makeIssue, resetViewStore } from "../helpers/index";
import * as viewStore from "../../src/app/stores/view";
import { setAllExpanded, viewState } from "../../src/app/stores/view";
import { updateConfig, resetConfig } from "../../src/app/stores/config";

beforeEach(() => {
  resetViewStore();
  resetConfig();
});

describe("IssuesTab", () => {
  it("renders a list of issues", () => {
    const issues = [
      makeIssue({ number: 1, title: "First issue" }),
      makeIssue({ number: 2, title: "Second issue" }),
    ];
    setAllExpanded("issues", ["owner/repo"], true);
    render(() => <IssuesTab issues={issues} userLogin="" />);
    screen.getByText("First issue");
    screen.getByText("Second issue");
  });

  it("shows empty state when issues array is empty", () => {
    render(() => <IssuesTab issues={[]} userLogin="" />);
    screen.getByText(/No open issues involving you/i);
  });

  it("shows loading skeleton when loading=true", () => {
    render(() => <IssuesTab issues={[]} loading={true} userLogin="" />);
    const status = screen.getByRole("status");
    expect(status).toBeDefined();
    // Issue list should not render during loading
    expect(screen.queryByText(/No open issues/i)).toBeNull();
  });

  it("filters out ignored issues", () => {
    const issue = makeIssue({ id: 99, title: "Should be hidden" });
    viewStore.ignoreItem({
      id: 99,
      type: "issue",
      repo: issue.repoFullName,
      title: issue.title,
      ignoredAt: Date.now(),
    });
    render(() => <IssuesTab issues={[issue]} userLogin="" />);
    expect(screen.queryByText("Should be hidden")).toBeNull();
    screen.getByText(/No open issues/i);
  });

  it("filters by globalFilter.repo", () => {
    const issues = [
      makeIssue({ number: 1, title: "In target repo", repoFullName: "owner/target" }),
      makeIssue({ number: 2, title: "In other repo", repoFullName: "owner/other" }),
    ];
    viewStore.setGlobalFilter(null, "owner/target");
    setAllExpanded("issues", ["owner/target"], true);
    render(() => <IssuesTab issues={issues} userLogin="" />);
    screen.getByText("In target repo");
    expect(screen.queryByText("In other repo")).toBeNull();
  });

  it("filters by globalFilter.org", () => {
    const issues = [
      makeIssue({ number: 1, title: "In org", repoFullName: "myorg/repo-a" }),
      makeIssue({ number: 2, title: "Outside org", repoFullName: "otherorg/repo-b" }),
    ];
    viewStore.setGlobalFilter("myorg", null);
    setAllExpanded("issues", ["myorg/repo-a"], true);
    render(() => <IssuesTab issues={issues} userLogin="" />);
    screen.getByText("In org");
    expect(screen.queryByText("Outside org")).toBeNull();
  });

  it("sorts by updatedAt descending by default", () => {
    const issues = [
      makeIssue({ id: 1, title: "Older issue", updatedAt: "2024-01-10T00:00:00Z" }),
      makeIssue({ id: 2, title: "Newer issue", updatedAt: "2024-01-20T00:00:00Z" }),
    ];
    setAllExpanded("issues", ["owner/repo"], true);
    render(() => <IssuesTab issues={issues} userLogin="" />);
    const allText = screen.getAllByRole("listitem");
    const texts = allText.map((el) => el.textContent ?? "");
    const newerIdx = texts.findIndex((t) => t.includes("Newer issue"));
    const olderIdx = texts.findIndex((t) => t.includes("Older issue"));
    expect(newerIdx).toBeLessThan(olderIdx);
  });

  it("SortDropdown is not rendered in the tab toolbar (moved to FilterBar)", () => {
    render(() => <IssuesTab issues={[]} userLogin="" />);
    // SortDropdown was moved to FilterBar; not rendered in tab isolation
    expect(screen.queryByRole("button", { name: /sort by/i })).toBeNull();
  });

  it("does not show pagination when there is only one page", () => {
    const issues = [makeIssue({ title: "Single issue" })];
    render(() => <IssuesTab issues={issues} userLogin="" />);
    expect(screen.queryByLabelText("Previous page")).toBeNull();
    expect(screen.queryByLabelText("Next page")).toBeNull();
  });

  it("all repo groups start collapsed by default", () => {
    const issues = [
      makeIssue({ id: 1, title: "Issue in first repo", repoFullName: "org/repo-a" }),
      makeIssue({ id: 2, title: "Issue in second repo", repoFullName: "org/repo-b" }),
    ];
    render(() => <IssuesTab issues={issues} userLogin="" />);
    // Both groups start collapsed — headers visible, items hidden
    screen.getByText("org/repo-a");
    screen.getByText("org/repo-b");
    expect(screen.queryByText("Issue in first repo")).toBeNull();
    expect(screen.queryByText("Issue in second repo")).toBeNull();
  });

  it("filters by role tab filter", () => {
    const issues = [
      makeIssue({ id: 1, title: "My Issue", userLogin: "alice", assigneeLogins: [] }),
      makeIssue({ id: 2, title: "Other Issue", userLogin: "bob", assigneeLogins: [] }),
    ];
    viewStore.setTabFilter("issues", "role", "author");
    setAllExpanded("issues", ["owner/repo"], true);
    render(() => <IssuesTab issues={issues} userLogin="alice" />);
    screen.getByText("My Issue");
    expect(screen.queryByText("Other Issue")).toBeNull();
  });

  it("filters by comments tab filter — has comments", () => {
    const issues = [
      makeIssue({ id: 1, title: "Discussed Issue", comments: 5 }),
      makeIssue({ id: 2, title: "Silent Issue", comments: 0 }),
    ];
    viewStore.setTabFilter("issues", "comments", "has");
    setAllExpanded("issues", ["owner/repo"], true);
    render(() => <IssuesTab issues={issues} userLogin="" />);
    screen.getByText("Discussed Issue");
    expect(screen.queryByText("Silent Issue")).toBeNull();
  });

  it("filters by comments tab filter — no comments", () => {
    const issues = [
      makeIssue({ id: 1, title: "Discussed Issue", comments: 5 }),
      makeIssue({ id: 2, title: "Silent Issue", comments: 0 }),
    ];
    viewStore.setTabFilter("issues", "comments", "none");
    setAllExpanded("issues", ["owner/repo"], true);
    render(() => <IssuesTab issues={issues} userLogin="" />);
    screen.getByText("Silent Issue");
    expect(screen.queryByText("Discussed Issue")).toBeNull();
  });

  it("groups issues by repo with collapsible headers", () => {
    const issues = [
      makeIssue({ id: 1, title: "Issue in repo A", repoFullName: "org/repo-a" }),
      makeIssue({ id: 2, title: "Issue in repo B", repoFullName: "org/repo-b" }),
      makeIssue({ id: 3, title: "Another in repo A", repoFullName: "org/repo-a" }),
    ];
    setAllExpanded("issues", ["org/repo-a"], true);
    render(() => <IssuesTab issues={issues} userLogin="" />);
    // Both repo headers visible
    screen.getByText("org/repo-a");
    screen.getByText("org/repo-b");
    // repo-a is expanded — items visible
    screen.getByText("Issue in repo A");
    screen.getByText("Another in repo A");
    // repo-b starts collapsed — items hidden
    expect(screen.queryByText("Issue in repo B")).toBeNull();
  });

  it("expands and collapses a repo group when header is clicked", async () => {
    const user = userEvent.setup();
    const issues = [
      makeIssue({ id: 1, title: "Visible issue", repoFullName: "org/repo-a" }),
    ];
    render(() => <IssuesTab issues={issues} userLogin="" />);
    // Starts collapsed
    expect(screen.queryByText("Visible issue")).toBeNull();

    // Click to expand
    const repoHeader = screen.getByText("org/repo-a").closest("button")!;
    await user.click(repoHeader);
    screen.getByText("Visible issue");

    // Click to collapse
    await user.click(repoHeader);
    expect(screen.queryByText("Visible issue")).toBeNull();
  });

  it("expands a collapsed repo group when header is clicked", async () => {
    const user = userEvent.setup();
    const issues = [
      makeIssue({ id: 1, title: "First repo issue", repoFullName: "org/repo-a" }),
      makeIssue({ id: 2, title: "Second repo issue", repoFullName: "org/repo-b" }),
    ];
    render(() => <IssuesTab issues={issues} userLogin="" />);
    // Second group starts collapsed
    expect(screen.queryByText("Second repo issue")).toBeNull();

    const repoBHeader = screen.getByText("org/repo-b").closest("button")!;
    await user.click(repoBHeader);

    screen.getByText("Second repo issue");
  });

  it("sets aria-expanded=false on all repo group headers by default", () => {
    const issues = [
      makeIssue({ id: 1, title: "Test issue", repoFullName: "org/repo-a" }),
    ];
    render(() => <IssuesTab issues={issues} userLogin="" />);
    const header = screen.getByText("org/repo-a").closest("button")!;
    expect(header.getAttribute("aria-expanded")).toBe("false");
  });

  it("sets aria-expanded=false on subsequent (collapsed) repo group headers", () => {
    const issues = [
      makeIssue({ id: 1, title: "First", repoFullName: "org/repo-a" }),
      makeIssue({ id: 2, title: "Second", repoFullName: "org/repo-b" }),
    ];
    render(() => <IssuesTab issues={issues} userLogin="" />);
    const headerB = screen.getByText("org/repo-b").closest("button")!;
    expect(headerB.getAttribute("aria-expanded")).toBe("false");
  });

  it("toggles aria-expanded when clicking repo group headers", async () => {
    const user = userEvent.setup();
    const issues = [
      makeIssue({ id: 1, title: "Toggle issue", repoFullName: "org/repo-a" }),
    ];
    render(() => <IssuesTab issues={issues} userLogin="" />);
    const header = screen.getByText("org/repo-a").closest("button")!;

    // Initially collapsed
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Toggle issue")).toBeNull();

    await user.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");
    screen.getByText("Toggle issue");

    await user.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Toggle issue")).toBeNull();
  });

  it("shows item count in collapsed repo group header", () => {
    const issues = [
      makeIssue({ id: 1, title: "Issue 1", repoFullName: "org/repo-a" }),
      makeIssue({ id: 2, title: "Issue 2", repoFullName: "org/repo-a" }),
      makeIssue({ id: 3, title: "Issue 3", repoFullName: "org/repo-a" }),
    ];
    render(() => <IssuesTab issues={issues} userLogin="" />);
    // Groups start collapsed — summary visible
    screen.getByText("3 issues");
  });

  it("shows singular 'issue' for a group with one item when collapsed", () => {
    const issues = [
      makeIssue({ id: 1, title: "Only issue", repoFullName: "org/repo-a" }),
    ];
    render(() => <IssuesTab issues={issues} userLogin="" />);
    // Group starts collapsed
    screen.getByText("1 issue");
  });

  it("shows role summary badges in collapsed repo group header", () => {
    const issues = [
      makeIssue({ id: 1, title: "My issue", repoFullName: "org/repo-a", userLogin: "alice", assigneeLogins: [] }),
      makeIssue({ id: 2, title: "My second issue", repoFullName: "org/repo-a", userLogin: "alice", assigneeLogins: [] }),
    ];
    render(() => <IssuesTab issues={issues} userLogin="alice" />);
    // Group starts collapsed — summary badges visible
    screen.getByText("author ×2");
  });

  it("hides summary metadata when repo group is expanded", async () => {
    const user = userEvent.setup();
    const issues = [
      makeIssue({ id: 1, title: "Issue A", repoFullName: "org/repo-a", userLogin: "alice", assigneeLogins: [] }),
    ];
    render(() => <IssuesTab issues={issues} userLogin="alice" />);

    // Group starts collapsed — summary count visible
    screen.getByText("1 issue");

    // Expand — summary disappears
    const header = screen.getByText("org/repo-a").closest("button")!;
    await user.click(header);
    expect(screen.queryByText("1 issue")).toBeNull();

    // Collapse again — summary reappears
    await user.click(header);
    screen.getByText("1 issue");
  });

  it("IgnoreBadge renders in the toolbar", () => {
    const issue = makeIssue({ id: 77, title: "To ignore" });
    viewStore.ignoreItem({
      id: 77,
      type: "issue",
      repo: issue.repoFullName,
      title: issue.title,
      ignoredAt: Date.now(),
    });
    render(() => <IssuesTab issues={[issue]} userLogin="" />);
    // IgnoreBadge now shows an icon button with aria-label
    screen.getByRole("button", { name: /1 ignored/i });
  });

  it("paginates repo groups across pages", async () => {
    const user = userEvent.setup();
    updateConfig({ itemsPerPage: 10 });
    const issues = [
      ...Array.from({ length: 6 }, (_, i) =>
        makeIssue({ id: 100 + i, title: `Repo A issue ${i}`, repoFullName: "org/repo-a" })
      ),
      ...Array.from({ length: 6 }, (_, i) =>
        makeIssue({ id: 200 + i, title: `Repo B issue ${i}`, repoFullName: "org/repo-b" })
      ),
    ];
    render(() => <IssuesTab issues={issues} userLogin="" />);
    // Page 1: repo-a (6 items), Page 2: repo-b (6 items) — 12 total > pageSize 10
    screen.getByText("org/repo-a");
    screen.getByText(/Page 1 of 2/);
    expect(screen.queryByText("org/repo-b")).toBeNull();

    const nextBtn = screen.getByLabelText("Next page");
    await user.click(nextBtn);
    screen.getByText("org/repo-b");
    screen.getByText(/Page 2 of 2/);
  });

  it("preserves expand state across filter changes", async () => {
    const user = userEvent.setup();
    const issues = [
      makeIssue({ id: 1, title: "Alice issue", repoFullName: "org/repo-a", userLogin: "alice" }),
      makeIssue({ id: 2, title: "Bob issue", repoFullName: "org/repo-b", userLogin: "bob" }),
    ];
    render(() => <IssuesTab issues={issues} userLogin="alice" />);

    // Expand repo-a
    const repoHeader = screen.getByText("org/repo-a").closest("button")!;
    await user.click(repoHeader);
    screen.getByText("Alice issue");

    // Apply role filter that keeps only alice's issue (repo-a)
    viewStore.setTabFilter("issues", "role", "author");
    // repo-a still visible (expanded), repo-b filtered out
    screen.getByText("org/repo-a");
    screen.getByText("Alice issue");
    expect(screen.queryByText("org/repo-b")).toBeNull();

    // Clear filter — repo-b reappears, repo-a stays expanded
    viewStore.setTabFilter("issues", "role", "all");
    screen.getByText("org/repo-a");
    screen.getByText("org/repo-b");
    screen.getByText("Alice issue");
    // repo-b is collapsed (never expanded), so Bob issue is hidden
    expect(screen.queryByText("Bob issue")).toBeNull();
  });

  it("collapse all with active filter preserves hidden repos' expanded state", async () => {
    const user = userEvent.setup();
    const issues = [
      makeIssue({ id: 1, title: "Alice issue", repoFullName: "org/repo-a", userLogin: "alice" }),
      makeIssue({ id: 2, title: "Bob issue", repoFullName: "org/repo-b", userLogin: "bob" }),
    ];
    setAllExpanded("issues", ["org/repo-a", "org/repo-b"], true);
    render(() => <IssuesTab issues={issues} userLogin="alice" />);
    screen.getByText("Alice issue");
    screen.getByText("Bob issue");

    // Apply filter hiding repo-b (only alice's issues visible)
    viewStore.setTabFilter("issues", "role", "author");
    screen.getByText("Alice issue");
    expect(screen.queryByText("org/repo-b")).toBeNull();

    // Collapse all — only affects visible (filtered) repos
    await user.click(screen.getByLabelText("Collapse all repos"));
    expect(screen.queryByText("Alice issue")).toBeNull();

    // Remove filter — repo-b should still be expanded (was hidden during collapse-all)
    viewStore.setTabFilter("issues", "role", "all");
    screen.getByText("Bob issue");
    // repo-a was collapsed by collapse-all
    expect(screen.queryByText("Alice issue")).toBeNull();
  });

  it("resets page when data shrinks below current page", async () => {
    const user = userEvent.setup();
    updateConfig({ itemsPerPage: 10 });
    const repoAIssues = Array.from({ length: 6 }, (_, i) =>
      makeIssue({ id: 100 + i, title: `Repo A issue ${i}`, repoFullName: "org/repo-a" })
    );
    const repoBIssues = Array.from({ length: 6 }, (_, i) =>
      makeIssue({ id: 200 + i, title: `Repo B issue ${i}`, repoFullName: "org/repo-b" })
    );
    setAllExpanded("issues", ["org/repo-a", "org/repo-b"], true);
    const [issues, setIssues] = createSignal<Issue[]>([...repoAIssues, ...repoBIssues]);
    render(() => <IssuesTab issues={issues()} userLogin="" />);

    // Navigate to page 2
    screen.getByText(/Page 1 of 2/);
    await user.click(screen.getByLabelText("Next page"));
    screen.getByText(/Page 2 of 2/);
    screen.getByText("org/repo-b");

    // Shrink data to fit on 1 page — page should reset
    setIssues(repoAIssues);
    expect(screen.queryByLabelText("Next page")).toBeNull();
    screen.getByText("org/repo-a");
    screen.getByText("Repo A issue 0");
  });

  it("keeps a large single-repo group on one page without splitting", () => {
    updateConfig({ itemsPerPage: 10 });
    const issues = Array.from({ length: 15 }, (_, i) =>
      makeIssue({ id: 300 + i, title: `Big repo issue ${i}`, repoFullName: "org/big-repo" })
    );
    setAllExpanded("issues", ["org/big-repo"], true);
    render(() => <IssuesTab issues={issues} userLogin="" />);
    // All 15 items in one group — whole-groups-only pagination keeps them together
    screen.getByText("org/big-repo");
    screen.getByText("Big repo issue 0");
    screen.getByText("Big repo issue 14");
    // No pagination controls (single page with oversized group)
    expect(screen.queryByLabelText("Next page")).toBeNull();
  });

  it("clicking 'Expand all' expands all repo groups", async () => {
    const user = userEvent.setup();
    const issues = [
      makeIssue({ id: 1, title: "Issue A", repoFullName: "org/repo-a" }),
      makeIssue({ id: 2, title: "Issue B", repoFullName: "org/repo-b" }),
    ];
    render(() => <IssuesTab issues={issues} userLogin="" />);
    // Both start collapsed
    expect(screen.queryByText("Issue A")).toBeNull();
    expect(screen.queryByText("Issue B")).toBeNull();

    await user.click(screen.getByLabelText("Expand all repos"));
    screen.getByText("Issue A");
    screen.getByText("Issue B");
  });

  it("clicking 'Collapse all' collapses all repo groups", async () => {
    const user = userEvent.setup();
    const issues = [
      makeIssue({ id: 1, title: "Issue A", repoFullName: "org/repo-a" }),
      makeIssue({ id: 2, title: "Issue B", repoFullName: "org/repo-b" }),
    ];
    setAllExpanded("issues", ["org/repo-a", "org/repo-b"], true);
    render(() => <IssuesTab issues={issues} userLogin="" />);
    screen.getByText("Issue A");
    screen.getByText("Issue B");

    await user.click(screen.getByLabelText("Collapse all repos"));
    expect(screen.queryByText("Issue A")).toBeNull();
    expect(screen.queryByText("Issue B")).toBeNull();
  });

  it("expanded state persists in viewState after toggle", async () => {
    const user = userEvent.setup();
    const issues = [
      makeIssue({ id: 1, title: "Persisted issue", repoFullName: "org/repo-a" }),
    ];
    render(() => <IssuesTab issues={issues} userLogin="" />);
    const header = screen.getByText("org/repo-a").closest("button")!;
    await user.click(header);
    expect(viewState.expandedRepos.issues["org/repo-a"]).toBe(true);
  });

  it("expanded state survives component unmount/remount", async () => {
    const user = userEvent.setup();
    const issues = [
      makeIssue({ id: 1, title: "Survives remount", repoFullName: "org/repo-a" }),
    ];
    const { unmount } = render(() => <IssuesTab issues={issues} userLogin="" />);
    const header = screen.getByText("org/repo-a").closest("button")!;
    await user.click(header);
    screen.getByText("Survives remount");

    unmount();
    render(() => <IssuesTab issues={issues} userLogin="" />);
    // State persisted in viewState store — should still be expanded
    screen.getByText("Survives remount");
  });

  it("prunes stale expanded keys when a repo disappears from data", () => {
    const [issues, setIssues] = createSignal<Issue[]>([
      makeIssue({ id: 1, title: "Repo A issue", repoFullName: "org/repo-a" }),
      makeIssue({ id: 2, title: "Repo B issue", repoFullName: "org/repo-b" }),
    ]);
    setAllExpanded("issues", ["org/repo-a", "org/repo-b"], true);
    render(() => <IssuesTab issues={issues()} userLogin="" />);
    // Both repos expanded
    screen.getByText("Repo A issue");
    screen.getByText("Repo B issue");

    // Remove repo-b from data — pruning effect should fire
    setIssues([makeIssue({ id: 1, title: "Repo A issue", repoFullName: "org/repo-a" })]);
    expect(viewState.expandedRepos.issues["org/repo-a"]).toBe(true);
    expect("org/repo-b" in viewState.expandedRepos.issues).toBe(false);
  });

  it("prunes the first repo key when it disappears (name-based, not positional)", () => {
    const [issues, setIssues] = createSignal<Issue[]>([
      makeIssue({ id: 1, title: "Repo A issue", repoFullName: "org/repo-a" }),
      makeIssue({ id: 2, title: "Repo B issue", repoFullName: "org/repo-b" }),
    ]);
    setAllExpanded("issues", ["org/repo-a", "org/repo-b"], true);
    render(() => <IssuesTab issues={issues()} userLogin="" />);

    // Remove repo-a (first), keep repo-b (second)
    setIssues([makeIssue({ id: 2, title: "Repo B issue", repoFullName: "org/repo-b" })]);
    expect("org/repo-a" in viewState.expandedRepos.issues).toBe(false);
    expect(viewState.expandedRepos.issues["org/repo-b"]).toBe(true);
  });

  it("preserves expanded keys when data becomes empty and restores UI on re-population", () => {
    const [issues, setIssues] = createSignal<Issue[]>([
      makeIssue({ id: 1, title: "Issue A", repoFullName: "org/repo-a" }),
    ]);
    setAllExpanded("issues", ["org/repo-a"], true);
    render(() => <IssuesTab issues={issues()} userLogin="" />);
    screen.getByText("Issue A");

    // Data becomes empty (e.g. loading state) — expanded state should be preserved
    setIssues([]);
    expect(viewState.expandedRepos.issues["org/repo-a"]).toBe(true);

    // Data returns — UI should use preserved expanded state
    setIssues([makeIssue({ id: 1, title: "Issue A", repoFullName: "org/repo-a" })]);
    screen.getByText("Issue A");
  });

  it("clicking 'Expand all' expands repos on other pages too", async () => {
    const user = userEvent.setup();
    updateConfig({ itemsPerPage: 10 });
    const issues = [
      ...Array.from({ length: 6 }, (_, i) =>
        makeIssue({ id: 100 + i, title: `Repo A issue ${i}`, repoFullName: "org/repo-a" })
      ),
      ...Array.from({ length: 6 }, (_, i) =>
        makeIssue({ id: 200 + i, title: `Repo B issue ${i}`, repoFullName: "org/repo-b" })
      ),
    ];
    render(() => <IssuesTab issues={issues} userLogin="" />);
    // Page 1 shows repo-a, page 2 shows repo-b
    screen.getByText(/Page 1 of 2/);

    // Expand all — affects repos on ALL pages
    await user.click(screen.getByLabelText("Expand all repos"));
    // Repo-a items visible on page 1
    screen.getByText("Repo A issue 0");

    // Navigate to page 2 — repo-b should already be expanded
    await user.click(screen.getByLabelText("Next page"));
    screen.getByText("org/repo-b");
    screen.getByText("Repo B issue 0");
  });

  it("hides Dependency Dashboard issues by default", () => {
    const issues = [
      makeIssue({ id: 1, title: "Dependency Dashboard" }),
      makeIssue({ id: 2, title: "Normal issue" }),
    ];
    setAllExpanded("issues", ["owner/repo"], true);
    render(() => <IssuesTab issues={issues} userLogin="" />);
    expect(screen.queryByText("Dependency Dashboard")).toBeNull();
    screen.getByText("Normal issue");
  });

  it("shows Dependency Dashboard issues when hideDepDashboard is false", () => {
    const issues = [
      makeIssue({ id: 1, title: "Dependency Dashboard" }),
      makeIssue({ id: 2, title: "Normal issue" }),
    ];
    viewStore.updateViewState({ hideDepDashboard: false });
    setAllExpanded("issues", ["owner/repo"], true);
    render(() => <IssuesTab issues={issues} userLogin="" />);
    screen.getByText("Dependency Dashboard");
    screen.getByText("Normal issue");
  });

  it("toggles Dependency Dashboard visibility via pill button", async () => {
    const user = userEvent.setup();
    const issues = [
      makeIssue({ id: 1, title: "Dependency Dashboard" }),
      makeIssue({ id: 2, title: "Normal issue" }),
    ];
    setAllExpanded("issues", ["owner/repo"], true);
    render(() => <IssuesTab issues={issues} userLogin="" />);

    // Hidden by default
    expect(screen.queryByText("Dependency Dashboard")).toBeNull();

    // Click toggle pill to show
    await user.click(screen.getByText("Show Dep Dashboard"));
    screen.getByText("Dependency Dashboard");

    // Click again to hide
    await user.click(screen.getByText("Show Dep Dashboard"));
    expect(screen.queryByText("Dependency Dashboard")).toBeNull();
  });

  it("renders repo header link to GitHub issues", () => {
    const issues = [makeIssue({ id: 1 })];
    setAllExpanded("issues", ["owner/repo"], true);
    render(() => <IssuesTab issues={issues} userLogin="" />);
    const link = screen.getByLabelText("Open owner/repo issues on GitHub");
    expect(link.getAttribute("href")).toBe("https://github.com/owner/repo/issues");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });
});
