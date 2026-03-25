import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { createSignal } from "solid-js";
import PullRequestsTab from "../../src/app/components/dashboard/PullRequestsTab";
import type { PullRequest } from "../../src/app/services/api";
import * as viewStore from "../../src/app/stores/view";
import { makePullRequest, resetViewStore } from "../helpers/index";
import { updateConfig, resetConfig } from "../../src/app/stores/config";

beforeEach(() => {
  resetViewStore();
  resetConfig();
});

describe("PullRequestsTab", () => {
  it("renders a list of pull requests", async () => {
    const prs = [
      makePullRequest({ id: 1, number: 1, title: "First PR", repoFullName: "org/repo-a" }),
      makePullRequest({ id: 2, number: 2, title: "Second PR", repoFullName: "org/repo-a" }),
    ];
    render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);
    // First group auto-expands, so items are visible
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
      makePullRequest({ id: 1, number: 1, title: "In target repo", repoFullName: "owner/target" }),
      makePullRequest({ id: 2, number: 2, title: "In other repo", repoFullName: "owner/other" }),
    ];
    viewStore.setGlobalFilter(null, "owner/target");
    render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);
    screen.getByText("In target repo");
    expect(screen.queryByText("In other repo")).toBeNull();
  });

  it("filters by globalFilter.org", () => {
    const prs = [
      makePullRequest({ id: 1, number: 1, title: "In org", repoFullName: "myorg/repo-a" }),
      makePullRequest({ id: 2, number: 2, title: "Outside org", repoFullName: "otherorg/repo-b" }),
    ];
    viewStore.setGlobalFilter("myorg", null);
    render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);
    screen.getByText("In org");
    expect(screen.queryByText("Outside org")).toBeNull();
  });

  it("sorts by updatedAt descending by default", () => {
    const prs = [
      makePullRequest({ id: 1, title: "Older PR", updatedAt: "2024-01-10T00:00:00Z", repoFullName: "org/repo-a" }),
      makePullRequest({ id: 2, title: "Newer PR", updatedAt: "2024-01-20T00:00:00Z", repoFullName: "org/repo-a" }),
    ];
    render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);
    const items = screen.getAllByRole("listitem");
    const texts = items.map((el) => el.textContent ?? "");
    const newerIdx = texts.findIndex((t) => t.includes("Newer PR"));
    const olderIdx = texts.findIndex((t) => t.includes("Older PR"));
    expect(newerIdx).toBeLessThan(olderIdx);
  });

  it("renders SortDropdown with all sort options", () => {
    render(() => <PullRequestsTab pullRequests={[]} userLogin="" />);
    const dropdown = screen.getByLabelText("Sort by") as HTMLSelectElement;
    expect(dropdown).toBeDefined();
    // Check all sort fields appear as options
    const optionText = Array.from(dropdown.options).map((o) => o.text);
    expect(optionText.some((t) => t.includes("Repo"))).toBe(true);
    expect(optionText.some((t) => t.includes("Title"))).toBe(true);
    expect(optionText.some((t) => t.includes("Author"))).toBe(true);
    expect(optionText.some((t) => t.includes("Checks"))).toBe(true);
    expect(optionText.some((t) => t.includes("Review"))).toBe(true);
    expect(optionText.some((t) => t.includes("Size"))).toBe(true);
    expect(optionText.some((t) => t.includes("Created"))).toBe(true);
    expect(optionText.some((t) => t.includes("Updated"))).toBe(true);
  });

  it("changes sort when SortDropdown selection changes", async () => {
    const user = userEvent.setup();
    const setSortSpy = vi.spyOn(viewStore, "setSortPreference");
    const prs = [makePullRequest({ id: 1, title: "PR A", repoFullName: "org/repo-a" })];
    render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);

    const dropdown = screen.getByLabelText("Sort by");
    await user.selectOptions(dropdown, "title:desc");

    expect(setSortSpy).toHaveBeenCalledWith("pullRequests", "title", "desc");
    setSortSpy.mockRestore();
  });

  it("does not show pagination when there is only one page", () => {
    const prs = [makePullRequest({ title: "Single PR" })];
    render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);
    expect(screen.queryByLabelText("Previous page")).toBeNull();
    expect(screen.queryByLabelText("Next page")).toBeNull();
  });

  it("shows StatusDot for each PR's checkStatus when expanded", () => {
    const prs = [
      makePullRequest({ id: 1, title: "PR with status", checkStatus: "success", repoFullName: "org/repo-a" }),
    ];
    render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);
    // First group auto-expands, so StatusDot is visible
    screen.getByLabelText("All checks passed");
  });

  it("shows Draft badge for draft PRs when expanded", () => {
    const pr = makePullRequest({ id: 1, title: "Draft PR", draft: true, repoFullName: "org/repo-a" });
    render(() => <PullRequestsTab pullRequests={[pr]} userLogin="" />);
    // "Draft" appears in both the filter chip button and the PR badge (first group auto-expands)
    const draftEls = screen.getAllByText("Draft");
    // At least one is a span (the badge), not a button (the chip)
    const badgeEl = draftEls.find((el) => el.tagName.toLowerCase() === "span");
    expect(badgeEl).toBeDefined();
  });

  it("does not show Draft badge for non-draft PRs", () => {
    const pr = makePullRequest({ id: 1, title: "Normal PR", draft: false, repoFullName: "org/repo-a" });
    render(() => <PullRequestsTab pullRequests={[pr]} userLogin="" />);
    // "Draft" may appear as a filter chip button, but should NOT appear as a badge span
    const draftEls = screen.queryAllByText("Draft");
    const badgeEl = draftEls.find((el) => el.tagName.toLowerCase() === "span");
    expect(badgeEl).toBeUndefined();
  });

  it("shows Author role badge when userLogin matches PR author", () => {
    const pr = makePullRequest({ id: 1, title: "My PR", userLogin: "alice", reviewerLogins: [], assigneeLogins: [], repoFullName: "org/repo-a" });
    render(() => <PullRequestsTab pullRequests={[pr]} userLogin="alice" />);
    // "Author" appears in both the filter chip button and the role badge (first group auto-expands)
    const authorEls = screen.getAllByText("Author");
    const badgeEl = authorEls.find((el) => el.tagName.toLowerCase() === "span");
    expect(badgeEl).toBeDefined();
  });

  it("shows Reviewer role badge when userLogin is a reviewer", () => {
    const pr = makePullRequest({ id: 1, title: "Review PR", userLogin: "bob", reviewerLogins: ["alice"], assigneeLogins: [], repoFullName: "org/repo-a" });
    render(() => <PullRequestsTab pullRequests={[pr]} userLogin="alice" />);
    // "Reviewer" appears in both the filter chip button and the role badge (first group auto-expands)
    const reviewerEls = screen.getAllByText("Reviewer");
    const badgeEl = reviewerEls.find((el) => el.tagName.toLowerCase() === "span");
    expect(badgeEl).toBeDefined();
  });

  it("shows ReviewBadge for approved PRs when expanded", () => {
    const pr = makePullRequest({ id: 1, title: "Approved PR", reviewDecision: "APPROVED", repoFullName: "org/repo-a" });
    render(() => <PullRequestsTab pullRequests={[pr]} userLogin="" />);
    // "Approved" appears in both the filter chip button and the review badge (first group auto-expands)
    const approvedEls = screen.getAllByText("Approved");
    const badgeEl = approvedEls.find((el) => el.tagName.toLowerCase() === "span");
    expect(badgeEl).toBeDefined();
  });

  it("shows SizeBadge for each PR when expanded", () => {
    const pr = makePullRequest({ id: 1, title: "Big PR", additions: 300, deletions: 100, repoFullName: "org/repo-a" });
    render(() => <PullRequestsTab pullRequests={[pr]} userLogin="" />);
    // prSizeCategory(300, 100) = 400 total -> M (first group auto-expands)
    // "M" appears in both the filter chip button and the size badge
    const mEls = screen.getAllByText("M");
    const badgeEl = mEls.find((el) => el.tagName.toLowerCase() === "span");
    expect(badgeEl).toBeDefined();
  });

  it("filters by tab role filter", () => {
    const prs = [
      makePullRequest({ id: 1, title: "My PR", userLogin: "alice", reviewerLogins: [], assigneeLogins: [], repoFullName: "org/repo-a" }),
      makePullRequest({ id: 2, title: "Other PR", userLogin: "bob", reviewerLogins: [], assigneeLogins: [], repoFullName: "org/repo-a" }),
    ];
    viewStore.setTabFilter("pullRequests", "role", "author");
    render(() => <PullRequestsTab pullRequests={prs} userLogin="alice" />);
    screen.getByText("My PR");
    expect(screen.queryByText("Other PR")).toBeNull();
  });

  it("filters by reviewDecision tab filter", () => {
    const prs = [
      makePullRequest({ id: 1, title: "Approved PR", reviewDecision: "APPROVED", repoFullName: "org/repo-a" }),
      makePullRequest({ id: 2, title: "Pending PR", reviewDecision: null, repoFullName: "org/repo-a" }),
    ];
    viewStore.setTabFilter("pullRequests", "reviewDecision", "APPROVED");
    render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);
    screen.getByText("Approved PR");
    expect(screen.queryByText("Pending PR")).toBeNull();
  });

  it("filters by draft tab filter", () => {
    const prs = [
      makePullRequest({ id: 1, title: "Draft PR", draft: true, repoFullName: "org/repo-a" }),
      makePullRequest({ id: 2, title: "Ready PR", draft: false, repoFullName: "org/repo-a" }),
    ];
    viewStore.setTabFilter("pullRequests", "draft", "draft");
    render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);
    screen.getByText("Draft PR");
    expect(screen.queryByText("Ready PR")).toBeNull();
  });

  it("filters by checkStatus tab filter", () => {
    const prs = [
      makePullRequest({ id: 1, title: "Passing PR", checkStatus: "success", repoFullName: "org/repo-a" }),
      makePullRequest({ id: 2, title: "Failing PR", checkStatus: "failure", repoFullName: "org/repo-a" }),
    ];
    viewStore.setTabFilter("pullRequests", "checkStatus", "success");
    render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);
    screen.getByText("Passing PR");
    expect(screen.queryByText("Failing PR")).toBeNull();
  });

  it("filters by checkStatus 'none' for PRs without CI", () => {
    const prs = [
      makePullRequest({ id: 1, title: "No CI PR", checkStatus: null, repoFullName: "org/repo-a" }),
      makePullRequest({ id: 2, title: "Has CI PR", checkStatus: "success", repoFullName: "org/repo-a" }),
    ];
    viewStore.setTabFilter("pullRequests", "checkStatus", "none");
    render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);
    screen.getByText("No CI PR");
    expect(screen.queryByText("Has CI PR")).toBeNull();
  });

  it("filters by sizeCategory tab filter", () => {
    const prs = [
      makePullRequest({ id: 1, title: "Small PR", additions: 5, deletions: 2, repoFullName: "org/repo-a" }),
      makePullRequest({ id: 2, title: "Large PR", additions: 600, deletions: 200, repoFullName: "org/repo-a" }),
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
    // First group (repo-a) is auto-expanded
    screen.getByText("PR in repo A");
    screen.getByText("Another in repo A");
    // repo-b is collapsed, so its PR is not visible
    expect(screen.queryByText("PR in repo B")).toBeNull();
  });

  it("auto-expands first repo group on initial mount", () => {
    const prs = [
      makePullRequest({ id: 1, title: "First Repo PR", repoFullName: "org/repo-a" }),
      makePullRequest({ id: 2, title: "Second Repo PR", repoFullName: "org/repo-b" }),
    ];
    render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);
    // First group is auto-expanded
    screen.getByText("First Repo PR");
    // Second group is collapsed
    expect(screen.queryByText("Second Repo PR")).toBeNull();
    // First group header has aria-expanded=true
    const firstHeader = screen.getByText("org/repo-a").closest("button")!;
    expect(firstHeader.getAttribute("aria-expanded")).toBe("true");
  });

  it("collapses a repo group when header is clicked", async () => {
    const user = userEvent.setup();
    const prs = [
      makePullRequest({ id: 1, title: "Visible PR", repoFullName: "org/repo-a" }),
    ];
    render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);
    // First group auto-expands
    screen.getByText("Visible PR");

    const repoHeader = screen.getByText("org/repo-a");
    await user.click(repoHeader);

    expect(screen.queryByText("Visible PR")).toBeNull();
  });

  it("expands a collapsed repo group when header is clicked", async () => {
    const user = userEvent.setup();
    const prs = [
      makePullRequest({ id: 1, title: "First Repo PR", repoFullName: "org/repo-a" }),
      makePullRequest({ id: 2, title: "Second Repo PR", repoFullName: "org/repo-b" }),
    ];
    render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);
    // Second group starts collapsed
    expect(screen.queryByText("Second Repo PR")).toBeNull();

    const repoHeader = screen.getByText("org/repo-b");
    await user.click(repoHeader);

    screen.getByText("Second Repo PR");
  });

  it("sets aria-expanded=true on first repo group header by default", () => {
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

  it("shows collapsed summary with PR count when group is collapsed", async () => {
    const user = userEvent.setup();
    const prs = [
      makePullRequest({ id: 1, title: "PR One", repoFullName: "org/repo-a" }),
      makePullRequest({ id: 2, title: "PR Two", repoFullName: "org/repo-a" }),
    ];
    render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);
    // Collapse the first group
    const header = screen.getByText("org/repo-a").closest("button")!;
    await user.click(header);

    // Summary should show count
    screen.getByText("2 PRs");
  });

  it("shows check status dots in collapsed summary", async () => {
    const user = userEvent.setup();
    const prs = [
      makePullRequest({ id: 1, title: "PR One", checkStatus: "success", repoFullName: "org/repo-a" }),
      makePullRequest({ id: 2, title: "PR Two", checkStatus: "failure", repoFullName: "org/repo-a" }),
    ];
    render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);
    // Collapse the first group
    const header = screen.getByText("org/repo-a").closest("button")!;
    await user.click(header);

    // Check success count (1) and failure count (1) shown as text
    const summarySpan = header.querySelector(".ml-auto")!;
    expect(summarySpan.textContent).toContain("1");
  });

  it("shows review state badges in collapsed summary", async () => {
    const user = userEvent.setup();
    const prs = [
      makePullRequest({ id: 1, title: "PR One", reviewDecision: "APPROVED", repoFullName: "org/repo-a" }),
      makePullRequest({ id: 2, title: "PR Two", reviewDecision: "CHANGES_REQUESTED", repoFullName: "org/repo-a" }),
    ];
    render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);
    // Collapse the first group
    const header = screen.getByText("org/repo-a").closest("button")!;
    await user.click(header);

    screen.getByText("Approved x1");
    screen.getByText("Changes x1");
  });

  it("shows role badges in collapsed summary", async () => {
    const user = userEvent.setup();
    const prs = [
      makePullRequest({ id: 1, title: "My PR", userLogin: "alice", reviewerLogins: [], assigneeLogins: [], repoFullName: "org/repo-a" }),
    ];
    render(() => <PullRequestsTab pullRequests={prs} userLogin="alice" />);
    // Collapse the first group
    const header = screen.getByText("org/repo-a").closest("button")!;
    await user.click(header);

    screen.getByText("author x1");
  });

  it("hides summary metadata when group is expanded", () => {
    const prs = [
      makePullRequest({ id: 1, title: "PR One", repoFullName: "org/repo-a" }),
    ];
    render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);
    // First group is auto-expanded — no summary count shown
    expect(screen.queryByText("1 PR")).toBeNull();
  });

  it("renders IgnoreBadge in filter toolbar", () => {
    const pr = makePullRequest({ id: 42, title: "To Ignore", repoFullName: "org/repo-a" });
    viewStore.ignoreItem({
      id: "42",
      type: "pullRequest",
      repo: pr.repoFullName,
      title: pr.title,
      ignoredAt: Date.now(),
    });
    render(() => <PullRequestsTab pullRequests={[]} userLogin="" />);
    // IgnoreBadge shows ignored count
    screen.getByText(/1 ignored/i);
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

  it("resets page when data shrinks below current page", async () => {
    const user = userEvent.setup();
    updateConfig({ itemsPerPage: 10 });
    const repoAPrs = Array.from({ length: 6 }, (_, i) =>
      makePullRequest({ id: 100 + i, title: `Repo A PR ${i}`, repoFullName: "org/repo-a" })
    );
    const repoBPrs = Array.from({ length: 6 }, (_, i) =>
      makePullRequest({ id: 200 + i, title: `Repo B PR ${i}`, repoFullName: "org/repo-b" })
    );
    const [prs, setPrs] = createSignal<PullRequest[]>([...repoAPrs, ...repoBPrs]);
    render(() => <PullRequestsTab pullRequests={prs()} userLogin="" />);

    // Navigate to page 2
    screen.getByText(/Page 1 of 2/);
    await user.click(screen.getByLabelText("Next page"));
    screen.getByText(/Page 2 of 2/);
    screen.getByText("org/repo-b");

    // Shrink data to fit on 1 page — page should reset
    setPrs(repoAPrs);
    expect(screen.queryByLabelText("Next page")).toBeNull();
    screen.getByText("org/repo-a");
    screen.getByText("Repo A PR 0");
  });
});
