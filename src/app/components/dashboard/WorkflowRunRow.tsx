import { Show } from "solid-js";
import type { WorkflowRun } from "../../services/api";
import type { Config } from "../../stores/config";
import { isSafeGitHubUrl } from "../../lib/url";
import { relativeTime } from "../../lib/format";

interface WorkflowRunRowProps {
  run: WorkflowRun;
  onIgnore: (run: WorkflowRun) => void;
  density: Config["viewDensity"];
}

function StatusIcon(props: { status: string; conclusion: string | null }) {
  // completed + success → green check
  if (props.status === "completed" && props.conclusion === "success") {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        class="h-4 w-4 text-green-500 flex-shrink-0"
        viewBox="0 0 20 20"
        fill="currentColor"
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
        class="h-4 w-4 text-red-500 flex-shrink-0"
        viewBox="0 0 20 20"
        fill="currentColor"
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
        class="h-4 w-4 text-gray-400 flex-shrink-0"
        viewBox="0 0 20 20"
        fill="currentColor"
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
        class="h-4 w-4 text-yellow-500 animate-spin flex-shrink-0"
        fill="none"
        viewBox="0 0 24 24"
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

  // queued → gray clock
  if (props.status === "queued") {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        class="h-4 w-4 text-gray-400 flex-shrink-0"
        viewBox="0 0 20 20"
        fill="currentColor"
        aria-label="Queued"
      >
        <path
          fill-rule="evenodd"
          d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z"
          clip-rule="evenodd"
        />
      </svg>
    );
  }

  // fallback: gray clock
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      class="h-4 w-4 text-gray-400 flex-shrink-0"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-label="Unknown status"
    >
      <path
        fill-rule="evenodd"
        d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z"
        clip-rule="evenodd"
      />
    </svg>
  );
}

export default function WorkflowRunRow(props: WorkflowRunRowProps) {
  const paddingClass = () =>
    props.density === "compact" ? "py-1.5 px-3" : "py-2.5 px-4";

  return (
    <div
      class={`flex items-center gap-3 ${paddingClass()} hover:bg-gray-50 dark:hover:bg-gray-800/50 group`}
    >
      <StatusIcon status={props.run.status} conclusion={props.run.conclusion} />

      <a
        href={isSafeGitHubUrl(props.run.htmlUrl) ? props.run.htmlUrl : undefined}
        target="_blank"
        rel="noopener noreferrer"
        class="flex-1 min-w-0 flex items-center gap-2 text-sm text-gray-900 dark:text-gray-100 hover:text-blue-600 dark:hover:text-blue-400 truncate"
      >
        <span class="truncate">{props.run.name}</span>

        <Show when={props.run.isPrRun}>
          <span class="inline-flex items-center rounded px-1 py-0.5 text-xs font-medium bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-300 flex-shrink-0">
            PR
          </span>
        </Show>
      </a>

      <span class="text-xs text-gray-500 dark:text-gray-400 flex-shrink-0">
        {props.run.headBranch}
      </span>

      <span class="text-xs text-gray-400 dark:text-gray-500 flex-shrink-0">
        {relativeTime(props.run.createdAt)}
      </span>

      <button
        onClick={() => props.onIgnore(props.run)}
        class="opacity-0 group-hover:opacity-100 text-xs text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-opacity focus:opacity-100 flex-shrink-0"
        aria-label={`Ignore run ${props.run.name}`}
      >
        Ignore
      </button>
    </div>
  );
}
