import { createMemo, createSignal, For, Show } from "solid-js";
import { config } from "../../stores/config";
import { viewState, setTabFilter, resetAllTabFilters, ignoreItem, trackItem, untrackItem } from "../../stores/view";
import { isSafeGitHubUrl } from "../../lib/url";
import type { PullRequest } from "../../services/api";
import type { AbandonedDependency } from "../../lib/dependency-dashboard";
import { classifyDepStatus, extractVersionInfo, isRebasing, STALE_THRESHOLD_DEFAULT_DAYS, type DepStatus } from "../../lib/dependency-detection";
import { matchAbandonedToPr } from "../../lib/dependency-dashboard";
import type { FilterChipGroupDef } from "../shared/filterTypes";
import FilterToolbar from "../shared/FilterToolbar";
import ItemRow from "./ItemRow";
import SkeletonRows from "../shared/SkeletonRows";

const DEP_FILTER_DEFAULTS = { updateType: "all" as const, bot: "all" };

const UPDATE_TYPE_OPTIONS: FilterChipGroupDef = {
  label: "Update type",
  field: "updateType",
  options: [
    { value: "all", label: "All" },
    { value: "major", label: "Major" },
    { value: "minor", label: "Minor" },
    { value: "patch", label: "Patch" },
  ],
};

interface ClassifiedPR {
  pr: PullRequest;
  status: DepStatus;
  versionInfo: ReturnType<typeof extractVersionInfo>;
  rebasing: boolean;
  abandonedDep: AbandonedDependency | null;
}

interface DependenciesTabProps {
  pullRequests: PullRequest[];
  loading?: boolean;
  userLogin: string;
  trackedBotLogins: Set<string>;
  abandonedDepsMap: Map<string, AbandonedDependency[]>;
  dashboardIssueUrls: Map<string, string>;
  hotPollingPRIds?: ReadonlySet<number>;
  refreshTick?: number;
  rebaseLabel: string;
}

