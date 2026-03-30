import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@solidjs/testing-library";
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

import ActionsTab from "../../../src/app/components/dashboard/ActionsTab";
import { resetViewState } from "../../../src/app/stores/view";

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
