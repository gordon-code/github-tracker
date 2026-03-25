import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { createSignal } from "solid-js";
import IssuesTab from "../../src/app/components/dashboard/IssuesTab";
import type { Issue } from "../../src/app/services/api";
import { makeIssue, resetViewStore } from "../helpers/index";
import * as viewStore from "../../src/app/stores/view";
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
      id: "99",
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
    render(() => <IssuesTab issues={issues} userLogin="" />);
    screen.getByText("In org");
    expect(screen.queryByText("Outside org")).toBeNull();
  });

  it("sorts by updatedAt descending by default", () => {
    const issues = [
      makeIssue({ id: 1, title: "Older issue", updatedAt: "2024-01-10T00:00:00Z" }),
      makeIssue({ id: 2, title: "Newer issue", updatedAt: "2024-01-20T00:00:00Z" }),
    ];
    render(() => <IssuesTab issues={issues} userLogin="" />);
    const allText = screen.getAllByRole("listitem");
    const texts = allText.map((el) => el.textContent ?? "");
    const newerIdx = texts.findIndex((t) => t.includes("Newer issue"));
    const olderIdx = texts.findIndex((t) => t.includes("Older issue"));
    expect(newerIdx).toBeLessThan(olderIdx);
  });

  it("renders SortDropdown in the toolbar", () => {
    render(() => <IssuesTab issues={[]} userLogin="" />);
    const select = screen.getByRole("combobox", { name: /sort by/i });
    expect(select).toBeDefined();
  });

  it("SortDropdown contains all sortable fields", () => {
    render(() => <IssuesTab issues={[]} userLogin="" />);
    const select = screen.getByRole("combobox", { name: /sort by/i }) as HTMLSelectElement;
    const optionValues = Array.from(select.options).map((o) => o.value);
    expect(optionValues.some((v) => v.startsWith("repo:"))).toBe(true);
    expect(optionValues.some((v) => v.startsWith("title:"))).toBe(true);
    expect(optionValues.some((v) => v.startsWith("author:"))).toBe(true);
    expect(optionValues.some((v) => v.startsWith("comments:"))).toBe(true);
    expect(optionValues.some((v) => v.startsWith("createdAt:"))).toBe(true);
    expect(optionValues.some((v) => v.startsWith("updatedAt:"))).toBe(true);
  });

  it("changes sort order when SortDropdown selection changes", () => {
    const setSortSpy = vi.spyOn(viewStore, "setSortPreference");
    const issues = [makeIssue({ title: "Issue A" })];
    render(() => <IssuesTab issues={issues} userLogin="" />);

    const select = screen.getByRole("combobox", { name: /sort by/i });
    fireEvent.change(select, { target: { value: "title:desc" } });

    expect(setSortSpy).toHaveBeenCalledWith("issues", "title", "desc");
    setSortSpy.mockRestore();
  });

  it("does not show pagination when there is only one page", () => {
    const issues = [makeIssue({ title: "Single issue" })];
    render(() => <IssuesTab issues={issues} userLogin="" />);
    expect(screen.queryByLabelText("Previous page")).toBeNull();
    expect(screen.queryByLabelText("Next page")).toBeNull();
  });

  it("first repo group auto-expands on initial mount", () => {
    const issues = [
      makeIssue({ id: 1, title: "Issue in first repo", repoFullName: "org/repo-a" }),
      makeIssue({ id: 2, title: "Issue in second repo", repoFullName: "org/repo-b" }),
    ];
    render(() => <IssuesTab issues={issues} userLogin="" />);
    // First group should be expanded — items visible
    screen.getByText("Issue in first repo");
    // Second group starts collapsed — items hidden
    expect(screen.queryByText("Issue in second repo")).toBeNull();
  });

  it("filters by role tab filter", () => {
    const issues = [
      makeIssue({ id: 1, title: "My Issue", userLogin: "alice", assigneeLogins: [] }),
      makeIssue({ id: 2, title: "Other Issue", userLogin: "bob", assigneeLogins: [] }),
    ];
    viewStore.setTabFilter("issues", "role", "author");
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
    render(() => <IssuesTab issues={issues} userLogin="" />);
    // Both repo headers visible
    screen.getByText("org/repo-a");
    screen.getByText("org/repo-b");
    // First group (repo-a) is auto-expanded — items visible
    screen.getByText("Issue in repo A");
    screen.getByText("Another in repo A");
    // Second group (repo-b) starts collapsed — items hidden
    expect(screen.queryByText("Issue in repo B")).toBeNull();
  });

  it("collapses the first auto-expanded repo group when header is clicked", async () => {
    const user = userEvent.setup();
    const issues = [
      makeIssue({ id: 1, title: "Visible issue", repoFullName: "org/repo-a" }),
    ];
    render(() => <IssuesTab issues={issues} userLogin="" />);
    // First group is auto-expanded
    screen.getByText("Visible issue");

    const repoHeader = screen.getByText("org/repo-a").closest("button")!;
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

  it("sets aria-expanded=true on the first (auto-expanded) repo group header", () => {
    const issues = [
      makeIssue({ id: 1, title: "Test issue", repoFullName: "org/repo-a" }),
    ];
    render(() => <IssuesTab issues={issues} userLogin="" />);
    const header = screen.getByText("org/repo-a").closest("button")!;
    expect(header.getAttribute("aria-expanded")).toBe("true");
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

    // Initially auto-expanded
    expect(header.getAttribute("aria-expanded")).toBe("true");
    await user.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Toggle issue")).toBeNull();

    await user.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");
    screen.getByText("Toggle issue");
  });

  it("shows item count in collapsed repo group header", async () => {
    const user = userEvent.setup();
    const issues = [
      makeIssue({ id: 1, title: "Issue 1", repoFullName: "org/repo-a" }),
      makeIssue({ id: 2, title: "Issue 2", repoFullName: "org/repo-a" }),
      makeIssue({ id: 3, title: "Issue 3", repoFullName: "org/repo-a" }),
    ];
    render(() => <IssuesTab issues={issues} userLogin="" />);

    // Collapse the auto-expanded group
    const header = screen.getByText("org/repo-a").closest("button")!;
    await user.click(header);

    screen.getByText("3 issues");
  });

  it("shows singular 'issue' for a group with one item when collapsed", async () => {
    const user = userEvent.setup();
    const issues = [
      makeIssue({ id: 1, title: "Only issue", repoFullName: "org/repo-a" }),
    ];
    render(() => <IssuesTab issues={issues} userLogin="" />);

    const header = screen.getByText("org/repo-a").closest("button")!;
    await user.click(header);

    screen.getByText("1 issue");
  });

  it("shows role summary badges in collapsed repo group header", async () => {
    const user = userEvent.setup();
    const issues = [
      makeIssue({ id: 1, title: "My issue", repoFullName: "org/repo-a", userLogin: "alice", assigneeLogins: [] }),
      makeIssue({ id: 2, title: "My second issue", repoFullName: "org/repo-a", userLogin: "alice", assigneeLogins: [] }),
    ];
    render(() => <IssuesTab issues={issues} userLogin="alice" />);

    // Collapse the auto-expanded group
    const header = screen.getByText("org/repo-a").closest("button")!;
    await user.click(header);

    // Should show author role badge with count
    screen.getByText("author ×2");
  });

  it("hides summary metadata when repo group is expanded", async () => {
    const user = userEvent.setup();
    const issues = [
      makeIssue({ id: 1, title: "Issue A", repoFullName: "org/repo-a", userLogin: "alice", assigneeLogins: [] }),
    ];
    render(() => <IssuesTab issues={issues} userLogin="alice" />);

    // Group starts expanded — no summary count visible
    expect(screen.queryByText("1 issue")).toBeNull();

    // Collapse — summary appears
    const header = screen.getByText("org/repo-a").closest("button")!;
    await user.click(header);
    screen.getByText("1 issue");

    // Expand again — summary disappears
    await user.click(header);
    expect(screen.queryByText("1 issue")).toBeNull();
  });

  it("IgnoreBadge renders in the toolbar", () => {
    const issue = makeIssue({ id: 77, title: "To ignore" });
    viewStore.ignoreItem({
      id: "77",
      type: "issue",
      repo: issue.repoFullName,
      title: issue.title,
      ignoredAt: Date.now(),
    });
    render(() => <IssuesTab issues={[issue]} userLogin="" />);
    // IgnoreBadge shows count of ignored items
    screen.getByText(/1 ignored/i);
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

    // First group (repo-a) is auto-expanded, collapse it
    const repoHeader = screen.getByText("org/repo-a").closest("button")!;
    await user.click(repoHeader);
    expect(screen.queryByText("Alice issue")).toBeNull();
    expect(repoHeader.getAttribute("aria-expanded")).toBe("false");

    // Apply role filter that keeps only alice's issue (repo-a)
    viewStore.setTabFilter("issues", "role", "author");
    // repo-a still visible (collapsed), repo-b filtered out
    screen.getByText("org/repo-a");
    expect(screen.queryByText("org/repo-b")).toBeNull();
    // Items still hidden because collapse state persists
    expect(screen.queryByText("Alice issue")).toBeNull();

    // Clear filter — repo-b reappears, repo-a stays collapsed
    viewStore.resetTabFilter("issues", "role");
    screen.getByText("org/repo-a");
    screen.getByText("org/repo-b");
    // repo-a stays collapsed (was collapsed before filter applied)
    expect(screen.queryByText("Alice issue")).toBeNull();
    // repo-b is collapsed (never expanded), so Bob issue is also hidden
    expect(screen.queryByText("Bob issue")).toBeNull();
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
    render(() => <IssuesTab issues={issues} userLogin="" />);
    // All 15 items in one group — whole-groups-only pagination keeps them together
    screen.getByText("org/big-repo");
    screen.getByText("Big repo issue 0");
    screen.getByText("Big repo issue 14");
    // No pagination controls (single page with oversized group)
    expect(screen.queryByLabelText("Next page")).toBeNull();
  });
});
