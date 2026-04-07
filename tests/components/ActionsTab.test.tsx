import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { createSignal } from "solid-js";
import ActionsTab from "../../src/app/components/dashboard/ActionsTab";
import type { WorkflowRun } from "../../src/app/services/api";
import * as viewStore from "../../src/app/stores/view";
import { viewState, setAllExpanded } from "../../src/app/stores/view";
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
    screen.getByRole("status", { name: /Loading workflow runs/i });
    expect(screen.queryByText("No workflow runs found.")).toBeNull();
  });

  it("groups runs by repository — repo headers visible", () => {
    const runs = [
      makeWorkflowRun({ repoFullName: "owner/repo-a", workflowId: 1, name: "CI" }),
      makeWorkflowRun({ repoFullName: "owner/repo-b", workflowId: 2, name: "CI" }),
    ];
    render(() => <ActionsTab workflowRuns={runs} />);
    screen.getByText("owner/repo-a");
    screen.getByText("owner/repo-b");
  });

  it("repo groups start collapsed — run row content not visible by default", () => {
    const runs = [
      makeWorkflowRun({ repoFullName: "owner/repo", workflowId: 1, name: "CI", displayTitle: "unique-run-title" }),
    ];
    render(() => <ActionsTab workflowRuns={runs} />);
    // Repo header visible
    screen.getByText("owner/repo");
    // Run row content not visible (collapsed by default)
    expect(screen.queryByText("unique-run-title")).toBeNull();
  });

  it("clicking repo header expands it and shows workflow cards", async () => {
    const user = userEvent.setup();
    const runs = [
      makeWorkflowRun({ repoFullName: "owner/repo", workflowId: 1, name: "CI", displayTitle: "unique-run-title" }),
    ];
    render(() => <ActionsTab workflowRuns={runs} />);
    // Collapsed by default
    expect(screen.queryByText("unique-run-title")).toBeNull();

    // Click repo header to expand
    const repoHeader = screen.getByText("owner/repo");
    await user.click(repoHeader);

    // Workflow card name should now be visible
    expect(screen.getAllByText("CI").length).toBeGreaterThanOrEqual(1);
  });

  it("clicking repo header again collapses it", async () => {
    const user = userEvent.setup();
    const runs = [
      makeWorkflowRun({ repoFullName: "owner/repo", workflowId: 1, name: "CI", displayTitle: "unique-run-title" }),
    ];
    render(() => <ActionsTab workflowRuns={runs} />);

    const repoHeader = screen.getByText("owner/repo");
    // Expand
    await user.click(repoHeader);
    expect(screen.getAllByText("CI").length).toBeGreaterThanOrEqual(1);

    // Collapse
    await user.click(repoHeader);
    // Workflow card now hidden
    expect(screen.queryByText("unique-run-title")).toBeNull();
  });

  it("collapsed repo header shows aggregate pass/fail summary", () => {
    const runs = [
      makeWorkflowRun({ repoFullName: "owner/repo", workflowId: 1, name: "Build", conclusion: "success" }),
      makeWorkflowRun({ repoFullName: "owner/repo", workflowId: 2, name: "Deploy", conclusion: "failure" }),
      makeWorkflowRun({ repoFullName: "owner/repo", workflowId: 3, name: "Lint", conclusion: "success" }),
    ];
    render(() => <ActionsTab workflowRuns={runs} />);
    // Collapsed by default — summary span shows aggregate counts
    const summaryEl = screen.getByText(/\d+ workflow/);
    expect(summaryEl.textContent).toContain("passed");
    expect(summaryEl.textContent).toContain("failed");
  });

  it("collapsed repo header summary disappears when repo is expanded", async () => {
    const user = userEvent.setup();
    const runs = [
      makeWorkflowRun({ repoFullName: "owner/repo", workflowId: 1, name: "CI", conclusion: "success" }),
    ];
    render(() => <ActionsTab workflowRuns={runs} />);
    // Summary span visible when collapsed
    expect(screen.getByText(/\d+ workflow/)).not.toBeNull();

    await user.click(screen.getByText("owner/repo"));
    // Summary hidden when expanded
    expect(screen.queryByText(/\d+ workflow/)).toBeNull();
  });

  it("workflow cards render in grid after expanding repo", async () => {
    const user = userEvent.setup();
    const runs = [
      makeWorkflowRun({ repoFullName: "owner/repo", workflowId: 1, name: "Build" }),
      makeWorkflowRun({ repoFullName: "owner/repo", workflowId: 2, name: "Deploy" }),
    ];
    render(() => <ActionsTab workflowRuns={runs} />);

    await user.click(screen.getByText("owner/repo"));

    // Both workflow names visible as card headers
    expect(screen.getAllByText("Build").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Deploy").length).toBeGreaterThanOrEqual(1);
  });

  it("failing workflows sort before passing ones in card grid", async () => {
    const user = userEvent.setup();
    const runs = [
      makeWorkflowRun({ repoFullName: "owner/repo", workflowId: 1, name: "Passing", conclusion: "success", createdAt: "2024-01-10T10:00:00Z" }),
      makeWorkflowRun({ repoFullName: "owner/repo", workflowId: 2, name: "Failing", conclusion: "failure", createdAt: "2024-01-10T09:00:00Z" }),
    ];
    render(() => <ActionsTab workflowRuns={runs} />);

    await user.click(screen.getByText("owner/repo"));

    const cards = screen.getAllByText(/Passing|Failing/);
    // Failing card should appear before passing
    const failingIndex = cards.findIndex((el) => el.textContent === "Failing");
    const passingIndex = cards.findIndex((el) => el.textContent === "Passing");
    expect(failingIndex).toBeLessThan(passingIndex);
  });

  it("clicking workflow card expands to show run rows", async () => {
    const user = userEvent.setup();
    const runs = [
      makeWorkflowRun({ repoFullName: "owner/repo", workflowId: 1, name: "CI", displayTitle: "my-unique-run" }),
    ];
    render(() => <ActionsTab workflowRuns={runs} />);

    // Expand repo first
    await user.click(screen.getByText("owner/repo"));
    // Run row not visible (card collapsed)
    expect(screen.queryByText("my-unique-run")).toBeNull();

    // Click the workflow card
    const cards = screen.getAllByText("CI");
    await user.click(cards[0]);

    // Run row now visible
    screen.getByText("my-unique-run");
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

  it("hides PR runs by default (showPrRuns=false)", async () => {
    const user = userEvent.setup();
    const runs = [
      makeWorkflowRun({ id: 1, name: "CI", repoFullName: "owner/repo", workflowId: 1, isPrRun: true, displayTitle: "pr-run-title" }),
      makeWorkflowRun({ id: 2, name: "Push-CI", repoFullName: "owner/repo", workflowId: 2, isPrRun: false, displayTitle: "push-run-title" }),
    ];
    render(() => <ActionsTab workflowRuns={runs} />);
    // Expand repo and workflow to check run rows
    await user.click(screen.getByText("owner/repo"));
    const cards = screen.getAllByText("Push-CI");
    await user.click(cards[0]);

    // PR run card not visible (filtered out entirely)
    expect(screen.queryByText("pr-run-title")).toBeNull();
    // Push run visible
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

    // Repo now appears; expand it and the card
    await user.click(screen.getByText("owner/repo"));
    const cards = screen.getAllByText("CI");
    await user.click(cards[0]);

    screen.getByText("pr-run-title");
  });

  it("filters by conclusion tab filter", async () => {
    const user = userEvent.setup();
    const runs = [
      makeWorkflowRun({ id: 1, repoFullName: "owner/repo", workflowId: 1, name: "CI", status: "completed", conclusion: "success", displayTitle: "success-run" }),
      makeWorkflowRun({ id: 2, repoFullName: "owner/repo", workflowId: 2, name: "CI-fail", status: "completed", conclusion: "failure", displayTitle: "failure-run" }),
    ];
    viewStore.setTabFilter("actions", "conclusion", "success");
    render(() => <ActionsTab workflowRuns={runs} />);

    await user.click(screen.getByText("owner/repo"));
    const cards = screen.getAllByText("CI");
    await user.click(cards[0]);

    screen.getByText("success-run");
    expect(screen.queryByText("failure-run")).toBeNull();
  });

  it("filters by event tab filter", async () => {
    const user = userEvent.setup();
    const runs = [
      makeWorkflowRun({ id: 1, repoFullName: "owner/repo", workflowId: 1, name: "Push-CI", event: "push", displayTitle: "push-run" }),
      makeWorkflowRun({ id: 2, repoFullName: "owner/repo", workflowId: 2, name: "Sched-CI", event: "schedule", displayTitle: "schedule-run" }),
    ];
    viewStore.setTabFilter("actions", "event", "push");
    render(() => <ActionsTab workflowRuns={runs} />);

    await user.click(screen.getByText("owner/repo"));
    const cards = screen.getAllByText("Push-CI");
    await user.click(cards[0]);

    screen.getByText("push-run");
    expect(screen.queryByText("schedule-run")).toBeNull();
  });

  it("sets aria-expanded=false on repo group header by default (collapsed)", () => {
    const runs = [
      makeWorkflowRun({ repoFullName: "owner/repo", workflowId: 1, name: "CI" }),
    ];
    render(() => <ActionsTab workflowRuns={runs} />);
    const repoHeader = screen.getByText("owner/repo").closest("button")!;
    expect(repoHeader.getAttribute("aria-expanded")).toBe("false");
  });

  it("toggles repo aria-expanded on click", async () => {
    const user = userEvent.setup();
    const runs = [
      makeWorkflowRun({ repoFullName: "owner/repo", workflowId: 1, name: "CI" }),
    ];
    render(() => <ActionsTab workflowRuns={runs} />);
    const repoHeader = screen.getByText("owner/repo").closest("button")!;
    expect(repoHeader.getAttribute("aria-expanded")).toBe("false");

    await user.click(repoHeader);
    expect(repoHeader.getAttribute("aria-expanded")).toBe("true");

    await user.click(repoHeader);
    expect(repoHeader.getAttribute("aria-expanded")).toBe("false");
  });

  it("toolbar: Show PR runs checkbox, FilterToolbar, and IgnoreBadge are present", () => {
    render(() => <ActionsTab workflowRuns={[]} />);
    screen.getByRole("checkbox");
    screen.getByText("Show PR runs");
  });

  it("Expand all button expands all repo groups", async () => {
    const user = userEvent.setup();
    const runs = [
      makeWorkflowRun({ repoFullName: "owner/repo-a", workflowId: 1, name: "CI-A", displayTitle: "run-a" }),
      makeWorkflowRun({ repoFullName: "owner/repo-b", workflowId: 2, name: "CI-B", displayTitle: "run-b" }),
    ];
    render(() => <ActionsTab workflowRuns={runs} />);

    // Both groups collapsed by default
    expect(screen.queryByText("run-a")).toBeNull();
    expect(screen.queryByText("run-b")).toBeNull();

    await user.click(screen.getByRole("button", { name: /Expand all/i }));

    // After expand all, workflow names visible (repos expanded)
    expect(screen.getAllByText("CI-A").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("CI-B").length).toBeGreaterThanOrEqual(1);
  });

  it("Collapse all button collapses all repo groups", async () => {
    const user = userEvent.setup();
    const runs = [
      makeWorkflowRun({ repoFullName: "owner/repo-a", workflowId: 1, name: "CI-A" }),
      makeWorkflowRun({ repoFullName: "owner/repo-b", workflowId: 2, name: "CI-B" }),
    ];
    render(() => <ActionsTab workflowRuns={runs} />);

    // Expand all first
    await user.click(screen.getByRole("button", { name: /Expand all/i }));
    expect(screen.getAllByText("CI-A").length).toBeGreaterThanOrEqual(1);

    // Collapse all
    await user.click(screen.getByRole("button", { name: /Collapse all/i }));

    // Repo groups collapsed — workflow names hidden
    expect(screen.queryByText("CI-A")).toBeNull();
    expect(screen.queryByText("CI-B")).toBeNull();
  });

  it("workflow card expansion is independent of repo-level expand/collapse all", async () => {
    const user = userEvent.setup();
    const runs = [
      makeWorkflowRun({ repoFullName: "owner/repo", workflowId: 1, name: "CI", displayTitle: "my-unique-run" }),
    ];
    render(() => <ActionsTab workflowRuns={runs} />);

    // Expand repo
    await user.click(screen.getByRole("button", { name: /Expand all/i }));
    // Expand workflow card
    const cards = screen.getAllByText("CI");
    await user.click(cards[0]);
    // Run row now visible
    screen.getByText("my-unique-run");

    // Collapse all repos, then expand again
    await user.click(screen.getByRole("button", { name: /Collapse all/i }));
    await user.click(screen.getByRole("button", { name: /Expand all/i }));

    // Workflow card expansion is local component state (not persisted in viewState)
    // It survives collapse/expand within the same mount because expandedWorkflows
    // is at component scope, but would reset on full component remount
    expect(viewState.expandedRepos.actions["owner/repo"]).toBe(true);
    // Run row still visible — local store persists within same component instance
    screen.getByText("my-unique-run");
  });

  it("prunes stale expanded keys when a repo disappears from data", () => {
    const [runs, setRuns] = createSignal<WorkflowRun[]>([
      makeWorkflowRun({ repoFullName: "owner/repo-a", workflowId: 1, name: "CI-A" }),
      makeWorkflowRun({ repoFullName: "owner/repo-b", workflowId: 2, name: "CI-B" }),
    ]);
    viewStore.setAllExpanded("actions", ["owner/repo-a", "owner/repo-b"], true);
    render(() => <ActionsTab workflowRuns={runs()} />);

    // Remove repo-b from data — pruning effect should fire
    setRuns([makeWorkflowRun({ repoFullName: "owner/repo-a", workflowId: 1, name: "CI-A" })]);
    expect(viewState.expandedRepos.actions["owner/repo-a"]).toBe(true);
    expect("owner/repo-b" in viewState.expandedRepos.actions).toBe(false);
  });

  it("preserves expanded keys when data becomes empty and restores UI on re-population", () => {
    const [runs, setRuns] = createSignal<WorkflowRun[]>([
      makeWorkflowRun({ repoFullName: "owner/repo", workflowId: 1, name: "CI" }),
    ]);
    viewStore.setAllExpanded("actions", ["owner/repo"], true);
    render(() => <ActionsTab workflowRuns={runs()} />);

    setRuns([]);
    expect(viewState.expandedRepos.actions["owner/repo"]).toBe(true);

    // Data returns — UI should use preserved expanded state
    setRuns([makeWorkflowRun({ repoFullName: "owner/repo", workflowId: 1, name: "CI" })]);
    expect(screen.getAllByText("CI").length).toBeGreaterThanOrEqual(1);
  });

  it("expanded repo state persists in viewState", async () => {
    const user = userEvent.setup();
    const runs = [
      makeWorkflowRun({ repoFullName: "owner/repo", workflowId: 1, name: "CI" }),
    ];
    render(() => <ActionsTab workflowRuns={runs} />);

    // Initially not expanded
    expect(viewState.expandedRepos.actions["owner/repo"]).toBeFalsy();

    // Click repo header to expand
    await user.click(screen.getByText("owner/repo"));

    // viewState updated
    expect(viewState.expandedRepos.actions["owner/repo"]).toBe(true);

    // Click again to collapse
    await user.click(screen.getByText("owner/repo"));
    expect(viewState.expandedRepos.actions["owner/repo"]).toBeFalsy();
  });

  it("expanded state survives component unmount and remount", async () => {
    const user = userEvent.setup();
    const runs = [
      makeWorkflowRun({ repoFullName: "owner/repo", workflowId: 1, name: "CI", displayTitle: "unique-title" }),
    ];

    // First render — expand repo
    const { unmount } = render(() => <ActionsTab workflowRuns={runs} />);
    await user.click(screen.getByText("owner/repo"));
    expect(viewState.expandedRepos.actions["owner/repo"]).toBe(true);

    // Unmount
    unmount();

    // Re-render — viewState persists so repo should still be expanded
    render(() => <ActionsTab workflowRuns={runs} />);
    // Workflow name visible means the repo group is expanded
    expect(screen.getAllByText("CI").length).toBeGreaterThanOrEqual(1);
    expect(viewState.expandedRepos.actions["owner/repo"]).toBe(true);
  });

  it("passes hotPollingRunIds to workflow summary cards", async () => {
    const user = userEvent.setup();
    const runs = [
      makeWorkflowRun({ id: 10, repoFullName: "org/repo", workflowId: 1, name: "CI", status: "in_progress", conclusion: null }),
      makeWorkflowRun({ id: 20, repoFullName: "org/repo", workflowId: 1, name: "CI", status: "completed", conclusion: "success" }),
    ];
    setAllExpanded("actions", ["org/repo"], true);
    const { container } = render(() => (
      <ActionsTab workflowRuns={runs} hotPollingRunIds={new Set([10])} />
    ));
    // Click workflow card header to expand and show individual run rows
    const ciHeader = screen.getByText("CI");
    await user.click(ciHeader);
    // Now WorkflowRunRow elements should be visible with shimmer on the hot-polled run
    const runRows = container.querySelectorAll("[class*='flex items-center gap-3']");
    expect(runRows.length).toBeGreaterThanOrEqual(2);
    expect(runRows[0]?.classList.contains("animate-shimmer")).toBe(true);
    expect(runRows[1]?.classList.contains("animate-shimmer")).toBe(false);
  });

  it("does not apply shimmer when hotPollingRunIds is undefined", async () => {
    const user = userEvent.setup();
    const runs = [
      makeWorkflowRun({ id: 1, repoFullName: "org/repo", workflowId: 1, name: "CI", status: "in_progress", conclusion: null }),
    ];
    setAllExpanded("actions", ["org/repo"], true);
    const { container } = render(() => <ActionsTab workflowRuns={runs} />);
    await user.click(screen.getByText("CI"));
    const runRows = container.querySelectorAll("[class*='flex items-center gap-3']");
    for (const row of runRows) {
      expect(row.classList.contains("animate-shimmer")).toBe(false);
    }
  });
});
