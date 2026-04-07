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
    // "All" button should appear
    const allBtn = screen.getAllByRole("button").find((b) => b.textContent?.includes("All"));
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
    const buttons = screen.getAllByRole("button");
    const approvedBtn = buttons.find((b) => b.textContent?.includes("Approved") && b !== trigger);
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
    const buttons = screen.getAllByRole("button");
    const allBtn = buttons.find((b) => b.textContent?.includes("All") && b !== trigger);
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
});
