import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@solidjs/testing-library";
import RepoGroupHeader from "../../../src/app/components/shared/RepoGroupHeader";

describe("RepoGroupHeader", () => {
  const defaultProps = {
    repoFullName: "owner/repo",
    isExpanded: true,
    onToggle: vi.fn(),
  };

  it("renders repo name", () => {
    const { getByText } = render(() => <RepoGroupHeader {...defaultProps} />);
    expect(getByText("owner/repo")).toBeTruthy();
  });

  it("renders star count when provided", () => {
    const { getByLabelText } = render(() => (
      <RepoGroupHeader {...defaultProps} starCount={1234} />
    ));
    expect(getByLabelText("1234 stars")).toBeTruthy();
  });

  it("hides star count when null", () => {
    const { queryByLabelText } = render(() => (
      <RepoGroupHeader {...defaultProps} starCount={null} />
    ));
    expect(queryByLabelText(/stars/)).toBeNull();
  });

  it("hides star count when undefined", () => {
    const { queryByLabelText } = render(() => (
      <RepoGroupHeader {...defaultProps} />
    ));
    expect(queryByLabelText(/stars/)).toBeNull();
  });

  it("hides star count when zero", () => {
    const { queryByLabelText } = render(() => (
      <RepoGroupHeader {...defaultProps} starCount={0} />
    ));
    expect(queryByLabelText(/stars/)).toBeNull();
  });

  it("renders chevron rotated when collapsed", () => {
    const { container } = render(() => (
      <RepoGroupHeader {...defaultProps} isExpanded={false} />
    ));
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("class")).toContain("-rotate-90");
  });

  it("renders chevron not rotated when expanded", () => {
    const { container } = render(() => (
      <RepoGroupHeader {...defaultProps} isExpanded={true} />
    ));
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("class")).not.toContain("-rotate-90");
  });

  it("calls onToggle on button click", () => {
    const onToggle = vi.fn();
    const { getByRole } = render(() => (
      <RepoGroupHeader {...defaultProps} onToggle={onToggle} />
    ));
    fireEvent.click(getByRole("button"));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("renders children when collapsed", () => {
    const { getByText } = render(() => (
      <RepoGroupHeader {...defaultProps} isExpanded={false}>
        <span>collapsed content</span>
      </RepoGroupHeader>
    ));
    expect(getByText("collapsed content")).toBeTruthy();
  });

  it("hides children when expanded", () => {
    const { queryByText } = render(() => (
      <RepoGroupHeader {...defaultProps} isExpanded={true}>
        <span>collapsed content</span>
      </RepoGroupHeader>
    ));
    expect(queryByText("collapsed content")).toBeNull();
  });

  it("renders trailing slot", () => {
    const { getByText } = render(() => (
      <RepoGroupHeader {...defaultProps} trailing={<span>trailing</span>} />
    ));
    expect(getByText("trailing")).toBeTruthy();
  });

  it("renders badges slot", () => {
    const { getByText } = render(() => (
      <RepoGroupHeader {...defaultProps} badges={<span>badge</span>} />
    ));
    expect(getByText("badge")).toBeTruthy();
  });

  it("applies animate-reorder-highlight when isHighlighted", () => {
    const { container } = render(() => (
      <RepoGroupHeader {...defaultProps} isHighlighted={true} />
    ));
    const outer = container.firstElementChild as HTMLElement;
    expect(outer.className).toContain("animate-reorder-highlight");
  });

  it("does not apply animate-reorder-highlight when not highlighted", () => {
    const { container } = render(() => (
      <RepoGroupHeader {...defaultProps} isHighlighted={false} />
    ));
    const outer = container.firstElementChild as HTMLElement;
    expect(outer.className).not.toContain("animate-reorder-highlight");
  });

  it("sets aria-expanded correctly", () => {
    const { getByRole } = render(() => (
      <RepoGroupHeader {...defaultProps} isExpanded={true} />
    ));
    expect(getByRole("button").getAttribute("aria-expanded")).toBe("true");
  });

  it("sets aria-expanded=false when collapsed", () => {
    const { getByRole } = render(() => (
      <RepoGroupHeader {...defaultProps} isExpanded={false} />
    ));
    expect(getByRole("button").getAttribute("aria-expanded")).toBe("false");
  });
});
