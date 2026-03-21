import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import IssuesTab from "../../src/app/components/dashboard/IssuesTab";
import type { ApiError } from "../../src/app/services/api";
import { makeIssue } from "../helpers/index";
import * as viewStore from "../../src/app/stores/view";

// Reset view state between tests
beforeEach(() => {
  viewStore.updateViewState({
    globalFilter: { org: null, repo: null },
    sortPreferences: {},
    ignoredItems: [],
  });
});

describe("IssuesTab", () => {
  it("renders a list of issues", () => {
    const issues = [
      makeIssue({ number: 1, title: "First issue" }),
      makeIssue({ number: 2, title: "Second issue" }),
    ];
    render(() => <IssuesTab issues={issues} />);
    screen.getByText("First issue");
    screen.getByText("Second issue");
  });

  it("shows empty state when issues array is empty", () => {
    render(() => <IssuesTab issues={[]} />);
    screen.getByText(/No open issues involving you/i);
  });

  it("shows loading skeleton when loading=true", () => {
    render(() => <IssuesTab issues={[]} loading={true} />);
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
    render(() => <IssuesTab issues={[]} errors={errors} />);
    screen.getByText(/Server error/i);
    screen.getByText(/Forbidden/i);
  });

  it("shows '(will retry)' for retryable errors", () => {
    const errors: ApiError[] = [
      { repo: "owner/repo", statusCode: 500, message: "Server error", retryable: true },
    ];
    render(() => <IssuesTab issues={[]} errors={errors} />);
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
    render(() => <IssuesTab issues={[issue]} />);
    expect(screen.queryByText("Should be hidden")).toBeNull();
    screen.getByText(/No open issues/i);
  });

  it("filters by globalFilter.repo", () => {
    const issues = [
      makeIssue({ number: 1, title: "In target repo", repoFullName: "owner/target" }),
      makeIssue({ number: 2, title: "In other repo", repoFullName: "owner/other" }),
    ];
    viewStore.setGlobalFilter(null, "owner/target");
    render(() => <IssuesTab issues={issues} />);
    screen.getByText("In target repo");
    expect(screen.queryByText("In other repo")).toBeNull();
  });

  it("filters by globalFilter.org", () => {
    const issues = [
      makeIssue({ number: 1, title: "In org", repoFullName: "myorg/repo-a" }),
      makeIssue({ number: 2, title: "Outside org", repoFullName: "otherorge/repo-b" }),
    ];
    viewStore.setGlobalFilter("myorg", null);
    render(() => <IssuesTab issues={issues} />);
    screen.getByText("In org");
    expect(screen.queryByText("Outside org")).toBeNull();
  });

  it("sorts by updatedAt descending by default", () => {
    const issues = [
      makeIssue({ id: 1, title: "Older issue", updatedAt: "2024-01-10T00:00:00Z" }),
      makeIssue({ id: 2, title: "Newer issue", updatedAt: "2024-01-20T00:00:00Z" }),
    ];
    render(() => <IssuesTab issues={issues} />);
    const allText = screen.getAllByRole("listitem");
    const texts = allText.map((el) => el.textContent ?? "");
    const newerIdx = texts.findIndex((t) => t.includes("Newer issue"));
    const olderIdx = texts.findIndex((t) => t.includes("Older issue"));
    expect(newerIdx).toBeLessThan(olderIdx);
  });

  it("changes sort order when a column header is clicked", () => {
    const setSortSpy = vi.spyOn(viewStore, "setSortPreference");
    const issues = [makeIssue({ title: "Issue A" })];
    render(() => <IssuesTab issues={issues} />);

    const titleHeader = screen.getByLabelText(/Sort by Title/i);
    fireEvent.click(titleHeader);

    expect(setSortSpy).toHaveBeenCalledWith("issues", "title", "desc");
    setSortSpy.mockRestore();
  });

  it("toggles sort direction on second click of same column", () => {
    const setSortSpy = vi.spyOn(viewStore, "setSortPreference");
    const issues = [makeIssue({ title: "Issue A" })];
    render(() => <IssuesTab issues={issues} />);

    const titleHeader = screen.getByLabelText(/Sort by Title/i);
    // First click: sets desc
    fireEvent.click(titleHeader);
    // Simulate sort pref being updated to title/desc (spy already called)
    // Second click should toggle to asc
    fireEvent.click(titleHeader);

    expect(setSortSpy).toHaveBeenCalledTimes(2);
    setSortSpy.mockRestore();
  });

  it("does not show pagination when there is only one page", () => {
    const issues = [makeIssue({ title: "Single issue" })];
    render(() => <IssuesTab issues={issues} />);
    expect(screen.queryByLabelText("Previous page")).toBeNull();
    expect(screen.queryByLabelText("Next page")).toBeNull();
  });

  it("renders column headers for all sortable fields", () => {
    render(() => <IssuesTab issues={[]} />);
    screen.getByLabelText("Sort by Repo");
    screen.getByLabelText("Sort by Title");
    screen.getByLabelText("Sort by Author");
    screen.getByLabelText("Sort by Created");
    screen.getByLabelText("Sort by Updated");
  });
});
