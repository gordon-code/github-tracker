import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { createSignal } from "solid-js";
import ItemRow from "../../src/app/components/dashboard/ItemRow";
import { setConfig } from "../../src/app/stores/config";

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
    const { container } = render(() => <ItemRow {...defaultProps} />);
    // Should show compact format like "2h"
    const timeEl = container.querySelector(`time[datetime="${defaultProps.createdAt}"]`);
    expect(timeEl).not.toBeNull();
    expect(timeEl!.textContent).toBe("2h");
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

  it("ignore button wrapper has relative z-10 to sit above overlay link", () => {
    render(() => <ItemRow {...defaultProps} />);
    const ignoreBtn = screen.getByLabelText(/Ignore #42/i);
    // The Tooltip wrapper span carries relative z-10; the button itself is inside it
    const tooltipTrigger = ignoreBtn.closest("span.relative");
    expect(tooltipTrigger).not.toBeNull();
    expect(tooltipTrigger!.className).toContain("z-10");
    expect(tooltipTrigger!.className).toContain("shrink-0");
    expect(tooltipTrigger!.className).toContain("self-center");
  });

  it("outer row has both comfortable and compact variant classes", () => {
    const { container } = render(() => (
      <ItemRow {...defaultProps} />
    ));
    const row = container.querySelector(".group")!;
    expect(row.className).toContain("py-3");
    expect(row.className).toContain("compact:py-1");
  });

  describe("compact mode", () => {
    beforeEach(() => { setConfig("viewDensity", "compact"); });
    afterEach(() => { setConfig("viewDensity", "comfortable"); });

    it("renders compact layout with inline number, title, and author", () => {
      render(() => <ItemRow {...defaultProps} hideRepo />);
      screen.getByText("#42");
      screen.getByText("Fix a bug");
      screen.getByText(/octocat/);
    });

    it("shows label count indicator when labels are present", () => {
      render(() => (
        <ItemRow {...defaultProps} labels={[{ name: "bug", color: "d73a4a" }, { name: "help", color: "0075ca" }]} />
      ));
      screen.getByText("2");
    });

    it("shows comment count indicator when comments are present", () => {
      render(() => (
        <ItemRow {...defaultProps} commentCount={5} />
      ));
      screen.getByText("5");
    });

    it("renders single time element in compact mode", () => {
      const { container } = render(() => <ItemRow {...defaultProps} />);
      const timeEls = container.querySelectorAll("time");
      expect(timeEls.length).toBe(1);
    });
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
    const created = container.querySelector(`time[datetime="${defaultProps.createdAt}"]`);
    const updated = container.querySelector(`time[datetime="${defaultProps.updatedAt}"]`);
    expect(created!.textContent).toBe("2h");
    expect(updated!.textContent).toBe("30m");
    // Middle dot separator is a <span> with aria-hidden
    const dot = container.querySelector('span[aria-hidden="true"]');
    expect(dot).not.toBeNull();
    expect(dot!.textContent).toBe("\u00B7");
  });

  it("shows date tooltip content on hover", () => {
    vi.useFakeTimers();
    const { container, unmount } = render(() => <ItemRow {...defaultProps} />);
    const createdTrigger = container.querySelector(
      `time[datetime="${defaultProps.createdAt}"]`
    )?.closest("span.inline-flex");
    expect(createdTrigger).not.toBeNull();
    fireEvent.pointerEnter(createdTrigger!);
    vi.advanceTimersByTime(300);
    expect(document.body.textContent).toContain(
      `Created: ${new Date(defaultProps.createdAt).toLocaleString()}`
    );
    fireEvent.pointerLeave(createdTrigger!);
    vi.advanceTimersByTime(500);
    unmount();
    vi.useRealTimers();
  });

  it("shows updated date tooltip content on hover", () => {
    vi.useFakeTimers();
    const { container, unmount } = render(() => <ItemRow {...defaultProps} />);
    const updatedTrigger = container.querySelector(
      `time[datetime="${defaultProps.updatedAt}"]`
    )?.closest("span.inline-flex");
    expect(updatedTrigger).not.toBeNull();
    fireEvent.pointerEnter(updatedTrigger!);
    vi.advanceTimersByTime(300);
    expect(document.body.textContent).toContain(
      `Updated: ${new Date(defaultProps.updatedAt).toLocaleString()}`
    );
    fireEvent.pointerLeave(updatedTrigger!);
    vi.advanceTimersByTime(500);
    unmount();
    vi.useRealTimers();
  });

  it("shows single date when createdAt equals updatedAt (zero diff)", () => {
    const sameDate = "2026-03-30T11:00:00Z";
    const { container } = render(() => (
      <ItemRow {...defaultProps} createdAt={sameDate} updatedAt={sameDate} />
    ));
    expect(container.querySelector('span[aria-hidden="true"]')).toBeNull();
    expect(container.querySelectorAll("time").length).toBe(1);
  });

  it("shows single date when updatedAt is within 60s of createdAt", () => {
    const { container } = render(() => (
      <ItemRow
        {...defaultProps}
        createdAt="2026-03-30T11:59:00Z"
        updatedAt="2026-03-30T11:59:30Z"
      />
    ));
    // Only one time element — no dot separator
    expect(container.querySelector('span[aria-hidden="true"]')).toBeNull();
    expect(container.querySelectorAll("time").length).toBe(1);
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
    // diff > 60s but both show "3d" — no dot separator
    expect(container.querySelector('span[aria-hidden="true"]')).toBeNull();
    expect(container.querySelector(`time[datetime="${createdAt}"]`)!.textContent).toBe("3d");
  });

  it("suppresses update display when both dates are invalid", () => {
    const { container } = render(() => (
      <ItemRow {...defaultProps} createdAt="not-a-date" updatedAt="also-invalid" />
    ));
    expect(container.querySelector('span[aria-hidden="true"]')).toBeNull();
    expect(container.querySelectorAll("time").length).toBe(1);
    expect(container.querySelector("time")!.textContent).toBe("");
  });

  it("suppresses update display when createdAt is valid but updatedAt is invalid", () => {
    const { container } = render(() => (
      <ItemRow {...defaultProps} createdAt="2026-03-30T10:00:00Z" updatedAt="not-a-date" />
    ));
    expect(container.querySelector('span[aria-hidden="true"]')).toBeNull();
    expect(container.querySelectorAll("time").length).toBe(1);
  });

  it("suppresses update display when updatedAt is valid but createdAt is invalid", () => {
    const { container } = render(() => (
      <ItemRow {...defaultProps} createdAt="not-a-date" updatedAt="2026-03-30T11:30:00Z" />
    ));
    expect(container.querySelector('span[aria-hidden="true"]')).toBeNull();
    expect(container.querySelectorAll("time").length).toBe(1);
  });

  it("renders correct datetime attributes on time elements", () => {
    const { container } = render(() => <ItemRow {...defaultProps} />);
    const timeEls = container.querySelectorAll("time");
    expect(timeEls.length).toBe(2);
    expect(timeEls[0].getAttribute("datetime")).toBe(defaultProps.createdAt);
    expect(timeEls[1].getAttribute("datetime")).toBe(defaultProps.updatedAt);
  });

  it("shows verbose aria-label for created and updated spans", () => {
    const { container } = render(() => <ItemRow {...defaultProps} />);
    const created = container.querySelector(`time[datetime="${defaultProps.createdAt}"]`);
    const updated = container.querySelector(`time[datetime="${defaultProps.updatedAt}"]`);
    expect(created!.getAttribute("aria-label")).toMatch(/^Created 2 hours? ago$/);
    expect(updated!.getAttribute("aria-label")).toMatch(/^Updated 30 minutes? ago$/);
  });

  it("shows comment count tooltip with correct pluralization", () => {
    vi.useFakeTimers();
    const { container, unmount } = render(() => (
      <ItemRow {...defaultProps} commentCount={5} />
    ));
    const tooltipTriggers = container.querySelectorAll("span.inline-flex");
    const commentTrigger = Array.from(tooltipTriggers).find(
      (el) => el.textContent?.includes("5")
    );
    expect(commentTrigger).not.toBeNull();
    fireEvent.pointerEnter(commentTrigger!);
    vi.advanceTimersByTime(300);
    expect(document.body.textContent).toContain("5 total comments");
    fireEvent.pointerLeave(commentTrigger!);
    vi.advanceTimersByTime(500);
    unmount();
    vi.useRealTimers();
  });

  it("shows singular 'comment' for commentCount=1", () => {
    vi.useFakeTimers();
    const { container, unmount } = render(() => (
      <ItemRow {...defaultProps} commentCount={1} />
    ));
    const tooltipTriggers = container.querySelectorAll("span.inline-flex");
    const commentTrigger = Array.from(tooltipTriggers).find(
      (el) => el.textContent?.trim() === "1"
    );
    expect(commentTrigger).not.toBeNull();
    fireEvent.pointerEnter(commentTrigger!);
    vi.advanceTimersByTime(300);
    expect(document.body.textContent).toContain("1 total comment");
    expect(document.body.textContent).not.toContain("1 total comments");
    fireEvent.pointerLeave(commentTrigger!);
    vi.advanceTimersByTime(500);
    unmount();
    vi.useRealTimers();
  });

  it("does not render pin button when onTrack is undefined", () => {
    render(() => <ItemRow {...defaultProps} />);
    expect(screen.queryByLabelText(/Pin #42/i)).toBeNull();
    expect(screen.queryByLabelText(/Unpin #42/i)).toBeNull();
  });

  it("renders pin button when onTrack is provided", () => {
    render(() => <ItemRow {...defaultProps} onTrack={vi.fn()} />);
    expect(screen.getByLabelText(/Pin #42/i)).not.toBeNull();
  });

  it("calls onTrack when pin button clicked", async () => {
    const user = userEvent.setup();
    const onTrack = vi.fn();
    render(() => <ItemRow {...defaultProps} onTrack={onTrack} />);
    await user.click(screen.getByLabelText(/Pin #42/i));
    expect(onTrack).toHaveBeenCalledOnce();
  });

  it("shows filled pin icon (solid bookmark) when isTracked is true", () => {
    render(() => (
      <ItemRow {...defaultProps} onTrack={vi.fn()} isTracked={true} />
    ));
    // Solid bookmark uses fill="currentColor" with fill-rule="evenodd" and has no stroke attr
    const btn = screen.getByLabelText(/Unpin #42/i);
    const svg = btn.querySelector("svg");
    expect(svg?.getAttribute("fill")).toBe("currentColor");
  });

  it("shows outline pin icon (outline bookmark) when isTracked is false", () => {
    render(() => (
      <ItemRow {...defaultProps} onTrack={vi.fn()} isTracked={false} />
    ));
    const btn = screen.getByLabelText(/Pin #42/i);
    const svg = btn.querySelector("svg");
    expect(svg?.getAttribute("fill")).toBe("none");
  });

  it("pin button has aria-label 'Unpin' when isTracked is true", () => {
    render(() => <ItemRow {...defaultProps} onTrack={vi.fn()} isTracked={true} />);
    expect(screen.getByLabelText("Unpin #42 Fix a bug")).not.toBeNull();
  });

  it("pin button has aria-label 'Pin' when isTracked is false", () => {
    render(() => <ItemRow {...defaultProps} onTrack={vi.fn()} isTracked={false} />);
    expect(screen.getByLabelText("Pin #42 Fix a bug")).not.toBeNull();
  });

  it("does not render ignore button when onIgnore is undefined", () => {
    const { onIgnore: _onIgnore, ...propsWithoutIgnore } = defaultProps;
    render(() => <ItemRow {...propsWithoutIgnore} />);
    expect(screen.queryByLabelText(/Ignore #42/i)).toBeNull();
  });

  it("refreshTick forces time display update", () => {
    const [tick, setTick] = createSignal(0);
    let mockNow = MOCK_NOW;
    vi.mocked(Date.now).mockImplementation(() => mockNow);

    const { container } = render(() => (
      <ItemRow {...defaultProps} refreshTick={tick()} />
    ));
    const created = container.querySelector(`time[datetime="${defaultProps.createdAt}"]`);
    const updated = container.querySelector(`time[datetime="${defaultProps.updatedAt}"]`);
    expect(created!.textContent).toBe("2h");
    expect(updated!.textContent).toBe("30m");

    // Advance mock time by 3 hours and bump refreshTick
    mockNow = MOCK_NOW + 3 * 60 * 60 * 1000;
    setTick(1);

    expect(created!.textContent).toBe("5h");
    // updatedAt was 30m before MOCK_NOW; after +3h it is 3h30m ago → Math.floor(210/60) = 3 → "3h"
    expect(updated!.textContent).toBe("3h");
  });
});
