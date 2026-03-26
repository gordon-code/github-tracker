import { createMemo, For, Show } from "solid-js";
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

export default function WorkflowSummaryCard(props: WorkflowSummaryCardProps) {
  const counts = createMemo(() => {
    let success = 0;
    let failure = 0;
    let running = 0;
    for (const r of props.runs) {
      if (r.status === "in_progress") running++;
      else if (r.conclusion === "success") success++;
      else if (r.conclusion === "failure") failure++;
    }
    return { success, failure, running };
  });

  const accentColor = createMemo(() => {
    const { failure, running, success } = counts();
    if (failure > 0) return "red";
    if (running > 0) return "yellow";
    if (success > 0 && success === props.runs.length) return "green";
    return "gray";
  });

  const hasFailure = createMemo(() => counts().failure > 0);

  const borderLeftClass = createMemo(() => {
    const color = accentColor();
    if (color === "red") return "border-l-4 border-l-error";
    if (color === "yellow") return "border-l-4 border-l-warning";
    if (color === "green") return "border-l-4 border-l-success";
    return "border-l-4 border-l-base-300";
  });

  const cardBgClass = createMemo(() =>
    hasFailure()
      ? "bg-error/5 border-error/30"
      : "bg-base-100 border-base-300"
  );

  const hoverClass = createMemo(() =>
    hasFailure()
      ? "hover:bg-error/10"
      : "hover:bg-base-200"
  );

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      props.onToggle();
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={props.expanded}
      aria-label={props.workflowName}
      class={`rounded-lg border p-3 cursor-pointer transition-colors ${hoverClass()} ${borderLeftClass()} ${cardBgClass()}`}
      onClick={props.onToggle}
      onKeyDown={handleKeyDown}
    >
      {/* Card header */}
      <div class="flex items-center gap-2 min-w-0">
        <span class="truncate text-sm font-medium text-base-content flex-1 min-w-0">
          {props.workflowName}
        </span>
        <div class="flex items-center gap-1.5 shrink-0">
          <Show when={counts().success > 0}>
            <span class="text-xs font-medium text-success" title={`${counts().success} successful`}>
              {counts().success}
            </span>
          </Show>
          <Show when={counts().failure > 0}>
            <span class="text-xs font-medium text-error" title={`${counts().failure} failed`}>
              {counts().failure}
            </span>
          </Show>
          <Show when={counts().running > 0}>
            <span class="text-xs font-medium text-warning" title={`${counts().running} running`}>
              {counts().running}
            </span>
          </Show>
        </div>
      </div>

      {/* Expanded run list */}
      <Show when={props.expanded}>
        <div
          class="mt-2 divide-y divide-base-200"
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
