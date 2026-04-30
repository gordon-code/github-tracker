import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { config, type TrackedUser } from "../../stores/config";
import { viewState, ignoreItem, unignoreItem, toggleExpandedRepo, setAllExpanded, pruneExpandedRepos, pruneLockedRepos, trackItem, untrackItem, PullRequestFiltersSchema } from "../../stores/view";
import { createTabFilterHandlers, mergeActiveFilters } from "../../lib/tabFilters";
import { isPrVisible } from "../../lib/filters";
import type { PullRequest, RepoRef } from "../../services/api";
import { deriveInvolvementRoles, prSizeCategory } from "../../lib/format";
import { isSafeGitHubUrl } from "../../lib/url";
import ExpandCollapseButtons from "../shared/ExpandCollapseButtons";
import ItemRow from "./ItemRow";
import UserAvatarBadge, { buildSurfacedByUsers } from "../shared/UserAvatarBadge";
import StatusDot from "../shared/StatusDot";
import IgnoreBadge from "./IgnoreBadge";
import PaginationControls from "../shared/PaginationControls";
import { scopeFilterGroup, prFilterGroups, type FilterChipGroupDef } from "../shared/filterTypes";
import FilterToolbar from "../shared/FilterToolbar";
import ReviewBadge from "../shared/ReviewBadge";
import SizeBadge from "../shared/SizeBadge";
import RoleBadge from "../shared/RoleBadge";
import SkeletonRows from "../shared/SkeletonRows";
import RepoGroupHeader from "../shared/RepoGroupHeader";
import { groupByRepo, computePageLayout, slicePageGroups, orderRepoGroups, ensureLockedRepoGroups, isUserInvolved } from "../../lib/grouping";
import { createReorderHighlight } from "../../lib/reorderHighlight";
import { createFlashDetection } from "../../lib/flashDetection";
import RepoLockControls from "../shared/RepoLockControls";
import RepoGitHubLink from "../shared/RepoGitHubLink";
import EmptyLockedRepoRow from "../shared/EmptyLockedRepoRow";
import { Tooltip } from "../shared/Tooltip";
import JiraBadge from "../shared/JiraBadge";
import { extractJiraKeys } from "../../../shared/validation";

export interface PullRequestsTabProps {
  pullRequests: PullRequest[];
  loading?: boolean;
  userLogin: string;
  allUsers?: { login: string; label: string }[];
  trackedUsers?: TrackedUser[];
  hotPollingPRIds?: ReadonlySet<number>;
  monitoredRepos?: RepoRef[];
  configRepoNames?: string[];
  refreshTick?: number;
  customTabId?: string;
  filterPreset?: Record<string, string>;
  jiraKeyMap?: () => ReadonlyMap<string, import("../../../shared/jira-types").JiraIssue | null>;
}

type SortField = "repo" | "title" | "author" | "createdAt" | "updatedAt" | "checkStatus" | "reviewDecision" | "size";

const PR_FILTER_DEFAULTS = PullRequestFiltersSchema.parse({});

function checkStatusOrder(status: PullRequest["checkStatus"]): number {
  switch (status) {
    case "failure":
      return 0;
    case "conflict":
      return 1;
    case "pending":
      return 2;
    case "success":
      return 3;
    default:
      return 4;
  }
}

function reviewDecisionOrder(decision: PullRequest["reviewDecision"]): number {
  switch (decision) {
    case "CHANGES_REQUESTED":
      return 0;
    case "REVIEW_REQUIRED":
      return 1;
    case "APPROVED":
      return 2;
    default:
      return 3;
  }
}

