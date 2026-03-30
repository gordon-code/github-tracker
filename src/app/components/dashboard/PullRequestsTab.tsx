import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { config } from "../../stores/config";
import { viewState, setSortPreference, ignoreItem, unignoreItem, setTabFilter, resetTabFilter, resetAllTabFilters, toggleExpandedRepo, setAllExpanded, pruneExpandedRepos, type PullRequestFilterField } from "../../stores/view";
import type { PullRequest } from "../../services/api";
import { deriveInvolvementRoles, prSizeCategory } from "../../lib/format";
import ExpandCollapseButtons from "../shared/ExpandCollapseButtons";
import ItemRow from "./ItemRow";
import UserAvatarBadge from "../shared/UserAvatarBadge";
import StatusDot from "../shared/StatusDot";
import IgnoreBadge from "./IgnoreBadge";
import SortDropdown from "../shared/SortDropdown";
import type { SortOption } from "../shared/SortDropdown";
import PaginationControls from "../shared/PaginationControls";
import FilterChips from "../shared/FilterChips";
import type { FilterChipGroupDef } from "../shared/FilterChips";
import ReviewBadge from "../shared/ReviewBadge";
import SizeBadge from "../shared/SizeBadge";
import RoleBadge from "../shared/RoleBadge";
import SkeletonRows from "../shared/SkeletonRows";
import ChevronIcon from "../shared/ChevronIcon";
import { groupByRepo, computePageLayout, slicePageGroups } from "../../lib/grouping";

export interface PullRequestsTabProps {
  pullRequests: PullRequest[];
  loading?: boolean;
  userLogin: string;
  allUsers?: { login: string; label: string }[];
  trackedUsers?: { login: string; avatarUrl: string; name: string | null }[];
}

type SortField = "repo" | "title" | "author" | "createdAt" | "updatedAt" | "checkStatus" | "reviewDecision" | "size";

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
      { value: "conflict", label: "Conflict" },
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

const sortOptions: SortOption[] = [
  { label: "Repo", field: "repo", type: "text" },
  { label: "Title", field: "title", type: "text" },
  { label: "Author", field: "author", type: "text" },
  { label: "Checks", field: "checkStatus", type: "text" },
  { label: "Review", field: "reviewDecision", type: "text" },
  { label: "Size", field: "size", type: "number" },
  { label: "Created", field: "createdAt", type: "date" },
  { label: "Updated", field: "updatedAt", type: "date" },
];

