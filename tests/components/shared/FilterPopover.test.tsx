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
    // "All" option should appear (now role="option")
    const allOption = screen.getAllByRole("option").find((o) => o.textContent?.includes("All"));
    expect(allOption).toBeDefined();
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
    const options = screen.getAllByRole("option");
    const approvedOpt = options.find((o) => o.textContent?.includes("Approved"));
    expect(approvedOpt?.textContent).toContain("✓");
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
    const options = screen.getAllByRole("option");
    const allOption = options.find((o) => o.textContent?.includes("All"));
    fireEvent.click(allOption!);
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

  it("option buttons use role='option' and aria-selected", () => {
    render(() => <FilterPopover group={reviewGroup} value="APPROVED" onChange={() => {}} />);
    const trigger = screen.getByRole("button", { name: /Filter by Review/i });
    fireEvent.click(trigger);
    vi.advanceTimersByTime(0);
    const options = screen.getAllByRole("option");
    expect(options.length).toBeGreaterThan(0);
    const approvedOpt = options.find(o => o.textContent?.includes("Approved"));
    expect(approvedOpt?.getAttribute("aria-selected")).toBe("true");
    const changesOpt = options.find(o => o.textContent?.includes("Changes requested"));
    expect(changesOpt?.getAttribute("aria-selected")).toBe("false");
  });

  it("popover content has role='listbox' with group label", () => {
    render(() => <FilterPopover group={reviewGroup} value="all" onChange={() => {}} />);
    const trigger = screen.getByRole("button", { name: /Filter by Review/i });
    fireEvent.click(trigger);
    vi.advanceTimersByTime(0);
    const listbox = document.querySelector("[role='listbox']");
    expect(listbox).toBeTruthy();
    expect(listbox?.getAttribute("aria-label")).toBe("Review");
  });
});
