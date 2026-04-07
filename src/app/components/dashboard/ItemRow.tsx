import { createMemo, For, JSX, Show } from "solid-js";
import { config } from "../../stores/config";
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
  onIgnore?: () => void;
  onTrack?: () => void;
  isTracked?: boolean;
  commentCount?: number;
  hideRepo?: boolean;
  surfacedByBadge?: JSX.Element;
  isPolling?: boolean;
  isFlashing?: boolean;
}

export default function ItemRow(props: ItemRowProps) {
  const isCompact = createMemo(() => config.viewDensity === "compact");
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

  const compactLabelTooltip = createMemo(() => {
    const parts: string[] = [];
    if (props.labels.length > 0) {
      parts.push(`Labels: ${props.labels.map((l) => expandEmoji(l.name)).join(", ")}`);
    }
    if ((props.commentCount ?? 0) > 0) {
      parts.push(`${props.commentCount} comment${props.commentCount === 1 ? "" : "s"}`);
    }
    return parts.join(" | ");
  });
  const hasCompactTooltip = createMemo(() => isCompact() && compactLabelTooltip() !== "");
  const hasLabels = createMemo(() => props.labels.length > 0);
  const repoShortName = createMemo(() => {
    const slash = props.repo.indexOf("/");
    return slash >= 0 ? props.repo.slice(slash + 1) : props.repo;
  });

  return (
    <div
      class={`group relative flex pl-6 pr-4 py-3 items-start gap-3 compact:pl-6 compact:pr-3 compact:py-1 compact:items-center compact:gap-2
        hover:bg-base-200
        transition-colors
        ${props.isFlashing ? "animate-flash" : props.isPolling ? "animate-shimmer" : ""}`}
    >
      {/* Poll spinner — absolute so it never causes reflow */}
      <Show when={props.isPolling}>
        <span class="absolute left-1 top-1/2 -translate-y-1/2 loading loading-spinner loading-xs text-base-content/40" />
      </Show>

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

      {/* Repo badge — compact: short name + tooltip; comfortable: full name, no tooltip */}
      <Show when={!props.hideRepo}>
        <Show
          when={isCompact()}
          fallback={
            <span
              class="shrink-0 inline-flex items-center rounded-full font-mono font-medium
                bg-primary/10 text-primary text-xs px-2.5 py-1"
            >
              {props.repo}
            </span>
          }
        >
          <Tooltip content={props.repo} class="shrink-0 relative z-10">
            <span
              class="shrink-0 inline-flex items-center rounded-full font-mono font-medium
                bg-primary/10 text-primary text-xs px-2 py-0.5"
            >
              {repoShortName()}
            </span>
          </Tooltip>
        </Show>
      </Show>

      {/* ── COMPACT LAYOUT: everything on one line ── */}
      <Show when={isCompact()}>
        {/* Number */}
        <span class="text-xs text-base-content/50 shrink-0">#{props.number}</span>

        {/* Title — truncated, fills available space */}
        <span class="font-medium text-sm truncate flex-1 min-w-0">
          {props.title}
        </span>

        {/* Children (badges) inline */}
        <Show when={props.children !== undefined}>
          <div class="relative z-10 shrink-0 flex items-center gap-1">{props.children}</div>
        </Show>

        {/* Label + comment count indicator via tooltip */}
        <Show when={hasCompactTooltip()}>
          <Tooltip content={compactLabelTooltip()} placement="top" focusable>
            <span class="relative z-10 inline-flex items-center gap-0.5 text-xs text-base-content/40 cursor-default select-none">
              <Show when={hasLabels()}>
                <span class="inline-flex items-center gap-0.5">
                  <svg class="h-3 w-3" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                    <path fill-rule="evenodd" d="M17.707 9.293a1 1 0 010 1.414l-7 7a1 1 0 01-1.414 0l-7-7A.997.997 0 012 10V5a3 3 0 013-3h5c.256 0 .512.098.707.293l7 7zM5 6a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd" />
                  </svg>
                  {props.labels.length}
                </span>
              </Show>
              <Show when={(props.commentCount ?? 0) > 0}>
                <span class="inline-flex items-center gap-0.5">
                  <svg class="h-3 w-3" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                    <path fill-rule="evenodd" d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7z" clip-rule="evenodd" />
                  </svg>
                  {formatCount(props.commentCount!)}
                </span>
              </Show>
            </span>
          </Tooltip>
        </Show>

        {/* surfacedByBadge */}
        <Show when={props.surfacedByBadge !== undefined}>
          <div class="relative z-10 shrink-0">{props.surfacedByBadge}</div>
        </Show>

        {/* Author + time — compact, inline */}
        <span class="shrink-0 text-xs text-base-content/50 whitespace-nowrap">
          {props.author}
          {" · "}
          <time datetime={props.updatedAt} title={staticDateInfo().updatedTitle} aria-label={dateDisplay().updatedLabel}>
            {dateDisplay().updated || dateDisplay().created}
          </time>
        </span>

      </Show>

      {/* ── COMFORTABLE LAYOUT: multi-line original ── */}
      <Show when={!isCompact()}>
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
            <div class="flex flex-wrap gap-1 mt-1">
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
            <div class="relative z-10 mt-1">{props.children}</div>
          </Show>
        </div>

        {/* Author + time + comment count */}
        <div class="shrink-0 flex flex-col items-end gap-0.5 text-xs text-base-content/60 pt-0.5">
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
          <Show when={(props.commentCount ?? 0) > 0}>
            <Tooltip content={`${props.commentCount} total ${props.commentCount === 1 ? "comment" : "comments"}`} focusable class="relative z-10">
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
            </Tooltip>
          </Show>
        </div>
      </Show>

      {/* Pin button — visible on hover, always visible when tracked */}
      <Show when={props.onTrack !== undefined}>
        <Tooltip content={props.isTracked ? "Untrack this item" : "Track this item"} class="shrink-0 self-center relative z-10">
          <button
            onClick={() => props.onTrack!()}
            class={`shrink-0 self-center rounded p-1
              transition-opacity focus:outline-none focus:ring-2 focus:ring-primary
              ${props.isTracked
                ? "text-primary opacity-100"
                : "text-base-content/30 hover:text-primary opacity-0 group-hover:opacity-100 focus:opacity-100"
              }`}
            aria-label={props.isTracked ? `Unpin #${props.number} ${props.title}` : `Pin #${props.number} ${props.title}`}
          >
            <Show
              when={props.isTracked}
              fallback={
                /* Outline bookmark (not tracked) */
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="h-4 w-4"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
              }
            >
              {/* Solid bookmark (tracked) */}
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="h-4 w-4"><path fill-rule="evenodd" d="M6.32 2.577a49.255 49.255 0 0 1 11.36 0c1.497.174 2.57 1.46 2.57 2.93V21a.75.75 0 0 1-1.085.67L12 18.089l-7.165 3.583A.75.75 0 0 1 3.75 21V5.507c0-1.47 1.073-2.756 2.57-2.93Z" clip-rule="evenodd" /></svg>
            </Show>
          </button>
        </Tooltip>
      </Show>

      {/* Ignore button — visible on hover */}
      <Show when={props.onIgnore !== undefined}>
        <Tooltip content="Ignore" class="shrink-0 self-center relative z-10">
          <button
            data-ignore-btn
            onClick={() => props.onIgnore!()}
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
              class="h-4 w-4 compact:h-3.5 compact:w-3.5"
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
      </Show>
    </div>
  );
}
