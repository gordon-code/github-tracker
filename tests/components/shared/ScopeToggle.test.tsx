import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import ScopeToggle from "../../../src/app/components/shared/ScopeToggle";

describe("ScopeToggle", () => {
  it("renders checkbox checked when value is 'involves_me'", () => {
    render(() => <ScopeToggle value="involves_me" onChange={() => {}} />);
    const checkbox = screen.getByRole("checkbox", { name: /Scope filter/i });
    expect((checkbox as HTMLInputElement).checked).toBe(true);
  });

  it("renders checkbox unchecked when value is 'all'", () => {
    render(() => <ScopeToggle value="all" onChange={() => {}} />);
    const checkbox = screen.getByRole("checkbox", { name: /Scope filter/i });
    expect((checkbox as HTMLInputElement).checked).toBe(false);
  });

  it("shows 'Involves me' text when checked", () => {
    render(() => <ScopeToggle value="involves_me" onChange={() => {}} />);
    screen.getByText("Involves me");
  });

  it("shows 'All activity' text when unchecked", () => {
    render(() => <ScopeToggle value="all" onChange={() => {}} />);
    screen.getByText("All activity");
  });

  it("toggling calls onChange('scope', 'all') when unchecking", () => {
    const onChange = vi.fn();
    render(() => <ScopeToggle value="involves_me" onChange={onChange} />);
    const checkbox = screen.getByRole("checkbox", { name: /Scope filter/i });
    fireEvent.click(checkbox);
    expect(onChange).toHaveBeenCalledWith("scope", "all");
  });

  it("toggling calls onChange('scope', 'involves_me') when checking", () => {
    const onChange = vi.fn();
    render(() => <ScopeToggle value="all" onChange={onChange} />);
    const checkbox = screen.getByRole("checkbox", { name: /Scope filter/i });
    fireEvent.click(checkbox);
    expect(onChange).toHaveBeenCalledWith("scope", "involves_me");
  });

  it("has aria-label='Scope filter' on checkbox", () => {
    render(() => <ScopeToggle value="involves_me" onChange={() => {}} />);
    const checkbox = screen.getByRole("checkbox", { name: "Scope filter" });
    expect(checkbox).toBeDefined();
  });
});
