import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import ActionsTab from "../../src/app/components/dashboard/ActionsTab";
import type { ApiError } from "../../src/app/services/api";
import * as viewStore from "../../src/app/stores/view";
import { makeWorkflowRun, resetViewStore } from "../helpers/index";

beforeEach(() => {
  resetViewStore();
});

describe("ActionsTab", () => {
  it("shows empty state when no workflow runs", () => {
    render(() => <ActionsTab workflowRuns={[]} />);
    screen.getByText("No workflow runs found.");
  });

  it("shows loading state when loading=true", () => {
    render(() => <ActionsTab workflowRuns={[]} loading={true} />);
    screen.getByText(/Loading workflow runs/i);
    expect(screen.queryByText("No workflow runs found.")).toBeNull();
  });

  it("shows error banners when errors provided", () => {
    const errors: ApiError[] = [
      { repo: "owner/repo", statusCode: 500, message: "Server error", retryable: false },
    ];
    render(() => <ActionsTab workflowRuns={[]} errors={errors} />);
    screen.getByText(/Server error/i);
  });

  it("groups runs by repository", () => {
    const runs = [
      makeWorkflowRun({ repoFullName: "owner/repo-a", workflowId: 1, name: "CI" }),
      makeWorkflowRun({ repoFullName: "owner/repo-b", workflowId: 2, name: "CI" }),
    ];
    render(() => <ActionsTab workflowRuns={runs} />);
    screen.getByText("owner/repo-a");
    screen.getByText("owner/repo-b");
  });

  it("groups runs by workflow within each repo", () => {
    const runs = [
      makeWorkflowRun({
        repoFullName: "owner/repo",
        workflowId: 1,
        name: "Build",
        runNumber: 1,
      }),
      makeWorkflowRun({
        repoFullName: "owner/repo",
        workflowId: 2,
        name: "Deploy",
        runNumber: 2,
      }),
    ];
    render(() => <ActionsTab workflowRuns={runs} />);
    // Workflow names appear as group header buttons AND run row spans (2 each)
    expect(screen.getAllByText("Build").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Deploy").length).toBeGreaterThanOrEqual(1);
    // Verify two separate workflow groups exist
    const buttons = screen.getAllByRole("button");
    const wfButtons = buttons.filter(
      (b) => b.textContent?.includes("Build") || b.textContent?.includes("Deploy")
    );
    expect(wfButtons.length).toBe(2);
  });

  it("toggles repo collapse when repo header clicked", async () => {
    const user = userEvent.setup();
    const runs = [
      makeWorkflowRun({ repoFullName: "owner/repo", workflowId: 1, name: "CI", displayTitle: "unique-run-title" }),
    ];
    render(() => <ActionsTab workflowRuns={runs} />);
    // displayTitle is rendered inside run rows (not in headers)
    screen.getByText("unique-run-title");

    // Click the repo header button to collapse it
    const repoHeader = screen.getByText("owner/repo");
    await user.click(repoHeader);

    // Run row content should be hidden after repo collapse
    expect(screen.queryByText("unique-run-title")).toBeNull();
  });

  it("toggles workflow collapse when workflow header clicked", async () => {
    const user = userEvent.setup();
    const run = makeWorkflowRun({
      repoFullName: "owner/repo",
      workflowId: 1,
      name: "MyWorkflow",
      displayTitle: "unique-wf-run-title",
    });
    render(() => <ActionsTab workflowRuns={[run]} />);
    // The run's displayTitle is rendered in the run row
    screen.getByText("unique-wf-run-title");

    // Find the workflow header button (the button containing "MyWorkflow" text)
    const buttons = screen.getAllByRole("button");
    const wfHeader = buttons.find((b) => b.textContent?.includes("MyWorkflow") && !b.textContent?.includes("owner/repo"));
    expect(wfHeader).toBeDefined();
    await user.click(wfHeader!);

    // displayTitle should be hidden after workflow collapse
    expect(screen.queryByText("unique-wf-run-title")).toBeNull();
  });

  it("filters out ignored workflow runs", () => {
    const run = makeWorkflowRun({ id: 42, name: "Ignored Run", repoFullName: "owner/repo" });
    viewStore.ignoreItem({
      id: "42",
      type: "workflowRun",
      repo: "owner/repo",
      title: "Ignored Run",
      ignoredAt: Date.now(),
    });
    render(() => <ActionsTab workflowRuns={[run]} />);
    expect(screen.queryByText("Ignored Run")).toBeNull();
    screen.getByText("No workflow runs found.");
  });

  it("filters by globalFilter.org", () => {
    const runs = [
      makeWorkflowRun({ repoFullName: "myorg/repo", workflowId: 1, name: "OrgCI" }),
      makeWorkflowRun({ repoFullName: "otherorg/repo", workflowId: 2, name: "OtherCI" }),
    ];
    viewStore.setGlobalFilter("myorg", null);
    render(() => <ActionsTab workflowRuns={runs} />);
    screen.getByText("myorg/repo");
    expect(screen.queryByText("otherorg/repo")).toBeNull();
  });

  it("filters by globalFilter.repo", () => {
    const runs = [
      makeWorkflowRun({ repoFullName: "owner/target", workflowId: 1, name: "TargetCI" }),
      makeWorkflowRun({ repoFullName: "owner/other", workflowId: 2, name: "OtherCI" }),
    ];
    viewStore.setGlobalFilter(null, "owner/target");
    render(() => <ActionsTab workflowRuns={runs} />);
    screen.getByText("owner/target");
    expect(screen.queryByText("owner/other")).toBeNull();
  });

  it("hides PR runs by default (showPrRuns=false)", () => {
    const runs = [
      makeWorkflowRun({ id: 1, name: "CI", repoFullName: "owner/repo", workflowId: 1, isPrRun: true, displayTitle: "pr-run-title" }),
      makeWorkflowRun({ id: 2, name: "CI", repoFullName: "owner/repo", workflowId: 2, isPrRun: false, displayTitle: "push-run-title" }),
    ];
    render(() => <ActionsTab workflowRuns={runs} />);
    // PR run's displayTitle is hidden
    expect(screen.queryByText("pr-run-title")).toBeNull();
    // Push run's displayTitle is visible
    screen.getByText("push-run-title");
  });

  it("shows PR runs when 'Show PR runs' checkbox is checked", async () => {
    const user = userEvent.setup();
    const runs = [
      makeWorkflowRun({ id: 1, name: "CI", repoFullName: "owner/repo", workflowId: 1, isPrRun: true, displayTitle: "pr-run-title" }),
    ];
    render(() => <ActionsTab workflowRuns={runs} />);
    // Initially hidden (isPrRun=true, showPrRuns=false)
    expect(screen.queryByText("pr-run-title")).toBeNull();

    // Check the checkbox to show PR runs
    const checkbox = screen.getByRole("checkbox");
    await user.click(checkbox);

    // Now the PR run's displayTitle should be visible
    screen.getByText("pr-run-title");
  });

  it("filters by conclusion tab filter", () => {
    const runs = [
      makeWorkflowRun({ id: 1, repoFullName: "owner/repo", workflowId: 1, name: "CI", status: "completed", conclusion: "success", displayTitle: "success-run" }),
      makeWorkflowRun({ id: 2, repoFullName: "owner/repo", workflowId: 1, name: "CI", status: "completed", conclusion: "failure", displayTitle: "failure-run" }),
    ];
    viewStore.setTabFilter("actions", "conclusion", "success");
    render(() => <ActionsTab workflowRuns={runs} />);
    screen.getByText("success-run");
    expect(screen.queryByText("failure-run")).toBeNull();
  });

  it("filters by event tab filter", () => {
    const runs = [
      makeWorkflowRun({ id: 1, repoFullName: "owner/repo", workflowId: 1, name: "CI", event: "push", displayTitle: "push-run" }),
      makeWorkflowRun({ id: 2, repoFullName: "owner/repo", workflowId: 1, name: "CI", event: "schedule", displayTitle: "schedule-run" }),
    ];
    viewStore.setTabFilter("actions", "event", "push");
    render(() => <ActionsTab workflowRuns={runs} />);
    screen.getByText("push-run");
    expect(screen.queryByText("schedule-run")).toBeNull();
  });
});
