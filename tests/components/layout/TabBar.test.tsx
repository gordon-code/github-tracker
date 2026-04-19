import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
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

  it("does not render Tracked tab when enableTracking is false", () => {
    const onTabChange = vi.fn();
    render(() => (
      <TabBar activeTab="issues" onTabChange={onTabChange} enableTracking={false} />
    ));
    expect(screen.queryByRole("tab", { name: /Tracked/i })).toBeNull();
  });

  it("does not render Tracked tab when enableTracking is undefined", () => {
    const onTabChange = vi.fn();
    render(() => (
      <TabBar activeTab="issues" onTabChange={onTabChange} />
    ));
    expect(screen.queryByRole("tab", { name: /Tracked/i })).toBeNull();
  });

  it("renders Tracked tab when enableTracking is true", () => {
    const onTabChange = vi.fn();
    render(() => (
      <TabBar activeTab="issues" onTabChange={onTabChange} enableTracking={true} />
    ));
    screen.getByRole("tab", { name: /Tracked/i });
  });

  it("shows tracked count badge when enableTracking is true and count provided", () => {
    const onTabChange = vi.fn();
    const counts: TabCounts = { tracked: 4 };
    render(() => (
      <TabBar activeTab="issues" onTabChange={onTabChange} enableTracking={true} counts={counts} />
    ));
    screen.getByText("4");
  });

  it("calls onTabChange with 'tracked' when Tracked tab clicked", async () => {
    const user = userEvent.setup();
    const onTabChange = vi.fn();
    render(() => (
      <TabBar activeTab="issues" onTabChange={onTabChange} enableTracking={true} />
    ));
    const trackedTab = screen.getByRole("tab", { name: /Tracked/i });
    await user.click(trackedTab);
    expect(onTabChange).toHaveBeenCalledWith("tracked");
  });

  // ── Custom tabs ──────────────────────────────────────────────────────────────

  it("renders custom tabs with correct names", () => {
    const onTabChange = vi.fn();
    render(() => (
      <TabBar
        activeTab="issues"
        onTabChange={onTabChange}
        customTabs={[
          { id: "tab-alpha", name: "Alpha" },
          { id: "tab-beta", name: "Beta" },
        ]}
      />
    ));
    screen.getByRole("tab", { name: /Alpha/ });
    screen.getByRole("tab", { name: /Beta/ });
  });

  it("renders custom tab count badge when count is provided", () => {
    const onTabChange = vi.fn();
    const counts: TabCounts = { "tab-alpha": 7 };
    render(() => (
      <TabBar
        activeTab="issues"
        onTabChange={onTabChange}
        customTabs={[{ id: "tab-alpha", name: "Alpha" }]}
        counts={counts}
      />
    ));
    screen.getByText("7");
  });

  it("does not render a count badge when count is undefined for a custom tab", () => {
    const onTabChange = vi.fn();
    render(() => (
      <TabBar
        activeTab="issues"
        onTabChange={onTabChange}
        customTabs={[{ id: "tab-alpha", name: "Alpha" }]}
      />
    ));
    expect(screen.queryByText("0")).toBeNull();
  });

  it("calls onTabChange with the custom tab id when clicked", async () => {
    const user = userEvent.setup();
    const onTabChange = vi.fn();
    render(() => (
      <TabBar
        activeTab="issues"
        onTabChange={onTabChange}
        customTabs={[{ id: "tab-alpha", name: "Alpha" }]}
      />
    ));
    const alphaTab = screen.getByRole("tab", { name: /Alpha/ });
    await user.click(alphaTab);
    expect(onTabChange).toHaveBeenCalledWith("tab-alpha");
  });

  it("renders the '+' button when onAddTab is provided", () => {
    const onTabChange = vi.fn();
    const onAddTab = vi.fn();
    render(() => (
      <TabBar activeTab="issues" onTabChange={onTabChange} onAddTab={onAddTab} />
    ));
    screen.getByRole("button", { name: /Add custom tab/i });
  });

  it("fires onAddTab callback when '+' button is clicked", () => {
    const onTabChange = vi.fn();
    const onAddTab = vi.fn();
    render(() => (
      <TabBar activeTab="issues" onTabChange={onTabChange} onAddTab={onAddTab} />
    ));
    const addBtn = screen.getByRole("button", { name: /Add custom tab/i });
    fireEvent.click(addBtn);
    expect(onAddTab).toHaveBeenCalledOnce();
  });

  it("does not render the '+' button when onAddTab is undefined", () => {
    const onTabChange = vi.fn();
    render(() => (
      <TabBar activeTab="issues" onTabChange={onTabChange} />
    ));
    expect(screen.queryByRole("button", { name: /Add custom tab/i })).toBeNull();
  });

  it("renders edit pencil button when onEditTab is provided", () => {
    const onTabChange = vi.fn();
    const onEditTab = vi.fn();
    render(() => (
      <TabBar
        activeTab="issues"
        onTabChange={onTabChange}
        customTabs={[{ id: "tab-alpha", name: "Alpha" }]}
        onEditTab={onEditTab}
      />
    ));
    screen.getByRole("button", { name: /Edit Alpha/i });
  });

  it("fires onEditTab with the correct tab id when edit button clicked", () => {
    const onTabChange = vi.fn();
    const onEditTab = vi.fn();
    render(() => (
      <TabBar
        activeTab="issues"
        onTabChange={onTabChange}
        customTabs={[
          { id: "tab-alpha", name: "Alpha" },
          { id: "tab-beta", name: "Beta" },
        ]}
        onEditTab={onEditTab}
      />
    ));
    const editBeta = screen.getByRole("button", { name: /Edit Beta/i });
    fireEvent.click(editBeta);
    expect(onEditTab).toHaveBeenCalledWith("tab-beta");
    expect(onEditTab).not.toHaveBeenCalledWith("tab-alpha");
  });

  it("does not render edit pencil buttons when onEditTab is undefined", () => {
    const onTabChange = vi.fn();
    render(() => (
      <TabBar
        activeTab="issues"
        onTabChange={onTabChange}
        customTabs={[{ id: "tab-alpha", name: "Alpha" }]}
      />
    ));
    expect(screen.queryByRole("button", { name: /Edit Alpha/i })).toBeNull();
  });
});
