import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { config } from "../../stores/config";
import { viewState, setSortPreference, ignoreItem, unignoreItem, setTabFilter, resetTabFilter, resetAllTabFilters, type PullRequestFilterField } from "../../stores/view";
import type { PullRequest, ApiError } from "../../services/api";
import { deriveInvolvementRoles, prSizeCategory } from "../../lib/format";
import ItemRow from "./ItemRow";
import StatusDot from "../shared/StatusDot";
import IgnoreBadge from "./IgnoreBadge";
import SortIcon from "../shared/SortIcon";
import ErrorBannerList from "../shared/ErrorBannerList";
import PaginationControls from "../shared/PaginationControls";
import FilterChips from "../shared/FilterChips";
import type { FilterChipGroupDef } from "../shared/FilterChips";
import ReviewBadge from "../shared/ReviewBadge";
import SizeBadge from "../shared/SizeBadge";
import RoleBadge from "../shared/RoleBadge";
import SkeletonRows from "../shared/SkeletonRows";
import ChevronIcon from "../shared/ChevronIcon";

export interface PullRequestsTabProps {
  pullRequests: PullRequest[];
  loading?: boolean;
  errors?: ApiError[];
  userLogin: string;
}

type SortField = "repo" | "title" | "author" | "createdAt" | "updatedAt" | "checkStatus" | "reviewDecision" | "size";

