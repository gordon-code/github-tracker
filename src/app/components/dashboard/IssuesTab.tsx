import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { config, type TrackedUser } from "../../stores/config";
import { viewState, updateViewState, setTabFilter, resetAllTabFilters, ignoreItem, unignoreItem, toggleExpandedRepo, setAllExpanded, pruneExpandedRepos, pruneLockedRepos, trackItem, untrackItem, type IssueFilterField } from "../../stores/view";
import type { Issue, RepoRef } from "../../services/api";
import ItemRow from "./ItemRow";
import UserAvatarBadge, { buildSurfacedByUsers } from "../shared/UserAvatarBadge";
import IgnoreBadge from "./IgnoreBadge";
import PaginationControls from "../shared/PaginationControls";
import { scopeFilterGroup, type FilterChipGroupDef } from "../shared/filterTypes";
import FilterToolbar from "../shared/FilterToolbar";
import RoleBadge from "../shared/RoleBadge";
import SkeletonRows from "../shared/SkeletonRows";
import ExpandCollapseButtons from "../shared/ExpandCollapseButtons";
import { deriveInvolvementRoles } from "../../lib/format";
import RepoGroupHeader from "../shared/RepoGroupHeader";
import { groupByRepo, computePageLayout, slicePageGroups, orderRepoGroups, ensureLockedRepoGroups, isUserInvolved } from "../../lib/grouping";
import { createReorderHighlight } from "../../lib/reorderHighlight";
import RepoLockControls from "../shared/RepoLockControls";
import RepoGitHubLink from "../shared/RepoGitHubLink";
import { Tooltip } from "../shared/Tooltip";

export interface IssuesTabProps {
  issues: Issue[];
  loading?: boolean;
  userLogin: string;
  allUsers?: { login: string; label: string }[];
  trackedUsers?: TrackedUser[];
  monitoredRepos?: RepoRef[];
  configRepoNames?: string[];
  refreshTick?: number;
}

type SortField = "repo" | "title" | "author" | "createdAt" | "updatedAt" | "comments";

const issueFilterGroups: FilterChipGroupDef[] = [
  {
    label: "Role",
    field: "role",
    options: [
      { value: "author", label: "Author" },
      { value: "assignee", label: "Assignee" },
    ],
  },
  {
    label: "Comments",
    field: "comments",
    options: [
      { value: "has", label: "Has comments" },
      { value: "none", label: "No comments" },
    ],
  },
];


