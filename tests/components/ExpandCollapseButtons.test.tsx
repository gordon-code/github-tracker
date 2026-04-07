import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import ExpandCollapseButtons from "../../src/app/components/shared/ExpandCollapseButtons";

describe("ExpandCollapseButtons", () => {
  it("renders both buttons with correct aria-labels", () => {
    render(() => <ExpandCollapseButtons onExpandAll={() => {}} onCollapseAll={() => {}} />);
    expect(screen.getByRole("button", { name: "Expand all repos" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Collapse all repos" })).toBeTruthy();
  });

  it("calls onExpandAll when expand button is clicked", async () => {
    const user = userEvent.setup();
    const onExpandAll = vi.fn();
    render(() => <ExpandCollapseButtons onExpandAll={onExpandAll} onCollapseAll={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Expand all repos" }));
    expect(onExpandAll).toHaveBeenCalledTimes(1);
  });

  it("calls onCollapseAll when collapse button is clicked", async () => {
    const user = userEvent.setup();
    const onCollapseAll = vi.fn();
    render(() => <ExpandCollapseButtons onExpandAll={() => {}} onCollapseAll={onCollapseAll} />);
    await user.click(screen.getByRole("button", { name: "Collapse all repos" }));
    expect(onCollapseAll).toHaveBeenCalledTimes(1);
  });
});
