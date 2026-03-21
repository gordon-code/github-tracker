import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import FilterBar from "../../../src/app/components/layout/FilterBar";

// Mock view store
vi.mock("../../../src/app/stores/view", () => ({
  viewState: { globalFilter: { org: null, repo: null } },
  setGlobalFilter: vi.fn(),
}));

// Mock config store
vi.mock("../../../src/app/stores/config", () => ({
  config: {
    selectedOrgs: ["myorg", "otherorg"],
    selectedRepos: [
      { owner: "myorg", name: "repo-a", fullName: "myorg/repo-a" },
      { owner: "myorg", name: "repo-b", fullName: "myorg/repo-b" },
      { owner: "otherorg", name: "repo-c", fullName: "otherorg/repo-c" },
    ],
  },
}));

import * as viewStore from "../../../src/app/stores/view";
import "../../../src/app/stores/config";

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  // Reset mock to default state
  (viewStore.viewState as { globalFilter: { org: string | null; repo: string | null } }).globalFilter = {
    org: null,
    repo: null,
  };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("FilterBar", () => {
  it("renders org and repo filter dropdowns", () => {
    render(() => <FilterBar />);
    expect(screen.getByLabelText("Filter by organization")).toBeDefined();
    expect(screen.getByLabelText("Filter by repository")).toBeDefined();
  });

  it("renders refresh button", () => {
    render(() => <FilterBar />);
    expect(screen.getByLabelText("Refresh data")).toBeDefined();
  });

  it("refresh button is enabled by default", () => {
    render(() => <FilterBar />);
    const refreshBtn = screen.getByLabelText("Refresh data") as HTMLButtonElement;
    expect(refreshBtn.disabled).toBe(false);
  });

  it("refresh button is disabled when isRefreshing=true", () => {
    render(() => <FilterBar isRefreshing={true} />);
    const refreshBtn = screen.getByLabelText("Refresh data") as HTMLButtonElement;
    expect(refreshBtn.disabled).toBe(true);
  });

  it("shows 'Refreshing...' when isRefreshing=true", () => {
    render(() => <FilterBar isRefreshing={true} />);
    expect(screen.getByText("Refreshing...")).toBeDefined();
  });

  it("shows last refreshed time when lastRefreshedAt provided", () => {
    const now = new Date();
    const tenSecondsAgo = new Date(now.getTime() - 10_000);
    render(() => <FilterBar lastRefreshedAt={tenSecondsAgo} />);
    expect(screen.getByText("Updated 10s ago")).toBeDefined();
  });

  it("shows minutes when lastRefreshedAt is more than 60s ago", () => {
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
    render(() => <FilterBar lastRefreshedAt={twoMinutesAgo} />);
    expect(screen.getByText("Updated 2m ago")).toBeDefined();
  });

  it("does not show updated label when lastRefreshedAt is null", () => {
    render(() => <FilterBar lastRefreshedAt={null} />);
    expect(screen.queryByText(/Updated/)).toBeNull();
  });

  it("calls onRefresh when refresh button clicked", () => {
    const onRefresh = vi.fn();
    render(() => <FilterBar onRefresh={onRefresh} />);
    fireEvent.click(screen.getByLabelText("Refresh data"));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("renders org options from config", () => {
    render(() => <FilterBar />);
    const orgSelect = screen.getByLabelText("Filter by organization") as HTMLSelectElement;
    const options = Array.from(orgSelect.options).map((o) => o.value);
    expect(options).toContain("myorg");
    expect(options).toContain("otherorg");
  });

  it("renders all repos when no org filter is set", () => {
    render(() => <FilterBar />);
    const repoSelect = screen.getByLabelText("Filter by repository") as HTMLSelectElement;
    const options = Array.from(repoSelect.options).map((o) => o.value);
    expect(options).toContain("myorg/repo-a");
    expect(options).toContain("myorg/repo-b");
    expect(options).toContain("otherorg/repo-c");
  });

  it("changing org filter calls setGlobalFilter and resets repo", () => {
    render(() => <FilterBar />);
    const orgSelect = screen.getByLabelText("Filter by organization");
    fireEvent.change(orgSelect, { target: { value: "myorg" } });
    expect(viewStore.setGlobalFilter).toHaveBeenCalledWith("myorg", null);
  });

  it("repo dropdown shows only repos for selected org", () => {
    // Set org filter to myorg
    (viewStore.viewState as { globalFilter: { org: string | null; repo: string | null } }).globalFilter = {
      org: "myorg",
      repo: null,
    };
    render(() => <FilterBar />);
    const repoSelect = screen.getByLabelText("Filter by repository") as HTMLSelectElement;
    const options = Array.from(repoSelect.options).map((o) => o.value);
    expect(options).toContain("myorg/repo-a");
    expect(options).toContain("myorg/repo-b");
    expect(options).not.toContain("otherorg/repo-c");
  });

  it("changing repo filter calls setGlobalFilter with current org and new repo", () => {
    render(() => <FilterBar />);
    const repoSelect = screen.getByLabelText("Filter by repository");
    fireEvent.change(repoSelect, { target: { value: "myorg/repo-a" } });
    expect(viewStore.setGlobalFilter).toHaveBeenCalledWith(null, "myorg/repo-a");
  });

  it("changing org to empty string calls setGlobalFilter with null org", () => {
    render(() => <FilterBar />);
    const orgSelect = screen.getByLabelText("Filter by organization");
    fireEvent.change(orgSelect, { target: { value: "" } });
    expect(viewStore.setGlobalFilter).toHaveBeenCalledWith(null, null);
  });
});
