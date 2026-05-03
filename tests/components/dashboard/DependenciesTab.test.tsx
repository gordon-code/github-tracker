import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, fireEvent } from "@solidjs/testing-library";

// ── localStorage mock (must be before imports that read localStorage) ─────────

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

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("../../../src/app/lib/url", () => ({
  isSafeGitHubUrl: (url: string) => typeof url === "string" && url.startsWith("https://github.com"),
  openGitHubUrl: vi.fn(),
}));

// ── Imports (after mocks and localStorage setup) ──────────────────────────────

import { render } from "@solidjs/testing-library";
import DependenciesTab from "../../../src/app/components/dashboard/DependenciesTab.js";
import { resetConfig, updateConfig } from "../../../src/app/stores/config.js";
import { setTabFilter, resetViewState, viewState } from "../../../src/app/stores/view.js";
import { makePullRequest } from "../../helpers/factories.js";
import type { AbandonedDependency } from "../../../src/app/lib/dependency-dashboard.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const EMPTY_MAPS = {
  abandonedDepsMap: new Map<string, AbandonedDependency[]>(),
  dashboardIssueUrls: new Map<string, string>(),
};

const BASE_PROPS = {
  userLogin: "testuser",
  trackedBotLogins: new Set<string>(),
  rebaseLabel: "rebase",
  ...EMPTY_MAPS,
};

function renderTab(overrides: Partial<Parameters<typeof DependenciesTab>[0]> = {}) {
  const props = { ...BASE_PROPS, pullRequests: [], ...overrides };
  return render(() => <DependenciesTab {...props} />);
}

// A PR that lands in "needs-review" (enriched, not draft, CI passing, not approved)
function makeNeedsReviewPR(overrides: Parameters<typeof makePullRequest>[0] = {}) {
  return makePullRequest({
    userLogin: "renovate[bot]",
    headRef: "renovate/lodash-4.x",
    title: "chore(deps): update dependency lodash to v5",
    checkStatus: "success",
    reviewDecision: null,
    draft: false,
    enriched: true,
    state: "OPEN",
    repoFullName: "owner/repo",
    ...overrides,
  });
}

// A PR that lands in "waiting" (CI pending, recent so not stale)
function makeWaitingPR(overrides: Parameters<typeof makePullRequest>[0] = {}) {
  const recentDate = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago
  return makePullRequest({
    userLogin: "dependabot[bot]",
    headRef: "dependabot/npm_and_yarn/axios-1.0.0",
    title: "Bump axios from 0.27.2 to 1.0.0",
    checkStatus: "pending",
    draft: false,
    enriched: true,
    updatedAt: recentDate,
    state: "OPEN",
    repoFullName: "owner/repo",
    ...overrides,
  });
}

// A PR that lands in "stale" (updatedAt >14 days ago)
function makeStalePR(overrides: Parameters<typeof makePullRequest>[0] = {}) {
  const oldDate = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
  return makePullRequest({
    userLogin: "renovate[bot]",
    headRef: "renovate/react-18.x",
    title: "chore(deps): update dependency react to v18",
    checkStatus: "pending",
    draft: false,
    enriched: true,
    updatedAt: oldDate,
    state: "OPEN",
    repoFullName: "owner/repo",
    ...overrides,
  });
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  localStorageMock.clear();
  resetViewState();
  resetConfig();
  vi.clearAllMocks();
});

// ── Empty state ───────────────────────────────────────────────────────────────

describe("DependenciesTab — empty state", () => {
  it("shows empty state message when no PRs", () => {
    renderTab({ pullRequests: [] });
    expect(screen.getByText("No open dependency update PRs")).toBeDefined();
    expect(screen.getByText("Your dependencies are up to date!")).toBeDefined();
  });

  it("does not show status group headers when empty", () => {
    renderTab({ pullRequests: [] });
    expect(screen.queryByText("Needs Review")).toBeNull();
    expect(screen.queryByText("Waiting")).toBeNull();
    expect(screen.queryByText("Stale")).toBeNull();
  });

  it("shows loading skeleton when loading with no PRs", () => {
    renderTab({ loading: true, pullRequests: [] });
    expect(screen.getByRole("status", { name: "Loading dependency PRs" })).toBeDefined();
  });

  it("shows 'no filter matches' when filters exclude all PRs", () => {
    const pr = makePullRequest({
      userLogin: "renovate[bot]",
      headRef: "renovate/lodash-4.x",
      title: "Bump lodash from 4.17.20 to 4.17.21",
      state: "OPEN",
      enriched: true,
      checkStatus: "success",
      reviewDecision: null,
      draft: false,
    });
    setTabFilter("dependencies", "updateType", "major");
    renderTab({ pullRequests: [pr] });
    expect(screen.getByText("No PRs match your current filters")).toBeDefined();
  });
});

