import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import ItemRow from "../../src/app/components/dashboard/ItemRow";

const defaultProps = {
  repo: "octocat/Hello-World",
  number: 42,
  title: "Fix a bug",
  author: "octocat",
  createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2h ago
  url: "https://github.com/octocat/Hello-World/issues/42",
  labels: [{ name: "bug", color: "d73a4a" }],
  onIgnore: vi.fn(),
  density: "comfortable" as const,
};

describe("ItemRow", () => {
  it("renders repo badge", () => {
    render(() => <ItemRow {...defaultProps} />);
    expect(screen.getByText("octocat/Hello-World")).toBeDefined();
  });

  it("renders issue number and title", () => {
    render(() => <ItemRow {...defaultProps} />);
    expect(screen.getByText("#42")).toBeDefined();
    expect(screen.getByText("Fix a bug")).toBeDefined();
  });

  it("renders author", () => {
    render(() => <ItemRow {...defaultProps} />);
    expect(screen.getByText("octocat")).toBeDefined();
  });

  it("renders label chip with correct name", () => {
    render(() => <ItemRow {...defaultProps} />);
    expect(screen.getByText("bug")).toBeDefined();
  });

  it("renders relative time for createdAt", () => {
    render(() => <ItemRow {...defaultProps} />);
    // Should show something like "2 hours ago"
    const timeEl = screen.getByTitle(defaultProps.createdAt);
    expect(timeEl).toBeDefined();
    expect(timeEl.textContent).toMatch(/hour/i);
  });

  it("renders children slot when provided", () => {
    render(() => (
      <ItemRow {...defaultProps}>
        <span data-testid="child-slot">extra content</span>
      </ItemRow>
    ));
    expect(screen.getByTestId("child-slot")).toBeDefined();
  });

  it("does not render children slot when not provided", () => {
    render(() => <ItemRow {...defaultProps} />);
    expect(screen.queryByTestId("child-slot")).toBeNull();
  });

  it("opens url in new tab when row is clicked", () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    render(() => <ItemRow {...defaultProps} />);

    // Click on the title text to trigger row click
    const titleEl = screen.getByText("Fix a bug");
    fireEvent.click(titleEl);

    expect(openSpy).toHaveBeenCalledWith(
      defaultProps.url,
      "_blank",
      "noopener,noreferrer"
    );
    openSpy.mockRestore();
  });

  it("calls onIgnore when ignore button is clicked", () => {
    const onIgnore = vi.fn();
    render(() => <ItemRow {...defaultProps} onIgnore={onIgnore} />);

    const ignoreBtn = screen.getByLabelText(/Ignore #42/i);
    fireEvent.click(ignoreBtn);

    expect(onIgnore).toHaveBeenCalledOnce();
  });

  it("does not open URL when ignore button is clicked", () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    const onIgnore = vi.fn();
    render(() => <ItemRow {...defaultProps} onIgnore={onIgnore} />);

    const ignoreBtn = screen.getByLabelText(/Ignore #42/i);
    fireEvent.click(ignoreBtn);

    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it("applies compact padding in compact density", () => {
    const { container } = render(() => (
      <ItemRow {...defaultProps} density="compact" />
    ));
    const row = container.querySelector("[role='row']");
    expect(row?.className).toContain("py-2");
  });

  it("applies comfortable padding in comfortable density", () => {
    const { container } = render(() => (
      <ItemRow {...defaultProps} density="comfortable" />
    ));
    const row = container.querySelector("[role='row']");
    expect(row?.className).toContain("py-3");
  });

  it("renders no labels section when labels array is empty", () => {
    render(() => <ItemRow {...defaultProps} labels={[]} />);
    expect(screen.queryByText("bug")).toBeNull();
  });
});
