import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import TabBar from "../../../src/app/components/layout/TabBar";
import type { TabCounts } from "../../../src/app/components/layout/TabBar";

describe("TabBar", () => {
  it("renders tabs for Issues, Pull Requests, and Actions", () => {
    const onTabChange = vi.fn();
    render(() => (
      <TabBar activeTab="issues" onTabChange={onTabChange} />
    ));
    expect(screen.getByText("Issues")).toBeDefined();
    expect(screen.getByText("Pull Requests")).toBeDefined();
    expect(screen.getByText("Actions")).toBeDefined();
  });

  it("highlights active tab with aria-current='page'", () => {
    const onTabChange = vi.fn();
    render(() => (
      <TabBar activeTab="pullRequests" onTabChange={onTabChange} />
    ));
    const buttons = screen.getAllByRole("button");
    const prButton = buttons.find((b) => b.textContent?.includes("Pull Requests"));
    expect(prButton).toBeDefined();
    expect(prButton!.getAttribute("aria-current")).toBe("page");
  });

  it("does not set aria-current on inactive tabs", () => {
    const onTabChange = vi.fn();
    render(() => (
      <TabBar activeTab="issues" onTabChange={onTabChange} />
    ));
    const buttons = screen.getAllByRole("button");
    const prButton = buttons.find((b) => b.textContent?.includes("Pull Requests"));
    const actionsButton = buttons.find((b) => b.textContent?.includes("Actions"));
    expect(prButton!.getAttribute("aria-current")).toBeNull();
    expect(actionsButton!.getAttribute("aria-current")).toBeNull();
  });

  it("calls onTabChange with 'issues' when Issues tab clicked", () => {
    const onTabChange = vi.fn();
    render(() => (
      <TabBar activeTab="pullRequests" onTabChange={onTabChange} />
    ));
    const buttons = screen.getAllByRole("button");
    const issuesButton = buttons.find((b) => b.textContent?.includes("Issues"));
    fireEvent.click(issuesButton!);
    expect(onTabChange).toHaveBeenCalledWith("issues");
  });

  it("calls onTabChange with 'pullRequests' when Pull Requests tab clicked", () => {
    const onTabChange = vi.fn();
    render(() => (
      <TabBar activeTab="issues" onTabChange={onTabChange} />
    ));
    const buttons = screen.getAllByRole("button");
    const prButton = buttons.find((b) => b.textContent?.includes("Pull Requests"));
    fireEvent.click(prButton!);
    expect(onTabChange).toHaveBeenCalledWith("pullRequests");
  });

  it("calls onTabChange with 'actions' when Actions tab clicked", () => {
    const onTabChange = vi.fn();
    render(() => (
      <TabBar activeTab="issues" onTabChange={onTabChange} />
    ));
    const buttons = screen.getAllByRole("button");
    const actionsButton = buttons.find((b) => b.textContent?.includes("Actions"));
    fireEvent.click(actionsButton!);
    expect(onTabChange).toHaveBeenCalledWith("actions");
  });

  it("shows counts in tab labels when counts prop provided", () => {
    const onTabChange = vi.fn();
    const counts: TabCounts = { issues: 5, pullRequests: 12, actions: 3 };
    render(() => (
      <TabBar activeTab="issues" onTabChange={onTabChange} counts={counts} />
    ));
    expect(screen.getByText("5")).toBeDefined();
    expect(screen.getByText("12")).toBeDefined();
    expect(screen.getByText("3")).toBeDefined();
  });

  it("does not show count badges when counts prop is not provided", () => {
    const onTabChange = vi.fn();
    render(() => (
      <TabBar activeTab="issues" onTabChange={onTabChange} />
    ));
    // No numeric badge spans should appear
    expect(screen.queryByText("0")).toBeNull();
  });

  it("does not render count badge when count is undefined for a tab", () => {
    const onTabChange = vi.fn();
    const counts: TabCounts = { issues: 7 };
    render(() => (
      <TabBar activeTab="issues" onTabChange={onTabChange} counts={counts} />
    ));
    expect(screen.getByText("7")).toBeDefined();
    // PR and Actions counts should not appear
    expect(screen.queryByText("0")).toBeNull();
  });
});
