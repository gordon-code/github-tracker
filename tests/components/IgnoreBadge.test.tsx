import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
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
    expect(screen.getByText("3 ignored")).toBeDefined();
  });

  it("clicking badge toggles popover open (aria-expanded)", () => {
    const items = [makeIgnoredItem()];
    render(() => <IgnoreBadge items={items} onUnignore={() => {}} />);
    const button = screen.getByText("1 ignored");
    // Initially closed
    expect(button.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(button);

    // Now open
    expect(button.getAttribute("aria-expanded")).toBe("true");
  });

  it("clicking badge again closes popover", () => {
    const items = [makeIgnoredItem()];
    render(() => <IgnoreBadge items={items} onUnignore={() => {}} />);
    const button = screen.getByText("1 ignored");

    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("popover shows each ignored item with repo and title", () => {
    const items = [
      makeIgnoredItem({ id: "1", repo: "owner/repo-a", title: "Issue Alpha" }),
      makeIgnoredItem({ id: "2", repo: "owner/repo-b", title: "Issue Beta" }),
    ];
    render(() => <IgnoreBadge items={items} onUnignore={() => {}} />);
    fireEvent.click(screen.getByText("2 ignored"));

    expect(screen.getByText("Issue Alpha")).toBeDefined();
    expect(screen.getByText("Issue Beta")).toBeDefined();
    expect(screen.getByText("owner/repo-a")).toBeDefined();
    expect(screen.getByText("owner/repo-b")).toBeDefined();
  });

  it("individual unignore button calls onUnignore with correct id", () => {
    const onUnignore = vi.fn();
    const items = [
      makeIgnoredItem({ id: "abc-123", title: "My Issue" }),
    ];
    render(() => <IgnoreBadge items={items} onUnignore={onUnignore} />);
    fireEvent.click(screen.getByText("1 ignored"));

    const unignoreBtn = screen.getByText("Unignore");
    fireEvent.click(unignoreBtn);

    expect(onUnignore).toHaveBeenCalledWith("abc-123");
  });

  it("'Unignore All' calls onUnignore for every item", () => {
    const onUnignore = vi.fn();
    const items = [
      makeIgnoredItem({ id: "1" }),
      makeIgnoredItem({ id: "2" }),
      makeIgnoredItem({ id: "3" }),
    ];
    render(() => <IgnoreBadge items={items} onUnignore={onUnignore} />);
    fireEvent.click(screen.getByText("3 ignored"));

    const unignoreAllBtn = screen.getByText("Unignore All");
    fireEvent.click(unignoreAllBtn);

    expect(onUnignore).toHaveBeenCalledTimes(3);
    expect(onUnignore).toHaveBeenCalledWith("1");
    expect(onUnignore).toHaveBeenCalledWith("2");
    expect(onUnignore).toHaveBeenCalledWith("3");
  });

  it("clicking backdrop closes popover", () => {
    const items = [makeIgnoredItem()];
    render(() => <IgnoreBadge items={items} onUnignore={() => {}} />);
    const button = screen.getByText("1 ignored");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");

    // The backdrop is aria-hidden div with fixed positioning
    const backdrop = document.querySelector('[aria-hidden="true"]') as HTMLElement;
    expect(backdrop).toBeDefined();
    // Simulate clicking the backdrop itself (target === currentTarget)
    fireEvent.click(backdrop, { target: backdrop });
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });
});
