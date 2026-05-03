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
import { config, resetConfig, updateConfig } from "../../../src/app/stores/config.js";
import { setTabFilter, resetViewState, viewState, setDependencyExpandedGroups } from "../../../src/app/stores/view.js";
import { makePullRequest } from "../../helpers/factories.js";
import type { AbandonedDependency } from "../../../src/app/lib/dependency-dashboard.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const EMPTY_MAPS = {
  abandonedDepsMap: new Map<string, AbandonedDependency[]>(),
  dashboardIssueUrls: new Map<string, string>(),
};

const BASE_PROPS = {
  rebaseLabel: "rebase",
  userLogin: "testuser",
  trackedBotLogins: new Set<string>(),
  ...EMPTY_MAPS,
};

function renderTab(overrides: Partial<Parameters<typeof DependenciesTab>[0]> = {}) {
  const props = { ...BASE_PROPS, pullRequests: [], ...overrides };
  return render(() => <DependenciesTab {...props} />);
}

// A PR that lands in "mergeable" (enriched, not draft, CI passing, not approved)
function makeMergeablePR(overrides: Parameters<typeof makePullRequest>[0] = {}) {
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

// A PR that lands in "needs-action" (CI pending, recent so not stale)
function makeNeedsActionPR(overrides: Parameters<typeof makePullRequest>[0] = {}) {
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
    expect(screen.queryByText("Mergeable")).toBeNull();
    expect(screen.queryByText("Needs Action")).toBeNull();
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
    expect(screen.getByText("No dependency PRs match your current filters")).toBeDefined();
  });
});

// ── Status groups ─────────────────────────────────────────────────────────────

describe("DependenciesTab — status groups", () => {
  it("renders Mergeable group for enriched passing PRs", () => {
    const pr = makeMergeablePR();
    renderTab({ pullRequests: [pr] });
    expect(screen.getByText("Mergeable")).toBeDefined();
  });

  it("renders Needs Action group for CI-pending PRs", () => {
    const pr = makeNeedsActionPR();
    renderTab({ pullRequests: [pr] });
    expect(screen.getByText("Needs Action")).toBeDefined();
  });

  it("renders Stale group for old PRs", () => {
    const pr = makeStalePR();
    renderTab({ pullRequests: [pr] });
    expect(screen.getByText("Stale")).toBeDefined();
  });

  it("shows Mergeable expanded by default — displayed title visible", () => {
    const pr = makeMergeablePR();
    renderTab({ pullRequests: [pr] });
    // "chore(deps): update dependency lodash to v5" → displayTitle: "lodash → v5"
    expect(screen.getByText("lodash → v5")).toBeDefined();
  });

  it("Needs Action group collapsed by default — content div is hidden", () => {
    const pr = makeNeedsActionPR();
    renderTab({ pullRequests: [pr] });
    const contentDiv = document.getElementById("dep-group-needs-action")!;
    expect(contentDiv.classList.contains("hidden")).toBe(true);
  });

  it("expands Needs Action group when header is clicked", () => {
    const pr = makeNeedsActionPR();
    renderTab({ pullRequests: [pr] });
    const header = screen.getByText("Needs Action").closest("button")!;
    fireEvent.click(header);
    const contentDiv = document.getElementById("dep-group-needs-action")!;
    expect(contentDiv.classList.contains("hidden")).toBe(false);
  });

  it("collapses an expanded group on second click", () => {
    const pr = makeMergeablePR();
    renderTab({ pullRequests: [pr] });
    const header = screen.getByText("Mergeable").closest("button")!;
    fireEvent.click(header);
    const contentDiv = document.getElementById("dep-group-mergeable")!;
    expect(contentDiv.classList.contains("hidden")).toBe(true);
  });

  it("does not show count badges in group headers", () => {
    const pr1 = makeMergeablePR();
    const pr2 = makeMergeablePR({ title: "Bump react from 17.0.0 to 18.0.0" });
    renderTab({ pullRequests: [pr1, pr2] });
    const header = screen.getByText("Mergeable").closest("button")!;
    expect(header.textContent).not.toContain("2");
  });
});

// ── Expand state persistence ─────────────────────────────────────────────────

