import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { config, type TrackedUser } from "../../stores/config";
import { viewState, setSortPreference, setTabFilter, resetTabFilter, resetAllTabFilters, ignoreItem, unignoreItem, toggleExpandedRepo, setAllExpanded, pruneExpandedRepos, pruneLockedRepos, type IssueFilterField } from "../../stores/view";
import type { Issue, RepoRef } from "../../services/api";
import ItemRow from "./ItemRow";
import UserAvatarBadge, { buildSurfacedByUsers } from "../shared/UserAvatarBadge";
import IgnoreBadge from "./IgnoreBadge";
import SortDropdown from "../shared/SortDropdown";
import type { SortOption } from "../shared/SortDropdown";
import PaginationControls from "../shared/PaginationControls";
import FilterChips from "../shared/FilterChips";
import type { FilterChipGroupDef } from "../shared/FilterChips";
import RoleBadge from "../shared/RoleBadge";
import SkeletonRows from "../shared/SkeletonRows";
import ChevronIcon from "../shared/ChevronIcon";
import ExpandCollapseButtons from "../shared/ExpandCollapseButtons";
import { deriveInvolvementRoles } from "../../lib/format";
import { groupByRepo, computePageLayout, slicePageGroups, orderRepoGroups } from "../../lib/grouping";
import { createReorderHighlight } from "../../lib/reorderHighlight";
import RepoLockControls from "../shared/RepoLockControls";
import ExternalLinkIcon from "../shared/ExternalLinkIcon";

