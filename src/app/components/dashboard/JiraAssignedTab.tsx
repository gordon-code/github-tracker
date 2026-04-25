import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import type { JiraIssue } from "../../../shared/jira-types";
import { viewState, setTabFilter, resetAllTabFilters, JiraFiltersSchema, trackItem, untrackJiraItem, setAllExpanded } from "../../stores/view";
import { config } from "../../stores/config";
import { jiraStatusCategoryClass } from "../../lib/format";
import { isSafeJiraSiteUrl } from "../../lib/url";
import { groupByRepo, computePageLayout, slicePageGroups, ensureLockedRepoGroups, orderRepoGroups } from "../../lib/grouping";
import PaginationControls from "../shared/PaginationControls";
import FilterPopover from "../shared/FilterPopover";
import LoadingSpinner from "../shared/LoadingSpinner";
import SortDropdown, { type SortOption } from "../shared/SortDropdown";
import ExpandCollapseButtons from "../shared/ExpandCollapseButtons";
import ChevronIcon from "../shared/ChevronIcon";
import RepoLockControls from "../shared/RepoLockControls";
import { Tooltip } from "../shared/Tooltip";

const JIRA_FILTER_DEFAULTS = JiraFiltersSchema.parse({});
const ITEMS_PER_PAGE = 25;
const TAB_KEY = "jiraAssigned";

interface JiraAssignedTabProps {
  issues: JiraIssue[];
  loading: boolean;
  siteUrl: string;
}

const STATUS_CATEGORY_OPTIONS = [
  { value: "all", label: "All" },
  { value: "new", label: "To Do" },
  { value: "indeterminate", label: "In Progress" },
];

const PRIORITY_OPTIONS = [
  { value: "all", label: "All" },
  { value: "Highest", label: "Highest" },
  { value: "High", label: "High" },
  { value: "Medium", label: "Medium" },
  { value: "Low", label: "Low" },
  { value: "Lowest", label: "Lowest" },
];

const JIRA_SORT_OPTIONS: SortOption[] = [
  { label: "Priority", field: "priority", type: "priority" },
  { label: "Status", field: "status", type: "text" },
  { label: "Key", field: "key", type: "text" },
  { label: "Updated", field: "updated", type: "date" },
];

const PRIORITY_ORDER = Object.assign(Object.create(null) as Record<string, number>, {
  Highest: 0, High: 1, Medium: 2, Low: 3, Lowest: 4,
});

function normalizePriorityName(name: string): string {
  return name.replace(/\s*\(.*\)$/, "");
}

const STATUS_CATEGORY_ORDER = Object.assign(Object.create(null) as Record<string, number>, {
  indeterminate: 0, new: 1, done: 2,
});

// Module-level so sort preference persists across tab switches (matches jiraIssues/jiraKeyMap pattern)
const [sortField, setSortField] = createSignal("priority");
const [sortDirection, setSortDirection] = createSignal<"asc" | "desc">("asc");
let _jiraExpandInitialized = false;

export function _resetJiraTabState() {
  setSortField("priority");
  setSortDirection("asc");
  _jiraExpandInitialized = false;
}

const ISSUE_TYPE_ICONS: Record<string, { path: string; color: string }> = Object.assign(
  Object.create(null) as Record<string, { path: string; color: string }>,
  {
    Epic:    { path: "M13 3L4 14h5l-2 7 9-11h-5l2-7z", color: "#904ee2" },
    Story:   { path: "M4 4h16v12a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 0v12h12V4H6z", color: "#63ba3c" },
    Task:    { path: "M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z", color: "#4bade8" },
    Bug:     { path: "M12 2a8 8 0 100 16 8 8 0 000-16zm0 14a6 6 0 110-12 6 6 0 010 12zm-1-5h2V7h-2v4zm0 2h2v2h-2v-2z", color: "#e5493a" },
    Subtask: { path: "M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z", color: "#4bade8" },
  },
);

function IssueTypeFallbackIcon(props: { name: string }) {
  const normalized = () => normalizePriorityName(props.name);
  const icon = () => ISSUE_TYPE_ICONS[normalized()];
  return (
    <Show
      when={icon()}
      fallback={
        <span class="badge badge-xs badge-ghost text-[10px]">{normalized()}</span>
      }
    >
      {(i) => (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill={i().color} class="h-4 w-4 shrink-0" aria-label={props.name}>
          <path d={i().path} />
        </svg>
      )}
    </Show>
  );
}

