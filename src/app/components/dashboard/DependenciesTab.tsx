import { createMemo, createSignal, For, Show } from "solid-js";
import { config, updateConfig } from "../../stores/config";
import { viewState, setTabFilter, resetAllTabFilters, ignoreItem, unignoreItem, trackItem, untrackItem, DependencyFiltersSchema, setDependencyExpandedGroups } from "../../stores/view";
import IgnoreBadge from "./IgnoreBadge";
import { isSafeGitHubUrl } from "../../lib/url";
import type { PullRequest } from "../../services/api";
import type { AbandonedDependency } from "../../lib/dependency-dashboard";
import {
  classifyDepStatus,
  extractVersionInfo,
  parseRenovateBody,
  ALL_DEP_STATUSES,
  isKnownDepBot,
  expandBotLogins,
  DEP_TOOL_LABEL_NAMES,
  type DepStatus,
  type VersionInfo,
} from "../../lib/dependency-detection";
import { matchAbandonedToPr } from "../../lib/dependency-dashboard";
import type { FilterChipGroupDef } from "../shared/filterTypes";
import FilterToolbar from "../shared/FilterToolbar";
import ExpandCollapseButtons from "../shared/ExpandCollapseButtons";
import RepoGroupHeader from "../shared/RepoGroupHeader";
import StatusDot from "../shared/StatusDot";
import SizeBadge from "../shared/SizeBadge";
import ReviewBadge from "../shared/ReviewBadge";
import ItemRow from "./ItemRow";
import SkeletonRows from "../shared/SkeletonRows";

const DEP_FILTER_DEFAULTS = DependencyFiltersSchema.parse({});

const UPDATE_TYPE_OPTIONS: FilterChipGroupDef = {
  label: "Update type",
  field: "updateType",
  options: [
    { value: "maintenance", label: "Maintenance" },
    { value: "pin", label: "Pin" },
    { value: "patch", label: "Patch" },
    { value: "minor", label: "Minor" },
    { value: "major", label: "Major" },
    { value: "other", label: "Other" },
  ],
};

const STATUS_META: Record<DepStatus, { label: string; badgeClass: string; defaultExpanded: boolean }> = {
  "mergeable":       { label: "Mergeable",      badgeClass: "badge-success",  defaultExpanded: true },
  "pending-rebase":  { label: "Pending Rebase",  badgeClass: "badge-ghost",    defaultExpanded: false },
  "needs-action":    { label: "Needs Action",    badgeClass: "badge-warning",  defaultExpanded: true },
  "stale":           { label: "Stale",           badgeClass: "badge-error",    defaultExpanded: false },
};

type DepCategory = "major" | "minor" | "patch" | "pin" | "maintenance" | "other";

function mapUpdateType(ut: NonNullable<VersionInfo["updateType"]>): DepCategory {
  if (ut === "digest") return "patch";
  return ut;
}

const CATEGORY_SORT_ORDER: Record<DepCategory, number> = {
  maintenance: 0,
  pin: 1,
  patch: 2,
  minor: 3,
  major: 4,
  other: 5,
};

function depCategory(pr: PullRequest, versionInfo: VersionInfo | null): DepCategory {
  if (versionInfo?.updateType) return mapUpdateType(versionInfo.updateType);

  const titleLower = pr.title.toLowerCase();
  if (/pin\s+dep/i.test(titleLower)) return "pin";
  if (/lock\s*file\s+maintenance/i.test(titleLower)) return "maintenance";

  if (!versionInfo) {
    for (const l of pr.labels) {
      const name = l.name.toLowerCase();
      if (name === "major") return "major";
      if (name === "minor") return "minor";
      if (name === "patch") return "patch";
    }
    return "maintenance";
  }

  for (const l of pr.labels) {
    const name = l.name.toLowerCase();
    if (name === "major") return "major";
    if (name === "minor") return "minor";
    if (name === "patch") return "patch";
  }
  return "other";
}

interface ClassifiedPR {
  pr: PullRequest;
  status: DepStatus;
  versionInfo: VersionInfo | null;
  category: DepCategory;
  abandoned: boolean;
  abandonedDep: AbandonedDependency | null;
}

interface DependenciesTabProps {
  pullRequests: PullRequest[];
  depBodies?: ReadonlyMap<number, string>;
  loading?: boolean;
  abandonedDepsMap: Map<string, AbandonedDependency[]>;
  dashboardIssueUrls: Map<string, string>;
  hotPollingPRIds?: ReadonlySet<number>;
  refreshTick?: number;
  rebaseLabel: string;
  userLogin: string;
  onRefresh?: () => void;
}