export interface IssuesTabProps {
  issues: Issue[];
  loading?: boolean;
  userLogin: string;
  allUsers?: { login: string; label: string }[];
  trackedUsers?: TrackedUser[];
  monitoredRepos?: RepoRef[];
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

const sortOptions: SortOption[] = [
  { label: "Repo", field: "repo", type: "text" },
  { label: "Title", field: "title", type: "text" },
  { label: "Author", field: "author", type: "text" },
  { label: "Comments", field: "comments", type: "number" },
  { label: "Created", field: "createdAt", type: "date" },
  { label: "Updated", field: "updatedAt", type: "date" },
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

  const filterGroups = createMemo<FilterChipGroupDef[]>(() => {
    const users = props.allUsers;
    if (!users || users.length <= 1) return issueFilterGroups;
    return [
      ...issueFilterGroups,
      {
        label: "User",
        field: "user",
        options: users.map((u) => ({ value: u.login, label: u.label })),
      },
    ];
  });

  const sortPref = createMemo(() => {
    const pref = viewState.sortPreferences["issues"];
    return pref ?? { field: "updatedAt", direction: "desc" as const };
  });

  const filteredSortedWithMeta = createMemo(() => {
    const filter = viewState.globalFilter;
    const tabFilter = viewState.tabFilters.issues;
    const ignored = new Set(
      viewState.ignoredItems
        .filter((i) => i.type === "issue")
        .map((i) => i.id)
    );

    const meta = new Map<number, { roles: ReturnType<typeof deriveInvolvementRoles> }>();

    let items = props.issues.filter((issue) => {
      if (ignored.has(String(issue.id))) return false;
      if (filter.repo && issue.repoFullName !== filter.repo) return false;
      if (filter.org && !issue.repoFullName.startsWith(filter.org + "/")) return false;

      const roles = deriveInvolvementRoles(props.userLogin, issue.userLogin, issue.assigneeLogins, [], upstreamRepoSet().has(issue.repoFullName));

      if (tabFilter.role !== "all") {
        if (!roles.includes(tabFilter.role as "author" | "assignee")) return false;
      }

      if (tabFilter.comments !== "all") {
        if (tabFilter.comments === "has" && issue.comments === 0) return false;
        if (tabFilter.comments === "none" && issue.comments > 0) return false;
      }

      if (tabFilter.depDashboard === "hide" && issue.title === "Dependency Dashboard") return false;

      if (tabFilter.user !== "all") {
        // Items from monitored repos bypass the surfacedBy filter (all activity is shown)
        if (!monitoredRepoNameSet().has(issue.repoFullName)) {
          const validUser = !props.allUsers || props.allUsers.some(u => u.login === tabFilter.user);
          if (validUser) {
            const surfacedBy = issue.surfacedBy ?? [props.userLogin.toLowerCase()];
            if (!surfacedBy.includes(tabFilter.user)) return false;
          }
        }
      }

      meta.set(issue.id, { roles });
      return true;
    });

    const { field, direction } = sortPref();
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

  const repoGroups = createMemo(() =>
    orderRepoGroups(groupByRepo(filteredSorted()), viewState.lockedRepos.issues)
  );
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
    [...new Set(props.issues.map((i) => i.repoFullName))]
  );

  createEffect(() => {
    const names = activeRepoNames();
    if (names.length === 0) return;
    pruneExpandedRepos("issues", names);
  });

  createEffect(() => {
    const names = activeRepoNames();
    if (names.length === 0) return;
    pruneLockedRepos("issues", names);
  });

  const highlightedReposIssues = createReorderHighlight(
    () => repoGroups().map(g => g.repoFullName),
    () => viewState.lockedRepos.issues,
  );

  function handleSort(field: string, direction: "asc" | "desc") {
    setSortPreference("issues", field, direction);
    setPage(0);
  }

  function handleIgnore(issue: Issue) {
    ignoreItem({
      id: String(issue.id),
      type: "issue",
      repo: issue.repoFullName,
      title: issue.title,
      ignoredAt: Date.now(),
    });
  }

  return (
    <div class="flex flex-col h-full">
      {/* Sort dropdown + filter chips + ignore badge toolbar */}
      <div class="flex flex-wrap items-center gap-3 px-4 py-2 border-b border-base-300 bg-base-100">
        <SortDropdown
          options={sortOptions}
          value={sortPref().field}
          direction={sortPref().direction}
          onChange={handleSort}
        />
        <FilterChips
          groups={filterGroups()}
          values={viewState.tabFilters.issues}
          onChange={(field, value) => {
            setTabFilter("issues", field as IssueFilterField, value);
            setPage(0);
          }}
          onReset={(field) => {
            resetTabFilter("issues", field as IssueFilterField);
            setPage(0);
          }}
          onResetAll={() => {
            resetAllTabFilters("issues");
            setPage(0);
          }}
        />
        <button
          onClick={() => {
            const next = viewState.tabFilters.issues.depDashboard === "show" ? "hide" : "show";
            setTabFilter("issues", "depDashboard", next);
            setPage(0);
          }}
          class={`btn btn-xs rounded-full ${viewState.tabFilters.issues.depDashboard === "show" ? "btn-primary" : "btn-ghost text-base-content/50"}`}
          aria-pressed={viewState.tabFilters.issues.depDashboard === "show"}
          title="Toggle visibility of Dependency Dashboard issues"
        >
          Show Dep Dashboard
        </button>
        <div class="flex-1" />
        <ExpandCollapseButtons
          onExpandAll={() => setAllExpanded("issues", repoGroups().map((g) => g.repoFullName), true)}
          onCollapseAll={() => setAllExpanded("issues", repoGroups().map((g) => g.repoFullName), false)}
        />
        <IgnoreBadge
          items={viewState.ignoredItems.filter((i) => i.type === "issue")}
          onUnignore={unignoreItem}
        />
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
              <p class="text-sm font-medium">No open issues involving you</p>
              <p class="text-xs">
                Issues where you are the author, assignee, or mentioned will appear here.
              </p>
            </div>
          }
        >
          <div class="divide-y divide-base-300">
            <For each={pageGroups()}>
              {(repoGroup) => {
                const isExpanded = () => !!viewState.expandedRepos.issues[repoGroup.repoFullName];

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
                  <div class="bg-base-100">
                    <div class={`group/repo-header flex items-center bg-base-200/60 border-y border-base-300 hover:bg-base-200 transition-colors duration-300 ${highlightedReposIssues().has(repoGroup.repoFullName) ? "animate-reorder-highlight" : ""}`}>
                      <button
                        onClick={() => toggleExpandedRepo("issues", repoGroup.repoFullName)}
                        aria-expanded={isExpanded()}
                        class="flex-1 flex items-center gap-2 px-4 py-2.5 text-left text-sm font-semibold text-base-content"
                      >
                        <ChevronIcon size="md" rotated={!isExpanded()} />
                        {repoGroup.repoFullName}
                        <Show when={monitoredRepoNameSet().has(repoGroup.repoFullName)}>
                          <span class="badge badge-xs badge-ghost" aria-label="monitoring all activity">Monitoring all</span>
                        </Show>
                        <Show when={!isExpanded()}>
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
                        </Show>
                      </button>
                      <a
                        href={`https://github.com/${repoGroup.repoFullName}/issues`}
                        target="_blank"
                        rel="noopener noreferrer"
                        class="opacity-0 group-hover/repo-header:opacity-100 focus-visible:opacity-100 transition-opacity text-base-content/40 hover:text-primary px-1"
                        title={`Open ${repoGroup.repoFullName} issues on GitHub`}
                        aria-label={`Open ${repoGroup.repoFullName} issues on GitHub`}
                      >
                        <ExternalLinkIcon />
                      </a>
                      <RepoLockControls tab="issues" repoFullName={repoGroup.repoFullName} />
                    </div>
                    <Show when={isExpanded()}>
                      <div role="list" class="divide-y divide-base-300">
                        <For each={repoGroup.items}>
                          {(issue) => (
                            <div role="listitem">
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
                                density={config.viewDensity}
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
