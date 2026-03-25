import { createMemo, For, Show } from "solid-js";
import { createStore } from "solid-js/store";
import type { WorkflowRun } from "../../services/api";
import { config } from "../../stores/config";
import { viewState, setViewState, setTabFilter, resetTabFilter, resetAllTabFilters, ignoreItem, unignoreItem, type ActionsFilterField } from "../../stores/view";
import WorkflowSummaryCard from "./WorkflowSummaryCard";
import IgnoreBadge from "./IgnoreBadge";
import SkeletonRows from "../shared/SkeletonRows";
import FilterChips from "../shared/FilterChips";
import type { FilterChipGroupDef } from "../shared/FilterChips";
import ChevronIcon from "../shared/ChevronIcon";

interface ActionsTabProps {
  workflowRuns: WorkflowRun[];
  loading?: boolean;
}

interface WorkflowGroup {
  workflowId: number;
  workflowName: string;
  runs: WorkflowRun[];
}

interface RepoGroup {
  repoFullName: string;
  workflows: WorkflowGroup[];
}

function groupRuns(runs: WorkflowRun[]): RepoGroup[] {
  const repoMap = new Map<string, Map<number, WorkflowGroup>>();

  for (const run of runs) {
    let wfMap = repoMap.get(run.repoFullName);
    if (!wfMap) {
      wfMap = new Map<number, WorkflowGroup>();
      repoMap.set(run.repoFullName, wfMap);
    }

    let wfGroup = wfMap.get(run.workflowId);
    if (!wfGroup) {
      wfGroup = {
        workflowId: run.workflowId,
        workflowName: run.name,
        runs: [],
      };
      wfMap.set(run.workflowId, wfGroup);
    }

    wfGroup.runs.push(run);
  }

  const result: RepoGroup[] = [];
  for (const [repoFullName, wfMap] of repoMap) {
    const workflows = Array.from(wfMap.values());
    // Sort runs within each workflow: most recent first
    for (const wf of workflows) {
      wf.runs.sort((a, b) => (b.createdAt > a.createdAt ? 1 : b.createdAt < a.createdAt ? -1 : 0));
    }
    // Sort workflows within repo: most recent run first
    workflows.sort((a, b) => {
      const aLatest = a.runs[0]?.createdAt ?? "";
      const bLatest = b.runs[0]?.createdAt ?? "";
      return bLatest > aLatest ? 1 : bLatest < aLatest ? -1 : 0;
    });
    result.push({ repoFullName, workflows });
  }

  // Sort repos: most recent activity first
  result.sort((a, b) => {
    const aLatest = a.workflows[0]?.runs[0]?.createdAt ?? "";
    const bLatest = b.workflows[0]?.runs[0]?.createdAt ?? "";
    return bLatest > aLatest ? 1 : bLatest < aLatest ? -1 : 0;
  });

  return result;
}

function sortWorkflowsByStatus(workflows: WorkflowGroup[]): WorkflowGroup[] {
  return [...workflows].sort((a, b) => {
    const priorityOf = (wf: WorkflowGroup): number => {
      const latest = wf.runs[0];
      if (!latest) return 2;
      if (latest.conclusion === "failure") return 0;
      if (latest.status === "in_progress") return 1;
      return 2;
    };
    return priorityOf(a) - priorityOf(b);
  });
}

const KNOWN_CONCLUSIONS = ["success", "failure", "cancelled"];
const KNOWN_EVENTS = ["push", "pull_request", "schedule", "workflow_dispatch"];

const actionsFilterGroups: FilterChipGroupDef[] = [
  {
    label: "Result",
    field: "conclusion",
    options: [
      { value: "success", label: "Success" },
      { value: "failure", label: "Failure" },
      { value: "cancelled", label: "Cancelled" },
      { value: "running", label: "Running" },
      { value: "other", label: "Other" },
    ],
  },
  {
    label: "Trigger",
    field: "event",
    options: [
      { value: "push", label: "Push" },
      { value: "pull_request", label: "PR" },
      { value: "schedule", label: "Schedule" },
      { value: "workflow_dispatch", label: "Manual" },
    ],
  },
];

