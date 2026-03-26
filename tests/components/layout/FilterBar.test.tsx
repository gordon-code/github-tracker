import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
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
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("FilterBar", () => {
  it("renders org and repo filter dropdowns", () => {
    render(() => <FilterBar />);
    screen.getByLabelText("Filter by organization");
    screen.getByLabelText("Filter by repository");
  });

  it("renders refresh button", () => {
    render(() => <FilterBar />);
    screen.getByLabelText("Refresh data");
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
    screen.getByText("Refreshing...");
  });

  it("shows last refreshed time when lastRefreshedAt provided", () => {
    const now = new Date();
    const tenSecondsAgo = new Date(now.getTime() - 10_000);
    render(() => <FilterBar lastRefreshedAt={tenSecondsAgo} />);
    screen.getByText("Updated 10s ago");
  });

  it("shows minutes when lastRefreshedAt is more than 60s ago", () => {
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
    render(() => <FilterBar lastRefreshedAt={twoMinutesAgo} />);
    screen.getByText("Updated 2m ago");
  });

  it("does not show updated label when lastRefreshedAt is null", () => {
    render(() => <FilterBar lastRefreshedAt={null} />);
    expect(screen.queryByText(/Updated/)).toBeNull();
  });

  it("calls onRefresh when refresh button clicked", async () => {
    const user = userEvent.setup({ delay: null });
    const onRefresh = vi.fn();
    render(() => <FilterBar onRefresh={onRefresh} />);
    await user.click(screen.getByLabelText("Refresh data"));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("org trigger shows 'All orgs' by default", () => {
    render(() => <FilterBar />);
    const orgTrigger = screen.getByLabelText("Filter by organization");
    expect(orgTrigger.textContent).toContain("All orgs");
  });

  it("repo trigger shows 'All repos' by default", () => {
    render(() => <FilterBar />);
    const repoTrigger = screen.getByLabelText("Filter by repository");
    expect(repoTrigger.textContent).toContain("All repos");
  });

  it("org trigger shows selected org when org filter is set", () => {
    (viewStore.viewState as { globalFilter: { org: string | null; repo: string | null } }).globalFilter = {
      org: "myorg",
      repo: null,
    };
    render(() => <FilterBar />);
    const orgTrigger = screen.getByLabelText("Filter by organization");
    expect(orgTrigger.textContent).toContain("myorg");
  });

  it("clicking org trigger opens listbox with org options", async () => {
    const user = userEvent.setup({ delay: null });
    render(() => <FilterBar />);
    const orgTrigger = screen.getByLabelText("Filter by organization");
    await user.click(orgTrigger);
    // Options should now be visible in the listbox
    expect(screen.getByRole("option", { name: "myorg" })).toBeDefined();
    expect(screen.getByRole("option", { name: "otherorg" })).toBeDefined();
  });

  it("clicking org trigger opens listbox with repo options", async () => {
    const user = userEvent.setup({ delay: null });
    render(() => <FilterBar />);
    const repoTrigger = screen.getByLabelText("Filter by repository");
    await user.click(repoTrigger);
    expect(screen.getByRole("option", { name: "myorg/repo-a" })).toBeDefined();
    expect(screen.getByRole("option", { name: "myorg/repo-b" })).toBeDefined();
    expect(screen.getByRole("option", { name: "otherorg/repo-c" })).toBeDefined();
  });

  it("selecting an org option calls setGlobalFilter and resets repo", async () => {
    const user = userEvent.setup({ delay: null });
    render(() => <FilterBar />);
    const orgTrigger = screen.getByLabelText("Filter by organization");
    await user.click(orgTrigger);
    const myorgOption = screen.getByRole("option", { name: "myorg" });
    await user.click(myorgOption);
    expect(viewStore.setGlobalFilter).toHaveBeenCalledWith("myorg", null);
  });

  it("selecting a repo option calls setGlobalFilter with current org and new repo", async () => {
    const user = userEvent.setup({ delay: null });
    render(() => <FilterBar />);
    const repoTrigger = screen.getByLabelText("Filter by repository");
    await user.click(repoTrigger);
    const repoOption = screen.getByRole("option", { name: "myorg/repo-a" });
    await user.click(repoOption);
    expect(viewStore.setGlobalFilter).toHaveBeenCalledWith(null, "myorg/repo-a");
  });

  it("selecting 'All orgs' option calls setGlobalFilter with null org", async () => {
    const user = userEvent.setup({ delay: null });
    render(() => <FilterBar />);
    const orgTrigger = screen.getByLabelText("Filter by organization");
    await user.click(orgTrigger);
    const allOrgsOption = screen.getByRole("option", { name: "All orgs" });
    await user.click(allOrgsOption);
    expect(viewStore.setGlobalFilter).toHaveBeenCalledWith(null, null);
  });
});
