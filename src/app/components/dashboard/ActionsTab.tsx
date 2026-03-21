import { createMemo, createSignal, For, Show } from "solid-js";
import type { WorkflowRun, ApiError } from "../../services/api";
import { config } from "../../stores/config";
import { viewState, ignoreItem, unignoreItem } from "../../stores/view";
import WorkflowRunRow from "./WorkflowRunRow";
import IgnoreBadge from "./IgnoreBadge";
import ErrorBannerList from "../shared/ErrorBannerList";

interface ActionsTabProps {
  workflowRuns: WorkflowRun[];
  loading?: boolean;
  errors?: ApiError[];
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
    result.push({
      repoFullName,
      workflows: Array.from(wfMap.values()),
    });
  }

  return result;
}

export default function ActionsTab(props: ActionsTabProps) {
  const [collapsedRepos, setCollapsedRepos] = createSignal<Set<string>>(
    new Set()
  );
  const [collapsedWorkflows, setCollapsedWorkflows] = createSignal<Set<string>>(
    new Set()
  );
  const [showPrRuns, setShowPrRuns] = createSignal(false);

  function toggleRepo(repoFullName: string) {
    setCollapsedRepos((prev) => {
      const next = new Set(prev);
      if (next.has(repoFullName)) {
        next.delete(repoFullName);
      } else {
        next.add(repoFullName);
      }
      return next;
    });
  }

  function toggleWorkflow(key: string) {
    setCollapsedWorkflows((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
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
    const ignoredIds = new Set(viewState.ignoredItems.map((i) => i.id));

    return props.workflowRuns.filter((run) => {
      if (ignoredIds.has(String(run.id))) return false;
      if (!showPrRuns() && run.isPrRun) return false;
      if (org && !run.repoFullName.startsWith(`${org}/`)) return false;
      if (repo && run.repoFullName !== repo) return false;
      return true;
    });
  });

  const repoGroups = createMemo(() => groupRuns(filteredRuns()));

  return (
    <div class="divide-y divide-gray-100 dark:divide-gray-800">
      {/* Toolbar */}
      <div class="flex items-center gap-3 px-4 py-2 bg-white dark:bg-gray-900">
        <label class="flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-400 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showPrRuns()}
            onChange={(e) => setShowPrRuns(e.currentTarget.checked)}
            class="rounded border-gray-300 dark:border-gray-600 text-blue-500 focus:ring-blue-500"
          />
          Show PR runs
        </label>
        <div class="flex-1" />
        <IgnoreBadge
          items={viewState.ignoredItems.filter((i) => i.type === "workflowRun")}
          onUnignore={unignoreItem}
        />
      </div>

      {/* Loading */}
      <Show when={props.loading}>
        <div class="p-8 text-center text-gray-500 dark:text-gray-400">
          <svg
            class="animate-spin h-6 w-6 mx-auto mb-2 text-gray-400"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            aria-label="Loading"
          >
            <circle
              class="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              stroke-width="4"
            />
            <path
              class="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
          <p class="text-sm">Loading workflow runs...</p>
        </div>
      </Show>

      {/* Error */}
      <Show when={!props.loading}>
        <ErrorBannerList errors={props.errors} />
      </Show>

      {/* Empty */}
      <Show
        when={
          !props.loading && (!props.errors || props.errors.length === 0) && repoGroups().length === 0
        }
      >
        <div class="p-8 text-center text-gray-500 dark:text-gray-400">
          <p class="text-sm">No workflow runs found.</p>
        </div>
      </Show>

      {/* Repo groups */}
      <Show when={!props.loading && repoGroups().length > 0}>
        <For each={repoGroups()}>
          {(repoGroup) => {
            const isRepoCollapsed = () =>
              collapsedRepos().has(repoGroup.repoFullName);

            return (
              <div class="bg-white dark:bg-gray-900">
                {/* Repo header */}
                <button
                  onClick={() => toggleRepo(repoGroup.repoFullName)}
                  class="w-full flex items-center gap-2 px-4 py-2 text-left text-sm font-semibold text-gray-700 dark:text-gray-200 bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    class={`h-3.5 w-3.5 text-gray-400 transition-transform ${isRepoCollapsed() ? "-rotate-90" : ""}`}
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    aria-hidden="true"
                  >
                    <path
                      fill-rule="evenodd"
                      d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
                      clip-rule="evenodd"
                    />
                  </svg>
                  {repoGroup.repoFullName}
                </button>

                {/* Workflow groups */}
                <Show when={!isRepoCollapsed()}>
                  <For each={repoGroup.workflows}>
                    {(wfGroup) => {
                      const wfKey = `${repoGroup.repoFullName}:${wfGroup.workflowId}`;
                      const isWfCollapsed = () =>
                        collapsedWorkflows().has(wfKey);

                      return (
                        <div class="border-l-2 border-gray-100 dark:border-gray-800 ml-4">
                          {/* Workflow header */}
                          <button
                            onClick={() => toggleWorkflow(wfKey)}
                            class="w-full flex items-center gap-2 px-4 py-1.5 text-left text-xs font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
                          >
                            <svg
                              xmlns="http://www.w3.org/2000/svg"
                              class={`h-3 w-3 text-gray-400 transition-transform ${isWfCollapsed() ? "-rotate-90" : ""}`}
                              viewBox="0 0 20 20"
                              fill="currentColor"
                              aria-hidden="true"
                            >
                              <path
                                fill-rule="evenodd"
                                d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
                                clip-rule="evenodd"
                              />
                            </svg>
                            {wfGroup.workflowName}
                          </button>

                          {/* Runs */}
                          <Show when={!isWfCollapsed()}>
                            <div class="divide-y divide-gray-50 dark:divide-gray-800/50">
                              <For each={wfGroup.runs}>
                                {(run) => (
                                  <WorkflowRunRow
                                    run={run}
                                    onIgnore={handleIgnore}
                                    density={config.viewDensity}
                                  />
                                )}
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
          }}
        </For>
      </Show>
    </div>
  );
}
