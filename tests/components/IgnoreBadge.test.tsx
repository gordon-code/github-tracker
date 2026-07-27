import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import IgnoreBadge from "../../src/app/components/dashboard/IgnoreBadge";
import type { IgnoredItem } from "../../src/app/stores/view";

function makeIgnoredItem(overrides: Partial<IgnoredItem> = {}): IgnoredItem {
  return {
    id: Math.floor(Math.random() * 100000),
    type: "issue",
    repo: "owner/repo",
    title: "Test item",
    ignoredAt: Date.now(),
    ...overrides,
  };
}

// Helper to get the trigger button by aria-label pattern
function getTrigger(count: number) {
  return screen.getByRole("button", { name: new RegExp(`${count} ignored`, "i") });
}

describe("IgnoreBadge", () => {
  it("renders nothing when items is empty", () => {
    const { container } = render(() => (
      <IgnoreBadge items={[]} onUnignore={() => {}} />
    ));
    expect(container.firstChild).toBeNull();
  });

  it("shows count badge on the trigger button", () => {
    const items = [makeIgnoredItem(), makeIgnoredItem(), makeIgnoredItem()];
    render(() => <IgnoreBadge items={items} onUnignore={() => {}} />);
    // The count badge span shows the number
    expect(screen.getByText("3")).toBeDefined();
    // The button has accessible aria-label
    getTrigger(3);
  });

  it("clicking badge toggles popover open (aria-expanded)", async () => {
    const user = userEvent.setup();
    const items = [makeIgnoredItem()];
    render(() => <IgnoreBadge items={items} onUnignore={() => {}} />);
    const button = getTrigger(1);
    // Initially closed
    expect(button.getAttribute("aria-expanded")).toBe("false");

    await user.click(button);

    // Now open
    expect(button.getAttribute("aria-expanded")).toBe("true");

    // Regression guard: popover content must retain z-50 so it stacks above
    // surrounding dashboard content (fix(ui): adds missing z-50 to IgnoreBadge popover content).
    const content = document.querySelector("[aria-label='Ignored items']");
    expect(content?.className).toContain("z-50");
  });

  it("clicking badge again closes popover", async () => {
    const user = userEvent.setup();
    const items = [makeIgnoredItem()];
    render(() => <IgnoreBadge items={items} onUnignore={() => {}} />);
    const button = getTrigger(1);

    await user.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");

    await user.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("popover shows each ignored item with repo and title", async () => {
    const user = userEvent.setup();
    const items = [
      makeIgnoredItem({ id: 1, repo: "owner/repo-a", title: "Issue Alpha" }),
      makeIgnoredItem({ id: 2, repo: "owner/repo-b", title: "Issue Beta" }),
    ];
    render(() => <IgnoreBadge items={items} onUnignore={() => {}} />);
    await user.click(getTrigger(2));

    screen.getByText("Issue Alpha");
    screen.getByText("Issue Beta");
    screen.getByText("owner/repo-a");
    screen.getByText("owner/repo-b");
  });

  it("individual unignore button calls onUnignore with correct id", async () => {
    const user = userEvent.setup();
    const onUnignore = vi.fn();
    const items = [
      makeIgnoredItem({ id: 123, title: "My Issue" }),
      makeIgnoredItem({ id: 456, title: "Another Issue" }),
    ];
    render(() => <IgnoreBadge items={items} onUnignore={onUnignore} />);
    const button = getTrigger(2);
    await user.click(button);

    const unignoreBtns = screen.getAllByText("Unignore");
    await user.click(unignoreBtns[0]);

    expect(onUnignore).toHaveBeenCalledWith(123);
    // Deliberate behavior: individual "Unignore" clicks must NOT close the
    // popover — only "Unignore All" does. Verify with 2+ items remaining so
    // the click doesn't trivially empty the list.
    expect(button.getAttribute("aria-expanded")).toBe("true");
  });

  it("'Unignore All' calls onUnignore for every item", async () => {
    const user = userEvent.setup();
    const onUnignore = vi.fn();
    const items = [
      makeIgnoredItem({ id: 1 }),
      makeIgnoredItem({ id: 2 }),
      makeIgnoredItem({ id: 3 }),
    ];
    render(() => <IgnoreBadge items={items} onUnignore={onUnignore} />);
    await user.click(getTrigger(3));

    const unignoreAllBtn = screen.getByText("Unignore All");
    await user.click(unignoreAllBtn);

    expect(onUnignore).toHaveBeenCalledTimes(3);
    expect(onUnignore).toHaveBeenCalledWith(1);
    expect(onUnignore).toHaveBeenCalledWith(2);
    expect(onUnignore).toHaveBeenCalledWith(3);
  });

  it("clicking outside closes popover", async () => {
    const user = userEvent.setup();
    const items = [makeIgnoredItem()];
    render(() => <IgnoreBadge items={items} onUnignore={() => {}} />);
    const button = getTrigger(1);
    await user.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");

    // Kobalte's createInteractOutside registers its document pointerdown listener
    // inside a setTimeout(0) (to avoid catching the click that opened the popover).
    // This file uses userEvent's real-timer async model throughout, so wait a real
    // tick rather than introducing fake timers.
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.pointerDown(document.body);

    expect(button.getAttribute("aria-expanded")).toBe("false");
  });
});
