import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSignal } from "solid-js";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import FilterToolbar from "../../../src/app/components/shared/FilterToolbar";
import type { FilterChipGroupDef } from "../../../src/app/components/shared/filterTypes";
import { scopeFilterGroup } from "../../../src/app/components/shared/filterTypes";

const roleGroup: FilterChipGroupDef = {
  label: "Role",
  field: "role",
  options: [
    { value: "author", label: "Author" },
    { value: "assignee", label: "Assignee" },
  ],
};

const reviewGroup: FilterChipGroupDef = {
  label: "Review",
  field: "reviewDecision",
  options: [
    { value: "APPROVED", label: "Approved" },
    { value: "CHANGES_REQUESTED", label: "Changes requested" },
  ],
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("FilterToolbar", () => {
  it("does not show ScopeToggle when no scope group", () => {
    render(() => (
      <FilterToolbar
        groups={[roleGroup]}
        values={{}}
        onChange={() => {}}
        onResetAll={() => {}}
      />
    ));
    expect(screen.queryByRole("checkbox", { name: /Scope filter/i })).toBeNull();
  });

  it("shows ScopeToggle when scope group is present", () => {
    render(() => (
      <FilterToolbar
        groups={[scopeFilterGroup, roleGroup]}
        values={{ scope: "involves_me" }}
        onChange={() => {}}
        onResetAll={() => {}}
      />
    ));
    expect(screen.getByRole("checkbox", { name: /Scope filter/i })).toBeDefined();
  });

  it("renders trigger button for each non-scope group", () => {
    render(() => (
      <FilterToolbar
        groups={[roleGroup, reviewGroup]}
        values={{}}
        onChange={() => {}}
        onResetAll={() => {}}
      />
    ));
    screen.getByRole("button", { name: /Filter by Role/i });
    screen.getByRole("button", { name: /Filter by Review/i });
  });

  it("scope group is not rendered as a popover trigger", () => {
    render(() => (
      <FilterToolbar
        groups={[scopeFilterGroup, roleGroup]}
        values={{ scope: "involves_me" }}
        onChange={() => {}}
        onResetAll={() => {}}
      />
    ));
    expect(screen.queryByRole("button", { name: /Filter by Scope/i })).toBeNull();
    screen.getByRole("button", { name: /Filter by Role/i });
  });

  it("does not show 'Reset all' when no active filters", () => {
    render(() => (
      <FilterToolbar
        groups={[roleGroup]}
        values={{ role: "all" }}
        onChange={() => {}}
        onResetAll={() => {}}
      />
    ));
    expect(screen.queryByText("Reset all")).toBeNull();
  });

  it("shows 'Reset all' when a filter is active", () => {
    render(() => (
      <FilterToolbar
        groups={[roleGroup]}
        values={{ role: "author" }}
        onChange={() => {}}
        onResetAll={() => {}}
      />
    ));
    screen.getByText("Reset all");
  });

  it("calls onResetAll when 'Reset all' is clicked", () => {
    const onResetAll = vi.fn();
    render(() => (
      <FilterToolbar
        groups={[roleGroup]}
        values={{ role: "author" }}
        onChange={() => {}}
        onResetAll={onResetAll}
      />
    ));
    fireEvent.click(screen.getByText("Reset all"));
    expect(onResetAll).toHaveBeenCalled();
  });

  it("renders correct trigger count when groups change dynamically", () => {
    const [groups, setGroups] = createSignal<FilterChipGroupDef[]>([roleGroup]);
    render(() => (
      <FilterToolbar
        groups={groups()}
        values={{}}
        onChange={() => {}}
        onResetAll={() => {}}
      />
    ));
    expect(screen.getAllByRole("button", { name: /Filter by/i })).toHaveLength(1);

    setGroups([roleGroup, reviewGroup]);
    expect(screen.getAllByRole("button", { name: /Filter by/i })).toHaveLength(2);
  });

  it("shows 'Reset all' when scope is 'all' (non-default 'involves_me') and other filters at default", () => {
    render(() => (
      <FilterToolbar
        groups={[scopeFilterGroup, roleGroup]}
        values={{ scope: "all", role: "all" }}
        onChange={() => {}}
        onResetAll={() => {}}
      />
    ));
    screen.getByText("Reset all");
  });

  it("scope toggle defaults to 'involves_me' when value not set", () => {
    render(() => (
      <FilterToolbar
        groups={[scopeFilterGroup, roleGroup]}
        values={{}}
        onChange={() => {}}
        onResetAll={() => {}}
      />
    ));
    const checkbox = screen.getByRole("checkbox", { name: /Scope filter/i });
    expect((checkbox as HTMLInputElement).checked).toBe(true);
  });
});
