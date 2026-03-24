import { createMemo, createSignal, For, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { config } from "../../stores/config";
import { viewState, setSortPreference, setTabFilter, resetTabFilter, resetAllTabFilters, ignoreItem, unignoreItem, type IssueFilterField } from "../../stores/view";
import type { Issue, ApiError } from "../../services/api";
import ItemRow from "./ItemRow";
import IgnoreBadge from "./IgnoreBadge";
import SortIcon from "../shared/SortIcon";
import ErrorBannerList from "../shared/ErrorBannerList";
import PaginationControls from "../shared/PaginationControls";
import FilterChips from "../shared/FilterChips";
import type { FilterChipGroupDef } from "../shared/FilterChips";
import RoleBadge from "../shared/RoleBadge";
import SkeletonRows from "../shared/SkeletonRows";
import ChevronIcon from "../shared/ChevronIcon";
import { deriveInvolvementRoles } from "../../lib/format";

export interface IssuesTabProps {
  issues: Issue[];
  loading?: boolean;
  errors?: ApiError[];
  userLogin: string;
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

interface IssueRepoGroup {
  repoFullName: string;
  items: Issue[];
}

function groupByRepo(items: Issue[]): IssueRepoGroup[] {
  const groups: IssueRepoGroup[] = [];
  const map = new Map<string, IssueRepoGroup>();
  for (const item of items) {
    let group = map.get(item.repoFullName);
    if (!group) {
      group = { repoFullName: item.repoFullName, items: [] };
      map.set(item.repoFullName, group);
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}

function paginateGroups(
  groups: IssueRepoGroup[],
  page: number,
  approxPageSize: number,
): { pageGroups: IssueRepoGroup[]; pageCount: number } {
  if (groups.length === 0) return { pageGroups: [], pageCount: 1 };

  const pageBoundaries: number[] = [0];
  let currentPageItems = 0;
  for (let i = 0; i < groups.length; i++) {
    if (currentPageItems > 0 && currentPageItems + groups[i].items.length > approxPageSize) {
      pageBoundaries.push(i);
      currentPageItems = 0;
    }
    currentPageItems += groups[i].items.length;
  }

  const pageCount = Math.max(1, pageBoundaries.length);
  const clampedPage = Math.max(0, Math.min(page, pageCount - 1));
  const start = pageBoundaries[clampedPage];
  const end = clampedPage + 1 < pageBoundaries.length ? pageBoundaries[clampedPage + 1] : groups.length;

  return { pageGroups: groups.slice(start, end), pageCount };
}

export default function IssuesTab(props: IssuesTabProps) {
  const [page, setPage] = createSignal(0);
  const [collapsedRepos, setCollapsedRepos] = createStore<Record<string, boolean>>({});

  function toggleRepo(repoFullName: string) {
    setCollapsedRepos(repoFullName, (v) => !v);
  }

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

      const roles = deriveInvolvementRoles(props.userLogin, issue.userLogin, issue.assigneeLogins, []);

      if (tabFilter.role !== "all") {
        if (!roles.includes(tabFilter.role as "author" | "assignee")) return false;
      }

      if (tabFilter.comments !== "all") {
        if (tabFilter.comments === "has" && issue.comments === 0) return false;
        if (tabFilter.comments === "none" && issue.comments > 0) return false;
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

  const filteredSorted = () => filteredSortedWithMeta().items;
  const issueMeta = () => filteredSortedWithMeta().meta;

  const pageSize = createMemo(() => config.itemsPerPage);

  const repoGroups = createMemo(() => groupByRepo(filteredSorted()));
  const paginatedResult = createMemo(() => paginateGroups(repoGroups(), page(), pageSize()));
  const pageCount = () => paginatedResult().pageCount;

  function handleSort(field: SortField) {
    const current = sortPref();
    const direction =
      current.field === field && current.direction === "desc" ? "asc" : "desc";
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

  const columnHeaders: { label: string; field: SortField }[] = [
    { label: "Repo", field: "repo" },
    { label: "Title", field: "title" },
    { label: "Author", field: "author" },
    { label: "Comments", field: "comments" },
    { label: "Created", field: "createdAt" },
    { label: "Updated", field: "updatedAt" },
  ];

  return (
    <div class="flex flex-col h-full">
      <ErrorBannerList errors={props.errors?.map((e) => ({ source: e.repo, message: e.message, retryable: e.retryable }))} />

      {/* Column headers */}
      <div
        role="rowgroup"
        class="flex items-center gap-2 px-4 py-1.5 bg-gray-100 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 text-xs font-medium text-gray-600 dark:text-gray-400 select-none"
      >
        <For each={columnHeaders}>
          {(col) => (
            <button
              onClick={() => handleSort(col.field)}
              class="hover:text-gray-900 dark:hover:text-gray-100 transition-colors focus:outline-none focus:underline"
              aria-label={`Sort by ${col.label}`}
            >
              {col.label}
              <SortIcon
                active={sortPref().field === col.field}
                direction={sortPref().direction}
              />
            </button>
          )}
        </For>

        <div class="flex-1" />
        <IgnoreBadge
          items={viewState.ignoredItems.filter((i) => i.type === "issue")}
          onUnignore={unignoreItem}
        />
      </div>

      {/* Filter chips */}
      <div class="px-4 py-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
        <FilterChips
          groups={issueFilterGroups}
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
      </div>

      {/* Loading skeleton — only when no data exists yet */}
      <Show when={props.loading && props.issues.length === 0}>
        <SkeletonRows label="Loading issues" />
      </Show>

      {/* Issue rows */}
      <Show when={!props.loading || props.issues.length > 0}>
        <Show
          when={paginatedResult().pageGroups.length > 0}
          fallback={
            <div class="flex flex-col items-center justify-center gap-2 py-16 text-gray-500 dark:text-gray-400">
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
          <div class="divide-y divide-gray-100 dark:divide-gray-800">
            <For each={paginatedResult().pageGroups}>
              {(repoGroup) => (
                <div class="bg-white dark:bg-gray-900">
                  <button
                    onClick={() => toggleRepo(repoGroup.repoFullName)}
                    aria-expanded={!collapsedRepos[repoGroup.repoFullName]}
                    class="w-full flex items-center gap-2 px-4 py-2 text-left text-sm font-semibold text-gray-700 dark:text-gray-200 bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                  >
                    <ChevronIcon size="md" rotated={collapsedRepos[repoGroup.repoFullName]} />
                    {repoGroup.repoFullName}
                  </button>
                  <Show when={!collapsedRepos[repoGroup.repoFullName]}>
                    <div role="list" class="divide-y divide-gray-200 dark:divide-gray-700">
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
                              url={issue.htmlUrl}
                              labels={issue.labels}
                              onIgnore={() => handleIgnore(issue)}
                              density={config.viewDensity}
                              commentCount={issue.comments}
                            >
                              <RoleBadge roles={issueMeta().get(issue.id)?.roles ?? []} />
                            </ItemRow>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              )}
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