// ── Status groups ─────────────────────────────────────────────────────────────

describe("DependenciesTab — status groups", () => {
  it("renders Needs Review group for enriched passing PRs", () => {
    const pr = makeNeedsReviewPR();
    renderTab({ pullRequests: [pr] });
    expect(screen.getByText("Needs Review")).toBeDefined();
  });

  it("renders Waiting group for CI-pending PRs", () => {
    const pr = makeWaitingPR();
    renderTab({ pullRequests: [pr] });
    expect(screen.getByText("Waiting")).toBeDefined();
  });

  it("renders Stale group for old PRs", () => {
    const pr = makeStalePR();
    renderTab({ pullRequests: [pr] });
    expect(screen.getByText("Stale")).toBeDefined();
  });

  it("shows Needs Review expanded by default — PR title visible", () => {
    const pr = makeNeedsReviewPR();
    renderTab({ pullRequests: [pr] });
    expect(screen.getByText(pr.title)).toBeDefined();
  });

  it("Waiting group collapsed by default — content div is hidden", () => {
    const pr = makeWaitingPR();
    renderTab({ pullRequests: [pr] });
    const contentDiv = document.getElementById("dep-group-waiting")!;
    expect(contentDiv.classList.contains("hidden")).toBe(true);
  });

  it("expands Waiting group when header is clicked", () => {
    const pr = makeWaitingPR();
    renderTab({ pullRequests: [pr] });
    const header = screen.getByText("Waiting").closest("button")!;
    fireEvent.click(header);
    const contentDiv = document.getElementById("dep-group-waiting")!;
    expect(contentDiv.classList.contains("hidden")).toBe(false);
  });

  it("collapses an expanded group on second click", () => {
    const pr = makeNeedsReviewPR();
    renderTab({ pullRequests: [pr] });
    const header = screen.getByText("Needs Review").closest("button")!;
    fireEvent.click(header);
    const contentDiv = document.getElementById("dep-group-needs-review")!;
    expect(contentDiv.classList.contains("hidden")).toBe(true);
  });

  it("shows count badge in group header", () => {
    const pr1 = makeNeedsReviewPR();
    const pr2 = makeNeedsReviewPR({ title: "chore(deps): update dependency react to v18" });
    renderTab({ pullRequests: [pr1, pr2] });
    const header = screen.getByText("Needs Review").closest("button")!;
    expect(header.textContent).toContain("2");
  });
});

// ── Stale threshold ───────────────────────────────────────────────────────────

describe("DependenciesTab — stale threshold", () => {
  it("PR updated 15 days ago is classified stale", () => {
    const pr = makeStalePR();
    renderTab({ pullRequests: [pr] });
    expect(screen.getByText("Stale")).toBeDefined();
  });

  it("PR updated 12 hours ago is not stale (goes to waiting)", () => {
    const recentDate = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    const pr = makeWaitingPR({ updatedAt: recentDate });
    renderTab({ pullRequests: [pr] });
    expect(screen.getByText("Waiting")).toBeDefined();
    expect(screen.queryByText("Stale")).toBeNull();
  });
});

// ── Version badges ─────────────────────────────────────────────────────────────

describe("DependenciesTab — version badges", () => {
  it("shows 'major' badge for major version bump", () => {
    const pr = makeNeedsReviewPR({ title: "Bump lodash from 3.10.0 to 4.0.0" });
    renderTab({ pullRequests: [pr] });
    expect(screen.getByText("major")).toBeDefined();
  });

  it("shows 'minor' badge for minor version bump", () => {
    const pr = makeNeedsReviewPR({ title: "Bump lodash from 4.16.0 to 4.17.0" });
    renderTab({ pullRequests: [pr] });
    expect(screen.getByText("minor")).toBeDefined();
  });

  it("shows 'patch' badge for patch version bump", () => {
    const pr = makeNeedsReviewPR({ title: "Bump lodash from 4.17.20 to 4.17.21" });
    renderTab({ pullRequests: [pr] });
    expect(screen.getByText("patch")).toBeDefined();
  });

  it("shows no version badge for maintenance titles", () => {
    const pr = makeNeedsReviewPR({ title: "chore(deps): pin dependencies" });
    renderTab({ pullRequests: [pr] });
    expect(screen.queryByText("major")).toBeNull();
    expect(screen.queryByText("minor")).toBeNull();
    expect(screen.queryByText("patch")).toBeNull();
  });
});

// ── Rebase indicator ──────────────────────────────────────────────────────────

