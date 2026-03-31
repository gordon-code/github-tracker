import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@solidjs/testing-library";
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
      <WorkflowRunRow run={run} onIgnore={() => {}} density="comfortable" />
    ));
    screen.getByText("CI Build");
  });

  it("renders displayTitle as primary text", () => {
    const run = makeWorkflowRun({ displayTitle: "feat: my cool feature" });
    render(() => (
      <WorkflowRunRow run={run} onIgnore={() => {}} density="comfortable" />
    ));
    screen.getByText("feat: my cool feature");
  });

  it("shows relative time in a semantic <time> element", () => {
    const createdAt = new Date(MOCK_NOW - 2 * 60 * 60 * 1000).toISOString();
    const run = makeWorkflowRun({ createdAt });
    const { container } = render(() => (
      <WorkflowRunRow run={run} onIgnore={() => {}} density="comfortable" />
    ));
    const timeEl = container.querySelector("time");
    expect(timeEl).not.toBeNull();
    expect(timeEl!.getAttribute("datetime")).toBe(createdAt);
    expect(timeEl!.textContent).toMatch(/2 hours? ago/);
  });

  it("updates time display when refreshTick changes", () => {
    let mockNow = MOCK_NOW;
    vi.spyOn(Date, "now").mockImplementation(() => mockNow);
    const createdAt = new Date(MOCK_NOW - 2 * 60 * 60 * 1000).toISOString();
    const run = makeWorkflowRun({ createdAt });
    const [tick, setTick] = createSignal(0);
    const { container } = render(() => (
      <WorkflowRunRow run={run} onIgnore={() => {}} density="comfortable" refreshTick={tick()} />
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
      <WorkflowRunRow run={run} onIgnore={() => {}} density="comfortable" />
    ));
    screen.getByLabelText("Success");
  });

  it("renders status indicator for failure conclusion", () => {
    const run = makeWorkflowRun({ status: "completed", conclusion: "failure" });
    render(() => (
      <WorkflowRunRow run={run} onIgnore={() => {}} density="comfortable" />
    ));
    screen.getByLabelText("Failure");
  });

  it("renders status indicator for cancelled conclusion", () => {
    const run = makeWorkflowRun({ status: "completed", conclusion: "cancelled" });
    render(() => (
      <WorkflowRunRow run={run} onIgnore={() => {}} density="comfortable" />
    ));
    screen.getByLabelText("Cancelled");
  });

  it("renders status indicator for in_progress status", () => {
    const run = makeWorkflowRun({ status: "in_progress", conclusion: null });
    render(() => (
      <WorkflowRunRow run={run} onIgnore={() => {}} density="comfortable" />
    ));
    screen.getByLabelText("In progress");
  });

  it("renders status indicator for queued status", () => {
    const run = makeWorkflowRun({ status: "queued", conclusion: null });
    render(() => (
      <WorkflowRunRow run={run} onIgnore={() => {}} density="comfortable" />
    ));
    screen.getByLabelText("Queued");
  });

  it("calls onIgnore when ignore button clicked", async () => {
    const user = userEvent.setup();
    const onIgnore = vi.fn();
    const run = makeWorkflowRun({ name: "Test Run" });
    render(() => (
      <WorkflowRunRow run={run} onIgnore={onIgnore} density="comfortable" />
    ));
    await user.click(screen.getByLabelText("Ignore run Test Run"));
    expect(onIgnore).toHaveBeenCalledWith(run);
  });

  it("has correct href for valid GitHub URL", () => {
    const run = makeWorkflowRun({
      htmlUrl: "https://github.com/owner/repo/actions/runs/1",
    });
    render(() => (
      <WorkflowRunRow run={run} onIgnore={() => {}} density="comfortable" />
    ));
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe(
      "https://github.com/owner/repo/actions/runs/1"
    );
  });

  it("has no href for invalid URL", () => {
    const run = makeWorkflowRun({ htmlUrl: "javascript:alert(1)" });
    const { container } = render(() => (
      <WorkflowRunRow run={run} onIgnore={() => {}} density="comfortable" />
    ));
    // isSafeGitHubUrl returns false for non-github URLs; href prop becomes undefined
    // An <a> without href has no "link" ARIA role, but the element still exists
    const anchor = container.querySelector("a");
    expect(anchor).toBeDefined();
    expect(anchor?.getAttribute("href")).toBeNull();
  });

  it("applies compact padding class for compact density", () => {
    const run = makeWorkflowRun({ name: "Compact Run" });
    render(() => (
      <WorkflowRunRow run={run} onIgnore={() => {}} density="compact" />
    ));
    const row = screen.getByText("Compact Run").closest("div[class]");
    expect(row?.className).toContain("py-1.5");
    expect(row?.className).toContain("px-3");
  });

  it("applies comfortable padding class for comfortable density", () => {
    const run = makeWorkflowRun({ name: "Comfortable Run" });
    render(() => (
      <WorkflowRunRow run={run} onIgnore={() => {}} density="comfortable" />
    ));
    const row = screen.getByText("Comfortable Run").closest("div[class]");
    expect(row?.className).toContain("py-2.5");
    expect(row?.className).toContain("px-4");
  });

  it("applies shimmer class when isPolling is true", () => {
    const { container } = render(() => (
      <WorkflowRunRow run={makeWorkflowRun()} onIgnore={() => {}} density="comfortable" isPolling={true} />
    ));
    expect(container.firstElementChild?.classList.contains("animate-shimmer")).toBe(true);
    expect(container.querySelector(".loading-spinner")).toBeTruthy();
  });

  it("does not apply shimmer when isPolling is false", () => {
    const { container } = render(() => (
      <WorkflowRunRow run={makeWorkflowRun()} onIgnore={() => {}} density="comfortable" isPolling={false} />
    ));
    expect(container.firstElementChild?.classList.contains("animate-shimmer")).toBe(false);
    expect(container.querySelector(".loading-spinner")).toBeFalsy();
  });

  it("does not apply shimmer when isPolling is omitted", () => {
    const { container } = render(() => (
      <WorkflowRunRow run={makeWorkflowRun()} onIgnore={() => {}} density="comfortable" />
    ));
    expect(container.firstElementChild?.classList.contains("animate-shimmer")).toBe(false);
    expect(container.querySelector(".loading-spinner")).toBeFalsy();
  });

  it("applies flash class when isFlashing is true", () => {
    const { container } = render(() => (
      <WorkflowRunRow run={makeWorkflowRun()} onIgnore={() => {}} density="comfortable" isFlashing={true} />
    ));
    expect(container.firstElementChild?.classList.contains("animate-flash")).toBe(true);
  });

  it("flash takes precedence over shimmer", () => {
    const { container } = render(() => (
      <WorkflowRunRow run={makeWorkflowRun()} onIgnore={() => {}} density="comfortable" isFlashing={true} isPolling={true} />
    ));
    expect(container.firstElementChild?.classList.contains("animate-flash")).toBe(true);
    expect(container.firstElementChild?.classList.contains("animate-shimmer")).toBe(false);
  });
});
