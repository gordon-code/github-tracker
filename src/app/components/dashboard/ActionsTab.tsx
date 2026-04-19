import { createEffect, createMemo, For, Show } from "solid-js";
import { createStore } from "solid-js/store";
import type { WorkflowRun } from "../../services/api";
import { viewState, setViewState, setTabFilter, resetAllTabFilters, ignoreItem, unignoreItem, toggleExpandedRepo, setAllExpanded, pruneExpandedRepos, pruneLockedRepos, setCustomTabFilter, resetCustomTabFilters, ActionsFiltersSchema, type ActionsFilterField } from "../../stores/view";
import { isRunVisible } from "../../lib/filters";
import WorkflowSummaryCard from "./WorkflowSummaryCard";
import IgnoreBadge from "./IgnoreBadge";
import SkeletonRows from "../shared/SkeletonRows";
import type { FilterChipGroupDef } from "../shared/filterTypes";
import FilterToolbar from "../shared/FilterToolbar";
import RepoGroupHeader from "../shared/RepoGroupHeader";
import ExpandCollapseButtons from "../shared/ExpandCollapseButtons";
import RepoLockControls from "../shared/RepoLockControls";
import RepoGitHubLink from "../shared/RepoGitHubLink";
import { orderRepoGroups } from "../../lib/grouping";
import { createReorderHighlight } from "../../lib/reorderHighlight";
import { createFlashDetection } from "../../lib/flashDetection";

interface ActionsTabProps {
  workflowRuns: WorkflowRun[];
  loading?: boolean;
  hasUpstreamRepos?: boolean;
  configRepoNames?: string[];
  refreshTick?: number;
  hotPollingRunIds?: ReadonlySet<number>;
  customTabId?: string;
  filterPreset?: Record<string, string>;
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
  const [expandedWorkflows, setExpandedWorkflows] = createStore<Record<string, boolean>>({});

  const tabKey = () => props.customTabId ?? "actions";

  function toggleWorkflow(key: string) {
    setExpandedWorkflows(key, (v) => !v);
  }

  const activeRepoNames = createMemo(() =>
    props.configRepoNames ?? [...new Set(props.workflowRuns.map((r) => r.repoFullName))]
  );

  const ignoredWorkflowRuns = createMemo(() =>
    viewState.ignoredItems.filter(i => i.type === "workflowRun")
  );

  // Merge chain: schema defaults → preset → stored runtime overrides
  const activeFilters = createMemo(() => {
    if (props.customTabId) {
      const stored = viewState.customTabFilters[props.customTabId] ?? {};
      const preset = props.filterPreset ?? {};
      const defaults = ActionsFiltersSchema.parse({});
      const merged = { ...defaults, ...preset, ...stored };
      return ActionsFiltersSchema.safeParse(merged).data ?? defaults;
    }
    return viewState.tabFilters.actions;
  });

  function handleFilterChange(field: string, value: string) {
    if (props.customTabId) {
      setCustomTabFilter(props.customTabId, field, value);
    } else {
      setTabFilter("actions", field as ActionsFilterField, value);
    }
  }

  function handleResetFilters() {
    if (props.customTabId) {
      resetCustomTabFilters(props.customTabId);
    } else {
      resetAllTabFilters("actions");
    }
  }

  createEffect(() => {
    const names = activeRepoNames();
    if (names.length === 0) return;
    pruneExpandedRepos(tabKey(), names);
  });

  const { flashingIds: flashingRunIds, peekUpdates } = createFlashDetection({
    getItems: () => props.workflowRuns,
    getHotIds: () => props.hotPollingRunIds,
    getExpandedRepos: () => viewState.expandedRepos[tabKey()] ?? {},
    trackKey: (run) => `${run.status}|${run.conclusion}`,
    itemLabel: (run) => run.name,
    itemStatus: (run) => run.conclusion ?? run.status,
  });

  function handleIgnore(run: WorkflowRun) {
    ignoreItem({
      id: run.id,
      type: "workflowRun",
      repo: run.repoFullName,
      title: run.name,
      ignoredAt: Date.now(),
    });
  }

