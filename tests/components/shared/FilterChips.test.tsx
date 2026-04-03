import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import FilterChips from "../../../src/app/components/shared/FilterChips";
import type { FilterChipGroupDef } from "../../../src/app/components/shared/FilterChips";

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function renderChips(opts: {
  groups: FilterChipGroupDef[];
  values?: Record<string, string>;
  onChange?: (field: string, value: string) => void;
  onReset?: (field: string) => void;
  onResetAll?: () => void;
}) {
  const onChange = opts.onChange ?? vi.fn();
  const onReset = opts.onReset ?? vi.fn();
  const onResetAll = opts.onResetAll ?? vi.fn();
  return render(() => (
    <FilterChips
      groups={opts.groups}
      values={opts.values ?? {}}
      onChange={onChange}
      onReset={onReset}
      onResetAll={onResetAll}
    />
  ));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("FilterChips — standard group (no defaultValue)", () => {
  const groups: FilterChipGroupDef[] = [
    {
      label: "Role",
      field: "role",
      options: [
        { value: "author", label: "Author" },
        { value: "reviewer", label: "Reviewer" },
      ],
    },
  ];

  it("renders the auto-generated 'All' button when no defaultValue", () => {
    renderChips({ groups });
    screen.getByText("All");
  });

  it("'All' button is aria-pressed=true when value is 'all' (default)", () => {
    renderChips({ groups, values: { role: "all" } });
    const allBtn = screen.getByText("All");
    expect(allBtn.getAttribute("aria-pressed")).toBe("true");
  });

  it("does not show reset '×' button when filter is at default 'all'", () => {
    renderChips({ groups, values: { role: "all" } });
    expect(screen.queryByLabelText("Reset Role filter")).toBeNull();
  });

  it("shows reset '×' button when a non-default option is selected", () => {
    renderChips({ groups, values: { role: "author" } });
    screen.getByLabelText("Reset Role filter");
  });

  it("shows 'Reset all' button when filter differs from default", () => {
    renderChips({ groups, values: { role: "author" } });
    screen.getByText("Reset all");
  });

  it("does not show 'Reset all' button when filter is at default", () => {
    renderChips({ groups, values: { role: "all" } });
    expect(screen.queryByText("Reset all")).toBeNull();
  });
});

describe("FilterChips — group with defaultValue", () => {
  const groups: FilterChipGroupDef[] = [
    {
      label: "Scope",
      field: "scope",
      defaultValue: "involves_me",
      options: [
        { value: "involves_me", label: "Involves me" },
        { value: "all", label: "All activity" },
      ],
    },
  ];

  it("does NOT render auto-generated 'All' button when defaultValue is set", () => {
    renderChips({ groups });
    // "All activity" is an option, but "All" (auto-generated) should not appear
    expect(screen.queryByText("All")).toBeNull();
    // The "All activity" option should still be present
    screen.getByText("All activity");
  });

  it("'Involves me' button is aria-pressed=true when value equals defaultValue", () => {
    renderChips({ groups, values: { scope: "involves_me" } });
    const btn = screen.getByText("Involves me");
    expect(btn.getAttribute("aria-pressed")).toBe("true");
  });

  it("does not show reset '×' button when value equals defaultValue", () => {
    renderChips({ groups, values: { scope: "involves_me" } });
    expect(screen.queryByLabelText("Reset Scope filter")).toBeNull();
  });

  it("shows reset '×' button when value differs from defaultValue", () => {
    renderChips({ groups, values: { scope: "all" } });
    screen.getByLabelText("Reset Scope filter");
  });

  it("'All activity' button is aria-pressed=true when value is 'all'", () => {
    renderChips({ groups, values: { scope: "all" } });
    const btn = screen.getByText("All activity");
    expect(btn.getAttribute("aria-pressed")).toBe("true");
  });

  it("shows 'Reset all' when value differs from defaultValue", () => {
    renderChips({ groups, values: { scope: "all" } });
    screen.getByText("Reset all");
  });

  it("does not show 'Reset all' when value equals defaultValue", () => {
    renderChips({ groups, values: { scope: "involves_me" } });
    expect(screen.queryByText("Reset all")).toBeNull();
  });

  it("does not show 'Reset all' when values object is empty (defaults apply)", () => {
    renderChips({ groups, values: {} });
    expect(screen.queryByText("Reset all")).toBeNull();
  });
});

describe("FilterChips — mixed groups (one standard, one with defaultValue)", () => {
  const groups: FilterChipGroupDef[] = [
    {
      label: "Scope",
      field: "scope",
      defaultValue: "involves_me",
      options: [
        { value: "involves_me", label: "Involves me" },
        { value: "all", label: "All activity" },
      ],
    },
    {
      label: "Role",
      field: "role",
      options: [
        { value: "author", label: "Author" },
        { value: "reviewer", label: "Reviewer" },
      ],
    },
  ];

  it("shows 'All' for standard group but not for defaultValue group", () => {
    renderChips({ groups });
    // "All" is the auto-generated button for Role group only
    const allButtons = screen.getAllByText("All");
    expect(allButtons).toHaveLength(1);
    // "All activity" is an option for Scope group
    screen.getByText("All activity");
  });

  it("shows 'Reset all' only when at least one filter differs from its default", () => {
    // scope at default, role at default
    renderChips({ groups, values: { scope: "involves_me", role: "all" } });
    expect(screen.queryByText("Reset all")).toBeNull();
  });

  it("shows 'Reset all' when scope differs from defaultValue", () => {
    renderChips({ groups, values: { scope: "all", role: "all" } });
    screen.getByText("Reset all");
  });

  it("shows 'Reset all' when role differs from 'all'", () => {
    renderChips({ groups, values: { scope: "involves_me", role: "author" } });
    screen.getByText("Reset all");
  });

  it("calls onChange when a chip is clicked", () => {
    const onChange = vi.fn();
    renderChips({ groups, onChange });
    fireEvent.click(screen.getByText("All activity"));
    expect(onChange).toHaveBeenCalledWith("scope", "all");
  });

  it("calls onReset when reset '×' button is clicked", () => {
    const onReset = vi.fn();
    renderChips({ groups, values: { scope: "all" }, onReset });
    fireEvent.click(screen.getByLabelText("Reset Scope filter"));
    expect(onReset).toHaveBeenCalledWith("scope");
  });

  it("calls onResetAll when 'Reset all' is clicked", () => {
    const onResetAll = vi.fn();
    renderChips({ groups, values: { scope: "all" }, onResetAll });
    fireEvent.click(screen.getByText("Reset all"));
    expect(onResetAll).toHaveBeenCalled();
  });
});
