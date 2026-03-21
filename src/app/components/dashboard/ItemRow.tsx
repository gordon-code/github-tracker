import { For, JSX, Show } from "solid-js";
import { openGitHubUrl } from "../../lib/url";
import { relativeTime, labelTextColor } from "../../lib/format";

export interface ItemRowProps {
  repo: string;
  number: number;
  title: string;
  author: string;
  createdAt: string;
  url: string;
  labels: { name: string; color: string }[];
  children?: JSX.Element;
  onIgnore: () => void;
  density: "compact" | "comfortable";
}

export default function ItemRow(props: ItemRowProps) {
  const isCompact = () => props.density === "compact";

  function handleRowClick(e: MouseEvent) {
    // Only open if click was not on the ignore button
    if ((e.target as HTMLElement).closest("[data-ignore-btn]")) return;
    openGitHubUrl(props.url);
  }

  return (
    <div
      role="row"
      tabIndex={0}
      onClick={handleRowClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openGitHubUrl(props.url);
        }
      }}
      class={`group relative flex items-start gap-3 cursor-pointer
        border-b border-gray-200 dark:border-gray-700
        hover:bg-gray-50 dark:hover:bg-gray-800/60
        transition-colors focus:outline-none focus:bg-gray-50 dark:focus:bg-gray-800/60
        ${isCompact() ? "px-4 py-2" : "px-4 py-3"}`}
    >
      {/* Repo badge */}
      <span
        class={`shrink-0 inline-flex items-center rounded-full font-mono font-medium
          bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-200
          ${isCompact() ? "text-xs px-2 py-0.5" : "text-xs px-2.5 py-1"}`}
        title={props.repo}
      >
        {props.repo}
      </span>

      {/* Main content */}
      <div class="flex-1 min-w-0">
        <div class={`flex flex-wrap items-baseline gap-x-2 gap-y-0.5 ${isCompact() ? "text-sm" : "text-sm"}`}>
          <span class="text-gray-500 dark:text-gray-400 shrink-0">
            #{props.number}
          </span>
          <span class="font-medium text-gray-900 dark:text-gray-100 truncate">
            {props.title}
          </span>
        </div>

        {/* Labels row */}
        <Show when={props.labels.length > 0}>
          <div class={`flex flex-wrap gap-1 ${isCompact() ? "mt-0.5" : "mt-1"}`}>
            <For each={props.labels}>
              {(label) => {
                const bg = `#${label.color}`;
                const fg = labelTextColor(label.color);
                return (
                  <span
                    class="inline-flex items-center rounded-full text-xs px-2 py-0.5 font-medium"
                    style={{ "background-color": bg, color: fg }}
                  >
                    {label.name}
                  </span>
                );
              }}
            </For>
          </div>
        </Show>

        {/* Additional children slot */}
        <Show when={props.children !== undefined}>
          <div class={isCompact() ? "mt-0.5" : "mt-1"}>{props.children}</div>
        </Show>
      </div>

      {/* Author + time */}
      <div class={`shrink-0 flex flex-col items-end gap-0.5 text-xs text-gray-500 dark:text-gray-400 ${isCompact() ? "" : "pt-0.5"}`}>
        <span>{props.author}</span>
        <span title={props.createdAt}>{relativeTime(props.createdAt)}</span>
      </div>

      {/* Ignore button — visible on hover */}
      <button
        data-ignore-btn
        onClick={(e) => {
          e.stopPropagation();
          props.onIgnore();
        }}
        class={`shrink-0 self-center rounded p-1
          text-gray-300 dark:text-gray-600
          hover:text-red-500 dark:hover:text-red-400
          opacity-0 group-hover:opacity-100 focus:opacity-100
          transition-opacity focus:outline-none focus:ring-2 focus:ring-red-400`}
        title="Ignore this item"
        aria-label={`Ignore #${props.number} ${props.title}`}
      >
        {/* Eye-slash icon */}
        <svg
          xmlns="http://www.w3.org/2000/svg"
          class={isCompact() ? "h-3.5 w-3.5" : "h-4 w-4"}
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
    </div>
  );
}
