import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import WorkflowSummaryCard from "../../src/app/components/dashboard/WorkflowSummaryCard";
import { makeWorkflowRun } from "../helpers/index";

describe("WorkflowSummaryCard", () => {
  it("renders workflow name", () => {
    const runs = [makeWorkflowRun({ name: "My Workflow", conclusion: "success" })];
    render(() => (
      <WorkflowSummaryCard
        workflowName="My Workflow"
        runs={runs}
        expanded={false}
        onToggle={() => {}}
        onIgnoreRun={() => {}}
        density="comfortable"
      />
    ));
    screen.getByText("My Workflow");
  });

  it("shows correct counts: success, failure, running", () => {
    const runs = [
      makeWorkflowRun({ conclusion: "success", status: "completed" }),
      makeWorkflowRun({ conclusion: "success", status: "completed" }),
      makeWorkflowRun({ conclusion: "failure", status: "completed" }),
      makeWorkflowRun({ conclusion: null, status: "in_progress" }),
    ];
    const { container } = render(() => (
      <WorkflowSummaryCard
        workflowName="CI"
        runs={runs}
        expanded={false}
        onToggle={() => {}}
        onIgnoreRun={() => {}}
        density="comfortable"
      />
    ));
    // 2 successes shown as success-colored count
    expect(screen.getByText("2").className).toContain("text-success");
    // 1 failure shown as error-colored count
    const errorCount = container.querySelector('[class*="text-error"]');
    expect(errorCount).not.toBeNull();
    expect(errorCount!.textContent).toBe("1");
    // 1 running shown as warning-colored count
    const warningCount = container.querySelector('[class*="text-warning"]');
    expect(warningCount).not.toBeNull();
    expect(warningCount!.textContent).toBe("1");
  });

  it("does not show zero counts", () => {
    const runs = [makeWorkflowRun({ conclusion: "success", status: "completed" })];
    const { container } = render(() => (
      <WorkflowSummaryCard
        workflowName="CI"
        runs={runs}
        expanded={false}
        onToggle={() => {}}
        onIgnoreRun={() => {}}
        density="comfortable"
      />
    ));
    // Only success count visible, no error or warning elements
    const errorSpans = container.querySelectorAll('[class*="text-error"]');
    const warningSpans = container.querySelectorAll('[class*="text-warning"]');
    expect(errorSpans.length).toBe(0);
    expect(warningSpans.length).toBe(0);
  });

  it("collapsed: does not render WorkflowRunRow components", () => {
    const runs = [
      makeWorkflowRun({ displayTitle: "run-unique-title", conclusion: "success" }),
    ];
    render(() => (
      <WorkflowSummaryCard
        workflowName="CI"
        runs={runs}
        expanded={false}
        onToggle={() => {}}
        onIgnoreRun={() => {}}
        density="comfortable"
      />
    ));
    expect(screen.queryByText("run-unique-title")).toBeNull();
  });

  it("expanded: renders WorkflowRunRow for each run", () => {
    const runs = [
      makeWorkflowRun({ displayTitle: "run-alpha", conclusion: "success" }),
      makeWorkflowRun({ displayTitle: "run-beta", conclusion: "failure" }),
    ];
    render(() => (
      <WorkflowSummaryCard
        workflowName="CI"
        runs={runs}
        expanded={true}
        onToggle={() => {}}
        onIgnoreRun={() => {}}
        density="comfortable"
      />
    ));
    screen.getByText("run-alpha");
    screen.getByText("run-beta");
  });

  it("clicking card calls onToggle", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const runs = [makeWorkflowRun({ conclusion: "success" })];
    const { container } = render(() => (
      <WorkflowSummaryCard
        workflowName="CI"
        runs={runs}
        expanded={false}
        onToggle={onToggle}
        onIgnoreRun={() => {}}
        density="comfortable"
      />
    ));
    const card = container.firstElementChild as HTMLElement;
    await user.click(card);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("card with failures has error border classes", () => {
    const runs = [makeWorkflowRun({ conclusion: "failure", status: "completed" })];
    const { container } = render(() => (
      <WorkflowSummaryCard
        workflowName="CI"
        runs={runs}
        expanded={false}
        onToggle={() => {}}
        onIgnoreRun={() => {}}
        density="comfortable"
      />
    ));
    const card = container.firstElementChild as HTMLElement;
    expect(card.className).toContain("border-error");
  });

  it("card with all successes has success border accent", () => {
    const runs = [
      makeWorkflowRun({ conclusion: "success", status: "completed" }),
      makeWorkflowRun({ conclusion: "success", status: "completed" }),
    ];
    const { container } = render(() => (
      <WorkflowSummaryCard
        workflowName="CI"
        runs={runs}
        expanded={false}
        onToggle={() => {}}
        onIgnoreRun={() => {}}
        density="comfortable"
      />
    ));
    const card = container.firstElementChild as HTMLElement;
    expect(card.className).toContain("border-l-success");
  });

  it("card with running workflows has warning border accent", () => {
    const runs = [
      makeWorkflowRun({ conclusion: null, status: "in_progress" }),
    ];
    const { container } = render(() => (
      <WorkflowSummaryCard
        workflowName="CI"
        runs={runs}
        expanded={false}
        onToggle={() => {}}
        onIgnoreRun={() => {}}
        density="comfortable"
      />
    ));
    const card = container.firstElementChild as HTMLElement;
    expect(card.className).toContain("border-l-warning");
  });

  it("passes isPolling to WorkflowRunRow when hotPollingRunIds contains run ID", () => {
    const runs = [
      makeWorkflowRun({ id: 10, conclusion: null, status: "in_progress" }),
      makeWorkflowRun({ id: 20, conclusion: "success", status: "completed" }),
    ];
    const hotPollingRunIds = new Set([10]);
    const { container } = render(() => (
      <WorkflowSummaryCard
        workflowName="CI"
        runs={runs}
        expanded={true}
        onToggle={() => {}}
        onIgnoreRun={() => {}}
        density="comfortable"
        hotPollingRunIds={hotPollingRunIds}
      />
    ));
    const rows = container.querySelectorAll("[class*='flex items-center gap-3']");
    // First row (id=10, in hot poll set) should have shimmer
    expect(rows[0]?.classList.contains("animate-shimmer")).toBe(true);
    // Second row (id=20, not in hot poll set) should not
    expect(rows[1]?.classList.contains("animate-shimmer")).toBe(false);
  });

  it("passes isFlashing to WorkflowRunRow when flashingRunIds contains run ID", () => {
    const runs = [
      makeWorkflowRun({ id: 10, conclusion: "success", status: "completed" }),
      makeWorkflowRun({ id: 20, conclusion: "success", status: "completed" }),
    ];
    const flashingRunIds = new Set([20]);
    const { container } = render(() => (
      <WorkflowSummaryCard
        workflowName="CI"
        runs={runs}
        expanded={true}
        onToggle={() => {}}
        onIgnoreRun={() => {}}
        density="comfortable"
        flashingRunIds={flashingRunIds}
      />
    ));
    const rows = container.querySelectorAll("[class*='flex items-center gap-3']");
    // First row (id=10, not flashing) should not have flash
    expect(rows[0]?.classList.contains("animate-flash")).toBe(false);
    // Second row (id=20, flashing) should have flash
    expect(rows[1]?.classList.contains("animate-flash")).toBe(true);
  });
});