describe("DependenciesTab — rebase indicator", () => {
  it("shows 'Rebasing' when PR has the rebase label", () => {
    const pr = makeNeedsReviewPR({ labels: [{ name: "rebase", color: "ededed" }] });
    renderTab({ pullRequests: [pr], rebaseLabel: "rebase" });
    expect(screen.getByText("Rebasing")).toBeDefined();
  });

  it("does not show 'Rebasing' when label does not match", () => {
    const pr = makeNeedsReviewPR({ labels: [] });
    renderTab({ pullRequests: [pr], rebaseLabel: "rebase" });
    expect(screen.queryByText("Rebasing")).toBeNull();
  });

  it("rebase label check is case-insensitive", () => {
    const pr = makeNeedsReviewPR({ labels: [{ name: "Rebase", color: "ededed" }] });
    renderTab({ pullRequests: [pr], rebaseLabel: "rebase" });
    expect(screen.getByText("Rebasing")).toBeDefined();
  });
});

// ── Abandoned dep pill ────────────────────────────────────────────────────────

describe("DependenciesTab — abandoned dep pill", () => {
  it("shows 'Abandoned dep' pill when PR title matches abandoned package", () => {
    const pr = makeNeedsReviewPR({
      title: "chore(deps): update dependency lodash to v5",
      repoFullName: "owner/repo",
    });
    const abandonedDepsMap = new Map([
      ["owner/repo", [{ datasource: "npm", packageName: "lodash", lastUpdated: "2024-01-01" }]],
    ]);
    const dashboardIssueUrls = new Map([
      ["owner/repo", "https://github.com/owner/repo/issues/1"],
    ]);
    renderTab({ pullRequests: [pr], abandonedDepsMap, dashboardIssueUrls });
    expect(screen.getByText("Abandoned dep")).toBeDefined();
  });

  it("does not show pill when no abandoned dep match", () => {
    const pr = makeNeedsReviewPR({ title: "Bump react from 17.0.0 to 18.0.0" });
    const abandonedDepsMap = new Map([
      ["owner/repo", [{ datasource: "npm", packageName: "lodash", lastUpdated: "2024-01-01" }]],
    ]);
    renderTab({ pullRequests: [pr], abandonedDepsMap });
    expect(screen.queryByText("Abandoned dep")).toBeNull();
  });

  it("abandoned pill is an anchor when dashboard URL is safe (SEC-001)", () => {
    const pr = makeNeedsReviewPR({
      title: "chore(deps): update dependency lodash to v5",
      repoFullName: "owner/repo",
    });
    const abandonedDepsMap = new Map([
      ["owner/repo", [{ datasource: "npm", packageName: "lodash", lastUpdated: "2024-01-01" }]],
    ]);
    const dashboardIssueUrls = new Map([
      ["owner/repo", "https://github.com/owner/repo/issues/1"],
    ]);
    renderTab({ pullRequests: [pr], abandonedDepsMap, dashboardIssueUrls });
    const pill = screen.getByText("Abandoned dep");
    expect(pill.tagName.toLowerCase()).toBe("a");
    expect(pill.getAttribute("href")).toBe("https://github.com/owner/repo/issues/1");
  });

  it("abandoned pill is a span when URL fails SEC-001 check", () => {
    const pr = makeNeedsReviewPR({
      title: "chore(deps): update dependency lodash to v5",
      repoFullName: "owner/repo",
    });
    const abandonedDepsMap = new Map([
      ["owner/repo", [{ datasource: "npm", packageName: "lodash", lastUpdated: "2024-01-01" }]],
    ]);
    const dashboardIssueUrls = new Map([
      ["owner/repo", "https://evil.example.com/phish"],
    ]);
    renderTab({ pullRequests: [pr], abandonedDepsMap, dashboardIssueUrls });
    const pill = screen.getByText("Abandoned dep");
    expect(pill.tagName.toLowerCase()).not.toBe("a");
  });
});

// ── Filters ───────────────────────────────────────────────────────────────────

describe("DependenciesTab — updateType filter", () => {
  it("shows all PRs by default (updateType=all)", () => {
    const major = makeNeedsReviewPR({ title: "Bump lodash from 3.0.0 to 4.0.0" });
    const patch = makeNeedsReviewPR({ title: "Bump lodash from 4.17.20 to 4.17.21" });
    renderTab({ pullRequests: [major, patch] });
    expect(screen.getByText(major.title)).toBeDefined();
    expect(screen.getByText(patch.title)).toBeDefined();
  });

  it("filters to major only when updateType=major is set", () => {
    const major = makeNeedsReviewPR({ title: "Bump lodash from 3.0.0 to 4.0.0" });
    const patch = makeNeedsReviewPR({ title: "Bump lodash from 4.17.20 to 4.17.21" });
    setTabFilter("dependencies", "updateType", "major");
    renderTab({ pullRequests: [major, patch] });
    expect(screen.getByText(major.title)).toBeDefined();
    expect(screen.queryByText(patch.title)).toBeNull();
  });

  it("maintenance PRs pass through all updateType filters (unknown version type)", () => {
    const pin = makeNeedsReviewPR({ title: "chore(deps): pin dependencies" });
    setTabFilter("dependencies", "updateType", "major");
    renderTab({ pullRequests: [pin] });
    expect(screen.getByText(pin.title)).toBeDefined();
  });
});

