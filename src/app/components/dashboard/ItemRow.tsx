import { createMemo, For, JSX, Show } from "solid-js";
import { isSafeGitHubUrl } from "../../lib/url";
import { relativeTime, shortRelativeTime, formatCount } from "../../lib/format";
import { expandEmoji } from "../../lib/emoji";
import { labelColorClass } from "../../lib/label-colors";
import { Tooltip } from "../shared/Tooltip";

export interface ItemRowProps {
  repo: string;
  number: number;
  title: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  refreshTick?: number;
  url: string;
  labels: { name: string; color: string }[];
  children?: JSX.Element;
  onIgnore: () => void;
  density: "compact" | "comfortable";
  commentCount?: number;
  hideRepo?: boolean;
  surfacedByBadge?: JSX.Element;
  isPolling?: boolean;
  isFlashing?: boolean;
}

export default function ItemRow(props: ItemRowProps) {
  const isCompact = () => props.density === "compact";
  const safeUrl = () => isSafeGitHubUrl(props.url) ? props.url : undefined;

  // Static date info — recomputed only when createdAt/updatedAt change (not on tick)
  const staticDateInfo = createMemo(() => {
    const createdTitle = `Created: ${new Date(props.createdAt).toLocaleString()}`;
    const updatedTitle = `Updated: ${new Date(props.updatedAt).toLocaleString()}`;
    const diffMs = Date.parse(props.updatedAt) - Date.parse(props.createdAt);
    return { createdTitle, updatedTitle, diffMs };
  });

  // Reading props.refreshTick registers it as a SolidJS reactive dependency,
  // forcing this memo to re-evaluate when the tick changes. Date.now() alone
  // is not tracked by SolidJS's dependency system.
  const dateDisplay = createMemo(() => {
    void props.refreshTick;
    const created = shortRelativeTime(props.createdAt);
    const updated = shortRelativeTime(props.updatedAt);
    const createdLabel = `Created ${relativeTime(props.createdAt)}`;
    const updatedLabel = `Updated ${relativeTime(props.updatedAt)}`;
    return { created, updated, createdLabel, updatedLabel };
  });

  const shouldShowUpdated = createMemo(() => {
    const { diffMs } = staticDateInfo();
    if (diffMs <= 60_000) return false;
    const { created, updated } = dateDisplay();
    return created !== "" && updated !== "" && created !== updated;
  });

  return (
    <div
      class={`group relative flex items-start gap-3
        hover:bg-base-200
        transition-colors
        ${isCompact() ? "px-4 py-2" : "px-4 py-3"}
        ${props.isFlashing ? "animate-flash" : props.isPolling ? "animate-shimmer" : ""}`}
    >
      {/* Overlay link — covers entire row; interactive children use relative z-10 */}
      <Show when={safeUrl()}>
        {(url) => (
          <a
            href={url()}
            target="_blank"
            rel="noopener noreferrer"
            class="absolute inset-0 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset rounded"
            aria-label={`${props.repo} #${props.number}: ${props.title}`}
          />
        )}
      </Show>

      {/* Repo badge */}
      <Show when={!props.hideRepo}>
        <Tooltip content={props.repo} class="relative z-10">
          <span
            class={`shrink-0 inline-flex items-center rounded-full font-mono font-medium
              bg-primary/10 text-primary
              ${isCompact() ? "text-xs px-2 py-0.5" : "text-xs px-2.5 py-1"}`}
          >
            {props.repo}
          </span>
        </Tooltip>
      </Show>

      {/* Main content */}
      <div class="flex-1 min-w-0">
        <div class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
          <span class="text-base-content/60 shrink-0">
            #{props.number}
          </span>
          <span class="font-medium text-base-content truncate">
            {props.title}
          </span>
        </div>

        {/* Labels row */}
        <Show when={props.labels.length > 0}>
          <div class={`flex flex-wrap gap-1 ${isCompact() ? "mt-0.5" : "mt-1"}`}>
            <For each={props.labels}>
              {(label) => (
                <span
                  class={`inline-flex items-center rounded-full text-xs px-2 py-0.5 font-medium ${labelColorClass(label.color)}`}
                >
                  {expandEmoji(label.name)}
                </span>
              )}
            </For>
          </div>
        </Show>

        {/* Additional children slot — z-10 to sit above stretched link */}
        <Show when={props.children !== undefined}>
          <div class={`relative z-10 ${isCompact() ? "mt-0.5" : "mt-1"}`}>{props.children}</div>
        </Show>
      </div>

      {/* Author + time + comment count */}
      <div class={`shrink-0 flex flex-col items-end gap-0.5 text-xs text-base-content/60 ${isCompact() ? "" : "pt-0.5"}`}>
        <span>{props.author}</span>
        <Show when={props.surfacedByBadge !== undefined}>
          <div class="relative z-10">{props.surfacedByBadge}</div>
        </Show>
        <span class="inline-flex items-center gap-1 whitespace-nowrap">
          <Tooltip content={staticDateInfo().createdTitle} class="relative z-10">
            <time
              datetime={props.createdAt}
              aria-label={dateDisplay().createdLabel}
            >
              {dateDisplay().created}
            </time>
          </Tooltip>
          <Show when={shouldShowUpdated()}>
            <span aria-hidden="true">{"\u00B7"}</span>
            <Tooltip content={staticDateInfo().updatedTitle} class="relative z-10">
              <time
                datetime={props.updatedAt}
                aria-label={dateDisplay().updatedLabel}
              >
                {dateDisplay().updated}
              </time>
            </Tooltip>
          </Show>
        </span>
        <Show when={props.isPolling}>
          <span class="loading loading-spinner loading-xs text-base-content/40" />
        </Show>
        <Show when={(props.commentCount ?? 0) > 0}>
          <span class="flex items-center gap-0.5">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              class="h-3 w-3"
              viewBox="0 0 20 20"
              fill="currentColor"
              aria-hidden="true"
            >
              <path
                fill-rule="evenodd"
                d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7zM7 9H5v2h2V9zm8 0h-2v2h2V9zM9 9h2v2H9V9z"
                clip-rule="evenodd"
              />
            </svg>
            {formatCount(props.commentCount!)}
          </span>
        </Show>
      </div>

      {/* Ignore button — visible on hover */}
      <Tooltip content="Ignore" class="relative z-10">
        <button
          data-ignore-btn
          onClick={() => props.onIgnore()}
          class={`shrink-0 self-center rounded p-1
            text-base-content/30
            hover:text-error
            opacity-0 group-hover:opacity-100 focus:opacity-100
            transition-opacity focus:outline-none focus:ring-2 focus:ring-error`}
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
      </Tooltip>
    </div>
  );
}
