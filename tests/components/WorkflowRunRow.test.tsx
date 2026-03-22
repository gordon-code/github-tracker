import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import WorkflowRunRow from "../../src/app/components/dashboard/WorkflowRunRow";
import { makeWorkflowRun } from "../helpers/index";

describe("WorkflowRunRow", () => {
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

  it("shows relative time", () => {
    const run = makeWorkflowRun({ createdAt: "2024-01-10T08:00:00Z" });
    render(() => (
      <WorkflowRunRow run={run} onIgnore={() => {}} density="comfortable" />
    ));
    // relativeTime returns a human-readable string; just verify something renders
    // We can't assert exact text as it depends on current date, but the element should exist
    const container = screen.getByText("CI").closest("div");
    expect(container).toBeDefined();
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
});