describe("DependenciesTab — bot filter", () => {
  it("filters to specific bot when bot filter is set", () => {
    const renovatePR = makeNeedsReviewPR({ userLogin: "renovate[bot]", title: "chore(deps): update lodash" });
    const dependabotPR = makeNeedsReviewPR({ userLogin: "dependabot[bot]", title: "Bump axios from 0.27 to 1.0.0" });
    setTabFilter("dependencies", "bot", "renovate[bot]");
    renderTab({ pullRequests: [renovatePR, dependabotPR] });
    expect(screen.getByText(renovatePR.title)).toBeDefined();
    expect(screen.queryByText(dependabotPR.title)).toBeNull();
  });
});

// ── Ignore button ─────────────────────────────────────────────────────────────

describe("DependenciesTab — ignore button", () => {
  it("clicking the ignore button hides the PR from the list", () => {
    const pr = makeNeedsReviewPR({ title: "chore(deps): bump lodash to v5" });
    renderTab({ pullRequests: [pr] });

    // PR is visible before ignore
    expect(screen.getByText(pr.title)).toBeDefined();

    const ignoreBtn = screen.getByRole("button", { name: /^Ignore #/ });
    fireEvent.click(ignoreBtn);

    // PR should no longer be rendered
    expect(screen.queryByText(pr.title)).toBeNull();
  });

  it("ignore button adds item to ignoredItems in viewState", () => {
    const pr = makeNeedsReviewPR({ id: 5001, title: "chore(deps): update react to v19" });
    renderTab({ pullRequests: [pr] });

    const ignoreBtn = screen.getByRole("button", { name: /^Ignore #/ });
    fireEvent.click(ignoreBtn);

    expect(viewState.ignoredItems.some((i) => i.id === 5001 && i.type === "pullRequest")).toBe(true);
  });

  it("ignored PR is not rendered even when re-renderTab is called", () => {
    const pr = makeNeedsReviewPR({ id: 5002, title: "Bump axios from 0.27 to 1.0.0 (ignored)" });
    const { unmount } = renderTab({ pullRequests: [pr] });

    fireEvent.click(screen.getByRole("button", { name: /^Ignore #/ }));
    unmount();

    // Re-render with same PR data — ignored item should still be filtered out
    renderTab({ pullRequests: [pr] });
    expect(screen.queryByText(pr.title)).toBeNull();
  });
});

// ── Track button ──────────────────────────────────────────────────────────────

describe("DependenciesTab — track button", () => {
  it("track button is not rendered when enableTracking is false", () => {
    updateConfig({ enableTracking: false });
    const pr = makeNeedsReviewPR({ title: "chore(deps): update lodash to v5" });
    renderTab({ pullRequests: [pr] });

    expect(screen.queryByRole("button", { name: /^Pin #/ })).toBeNull();
  });

  it("track button renders when enableTracking is true", () => {
    updateConfig({ enableTracking: true });
    const pr = makeNeedsReviewPR({ title: "chore(deps): update lodash to v5" });
    renderTab({ pullRequests: [pr] });

    expect(screen.getByRole("button", { name: /^Pin #/ })).toBeDefined();
  });

  it("clicking track button adds the PR to trackedItems", () => {
    updateConfig({ enableTracking: true });
    const pr = makeNeedsReviewPR({ id: 6001, title: "Bump react from 17 to 18" });
    renderTab({ pullRequests: [pr] });

    fireEvent.click(screen.getByRole("button", { name: /^Pin #/ }));

    expect(viewState.trackedItems.some((t) => t.id === 6001 && t.type === "pullRequest")).toBe(true);
  });

  it("clicking track button a second time removes the PR from trackedItems (toggle)", () => {
    updateConfig({ enableTracking: true });
    const pr = makeNeedsReviewPR({ id: 6002, title: "Bump typescript from 4 to 5" });
    renderTab({ pullRequests: [pr] });

    // First click: track (aria-label is "Pin #…")
    fireEvent.click(screen.getByRole("button", { name: /^Pin #/ }));
    expect(viewState.trackedItems.some((t) => t.id === 6002)).toBe(true);

    // Second click: untrack (aria-label switches to "Unpin #…" when tracked)
    fireEvent.click(screen.getByRole("button", { name: /^Unpin #/ }));
    expect(viewState.trackedItems.some((t) => t.id === 6002)).toBe(false);
  });
});