export default function ActionsTab(props: ActionsTabProps) {
  const [expandedRepos, setExpandedRepos] = createStore<Record<string, boolean>>({});
  const [expandedWorkflows, setExpandedWorkflows] = createStore<Record<string, boolean>>({});

  function toggleRepo(repoFullName: string) {
    setExpandedRepos(repoFullName, (v) => !v);
  }

  function toggleWorkflow(key: string) {
    setExpandedWorkflows(key, (v) => !v);
  }

  function handleIgnore(run: WorkflowRun) {
    ignoreItem({
      id: String(run.id),
      type: "workflowRun",
      repo: run.repoFullName,
      title: run.name,
      ignoredAt: Date.now(),
    });
  }


  const filteredRuns = createMemo(() => {
    const { org, repo } = viewState.globalFilter;
    const ignoredIds = new Set(
      viewState.ignoredItems
        .filter((i) => i.type === "workflowRun")
        .map((i) => i.id)
    );
    const conclusionFilter = viewState.tabFilters.actions.conclusion;
    const eventFilter = viewState.tabFilters.actions.event;

    return props.workflowRuns.filter((run) => {
      if (ignoredIds.has(String(run.id))) return false;
      if (!viewState.showPrRuns && run.isPrRun) return false;
      if (org && !run.repoFullName.startsWith(`${org}/`)) return false;
      if (repo && run.repoFullName !== repo) return false;

      if (conclusionFilter !== "all") {
        if (conclusionFilter === "running") {
          if (run.status !== "in_progress") return false;
        } else if (conclusionFilter === "other") {
          if (run.conclusion === null || KNOWN_CONCLUSIONS.includes(run.conclusion)) return false;
        } else {
          if (run.conclusion !== conclusionFilter) return false;
        }
      }

      if (eventFilter !== "all") {
        if (eventFilter === "other") {
          if (KNOWN_EVENTS.includes(run.event)) return false;
        } else {
          if (run.event !== eventFilter) return false;
        }
      }

      return true;
    });
  });

  const repoGroups = createMemo(() => groupRuns(filteredRuns()));

  return (
    <div class="divide-y divide-gray-100 dark:divide-gray-800">
      {/* Toolbar */}
      <div class="flex flex-wrap items-center gap-3 px-4 py-2 bg-white dark:bg-gray-900">
        <label class="flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-400 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={viewState.showPrRuns}
            onChange={(e) => setViewState("showPrRuns", e.currentTarget.checked)}
            class="rounded border-gray-300 dark:border-gray-600 text-blue-500 focus:ring-blue-500"
          />
          Show PR runs
        </label>
        <FilterChips
          groups={actionsFilterGroups}
          values={viewState.tabFilters.actions}
          onChange={(field, value) => setTabFilter("actions", field as ActionsFilterField, value)}
          onReset={(field) => resetTabFilter("actions", field as ActionsFilterField)}
          onResetAll={() => resetAllTabFilters("actions")}
        />
        <div class="flex-1" />
        <IgnoreBadge
          items={viewState.ignoredItems.filter((i) => i.type === "workflowRun")}
          onUnignore={unignoreItem}
        />
      </div>

      {/* Loading skeleton — only when no data exists yet */}
      <Show when={props.loading && props.workflowRuns.length === 0}>
        <SkeletonRows label="Loading workflow runs" />
      </Show>

      {/* Empty */}
      <Show
        when={
          !props.loading && repoGroups().length === 0
        }
      >
        <div class="p-8 text-center text-gray-500 dark:text-gray-400">
          <p class="text-sm">No workflow runs found.</p>
        </div>
      </Show>

      {/* Repo groups */}
      <Show when={repoGroups().length > 0}>
        <For each={repoGroups()}>
          {(repoGroup) => {
            const isExpanded = () => !!expandedRepos[repoGroup.repoFullName];

            const sortedWorkflows = createMemo(() =>
              sortWorkflowsByStatus(repoGroup.workflows)
            );

            const collapsedSummary = createMemo(() => {
              const wfs = repoGroup.workflows;
              const total = wfs.length;
              let passed = 0;
              let failed = 0;
              for (const wf of wfs) {
                const latest = wf.runs[0];
                if (latest?.conclusion === "success") passed++;
                else if (latest?.conclusion === "failure") failed++;
              }
              const parts: string[] = [];
              if (passed > 0) parts.push(`${passed} passed`);
              if (failed > 0) parts.push(`${failed} failed`);
              return `${total} workflow${total !== 1 ? "s" : ""}: ${parts.join(", ")}`;
            });

            return (
              <div class="bg-white dark:bg-gray-900">
                {/* Repo header */}
                <button
                  onClick={() => toggleRepo(repoGroup.repoFullName)}
                  aria-expanded={isExpanded()}
                  class="w-full flex items-center gap-2 px-4 py-2 text-left text-sm font-semibold text-gray-700 dark:text-gray-200 bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                >
                  <ChevronIcon size="md" rotated={!isExpanded()} />
                  {repoGroup.repoFullName}
                  <Show when={!isExpanded()}>
                    <span class="ml-2 text-xs font-normal text-gray-500 dark:text-gray-400">
                      {collapsedSummary()}
                    </span>
                  </Show>
                </button>

                {/* Workflow cards grid */}
                <Show when={isExpanded()}>
                  <div class="grid grid-cols-2 sm:grid-cols-3 gap-3 p-3">
                    <For each={sortedWorkflows()}>
                      {(wfGroup) => {
                        const wfKey = `${repoGroup.repoFullName}:${wfGroup.workflowId}`;
                        const isWfExpanded = () => !!expandedWorkflows[wfKey];

                        return (
                          <div class={isWfExpanded() ? "col-span-full" : ""}>
                            <WorkflowSummaryCard
                              workflowName={wfGroup.workflowName}
                              runs={wfGroup.runs}
                              expanded={isWfExpanded()}
                              onToggle={() => toggleWorkflow(wfKey)}
                              onIgnoreRun={handleIgnore}
                              density={config.viewDensity}
                            />
                          </div>
                        );
                      }}
                    </For>
                  </div>
                </Show>
              </div>
            );
          }}
        </For>
      </Show>
    </div>
  );
}