export default function PullRequestsTab(props: PullRequestsTabProps) {
  const [page, setPage] = createSignal(0);

  const trackedUserMap = createMemo(() =>
    new Map(props.trackedUsers?.map(u => [u.login, u]) ?? [])
  );

  const filterGroups = createMemo<FilterChipGroupDef[]>(() => {
    const users = props.allUsers;
    if (!users || users.length <= 1) return prFilterGroups;
    return [
      ...prFilterGroups,
      {
        label: "User",
        field: "user",
        options: users.map((u) => ({ value: u.login, label: u.label })),
      },
    ];
  });

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

      // Tab filters — light-field filters always apply; heavy-field filters
      // only apply to enriched PRs so unenriched phase-1 PRs aren't incorrectly hidden
      const isEnriched = pr.enriched !== false;
      if (tabFilters.role !== "all") {
        // Role depends on assigneeLogins/reviewerLogins (heavy), but "author" is light
        if (isEnriched && !roles.includes(tabFilters.role as "author" | "reviewer" | "assignee")) return false;
        if (!isEnriched && tabFilters.role === "author" && !roles.includes("author")) return false;
      }
      if (tabFilters.reviewDecision !== "all") {
        if (pr.reviewDecision !== tabFilters.reviewDecision) return false;
      }
      if (tabFilters.draft !== "all") {
        if (tabFilters.draft === "draft" && !pr.draft) return false;
        if (tabFilters.draft === "ready" && pr.draft) return false;
      }
      if (tabFilters.checkStatus !== "all" && isEnriched) {
        if (tabFilters.checkStatus === "none") {
          if (pr.checkStatus !== null) return false;
        } else {
          if (pr.checkStatus !== tabFilters.checkStatus) return false;
        }
      }
      if (tabFilters.sizeCategory !== "all" && isEnriched) {
        if (sizeCategory !== tabFilters.sizeCategory) return false;
      }

      if (tabFilters.user !== "all") {
        const surfacedBy = pr.surfacedBy ?? [props.userLogin.toLowerCase()];
        if (!surfacedBy.includes(tabFilters.user)) return false;
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

  const repoGroups = createMemo(() => groupByRepo(filteredSorted()));
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
    [...new Set(props.pullRequests.map((pr) => pr.repoFullName))]
  );

  createEffect(() => {
    const names = activeRepoNames();
    if (names.length === 0) return;
    pruneExpandedRepos("pullRequests", names);
  });

  function handleSort(field: string, direction: "asc" | "desc") {
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

  return (
    <div class="flex flex-col h-full">
      {/* Filter toolbar with SortDropdown */}
      <div class="flex items-center gap-3 px-4 py-2 border-b border-base-300 bg-base-100">
        <SortDropdown
          options={sortOptions}
          value={sortPref().field}
          direction={sortPref().direction}
          onChange={handleSort}
        />
        <FilterChips
          groups={filterGroups()}
          values={viewState.tabFilters.pullRequests}
          onChange={(field, value) => {
            setTabFilter("pullRequests", field as PullRequestFilterField, value);
            setPage(0);
          }}
          onReset={(field) => {
            resetTabFilter("pullRequests", field as PullRequestFilterField);
            setPage(0);
          }}
          onResetAll={() => {
            resetAllTabFilters("pullRequests");
            setPage(0);
          }}
        />
        <div class="flex-1" />
        <ExpandCollapseButtons
          onExpandAll={() => setAllExpanded("pullRequests", repoGroups().map((g) => g.repoFullName), true)}
          onCollapseAll={() => setAllExpanded("pullRequests", repoGroups().map((g) => g.repoFullName), false)}
        />
        <IgnoreBadge
          items={viewState.ignoredItems.filter((i) => i.type === "pullRequest")}
          onUnignore={unignoreItem}
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
              <p class="text-sm font-medium">No open pull requests involving you</p>
              <p class="text-xs">
                PRs where you are the author, assignee, or reviewer will appear here.
              </p>
            </div>
          }
        >
          <div class="divide-y divide-base-300">
            <For each={pageGroups()}>
              {(repoGroup) => {
                const isExpanded = () => !!viewState.expandedRepos.pullRequests[repoGroup.repoFullName];

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
                  <div class="bg-base-100">
                    <button
                      onClick={() => toggleExpandedRepo("pullRequests", repoGroup.repoFullName)}
                      aria-expanded={isExpanded()}
                      class="w-full flex items-center gap-2 px-4 py-2.5 text-left text-sm font-semibold text-base-content bg-base-200/60 border-y border-base-300 hover:bg-base-200 transition-colors"
                    >
                      <ChevronIcon size="md" rotated={!isExpanded()} />
                      {repoGroup.repoFullName}
                      <Show when={!isExpanded()}>
                        <span class="ml-auto flex items-center gap-2 text-xs font-normal text-base-content/60">
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
                      </Show>
                    </button>
                    <Show when={isExpanded()}>
                      <div role="list" class="divide-y divide-base-300">
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
                                commentCount={pr.enriched !== false ? pr.comments + pr.reviewThreads : undefined}
                                onIgnore={() => handleIgnore(pr)}
                                density={config.viewDensity}
                                surfacedByBadge={
                                  props.trackedUsers && props.trackedUsers.length > 0
                                    ? <UserAvatarBadge
                                        users={(pr.surfacedBy ?? []).flatMap((login) => {
                                          const u = trackedUserMap().get(login);
                                          return u ? [{ login: u.login, avatarUrl: u.avatarUrl }] : [];
                                        })}
                                        currentUserLogin={props.userLogin}
                                      />
                                    : undefined
                                }
                              >
                                <div class="flex items-center gap-2 flex-wrap">
                                  <Show when={pr.enriched !== false}>
                                    <RoleBadge roles={prMeta().get(pr.id)?.roles ?? []} />
                                  </Show>
                                  <ReviewBadge decision={pr.reviewDecision} />
                                  <Show when={pr.enriched !== false}>
                                    <SizeBadge additions={pr.additions} deletions={pr.deletions} changedFiles={pr.changedFiles} category={prMeta().get(pr.id)?.sizeCategory} filesUrl={`${pr.htmlUrl}/files`} />
                                    <StatusDot status={pr.checkStatus} href={`${pr.htmlUrl}/checks`} />
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
                                    <span class="text-xs text-base-content/60" title={pr.reviewerLogins.join(", ")}>
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
                );
              }}
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
