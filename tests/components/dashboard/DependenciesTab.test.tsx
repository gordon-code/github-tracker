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

  it("filters to digest only when updateType=digest is set", () => {
    const digest = makeMergeablePR({
      title: "chore(deps): refresh vendored dependencies",
      labels: [{ name: "digest", color: "1a7f37" }],
    });
    const patch = makeMergeablePR({ title: "Bump axios from 0.27.1 to 0.27.2" });
    setTabFilter("dependencies", "updateType", "digest");
    renderTab({ pullRequests: [digest, patch] });
    expect(screen.getByText("Refresh vendored dependencies")).toBeDefined();
    expect(screen.queryByText("axios: 0.27.1 → 0.27.2")).toBeNull();
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

// ── Update type filter options order ─────────────────────────────────────────

describe("DependenciesTab — update type filter options order", () => {
  it("shows options in risk order: Maintenance, Pin, Digest, Patch, Minor, Major, Other", () => {
    vi.useFakeTimers();
    try {
      const pr = makeMergeablePR();
      renderTab({ pullRequests: [pr] });
      const trigger = screen.getByRole("button", { name: /filter by update type/i });
      fireEvent.click(trigger);
      vi.advanceTimersByTime(0);
      const content = document.querySelector('[aria-label="Update type"]')!;
      const optionLabels = Array.from(content.querySelectorAll("button"))
        .map((b) => b.textContent?.replace(/^✓\s*/, "").trim())
        .filter((t): t is string => !!t && t !== "All");
      expect(optionLabels).toEqual(["Maintenance", "Pin", "Digest", "Patch", "Minor", "Major", "Other"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── Category classification ───────────────────────────────────────────────────

describe("DependenciesTab — category classification", () => {
  it("digest category sorts between pin and patch, and renders a visible badge", () => {
    const prPin = makeMergeablePR({ id: 7001, title: "chore(deps): pin dependencies" });
    const prDigest = makeMergeablePR({ id: 7002, title: "chore(deps): update rust crate pyo3 to v0.29.1" });
    const prPatch = makeMergeablePR({ id: 7003, title: "Bump axios from 0.27.1 to 0.27.2" });
    const depMeta = new Map([
      [prDigest.id, { updateType: "digest" as const, packageName: "pyo3", to: "v0.29.1" }],
    ]);

    renderTab({ pullRequests: [prPatch, prPin, prDigest], depMeta });

    expect(screen.getByText("digest")).toBeDefined();

    const items = screen.getAllByRole("listitem");
    const categories = items
      .map((item) => item.querySelector(".badge")?.textContent?.trim())
      .filter((c): c is string => !!c);
    expect(categories).toEqual(["pin", "digest", "patch"]);
  });

  it("sorts all 7 categories in strict risk order: maintenance, pin, digest, patch, minor, major, other", () => {
    const prMaintenance = makeMergeablePR({ id: 7101, title: "chore(deps): lock file maintenance" });
    const prPin = makeMergeablePR({ id: 7102, title: "chore(deps): pin dependencies" });
    const prDigest = makeMergeablePR({
      id: 7103,
      title: "chore(deps): refresh vendored dependencies",
      labels: [{ name: "digest", color: "1a7f37" }],
    });
    const prPatch = makeMergeablePR({ id: 7104, title: "Bump axios from 0.27.1 to 0.27.2" });
    const prMinor = makeMergeablePR({ id: 7105, title: "Bump lodash from 4.16.0 to 4.17.0" });
    const prMajor = makeMergeablePR({ id: 7106, title: "Bump react from 17.0.0 to 18.0.0" });
    // Regression guard: an unparseable title with no matching labels must classify as "other"
    // (unknown risk) and sort last, not fall back to "maintenance" (verified-safe) and sort first.
    const prOther = makeMergeablePR({
      id: 7107,
      title: "chore(deps): refresh vendored dependencies for widgets",
    });

    // Deliberately shuffled input order to prove the sort — not insertion order — determines output.
    renderTab({ pullRequests: [prOther, prMajor, prMinor, prPatch, prDigest, prPin, prMaintenance] });

    const items = screen.getAllByRole("listitem");
    const order = items.map((item) => {
      const text = item.textContent ?? "";
      if (text.includes("Lock file maintenance")) return "maintenance";
      if (text.includes("Pin dependencies")) return "pin";
      if (text.includes("Refresh vendored dependencies for widgets")) return "other";
      if (text.includes("Refresh vendored dependencies")) return "digest";
      if (text.includes("axios")) return "patch";
      if (text.includes("lodash")) return "minor";
      if (text.includes("react")) return "major";
      return "unknown";
    });

    expect(order).toEqual(["maintenance", "pin", "digest", "patch", "minor", "major", "other"]);
    // "other" renders no risk badge (Show when={category !== "other"}) — confirm it's not mislabeled "maintenance".
    expect(screen.queryByText("maintenance")).not.toBeNull();
    expect(screen.getAllByText("maintenance")).toHaveLength(1);
  });

  it("PR with unparseable title and no matching labels renders as 'other' (hidden badge), not 'maintenance'", () => {
    const pr = makeMergeablePR({ title: "chore(deps): refresh vendored dependencies" });
    renderTab({ pullRequests: [pr] });
    expect(screen.queryByText("maintenance")).toBeNull();
    expect(screen.queryByText("other")).toBeNull();

    const item = screen.getByRole("listitem");
    expect(item.querySelector(".badge")).toBeNull();
  });

  it("PR with a lock-file-maintenance title still renders as 'maintenance' (regression guard)", () => {
    const pr = makeMergeablePR({ title: "chore(deps): lock file maintenance" });
    renderTab({ pullRequests: [pr] });
    expect(screen.getByText("maintenance")).toBeDefined();
  });

  it("PR with unparseable title and a 'digest' label renders category 'digest' with a visible badge", () => {
    const pr = makeMergeablePR({
      title: "chore(deps): refresh vendored dependencies",
      labels: [{ name: "digest", color: "1a7f37" }],
    });
    renderTab({ pullRequests: [pr] });

    const item = screen.getByRole("listitem");
    expect(item.querySelector(".badge")?.textContent?.trim()).toBe("digest");
  });

  it("PR with unparseable title and a 'pin' label renders category 'pin' with a visible badge", () => {
    const pr = makeMergeablePR({
      title: "chore(deps): refresh vendored dependencies",
      labels: [{ name: "pin", color: "1a7f37" }],
    });
    renderTab({ pullRequests: [pr] });

    const item = screen.getByRole("listitem");
    expect(item.querySelector(".badge")?.textContent?.trim()).toBe("pin");
  });

  it("PR with unparseable title and a 'maintenance' label renders category 'maintenance' with a visible badge", () => {
    const pr = makeMergeablePR({
      title: "chore(deps): refresh vendored dependencies",
      labels: [{ name: "maintenance", color: "1a7f37" }],
    });
    renderTab({ pullRequests: [pr] });

    const item = screen.getByRole("listitem");
    expect(item.querySelector(".badge")?.textContent?.trim()).toBe("maintenance");
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

// ── Auto-merge badge and inline Approve action ───────────────────────────────

describe("DependenciesTab — auto-merge badge and Approve action", () => {
  const validSha = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

  it("renders auto-merge badge in comfortable and compact density and preserves category badge first in DOM order", () => {
    const prAuto = makeMergeablePR({
      id: 8001,
      number: 801,
      title: "Bump axios from 0.27.1 to 0.27.2",
      autoMergeMethod: "SQUASH",
      enriched: true,
    });
    const prNoAuto = makeMergeablePR({
      id: 8002,
      number: 802,
      title: "Bump lodash from 4.16.0 to 4.17.0",
      autoMergeMethod: null,
      enriched: true,
    });

    const { unmount } = renderTab({ pullRequests: [prAuto, prNoAuto] });
    const badges = screen.getAllByTestId("auto-merge-badge");
    expect(badges).toHaveLength(1);
    expect(badges[0].className).toContain("badge-sm");

    // Verify category badge ("patch") still comes before auto-merge badge in DOM order
    const items = screen.getAllByRole("listitem");
    expect(items[0].querySelector(".badge")?.textContent?.trim()).toBe("patch");
    unmount();

    updateConfig({ viewDensity: "compact" });
    renderTab({ pullRequests: [prAuto, prNoAuto] });
    const compactBadges = screen.getAllByTestId("auto-merge-badge");
    expect(compactBadges).toHaveLength(1);
    expect(compactBadges[0].className).toContain("badge-xs");
  });

  it("shows Approve button for eligible dependency PRs and invokes onApprovePR(pr) on confirmation", () => {
    const onApprovePR = vi.fn();
    const eligibleDepPR = makeNeedsActionPR({
      id: 8010,
      number: 810,
      title: "Bump axios from 0.27.2 to 1.0.0",
      nodeId: "PR_kwDOdep8010",
      headSha: validSha,
      reviewDecision: "REVIEW_REQUIRED",
      checkStatus: "success",
      enriched: true,
    });
    const alreadyApprovedDepPR = makeMergeablePR({
      id: 8011,
      number: 811,
      title: "Bump lodash from 4.16.0 to 4.17.0",
      nodeId: "PR_kwDOdep8011",
      headSha: validSha,
      reviewDecision: "REVIEW_REQUIRED",
      viewerLatestReviewState: "APPROVED",
      viewerReviewRequested: false,
      enriched: true,
    });

    renderTab({
      pullRequests: [eligibleDepPR, alreadyApprovedDepPR],
      userLogin: "testuser",
      onApprovePR,
    });

    const approveBtn = screen.getByLabelText(/^Approve #810 /);
    expect(screen.queryByLabelText(/^Approve #811 /)).toBeNull();

    fireEvent.click(approveBtn);
    expect(onApprovePR).not.toHaveBeenCalled();
    expect(approveBtn.textContent).toBe("Confirm?");

    fireEvent.click(approveBtn);
    expect(onApprovePR).toHaveBeenCalledOnce();
    expect(onApprovePR).toHaveBeenCalledWith(eligibleDepPR);
  });

  it("hides Approve button when pr.checkStatus is 'failure'", () => {
    setDependencyExpandedGroups(["mergeable", "needs-action"]);
    const onApprovePR = vi.fn();
    const failingDepPR = makeNeedsActionPR({
      id: 8012,
      number: 812,
      title: "Bump axios from 0.27.2 to 1.0.0",
      nodeId: "PR_kwDOdep8012",
      headSha: validSha,
      checkStatus: "failure",
      reviewDecision: "REVIEW_REQUIRED",
      viewerReviewRequested: true,
      enriched: true,
    });

    renderTab({
      pullRequests: [failingDepPR],
      userLogin: "testuser",
      onApprovePR,
    });

    expect(screen.queryByLabelText(/^Approve #812 /)).toBeNull();
  });

  it("renders interactive DraftBadge button for self-authored draft PRs in 'Needs Action' and invokes onMarkPRReady(pr) on second click", () => {
    setDependencyExpandedGroups(["mergeable", "needs-action"]);
    const onMarkPRReady = vi.fn();
    const selfDraftDepPR = makeNeedsActionPR({
      id: 8020,
      number: 820,
      userLogin: "testuser",
      title: "Bump axios from 0.27.2 to 1.0.0",
      nodeId: "PR_kwDOdep8020",
      draft: true,
      checkStatus: "success",
      enriched: true,
    });
    const botDraftDepPR = makeNeedsActionPR({
      id: 8021,
      number: 821,
      userLogin: "dependabot[bot]",
      title: "Bump lodash from 4.17.20 to 4.17.21",
      nodeId: "PR_kwDOdep8021",
      draft: true,
      checkStatus: "success",
      enriched: true,
    });

    renderTab({
      pullRequests: [selfDraftDepPR, botDraftDepPR],
      userLogin: "testuser",
      onMarkPRReady,
    });

    const needsActionGroup = document.getElementById("dep-group-needs-action")!;
    expect(needsActionGroup).not.toBeNull();

    const badges = screen.getAllByTestId("draft-badge");
    expect(badges).toHaveLength(2);

    const ownBtn = screen.getByLabelText("Mark #820 axios: 0.27.2 → 1.0.0 ready for review") as HTMLButtonElement;
    expect(ownBtn.tagName.toLowerCase()).toBe("button");
    expect(ownBtn.textContent).toBe("Draft");

    const botSpan = badges.find((el) => el !== ownBtn)!;
    expect(botSpan.tagName.toLowerCase()).toBe("span");
    expect(botSpan.textContent).toBe("Draft");

    fireEvent.click(ownBtn);
    expect(onMarkPRReady).not.toHaveBeenCalled();
    expect(ownBtn.textContent).toBe("Ready?");

    fireEvent.click(ownBtn);
    expect(onMarkPRReady).toHaveBeenCalledOnce();
    expect(onMarkPRReady).toHaveBeenCalledWith(selfDraftDepPR);
  });

  it("renders 'Merge conflict', 'Failing checks', and 'Checks running' badges in 'Needs Action' and links StatusDot to /checks", () => {
    setDependencyExpandedGroups(["mergeable", "needs-action"]);
    const conflictPR = makeNeedsActionPR({
      id: 8030,
      number: 830,
      title: "Bump axios from 0.27.2 to 1.0.0",
      htmlUrl: "https://github.com/owner/repo/pull/830",
      checkStatus: "conflict",
      enriched: true,
    });
    const failingPR = makeNeedsActionPR({
      id: 8031,
      number: 831,
      title: "Bump lodash from 4.17.20 to 4.17.21",
      htmlUrl: "https://github.com/owner/repo/pull/831",
      checkStatus: "failure",
      enriched: true,
    });
    const pendingPR = makeNeedsActionPR({
      id: 8032,
      number: 832,
      title: "Bump react from 17.0.0 to 18.0.0",
      htmlUrl: "https://github.com/owner/repo/pull/832",
      checkStatus: "pending",
      enriched: true,
    });

    renderTab({
      pullRequests: [conflictPR, failingPR, pendingPR],
      userLogin: "testuser",
    });

    expect(screen.getByText("Merge conflict")).toBeDefined();
    expect(screen.getByText("Failing checks")).toBeDefined();
    expect(screen.getByText("Checks running")).toBeDefined();

    const conflictDotLink = screen.getByLabelText("Checks blocked by merge conflict").closest("a");
    expect(conflictDotLink?.getAttribute("href")).toBe("https://github.com/owner/repo/pull/830/checks");

    const failingDotLink = screen.getByLabelText("Checks failing").closest("a");
    expect(failingDotLink?.getAttribute("href")).toBe("https://github.com/owner/repo/pull/831/checks");

    const pendingDotLink = screen.getByLabelText("Checks in progress").closest("a");
    expect(pendingDotLink?.getAttribute("href")).toBe("https://github.com/owner/repo/pull/832/checks");
  });

  it("classifies enriched non-draft PRs with checkStatus: null or reviewDecision: 'APPROVED' into 'Mergeable' and 'CHANGES_REQUESTED' into 'Needs Action'", () => {
    setDependencyExpandedGroups(["mergeable", "needs-action"]);
    const noCiPR = makeMergeablePR({
      id: 8040,
      number: 840,
      title: "Bump axios from 0.27.1 to 0.27.2",
      checkStatus: null,
      reviewDecision: null,
    });
    const approvedPR = makeMergeablePR({
      id: 8041,
      number: 841,
      title: "Bump lodash from 4.17.20 to 4.17.21",
      checkStatus: "success",
      reviewDecision: "APPROVED",
    });
    const changesRequestedPR = makeNeedsActionPR({
      id: 8042,
      number: 842,
      title: "Bump react from 17.0.0 to 18.0.0",
      checkStatus: "success",
      reviewDecision: "CHANGES_REQUESTED",
    });

    renderTab({
      pullRequests: [noCiPR, approvedPR, changesRequestedPR],
      userLogin: "testuser",
    });

    const mergeableGroup = document.getElementById("dep-group-mergeable")!;
    expect(mergeableGroup.textContent).toContain("axios: 0.27.1 → 0.27.2");
    expect(mergeableGroup.textContent).toContain("lodash: 4.17.20 → 4.17.21");

    const needsActionGroup = document.getElementById("dep-group-needs-action")!;
    expect(needsActionGroup.textContent).toContain("react: 17.0.0 → 18.0.0");
  });

  it("places PR with checkStatus: null and checkStatusStale: true into 'Needs Action' and renders 'Checking status'", () => {
    setDependencyExpandedGroups(["mergeable", "needs-action"]);
    const staleNullCheckPR = makeMergeablePR({
      id: 8050,
      number: 850,
      title: "Bump axios from 0.27.2 to 1.0.0",
      enriched: true,
      draft: false,
      checkStatus: null,
      checkStatusStale: true,
      updatedAt: new Date().toISOString(),
    });

    renderTab({
      pullRequests: [staleNullCheckPR],
      userLogin: "testuser",
      loading: false,
    });

    expect(document.getElementById("dep-group-mergeable")).toBeNull();
    const needsActionGroup = document.getElementById("dep-group-needs-action")!;
    expect(needsActionGroup).not.toBeNull();
    expect(needsActionGroup.textContent).toContain("axios: 0.27.2 → 1.0.0");
    expect(screen.getByText("Checking status")).toBeDefined();
    expect(screen.queryByText("Checks running")).toBeNull();
  });

  it("renders 'Checking status' for unenriched PR once enrichment is no longer pending, and suppresses it while light results await enrichment (loading: false, enrichmentPending: true)", () => {
    setDependencyExpandedGroups(["mergeable", "needs-action"]);
    const unenrichedPR = makeNeedsActionPR({
      id: 8051,
      number: 851,
      title: "Bump lodash from 4.17.20 to 4.17.21",
      enriched: false,
      checkStatus: null,
    });

    const { unmount } = renderTab({
      pullRequests: [unenrichedPR],
      userLogin: "testuser",
      loading: false,
      enrichmentPending: false,
    });

    const needsActionGroup = document.getElementById("dep-group-needs-action")!;
    expect(needsActionGroup.textContent).toContain("lodash: 4.17.20 → 4.17.21");
    expect(screen.getAllByText("Checking status")).toHaveLength(1);
    unmount();

    // DashboardPage has already set loading: false once light results render
    renderTab({
      pullRequests: [unenrichedPR],
      userLogin: "testuser",
      loading: false,
      enrichmentPending: true,
    });

    expect(document.getElementById("dep-group-needs-action")!.textContent).toContain("lodash: 4.17.20 → 4.17.21");
    expect(screen.queryByText("Checking status")).toBeNull();
  });

  it("still renders 'Checking status' for an enriched checkStatusStale PR while enrichmentPending is true", () => {
    const stalePR = makeMergeablePR({
      id: 8052,
      number: 852,
      title: "Bump axios from 0.27.2 to 1.0.0",
      checkStatus: null,
      checkStatusStale: true,
      updatedAt: new Date().toISOString(),
    });
    renderTab({ pullRequests: [stalePR], loading: false, enrichmentPending: true });
    expect(screen.getAllByText("Checking status")).toHaveLength(1);
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