describe("DependenciesTab — expand state persistence", () => {
  it("persists expanded groups to viewState", () => {
    const pr = makeNeedsActionPR();
    renderTab({ pullRequests: [pr] });
    const header = screen.getByText("Needs Action").closest("button")!;
    fireEvent.click(header);
    expect(viewState.dependencyExpandedGroups).toContain("needs-action");
  });

  it("restores expanded groups from viewState", () => {
    setDependencyExpandedGroups(["needs-action", "stale"]);
    const pr = makeNeedsActionPR();
    renderTab({ pullRequests: [pr] });
    const contentDiv = document.getElementById("dep-group-needs-action")!;
    expect(contentDiv.classList.contains("hidden")).toBe(false);
  });

  it("expand all opens all groups", () => {
    const pr1 = makeMergeablePR();
    const pr2 = makeNeedsActionPR();
    const pr3 = makeStalePR();
    renderTab({ pullRequests: [pr1, pr2, pr3] });
    const expandAllBtn = screen.getByLabelText("Expand all repos");
    fireEvent.click(expandAllBtn);
    expect(document.getElementById("dep-group-mergeable")!.classList.contains("hidden")).toBe(false);
    expect(document.getElementById("dep-group-needs-action")!.classList.contains("hidden")).toBe(false);
    expect(document.getElementById("dep-group-stale")!.classList.contains("hidden")).toBe(false);
  });

  it("collapse all closes all groups", () => {
    const pr = makeMergeablePR();
    renderTab({ pullRequests: [pr] });
    const collapseAllBtn = screen.getByLabelText("Collapse all repos");
    fireEvent.click(collapseAllBtn);
    expect(document.getElementById("dep-group-mergeable")!.classList.contains("hidden")).toBe(true);
  });
});

// ── Pending Rebase status ────────────────────────────────────────────────────

describe("DependenciesTab — pending rebase", () => {
  it("classifies PR with rebase label into Pending Rebase group", () => {
    const pr = makeMergeablePR({ labels: [{ name: "rebase", color: "ededed" }] });
    renderTab({ pullRequests: [pr], rebaseLabel: "rebase" });
    expect(screen.getByText("Pending Rebase")).toBeDefined();
    expect(screen.queryByText("Mergeable")).toBeNull();
  });

  it("rebase classification is case-insensitive", () => {
    const pr = makeMergeablePR({ labels: [{ name: "Rebase", color: "ededed" }] });
    renderTab({ pullRequests: [pr], rebaseLabel: "rebase" });
    expect(screen.getByText("Pending Rebase")).toBeDefined();
  });

  it("Pending Rebase group is collapsed by default", () => {
    const pr = makeMergeablePR({ labels: [{ name: "rebase", color: "ededed" }] });
    renderTab({ pullRequests: [pr], rebaseLabel: "rebase" });
    const contentDiv = document.getElementById("dep-group-pending-rebase")!;
    expect(contentDiv.classList.contains("hidden")).toBe(true);
  });
});

// ── Stale threshold ───────────────────────────────────────────────────────────

describe("DependenciesTab — stale threshold", () => {
  it("PR updated 15 days ago is classified stale", () => {
    const pr = makeStalePR();
    renderTab({ pullRequests: [pr] });
    expect(screen.getByText("Stale")).toBeDefined();
  });

  it("PR updated 12 hours ago is not stale (goes to needs-action)", () => {
    const recentDate = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    const pr = makeNeedsActionPR({ updatedAt: recentDate });
    renderTab({ pullRequests: [pr] });
    expect(screen.getByText("Needs Action")).toBeDefined();
    expect(screen.queryByText("Stale")).toBeNull();
  });
});

// ── Version badges ─────────────────────────────────────────────────────────────