  const filteredRuns = createMemo(() => {
    const ignoredIds = new Set(ignoredWorkflowRuns().map((i) => i.id));
    const globalFilter = props.customTabId ? null : viewState.globalFilter;
    const conclusionFilter = activeFilters().conclusion;
    const eventFilter = activeFilters().event;

    return props.workflowRuns.filter((run) => {
      if (!isRunVisible(run, { ignoredIds, showPrRuns: viewState.showPrRuns, globalFilter })) return false;

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

  const repoGroups = createMemo(() =>
    orderRepoGroups(groupRuns(filteredRuns()), viewState.lockedRepos)
  );

  createEffect(() => {
    const names = activeRepoNames();
    if (names.length === 0) return;
    pruneLockedRepos(names);
  });

  const highlightedReposActions = createReorderHighlight(
    () => repoGroups().map(g => g.repoFullName),
    () => viewState.lockedRepos,
    () => ignoredWorkflowRuns().length,
    () => JSON.stringify(props.customTabId
      ? (viewState.customTabFilters[props.customTabId] ?? {})
      : viewState.tabFilters.actions),
  );

  return (
    <div class="divide-y divide-base-300">
      {/* Toolbar */}
      <div class="flex items-start px-4 py-2 gap-3 compact:py-0.5 compact:gap-2 border-b border-base-300 bg-base-100">
        <div class="flex flex-wrap items-center min-w-0 flex-1 gap-3 compact:gap-2">
          <label class="flex items-center gap-1.5 text-sm text-base-content/70 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={viewState.showPrRuns}
              onChange={(e) => setViewState("showPrRuns", e.currentTarget.checked)}
              class="checkbox checkbox-sm checkbox-primary"
            />
            Show PR runs
          </label>
          <FilterToolbar
            groups={actionsFilterGroups}
            values={activeFilters()}
            onChange={(f, v) => handleFilterChange(f, v)}
            onResetAll={() => handleResetFilters()}
          />
        </div>
        <div class="shrink-0 flex items-center gap-2 py-0.5">
          <ExpandCollapseButtons
            onExpandAll={() => setAllExpanded(tabKey(), repoGroups().map((g) => g.repoFullName), true)}
            onCollapseAll={() => setAllExpanded(tabKey(), repoGroups().map((g) => g.repoFullName), false)}
          />
          <IgnoreBadge
            items={ignoredWorkflowRuns()}
            onUnignore={unignoreItem}
          />
        </div>
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
        <div class="p-8 text-center text-base-content/50">
          <p class="text-sm">No workflow runs found.</p>
        </div>
      </Show>

      {/* Repo groups */}
      <Show when={repoGroups().length > 0}>
        <For each={repoGroups()}>
          {(repoGroup) => {
            const isExpanded = () => !!(viewState.expandedRepos[tabKey()] ?? {})[repoGroup.repoFullName];

            const sortedWorkflows = createMemo(() =>
              sortWorkflowsByStatus(repoGroup.workflows)
            );

            const workflowCounts = createMemo(() => {
              const wfs = repoGroup.workflows;
              const total = wfs.length;
              let passed = 0;
              let failed = 0;
              let running = 0;
              for (const wf of wfs) {
                const latest = wf.runs[0];
                if (latest?.conclusion === "success") passed++;
                else if (latest?.conclusion === "failure") failed++;
                else if (latest?.status === "in_progress") running++;
              }
              return { total, passed, failed, running };
            });

            return (
              <div class="bg-base-100" data-repo-group={repoGroup.repoFullName}>
                <RepoGroupHeader
                  repoFullName={repoGroup.repoFullName}
                  isExpanded={isExpanded()}
                  isHighlighted={highlightedReposActions().has(repoGroup.repoFullName)}
                  onToggle={() => toggleExpandedRepo(tabKey(), repoGroup.repoFullName)}
                  trailing={
                    <>
                      <RepoGitHubLink repoFullName={repoGroup.repoFullName} section="actions" />
                      <RepoLockControls repoFullName={repoGroup.repoFullName} />
                    </>
                  }
                  collapsedSummary={
                    <span class="ml-auto text-xs font-normal text-base-content/60">
                      {workflowCounts().total} workflow{workflowCounts().total !== 1 ? "s" : ""}
                      <Show when={workflowCounts().passed > 0 || workflowCounts().failed > 0 || workflowCounts().running > 0}>
                        {": "}
                        <Show when={workflowCounts().passed > 0}>
                          <span>{workflowCounts().passed} passed</span>
                        </Show>
                        <Show when={workflowCounts().passed > 0 && (workflowCounts().failed > 0 || workflowCounts().running > 0)}>
                          {", "}
                        </Show>
                        <Show when={workflowCounts().failed > 0}>
                          <span class="text-error font-medium">{workflowCounts().failed} failed</span>
                        </Show>
                        <Show when={workflowCounts().failed > 0 && workflowCounts().running > 0}>
                          {", "}
                        </Show>
                        <Show when={workflowCounts().running > 0}>
                          <span>{workflowCounts().running} running</span>
                        </Show>
                      </Show>
                    </span>
                  }
                />
                <Show when={!isExpanded() && peekUpdates().get(repoGroup.repoFullName)}>
                  {(peek) => (
                    <div class="animate-flash flex items-center gap-2 text-xs text-base-content/70 px-4 py-1.5 border-b border-base-300 bg-base-100">
                      <span class="loading loading-spinner loading-xs text-primary/60" />
                      <span class="truncate flex-1">{peek().itemLabel}</span>
                      <span class="badge badge-xs badge-primary">{peek().newStatus}</span>
                    </div>
                  )}
                </Show>

                {/* Workflow cards grid */}
                <Show when={isExpanded()}>
                  <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 p-3">
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
                              refreshTick={props.refreshTick}
                              hotPollingRunIds={props.hotPollingRunIds}
                              flashingRunIds={flashingRunIds()}
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

      {/* Upstream repos exclusion note */}
      <Show when={props.hasUpstreamRepos}>
        <p class="text-xs text-base-content/40 text-center py-2">
          Workflow runs are not tracked for upstream repositories.
        </p>
      </Show>
    </div>
  );
}
