import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { createSignal } from "solid-js";
import IssuesTab from "../../src/app/components/dashboard/IssuesTab";
import type { Issue, ApiError } from "../../src/app/services/api";
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

  it("shows error banners for each ApiError", () => {
    const errors: ApiError[] = [
      { repo: "owner/repo", statusCode: 500, message: "Server error", retryable: true },
      { repo: "owner/other", statusCode: 403, message: "Forbidden", retryable: false },
    ];
    render(() => <IssuesTab issues={[]} errors={errors} userLogin="" />);
    screen.getByText(/Server error/i);
    screen.getByText(/Forbidden/i);
  });

  it("shows '(will retry)' for retryable errors", () => {
    const errors: ApiError[] = [
      { repo: "owner/repo", statusCode: 500, message: "Server error", retryable: true },
    ];
    render(() => <IssuesTab issues={[]} errors={errors} userLogin="" />);
    screen.getByText(/will retry/i);
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

  it("changes sort order when a column header is clicked", async () => {
    const user = userEvent.setup();
    const setSortSpy = vi.spyOn(viewStore, "setSortPreference");
    const issues = [makeIssue({ title: "Issue A" })];
    render(() => <IssuesTab issues={issues} userLogin="" />);

    const titleHeader = screen.getByLabelText(/Sort by Title/i);
    await user.click(titleHeader);

    expect(setSortSpy).toHaveBeenCalledWith("issues", "title", "desc");
    setSortSpy.mockRestore();
  });

  it("toggles sort direction on second click of same column", async () => {
    const user = userEvent.setup();
    const issues = [makeIssue({ title: "Issue A" })];
    render(() => <IssuesTab issues={issues} userLogin="" />);

    const titleHeader = screen.getByLabelText(/Sort by Title/i);
    // First click: title was not active, so sets desc
    await user.click(titleHeader);
    expect(viewStore.viewState.sortPreferences["issues"]).toEqual({ field: "title", direction: "desc" });
    // Second click on same column: toggles to asc
    await user.click(titleHeader);
    expect(viewStore.viewState.sortPreferences["issues"]).toEqual({ field: "title", direction: "asc" });
  });

  it("does not show pagination when there is only one page", () => {
    const issues = [makeIssue({ title: "Single issue" })];
    render(() => <IssuesTab issues={issues} userLogin="" />);
    expect(screen.queryByLabelText("Previous page")).toBeNull();
    expect(screen.queryByLabelText("Next page")).toBeNull();
  });

  it("renders column headers for all sortable fields", () => {
    render(() => <IssuesTab issues={[]} userLogin="" />);
    screen.getByLabelText("Sort by Repo");
    screen.getByLabelText("Sort by Title");
    screen.getByLabelText("Sort by Author");
    screen.getByLabelText("Sort by Created");
    screen.getByLabelText("Sort by Updated");
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

  it("renders Comments column header", () => {
    render(() => <IssuesTab issues={[]} userLogin="" />);
    screen.getByLabelText("Sort by Comments");
  });

  it("groups issues by repo with collapsible headers", () => {
    const issues = [
      makeIssue({ id: 1, title: "Issue in repo A", repoFullName: "org/repo-a" }),
      makeIssue({ id: 2, title: "Issue in repo B", repoFullName: "org/repo-b" }),
      makeIssue({ id: 3, title: "Another in repo A", repoFullName: "org/repo-a" }),
    ];
    render(() => <IssuesTab issues={issues} userLogin="" />);
    screen.getByText("org/repo-a");
    screen.getByText("org/repo-b");
    screen.getByText("Issue in repo A");
    screen.getByText("Another in repo A");
    screen.getByText("Issue in repo B");
  });

  it("collapses a repo group when header is clicked", async () => {
    const user = userEvent.setup();
    const issues = [
      makeIssue({ id: 1, title: "Visible issue", repoFullName: "org/repo-a" }),
      makeIssue({ id: 2, title: "Other repo issue", repoFullName: "org/repo-b" }),
    ];
    render(() => <IssuesTab issues={issues} userLogin="" />);
    screen.getByText("Visible issue");

    const repoHeader = screen.getByText("org/repo-a");
    await user.click(repoHeader);

    expect(screen.queryByText("Visible issue")).toBeNull();
    screen.getByText("Other repo issue");
  });

  it("sets aria-expanded on repo group headers", () => {
    const issues = [
      makeIssue({ id: 1, title: "Test issue", repoFullName: "org/repo-a" }),
    ];
    render(() => <IssuesTab issues={issues} userLogin="" />);
    const header = screen.getByText("org/repo-a").closest("button")!;
    expect(header.getAttribute("aria-expanded")).toBe("true");
  });

  it("toggles aria-expanded to false on collapse and back to true on re-expand", async () => {
    const user = userEvent.setup();
    const issues = [
      makeIssue({ id: 1, title: "Toggle issue", repoFullName: "org/repo-a" }),
    ];
    render(() => <IssuesTab issues={issues} userLogin="" />);
    const header = screen.getByText("org/repo-a").closest("button")!;

    expect(header.getAttribute("aria-expanded")).toBe("true");
    await user.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Toggle issue")).toBeNull();

    await user.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");
    screen.getByText("Toggle issue");
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

  it("preserves collapse state across filter changes", async () => {
    const user = userEvent.setup();
    const issues = [
      makeIssue({ id: 1, title: "Alice issue", repoFullName: "org/repo-a", userLogin: "alice" }),
      makeIssue({ id: 2, title: "Bob issue", repoFullName: "org/repo-b", userLogin: "bob" }),
    ];
    render(() => <IssuesTab issues={issues} userLogin="alice" />);

    // Collapse repo-a
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
    expect(screen.queryByText("Alice issue")).toBeNull();
    screen.getByText("Bob issue");
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