describe("DependenciesTab — version badges", () => {
  it("shows 'major' badge for major version bump", () => {
    const pr = makeMergeablePR({ title: "Bump lodash from 3.10.0 to 4.0.0" });
    renderTab({ pullRequests: [pr] });
    expect(screen.getByText("major")).toBeDefined();
  });

  it("shows 'minor' badge for minor version bump", () => {
    const pr = makeMergeablePR({ title: "Bump lodash from 4.16.0 to 4.17.0" });
    renderTab({ pullRequests: [pr] });
    expect(screen.getByText("minor")).toBeDefined();
  });

  it("shows 'patch' badge for patch version bump", () => {
    const pr = makeMergeablePR({ title: "Bump lodash from 4.17.20 to 4.17.21" });
    renderTab({ pullRequests: [pr] });
    expect(screen.getByText("patch")).toBeDefined();
  });

  it("shows no version badge for maintenance titles", () => {
    const pr = makeMergeablePR({ title: "chore(deps): pin dependencies" });
    renderTab({ pullRequests: [pr] });
    expect(screen.queryByText("major")).toBeNull();
    expect(screen.queryByText("minor")).toBeNull();
    expect(screen.queryByText("patch")).toBeNull();
  });

  it("shows structured title with version arrow for bump PRs", () => {
    const pr = makeMergeablePR({ title: "Bump lodash from 4.17.20 to 4.17.21" });
    renderTab({ pullRequests: [pr] });
    expect(screen.getByText("lodash: 4.17.20 → 4.17.21")).toBeDefined();
  });

  it("shows structured title with to-version for Renovate PRs", () => {
    const pr = makeMergeablePR({ title: "chore(deps): update dependency react to v18" });
    renderTab({ pullRequests: [pr] });
    expect(screen.getByText("react → v18")).toBeDefined();
  });

  it("shows structured title for Python requirement PRs", () => {
    const pr = makeMergeablePR({ title: "chore(deps-dev): update ruff requirement from >=0.9.4 to >=0.15.10" });
    renderTab({ pullRequests: [pr] });
    expect(screen.getByText("ruff: 0.9.4 → 0.15.10")).toBeDefined();
  });
});

// ── Abandoned pill ────────────────────────────────────────────────────────

