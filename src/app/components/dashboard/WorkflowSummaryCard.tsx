import { For, Show } from "solid-js";
import type { WorkflowRun } from "../../services/api";
import WorkflowRunRow from "./WorkflowRunRow";

interface WorkflowSummaryCardProps {
  workflowName: string;
  runs: WorkflowRun[];
  expanded: boolean;
  onToggle: () => void;
  onIgnoreRun: (run: WorkflowRun) => void;
  density: "compact" | "comfortable";
}

function getAccentColor(runs: WorkflowRun[]): "green" | "red" | "yellow" | "gray" {
  const hasFailure = runs.some((r) => r.conclusion === "failure");
  const hasRunning = runs.some((r) => r.status === "in_progress");
  const allSuccess = runs.every((r) => r.conclusion === "success");

  if (hasFailure) return "red";
  if (hasRunning) return "yellow";
  if (allSuccess) return "green";
  return "gray";
}

export default function WorkflowSummaryCard(props: WorkflowSummaryCardProps) {
  const successCount = () => props.runs.filter((r) => r.conclusion === "success").length;
  const failureCount = () => props.runs.filter((r) => r.conclusion === "failure").length;
  const runningCount = () => props.runs.filter((r) => r.status === "in_progress").length;

  const accentColor = () => getAccentColor(props.runs);

  const hasFailure = () => failureCount() > 0;

  const borderLeftClass = () => {
    const color = accentColor();
    if (color === "red") return "border-l-4 border-l-red-500";
    if (color === "yellow") return "border-l-4 border-l-yellow-500";
    if (color === "green") return "border-l-4 border-l-green-500";
    return "border-l-4 border-l-gray-300 dark:border-l-gray-600";
  };

  const cardBgClass = () =>
    hasFailure()
      ? "border-red-300 dark:border-red-700 bg-red-50/50 dark:bg-red-900/10"
      : "bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700";

  return (
    <div
      class={`rounded-lg border p-3 cursor-pointer transition-colors hover:bg-gray-50 dark:hover:bg-gray-800/50 ${borderLeftClass()} ${cardBgClass()}`}
      onClick={props.onToggle}
    >
      {/* Card header */}
      <div class="flex items-center gap-2 min-w-0">
        <span class="truncate text-sm font-medium text-gray-800 dark:text-gray-200 flex-1 min-w-0">
          {props.workflowName}
        </span>
        <div class="flex items-center gap-1.5 shrink-0">
          <Show when={successCount() > 0}>
            <span class="text-xs font-medium text-green-600 dark:text-green-400">
              {successCount()}
            </span>
          </Show>
          <Show when={failureCount() > 0}>
            <span class="text-xs font-medium text-red-600 dark:text-red-400">
              {failureCount()}
            </span>
          </Show>
          <Show when={runningCount() > 0}>
            <span class="text-xs font-medium text-yellow-600 dark:text-yellow-400">
              {runningCount()}
            </span>
          </Show>
        </div>
      </div>

      {/* Expanded run list */}
      <Show when={props.expanded}>
        <div
          class="mt-2 divide-y divide-gray-50 dark:divide-gray-800/50"
          onClick={(e) => e.stopPropagation()}
        >
          <For each={props.runs}>
            {(run) => (
              <WorkflowRunRow
                run={run}
                onIgnore={props.onIgnoreRun}
                density={props.density}
              />
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