export default function DependenciesTab(props: DependenciesTabProps) {
  const expandedGroups = createMemo(() =>
    new Set<string>(viewState.dependencyExpandedGroups)
  );

  function toggleGroup(status: DepStatus) {
    const current = viewState.dependencyExpandedGroups;
    const next = current.includes(status)
      ? current.filter((s) => s !== status)
      : [...current, status];
    setDependencyExpandedGroups(next);
  }

  function expandAllGroups() {
    setDependencyExpandedGroups([...ALL_DEP_STATUSES]);
  }

  function collapseAllGroups() {
    setDependencyExpandedGroups([]);
  }

  const activeFilters = createMemo(() => ({
    ...DEP_FILTER_DEFAULTS,
    ...(viewState.tabFilters.dependencies ?? {}),
  }));

  const botOptions = createMemo<FilterChipGroupDef>(() => {
    const logins = [...new Set(props.pullRequests.map((pr) => pr.userLogin))].sort();
    return {
      label: "Bot",
      field: "bot",
      options: logins.map((l) => ({ value: l, label: l })),
    };
  });

  const filterGroups = createMemo(() => [UPDATE_TYPE_OPTIONS, botOptions()]);

  const ignoredIds = createMemo(
    () => new Set(viewState.ignoredItems.filter((i) => i.type === "pullRequest").map((i) => i.id))
  );

  const ignoredDepPRs = createMemo(() => {
    const depIds = new Set(props.pullRequests.map((p) => p.id));
    return viewState.ignoredItems.filter((i) => i.type === "pullRequest" && depIds.has(i.id));
  });

  const trackedPrIds = createMemo(() =>
    config.enableTracking
      ? new Set(viewState.trackedItems.filter((t) => t.type === "pullRequest").map((t) => t.id))
      : new Set<number>()
  );

  const trackedBotLogins = createMemo(() =>
    expandBotLogins(config.trackedUsers.filter((u) => u.type === "bot").map((u) => u.login.toLowerCase()))
  );

  const classifiedPRs = createMemo<ClassifiedPR[]>(() => {
    const filters = activeFilters();
    const ignored = ignoredIds();
    const bodies = props.depBodies;
    return props.pullRequests
      .map((pr) => {
        const titleInfo = extractVersionInfo(pr.title);
        let versionInfo = titleInfo;
        const body = bodies?.get(pr.id);
        if (body && (!titleInfo?.updateType || !titleInfo?.from)) {
          const bodyInfo = parseRenovateBody(body);
          if (bodyInfo) {
            versionInfo = {
              packageName: titleInfo?.packageName ?? bodyInfo.packageName,
              from: bodyInfo.from ?? titleInfo?.from,
              to: bodyInfo.to ?? titleInfo?.to,
              updateType: bodyInfo.updateType ?? titleInfo?.updateType,
            };
          }
        }
        const abandonedDeps = props.abandonedDepsMap.get(pr.repoFullName) ?? [];
        const abandonedDep = matchAbandonedToPr(pr, abandonedDeps);
        const abandoned = abandonedDep !== null || /\s-\s*abandoned$/i.test(pr.title);
        return {
          pr,
          status: classifyDepStatus(pr, props.rebaseLabel),
          versionInfo,
          category: depCategory(pr, versionInfo),
          abandoned,
          abandonedDep,
        };
      })
      .filter(({ pr, category }) => {
        if (ignored.has(pr.id)) return false;
        if (filters.bot !== "all" && pr.userLogin !== filters.bot) return false;
        if (filters.updateType !== "all" && category !== filters.updateType) return false;
        return true;
      });
  });

  const sortedPRs = createMemo(() => {
    const { field, direction } = viewState.globalSort;
    const items = [...classifiedPRs()];
    const dir = direction === "asc" ? 1 : -1;

    items.sort((a, b) => {
      // User-selected sort as primary
      let cmp = 0;
      switch (field) {
        case "repo": cmp = a.pr.repoFullName.localeCompare(b.pr.repoFullName); break;
        case "title": cmp = a.pr.title.localeCompare(b.pr.title); break;
        case "author": cmp = a.pr.userLogin.localeCompare(b.pr.userLogin); break;
        case "comments": cmp = a.pr.comments - b.pr.comments; break;
        case "checkStatus": cmp = (a.pr.checkStatus ?? "").localeCompare(b.pr.checkStatus ?? ""); break;
        case "reviewDecision": cmp = (a.pr.reviewDecision ?? "").localeCompare(b.pr.reviewDecision ?? ""); break;
        case "size": cmp = (a.pr.additions + a.pr.deletions) - (b.pr.additions + b.pr.deletions); break;
        case "createdAt": cmp = a.pr.createdAt.localeCompare(b.pr.createdAt); break;
        case "updatedAt":
        default:
          cmp = a.pr.updatedAt.localeCompare(b.pr.updatedAt);
          break;
      }
      if (cmp !== 0) return cmp * dir;

      // Category as secondary (safest → least safe within each group)
      const catCmp = CATEGORY_SORT_ORDER[a.category] - CATEGORY_SORT_ORDER[b.category];
      if (catCmp !== 0) return catCmp;

      return a.pr.repoFullName.localeCompare(b.pr.repoFullName);
    });

    return items;
  });

  const statusGroups = createMemo(() => {
    const groups: Record<DepStatus, ClassifiedPR[]> = {
      "mergeable": [],
      "pending-rebase": [],
      "needs-action": [],
      "stale": [],
    };
    for (const item of sortedPRs()) {
      groups[item.status].push(item);
    }
    return groups;
  });

  // Unknown bot detection — inline banner with "Track" action
  const [dismissedBots, setDismissedBots] = createSignal(new Set<string>());

  const unknownBots = createMemo(() => {
    const known = trackedBotLogins();
    const userLower = props.userLogin.toLowerCase();
    const dismissed = dismissedBots();
    const seen = new Map<string, { login: string; avatarUrl: string }>();

    for (const pr of props.pullRequests) {
      const login = pr.userLogin.toLowerCase();
      if (login === userLower) continue;
      if (isKnownDepBot(login)) continue;
      if (known.has(login)) continue;
      if (dismissed.has(login)) continue;
      if (seen.has(login)) continue;
      seen.set(login, { login: pr.userLogin, avatarUrl: pr.userAvatarUrl });
    }
    return [...seen.values()];
  });

  function handleTrackBot(login: string, avatarUrl: string) {
    const normalized = login.replace(/\[bot\]$/i, "");
    const existing = config.trackedUsers.map((u) => u.login.toLowerCase());
    if (existing.includes(normalized.toLowerCase())) return;
    updateConfig({
      trackedUsers: [...config.trackedUsers, { login: normalized, avatarUrl, name: null, type: "bot" as const }],
    });
    props.onRefresh?.();
  }

  function handleDismissBot(login: string) {
    setDismissedBots((prev) => new Set([...prev, login.toLowerCase()]));
  }

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
      <div class="flex items-start px-4 py-2 gap-3 compact:py-0.5 compact:gap-2 border-b border-base-300 bg-base-100">
        <div class="flex flex-wrap items-center min-w-0 flex-1 gap-3 compact:gap-2">
          <FilterToolbar
            groups={filterGroups()}
            values={activeFilters()}
            onChange={(f, v) => setTabFilter("dependencies", f as "updateType" | "bot", v)}
            onResetAll={() => resetAllTabFilters("dependencies")}
          />
        </div>
        <div class="shrink-0 flex items-center gap-2 py-0.5">
          <IgnoreBadge items={ignoredDepPRs()} onUnignore={unignoreItem} />
          <ExpandCollapseButtons
            onExpandAll={expandAllGroups}
            onCollapseAll={collapseAllGroups}
          />
        </div>
      </div>

      <For each={unknownBots()}>
        {(bot) => (
          <div class="flex items-center gap-2 px-4 py-2 bg-info/10 border-b border-base-300 text-sm">
            <Show when={bot.avatarUrl}>
              <img src={bot.avatarUrl} alt={bot.login} class="w-5 h-5 rounded-full" />
            </Show>
            <span class="flex-1">
              Dependency PRs from <strong>{bot.login}</strong> — track this bot for full coverage?
            </span>
            <button
              type="button"
              class="btn btn-xs btn-primary"
              onClick={() => handleTrackBot(bot.login, bot.avatarUrl)}
            >
              Track bot
            </button>
            <button
              type="button"
              class="btn btn-xs btn-ghost"
              onClick={() => handleDismissBot(bot.login)}
            >
              Dismiss
            </button>
          </div>
        )}
      </For>

      <Show when={props.loading && props.pullRequests.length === 0}>
        <SkeletonRows label="Loading dependency PRs" />
      </Show>

      <Show when={!props.loading && sortedPRs().length === 0 && props.pullRequests.length === 0}>
        <div class="flex flex-col items-center justify-center gap-2 py-16 text-base-content/50">
          <svg class="h-10 w-10 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p class="text-sm font-medium">No open dependency update PRs</p>
          <p class="text-xs">Your dependencies are up to date!</p>
        </div>
      </Show>

      <Show when={!props.loading && sortedPRs().length === 0 && props.pullRequests.length > 0}>
        <div class="flex flex-col items-center justify-center gap-2 py-16 text-base-content/50">
          <p class="text-sm font-medium">No dependency PRs match your current filters</p>
        </div>
      </Show>

      <Show when={sortedPRs().length > 0}>
        <div class="divide-y divide-base-300 overflow-y-auto flex-1">
          <For each={ALL_DEP_STATUSES}>
            {(status) => (
              <StatusGroup
                status={status}
                label={STATUS_META[status].label}
                items={statusGroups()[status]}
                expanded={expandedGroups().has(status)}
                onToggle={() => toggleGroup(status)}
                dashboardIssueUrls={props.dashboardIssueUrls}
                hotPollingPRIds={props.hotPollingPRIds}
                refreshTick={props.refreshTick}
                trackedPrIds={trackedPrIds()}
                enableTracking={config.enableTracking}
                onIgnore={handleIgnore}
                onTrack={handleTrack}
              />
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

interface StatusGroupProps {
  status: DepStatus;
  label: string;
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

function stripCommitPrefix(title: string): string {
  const stripped = title.replace(/^(?:chore|fix|build)\(deps[^)]*\):\s*/i, "").replace(/\s*-\s*abandoned$/i, "");
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

function displayTitle(pr: PullRequest, versionInfo: VersionInfo | null): string {
  if (versionInfo?.packageName) {
    if (versionInfo.from && versionInfo.to) return `${versionInfo.packageName}: ${versionInfo.from} → ${versionInfo.to}`;
    if (versionInfo.to) return `${versionInfo.packageName} → ${versionInfo.to}`;
    return versionInfo.packageName;
  }
  return stripCommitPrefix(pr.title);
}

function filteredLabels(labels: { name: string; color: string }[]): { name: string; color: string }[] {
  return labels.filter((l) => !DEP_TOOL_LABEL_NAMES.has(l.name.toLowerCase()));
}

function StatusGroup(props: StatusGroupProps) {
  return (
    <Show when={props.items.length > 0}>
      <div>
        <RepoGroupHeader
          repoFullName={props.label}
          isExpanded={props.expanded}
          onToggle={props.onToggle}
        />

        <div id={`dep-group-${props.status}`} role="list" class={`divide-y divide-base-300${props.expanded ? "" : " hidden"}`}>
          <For each={props.items}>
            {({ pr, versionInfo, category, abandoned, abandonedDep }) => {
              const dashUrl = () => props.dashboardIssueUrls.get(pr.repoFullName);
              const title = () => displayTitle(pr, versionInfo);
              return (
                <div role="listitem">
                  <ItemRow
                    repo={pr.repoFullName}
                    number={pr.number}
                    title={title()}
                    author={pr.userLogin}
                    createdAt={pr.createdAt}
                    updatedAt={pr.updatedAt}
                    refreshTick={props.refreshTick}
                    url={pr.htmlUrl}
                    labels={filteredLabels(pr.labels)}
                    commentCount={pr.enriched !== false ? pr.comments : undefined}
                    onIgnore={() => props.onIgnore(pr)}
                    onTrack={props.enableTracking ? () => props.onTrack(pr) : undefined}
                    isTracked={props.enableTracking ? props.trackedPrIds.has(pr.id) : undefined}
                    isPolling={props.hotPollingPRIds?.has(pr.id)}
                    hideAuthor
                    hideNumber
                    subtleRepo
                    titlePrefix={
                      <Show when={category !== "other"}>
                        <span class={`badge badge-sm min-w-[4.5rem] justify-center ${
                          category === "major" ? "badge-error" :
                          category === "minor" ? "badge-warning" :
                          "badge-success"
                        }`}>
                          {category}
                        </span>
                      </Show>
                    }
                  >
                    <div class="flex items-center gap-1.5 flex-wrap">
                      <Show when={pr.enriched !== false}>
                        <StatusDot status={pr.checkStatus} />
                      </Show>

                      <Show when={pr.enriched !== false}>
                        <ReviewBadge decision={pr.reviewDecision} />
                      </Show>

                      <Show when={pr.enriched !== false && (pr.additions > 0 || pr.deletions > 0)}>
                        <SizeBadge
                          additions={pr.additions}
                          deletions={pr.deletions}
                          changedFiles={pr.changedFiles}
                        />
                      </Show>

                      <Show when={pr.draft}>
                        <span class="badge badge-ghost badge-sm">Draft</span>
                      </Show>

                      <Show when={abandoned}>
                        <Show
                          when={abandonedDep !== null && dashUrl() && isSafeGitHubUrl(dashUrl()!)}
                          fallback={
                            <span class="badge badge-error badge-outline badge-sm">Abandoned</span>
                          }
                        >
                          <a
                            href={dashUrl()}
                            target="_blank"
                            rel="noopener noreferrer"
                            class="badge badge-error badge-outline badge-sm"
                            onClick={(e) => e.stopPropagation()}
                          >
                            Abandoned
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
      </div>
    </Show>
  );
}
