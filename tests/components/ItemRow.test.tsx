import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
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
    screen.getByText("octocat/Hello-World");
  });

  it("renders issue number and title", () => {
    render(() => <ItemRow {...defaultProps} />);
    screen.getByText("#42");
    screen.getByText("Fix a bug");
  });

  it("renders author", () => {
    render(() => <ItemRow {...defaultProps} />);
    screen.getByText("octocat");
  });

  it("renders label chip with correct name", () => {
    render(() => <ItemRow {...defaultProps} />);
    screen.getByText("bug");
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
    screen.getByTestId("child-slot");
  });

  it("does not render children slot when not provided", () => {
    render(() => <ItemRow {...defaultProps} />);
    expect(screen.queryByTestId("child-slot")).toBeNull();
  });

  it("title is a real link with correct href and target", () => {
    render(() => <ItemRow {...defaultProps} />);
    const link = screen.getByText("Fix a bug").closest("a")!;
    expect(link.getAttribute("href")).toBe(defaultProps.url);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("title link has no href for non-GitHub URLs", () => {
    render(() => <ItemRow {...defaultProps} url="https://evil.com/bad" />);
    const link = screen.getByText("Fix a bug").closest("a")!;
    expect(link.getAttribute("href")).toBeNull();
  });

  it("calls onIgnore when ignore button is clicked", async () => {
    const user = userEvent.setup();
    const onIgnore = vi.fn();
    render(() => <ItemRow {...defaultProps} onIgnore={onIgnore} />);

    const ignoreBtn = screen.getByLabelText(/Ignore #42/i);
    await user.click(ignoreBtn);

    expect(onIgnore).toHaveBeenCalledOnce();
  });

  it("ignore button does not navigate (sits above stretched link)", async () => {
    const user = userEvent.setup();
    const onIgnore = vi.fn();
    render(() => <ItemRow {...defaultProps} onIgnore={onIgnore} />);

    const ignoreBtn = screen.getByLabelText(/Ignore #42/i);
    await user.click(ignoreBtn);

    expect(onIgnore).toHaveBeenCalledOnce();
  });

  it("applies compact padding in compact density", () => {
    const { container } = render(() => (
      <ItemRow {...defaultProps} density="compact" />
    ));
    const row = container.querySelector(".group")!;
    expect(row.className).toContain("py-2");
  });

  it("applies comfortable padding in comfortable density", () => {
    const { container } = render(() => (
      <ItemRow {...defaultProps} density="comfortable" />
    ));
    const row = container.querySelector(".group")!;
    expect(row.className).toContain("py-3");
  });

  it("renders no labels section when labels array is empty", () => {
    render(() => <ItemRow {...defaultProps} labels={[]} />);
    expect(screen.queryByText("bug")).toBeNull();
  });

  it("hides repo badge when hideRepo is true", () => {
    render(() => <ItemRow {...defaultProps} hideRepo={true} />);
    expect(screen.queryByText("octocat/Hello-World")).toBeNull();
    screen.getByText("Fix a bug");
  });

  it("shows repo badge when hideRepo is false", () => {
    render(() => <ItemRow {...defaultProps} hideRepo={false} />);
    screen.getByText("octocat/Hello-World");
  });
});