export default function IssuesTab(props: IssuesTabProps) {
  const [page, setPage] = createSignal(0);

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

  const showScopeFilter = createMemo(() =>
    (props.monitoredRepos ?? []).length > 0 || (props.allUsers?.length ?? 0) > 1
  );

  const ignoredIssues = createMemo(() =>
    viewState.ignoredItems.filter(i => i.type === "issue")
  );

  const filterGroups = createMemo<FilterChipGroupDef[]>(() => {
    const users = props.allUsers;
    const base = showScopeFilter()
      ? [scopeFilterGroup, ...issueFilterGroups]
      : [...issueFilterGroups];
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

  // Auto-reset scope to default when scope toggle is hidden (localStorage hygiene)
  createEffect(() => {
    if (!showScopeFilter() && viewState.tabFilters.issues.scope !== "involves_me") {
      setTabFilter("issues", "scope", "involves_me");
    }
  });

  // Auto-reset user filter when User filter group is hidden
  createEffect(() => {
    const users = props.allUsers;
    if ((!users || users.length <= 1) && viewState.tabFilters.issues.user !== "all") {
      setTabFilter("issues", "user", "all");
    }
  });

  const isInvolvedItem = (item: Issue) =>
    isUserInvolved(item, userLoginLower(), monitoredRepoNameSet());

  const filteredSortedWithMeta = createMemo(() => {
    const filter = viewState.globalFilter;
    const tabFilter = viewState.tabFilters.issues;
    const ignored = new Set(
      ignoredIssues()
        .map((i) => i.id)
    );

    const meta = new Map<number, { roles: ReturnType<typeof deriveInvolvementRoles> }>();

    let items = props.issues.filter((issue) => {
      if (ignored.has(issue.id)) return false;
      if (filter.repo && issue.repoFullName !== filter.repo) return false;
      if (filter.org && !issue.repoFullName.startsWith(filter.org + "/")) return false;

      const roles = deriveInvolvementRoles(props.userLogin, issue.userLogin, issue.assigneeLogins, [], upstreamRepoSet().has(issue.repoFullName));

      // Scope filter — use effective scope to avoid one-render flash when auto-reset effect hasn't fired yet
      const effectiveScope = showScopeFilter() ? tabFilter.scope : "involves_me";
      if (effectiveScope === "involves_me" && !isInvolvedItem(issue)) return false;

      if (tabFilter.role !== "all") {
        if (!roles.includes(tabFilter.role as "author" | "assignee")) return false;
      }

      if (tabFilter.comments !== "all") {
        if (tabFilter.comments === "has" && issue.comments === 0) return false;
        if (tabFilter.comments === "none" && issue.comments > 0) return false;
      }

      if (viewState.hideDepDashboard && issue.title === "Dependency Dashboard") return false;

      if (tabFilter.user !== "all") {
        // Items from monitored repos bypass the surfacedBy filter (all activity is shown)
        if (!monitoredRepoNameSet().has(issue.repoFullName)) {
          const validUser = !props.allUsers || props.allUsers.some(u => u.login === tabFilter.user);
          if (validUser) {
            const surfacedBy = issue.surfacedBy ?? [userLoginLower()];
            if (!surfacedBy.includes(tabFilter.user)) return false;
          }
        }
      }

      meta.set(issue.id, { roles });
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
        case "comments":
          cmp = a.comments - b.comments;
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
  const issueMeta = createMemo(() => filteredSortedWithMeta().meta);

  const repoGroups = createMemo(() => {
    const groups = groupByRepo(filteredSorted());
    const withLocked = ensureLockedRepoGroups(
      groups,
      viewState.lockedRepos,
      (name) => ({ repoFullName: name, items: [] as typeof groups[0]["items"] }),
    );
    return orderRepoGroups(withLocked, viewState.lockedRepos);
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
    props.configRepoNames ?? [...new Set(props.issues.map((i) => i.repoFullName))]
  );

  createEffect(() => {
    const names = activeRepoNames();
    if (names.length === 0) return;
    pruneExpandedRepos("issues", names);
  });

  createEffect(() => {
    const names = activeRepoNames();
    if (names.length === 0) return;
    pruneLockedRepos(names);
  });

  const trackedIssueIds = createMemo(() =>
    config.enableTracking
      ? new Set(viewState.trackedItems.filter(t => t.type === "issue").map(t => t.id))
      : new Set<number>()
  );

  const highlightedReposIssues = createReorderHighlight(
    () => repoGroups().map(g => g.repoFullName),
    () => viewState.lockedRepos,
    () => ignoredIssues().length,
    () => JSON.stringify(viewState.tabFilters.issues),
  );

  function handleIgnore(issue: Issue) {
    ignoreItem({
      id: issue.id,
      type: "issue",
      repo: issue.repoFullName,
      title: issue.title,
      ignoredAt: Date.now(),
    });
    if (config.enableTracking) untrackItem(issue.id, "issue");
  }

  function handleTrack(issue: Issue) {
    if (trackedIssueIds().has(issue.id)) {
      untrackItem(issue.id, "issue");
    } else {
      trackItem({ id: issue.id, number: issue.number, type: "issue", repoFullName: issue.repoFullName, title: issue.title, addedAt: Date.now() });
    }
  }

  return (
    <div class="flex flex-col h-full">
      {/* Filter chips + ignore badge toolbar */}
      <div class="flex items-start px-4 py-2 gap-3 compact:py-0.5 compact:gap-2 border-b border-base-300 bg-base-100">
        <div class="flex flex-wrap items-center min-w-0 flex-1 gap-3 compact:gap-2">
          <FilterToolbar
            groups={filterGroups()}
            values={viewState.tabFilters.issues}
            onChange={(f, v) => {
              setTabFilter("issues", f as IssueFilterField, v);
              setPage(0);
            }}
            onResetAll={() => {
              resetAllTabFilters("issues");
              setPage(0);
            }}
          />
          <Tooltip content="Show or hide Renovate Dependency Dashboard issues">
            <button
              onClick={() => {
                updateViewState({ hideDepDashboard: !viewState.hideDepDashboard });
                setPage(0);
              }}
              class={`btn btn-xs rounded-full ${!viewState.hideDepDashboard ? "btn-primary" : "btn-ghost text-base-content/50"}`}
              aria-pressed={!viewState.hideDepDashboard}
            >
              Show Dep Dashboard
            </button>
          </Tooltip>
        </div>
        <div class="shrink-0 flex items-center gap-2 py-0.5">
          <ExpandCollapseButtons
            onExpandAll={() => setAllExpanded("issues", repoGroups().map((g) => g.repoFullName), true)}
            onCollapseAll={() => setAllExpanded("issues", repoGroups().map((g) => g.repoFullName), false)}
          />
          <IgnoreBadge
            items={ignoredIssues()}
            onUnignore={unignoreItem}
          />
        </div>
      </div>

      {/* Loading skeleton — only when no data exists yet */}
      <Show when={props.loading && props.issues.length === 0}>
        <SkeletonRows label="Loading issues" />
      </Show>

      {/* Issue rows */}
      <Show when={!props.loading || props.issues.length > 0}>
        <Show
          when={pageGroups().length > 0}
          fallback={
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
                  d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
                />
              </svg>
              <p class="text-sm font-medium">
                {viewState.tabFilters.issues.scope === "all" ? "No open issues found" : "No open issues involving you"}
              </p>
              <p class="text-xs">
                {viewState.tabFilters.issues.scope === "all"
                  ? "No issues match your current filters."
                  : "Issues where you are the author, assignee, or mentioned will appear here."}
              </p>
            </div>
          }
        >
          <div class="divide-y divide-base-300">
            <For each={pageGroups()}>
              {(repoGroup) => {
                const isEmpty = () => repoGroup.items.length === 0;
                const isExpanded = () => !isEmpty() && !!viewState.expandedRepos.issues[repoGroup.repoFullName];

                const roleSummary = createMemo(() => {
                  const counts: Record<string, number> = {};
                  for (const item of repoGroup.items) {
                    const m = issueMeta().get(item.id);
                    if (m) {
                      for (const role of m.roles) {
                        counts[role] = (counts[role] || 0) + 1;
                      }
                    }
                  }
                  return Object.entries(counts);
                });

                return (
                  <Show
                    when={!isEmpty()}
                    fallback={
                      <div class="group/repo-header flex items-center border-y border-base-300 bg-base-200/30 opacity-40" data-repo-group={repoGroup.repoFullName}>
                        <span class="flex-1 flex items-center gap-2 px-4 py-1.5 compact:py-0.5">
                          <span class="h-3.5 w-3.5 shrink-0" />
                          <span class="text-sm text-base-content/60">{repoGroup.repoFullName}</span>
                        </span>
                        <RepoGitHubLink repoFullName={repoGroup.repoFullName} section="issues" />
                        <RepoLockControls repoFullName={repoGroup.repoFullName} />
                      </div>
                    }
                  >
                  <div class="bg-base-100" data-repo-group={repoGroup.repoFullName}>
                    <RepoGroupHeader
                      repoFullName={repoGroup.repoFullName}
                      starCount={repoGroup.starCount}
                      isExpanded={isExpanded()}
                      isHighlighted={highlightedReposIssues().has(repoGroup.repoFullName)}
                      onToggle={() => toggleExpandedRepo("issues", repoGroup.repoFullName)}
                      badges={
                        <Show when={monitoredRepoNameSet().has(repoGroup.repoFullName)}>
                          <Tooltip content="Showing all activity, not just yours" focusable>
                            <span class="badge badge-xs badge-ghost" aria-label="monitoring all activity">Monitoring all</span>
                          </Tooltip>
                        </Show>
                      }
                      trailing={
                        <>
                          <RepoGitHubLink repoFullName={repoGroup.repoFullName} section="issues" />
                          <RepoLockControls repoFullName={repoGroup.repoFullName} />
                        </>
                      }
                      collapsedSummary={
                        <span class="ml-auto flex items-center gap-2 text-xs font-normal text-base-content/60">
                          <span>{repoGroup.items.length} {repoGroup.items.length === 1 ? "issue" : "issues"}</span>
                          <For each={roleSummary()}>
                            {([role, count]) => (
                              <span class={`inline-flex items-center rounded-full px-1.5 py-0.5 text-xs font-medium ${
                                role === "author" ? "bg-primary/10 text-primary" :
                                role === "assignee" ? "bg-secondary/10 text-secondary" :
                                "bg-base-300 text-base-content/70"
                              }`}>
                                {role} ×{count}
                              </span>
                            )}
                          </For>
                        </span>
                      }
                    />
                    <Show when={isExpanded()}>
                      <div role="list" class="divide-y divide-base-300">
                        <For each={repoGroup.items}>
                          {(issue) => (
                            <div role="listitem" class={
                              viewState.tabFilters.issues.scope === "all" && isInvolvedItem(issue)
                                ? "border-l-2 border-l-primary"
                                : undefined
                            }>
                              <ItemRow
                                hideRepo={true}
                                repo={issue.repoFullName}
                                number={issue.number}
                                title={issue.title}
                                author={issue.userLogin}
                                createdAt={issue.createdAt}
                                updatedAt={issue.updatedAt}
                                refreshTick={props.refreshTick}
                                url={issue.htmlUrl}
                                labels={issue.labels}
                                onIgnore={() => handleIgnore(issue)}
                                onTrack={config.enableTracking ? () => handleTrack(issue) : undefined}
                                isTracked={config.enableTracking ? trackedIssueIds().has(issue.id) : undefined}
                                commentCount={issue.comments}
                                surfacedByBadge={
                                  props.trackedUsers && props.trackedUsers.length > 0
                                    ? <UserAvatarBadge
                                        users={buildSurfacedByUsers(issue.surfacedBy, trackedUserMap())}
                                        currentUserLogin={props.userLogin}
                                      />
                                    : undefined
                                }
                              >
                                <RoleBadge roles={issueMeta().get(issue.id)?.roles ?? []} />
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
      </Show>

      <Show when={!props.loading || props.issues.length > 0}>
        <PaginationControls
          page={page()}
          pageCount={pageCount()}
          totalItems={filteredSorted().length}
          itemLabel="issue"
          onPrev={() => setPage((p) => Math.max(0, p - 1))}
          onNext={() => setPage((p) => Math.min(pageCount() - 1, p + 1))}
        />
      </Show>
    </div>
  );
}
