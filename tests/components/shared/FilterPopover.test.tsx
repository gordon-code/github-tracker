import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import FilterPopover from "../../../src/app/components/shared/FilterPopover";
import type { FilterChipGroupDef } from "../../../src/app/components/shared/filterTypes";

const reviewGroup: FilterChipGroupDef = {
  label: "Review",
  field: "reviewDecision",
  options: [
    { value: "APPROVED", label: "Approved" },
    { value: "CHANGES_REQUESTED", label: "Changes requested" },
  ],
};

const scopeGroup: FilterChipGroupDef = {
  label: "Scope",
  field: "scope",
  defaultValue: "involves_me",
  options: [
    { value: "involves_me", label: "Involves me" },
    { value: "all", label: "All activity" },
  ],
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("FilterPopover", () => {
  it("renders trigger with group label when no active filter", () => {
    render(() => <FilterPopover group={reviewGroup} value="all" onChange={() => {}} />);
    const trigger = screen.getByRole("button", { name: /Filter by Review/i });
    expect(trigger.textContent).toContain("Review");
  });

  it("has btn-ghost class when value is default ('all')", () => {
    render(() => <FilterPopover group={reviewGroup} value="all" onChange={() => {}} />);
    const trigger = screen.getByRole("button", { name: /Filter by Review/i });
    expect(trigger.className).toContain("btn-ghost");
    expect(trigger.className).not.toContain("btn-primary");
  });

  it("has btn-primary class and 'Review: Approved' text when value is 'APPROVED'", () => {
    render(() => <FilterPopover group={reviewGroup} value="APPROVED" onChange={() => {}} />);
    const trigger = screen.getByRole("button", { name: /Filter by Review/i });
    expect(trigger.className).toContain("btn-primary");
    expect(trigger.textContent).toContain("Review: Approved");
  });

  it("has aria-label='Filter by Review' on trigger", () => {
    render(() => <FilterPopover group={reviewGroup} value="all" onChange={() => {}} />);
    screen.getByRole("button", { name: "Filter by Review" });
  });

  it("clicking trigger opens popover", () => {
    render(() => <FilterPopover group={reviewGroup} value="all" onChange={() => {}} />);
    const trigger = screen.getByRole("button", { name: /Filter by Review/i });
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("popover shows 'All' option plus options when group has no defaultValue", () => {
    render(() => <FilterPopover group={reviewGroup} value="all" onChange={() => {}} />);
    const trigger = screen.getByRole("button", { name: /Filter by Review/i });
    fireEvent.click(trigger);
    vi.advanceTimersByTime(0);
    // "All" option should appear as a button in the popover
    const buttons = screen.getAllByRole("button").filter(b => b !== trigger);
    const allBtn = buttons.find(b => b.textContent?.includes("All"));
    expect(allBtn).toBeDefined();
    screen.getByText("Approved");
    screen.getByText("Changes requested");
  });

  it("popover shows only options when group has defaultValue (no extra 'All')", () => {
    render(() => <FilterPopover group={scopeGroup} value="involves_me" onChange={() => {}} />);
    const trigger = screen.getByRole("button", { name: /Filter by Scope/i });
    fireEvent.click(trigger);
    vi.advanceTimersByTime(0);
    // Should not have a standalone "All" button (scopeGroup has defaultValue)
    const allBtn = screen.queryAllByRole("button").filter(
      (b) => b !== trigger && (b.textContent?.trim() === "All" || b.textContent?.trim() === "✓ All")
    );
    expect(allBtn.length).toBe(0);
    // Options from scopeGroup should be visible (either inline or in portal)
    const hasInvolves = screen.queryAllByText(/Involves me/i).length > 0
      || document.body.textContent?.includes("Involves me");
    const hasAllActivity = screen.queryAllByText(/All activity/i).length > 0
      || document.body.textContent?.includes("All activity");
    expect(hasInvolves).toBe(true);
    expect(hasAllActivity).toBe(true);
  });

  it("selected option shows ✓ prefix", () => {
    render(() => <FilterPopover group={reviewGroup} value="APPROVED" onChange={() => {}} />);
    const trigger = screen.getByRole("button", { name: /Filter by Review/i });
    fireEvent.click(trigger);
    vi.advanceTimersByTime(0);
    const buttons = screen.getAllByRole("button").filter(b => b !== trigger);
    const approvedBtn = buttons.find(b => b.textContent?.includes("Approved"));
    expect(approvedBtn?.textContent).toContain("✓");
  });

  it("clicking option calls onChange and closes popover", () => {
    const onChange = vi.fn();
    render(() => <FilterPopover group={reviewGroup} value="all" onChange={onChange} />);
    const trigger = screen.getByRole("button", { name: /Filter by Review/i });
    fireEvent.click(trigger);
    vi.advanceTimersByTime(0);
    const approvedBtn = screen.getByText("Approved");
    fireEvent.click(approvedBtn);
    expect(onChange).toHaveBeenCalledWith("reviewDecision", "APPROVED");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("selecting 'All' calls onChange(field, 'all')", () => {
    const onChange = vi.fn();
    render(() => <FilterPopover group={reviewGroup} value="APPROVED" onChange={onChange} />);
    const trigger = screen.getByRole("button", { name: /Filter by Review/i });
    fireEvent.click(trigger);
    vi.advanceTimersByTime(0);
    const buttons = screen.getAllByRole("button").filter(b => b !== trigger);
    const allBtn = buttons.find(b => b.textContent?.includes("All"));
    fireEvent.click(allBtn!);
    expect(onChange).toHaveBeenCalledWith("reviewDecision", "all");
  });

  it("Escape closes popover", () => {
    render(() => <FilterPopover group={reviewGroup} value="all" onChange={() => {}} />);
    const trigger = screen.getByRole("button", { name: /Filter by Review/i });
    fireEvent.click(trigger);
    vi.advanceTimersByTime(0);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("Escape closes popover (focus management)", () => {
    render(() => <FilterPopover group={reviewGroup} value="all" onChange={() => {}} />);
    const trigger = screen.getByRole("button", { name: /Filter by Review/i });
    fireEvent.click(trigger);
    vi.advanceTimersByTime(0);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(document, { key: "Escape" });
    vi.advanceTimersByTime(0);
    // Popover is closed; focus is managed by Kobalte (returns to trigger or nearby element)
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("selected option has aria-pressed='true', unselected has 'false'", () => {
    render(() => <FilterPopover group={reviewGroup} value="APPROVED" onChange={() => {}} />);
    const trigger = screen.getByRole("button", { name: /Filter by Review/i });
    fireEvent.click(trigger);
    vi.advanceTimersByTime(0);
    const buttons = screen.getAllByRole("button").filter(b => b !== trigger);
    const approvedBtn = buttons.find(b => b.textContent?.includes("Approved"));
    expect(approvedBtn?.getAttribute("aria-pressed")).toBe("true");
    const changesBtn = buttons.find(b => b.textContent?.includes("Changes requested"));
    expect(changesBtn?.getAttribute("aria-pressed")).toBe("false");
  });

  it("'All' button has aria-pressed='true' when value is 'all'", () => {
    render(() => <FilterPopover group={reviewGroup} value="all" onChange={() => {}} />);
    const trigger = screen.getByRole("button", { name: /Filter by Review/i });
    fireEvent.click(trigger);
    vi.advanceTimersByTime(0);
    const buttons = screen.getAllByRole("button").filter(b => b !== trigger);
    const allBtn = buttons.find(b => b.textContent?.includes("All"));
    expect(allBtn?.getAttribute("aria-pressed")).toBe("true");
    const approvedBtn = buttons.find(b => b.textContent?.includes("Approved"));
    expect(approvedBtn?.getAttribute("aria-pressed")).toBe("false");
  });

  it("popover content has aria-label with group label", () => {
    render(() => <FilterPopover group={reviewGroup} value="all" onChange={() => {}} />);
    const trigger = screen.getByRole("button", { name: /Filter by Review/i });
    fireEvent.click(trigger);
    vi.advanceTimersByTime(0);
    const content = document.querySelector("[aria-label='Review']");
    expect(content).toBeTruthy();
  });

  it("shows raw value as label for unknown/stale filter values", () => {
    render(() => <FilterPopover group={reviewGroup} value="STALE_VALUE" onChange={() => {}} />);
    const trigger = screen.getByRole("button", { name: /Filter by Review/i });
    expect(trigger.className).toContain("btn-primary");
    expect(trigger.textContent).toContain("Review: STALE_VALUE");
  });
});
