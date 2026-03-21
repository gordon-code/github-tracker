import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import ActionsTab from "../../src/app/components/dashboard/ActionsTab";
import type { ApiError } from "../../src/app/services/api";
import * as viewStore from "../../src/app/stores/view";
import { makeWorkflowRun } from "../helpers/index";

beforeEach(() => {
  viewStore.updateViewState({
    globalFilter: { org: null, repo: null },
    sortPreferences: {},
    ignoredItems: [],
  });
});

describe("ActionsTab", () => {
  it("shows empty state when no workflow runs", () => {
    render(() => <ActionsTab workflowRuns={[]} />);
    expect(screen.getByText("No workflow runs found.")).toBeDefined();
  });

  it("shows loading state when loading=true", () => {
    render(() => <ActionsTab workflowRuns={[]} loading={true} />);
    expect(screen.getByText(/Loading workflow runs/i)).toBeDefined();
    expect(screen.queryByText("No workflow runs found.")).toBeNull();
  });

  it("shows error banners when errors provided", () => {
    const errors: ApiError[] = [
      { repo: "owner/repo", statusCode: 500, message: "Server error", retryable: false },
    ];
    render(() => <ActionsTab workflowRuns={[]} errors={errors} />);
    expect(screen.getByText(/Server error/i)).toBeDefined();
  });

  it("groups runs by repository", () => {
    const runs = [
      makeWorkflowRun({ repoFullName: "owner/repo-a", workflowId: 1, name: "CI" }),
      makeWorkflowRun({ repoFullName: "owner/repo-b", workflowId: 2, name: "CI" }),
    ];
    render(() => <ActionsTab workflowRuns={runs} />);
    expect(screen.getByText("owner/repo-a")).toBeDefined();
    expect(screen.getByText("owner/repo-b")).toBeDefined();
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

  it("toggles repo collapse when repo header clicked", () => {
    const runs = [
      makeWorkflowRun({ repoFullName: "owner/repo", workflowId: 1, name: "CI", headBranch: "main" }),
    ];
    render(() => <ActionsTab workflowRuns={runs} />);
    // Branch name is only rendered inside run rows (not in headers)
    expect(screen.getByText("main")).toBeDefined();

    // Click the repo header button to collapse it
    const repoHeader = screen.getByText("owner/repo");
    fireEvent.click(repoHeader);

    // Run row content should be hidden after repo collapse
    expect(screen.queryByText("main")).toBeNull();
  });

  it("toggles workflow collapse when workflow header clicked", () => {
    const run = makeWorkflowRun({
      repoFullName: "owner/repo",
      workflowId: 1,
      name: "MyWorkflow",
      headBranch: "feature/wf-branch",
    });
    render(() => <ActionsTab workflowRuns={[run]} />);
    // The run's branch name is only in the run row
    expect(screen.getByText("feature/wf-branch")).toBeDefined();

    // Find the workflow header button (the button containing "MyWorkflow" text)
    const buttons = screen.getAllByRole("button");
    const wfHeader = buttons.find((b) => b.textContent?.includes("MyWorkflow") && !b.textContent?.includes("owner/repo"));
    expect(wfHeader).toBeDefined();
    fireEvent.click(wfHeader!);

    // Branch name should be hidden after workflow collapse
    expect(screen.queryByText("feature/wf-branch")).toBeNull();
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
    expect(screen.getByText("No workflow runs found.")).toBeDefined();
  });

  it("filters by globalFilter.org", () => {
    const runs = [
      makeWorkflowRun({ repoFullName: "myorg/repo", workflowId: 1, name: "OrgCI" }),
      makeWorkflowRun({ repoFullName: "otherorg/repo", workflowId: 2, name: "OtherCI" }),
    ];
    viewStore.setGlobalFilter("myorg", null);
    render(() => <ActionsTab workflowRuns={runs} />);
    expect(screen.getByText("myorg/repo")).toBeDefined();
    expect(screen.queryByText("otherorg/repo")).toBeNull();
  });

  it("filters by globalFilter.repo", () => {
    const runs = [
      makeWorkflowRun({ repoFullName: "owner/target", workflowId: 1, name: "TargetCI" }),
      makeWorkflowRun({ repoFullName: "owner/other", workflowId: 2, name: "OtherCI" }),
    ];
    viewStore.setGlobalFilter(null, "owner/target");
    render(() => <ActionsTab workflowRuns={runs} />);
    expect(screen.getByText("owner/target")).toBeDefined();
    expect(screen.queryByText("owner/other")).toBeNull();
  });

  it("hides PR runs by default (showPrRuns=false)", () => {
    const runs = [
      makeWorkflowRun({ id: 1, name: "CI", repoFullName: "owner/repo", workflowId: 1, isPrRun: true, headBranch: "pr-branch" }),
      makeWorkflowRun({ id: 2, name: "CI", repoFullName: "owner/repo", workflowId: 2, isPrRun: false, headBranch: "push-branch" }),
    ];
    render(() => <ActionsTab workflowRuns={runs} />);
    // PR run's branch is hidden
    expect(screen.queryByText("pr-branch")).toBeNull();
    // Push run's branch is visible
    expect(screen.getByText("push-branch")).toBeDefined();
  });

  it("shows PR runs when 'Show PR runs' checkbox is checked", () => {
    const runs = [
      makeWorkflowRun({ id: 1, name: "CI", repoFullName: "owner/repo", workflowId: 1, isPrRun: true, headBranch: "pr-branch" }),
    ];
    render(() => <ActionsTab workflowRuns={runs} />);
    // Initially hidden (isPrRun=true, showPrRuns=false)
    expect(screen.queryByText("pr-branch")).toBeNull();

    // Check the checkbox to show PR runs
    const checkbox = screen.getByRole("checkbox");
    fireEvent.click(checkbox);

    // Now the PR run's branch should be visible
    expect(screen.getByText("pr-branch")).toBeDefined();
  });
});
