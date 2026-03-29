import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import ExpandCollapseButtons from "../../src/app/components/shared/ExpandCollapseButtons";

describe("ExpandCollapseButtons", () => {
  it("renders both buttons with correct aria-labels", () => {
    render(() => <ExpandCollapseButtons onExpandAll={() => {}} onCollapseAll={() => {}} />);
    expect(screen.getByRole("button", { name: "Expand all" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Collapse all" })).toBeTruthy();
  });

  it("calls onExpandAll when expand button is clicked", () => {
    const onExpandAll = vi.fn();
    render(() => <ExpandCollapseButtons onExpandAll={onExpandAll} onCollapseAll={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    expect(onExpandAll).toHaveBeenCalledTimes(1);
  });

  it("calls onCollapseAll when collapse button is clicked", () => {
    const onCollapseAll = vi.fn();
    render(() => <ExpandCollapseButtons onExpandAll={() => {}} onCollapseAll={onCollapseAll} />);
    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(onCollapseAll).toHaveBeenCalledTimes(1);
  });
});
