import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import IgnoreBadge from "../../src/app/components/dashboard/IgnoreBadge";
import type { IgnoredItem } from "../../src/app/stores/view";

function makeIgnoredItem(overrides: Partial<IgnoredItem> = {}): IgnoredItem {
  return {
    id: String(Math.floor(Math.random() * 100000)),
    type: "issue",
    repo: "owner/repo",
    title: "Test item",
    ignoredAt: Date.now(),
    ...overrides,
  };
}

describe("IgnoreBadge", () => {
  it("renders nothing when items is empty", () => {
    const { container } = render(() => (
      <IgnoreBadge items={[]} onUnignore={() => {}} />
    ));
    expect(container.firstChild).toBeNull();
  });

  it("shows count of ignored items in badge", () => {
    const items = [makeIgnoredItem(), makeIgnoredItem(), makeIgnoredItem()];
    render(() => <IgnoreBadge items={items} onUnignore={() => {}} />);
    screen.getByText("3 ignored");
  });

  it("clicking badge toggles popover open (aria-expanded)", async () => {
    const user = userEvent.setup();
    const items = [makeIgnoredItem()];
    render(() => <IgnoreBadge items={items} onUnignore={() => {}} />);
    const button = screen.getByText("1 ignored");
    // Initially closed
    expect(button.getAttribute("aria-expanded")).toBe("false");

    await user.click(button);

    // Now open
    expect(button.getAttribute("aria-expanded")).toBe("true");
  });

  it("clicking badge again closes popover", async () => {
    const user = userEvent.setup();
    const items = [makeIgnoredItem()];
    render(() => <IgnoreBadge items={items} onUnignore={() => {}} />);
    const button = screen.getByText("1 ignored");

    await user.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");

    await user.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("popover shows each ignored item with repo and title", async () => {
    const user = userEvent.setup();
    const items = [
      makeIgnoredItem({ id: "1", repo: "owner/repo-a", title: "Issue Alpha" }),
      makeIgnoredItem({ id: "2", repo: "owner/repo-b", title: "Issue Beta" }),
    ];
    render(() => <IgnoreBadge items={items} onUnignore={() => {}} />);
    await user.click(screen.getByText("2 ignored"));

    screen.getByText("Issue Alpha");
    screen.getByText("Issue Beta");
    screen.getByText("owner/repo-a");
    screen.getByText("owner/repo-b");
  });

  it("individual unignore button calls onUnignore with correct id", async () => {
    const user = userEvent.setup();
    const onUnignore = vi.fn();
    const items = [
      makeIgnoredItem({ id: "abc-123", title: "My Issue" }),
    ];
    render(() => <IgnoreBadge items={items} onUnignore={onUnignore} />);
    await user.click(screen.getByText("1 ignored"));

    const unignoreBtn = screen.getByText("Unignore");
    await user.click(unignoreBtn);

    expect(onUnignore).toHaveBeenCalledWith("abc-123");
  });

  it("'Unignore All' calls onUnignore for every item", async () => {
    const user = userEvent.setup();
    const onUnignore = vi.fn();
    const items = [
      makeIgnoredItem({ id: "1" }),
      makeIgnoredItem({ id: "2" }),
      makeIgnoredItem({ id: "3" }),
    ];
    render(() => <IgnoreBadge items={items} onUnignore={onUnignore} />);
    await user.click(screen.getByText("3 ignored"));

    const unignoreAllBtn = screen.getByText("Unignore All");
    await user.click(unignoreAllBtn);

    expect(onUnignore).toHaveBeenCalledTimes(3);
    expect(onUnignore).toHaveBeenCalledWith("1");
    expect(onUnignore).toHaveBeenCalledWith("2");
    expect(onUnignore).toHaveBeenCalledWith("3");
  });

  it("clicking backdrop closes popover", async () => {
    const user = userEvent.setup();
    const items = [makeIgnoredItem()];
    render(() => <IgnoreBadge items={items} onUnignore={() => {}} />);
    const button = screen.getByText("1 ignored");
    await user.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");

    // The backdrop is aria-hidden div with fixed positioning
    const backdrop = document.querySelector('[aria-hidden="true"]') as HTMLElement;
    expect(backdrop).toBeDefined();
    // Simulate clicking the backdrop itself (target === currentTarget)
    await user.click(backdrop);
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });
});
