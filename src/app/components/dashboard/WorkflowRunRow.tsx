import { createMemo, Show } from "solid-js";
import type { WorkflowRun } from "../../services/api";
import type { Config } from "../../stores/config";
import { isSafeGitHubUrl } from "../../lib/url";
import { relativeTime, formatDuration } from "../../lib/format";
import { Tooltip } from "../shared/Tooltip";

interface WorkflowRunRowProps {
  run: WorkflowRun;
  onIgnore: (run: WorkflowRun) => void;
  density: Config["viewDensity"];
  refreshTick?: number;
  isPolling?: boolean;
  isFlashing?: boolean;
}

function StatusIcon(props: { status: string; conclusion: string | null }) {
  // completed + success → green check
  if (props.status === "completed" && props.conclusion === "success") {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        class="h-4 w-4 text-success shrink-0"
        viewBox="0 0 20 20"
        fill="currentColor"
        role="img"
        aria-label="Success"
      >
        <path
          fill-rule="evenodd"
          d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
          clip-rule="evenodd"
        />
      </svg>
    );
  }

  // completed + failure → red X
  if (props.status === "completed" && props.conclusion === "failure") {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        class="h-4 w-4 text-error shrink-0"
        viewBox="0 0 20 20"
        fill="currentColor"
        role="img"
        aria-label="Failure"
      >
        <path
          fill-rule="evenodd"
          d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
          clip-rule="evenodd"
        />
      </svg>
    );
  }

  // completed + cancelled → gray slash
  if (props.status === "completed" && props.conclusion === "cancelled") {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        class="h-4 w-4 text-base-content/40 shrink-0"
        viewBox="0 0 20 20"
        fill="currentColor"
        role="img"
        aria-label="Cancelled"
      >
        <path
          fill-rule="evenodd"
          d="M4.293 4.293a1 1 0 011.414 0l10 10a1 1 0 01-1.414 1.414l-10-10a1 1 0 010-1.414z"
          clip-rule="evenodd"
        />
      </svg>
    );
  }

  // in_progress → yellow spinner
  if (props.status === "in_progress") {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        class="h-4 w-4 text-warning animate-spin shrink-0"
        fill="none"
        viewBox="0 0 24 24"
        role="img"
        aria-label="In progress"
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
    );
  }

  // queued or unknown → gray clock
  const label = props.status === "queued" ? "Queued" : "Unknown status";
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      class="h-4 w-4 text-base-content/40 shrink-0"
      viewBox="0 0 20 20"
      fill="currentColor"
      role="img"
      aria-label={label}
    >
      <path
        fill-rule="evenodd"
        d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z"
        clip-rule="evenodd"
      />
    </svg>
  );
}

function durationLabel(run: WorkflowRun): string {
  if (run.status === "completed") return formatDuration(run.runStartedAt, run.completedAt ?? run.updatedAt);
  if (run.status === "in_progress") return "running...";
  return "--";
}

export default function WorkflowRunRow(props: WorkflowRunRowProps) {
  const paddingClass = () =>
    props.density === "compact" ? "py-1 px-2" : "py-2.5 px-4";

  const createdTitle = createMemo(() => `Created: ${new Date(props.run.createdAt).toLocaleString()}`);

  // Reading props.refreshTick registers it as a SolidJS reactive dependency,
  // forcing this memo to re-evaluate when the tick changes. Date.now() alone
  // is not tracked by SolidJS's dependency system.
  const timeLabel = createMemo(() => {
    void props.refreshTick;
    return relativeTime(props.run.createdAt);
  });

  return (
    <div
      class={`flex items-center gap-3 ${paddingClass()} group ${props.run.conclusion === "failure" ? "bg-error/5 hover:bg-error/10" : "hover:bg-base-200"} ${props.isFlashing ? "animate-flash" : props.isPolling ? "animate-shimmer" : ""}`}
    >
      <StatusIcon status={props.run.status} conclusion={props.run.conclusion} />

      <a
        href={isSafeGitHubUrl(props.run.htmlUrl) ? props.run.htmlUrl : undefined}
        target="_blank"
        rel="noopener noreferrer"
        class="flex-1 min-w-0 flex flex-col gap-0.5 text-sm hover:text-primary"
      >
        <span class="truncate text-base-content">
          {props.run.displayTitle}
        </span>
        <span class="truncate text-xs text-base-content/60">
          {props.run.name}
        </span>
      </a>

      <Show when={props.run.isPrRun}>
        <span class="badge badge-info badge-sm shrink-0">
          PR
        </span>
      </Show>

      <Show when={props.run.runAttempt > 1}>
        <span class="badge badge-warning badge-sm shrink-0">
          Attempt {props.run.runAttempt}
        </span>
      </Show>

      <span class="text-xs text-base-content/60 shrink-0">
        {props.run.actorLogin}
      </span>

      <span class="text-xs text-base-content/60 shrink-0">
        {durationLabel(props.run)}
      </span>

      <Tooltip content={createdTitle()} class="shrink-0">
        <time
          class="text-xs text-base-content/40"
          datetime={props.run.createdAt}
        >
          {timeLabel()}
        </time>
      </Tooltip>

      <Show when={props.isPolling}>
        <span class="loading loading-spinner loading-xs text-base-content/40" />
      </Show>

      <Tooltip content="Ignore" class="shrink-0">
        <button
          onClick={() => props.onIgnore(props.run)}
          class="rounded p-1 text-base-content/30 hover:text-error opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity focus:outline-none focus:ring-2 focus:ring-error"
          aria-label={`Ignore run ${props.run.name}`}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            class="h-4 w-4"
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
          >
            <path
              fill-rule="evenodd"
              d="M3.707 2.293a1 1 0 00-1.414 1.414l14 14a1 1 0 001.414-1.414l-1.473-1.473A10.014 10.014 0 0019.542 10C18.268 5.943 14.478 3 10 3a9.958 9.958 0 00-4.512 1.074l-1.78-1.781zm4.261 4.26l1.514 1.515a2.003 2.003 0 012.45 2.45l1.514 1.514a4 4 0 00-5.478-5.478z"
              clip-rule="evenodd"
            />
            <path d="M12.454 16.697L9.75 13.992a4 4 0 01-3.742-3.741L2.335 6.578A9.98 9.98 0 00.458 10c1.274 4.057 5.065 7 9.542 7 .847 0 1.669-.105 2.454-.303z" />
          </svg>
        </button>
      </Tooltip>
    </div>
  );
}