export default function DependenciesTab(props: DependenciesTabProps) {
  const [expandedGroups, setExpandedGroups] = createSignal<Set<DepStatus>>(
    new Set(["needs-review", "waiting", "stale"])
  );

  function toggleGroup(status: DepStatus) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }

  const activeFilters = createMemo(() => ({
    ...DEP_FILTER_DEFAULTS,
    ...(viewState.tabFilters.dependencies ?? {}),
  }));

  const botOptions = createMemo<FilterChipGroupDef>(() => {
    const logins = [...new Set(props.pullRequests.filter((pr) => pr.state === "OPEN").map((pr) => pr.userLogin))].sort();
    return {
      label: "Bot",
      field: "bot",
      options: [
        { value: "all", label: "All" },
        ...logins.map((l) => ({ value: l, label: l })),
      ],
    };
  });

  const filterGroups = createMemo(() => [UPDATE_TYPE_OPTIONS, botOptions()]);

  const ignoredIds = createMemo(
    () => new Set(viewState.ignoredItems.filter((i) => i.type === "pullRequest").map((i) => i.id))
  );

  const trackedPrIds = createMemo(() =>
    config.enableTracking
      ? new Set(viewState.trackedItems.filter((t) => t.type === "pullRequest").map((t) => t.id))
      : new Set<number>()
  );

  const classifiedPRs = createMemo<ClassifiedPR[]>(() => {
    const filters = activeFilters();
    const ignored = ignoredIds();
    return props.pullRequests
      .map((pr) => {
        const versionInfo = extractVersionInfo(pr.title);
        const abandonedDeps = props.abandonedDepsMap.get(pr.repoFullName) ?? [];
        return {
          pr,
          status: classifyDepStatus(pr, STALE_THRESHOLD_DEFAULT_DAYS),
          versionInfo,
          rebasing: isRebasing(pr, props.rebaseLabel),
          abandonedDep: matchAbandonedToPr(pr, abandonedDeps),
        };
      })
      .filter(({ pr, versionInfo }) => {
        if (pr.state !== "OPEN") return false;
        if (ignored.has(pr.id)) return false;

        // Bot filter
        if (filters.bot !== "all" && pr.userLogin !== filters.bot) return false;

        // updateType filter — pass through when updateType is null (unknown)
        if (filters.updateType !== "all") {
          if (versionInfo !== null && versionInfo.updateType !== undefined && versionInfo.updateType !== filters.updateType) return false;
        }

        return true;
      })
      .sort((a, b) => (a.pr.updatedAt < b.pr.updatedAt ? 1 : a.pr.updatedAt > b.pr.updatedAt ? -1 : 0));
  });

  const openPrCount = createMemo(() => props.pullRequests.filter(p => p.state === "OPEN").length);

  const statusGroups = createMemo(() => {
    const groups: Record<DepStatus, ClassifiedPR[]> = {
      "needs-review": [],
      waiting: [],
      stale: [],
    };
    for (const item of classifiedPRs()) {
      groups[item.status].push(item);
    }
    return groups;
  });

  function handleIgnore(pr: PullRequest) {
    ignoreItem({ id: pr.id, type: "pullRequest", repo: pr.repoFullName, title: pr.title, ignoredAt: Date.now() });
    if (config.enableTracking) untrackItem(pr.id, "pullRequest");
  }

  function handleTrack(pr: PullRequest) {
    if (trackedPrIds().has(pr.id)) {
      untrackItem(pr.id, "pullRequest");
    } else {
      trackItem({ id: pr.id, number: pr.number, type: "pullRequest", source: "github", repoFullName: pr.repoFullName, title: pr.title, addedAt: Date.now() });
    }
  }

  return (
    <div class="flex flex-col h-full">
      {/* Filter toolbar */}
      <div class="flex items-start px-4 py-2 gap-3 compact:py-0.5 compact:gap-2 border-b border-base-300 bg-base-100">
        <div class="flex flex-wrap items-center min-w-0 flex-1 gap-2 compact:gap-1">
          <FilterToolbar
            groups={filterGroups()}
            values={activeFilters()}
            onChange={(f, v) => setTabFilter("dependencies", f as "updateType" | "bot", v)}
            onResetAll={() => resetAllTabFilters("dependencies")}
          />
        </div>
      </div>

      {/* Loading skeleton */}
      <Show when={props.loading && props.pullRequests.length === 0}>
        <SkeletonRows label="Loading dependency PRs" />
      </Show>

      {/* Empty state */}
      <Show when={!props.loading && classifiedPRs().length === 0 && openPrCount() === 0}>
        <div class="flex flex-col items-center justify-center gap-2 py-16 text-base-content/50">
          <svg class="h-10 w-10 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p class="text-sm font-medium">No open dependency update PRs</p>
          <p class="text-xs">Your dependencies are up to date!</p>
        </div>
      </Show>

      {/* No results from filter */}
      <Show when={!props.loading && classifiedPRs().length === 0 && openPrCount() > 0}>
        <div class="flex flex-col items-center justify-center gap-2 py-16 text-base-content/50">
          <p class="text-sm font-medium">No PRs match your current filters</p>
        </div>
      </Show>

      {/* Status groups */}
      <Show when={classifiedPRs().length > 0}>
        <div class="divide-y divide-base-300 overflow-y-auto flex-1">
          <StatusGroup
            status="needs-review"
            label="Needs Review"
            badgeClass="badge-warning"
            items={statusGroups()["needs-review"]}
            expanded={expandedGroups().has("needs-review")}
            onToggle={() => toggleGroup("needs-review")}
            dashboardIssueUrls={props.dashboardIssueUrls}
            hotPollingPRIds={props.hotPollingPRIds}
            refreshTick={props.refreshTick}
            trackedPrIds={trackedPrIds()}
            enableTracking={config.enableTracking}
            onIgnore={handleIgnore}
            onTrack={handleTrack}
          />
          <StatusGroup
            status="waiting"
            label="Waiting"
            badgeClass="badge-info"
            items={statusGroups().waiting}
            expanded={expandedGroups().has("waiting")}
            onToggle={() => toggleGroup("waiting")}
            dashboardIssueUrls={props.dashboardIssueUrls}
            hotPollingPRIds={props.hotPollingPRIds}
            refreshTick={props.refreshTick}
            trackedPrIds={trackedPrIds()}
            enableTracking={config.enableTracking}
            onIgnore={handleIgnore}
            onTrack={handleTrack}
          />
          <StatusGroup
            status="stale"
            label="Stale"
            badgeClass="badge-error"
            items={statusGroups().stale}
            expanded={expandedGroups().has("stale")}
            onToggle={() => toggleGroup("stale")}
            dashboardIssueUrls={props.dashboardIssueUrls}
            hotPollingPRIds={props.hotPollingPRIds}
            refreshTick={props.refreshTick}
            trackedPrIds={trackedPrIds()}
            enableTracking={config.enableTracking}
            onIgnore={handleIgnore}
            onTrack={handleTrack}
          />
        </div>
      </Show>
    </div>
  );
}

