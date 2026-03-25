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
    // 2 successes shown as green count
    expect(screen.getByText("2").className).toContain("green");
    // 1 failure shown as red count — use container query to target by color class
    const redCount = container.querySelector('[class*="text-red"]');
    expect(redCount).not.toBeNull();
    expect(redCount!.textContent).toBe("1");
    // 1 running shown as yellow count
    const yellowCount = container.querySelector('[class*="text-yellow"]');
    expect(yellowCount).not.toBeNull();
    expect(yellowCount!.textContent).toBe("1");
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
    // Only green count visible, no red or yellow elements
    const redSpans = container.querySelectorAll('[class*="red"]');
    const yellowSpans = container.querySelectorAll('[class*="yellow"]');
    expect(redSpans.length).toBe(0);
    expect(yellowSpans.length).toBe(0);
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

  it("card with failures has red border classes", () => {
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
    expect(card.className).toContain("border-red");
  });

  it("card with all successes has green border accent", () => {
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
    expect(card.className).toContain("border-l-green");
  });

  it("card with running workflows has yellow border accent", () => {
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
    expect(card.className).toContain("border-l-yellow");
  });
});