export default function JiraAssignedTab(props: JiraAssignedTabProps) {
  const [page, setPage] = createSignal(0);

  const filters = createMemo(() => viewState.tabFilters.jiraAssigned ?? JIRA_FILTER_DEFAULTS);

  const pinnedJiraKeys = createMemo(() =>
    new Set(
      viewState.trackedItems
        .filter((t) => t.source === "jira" && t.jiraKey)
        .map((t) => t.jiraKey!)
    )
  );

  const filtered = createMemo(() => {
    const f = filters();
    return props.issues.filter((issue) => {
      if (f.statusCategory !== "all" && issue.fields.status.statusCategory.key !== f.statusCategory) return false;
      if (f.priority !== "all" && issue.fields.priority?.name !== f.priority) return false;
      return true;
    });
  });

  const filteredSorted = createMemo(() => {
    const items = [...filtered()];
    const field = sortField();
    const dir = sortDirection();
    items.sort((a, b) => {
      let cmp = 0;
      switch (field) {
        case "priority":
          cmp = (PRIORITY_ORDER[normalizePriorityName(a.fields.priority?.name ?? "Medium")] ?? 2)
            - (PRIORITY_ORDER[normalizePriorityName(b.fields.priority?.name ?? "Medium")] ?? 2);
          break;
        case "status":
          cmp = (STATUS_CATEGORY_ORDER[a.fields.status.statusCategory.key] ?? 1)
            - (STATUS_CATEGORY_ORDER[b.fields.status.statusCategory.key] ?? 1);
          break;
        case "key": {
          const aP = a.key.replace(/-\d+$/, "");
          const bP = b.key.replace(/-\d+$/, "");
          cmp = aP === bP
            ? parseInt(a.key.split("-").pop()!, 10) - parseInt(b.key.split("-").pop()!, 10)
            : aP.localeCompare(bP);
          break;
        }
        case "updated": {
          const aUp = String(a.fields.updated ?? "");
          const bUp = String(b.fields.updated ?? "");
          cmp = aUp < bUp ? -1 : aUp > bUp ? 1 : 0;
          break;
        }
        default:
          break;
      }
      return dir === "asc" ? cmp : -cmp;
    });
    return items;
  });

  type JiraItem = JiraIssue & { repoFullName: string };
  const itemsWithGroupKey = createMemo(() =>
    filteredSorted().map((issue): JiraItem => ({
      ...issue,
      repoFullName: issue.fields.project?.key ?? "OTHER",
    }))
  );

  const repoGroups = createMemo(() => {
    const groups = groupByRepo(itemsWithGroupKey());
    const lockedForTab = viewState.lockedRepos[TAB_KEY] ?? [];
    const withLocked = ensureLockedRepoGroups(
      groups,
      lockedForTab,
      (name) => ({ repoFullName: name, items: [] as JiraItem[] }),
    );
    return orderRepoGroups(withLocked, lockedForTab);
  });

  const pageLayout = createMemo(() => computePageLayout(repoGroups(), ITEMS_PER_PAGE));
  const pageCount = createMemo(() => pageLayout().pageCount);
  const pageGroups = createMemo(() =>
    slicePageGroups(repoGroups(), pageLayout().boundaries, pageCount(), page())
  );

  const projectKeys = createMemo(() => repoGroups().map((g) => g.repoFullName));

  createEffect(() => {
    const max = pageCount() - 1;
    if (page() > max) setPage(max);
  });

  createEffect(() => {
    const keys = projectKeys();
    if (keys.length === 0 || _jiraExpandInitialized) return;
    const expanded = viewState.expandedRepos[TAB_KEY];
    if (expanded && Object.keys(expanded).length > 0) return;
    _jiraExpandInitialized = true;
    setAllExpanded(TAB_KEY, keys, true);
  });

  return (
    <div class="flex flex-col">
      {/* Filter + sort toolbar */}
      <div class="border-b border-base-300 px-4 py-2 compact:py-0.5 flex items-center gap-2 compact:gap-1.5 flex-wrap">
        <span class="text-sm font-medium text-base-content/60">Filter:</span>
        <FilterPopover
          group={{
            field: "statusCategory",
            label: "Status",
            options: STATUS_CATEGORY_OPTIONS,
            defaultValue: "all",
          }}
          value={filters().statusCategory}
          onChange={(field, value) => {
            setTabFilter("jiraAssigned", field as "statusCategory", value);
            setPage(0);
          }}
        />
        <FilterPopover
          group={{
            field: "priority",
            label: "Priority",
            options: PRIORITY_OPTIONS,
            defaultValue: "all",
          }}
          value={filters().priority}
          onChange={(field, value) => {
            setTabFilter("jiraAssigned", field as "priority", value);
            setPage(0);
          }}
        />
        <Show when={filters().statusCategory !== "all" || filters().priority !== "all"}>
          <button
            type="button"
            class="btn btn-ghost btn-xs"
            onClick={() => { resetAllTabFilters("jiraAssigned"); setPage(0); }}
          >
            Clear
          </button>
        </Show>
        <div class="ml-auto flex items-center gap-2">
          <span class="text-xs text-base-content/50">
            {filtered().length} issue{filtered().length !== 1 ? "s" : ""}
          </span>
          <SortDropdown
            options={JIRA_SORT_OPTIONS}
            value={sortField()}
            direction={sortDirection()}
            onChange={(field, dir) => {
              setSortField(field);
              setSortDirection(dir);
              setPage(0);
            }}
          />
          <ExpandCollapseButtons
            onExpandAll={() => setAllExpanded(TAB_KEY, projectKeys(), true)}
            onCollapseAll={() => setAllExpanded(TAB_KEY, projectKeys(), false)}
          />
        </div>
      </div>

      <Show when={props.loading && props.issues.length === 0}>
        <div class="flex justify-center py-12">
          <LoadingSpinner size="md" label="Loading Jira issues..." />
        </div>
      </Show>

      <Show when={!props.loading && filtered().length === 0}>
        <div class="flex flex-col items-center justify-center py-16 text-base-content/40">
          <p class="text-base">
            {(filters().statusCategory !== "all" || filters().priority !== "all")
              ? "No issues match current filters"
              : "No assigned Jira issues"}
          </p>
        </div>
      </Show>

      <Show when={pageGroups().length > 0}>
        <div class="divide-y divide-base-300">
          <For each={pageGroups()}>
            {(group) => {
              const isEmpty = () => group.items.length === 0;
              const isExpanded = () => !isEmpty() && !!(viewState.expandedRepos[TAB_KEY] ?? {})[group.repoFullName];

              return (
                <div>
                  <div class="group/repo-header flex items-center bg-info/5 border-y border-base-300 hover:bg-info/10 transition-colors">
                    <button
                      onClick={() => setAllExpanded(TAB_KEY, [group.repoFullName], !isExpanded())}
                      aria-expanded={isExpanded()}
                      class="flex-1 flex items-center gap-2 px-4 py-2.5 compact:py-1.5 text-left text-base compact:text-sm font-bold"
                    >
                      <ChevronIcon size="md" rotated={!isExpanded()} />
                      {group.repoFullName}
                      <Show when={!isExpanded() && !isEmpty()}>
                        <span class="ml-auto text-xs font-normal text-base-content/60">
                          {group.items.length} issue{group.items.length !== 1 ? "s" : ""}
                        </span>
                      </Show>
                    </button>
                    <RepoLockControls repoFullName={group.repoFullName} tabKey={TAB_KEY} />
                  </div>
                  <Show when={isExpanded()}>
                    <div role="list" class="divide-y divide-base-300">
                      <For each={group.items}>
                        {(issue) => {
                          const isPinned = () => pinnedJiraKeys().has(issue.key);
                          const browseUrl = () => isSafeJiraSiteUrl(props.siteUrl) ? `${props.siteUrl}/browse/${issue.key}` : "#";
                          return (
                            <div role="listitem" class="px-4 py-3 compact:py-2 flex items-start gap-3 compact:gap-2">
                              <div class="flex-1 min-w-0">
                                <div class="flex items-center gap-2 flex-wrap">
                                  <Show when={issue.fields.issuetype}>
                                    {(type) => {
                                      const [imgFailed, setImgFailed] = createSignal(false);
                                      return (
                                        <Tooltip content={type().name} focusable>
                                          <Show
                                            when={type().iconUrl && !imgFailed()}
                                            fallback={<IssueTypeFallbackIcon name={type().name} />}
                                          >
                                            <img
                                              src={type().iconUrl!}
                                              alt={type().name}
                                              class="h-4 w-4 shrink-0"
                                              loading="lazy"
                                              onError={() => setImgFailed(true)}
                                            />
                                          </Show>
                                        </Tooltip>
                                      );
                                    }}
                                  </Show>
                                  <a
                                    href={browseUrl()}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    class="font-mono text-xs text-primary hover:underline shrink-0"
                                  >
                                    {issue.key}
                                  </a>
                                  <span
                                    class={`badge badge-xs ${jiraStatusCategoryClass(issue.fields.status.statusCategory.key)}`}
                                  >
                                    {issue.fields.status.name}
                                  </span>
                                  <Show when={issue.fields.priority?.name && normalizePriorityName(issue.fields.priority.name) !== "Medium" && issue.fields.priority.name !== "Undefined"}>
                                    <span class="badge badge-xs badge-outline text-[10px]">
                                      {normalizePriorityName(issue.fields.priority!.name)}
                                    </span>
                                  </Show>
                                  <Show when={config.viewDensity === "compact"}>
                                    <span class="text-xs text-base-content truncate" title={issue.fields.summary}>
                                      {issue.fields.summary}
                                    </span>
                                  </Show>
                                </div>
                                <Show when={config.viewDensity !== "compact"}>
                                  <p class="mt-0.5 text-sm text-base-content truncate" title={issue.fields.summary}>
                                    {issue.fields.summary}
                                  </p>
                                </Show>
                              </div>
                              <Show when={config.enableTracking}>
                                <button
                                  type="button"
                                  class={`shrink-0 self-center rounded p-1 transition-colors focus:outline-none focus:ring-2 focus:ring-primary ${isPinned() ? "text-primary" : "text-base-content/30 hover:text-primary"}`}
                                  aria-label={isPinned() ? `Unpin ${issue.key}` : `Pin ${issue.key}`}
                                  onClick={() => {
                                    if (isPinned()) {
                                      untrackJiraItem(issue.key);
                                    } else {
                                      trackItem({
                                        id: parseInt(issue.id, 10),
                                        source: "jira",
                                        type: "jiraIssue",
                                        jiraKey: issue.key,
                                        jiraProjectKey: issue.fields.project?.key,
                                        jiraStatus: issue.fields.status.name,
                                        repoFullName: `${props.siteUrl.replace(/^https?:\/\//, "")}/${issue.fields.project?.key ?? "unknown"}`,
                                        htmlUrl: browseUrl(),
                                        title: issue.fields.summary,
                                        addedAt: Date.now(),
                                      });
                                    }
                                  }}
                                >
                                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill={isPinned() ? "currentColor" : "none"} stroke="currentColor" stroke-width={isPinned() ? "0" : "1.5"} class="h-4 w-4">
                                    <path fill-rule="evenodd" d="M6.32 2.577a49.255 49.255 0 0 1 11.36 0c1.497.174 2.57 1.46 2.57 2.93V21a.75.75 0 0 1-1.085.67L12 18.089l-7.165 3.583A.75.75 0 0 1 3.75 21V5.507c0-1.47 1.073-2.756 2.57-2.93Z" clip-rule="evenodd" />
                                  </svg>
                                </button>
                              </Show>
                            </div>
                          );
                        }}
                      </For>
                    </div>
                  </Show>
                  <Show when={isEmpty()}>
                    <div class="px-4 py-3 compact:py-2 text-sm text-base-content/40 italic">
                      No matching issues in {group.repoFullName}
                    </div>
                  </Show>
                </div>
              );
            }}
          </For>
        </div>
        <Show when={pageCount() > 1}>
          <div class="border-t border-base-300">
            <PaginationControls
              page={page()}
              pageCount={pageCount()}
              totalItems={filteredSorted().length}
              itemLabel="issue"
              onPrev={() => setPage((p) => Math.max(0, p - 1))}
              onNext={() => setPage((p) => Math.min(pageCount() - 1, p + 1))}
            />
          </div>
        </Show>
      </Show>
    </div>
  );
}
