import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import PullRequestsTab from "../../src/app/components/dashboard/PullRequestsTab";
import type { ApiError } from "../../src/app/services/api";
import * as viewStore from "../../src/app/stores/view";
import { makePullRequest, resetViewStore } from "../helpers/index";
import { updateConfig, resetConfig } from "../../src/app/stores/config";

beforeEach(() => {
  resetViewStore();
  resetConfig();
});

describe("PullRequestsTab", () => {
  it("renders a list of pull requests", () => {
    const prs = [
      makePullRequest({ number: 1, title: "First PR" }),
      makePullRequest({ number: 2, title: "Second PR" }),
    ];
    render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);
    screen.getByText("First PR");
    screen.getByText("Second PR");
  });

  it("shows empty state when pull requests array is empty", () => {
    render(() => <PullRequestsTab pullRequests={[]} userLogin="" />);
    screen.getByText(/No open pull requests involving you/i);
  });

  it("shows loading skeleton when loading=true", () => {
    render(() => <PullRequestsTab pullRequests={[]} loading={true} userLogin="" />);
    const status = screen.getByRole("status");
    expect(status).toBeDefined();
    expect(screen.queryByText(/No open pull requests/i)).toBeNull();
  });

  it("shows error banners for each ApiError", () => {
    const errors: ApiError[] = [
      { repo: "owner/repo", statusCode: 500, message: "Server error", retryable: true },
      { repo: "owner/other", statusCode: 403, message: "Forbidden", retryable: false },
    ];
    render(() => <PullRequestsTab pullRequests={[]} errors={errors} userLogin="" />);
    screen.getByText(/Server error/i);
    screen.getByText(/Forbidden/i);
  });

  it("shows '(will retry)' for retryable errors", () => {
    const errors: ApiError[] = [
      { repo: "owner/repo", statusCode: 500, message: "Server error", retryable: true },
    ];
    render(() => <PullRequestsTab pullRequests={[]} errors={errors} userLogin="" />);
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
    render(() => <PullRequestsTab pullRequests={[pr]} userLogin="" />);
    expect(screen.queryByText("Should be hidden")).toBeNull();
    screen.getByText(/No open pull requests/i);
  });

  it("filters by globalFilter.repo", () => {
    const prs = [
      makePullRequest({ number: 1, title: "In target repo", repoFullName: "owner/target" }),
      makePullRequest({ number: 2, title: "In other repo", repoFullName: "owner/other" }),
    ];
    viewStore.setGlobalFilter(null, "owner/target");
    render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);
    screen.getByText("In target repo");
    expect(screen.queryByText("In other repo")).toBeNull();
  });

  it("filters by globalFilter.org", () => {
    const prs = [
      makePullRequest({ number: 1, title: "In org", repoFullName: "myorg/repo-a" }),
      makePullRequest({ number: 2, title: "Outside org", repoFullName: "otherorg/repo-b" }),
    ];
    viewStore.setGlobalFilter("myorg", null);
    render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);
    screen.getByText("In org");
    expect(screen.queryByText("Outside org")).toBeNull();
  });

  it("sorts by updatedAt descending by default", () => {
    const prs = [
      makePullRequest({ id: 1, title: "Older PR", updatedAt: "2024-01-10T00:00:00Z" }),
      makePullRequest({ id: 2, title: "Newer PR", updatedAt: "2024-01-20T00:00:00Z" }),
    ];
    render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);
    const items = screen.getAllByRole("listitem");
    const texts = items.map((el) => el.textContent ?? "");
    const newerIdx = texts.findIndex((t) => t.includes("Newer PR"));
    const olderIdx = texts.findIndex((t) => t.includes("Older PR"));
    expect(newerIdx).toBeLessThan(olderIdx);
  });

  it("changes sort when column header clicked", async () => {
    const user = userEvent.setup();
    const setSortSpy = vi.spyOn(viewStore, "setSortPreference");
    const prs = [makePullRequest({ title: "PR A" })];
    render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);

    const titleHeader = screen.getByLabelText(/Sort by Title/i);
    await user.click(titleHeader);

    expect(setSortSpy).toHaveBeenCalledWith("pullRequests", "title", "desc");
    setSortSpy.mockRestore();
  });

  it("renders column headers for all sortable fields", () => {
    render(() => <PullRequestsTab pullRequests={[]} userLogin="" />);
    screen.getByLabelText("Sort by Repo");
    screen.getByLabelText("Sort by Title");
    screen.getByLabelText("Sort by Author");
    screen.getByLabelText("Sort by Checks");
    screen.getByLabelText("Sort by Review");
    screen.getByLabelText("Sort by Size");
    screen.getByLabelText("Sort by Created");
    screen.getByLabelText("Sort by Updated");
  });

  it("does not show pagination when there is only one page", () => {
    const prs = [makePullRequest({ title: "Single PR" })];
    render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);
    expect(screen.queryByLabelText("Previous page")).toBeNull();
    expect(screen.queryByLabelText("Next page")).toBeNull();
  });

  it("shows StatusDot for each PR's checkStatus", () => {
    const prs = [
      makePullRequest({ id: 1, title: "PR with status", checkStatus: "success" }),
    ];
    render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);
    // StatusDot renders a <span> with aria-label matching the check status label
    screen.getByLabelText("All checks passed");
  });

  it("shows Draft badge for draft PRs", () => {
    const pr = makePullRequest({ title: "Draft PR", draft: true });
    render(() => <PullRequestsTab pullRequests={[pr]} userLogin="" />);
    // "Draft" appears in both the filter chip button and the PR badge
    const draftEls = screen.getAllByText("Draft");
    // At least one is a span (the badge), not a button (the chip)
    const badgeEl = draftEls.find((el) => el.tagName.toLowerCase() === "span");
    expect(badgeEl).toBeDefined();
  });

  it("does not show Draft badge for non-draft PRs", () => {
    const pr = makePullRequest({ title: "Normal PR", draft: false });
    render(() => <PullRequestsTab pullRequests={[pr]} userLogin="" />);
    // "Draft" may appear as a filter chip button, but should NOT appear as a badge span
    const draftEls = screen.queryAllByText("Draft");
    const badgeEl = draftEls.find((el) => el.tagName.toLowerCase() === "span");
    expect(badgeEl).toBeUndefined();
  });

  it("shows Author role badge when userLogin matches PR author", () => {
    const pr = makePullRequest({ title: "My PR", userLogin: "alice", reviewerLogins: [], assigneeLogins: [] });
    render(() => <PullRequestsTab pullRequests={[pr]} userLogin="alice" />);
    // "Author" appears in both the filter chip button and the role badge
    const authorEls = screen.getAllByText("Author");
    const badgeEl = authorEls.find((el) => el.tagName.toLowerCase() === "span");
    expect(badgeEl).toBeDefined();
  });

  it("shows Reviewer role badge when userLogin is a reviewer", () => {
    const pr = makePullRequest({ title: "Review PR", userLogin: "bob", reviewerLogins: ["alice"], assigneeLogins: [] });
    render(() => <PullRequestsTab pullRequests={[pr]} userLogin="alice" />);
    // "Reviewer" appears in both the filter chip button and the role badge
    const reviewerEls = screen.getAllByText("Reviewer");
    const badgeEl = reviewerEls.find((el) => el.tagName.toLowerCase() === "span");
    expect(badgeEl).toBeDefined();
  });

  it("shows ReviewBadge for approved PRs", () => {
    const pr = makePullRequest({ title: "Approved PR", reviewDecision: "APPROVED" });
    render(() => <PullRequestsTab pullRequests={[pr]} userLogin="" />);
    // "Approved" appears in both the filter chip button and the review badge
    const approvedEls = screen.getAllByText("Approved");
    const badgeEl = approvedEls.find((el) => el.tagName.toLowerCase() === "span");
    expect(badgeEl).toBeDefined();
  });

  it("shows SizeBadge for each PR", () => {
    const pr = makePullRequest({ title: "Big PR", additions: 300, deletions: 100 });
    render(() => <PullRequestsTab pullRequests={[pr]} userLogin="" />);
    // prSizeCategory(300, 100) = 400 total -> M
    // "M" appears in both the filter chip button and the size badge
    const mEls = screen.getAllByText("M");
    const badgeEl = mEls.find((el) => el.tagName.toLowerCase() === "span");
    expect(badgeEl).toBeDefined();
  });

  it("filters by tab role filter", () => {
    const prs = [
      makePullRequest({ id: 1, title: "My PR", userLogin: "alice", reviewerLogins: [], assigneeLogins: [] }),
      makePullRequest({ id: 2, title: "Other PR", userLogin: "bob", reviewerLogins: [], assigneeLogins: [] }),
    ];
    viewStore.setTabFilter("pullRequests", "role", "author");
    render(() => <PullRequestsTab pullRequests={prs} userLogin="alice" />);
    screen.getByText("My PR");
    expect(screen.queryByText("Other PR")).toBeNull();
  });

  it("filters by reviewDecision tab filter", () => {
    const prs = [
      makePullRequest({ id: 1, title: "Approved PR", reviewDecision: "APPROVED" }),
      makePullRequest({ id: 2, title: "Pending PR", reviewDecision: null }),
    ];
    viewStore.setTabFilter("pullRequests", "reviewDecision", "APPROVED");
    render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);
    screen.getByText("Approved PR");
    expect(screen.queryByText("Pending PR")).toBeNull();
  });

  it("filters by draft tab filter", () => {
    const prs = [
      makePullRequest({ id: 1, title: "Draft PR", draft: true }),
      makePullRequest({ id: 2, title: "Ready PR", draft: false }),
    ];
    viewStore.setTabFilter("pullRequests", "draft", "draft");
    render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);
    screen.getByText("Draft PR");
    expect(screen.queryByText("Ready PR")).toBeNull();
  });

  it("filters by checkStatus tab filter", () => {
    const prs = [
      makePullRequest({ id: 1, title: "Passing PR", checkStatus: "success" }),
      makePullRequest({ id: 2, title: "Failing PR", checkStatus: "failure" }),
    ];
    viewStore.setTabFilter("pullRequests", "checkStatus", "success");
    render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);
    screen.getByText("Passing PR");
    expect(screen.queryByText("Failing PR")).toBeNull();
  });

  it("filters by checkStatus 'none' for PRs without CI", () => {
    const prs = [
      makePullRequest({ id: 1, title: "No CI PR", checkStatus: null }),
      makePullRequest({ id: 2, title: "Has CI PR", checkStatus: "success" }),
    ];
    viewStore.setTabFilter("pullRequests", "checkStatus", "none");
    render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);
    screen.getByText("No CI PR");
    expect(screen.queryByText("Has CI PR")).toBeNull();
  });

  it("filters by sizeCategory tab filter", () => {
    const prs = [
      makePullRequest({ id: 1, title: "Small PR", additions: 5, deletions: 2 }),
      makePullRequest({ id: 2, title: "Large PR", additions: 600, deletions: 200 }),
    ];
    viewStore.setTabFilter("pullRequests", "sizeCategory", "XS");
    render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);
    screen.getByText("Small PR");
    expect(screen.queryByText("Large PR")).toBeNull();
  });

  it("groups PRs by repo with collapsible headers", () => {
    const prs = [
      makePullRequest({ id: 1, title: "PR in repo A", repoFullName: "org/repo-a" }),
      makePullRequest({ id: 2, title: "PR in repo B", repoFullName: "org/repo-b" }),
      makePullRequest({ id: 3, title: "Another in repo A", repoFullName: "org/repo-a" }),
    ];
    render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);
    screen.getByText("org/repo-a");
    screen.getByText("org/repo-b");
    screen.getByText("PR in repo A");
    screen.getByText("Another in repo A");
    screen.getByText("PR in repo B");
  });

  it("collapses a repo group when header is clicked", async () => {
    const user = userEvent.setup();
    const prs = [
      makePullRequest({ id: 1, title: "Visible PR", repoFullName: "org/repo-a" }),
      makePullRequest({ id: 2, title: "Other repo PR", repoFullName: "org/repo-b" }),
    ];
    render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);
    screen.getByText("Visible PR");

    const repoHeader = screen.getByText("org/repo-a");
    await user.click(repoHeader);

    expect(screen.queryByText("Visible PR")).toBeNull();
    screen.getByText("Other repo PR");
  });

  it("sets aria-expanded on repo group headers", () => {
    const prs = [
      makePullRequest({ id: 1, title: "Test PR", repoFullName: "org/repo-a" }),
    ];
    render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);
    const header = screen.getByText("org/repo-a").closest("button")!;
    expect(header.getAttribute("aria-expanded")).toBe("true");
  });

  it("toggles aria-expanded to false on collapse and back to true on re-expand", async () => {
    const user = userEvent.setup();
    const prs = [
      makePullRequest({ id: 1, title: "Toggle PR", repoFullName: "org/repo-a" }),
    ];
    render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);
    const header = screen.getByText("org/repo-a").closest("button")!;

    expect(header.getAttribute("aria-expanded")).toBe("true");
    await user.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Toggle PR")).toBeNull();

    await user.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");
    screen.getByText("Toggle PR");
  });

  it("paginates repo groups across pages", async () => {
    const user = userEvent.setup();
    updateConfig({ itemsPerPage: 10 });
    const prs = [
      ...Array.from({ length: 6 }, (_, i) =>
        makePullRequest({ id: 100 + i, title: `Repo A PR ${i}`, repoFullName: "org/repo-a" })
      ),
      ...Array.from({ length: 6 }, (_, i) =>
        makePullRequest({ id: 200 + i, title: `Repo B PR ${i}`, repoFullName: "org/repo-b" })
      ),
    ];
    render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);
    screen.getByText("org/repo-a");
    screen.getByText(/Page 1 of 2/);
    expect(screen.queryByText("org/repo-b")).toBeNull();

    const nextBtn = screen.getByLabelText("Next page");
    await user.click(nextBtn);
    screen.getByText("org/repo-b");
    screen.getByText(/Page 2 of 2/);
  });

  it("keeps a large single-repo group on one page without splitting", () => {
    updateConfig({ itemsPerPage: 10 });
    const prs = Array.from({ length: 15 }, (_, i) =>
      makePullRequest({ id: 300 + i, title: `Big repo PR ${i}`, repoFullName: "org/big-repo" })
    );
    render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);
    screen.getByText("org/big-repo");
    screen.getByText("Big repo PR 0");
    screen.getByText("Big repo PR 14");
    expect(screen.queryByLabelText("Next page")).toBeNull();
  });
});