describe("DependenciesTab — abandoned dep pill", () => {
  it("shows 'Abandoned' pill when PR title matches abandoned package", () => {
    const pr = makeMergeablePR({
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
    expect(screen.getByText("Abandoned")).toBeDefined();
  });

  it("does not show pill when no abandoned dep match", () => {
    const pr = makeMergeablePR({ title: "Bump react from 17.0.0 to 18.0.0" });
    const abandonedDepsMap = new Map([
      ["owner/repo", [{ datasource: "npm", packageName: "lodash", lastUpdated: "2024-01-01" }]],
    ]);
    renderTab({ pullRequests: [pr], abandonedDepsMap });
    expect(screen.queryByText("Abandoned")).toBeNull();
  });

  it("abandoned pill is an anchor when dashboard URL is safe (SEC-001)", () => {
    const pr = makeMergeablePR({
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
    const pill = screen.getByText("Abandoned");
    expect(pill.tagName.toLowerCase()).toBe("a");
    expect(pill.getAttribute("href")).toBe("https://github.com/owner/repo/issues/1");
  });

  it("abandoned pill is a span when URL fails SEC-001 check", () => {
    const pr = makeMergeablePR({
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
    const pill = screen.getByText("Abandoned");
    expect(pill.tagName.toLowerCase()).not.toBe("a");
  });
});

// ── Filters ───────────────────────────────────────────────────────────────────

describe("DependenciesTab — updateType filter", () => {
  it("shows all PRs by default (updateType=all)", () => {
    const major = makeMergeablePR({ title: "Bump lodash from 3.0.0 to 4.0.0" });
    const patch = makeMergeablePR({ title: "Bump axios from 0.27.1 to 0.27.2" });
    renderTab({ pullRequests: [major, patch] });
    expect(screen.getByText("lodash: 3.0.0 → 4.0.0")).toBeDefined();
    expect(screen.getByText("axios: 0.27.1 → 0.27.2")).toBeDefined();
  });

  it("filters to major only when updateType=major is set", () => {
    const major = makeMergeablePR({ title: "Bump lodash from 3.0.0 to 4.0.0" });
    const patch = makeMergeablePR({ title: "Bump axios from 0.27.1 to 0.27.2" });
    setTabFilter("dependencies", "updateType", "major");
    renderTab({ pullRequests: [major, patch] });
    expect(screen.getByText("lodash: 3.0.0 → 4.0.0")).toBeDefined();
    expect(screen.queryByText("axios: 0.27.1 → 0.27.2")).toBeNull();
  });

  it("maintenance PRs are hidden when a specific version type is selected", () => {
    const pin = makeMergeablePR({ title: "chore(deps): pin dependencies" });
    setTabFilter("dependencies", "updateType", "major");
    renderTab({ pullRequests: [pin] });
    expect(screen.queryByText("Pin dependencies")).toBeNull();
  });

  it("pin PRs are shown when pin filter is selected", () => {
    const pin = makeMergeablePR({ title: "chore(deps): pin dependencies" });
    setTabFilter("dependencies", "updateType", "pin");
    renderTab({ pullRequests: [pin] });
    expect(screen.getByText("Pin dependencies")).toBeDefined();
  });

  it("lock file PRs are shown when maintenance filter is selected", () => {
    const lockFile = makeMergeablePR({ title: "chore(deps): lock file maintenance" });
    setTabFilter("dependencies", "updateType", "maintenance");
    renderTab({ pullRequests: [lockFile] });
    expect(screen.getByText("Lock file maintenance")).toBeDefined();
  });

  it("uses label as fallback when title has no version info", () => {
    const pr = makeMergeablePR({
      title: "chore(deps): update dependency foo to v2",
      labels: [{ name: "major", color: "ff0000" }],
    });
    setTabFilter("dependencies", "updateType", "major");
    renderTab({ pullRequests: [pr] });
    expect(screen.getByText("foo → v2")).toBeDefined();
  });
});

describe("DependenciesTab — bot filter", () => {
  it("filters to specific bot when bot filter is set", () => {
    const renovatePR = makeMergeablePR({ userLogin: "renovate[bot]", title: "chore(deps): update dependency lodash to v5" });
    const dependabotPR = makeMergeablePR({ userLogin: "dependabot[bot]", title: "Bump axios from 0.27.2 to 1.0.0" });
    setTabFilter("dependencies", "bot", "renovate[bot]");
    renderTab({ pullRequests: [renovatePR, dependabotPR] });
    expect(screen.getByText("lodash → v5")).toBeDefined();
    expect(screen.queryByText(/axios/)).toBeNull();
  });
});

// ── Label filtering ──────────────────────────────────────────────────────────

describe("DependenciesTab — label filtering", () => {
  it("filters out dep-tool labels (dependencies, renovate)", () => {
    const pr = makeMergeablePR({
      labels: [
        { name: "dependencies", color: "0075ca" },
        { name: "renovate", color: "1a7f37" },
        { name: "go", color: "00add8" },
      ],
    });
    renderTab({ pullRequests: [pr] });
    expect(screen.queryByText("dependencies")).toBeNull();
    expect(screen.queryByText("renovate")).toBeNull();
    expect(screen.getByText("go")).toBeDefined();
  });
});

// ── Ignore button ─────────────────────────────────────────────────────────────

describe("DependenciesTab — ignore button", () => {
  it("clicking the ignore button hides the PR from the list", () => {
    const pr = makeMergeablePR({ title: "chore(deps): update dependency lodash to v5" });
    renderTab({ pullRequests: [pr] });
    expect(screen.getByText("lodash → v5")).toBeDefined();

    const ignoreBtn = screen.getByRole("button", { name: /^Ignore #/ });
    fireEvent.click(ignoreBtn);

    expect(screen.queryByText("lodash → v5")).toBeNull();
  });

  it("ignore button adds item to ignoredItems in viewState", () => {
    const pr = makeMergeablePR({ id: 5001, title: "chore(deps): update dependency react to v19" });
    renderTab({ pullRequests: [pr] });

    const ignoreBtn = screen.getByRole("button", { name: /^Ignore #/ });
    fireEvent.click(ignoreBtn);

    expect(viewState.ignoredItems.some((i) => i.id === 5001 && i.type === "pullRequest")).toBe(true);
  });

  it("ignored PR is not rendered even when re-renderTab is called", () => {
    const pr = makeMergeablePR({ id: 5002, title: "Bump axios from 0.27.2 to 1.0.0" });
    const { unmount } = renderTab({ pullRequests: [pr] });

    fireEvent.click(screen.getByRole("button", { name: /^Ignore #/ }));
    unmount();

    renderTab({ pullRequests: [pr] });
    expect(screen.queryByText(/axios/)).toBeNull();
  });

  it("ignored dep PRs appear in the IgnoreBadge", () => {
    const pr = makeMergeablePR({ id: 5003, title: "chore(deps): update dependency chalk to v6" });
    renderTab({ pullRequests: [pr] });

    fireEvent.click(screen.getByRole("button", { name: /^Ignore #/ }));

    expect(screen.getByLabelText(/ignored items/i)).toBeDefined();
  });
});

// ── Track button ──────────────────────────────────────────────────────────────

describe("DependenciesTab — track button", () => {
  it("track button is not rendered when enableTracking is false", () => {
    updateConfig({ enableTracking: false });
    const pr = makeMergeablePR({ title: "chore(deps): update dependency lodash to v5" });
    renderTab({ pullRequests: [pr] });

    expect(screen.queryByRole("button", { name: /^Pin #/ })).toBeNull();
  });

  it("track button renders when enableTracking is true", () => {
    updateConfig({ enableTracking: true });
    const pr = makeMergeablePR({ title: "chore(deps): update dependency lodash to v5" });
    renderTab({ pullRequests: [pr] });

    expect(screen.getByRole("button", { name: /^Pin #/ })).toBeDefined();
  });

  it("clicking track button adds the PR to trackedItems", () => {
    updateConfig({ enableTracking: true });
    const pr = makeMergeablePR({ id: 6001, title: "Bump react from 17.0.0 to 18.0.0" });
    renderTab({ pullRequests: [pr] });

    fireEvent.click(screen.getByRole("button", { name: /^Pin #/ }));

    expect(viewState.trackedItems.some((t) => t.id === 6001 && t.type === "pullRequest")).toBe(true);
  });

  it("clicking track button a second time removes the PR from trackedItems (toggle)", () => {
    updateConfig({ enableTracking: true });
    const pr = makeMergeablePR({ id: 6002, title: "Bump typescript from 4.0.0 to 5.0.0" });
    renderTab({ pullRequests: [pr] });

    fireEvent.click(screen.getByRole("button", { name: /^Pin #/ }));
    expect(viewState.trackedItems.some((t) => t.id === 6002)).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /^Unpin #/ }));
    expect(viewState.trackedItems.some((t) => t.id === 6002)).toBe(false);
  });
});

// ── Unknown bot detection ────────────────────────────────────────────────────

describe("DependenciesTab — unknown bot banner", () => {
  it("shows banner for unknown bot authors", () => {
    const pr = makeMergeablePR({
      userLogin: "custom-dep-bot",
      userAvatarUrl: "https://avatars.githubusercontent.com/u/12345",
    });
    renderTab({ pullRequests: [pr] });
    expect(screen.getByRole("button", { name: "Track bot" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeDefined();
  });

  it("does not show banner for known dep bots", () => {
    const pr = makeMergeablePR({ userLogin: "renovate[bot]" });
    renderTab({ pullRequests: [pr] });
    expect(screen.queryByRole("button", { name: "Track bot" })).toBeNull();
  });

  it("does not show banner for known bots without [bot] suffix", () => {
    const pr = makeMergeablePR({ userLogin: "dependabot" });
    renderTab({ pullRequests: [pr] });
    expect(screen.queryByRole("button", { name: "Track bot" })).toBeNull();
  });

  it("does not show banner for the authenticated user", () => {
    const pr = makeMergeablePR({ userLogin: "testuser" });
    renderTab({ pullRequests: [pr], userLogin: "testuser" });
    expect(screen.queryByRole("button", { name: "Track bot" })).toBeNull();
  });

  it("dismiss button hides the banner for the session", () => {
    const pr = makeMergeablePR({
      userLogin: "custom-dep-bot",
      userAvatarUrl: "https://avatars.githubusercontent.com/u/12345",
    });
    renderTab({ pullRequests: [pr] });
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("button", { name: "Track bot" })).toBeNull();
  });

  it("track button adds bot to config.trackedUsers", () => {
    const pr = makeMergeablePR({
      userLogin: "custom-dep-bot",
      userAvatarUrl: "https://avatars.githubusercontent.com/u/12345",
    });
    renderTab({ pullRequests: [pr] });
    fireEvent.click(screen.getByRole("button", { name: "Track bot" }));

    expect(config.trackedUsers.some((u) => u.login === "custom-dep-bot" && u.type === "bot")).toBe(true);
  });
});

// ── Ignore button ─────────────────────────────────────────────────────────────

describe("DependenciesTab — ignore button", () => {
  it("clicking the ignore button hides the PR from the list", () => {
    const pr = makeMergeablePR({ title: "chore(deps): update dependency lodash to v5" });
    renderTab({ pullRequests: [pr] });
    expect(screen.getByText("lodash")).toBeDefined();

    const ignoreBtn = screen.getByRole("button", { name: /^Ignore #/ });
    fireEvent.click(ignoreBtn);

    expect(screen.queryByText("lodash")).toBeNull();
  });

  it("ignore button adds item to ignoredItems in viewState", () => {
    const pr = makeMergeablePR({ id: 5001, title: "chore(deps): update dependency react to v19" });
    renderTab({ pullRequests: [pr] });

    const ignoreBtn = screen.getByRole("button", { name: /^Ignore #/ });
    fireEvent.click(ignoreBtn);

    expect(viewState.ignoredItems.some((i) => i.id === 5001 && i.type === "pullRequest")).toBe(true);
  });

  it("ignored PR is not rendered even when re-renderTab is called", () => {
    const pr = makeMergeablePR({ id: 5002, title: "Bump axios from 0.27.2 to 1.0.0" });
    const { unmount } = renderTab({ pullRequests: [pr] });

    fireEvent.click(screen.getByRole("button", { name: /^Ignore #/ }));
    unmount();

    renderTab({ pullRequests: [pr] });
    expect(screen.queryByText("axios")).toBeNull();
  });
});

// ── Track button ──────────────────────────────────────────────────────────────

describe("DependenciesTab — track button", () => {
  it("track button is not rendered when enableTracking is false", () => {
    updateConfig({ enableTracking: false });
    const pr = makeMergeablePR({ title: "chore(deps): update dependency lodash to v5" });
    renderTab({ pullRequests: [pr] });

    expect(screen.queryByRole("button", { name: /^Pin #/ })).toBeNull();
  });

  it("track button renders when enableTracking is true", () => {
    updateConfig({ enableTracking: true });
    const pr = makeMergeablePR({ title: "chore(deps): update dependency lodash to v5" });
    renderTab({ pullRequests: [pr] });

    expect(screen.getByRole("button", { name: /^Pin #/ })).toBeDefined();
  });

  it("clicking track button adds the PR to trackedItems", () => {
    updateConfig({ enableTracking: true });
    const pr = makeMergeablePR({ id: 6001, title: "Bump react from 17.0.0 to 18.0.0" });
    renderTab({ pullRequests: [pr] });

    fireEvent.click(screen.getByRole("button", { name: /^Pin #/ }));

    expect(viewState.trackedItems.some((t) => t.id === 6001 && t.type === "pullRequest")).toBe(true);
  });

  it("clicking track button a second time removes the PR from trackedItems (toggle)", () => {
    updateConfig({ enableTracking: true });
    const pr = makeMergeablePR({ id: 6002, title: "Bump typescript from 4.0.0 to 5.0.0" });
    renderTab({ pullRequests: [pr] });

    fireEvent.click(screen.getByRole("button", { name: /^Pin #/ }));
    expect(viewState.trackedItems.some((t) => t.id === 6002)).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /^Unpin #/ }));
    expect(viewState.trackedItems.some((t) => t.id === 6002)).toBe(false);
  });
});

// ── Unknown bot detection ────────────────────────────────────────────────────

describe("DependenciesTab — unknown bot banner", () => {
  it("shows banner for unknown bot authors", () => {
    const pr = makeMergeablePR({
      userLogin: "custom-dep-bot",
      userAvatarUrl: "https://avatars.githubusercontent.com/u/12345",
    });
    renderTab({ pullRequests: [pr] });
    expect(screen.getByRole("button", { name: "Track bot" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeDefined();
  });

  it("does not show banner for known dep bots", () => {
    const pr = makeMergeablePR({ userLogin: "renovate[bot]" });
    renderTab({ pullRequests: [pr] });
    expect(screen.queryByRole("button", { name: "Track bot" })).toBeNull();
  });

  it("does not show banner for known bots without [bot] suffix", () => {
    const pr = makeMergeablePR({ userLogin: "dependabot" });
    renderTab({ pullRequests: [pr] });
    expect(screen.queryByRole("button", { name: "Track bot" })).toBeNull();
  });

  it("does not show banner for the authenticated user", () => {
    const pr = makeMergeablePR({ userLogin: "testuser" });
    renderTab({ pullRequests: [pr], userLogin: "testuser" });
    expect(screen.queryByRole("button", { name: "Track bot" })).toBeNull();
  });

  it("dismiss button hides the banner for the session", () => {
    const pr = makeMergeablePR({
      userLogin: "custom-dep-bot",
      userAvatarUrl: "https://avatars.githubusercontent.com/u/12345",
    });
    renderTab({ pullRequests: [pr] });
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("button", { name: "Track bot" })).toBeNull();
  });

  it("track button adds bot to config.trackedUsers", () => {
    const pr = makeMergeablePR({
      userLogin: "custom-dep-bot",
      userAvatarUrl: "https://avatars.githubusercontent.com/u/12345",
    });
    renderTab({ pullRequests: [pr] });
    fireEvent.click(screen.getByRole("button", { name: "Track bot" }));

    expect(config.trackedUsers.some((u) => u.login === "custom-dep-bot" && u.type === "bot")).toBe(true);
  });
});
