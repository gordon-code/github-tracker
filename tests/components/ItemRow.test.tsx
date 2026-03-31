import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { createSignal } from "solid-js";
import ItemRow from "../../src/app/components/dashboard/ItemRow";

const MOCK_NOW = new Date("2026-03-30T12:00:00Z").getTime();

const defaultProps = {
  repo: "octocat/Hello-World",
  number: 42,
  title: "Fix a bug",
  author: "octocat",
  createdAt: "2026-03-30T10:00:00Z", // 2h before MOCK_NOW
  updatedAt: "2026-03-30T11:30:00Z", // 30m before MOCK_NOW (differs from createdAt by >60s)
  url: "https://github.com/octocat/Hello-World/issues/42",
  labels: [{ name: "bug", color: "d73a4a" }],
  onIgnore: vi.fn(),
  density: "comfortable" as const,
};

describe("ItemRow", () => {
  beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(MOCK_NOW); });
  afterEach(() => { vi.restoreAllMocks(); });

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
    // Should show compact format like "2h"
    const timeEl = screen.getByTitle(`Created: ${new Date(defaultProps.createdAt).toLocaleString()}`);
    expect(timeEl).toBeDefined();
    expect(timeEl.textContent).toBe("2h");
  });

  it("renders children slot when provided", () => {
    render(() => (
      <ItemRow {...defaultProps}>
        <span data-testid="child-slot">extra content</span>
      </ItemRow>
    ));
    screen.getByTestId("child-slot");
  });

  it("children slot sits above overlay link (relative z-10)", () => {
    const { container } = render(() => (
      <ItemRow {...defaultProps}>
        <span data-testid="child-slot">extra content</span>
      </ItemRow>
    ));
    const childWrapper = container.querySelector("[data-testid='child-slot']")!.parentElement!;
    expect(childWrapper.className).toContain("relative");
    expect(childWrapper.className).toContain("z-10");
  });

  it("does not render children slot when not provided", () => {
    render(() => <ItemRow {...defaultProps} />);
    expect(screen.queryByTestId("child-slot")).toBeNull();
  });

  it("renders overlay link with correct href, target, rel, and aria-label", () => {
    render(() => <ItemRow {...defaultProps} />);
    const link = screen.getByRole("link", { name: /octocat\/Hello-World #42: Fix a bug/ });
    expect(link.getAttribute("href")).toBe(defaultProps.url);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("does not render overlay link for non-GitHub URLs", () => {
    render(() => <ItemRow {...defaultProps} url="https://evil.com/bad" />);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("calls onIgnore when ignore button is clicked", async () => {
    const user = userEvent.setup();
    const onIgnore = vi.fn();
    render(() => <ItemRow {...defaultProps} onIgnore={onIgnore} />);

    const ignoreBtn = screen.getByLabelText(/Ignore #42/i);
    await user.click(ignoreBtn);

    expect(onIgnore).toHaveBeenCalledOnce();
  });

  it("ignore button has relative z-10 to sit above overlay link", () => {
    render(() => <ItemRow {...defaultProps} />);
    const ignoreBtn = screen.getByLabelText(/Ignore #42/i);
    expect(ignoreBtn.className).toContain("relative");
    expect(ignoreBtn.className).toContain("z-10");
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

  it("applies shimmer class when isPolling is true", () => {
    const { container } = render(() => <ItemRow {...defaultProps} isPolling={true} />);
    expect(container.firstElementChild?.classList.contains("animate-shimmer")).toBe(true);
    expect(container.querySelector(".loading-spinner")).toBeTruthy();
  });

  it("does not apply shimmer class when isPolling is false", () => {
    const { container } = render(() => <ItemRow {...defaultProps} isPolling={false} />);
    expect(container.firstElementChild?.classList.contains("animate-shimmer")).toBe(false);
    expect(container.querySelector(".loading-spinner")).toBeFalsy();
  });

  it("does not apply shimmer class when isPolling is omitted", () => {
    const { container } = render(() => <ItemRow {...defaultProps} />);
    expect(container.firstElementChild?.classList.contains("animate-shimmer")).toBe(false);
    expect(container.querySelector(".loading-spinner")).toBeFalsy();
  });

  it("applies flash class when isFlashing is true", () => {
    const { container } = render(() => <ItemRow {...defaultProps} isFlashing={true} />);
    expect(container.firstElementChild?.classList.contains("animate-flash")).toBe(true);
  });

  it("does not apply flash class when isFlashing is false", () => {
    const { container } = render(() => <ItemRow {...defaultProps} isFlashing={false} />);
    expect(container.firstElementChild?.classList.contains("animate-flash")).toBe(false);
  });

  it("flash takes precedence over shimmer", () => {
    const { container } = render(() => <ItemRow {...defaultProps} isFlashing={true} isPolling={true} />);
    expect(container.firstElementChild?.classList.contains("animate-flash")).toBe(true);
    expect(container.firstElementChild?.classList.contains("animate-shimmer")).toBe(false);
  });

  it("shows both dates when updatedAt meaningfully differs from createdAt", () => {
    const { container } = render(() => <ItemRow {...defaultProps} />);
    // createdAt=2h ago → "2h", updatedAt=30m ago → "30m"
    expect(screen.getByTitle(`Created: ${new Date(defaultProps.createdAt).toLocaleString()}`).textContent).toBe("2h");
    expect(screen.getByTitle(`Updated: ${new Date(defaultProps.updatedAt).toLocaleString()}`).textContent).toBe("30m");
    // Middle dot separator is a <span> with aria-hidden
    const dot = container.querySelector('span[aria-hidden="true"]');
    expect(dot).not.toBeNull();
    expect(dot!.textContent).toBe("\u00B7");
  });

  it("shows single date when updatedAt is within 60s of createdAt", () => {
    const { container } = render(() => (
      <ItemRow
        {...defaultProps}
        createdAt="2026-03-30T11:59:00Z"
        updatedAt="2026-03-30T11:59:30Z"
      />
    ));
    // Only one time span — no dot separator span
    expect(container.querySelector('span[aria-hidden="true"]')).toBeNull();
    expect(screen.queryByTitle(`Updated: ${new Date("2026-03-30T11:59:30Z").toLocaleString()}`)).toBeNull();
  });

  it("shows single date when updatedAt is exactly 60s after createdAt", () => {
    const { container } = render(() => (
      <ItemRow
        {...defaultProps}
        createdAt="2026-03-30T11:59:00Z"
        updatedAt="2026-03-30T12:00:00Z"
      />
    ));
    // diff === 60_000ms, condition is <=, so still suppressed
    expect(container.querySelector('span[aria-hidden="true"]')).toBeNull();
  });

  it("shows single date when both compact values are identical (display-equality guard)", () => {
    // Both 3 days ago — createdAt 3d+2min ago, updatedAt exactly 3d ago, both display "3d"
    const createdAt = new Date(MOCK_NOW - (3 * 24 * 60 * 60 + 2 * 60) * 1000).toISOString();
    const updatedAt = new Date(MOCK_NOW - 3 * 24 * 60 * 60 * 1000).toISOString();
    const { container } = render(() => (
      <ItemRow {...defaultProps} createdAt={createdAt} updatedAt={updatedAt} />
    ));
    // diff > 60s but both show "3d" — no dot separator span
    expect(container.querySelector('span[aria-hidden="true"]')).toBeNull();
    expect(screen.getByTitle(`Created: ${new Date(createdAt).toLocaleString()}`).textContent).toBe("3d");
  });

  it("shows verbose aria-label for created and updated spans", () => {
    render(() => <ItemRow {...defaultProps} />);
    const createdSpan = screen.getByTitle(`Created: ${new Date(defaultProps.createdAt).toLocaleString()}`);
    const updatedSpan = screen.getByTitle(`Updated: ${new Date(defaultProps.updatedAt).toLocaleString()}`);
    expect(createdSpan.getAttribute("aria-label")).toMatch(/^Created 2 hours? ago$/);
    expect(updatedSpan.getAttribute("aria-label")).toMatch(/^Updated 30 minutes? ago$/);
  });

  it("refreshTick forces time display update", () => {
    const [tick, setTick] = createSignal(0);
    let mockNow = MOCK_NOW;
    vi.spyOn(Date, "now").mockImplementation(() => mockNow);

    // createdAt is 2h before MOCK_NOW → displays "2h"
    // updatedAt is 30m before MOCK_NOW → displays "30m"
    render(() => (
      <ItemRow
        {...defaultProps}
        refreshTick={tick()}
      />
    ));
    expect(screen.getByTitle(`Created: ${new Date(defaultProps.createdAt).toLocaleString()}`).textContent).toBe("2h");
    expect(screen.getByTitle(`Updated: ${new Date(defaultProps.updatedAt).toLocaleString()}`).textContent).toBe("30m");

    // Advance mock time by 3 hours and bump refreshTick
    mockNow = MOCK_NOW + 3 * 60 * 60 * 1000;
    setTick(1);

    expect(screen.getByTitle(`Created: ${new Date(defaultProps.createdAt).toLocaleString()}`).textContent).toBe("5h");
    // updatedAt was 30m before MOCK_NOW; after +3h it is 3h30m ago → Math.floor(210/60) = 3 → "3h"
    expect(screen.getByTitle(`Updated: ${new Date(defaultProps.updatedAt).toLocaleString()}`).textContent).toBe("3h");
  });
});
