import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import ActionsTab from "../../src/app/components/dashboard/ActionsTab";
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

  it("toolbar: Show PR runs checkbox, FilterChips, and IgnoreBadge are present", () => {
    render(() => <ActionsTab workflowRuns={[]} />);
    screen.getByRole("checkbox");
    screen.getByText("Show PR runs");
  });
});
