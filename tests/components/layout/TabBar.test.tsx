import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import TabBar from "../../../src/app/components/layout/TabBar";
import type { TabCounts } from "../../../src/app/components/layout/TabBar";

describe("TabBar", () => {
  it("renders tabs for Issues, Pull Requests, and Actions", () => {
    const onTabChange = vi.fn();
    render(() => (
      <TabBar activeTab="issues" onTabChange={onTabChange} />
    ));
    screen.getByText("Issues");
    screen.getByText("Pull Requests");
    screen.getByText("Actions");
  });

  it("highlights active tab with aria-selected='true'", () => {
    const onTabChange = vi.fn();
    render(() => (
      <TabBar activeTab="pullRequests" onTabChange={onTabChange} />
    ));
    const prTab = screen.getByRole("tab", { name: /Pull Requests/ });
    expect(prTab).toBeDefined();
    expect(prTab.getAttribute("aria-selected")).toBe("true");
  });

  it("does not set aria-selected on inactive tabs", () => {
    const onTabChange = vi.fn();
    render(() => (
      <TabBar activeTab="issues" onTabChange={onTabChange} />
    ));
    const prTab = screen.getByRole("tab", { name: /Pull Requests/ });
    const actionsTab = screen.getByRole("tab", { name: /Actions/ });
    expect(prTab.getAttribute("aria-selected")).toBe("false");
    expect(actionsTab.getAttribute("aria-selected")).toBe("false");
  });

  it("calls onTabChange with 'issues' when Issues tab clicked", async () => {
    const user = userEvent.setup();
    const onTabChange = vi.fn();
    render(() => (
      <TabBar activeTab="pullRequests" onTabChange={onTabChange} />
    ));
    const issuesTab = screen.getByRole("tab", { name: /Issues/ });
    await user.click(issuesTab);
    expect(onTabChange).toHaveBeenCalledWith("issues");
  });

  it("calls onTabChange with 'pullRequests' when Pull Requests tab clicked", async () => {
    const user = userEvent.setup();
    const onTabChange = vi.fn();
    render(() => (
      <TabBar activeTab="issues" onTabChange={onTabChange} />
    ));
    const prTab = screen.getByRole("tab", { name: /Pull Requests/ });
    await user.click(prTab);
    expect(onTabChange).toHaveBeenCalledWith("pullRequests");
  });

  it("calls onTabChange with 'actions' when Actions tab clicked", async () => {
    const user = userEvent.setup();
    const onTabChange = vi.fn();
    render(() => (
      <TabBar activeTab="issues" onTabChange={onTabChange} />
    ));
    const actionsTab = screen.getByRole("tab", { name: /Actions/ });
    await user.click(actionsTab);
    expect(onTabChange).toHaveBeenCalledWith("actions");
  });

  it("shows counts in tab labels when counts prop provided", () => {
    const onTabChange = vi.fn();
    const counts: TabCounts = { issues: 5, pullRequests: 12, actions: 3 };
    render(() => (
      <TabBar activeTab="issues" onTabChange={onTabChange} counts={counts} />
    ));
    screen.getByText("5");
    screen.getByText("12");
    screen.getByText("3");
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
    screen.getByText("7");
    // PR and Actions counts should not appear
    expect(screen.queryByText("0")).toBeNull();
  });
});