export default function PullRequestsTab(props: PullRequestsTabProps) {
  const [page, setPage] = createSignal(0);

  const tabKey = () => props.customTabId ?? "pullRequests";

  const trackedUserMap = createMemo(() =>
    new Map(props.trackedUsers?.map(u => [u.login, u]) ?? [])
  );

  const upstreamRepoSet = createMemo(() =>
    new Set((config.upstreamRepos ?? []).map(r => r.fullName))
  );

  const monitoredRepoNameSet = createMemo(() =>
    new Set((props.monitoredRepos ?? []).map(r => r.fullName))
  );

  const userLoginLower = createMemo(() => props.userLogin.toLowerCase());

  const showScopeFilter = createMemo(() => {
    if (props.customTabId) return true;
    return (props.monitoredRepos ?? []).length > 0 || (props.allUsers?.length ?? 0) > 1;
  });

  const ignoredPullRequests = createMemo(() =>
    viewState.ignoredItems.filter(i => i.type === "pullRequest")
  );

  // Merge chain: schema defaults → preset → stored runtime overrides
  const activeFilters = createMemo(() =>
    mergeActiveFilters(PullRequestFiltersSchema, PR_FILTER_DEFAULTS, props.customTabId, viewState.tabFilters.pullRequests, {
      preset: props.filterPreset,
      resolveLogin: props.userLogin,
    })
  );

  const filterGroups = createMemo<FilterChipGroupDef[]>(() => {
    const users = props.allUsers;
    const base = showScopeFilter()
      ? [scopeFilterGroup, ...prFilterGroups]
      : [...prFilterGroups];
    if (!users || users.length <= 1) return base;
    return [
      ...base,
      {
        label: "User",
        field: "user",
        options: users.map((u) => ({ value: u.login, label: u.label })),
      },
    ];
  });

  const { handleFilterChange, handleResetFilters } = createTabFilterHandlers("pullRequests", () => props.customTabId);

  // Auto-reset scope to default when scope toggle is hidden (localStorage hygiene)
  createEffect(() => {
    if (!showScopeFilter() && activeFilters().scope !== "involves_me") {
      handleFilterChange("scope", "involves_me");
    }
  });

  // Auto-reset user filter when User filter group is hidden
  createEffect(() => {
    const users = props.allUsers;
    if ((!users || users.length <= 1) && activeFilters().user !== "all") {
      handleFilterChange("user", "all");
    }
  });

  const isInvolvedItem = (item: PullRequest) =>
    isUserInvolved(item, userLoginLower(), monitoredRepoNameSet(),
      item.enriched !== false ? item.reviewerLogins : undefined);

  const filteredSortedWithMeta = createMemo(() => {
    const tabFilters = activeFilters();
    const ignoredIds = new Set(ignoredPullRequests().map((i) => i.id));
    const globalFilter = props.customTabId ? null : viewState.globalFilter;

    const meta = new Map<number, { roles: ReturnType<typeof deriveInvolvementRoles>; sizeCategory: ReturnType<typeof prSizeCategory> }>();

    let items = props.pullRequests.filter((pr) => {
      if (pr.state !== "OPEN") return false;
      if (!isPrVisible(pr, { ignoredIds, globalFilter })) return false;

      const roles = deriveInvolvementRoles(props.userLogin, pr.userLogin, pr.assigneeLogins, pr.reviewerLogins, upstreamRepoSet().has(pr.repoFullName));
      const sizeCategory = prSizeCategory(pr.additions, pr.deletions);

      // Scope filter — use effective scope to avoid one-render flash when auto-reset effect hasn't fired yet
      const effectiveScope = showScopeFilter() ? tabFilters.scope : "involves_me";
      if (effectiveScope === "involves_me" && !isInvolvedItem(pr)) return false;

      // Tab filters — light-field filters always apply; heavy-field filters
      // only apply to enriched PRs so unenriched phase-1 PRs aren't incorrectly hidden
      const isEnriched = pr.enriched !== false;
      if (tabFilters.role !== "all") {
        // Role depends on assigneeLogins/reviewerLogins (heavy), but "author" is light
        if (isEnriched && !roles.includes(tabFilters.role as "author" | "reviewer" | "assignee")) return false;
        if (!isEnriched && tabFilters.role === "author" && !roles.includes("author")) return false;
      }
      if (tabFilters.reviewDecision !== "all") {
        if (tabFilters.reviewDecision === "mergeable") {
          if (pr.reviewDecision !== "APPROVED" && pr.reviewDecision !== null) return false;
        } else {
          if (pr.reviewDecision !== tabFilters.reviewDecision) return false;
        }
      }
      if (tabFilters.draft !== "all") {
        if (tabFilters.draft === "draft" && !pr.draft) return false;
        if (tabFilters.draft === "ready" && pr.draft) return false;
      }
      if (tabFilters.checkStatus !== "all" && isEnriched) {
        if (tabFilters.checkStatus === "none") {
          if (pr.checkStatus !== null) return false;
        } else if (tabFilters.checkStatus === "blocked") {
          if (pr.checkStatus !== "failure" && pr.checkStatus !== "conflict") return false;
        } else {
          if (pr.checkStatus !== tabFilters.checkStatus) return false;
        }
      }
      if (tabFilters.sizeCategory !== "all" && isEnriched) {
        if (sizeCategory !== tabFilters.sizeCategory) return false;
      }

      if (tabFilters.user !== "all") {
        // Items from monitored repos bypass the surfacedBy filter (all activity is shown)
        if (!monitoredRepoNameSet().has(pr.repoFullName)) {
          const validUser = !props.allUsers || props.allUsers.some(u => u.login === tabFilters.user);
          if (validUser) {
            const surfacedBy = pr.surfacedBy ?? [userLoginLower()];
            if (!surfacedBy.includes(tabFilters.user)) return false;
          }
        }
      }

      meta.set(pr.id, { roles, sizeCategory });
      return true;
    });

    const { field, direction } = viewState.globalSort;
    items = [...items].sort((a, b) => {
      let cmp = 0;
      switch (field as SortField) {
        case "repo":
          cmp = a.repoFullName.localeCompare(b.repoFullName);
          break;
        case "title":
          cmp = a.title.localeCompare(b.title);
          break;
        case "author":
          cmp = a.userLogin.localeCompare(b.userLogin);
          break;
        case "createdAt":
          cmp = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
          break;
        case "checkStatus":
          cmp = checkStatusOrder(a.checkStatus) - checkStatusOrder(b.checkStatus);
          break;
        case "reviewDecision":
          cmp = reviewDecisionOrder(a.reviewDecision) - reviewDecisionOrder(b.reviewDecision);
          break;
        case "size":
          cmp = (a.additions + a.deletions) - (b.additions + b.deletions);
          break;
        case "updatedAt":
        default:
          cmp = a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0;
          break;
      }
      return direction === "asc" ? cmp : -cmp;
    });

    return { items, meta };
  });

  const filteredSorted = createMemo(() => filteredSortedWithMeta().items);
  const prMeta = createMemo(() => filteredSortedWithMeta().meta);

  const repoGroups = createMemo(() => {
    const groups = groupByRepo(filteredSorted());
    const lockedForTab = viewState.lockedRepos[tabKey()] ?? [];
    const withLocked = ensureLockedRepoGroups(
      groups,
      lockedForTab,
      (name) => ({ repoFullName: name, items: [] as typeof groups[0]["items"] }),
    );
    return orderRepoGroups(withLocked, lockedForTab);
  });
  const pageLayout = createMemo(() => computePageLayout(repoGroups(), config.itemsPerPage));
  const pageCount = createMemo(() => pageLayout().pageCount);
  const pageGroups = createMemo(() =>
    slicePageGroups(repoGroups(), pageLayout().boundaries, pageCount(), page())
  );

  createEffect(() => {
    const max = pageCount() - 1;
    if (page() > max) setPage(max);
  });

  const activeRepoNames = createMemo(() =>
    props.configRepoNames ?? [...new Set(props.pullRequests.map((pr) => pr.repoFullName))]
  );

  createEffect(() => {
    const names = activeRepoNames();
    if (names.length === 0) return;
    pruneExpandedRepos(tabKey(), names);
  });

  createEffect(() => {
    const names = activeRepoNames();
    if (names.length === 0) return;
    pruneLockedRepos(tabKey(), names);
  });

  const { flashingIds: flashingPRIds, peekUpdates } = createFlashDetection({
    getItems: () => props.pullRequests,
    getHotIds: () => props.hotPollingPRIds,
    getExpandedRepos: () => viewState.expandedRepos[tabKey()] ?? {},
    trackKey: (pr) => `${pr.checkStatus}|${pr.reviewDecision}`,
    itemLabel: (pr) => `#${pr.number} ${pr.title}`,
    itemStatus: (pr) => pr.checkStatus ?? pr.reviewDecision ?? "updated",
  });

  const trackedPrIds = createMemo(() =>
    config.enableTracking
      ? new Set(viewState.trackedItems.filter(t => t.type === "pullRequest").map(t => t.id))
      : new Set<number>()
  );

  const highlightedReposPRs = createReorderHighlight(
    () => repoGroups().map(g => g.repoFullName),
    () => viewState.lockedRepos[tabKey()] ?? [],
    () => ignoredPullRequests().length,
    () => JSON.stringify(props.customTabId
      ? (viewState.customTabFilters[props.customTabId] ?? {})
      : viewState.tabFilters.pullRequests),
  );

  function handleIgnore(pr: PullRequest) {
    ignoreItem({
      id: pr.id,
      type: "pullRequest",
      repo: pr.repoFullName,
      title: pr.title,
      ignoredAt: Date.now(),
    });
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
        <div class="flex flex-wrap items-center min-w-0 flex-1 gap-3 compact:gap-2">
          <FilterToolbar
            groups={filterGroups()}
            values={activeFilters()}
            onChange={(f, v) => {
              handleFilterChange(f, v);
              setPage(0);
            }}
            onResetAll={() => {
              handleResetFilters();
              setPage(0);
            }}
          />
        </div>
        <div class="shrink-0 flex items-center gap-2 py-0.5">
          <ExpandCollapseButtons
            onExpandAll={() => setAllExpanded(tabKey(), repoGroups().map((g) => g.repoFullName), true)}
            onCollapseAll={() => setAllExpanded(tabKey(), repoGroups().map((g) => g.repoFullName), false)}
          />
          <IgnoreBadge
            items={ignoredPullRequests()}
            onUnignore={unignoreItem}
          />
        </div>
      </div>

      {/* Loading skeleton — only when no data exists yet */}
      <Show when={props.loading && props.pullRequests.length === 0}>
        <SkeletonRows label="Loading pull requests" />
      </Show>

      {/* Empty — only when no groups exist at all (locked stubs are handled by EmptyLockedRepoRow) */}
      <Show when={(!props.loading || props.pullRequests.length > 0) && pageGroups().length === 0}>
        <div class="flex flex-col items-center justify-center gap-2 py-16 text-base-content/50">
          <svg
            class="h-10 w-10 opacity-40"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="1.5"
              d="M8 7h8m-8 5h5m-5 5h8M5 3h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2z"
            />
          </svg>
          <p class="text-sm font-medium">
            {activeFilters().scope === "all" ? "No open pull requests found" : "No open pull requests involving you"}
          </p>
          <p class="text-xs">
            {activeFilters().scope === "all"
              ? "No pull requests match your current filters."
              : "PRs where you are the author, assignee, or reviewer will appear here."}
          </p>
        </div>
      </Show>

      {/* PR rows */}
      <Show when={(!props.loading || props.pullRequests.length > 0) && pageGroups().length > 0}>
        <div class="divide-y divide-base-300">
          <For each={pageGroups()}>
            {(repoGroup) => {
                const isEmpty = () => repoGroup.items.length === 0;
                const isExpanded = () => !isEmpty() && !!(viewState.expandedRepos[tabKey()] ?? {})[repoGroup.repoFullName];

                const summaryMeta = createMemo(() => {
                  const checks = { success: 0, failure: 0, pending: 0, conflict: 0 };
                  const reviews = { APPROVED: 0, CHANGES_REQUESTED: 0, REVIEW_REQUIRED: 0 };
                  const roles: Record<string, number> = {};

                  for (const item of repoGroup.items) {
                    if (item.checkStatus === "success") checks.success++;
                    else if (item.checkStatus === "failure") checks.failure++;
                    else if (item.checkStatus === "pending") checks.pending++;
                    else if (item.checkStatus === "conflict") checks.conflict++;

                    if (item.reviewDecision === "APPROVED") reviews.APPROVED++;
                    else if (item.reviewDecision === "CHANGES_REQUESTED") reviews.CHANGES_REQUESTED++;
                    else if (item.reviewDecision === "REVIEW_REQUIRED") reviews.REVIEW_REQUIRED++;

                    const m = prMeta().get(item.id);
                    if (m) {
                      for (const role of m.roles) {
                        roles[role] = (roles[role] || 0) + 1;
                      }
                    }
                  }

                  return { checks, reviews, roles: Object.entries(roles) };
                });

                return (
                  <Show
                    when={!isEmpty()}
                    fallback={
                      <EmptyLockedRepoRow repoFullName={repoGroup.repoFullName} section="pulls" tabKey={tabKey()} />
                    }
                  >
                    <div class="bg-base-100" data-repo-group={repoGroup.repoFullName}>
                      <RepoGroupHeader
                        repoFullName={repoGroup.repoFullName}
                        starCount={repoGroup.starCount}
                        isExpanded={isExpanded()}
                        isHighlighted={highlightedReposPRs().has(repoGroup.repoFullName)}
                        onToggle={() => toggleExpandedRepo(tabKey(), repoGroup.repoFullName)}
                        badges={
                          <Show when={monitoredRepoNameSet().has(repoGroup.repoFullName)}>
                            <Tooltip content="Showing all activity, not just yours" focusable>
                              <span class="badge badge-xs badge-ghost" aria-label="monitoring all activity">Monitoring all</span>
                            </Tooltip>
                          </Show>
                        }
                        trailing={
                          <>
                            <RepoGitHubLink repoFullName={repoGroup.repoFullName} section="pulls" />
                            <RepoLockControls repoFullName={repoGroup.repoFullName} tabKey={tabKey()} />
                          </>
                        }
                        collapsedSummary={
                          <span class="ml-auto flex items-center gap-2 text-xs font-normal text-base-content/60 shrink-0">
                            <span>{repoGroup.items.length} {repoGroup.items.length === 1 ? "PR" : "PRs"}</span>
                            <Show when={summaryMeta().checks.success > 0}>
                              <span class="flex items-center gap-0.5">
                                <span class="inline-block w-2 h-2 rounded-full bg-success" />
                                <span>{summaryMeta().checks.success}</span>
                              </span>
                            </Show>
                            <Show when={summaryMeta().checks.failure > 0}>
                              <span class="flex items-center gap-0.5">
                                <span class="inline-block w-2 h-2 rounded-full bg-error" />
                                <span>{summaryMeta().checks.failure}</span>
                              </span>
                            </Show>
                            <Show when={summaryMeta().checks.pending > 0}>
                              <span class="flex items-center gap-0.5">
                                <span class="inline-block w-2 h-2 rounded-full bg-warning" />
                                <span>{summaryMeta().checks.pending}</span>
                              </span>
                            </Show>
                            <Show when={summaryMeta().checks.conflict > 0}>
                              <span class="badge badge-warning badge-sm gap-0.5">
                                <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                                  <path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd" />
                                </svg>
                                {summaryMeta().checks.conflict === 1 ? "Conflict" : `Conflicts ×${summaryMeta().checks.conflict}`}
                              </span>
                            </Show>
                            <Show when={summaryMeta().reviews.APPROVED > 0}>
                              <span class="badge badge-success badge-sm">
                                {`Approved ×${summaryMeta().reviews.APPROVED}`}
                              </span>
                            </Show>
                            <Show when={summaryMeta().reviews.CHANGES_REQUESTED > 0}>
                              <span class="badge badge-warning badge-sm">
                                {`Changes ×${summaryMeta().reviews.CHANGES_REQUESTED}`}
                              </span>
                            </Show>
                            <Show when={summaryMeta().reviews.REVIEW_REQUIRED > 0}>
                              <span class="badge badge-info badge-sm">
                                {`Needs review ×${summaryMeta().reviews.REVIEW_REQUIRED}`}
                              </span>
                            </Show>
                            <For each={summaryMeta().roles}>
                              {([role, count]) => (
                                <span class={`inline-flex items-center rounded-full px-1.5 py-0.5 text-xs font-medium ${
                                  role === "author" ? "bg-primary/10 text-primary" :
                                  role === "reviewer" ? "bg-secondary/10 text-secondary" :
                                  role === "assignee" ? "bg-accent/10 text-accent" :
                                  "bg-base-300 text-base-content/70"
                                }`}>
                                  {`${role} ×${count}`}
                                </span>
                              )}
                            </For>
                          </span>
                        }
                      />
                      <Show when={!isExpanded() && peekUpdates().get(repoGroup.repoFullName)}>
                        {(peek) => (
                          <div class="animate-flash flex items-center gap-2 text-xs text-base-content/70 px-4 py-1.5 border-b border-base-300 bg-base-100">
                            <span class="loading loading-spinner loading-xs text-primary/60" />
                            <span class="truncate flex-1">{peek().itemLabel}</span>
                            <span class="badge badge-xs badge-primary">{peek().newStatus}</span>
                          </div>
                        )}
                      </Show>
                      <Show when={isExpanded()}>
                        <div role="list" class="divide-y divide-base-300">
                          <For each={repoGroup.items}>
                            {(pr) => (
                            <div role="listitem" class={
                              activeFilters().scope === "all" && isInvolvedItem(pr)
                                ? "border-l-2 border-l-primary"
                                : undefined
                            }>
                              <ItemRow
                                hideRepo={true}
                                repo={pr.repoFullName}
                                number={pr.number}
                                title={pr.title}
                                author={pr.userLogin}
                                createdAt={pr.createdAt}
                                updatedAt={pr.updatedAt}
                                refreshTick={props.refreshTick}
                                url={pr.htmlUrl}
                                labels={pr.labels}
                                commentCount={pr.enriched !== false ? pr.comments + pr.reviewThreads : undefined}
                                onIgnore={() => handleIgnore(pr)}
                                onTrack={config.enableTracking ? () => handleTrack(pr) : undefined}
                                isTracked={config.enableTracking ? trackedPrIds().has(pr.id) : undefined}
                                surfacedByBadge={
                                  props.trackedUsers && props.trackedUsers.length > 0
                                    ? <UserAvatarBadge
                                        users={buildSurfacedByUsers(pr.surfacedBy, trackedUserMap())}
                                        currentUserLogin={props.userLogin}
                                      />
                                    : undefined
                                }
                                isPolling={props.hotPollingPRIds?.has(pr.id)}
                                isFlashing={flashingPRIds().has(pr.id)}
                              >
                                <Show
                                  when={config.viewDensity === "compact"}
                                  fallback={
                                    <div class="flex items-center gap-2 flex-wrap">
                                      <Show when={pr.enriched !== false}>
                                        <RoleBadge roles={prMeta().get(pr.id)?.roles ?? []} />
                                      </Show>
                                      <ReviewBadge decision={pr.reviewDecision} />
                                      <Show when={pr.enriched !== false}>
                                        <SizeBadge additions={pr.additions} deletions={pr.deletions} changedFiles={pr.changedFiles} category={prMeta().get(pr.id)?.sizeCategory} filesUrl={isSafeGitHubUrl(pr.htmlUrl) ? `${pr.htmlUrl}/files` : undefined} />
                                        <StatusDot status={pr.checkStatus} href={isSafeGitHubUrl(pr.htmlUrl) ? `${pr.htmlUrl}/checks` : undefined} />
                                        <Show when={pr.checkStatus === "conflict"}>
                                          <span class="badge badge-warning badge-sm gap-1">
                                            <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                                              <path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd" />
                                            </svg>
                                            Merge conflict
                                          </span>
                                        </Show>
                                      </Show>
                                      <Show when={pr.draft}>
                                        <span class="badge badge-ghost badge-sm italic text-base-content/50">
                                          Draft
                                        </span>
                                      </Show>
                                      <Show when={pr.enriched !== false && pr.reviewerLogins.length > 0}>
                                        <Tooltip content={pr.reviewerLogins.join(", ")} focusable>
                                          <span class="text-xs text-base-content/60">
                                            Reviewers: {pr.reviewerLogins.slice(0, 5).join(", ")}
                                            {pr.reviewerLogins.length > 5 && ` +${pr.reviewerLogins.length - 5} more`}
                                            {pr.totalReviewCount > pr.reviewerLogins.length && ` (${pr.totalReviewCount} total)`}
                                          </span>
                                        </Tooltip>
                                      </Show>
                                    </div>
                                  }
                                >
                                  {/* Compact: key badges inline + hidden metadata in tooltip */}
                                  <div class="flex items-center gap-1">
                                    <StatusDot status={pr.checkStatus} href={isSafeGitHubUrl(pr.htmlUrl) ? `${pr.htmlUrl}/checks` : undefined} />
                                    <ReviewBadge decision={pr.reviewDecision} />
                                    <Show when={pr.enriched !== false}>
                                      <SizeBadge additions={pr.additions} deletions={pr.deletions} changedFiles={pr.changedFiles} category={prMeta().get(pr.id)?.sizeCategory} filesUrl={isSafeGitHubUrl(pr.htmlUrl) ? `${pr.htmlUrl}/files` : undefined} />
                                    </Show>
                                    <Show when={pr.checkStatus === "conflict"}>
                                      <Tooltip content="Merge conflict">
                                        <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3 text-warning" viewBox="0 0 20 20" fill="currentColor" aria-label="Merge conflict">
                                          <path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd" />
                                        </svg>
                                      </Tooltip>
                                    </Show>
                                    <Show when={pr.draft}>
                                      <span class="badge badge-ghost badge-xs italic text-base-content/50">D</span>
                                    </Show>
                                    <Show when={pr.enriched !== false && (pr.reviewerLogins.length > 0 || (prMeta().get(pr.id)?.roles ?? []).length > 0)}>
                                      <Tooltip content={[
                                        (prMeta().get(pr.id)?.roles ?? []).length > 0 ? `Role: ${(prMeta().get(pr.id)?.roles ?? []).join(", ")}` : false,
                                        pr.reviewerLogins.length > 0 ? `Reviewers: ${pr.reviewerLogins.join(", ")}` : false,
                                      ].filter(Boolean).join(" | ")} placement="top">
                                        <span class="text-base-content/40 text-xs cursor-default">···</span>
                                      </Tooltip>
                                    </Show>
                                  </div>
                                </Show>
                                <Show when={config.jira?.enabled && config.jira?.issueKeyDetection && props.jiraKeyMap}>
                                  {(() => {
                                    const titleKeys = new Set(extractJiraKeys(pr.title));
                                    const branchKeys = new Set(extractJiraKeys(pr.headRef ?? ""));
                                    const annotated = [...new Set([...titleKeys, ...branchKeys])].map((key) => ({
                                      key,
                                      source: (titleKeys.has(key) && branchKeys.has(key) ? "title & branch"
                                        : titleKeys.has(key) ? "title" : "branch") as "title" | "branch" | "title & branch",
                                    }));
                                    return (
                                      <For each={annotated}>
                                        {(entry) => (
                                          <JiraBadge
                                            issueKey={entry.key}
                                            issue={props.jiraKeyMap!().get(entry.key)}
                                            siteUrl={config.jira?.siteUrl ?? ""}
                                            source={entry.source}
                                          />
                                        )}
                                      </For>
                                    );
                                  })()}
                                </Show>
                              </ItemRow>
                            </div>
                            )}
                          </For>
                        </div>
                      </Show>
                    </div>
                  </Show>
                );
            }}
          </For>
        </div>
      </Show>

      <Show when={!props.loading || props.pullRequests.length > 0}>
        <PaginationControls
          page={page()}
          pageCount={pageCount()}
          totalItems={filteredSorted().length}
          itemLabel="pull request"
          onPrev={() => setPage((p) => Math.max(0, p - 1))}
          onNext={() => setPage((p) => Math.min(pageCount() - 1, p + 1))}
        />
      </Show>
    </div>
  );
}