function checkStatusOrder(status: PullRequest["checkStatus"]): number {
  switch (status) {
    case "failure":
      return 0;
    case "pending":
      return 1;
    case "success":
      return 2;
    default:
      return 3;
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

const prFilterGroups: FilterChipGroupDef[] = [
  {
    label: "Role",
    field: "role",
    options: [
      { value: "author", label: "Author" },
      { value: "reviewer", label: "Reviewer" },
      { value: "assignee", label: "Assignee" },
    ],
  },
  {
    label: "Review",
    field: "reviewDecision",
    options: [
      { value: "APPROVED", label: "Approved" },
      { value: "CHANGES_REQUESTED", label: "Changes" },
      { value: "REVIEW_REQUIRED", label: "Needs review" },
    ],
  },
  {
    label: "Status",
    field: "draft",
    options: [
      { value: "draft", label: "Draft" },
      { value: "ready", label: "Ready" },
    ],
  },
  {
    label: "Checks",
    field: "checkStatus",
    options: [
      { value: "success", label: "Passing" },
      { value: "failure", label: "Failing" },
      { value: "pending", label: "Pending" },
      { value: "none", label: "No CI" },
    ],
  },
  {
    label: "Size",
    field: "sizeCategory",
    options: [
      { value: "XS", label: "XS" },
      { value: "S", label: "S" },
      { value: "M", label: "M" },
      { value: "L", label: "L" },
      { value: "XL", label: "XL" },
    ],
  },
];

interface PrRepoGroup {
  repoFullName: string;
  items: PullRequest[];
}

function groupByRepo(items: PullRequest[]): PrRepoGroup[] {
  const groups: PrRepoGroup[] = [];
  const map = new Map<string, PrRepoGroup>();
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

function computePageLayout(
  groups: PrRepoGroup[],
  approxPageSize: number,
): { boundaries: number[]; pageCount: number } {
  if (groups.length === 0) return { boundaries: [0], pageCount: 1 };

  const boundaries: number[] = [0];
  let currentPageItems = 0;
  for (let i = 0; i < groups.length; i++) {
    if (currentPageItems > 0 && currentPageItems + groups[i].items.length > approxPageSize) {
      boundaries.push(i);
      currentPageItems = 0;
    }
    currentPageItems += groups[i].items.length;
  }

  return { boundaries, pageCount: Math.max(1, boundaries.length) };
}

function slicePageGroups(
  groups: PrRepoGroup[],
  boundaries: number[],
  pageCount: number,
  page: number,
): PrRepoGroup[] {
  const clampedPage = Math.max(0, Math.min(page, pageCount - 1));
  const start = boundaries[clampedPage];
  const end = clampedPage + 1 < boundaries.length ? boundaries[clampedPage + 1] : groups.length;
  return groups.slice(start, end);
}

export default function PullRequestsTab(props: PullRequestsTabProps) {
  const [page, setPage] = createSignal(0);
  const [collapsedRepos, setCollapsedRepos] = createStore<Record<string, boolean>>({});

  function toggleRepo(repoFullName: string) {
    setCollapsedRepos(repoFullName, (v) => !v);
  }

  const sortPref = createMemo(() => {
    const pref = viewState.sortPreferences["pullRequests"];
    return pref ?? { field: "updatedAt", direction: "desc" as const };
  });

  const filteredSortedWithMeta = createMemo(() => {
    const filter = viewState.globalFilter;
    const tabFilters = viewState.tabFilters.pullRequests;
    const ignored = new Set(
      viewState.ignoredItems
        .filter((i) => i.type === "pullRequest")
        .map((i) => i.id)
    );

    const meta = new Map<number, { roles: ReturnType<typeof deriveInvolvementRoles>; sizeCategory: ReturnType<typeof prSizeCategory> }>();

    let items = props.pullRequests.filter((pr) => {
      if (ignored.has(String(pr.id))) return false;
      if (filter.repo && pr.repoFullName !== filter.repo) return false;
      if (filter.org && !pr.repoFullName.startsWith(filter.org + "/")) return false;

      const roles = deriveInvolvementRoles(props.userLogin, pr.userLogin, pr.assigneeLogins, pr.reviewerLogins);
      const sizeCategory = prSizeCategory(pr.additions, pr.deletions);

      // Tab filters
      if (tabFilters.role !== "all") {
        if (!roles.includes(tabFilters.role as "author" | "reviewer" | "assignee")) return false;
      }
      if (tabFilters.reviewDecision !== "all") {
        if (pr.reviewDecision !== tabFilters.reviewDecision) return false;
      }
      if (tabFilters.draft !== "all") {
        if (tabFilters.draft === "draft" && !pr.draft) return false;
        if (tabFilters.draft === "ready" && pr.draft) return false;
      }
      if (tabFilters.checkStatus !== "all") {
        if (tabFilters.checkStatus === "none") {
          if (pr.checkStatus !== null) return false;
        } else {
          if (pr.checkStatus !== tabFilters.checkStatus) return false;
        }
      }
      if (tabFilters.sizeCategory !== "all") {
        if (sizeCategory !== tabFilters.sizeCategory) return false;
      }

      meta.set(pr.id, { roles, sizeCategory });
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

  const pageSize = createMemo(() => config.itemsPerPage);

  const repoGroups = createMemo(() => groupByRepo(filteredSorted()));
  const pageLayout = createMemo(() => computePageLayout(repoGroups(), pageSize()));
  const pageCount = () => pageLayout().pageCount;
  const pageGroups = createMemo(() =>
    slicePageGroups(repoGroups(), pageLayout().boundaries, pageLayout().pageCount, page())
  );

  createEffect(() => {
    const max = pageCount() - 1;
    if (page() > max) setPage(max);
  });

  function handleSort(field: SortField) {
    const current = sortPref();
    const direction =
      current.field === field && current.direction === "desc" ? "asc" : "desc";
    setSortPreference("pullRequests", field, direction);
    setPage(0);
  }

  function handleIgnore(pr: PullRequest) {
    ignoreItem({
      id: String(pr.id),
      type: "pullRequest",
      repo: pr.repoFullName,
      title: pr.title,
      ignoredAt: Date.now(),
    });
  }

  const columnHeaders: { label: string; field: SortField }[] = [
    { label: "Repo", field: "repo" },
    { label: "Title", field: "title" },
    { label: "Author", field: "author" },
    { label: "Checks", field: "checkStatus" },
    { label: "Review", field: "reviewDecision" },
    { label: "Size", field: "size" },
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
          items={viewState.ignoredItems.filter((i) => i.type === "pullRequest")}
          onUnignore={unignoreItem}
        />
      </div>

      {/* Filter chips */}
      <div class="px-4 py-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
        <FilterChips
          groups={prFilterGroups}
          values={viewState.tabFilters.pullRequests}
          onChange={(field, value) => { setTabFilter("pullRequests", field as PullRequestFilterField, value); setPage(0); }}
          onReset={(field) => { resetTabFilter("pullRequests", field as PullRequestFilterField); setPage(0); }}
          onResetAll={() => { resetAllTabFilters("pullRequests"); setPage(0); }}
        />
      </div>

      {/* Loading skeleton — only when no data exists yet */}
      <Show when={props.loading && props.pullRequests.length === 0}>
        <SkeletonRows label="Loading pull requests" />
      </Show>

      {/* PR rows */}
      <Show when={!props.loading || props.pullRequests.length > 0}>
        <Show
          when={pageGroups().length > 0}
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
                  d="M8 7h8m-8 5h5m-5 5h8M5 3h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2z"
                />
              </svg>
              <p class="text-sm font-medium">No open pull requests involving you</p>
              <p class="text-xs">
                PRs where you are the author, assignee, or reviewer will appear here.
              </p>
            </div>
          }
        >
          <div class="divide-y divide-gray-100 dark:divide-gray-800">
            <For each={pageGroups()}>
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
                        {(pr) => (
                          <div role="listitem">
                            <ItemRow
                              hideRepo={true}
                              repo={pr.repoFullName}
                              number={pr.number}
                              title={pr.title}
                              author={pr.userLogin}
                              createdAt={pr.createdAt}
                              url={pr.htmlUrl}
                              labels={pr.labels}
                              commentCount={pr.comments + pr.reviewComments}
                              onIgnore={() => handleIgnore(pr)}
                              density={config.viewDensity}
                            >
                              <div class="flex items-center gap-2 flex-wrap">
                                <RoleBadge roles={prMeta().get(pr.id)?.roles ?? []} />
                                <ReviewBadge decision={pr.reviewDecision} />
                                <SizeBadge additions={pr.additions} deletions={pr.deletions} changedFiles={pr.changedFiles} category={prMeta().get(pr.id)?.sizeCategory} />
                                <StatusDot status={pr.checkStatus} />
                                <Show when={pr.draft}>
                                  <span class="inline-flex items-center rounded-full bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 text-xs px-2 py-0.5 font-medium">
                                    Draft
                                  </span>
                                </Show>
                                <Show when={pr.reviewerLogins.length > 0}>
                                  <span class="text-xs text-gray-500 dark:text-gray-400" title={pr.reviewerLogins.join(", ")}>
                                    Reviewers: {pr.reviewerLogins.slice(0, 5).join(", ")}
                                    {pr.reviewerLogins.length > 5 && ` +${pr.reviewerLogins.length - 5} more`}
                                    {pr.totalReviewCount > pr.reviewerLogins.length && ` (${pr.totalReviewCount} total)`}
                                  </span>
                                </Show>
                              </div>
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
