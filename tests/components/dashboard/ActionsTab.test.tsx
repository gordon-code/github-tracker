import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { makeWorkflowRun } from "../../helpers/index";

// ── localStorage mock ─────────────────────────────────────────────────────────

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

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("../../../src/app/lib/url", () => ({
  isSafeGitHubUrl: () => true,
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { produce } from "solid-js/store";
import ActionsTab from "../../../src/app/components/dashboard/ActionsTab";
import { viewState, setViewState, resetViewState } from "../../../src/app/stores/view";

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  localStorageMock.clear();
  resetViewState();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ActionsTab — upstream exclusion note", () => {
  it("does not show upstream note when hasUpstreamRepos is false", () => {
    render(() => (
      <ActionsTab workflowRuns={[]} hasUpstreamRepos={false} />
    ));
    expect(screen.queryByText(/workflow runs are not tracked for upstream/i)).toBeNull();
  });

  it("does not show upstream note when hasUpstreamRepos is undefined", () => {
    render(() => (
      <ActionsTab workflowRuns={[]} />
    ));
    expect(screen.queryByText(/workflow runs are not tracked for upstream/i)).toBeNull();
  });

  it("shows upstream note when hasUpstreamRepos is true", () => {
    render(() => (
      <ActionsTab workflowRuns={[]} hasUpstreamRepos={true} />
    ));
    screen.getByText(/workflow runs are not tracked for upstream/i);
  });

  it("shows upstream note alongside workflow run data when hasUpstreamRepos is true", () => {
    const runs = [makeWorkflowRun({ repoFullName: "owner/repo" })];
    render(() => (
      <ActionsTab workflowRuns={runs} hasUpstreamRepos={true} />
    ));
    screen.getByText(/workflow runs are not tracked for upstream/i);
  });
});

describe("ActionsTab — empty-repo state preservation", () => {
  it("preserves expand/lock state for empty repos in configRepoNames", () => {
    setViewState(produce((s) => {
      s.expandedRepos.actions["owner/empty-repo"] = true;
      s.expandedRepos.actions["owner/stale-repo"] = true;
      s.lockedRepos = ["owner/empty-repo", "owner/stale-repo"];
    }));

    render(() => (
      <ActionsTab
        workflowRuns={[makeWorkflowRun({ repoFullName: "owner/active-repo" })]}
        configRepoNames={["owner/active-repo", "owner/empty-repo"]}
      />
    ));

    // Empty repo preserved (in configRepoNames but no items)
    expect(viewState.expandedRepos.actions["owner/empty-repo"]).toBe(true);
    expect(viewState.lockedRepos).toContain("owner/empty-repo");
    // Stale repo pruned (not in configRepoNames)
    expect(viewState.expandedRepos.actions["owner/stale-repo"]).toBeUndefined();
    expect(viewState.lockedRepos).not.toContain("owner/stale-repo");
  });

  it("falls back to item-derived names when configRepoNames not provided", () => {
    render(() => (
      <ActionsTab workflowRuns={[]} />
    ));
    // With empty items and no configRepoNames, guard returns early — no pruning
    expect(viewState.lockedRepos).toEqual([]);
  });

  it("renders compact stub row for a locked repo with no workflow runs", () => {
    setViewState(produce((s) => {
      s.lockedRepos = ["owner/locked-empty"];
    }));

    const { container } = render(() => (
      <ActionsTab
        workflowRuns={[makeWorkflowRun({ repoFullName: "owner/active-repo" })]}
        configRepoNames={["owner/active-repo", "owner/locked-empty"]}
      />
    ));

    const stub = container.querySelector('[data-repo-group="owner/locked-empty"]');
    expect(stub).not.toBeNull();
    expect(stub?.textContent).toContain("owner/locked-empty");
    const headerBtn = stub?.querySelector('[aria-expanded]');
    expect(headerBtn).toBeNull();
  });

  it("does not expand a locked repo with no workflow runs even when expandedRepos is set", () => {
    setViewState(produce((s) => {
      s.lockedRepos = ["owner/locked-empty"];
      s.expandedRepos.actions["owner/locked-empty"] = true;
    }));

    const { container } = render(() => (
      <ActionsTab
        workflowRuns={[makeWorkflowRun({ repoFullName: "owner/active-repo" })]}
        configRepoNames={["owner/active-repo", "owner/locked-empty"]}
      />
    ));

    const stub = container.querySelector('[data-repo-group="owner/locked-empty"]');
    expect(stub).not.toBeNull();
    expect(stub?.querySelector('[aria-expanded]')).toBeNull();
  });

  it("hides empty-state message when only locked stubs exist (no double render)", () => {
    setViewState(produce((s) => {
      s.lockedRepos = ["owner/locked-empty"];
    }));

    const { container } = render(() => (
      <ActionsTab
        workflowRuns={[]}
        configRepoNames={["owner/locked-empty"]}
      />
    ));

    // Locked stub renders
    const stub = container.querySelector('[data-repo-group="owner/locked-empty"]');
    expect(stub).not.toBeNull();
    // Empty-state message does NOT render alongside the stub
    expect(screen.queryByText("No workflow runs found.")).toBeNull();
  });

  it("hides locked stubs during initial load (no skeleton + stub double render)", () => {
    setViewState(produce((s) => {
      s.lockedRepos = ["owner/locked-empty"];
    }));

    const { container } = render(() => (
      <ActionsTab
        workflowRuns={[]}
        loading={true}
        configRepoNames={["owner/locked-empty"]}
      />
    ));

    // Loading skeleton shows (label is aria-label, not visible text)
    screen.getByRole("status", { name: "Loading workflow runs" });
    // Locked stub does NOT render alongside the skeleton
    const stub = container.querySelector('[data-repo-group="owner/locked-empty"]');
    expect(stub).toBeNull();
  });
});

// ── ActionsTab — RepoGroupHeader integration ──────────────────────────────────

describe("ActionsTab — RepoGroupHeader rendering", () => {
  it("renders the repo name in the group header when workflow runs are present", () => {
    const runs = [makeWorkflowRun({ repoFullName: "owner/my-repo" })];
    render(() => (
      <ActionsTab workflowRuns={runs} />
    ));
    // The header toggle button has aria-expanded, distinguishing it from pin/unpin buttons
    const headerBtn = screen.getAllByRole("button", { name: /owner\/my-repo/i })
      .find(btn => btn.hasAttribute("aria-expanded"));
    expect(headerBtn).toBeTruthy();
  });

  it("toggles repo group expanded state when header button is clicked", async () => {
    const user = userEvent.setup();
    const runs = [makeWorkflowRun({ repoFullName: "owner/repo" })];

    render(() => (
      <ActionsTab workflowRuns={runs} />
    ));

    const headerBtn = screen.getAllByRole("button", { name: /owner\/repo/i })
      .find(btn => btn.hasAttribute("aria-expanded"))!;

    // Initially collapsed
    expect(headerBtn.getAttribute("aria-expanded")).toBe("false");
    expect(viewState.expandedRepos.actions["owner/repo"]).toBeFalsy();

    // Click to expand
    await user.click(headerBtn);
    expect(headerBtn.getAttribute("aria-expanded")).toBe("true");
    expect(viewState.expandedRepos.actions["owner/repo"]).toBe(true);

    // Click again to collapse
    await user.click(headerBtn);
    expect(headerBtn.getAttribute("aria-expanded")).toBe("false");
    expect(viewState.expandedRepos.actions["owner/repo"]).toBeFalsy();
  });
});
