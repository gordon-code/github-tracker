import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { createSignal } from "solid-js";
import PullRequestsTab from "../../src/app/components/dashboard/PullRequestsTab";
import type { PullRequest } from "../../src/app/services/api";
import * as viewStore from "../../src/app/stores/view";
import { setAllExpanded } from "../../src/app/stores/view";
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
    setAllExpanded("pullRequests", ["org/repo-a"], true);
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

  it("filters out ignored PRs", () => {
    const pr = makePullRequest({ id: 99, title: "Should be hidden" });
    viewStore.ignoreItem({
      id: 99,
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
    setAllExpanded("pullRequests", ["owner/target"], true);
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
    setAllExpanded("pullRequests", ["myorg/repo-a"], true);
    render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);
    screen.getByText("In org");
    expect(screen.queryByText("Outside org")).toBeNull();
  });

  it("sorts by updatedAt descending by default", () => {
    const prs = [
      makePullRequest({ id: 1, title: "Older PR", updatedAt: "2024-01-10T00:00:00Z", repoFullName: "org/repo-a" }),
      makePullRequest({ id: 2, title: "Newer PR", updatedAt: "2024-01-20T00:00:00Z", repoFullName: "org/repo-a" }),
    ];
    setAllExpanded("pullRequests", ["org/repo-a"], true);
    render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);
    const items = screen.getAllByRole("listitem");
    const texts = items.map((el) => el.textContent ?? "");
    const newerIdx = texts.findIndex((t) => t.includes("Newer PR"));
    const olderIdx = texts.findIndex((t) => t.includes("Older PR"));
    expect(newerIdx).toBeLessThan(olderIdx);
  });

  it("SortDropdown is not rendered in the tab toolbar (moved to FilterBar)", () => {
    render(() => <PullRequestsTab pullRequests={[]} userLogin="" />);
    // SortDropdown was moved to FilterBar; not rendered in tab isolation
    expect(screen.queryByRole("button", { name: /Sort by/ })).toBeNull();
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
    setAllExpanded("pullRequests", ["org/repo-a"], true);
    render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);
    screen.getByLabelText("All checks passed");
  });

  it("shows Draft badge for draft PRs when expanded", () => {
    const pr = makePullRequest({ id: 1, title: "Draft PR", draft: true, repoFullName: "org/repo-a" });
    setAllExpanded("pullRequests", ["org/repo-a"], true);
    render(() => <PullRequestsTab pullRequests={[pr]} userLogin="" />);
    // "Draft" appears as a PR badge
    const draftEls = screen.getAllByText("Draft");
    // Badge should be a span element
    const badgeEl = draftEls.find((el) => el.tagName.toLowerCase() === "span");
    expect(badgeEl).toBeDefined();
  });

  it("does not show Draft badge for non-draft PRs", () => {
    const pr = makePullRequest({ id: 1, title: "Normal PR", draft: false, repoFullName: "org/repo-a" });
    render(() => <PullRequestsTab pullRequests={[pr]} userLogin="" />);
    // "Draft" should NOT appear as a badge span for non-draft PRs
    const draftEls = screen.queryAllByText("Draft");
    const badgeEl = draftEls.find((el) => el.tagName.toLowerCase() === "span");
    expect(badgeEl).toBeUndefined();
  });

  it("shows Author role badge when userLogin matches PR author", () => {
    const pr = makePullRequest({ id: 1, title: "My PR", userLogin: "alice", reviewerLogins: [], assigneeLogins: [], repoFullName: "org/repo-a" });
    setAllExpanded("pullRequests", ["org/repo-a"], true);
    render(() => <PullRequestsTab pullRequests={[pr]} userLogin="alice" />);
    // "Author" appears as a role badge
    const authorEls = screen.getAllByText("Author");
    const badgeEl = authorEls.find((el) => el.tagName.toLowerCase() === "span");
    expect(badgeEl).toBeDefined();
  });

  it("shows Reviewer role badge when userLogin is a reviewer", () => {
    const pr = makePullRequest({ id: 1, title: "Review PR", userLogin: "bob", reviewerLogins: ["alice"], assigneeLogins: [], repoFullName: "org/repo-a" });
    setAllExpanded("pullRequests", ["org/repo-a"], true);
    render(() => <PullRequestsTab pullRequests={[pr]} userLogin="alice" />);
    // "Reviewer" appears as a role badge
    const reviewerEls = screen.getAllByText("Reviewer");
    const badgeEl = reviewerEls.find((el) => el.tagName.toLowerCase() === "span");
    expect(badgeEl).toBeDefined();
  });

  it("shows ReviewBadge for approved PRs when expanded", () => {
    const pr = makePullRequest({ id: 1, title: "Approved PR", reviewDecision: "APPROVED", repoFullName: "org/repo-a" });
    setAllExpanded("pullRequests", ["org/repo-a"], true);
    render(() => <PullRequestsTab pullRequests={[pr]} userLogin="" />);
    // "Approved" appears as a review badge
    const approvedEls = screen.getAllByText("Approved");
    const badgeEl = approvedEls.find((el) => el.tagName.toLowerCase() === "span");
    expect(badgeEl).toBeDefined();
  });

  it("shows SizeBadge for each PR when expanded", () => {
    const pr = makePullRequest({ id: 1, title: "Big PR", additions: 300, deletions: 100, repoFullName: "org/repo-a" });
    setAllExpanded("pullRequests", ["org/repo-a"], true);
    render(() => <PullRequestsTab pullRequests={[pr]} userLogin="" />);
    // prSizeCategory(300, 100) = 400 total -> L
    const lEls = screen.getAllByText("L");
    const badgeEl = lEls.find((el) => el.tagName.toLowerCase() === "span");
    expect(badgeEl).toBeDefined();
  });

  it("filters by tab role filter", () => {
    const prs = [
      makePullRequest({ id: 1, title: "My PR", userLogin: "alice", reviewerLogins: [], assigneeLogins: [], repoFullName: "org/repo-a" }),
      makePullRequest({ id: 2, title: "Other PR", userLogin: "bob", reviewerLogins: [], assigneeLogins: [], repoFullName: "org/repo-a" }),
    ];
    viewStore.setTabFilter("pullRequests", "role", "author");
    setAllExpanded("pullRequests", ["org/repo-a"], true);
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
    setAllExpanded("pullRequests", ["org/repo-a"], true);
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
    setAllExpanded("pullRequests", ["org/repo-a"], true);
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
    setAllExpanded("pullRequests", ["org/repo-a"], true);
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
    setAllExpanded("pullRequests", ["org/repo-a"], true);
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
    setAllExpanded("pullRequests", ["org/repo-a"], true);
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
    setAllExpanded("pullRequests", ["org/repo-a"], true);
    render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);
    screen.getByText("org/repo-a");
    screen.getByText("org/repo-b");
    // repo-a is expanded
    screen.getByText("PR in repo A");
    screen.getByText("Another in repo A");
    // repo-b is collapsed, so its PR is not visible
    expect(screen.queryByText("PR in repo B")).toBeNull();
  });

  it("all repo groups start collapsed on initial mount", () => {
    const prs = [
      makePullRequest({ id: 1, title: "First Repo PR", repoFullName: "org/repo-a" }),
      makePullRequest({ id: 2, title: "Second Repo PR", repoFullName: "org/repo-b" }),
    ];
    render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);
    // Both groups should start collapsed
    expect(screen.queryByText("First Repo PR")).toBeNull();
    expect(screen.queryByText("Second Repo PR")).toBeNull();
    // Repo headers are still visible
    screen.getByText("org/repo-a");
    screen.getByText("org/repo-b");
    // Both headers have aria-expanded=false
    const firstHeader = screen.getByText("org/repo-a").closest("button")!;
    expect(firstHeader.getAttribute("aria-expanded")).toBe("false");
  });

  it("collapses a repo group when header is clicked after expanding", async () => {
    const user = userEvent.setup();
    const prs = [
      makePullRequest({ id: 1, title: "Visible PR", repoFullName: "org/repo-a" }),
    ];
    render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);
    const repoHeader = screen.getByText("org/repo-a").closest("button")!;

    // Click to expand first
    await user.click(repoHeader);
    screen.getByText("Visible PR");

    // Click again to collapse
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
    // Both groups start collapsed
    expect(screen.queryByText("Second Repo PR")).toBeNull();

    const repoHeader = screen.getByText("org/repo-b").closest("button")!;
    await user.click(repoHeader);

    screen.getByText("Second Repo PR");
  });

  it("starts with aria-expanded=false on all repo group headers", () => {
    const prs = [
      makePullRequest({ id: 1, title: "Test PR", repoFullName: "org/repo-a" }),
    ];
    render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);
    const header = screen.getByText("org/repo-a").closest("button")!;
    expect(header.getAttribute("aria-expanded")).toBe("false");
  });

  it("toggles aria-expanded false→true→false on header clicks", async () => {
    const user = userEvent.setup();
    const prs = [
      makePullRequest({ id: 1, title: "Toggle PR", repoFullName: "org/repo-a" }),
    ];
    render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);
    const header = screen.getByText("org/repo-a").closest("button")!;

    // Starts collapsed
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Toggle PR")).toBeNull();

    // Expand
    await user.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");
    screen.getByText("Toggle PR");

    // Collapse again
    await user.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Toggle PR")).toBeNull();
  });

  it("shows collapsed summary with PR count when group is collapsed", () => {
    const prs = [
      makePullRequest({ id: 1, title: "PR One", repoFullName: "org/repo-a" }),
      makePullRequest({ id: 2, title: "PR Two", repoFullName: "org/repo-a" }),
    ];
    render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);
    // Group starts collapsed — summary should show count
    screen.getByText("2 PRs");
  });

  it("shows check status dots in collapsed summary", () => {
    const prs = [
      makePullRequest({ id: 1, title: "PR One", checkStatus: "success", repoFullName: "org/repo-a" }),
      makePullRequest({ id: 2, title: "PR Two", checkStatus: "failure", repoFullName: "org/repo-a" }),
    ];
    render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);
    // Group starts collapsed — check success count (1) and failure count (1) shown as text
    const header = screen.getByText("org/repo-a").closest("button")!;
    const summarySpan = header.querySelector(".ml-auto")!;
    expect(summarySpan.textContent).toContain("1");
  });

  it("shows review state badges in collapsed summary", () => {
    const prs = [
      makePullRequest({ id: 1, title: "PR One", reviewDecision: "APPROVED", repoFullName: "org/repo-a" }),
      makePullRequest({ id: 2, title: "PR Two", reviewDecision: "CHANGES_REQUESTED", repoFullName: "org/repo-a" }),
    ];
    render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);
    // Group starts collapsed — review badges visible in summary
    screen.getByText("Approved ×1");
    screen.getByText("Changes ×1");
  });

  it("shows role badges in collapsed summary", () => {
    const prs = [
      makePullRequest({ id: 1, title: "My PR", userLogin: "alice", reviewerLogins: [], assigneeLogins: [], repoFullName: "org/repo-a" }),
    ];
    render(() => <PullRequestsTab pullRequests={prs} userLogin="alice" />);
    // Group starts collapsed — role badges visible in summary
    screen.getByText("author ×1");
  });

  it("hides summary metadata when group is expanded", async () => {
    const user = userEvent.setup();
    const prs = [
      makePullRequest({ id: 1, title: "PR One", repoFullName: "org/repo-a" }),
    ];
    render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);
    const header = screen.getByText("org/repo-a").closest("button")!;
    // Expand the group
    await user.click(header);
    // Summary count should not be shown when expanded
    expect(screen.queryByText("1 PR")).toBeNull();
  });

  it("renders IgnoreBadge in filter toolbar", () => {
    const pr = makePullRequest({ id: 42, title: "To Ignore", repoFullName: "org/repo-a" });
    viewStore.ignoreItem({
      id: 42,
      type: "pullRequest",
      repo: pr.repoFullName,
      title: pr.title,
      ignoredAt: Date.now(),
    });
    render(() => <PullRequestsTab pullRequests={[]} userLogin="" />);
    // IgnoreBadge now shows an icon button with aria-label
    screen.getByRole("button", { name: /1 ignored/i });
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
    setAllExpanded("pullRequests", ["org/big-repo"], true);
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
  });

  it("clicking Expand all expands all repo groups", async () => {
    const user = userEvent.setup();
    const prs = [
      makePullRequest({ id: 1, title: "PR in repo A", repoFullName: "org/repo-a" }),
      makePullRequest({ id: 2, title: "PR in repo B", repoFullName: "org/repo-b" }),
    ];
    render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);
    // Both start collapsed
    expect(screen.queryByText("PR in repo A")).toBeNull();
    expect(screen.queryByText("PR in repo B")).toBeNull();

    await user.click(screen.getByLabelText("Expand all repos"));

    screen.getByText("PR in repo A");
    screen.getByText("PR in repo B");
  });

  it("clicking Collapse all collapses all repo groups", async () => {
    const user = userEvent.setup();
    const prs = [
      makePullRequest({ id: 1, title: "PR in repo A", repoFullName: "org/repo-a" }),
      makePullRequest({ id: 2, title: "PR in repo B", repoFullName: "org/repo-b" }),
    ];
    setAllExpanded("pullRequests", ["org/repo-a", "org/repo-b"], true);
    render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);
    // Both start expanded
    screen.getByText("PR in repo A");
    screen.getByText("PR in repo B");

    await user.click(screen.getByLabelText("Collapse all repos"));

    expect(screen.queryByText("PR in repo A")).toBeNull();
    expect(screen.queryByText("PR in repo B")).toBeNull();
  });

  it("expanded state persists in viewState after toggle", async () => {
    const user = userEvent.setup();
    const prs = [
      makePullRequest({ id: 1, title: "PR in repo A", repoFullName: "org/repo-a" }),
    ];
    render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);

    // Initially collapsed
    expect(viewStore.viewState.expandedRepos.pullRequests["org/repo-a"]).toBeFalsy();

    const header = screen.getByText("org/repo-a").closest("button")!;
    await user.click(header);

    // Now expanded in viewState
    expect(viewStore.viewState.expandedRepos.pullRequests["org/repo-a"]).toBe(true);
  });

  it("expanded state survives component unmount and remount", async () => {
    const user = userEvent.setup();
    const prs = [
      makePullRequest({ id: 1, title: "Persistent PR", repoFullName: "org/repo-a" }),
    ];

    const { unmount } = render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);
    const header = screen.getByText("org/repo-a").closest("button")!;
    await user.click(header);
    // Confirm expanded
    screen.getByText("Persistent PR");

    // Unmount
    unmount();

    // Remount — state in viewState should persist
    render(() => <PullRequestsTab pullRequests={prs} userLogin="" />);
    screen.getByText("Persistent PR");
  });

  it("prunes stale expanded keys when a repo disappears from data", () => {
    const [prs, setPrs] = createSignal<PullRequest[]>([
      makePullRequest({ id: 1, title: "Repo A PR", repoFullName: "org/repo-a" }),
      makePullRequest({ id: 2, title: "Repo B PR", repoFullName: "org/repo-b" }),
    ]);
    setAllExpanded("pullRequests", ["org/repo-a", "org/repo-b"], true);
    render(() => <PullRequestsTab pullRequests={prs()} userLogin="" />);
    screen.getByText("Repo A PR");
    screen.getByText("Repo B PR");

    // Remove repo-b from data — pruning effect should fire
    setPrs([makePullRequest({ id: 1, title: "Repo A PR", repoFullName: "org/repo-a" })]);
    expect(viewStore.viewState.expandedRepos.pullRequests["org/repo-a"]).toBe(true);
    expect("org/repo-b" in viewStore.viewState.expandedRepos.pullRequests).toBe(false);
  });

  it("preserves expanded keys when data becomes empty and restores UI on re-population", () => {
    const [prs, setPrs] = createSignal<PullRequest[]>([
      makePullRequest({ id: 1, title: "PR A", repoFullName: "org/repo-a" }),
    ]);
    setAllExpanded("pullRequests", ["org/repo-a"], true);
    render(() => <PullRequestsTab pullRequests={prs()} userLogin="" />);
    screen.getByText("PR A");

    setPrs([]);
    expect(viewStore.viewState.expandedRepos.pullRequests["org/repo-a"]).toBe(true);

    // Data returns — UI should use preserved expanded state
    setPrs([makePullRequest({ id: 1, title: "PR A", repoFullName: "org/repo-a" })]);
    screen.getByText("PR A");
  });

  it("clicking 'Expand all' expands repos on other pages too", async () => {
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
    // Page 1 shows repo-a, page 2 shows repo-b
    screen.getByText(/Page 1 of 2/);

    // Expand all — affects repos on ALL pages
    await user.click(screen.getByLabelText("Expand all repos"));
    // Repo-a items visible on page 1
    screen.getByText("Repo A PR 0");

    // Navigate to page 2 — repo-b should already be expanded
    await user.click(screen.getByLabelText("Next page"));
    screen.getByText("org/repo-b");
    screen.getByText("Repo B PR 0");
  });

  it("applies shimmer class to rows whose IDs are in hotPollingPRIds", () => {
    const prs = [
      makePullRequest({ id: 42, number: 42, title: "Hot PR", repoFullName: "org/repo" }),
      makePullRequest({ id: 99, number: 99, title: "Cold PR", repoFullName: "org/repo" }),
    ];
    setAllExpanded("pullRequests", ["org/repo"], true);
    const { container } = render(() => (
      <PullRequestsTab pullRequests={prs} userLogin="" hotPollingPRIds={new Set([42])} />
    ));
    const rows = container.querySelectorAll("[role='listitem']");
    expect(rows.length).toBe(2);
    // First row (id=42, hot-polled) should have shimmer
    expect(rows[0]?.querySelector(".animate-shimmer")).toBeTruthy();
    // Second row (id=99, not hot-polled) should not
    expect(rows[1]?.querySelector(".animate-shimmer")).toBeFalsy();
  });

  it("does not apply shimmer when hotPollingPRIds is undefined", () => {
    const prs = [
      makePullRequest({ id: 1, number: 1, title: "Normal PR", repoFullName: "org/repo" }),
    ];
    setAllExpanded("pullRequests", ["org/repo"], true);
    const { container } = render(() => (
      <PullRequestsTab pullRequests={prs} userLogin="" />
    ));
    const rows = container.querySelectorAll("[role='listitem']");
    expect(rows[0]?.querySelector(".animate-shimmer")).toBeFalsy();
  });
});
