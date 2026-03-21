import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import PullRequestsTab from "../../src/app/components/dashboard/PullRequestsTab";
import type { ApiError } from "../../src/app/services/api";
import * as viewStore from "../../src/app/stores/view";
import { makePullRequest } from "../helpers/index";

beforeEach(() => {
  viewStore.updateViewState({
    globalFilter: { org: null, repo: null },
    sortPreferences: {},
    ignoredItems: [],
  });
});

describe("PullRequestsTab", () => {
  it("renders a list of pull requests", () => {
    const prs = [
      makePullRequest({ number: 1, title: "First PR" }),
      makePullRequest({ number: 2, title: "Second PR" }),
    ];
    render(() => <PullRequestsTab pullRequests={prs} />);
    screen.getByText("First PR");
    screen.getByText("Second PR");
  });

  it("shows empty state when pull requests array is empty", () => {
    render(() => <PullRequestsTab pullRequests={[]} />);
    screen.getByText(/No open pull requests involving you/i);
  });

  it("shows loading skeleton when loading=true", () => {
    render(() => <PullRequestsTab pullRequests={[]} loading={true} />);
    const status = screen.getByRole("status");
    expect(status).toBeDefined();
    expect(screen.queryByText(/No open pull requests/i)).toBeNull();
  });

  it("shows error banners for each ApiError", () => {
    const errors: ApiError[] = [
      { repo: "owner/repo", statusCode: 500, message: "Server error", retryable: true },
      { repo: "owner/other", statusCode: 403, message: "Forbidden", retryable: false },
    ];
    render(() => <PullRequestsTab pullRequests={[]} errors={errors} />);
    screen.getByText(/Server error/i);
    screen.getByText(/Forbidden/i);
  });

  it("shows '(will retry)' for retryable errors", () => {
    const errors: ApiError[] = [
      { repo: "owner/repo", statusCode: 500, message: "Server error", retryable: true },
    ];
    render(() => <PullRequestsTab pullRequests={[]} errors={errors} />);
    screen.getByText(/will retry/i);
  });

  it("filters out ignored PRs", () => {
    const pr = makePullRequest({ id: 99, title: "Should be hidden" });
    viewStore.ignoreItem({
      id: "99",
      type: "pullRequest",
      repo: pr.repoFullName,
      title: pr.title,
      ignoredAt: Date.now(),
    });
    render(() => <PullRequestsTab pullRequests={[pr]} />);
    expect(screen.queryByText("Should be hidden")).toBeNull();
    screen.getByText(/No open pull requests/i);
  });

  it("filters by globalFilter.repo", () => {
    const prs = [
      makePullRequest({ number: 1, title: "In target repo", repoFullName: "owner/target" }),
      makePullRequest({ number: 2, title: "In other repo", repoFullName: "owner/other" }),
    ];
    viewStore.setGlobalFilter(null, "owner/target");
    render(() => <PullRequestsTab pullRequests={prs} />);
    screen.getByText("In target repo");
    expect(screen.queryByText("In other repo")).toBeNull();
  });

  it("filters by globalFilter.org", () => {
    const prs = [
      makePullRequest({ number: 1, title: "In org", repoFullName: "myorg/repo-a" }),
      makePullRequest({ number: 2, title: "Outside org", repoFullName: "otherorge/repo-b" }),
    ];
    viewStore.setGlobalFilter("myorg", null);
    render(() => <PullRequestsTab pullRequests={prs} />);
    screen.getByText("In org");
    expect(screen.queryByText("Outside org")).toBeNull();
  });

  it("sorts by updatedAt descending by default", () => {
    const prs = [
      makePullRequest({ id: 1, title: "Older PR", updatedAt: "2024-01-10T00:00:00Z" }),
      makePullRequest({ id: 2, title: "Newer PR", updatedAt: "2024-01-20T00:00:00Z" }),
    ];
    render(() => <PullRequestsTab pullRequests={prs} />);
    const items = screen.getAllByRole("listitem");
    const texts = items.map((el) => el.textContent ?? "");
    const newerIdx = texts.findIndex((t) => t.includes("Newer PR"));
    const olderIdx = texts.findIndex((t) => t.includes("Older PR"));
    expect(newerIdx).toBeLessThan(olderIdx);
  });

  it("changes sort when column header clicked", () => {
    const setSortSpy = vi.spyOn(viewStore, "setSortPreference");
    const prs = [makePullRequest({ title: "PR A" })];
    render(() => <PullRequestsTab pullRequests={prs} />);

    const titleHeader = screen.getByLabelText(/Sort by Title/i);
    fireEvent.click(titleHeader);

    expect(setSortSpy).toHaveBeenCalledWith("pullRequests", "title", "desc");
    setSortSpy.mockRestore();
  });

  it("renders column headers for all sortable fields", () => {
    render(() => <PullRequestsTab pullRequests={[]} />);
    screen.getByLabelText("Sort by Repo");
    screen.getByLabelText("Sort by Title");
    screen.getByLabelText("Sort by Author");
    screen.getByLabelText("Sort by Checks");
    screen.getByLabelText("Sort by Created");
    screen.getByLabelText("Sort by Updated");
  });

  it("does not show pagination when there is only one page", () => {
    const prs = [makePullRequest({ title: "Single PR" })];
    render(() => <PullRequestsTab pullRequests={prs} />);
    expect(screen.queryByLabelText("Previous page")).toBeNull();
    expect(screen.queryByLabelText("Next page")).toBeNull();
  });

  it("shows StatusDot for each PR's checkStatus", () => {
    const prs = [
      makePullRequest({ id: 1, title: "PR with status", checkStatus: "success" }),
    ];
    render(() => <PullRequestsTab pullRequests={prs} />);
    // StatusDot renders a <span> with aria-label matching the check status label
    screen.getByLabelText("All checks passed");
  });

  it("shows Draft badge for draft PRs", () => {
    const pr = makePullRequest({ title: "Draft PR", draft: true });
    render(() => <PullRequestsTab pullRequests={[pr]} />);
    screen.getByText("Draft");
  });

  it("does not show Draft badge for non-draft PRs", () => {
    const pr = makePullRequest({ title: "Normal PR", draft: false });
    render(() => <PullRequestsTab pullRequests={[pr]} />);
    expect(screen.queryByText("Draft")).toBeNull();
  });

  it("shows reviewers when reviewerLogins non-empty", () => {
    const pr = makePullRequest({
      title: "PR with reviewers",
      reviewerLogins: ["alice", "bob"],
    });
    render(() => <PullRequestsTab pullRequests={[pr]} />);
    screen.getByText(/Reviewers:/i);
    screen.getByText(/alice/);
    screen.getByText(/bob/);
  });

  it("does not show reviewers section when reviewerLogins is empty", () => {
    const pr = makePullRequest({ title: "PR no reviewers", reviewerLogins: [] });
    render(() => <PullRequestsTab pullRequests={[pr]} />);
    expect(screen.queryByText(/Reviewers:/i)).toBeNull();
  });
});
