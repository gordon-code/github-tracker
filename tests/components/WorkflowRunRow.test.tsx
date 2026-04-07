import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { createSignal } from "solid-js";
import WorkflowRunRow from "../../src/app/components/dashboard/WorkflowRunRow";
import { makeWorkflowRun } from "../helpers/index";

const MOCK_NOW = new Date("2026-03-30T12:00:00Z").getTime();

describe("WorkflowRunRow", () => {
  beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(MOCK_NOW); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("renders run name", () => {
    const run = makeWorkflowRun({ name: "CI Build" });
    render(() => (
      <WorkflowRunRow run={run} onIgnore={() => {}} />
    ));
    screen.getByText("CI Build");
  });

  it("renders displayTitle as primary text", () => {
    const run = makeWorkflowRun({ displayTitle: "feat: my cool feature" });
    render(() => (
      <WorkflowRunRow run={run} onIgnore={() => {}} />
    ));
    screen.getByText("feat: my cool feature");
  });

  it("shows relative time in a semantic <time> element", () => {
    const createdAt = new Date(MOCK_NOW - 2 * 60 * 60 * 1000).toISOString();
    const run = makeWorkflowRun({ createdAt });
    const { container } = render(() => (
      <WorkflowRunRow run={run} onIgnore={() => {}} />
    ));
    const timeEl = container.querySelector("time");
    expect(timeEl).not.toBeNull();
    expect(timeEl!.getAttribute("datetime")).toBe(createdAt);
    expect(timeEl!.textContent).toMatch(/2 hours? ago/);
  });

  it("shows date tooltip content on hover", () => {
    vi.useFakeTimers();
    const createdAt = new Date(MOCK_NOW - 2 * 60 * 60 * 1000).toISOString();
    const run = makeWorkflowRun({ createdAt });
    const { container, unmount } = render(() => (
      <WorkflowRunRow run={run} onIgnore={() => {}} />
    ));
    const timeTrigger = container.querySelector("time")?.closest("span.inline-flex");
    expect(timeTrigger).not.toBeNull();
    fireEvent.pointerEnter(timeTrigger!);
    vi.advanceTimersByTime(300);
    expect(document.body.textContent).toContain(
      `Created: ${new Date(createdAt).toLocaleString()}`
    );
    fireEvent.pointerLeave(timeTrigger!);
    vi.advanceTimersByTime(500);
    unmount();
    vi.useRealTimers();
  });

  it("updates time display when refreshTick changes", () => {
    let mockNow = MOCK_NOW;
    vi.mocked(Date.now).mockImplementation(() => mockNow);
    const createdAt = new Date(MOCK_NOW - 2 * 60 * 60 * 1000).toISOString();
    const run = makeWorkflowRun({ createdAt });
    const [tick, setTick] = createSignal(0);
    const { container } = render(() => (
      <WorkflowRunRow run={run} onIgnore={() => {}} refreshTick={tick()} />
    ));
    const timeEl = container.querySelector("time");
    expect(timeEl!.textContent).toMatch(/2 hours? ago/);
    mockNow = MOCK_NOW + 3 * 60 * 60 * 1000;
    setTick(1);
    expect(timeEl!.textContent).toMatch(/5 hours? ago/);
  });

  it("renders status indicator for success conclusion", () => {
    const run = makeWorkflowRun({ status: "completed", conclusion: "success" });
    render(() => (
      <WorkflowRunRow run={run} onIgnore={() => {}} />
    ));
    screen.getByLabelText("Success");
  });

  it("renders status indicator for failure conclusion", () => {
    const run = makeWorkflowRun({ status: "completed", conclusion: "failure" });
    render(() => (
      <WorkflowRunRow run={run} onIgnore={() => {}} />
    ));
    screen.getByLabelText("Failure");
  });

  it("renders status indicator for cancelled conclusion", () => {
    const run = makeWorkflowRun({ status: "completed", conclusion: "cancelled" });
    render(() => (
      <WorkflowRunRow run={run} onIgnore={() => {}} />
    ));
    screen.getByLabelText("Cancelled");
  });

  it("renders status indicator for in_progress status", () => {
    const run = makeWorkflowRun({ status: "in_progress", conclusion: null });
    render(() => (
      <WorkflowRunRow run={run} onIgnore={() => {}} />
    ));
    screen.getByLabelText("In progress");
  });

  it("renders status indicator for queued status", () => {
    const run = makeWorkflowRun({ status: "queued", conclusion: null });
    render(() => (
      <WorkflowRunRow run={run} onIgnore={() => {}} />
    ));
    screen.getByLabelText("Queued");
  });

  it("calls onIgnore when ignore button clicked", async () => {
    const user = userEvent.setup();
    const onIgnore = vi.fn();
    const run = makeWorkflowRun({ name: "Test Run" });
    render(() => (
      <WorkflowRunRow run={run} onIgnore={onIgnore} />
    ));
    await user.click(screen.getByLabelText("Ignore run Test Run"));
    expect(onIgnore).toHaveBeenCalledWith(run);
  });

  it("has correct href for valid GitHub URL", () => {
    const run = makeWorkflowRun({
      htmlUrl: "https://github.com/owner/repo/actions/runs/1",
    });
    render(() => (
      <WorkflowRunRow run={run} onIgnore={() => {}} />
    ));
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe(
      "https://github.com/owner/repo/actions/runs/1"
    );
  });

  it("has no href for invalid URL", () => {
    const run = makeWorkflowRun({ htmlUrl: "javascript:alert(1)" });
    const { container } = render(() => (
      <WorkflowRunRow run={run} onIgnore={() => {}} />
    ));
    // isSafeGitHubUrl returns false for non-github URLs; href prop becomes undefined
    // An <a> without href has no "link" ARIA role, but the element still exists
    const anchor = container.querySelector("a");
    expect(anchor).toBeDefined();
    expect(anchor?.getAttribute("href")).toBeNull();
  });

  it("has both comfortable and compact classes (CSS-driven density)", () => {
    const run = makeWorkflowRun({ name: "Density Run" });
    render(() => (
      <WorkflowRunRow run={run} onIgnore={() => {}} />
    ));
    const row = screen.getByText("Density Run").closest("div[class]");
    expect(row?.className).toContain("py-2.5");
    expect(row?.className).toContain("px-4");
    expect(row?.className).toContain("compact:py-1");
    expect(row?.className).toContain("compact:px-2");
  });

  it("applies shimmer class when isPolling is true", () => {
    const { container } = render(() => (
      <WorkflowRunRow run={makeWorkflowRun()} onIgnore={() => {}} isPolling={true} />
    ));
    expect(container.firstElementChild?.classList.contains("animate-shimmer")).toBe(true);
    expect(container.querySelector(".loading-spinner")).toBeTruthy();
  });

  it("does not apply shimmer when isPolling is false", () => {
    const { container } = render(() => (
      <WorkflowRunRow run={makeWorkflowRun()} onIgnore={() => {}} isPolling={false} />
    ));
    expect(container.firstElementChild?.classList.contains("animate-shimmer")).toBe(false);
    expect(container.querySelector(".loading-spinner")).toBeFalsy();
  });

  it("does not apply shimmer when isPolling is omitted", () => {
    const { container } = render(() => (
      <WorkflowRunRow run={makeWorkflowRun()} onIgnore={() => {}} />
    ));
    expect(container.firstElementChild?.classList.contains("animate-shimmer")).toBe(false);
    expect(container.querySelector(".loading-spinner")).toBeFalsy();
  });

  it("applies flash class when isFlashing is true", () => {
    const { container } = render(() => (
      <WorkflowRunRow run={makeWorkflowRun()} onIgnore={() => {}} isFlashing={true} />
    ));
    expect(container.firstElementChild?.classList.contains("animate-flash")).toBe(true);
  });

  it("flash takes precedence over shimmer", () => {
    const { container } = render(() => (
      <WorkflowRunRow run={makeWorkflowRun()} onIgnore={() => {}} isFlashing={true} isPolling={true} />
    ));
    expect(container.firstElementChild?.classList.contains("animate-flash")).toBe(true);
    expect(container.firstElementChild?.classList.contains("animate-shimmer")).toBe(false);
  });
});