interface StatusGroupProps {
  status: DepStatus;
  label: string;
  badgeClass: string;
  items: ClassifiedPR[];
  expanded: boolean;
  onToggle: () => void;
  dashboardIssueUrls: Map<string, string>;
  hotPollingPRIds?: ReadonlySet<number>;
  refreshTick?: number;
  trackedPrIds: Set<number>;
  enableTracking: boolean;
  onIgnore: (pr: PullRequest) => void;
  onTrack: (pr: PullRequest) => void;
}

function StatusGroup(props: StatusGroupProps) {
  return (
    <Show when={props.items.length > 0}>
      <div>
        {/* Group header */}
        <button
          type="button"
          class="w-full flex items-center gap-2 px-4 py-2 bg-base-200 hover:bg-base-300 text-sm font-medium text-base-content transition-colors"
          onClick={props.onToggle}
          aria-expanded={props.expanded}
          aria-controls={`dep-group-${props.status}`}
        >
          <svg
            class={`h-3.5 w-3.5 text-base-content/50 transition-transform ${props.expanded ? "rotate-90" : ""}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
          </svg>
          <span>{props.label}</span>
          <span class={`badge badge-sm ${props.badgeClass}`}>{props.items.length}</span>
        </button>

        {/* PR rows */}
        <Show when={props.expanded}>
          <div id={`dep-group-${props.status}`} role="list" class="divide-y divide-base-300">
            <For each={props.items}>
              {({ pr, versionInfo, rebasing, abandonedDep }) => {
                const dashUrl = () => props.dashboardIssueUrls.get(pr.repoFullName);
                return (
                  <div role="listitem">
                    <ItemRow
                      repo={pr.repoFullName}
                      number={pr.number}
                      title={pr.title}
                      author={pr.userLogin}
                      createdAt={pr.createdAt}
                      updatedAt={pr.updatedAt}
                      refreshTick={props.refreshTick}
                      url={pr.htmlUrl}
                      labels={pr.labels}
                      commentCount={pr.enriched !== false ? pr.comments : undefined}
                      onIgnore={() => props.onIgnore(pr)}
                      onTrack={props.enableTracking ? () => props.onTrack(pr) : undefined}
                      isTracked={props.enableTracking ? props.trackedPrIds.has(pr.id) : undefined}
                      isPolling={props.hotPollingPRIds?.has(pr.id)}
                    >
                      <div class="flex items-center gap-1.5 flex-wrap">
                        {/* Version badge */}
                        <Show when={versionInfo?.updateType}>
                          {(updateType) => (
                            <span class={`badge badge-sm ${
                              updateType() === "major" ? "badge-error" :
                              updateType() === "minor" ? "badge-warning" :
                              "badge-success"
                            }`}>
                              {updateType()}
                            </span>
                          )}
                        </Show>

                        {/* Rebase indicator */}
                        <Show when={rebasing}>
                          <span class="badge badge-ghost badge-sm">Rebasing</span>
                        </Show>

                        {/* Draft indicator */}
                        <Show when={pr.draft}>
                          <span class="badge badge-ghost badge-sm">Draft</span>
                        </Show>

                        {/* Abandoned dep pill — SEC-001: URL validated before use as href */}
                        <Show when={abandonedDep !== null}>
                          <Show
                            when={dashUrl() && isSafeGitHubUrl(dashUrl()!)}
                            fallback={
                              <span class="badge badge-error badge-outline badge-sm">Abandoned dep</span>
                            }
                          >
                            <a
                              href={dashUrl()}
                              target="_blank"
                              rel="noopener noreferrer"
                              class="badge badge-error badge-outline badge-sm"
                              onClick={(e) => e.stopPropagation()}
                            >
                              Abandoned dep
                            </a>
                          </Show>
                        </Show>
                      </div>
                    </ItemRow>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>
      </div>
    </Show>
  );
}
