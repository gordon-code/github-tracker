import { createMemo, createSignal, For, Show } from "solid-js";
import type { JiraIssue } from "../../../shared/jira-types";
import { viewState, setTabFilter, resetAllTabFilters, JiraFiltersSchema, trackItem, untrackJiraItem, setAllExpanded } from "../../stores/view";
import { config } from "../../stores/config";
import { jiraStatusCategoryClass } from "../../lib/format";
import { isSafeJiraSiteUrl } from "../../lib/url";
import PaginationControls from "../shared/PaginationControls";
import FilterPopover from "../shared/FilterPopover";
import LoadingSpinner from "../shared/LoadingSpinner";
import SortDropdown, { type SortOption } from "../shared/SortDropdown";
import ExpandCollapseButtons from "../shared/ExpandCollapseButtons";
import ChevronIcon from "../shared/ChevronIcon";
import RepoLockControls from "../shared/RepoLockControls";

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
  { label: "Priority", field: "priority", type: "number" },
  { label: "Status", field: "status", type: "text" },
  { label: "Key", field: "key", type: "text" },
  { label: "Updated", field: "updated", type: "date" },
];

const PRIORITY_ORDER: Record<string, number> = {
  Highest: 0, High: 1, Medium: 2, Low: 3, Lowest: 4,
};

const STATUS_CATEGORY_ORDER: Record<string, number> = {
  indeterminate: 0, new: 1, done: 2,
};

// Module-level so sort preference persists across tab switches (matches jiraIssues/jiraKeyMap pattern)
const [sortField, setSortField] = createSignal("priority");
const [sortDirection, setSortDirection] = createSignal<"asc" | "desc">("asc");

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
          cmp = (PRIORITY_ORDER[a.fields.priority?.name ?? "Medium"] ?? 2)
            - (PRIORITY_ORDER[b.fields.priority?.name ?? "Medium"] ?? 2);
          break;
        case "status":
          cmp = (STATUS_CATEGORY_ORDER[a.fields.status.statusCategory.key] ?? 1)
            - (STATUS_CATEGORY_ORDER[b.fields.status.statusCategory.key] ?? 1);
          break;
        case "key":
          cmp = a.key.localeCompare(b.key);
          break;
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

  const pageCount = createMemo(() => Math.ceil(filteredSorted().length / ITEMS_PER_PAGE));
  const paginated = createMemo(() => filteredSorted().slice(page() * ITEMS_PER_PAGE, (page() + 1) * ITEMS_PER_PAGE));

  const paginatedGrouped = createMemo(() => {
    const map = new Map<string, JiraIssue[]>();
    for (const issue of paginated()) {
      const key = issue.fields.project?.key ?? "OTHER";
      let group = map.get(key);
      if (!group) { group = []; map.set(key, group); }
      group.push(issue);
    }
    const entries = [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));

    const locked = viewState.lockedRepos[TAB_KEY] ?? [];
    if (locked.length === 0) return entries;

    const lockedSet = new Set(locked);
    const lockedEntries: [string, JiraIssue[]][] = [];
    for (const k of locked) {
      const group = map.get(k);
      if (group) lockedEntries.push([k, group]);
    }
    const unlockedEntries = entries.filter(([k]) => !lockedSet.has(k));
    return [...lockedEntries, ...unlockedEntries];
  });

  const projectKeys = createMemo(() => paginatedGrouped().map(([k]) => k));

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

      <Show when={paginatedGrouped().length > 0}>
        <div class="divide-y divide-base-300">
          <For each={paginatedGrouped()}>
            {([projectKey, issues]) => {
              const isEmpty = () => issues.length === 0;
              const isExpanded = () => !isEmpty() && (viewState.expandedRepos[TAB_KEY]?.[projectKey] ?? true);

              return (
                <div>
                  <div class="group/repo-header flex items-center bg-info/5 border-y border-base-300 hover:bg-info/10 transition-colors">
                    <button
                      onClick={() => setAllExpanded(TAB_KEY, [projectKey], !isExpanded())}
                      aria-expanded={isExpanded()}
                      class="flex-1 flex items-center gap-2 px-4 py-2.5 compact:py-1.5 text-left text-base compact:text-sm font-bold"
                    >
                      <ChevronIcon size="md" rotated={!isExpanded()} />
                      {projectKey}
                      <Show when={!isExpanded() && !isEmpty()}>
                        <span class="ml-auto text-xs font-normal text-base-content/60">
                          {issues.length} issue{issues.length !== 1 ? "s" : ""}
                        </span>
                      </Show>
                    </button>
                    <RepoLockControls repoFullName={projectKey} tabKey={TAB_KEY} />
                  </div>
                  <Show when={isExpanded()}>
                    <div role="list" class="divide-y divide-base-300">
                      <For each={issues}>
                        {(issue) => {
                          const isPinned = () => pinnedJiraKeys().has(issue.key);
                          const browseUrl = () => isSafeJiraSiteUrl(props.siteUrl) ? `${props.siteUrl}/browse/${issue.key}` : "#";
                          return (
                            <div role="listitem" class="px-4 py-3 compact:py-2 flex items-start gap-3 compact:gap-2">
                              <div class="flex-1 min-w-0">
                                <div class="flex items-center gap-2 flex-wrap">
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
                                  <Show when={issue.fields.priority?.name && issue.fields.priority.name !== "Medium" && issue.fields.priority.name !== "Undefined"}>
                                    <span class="badge badge-xs badge-outline text-[10px]">
                                      {issue.fields.priority!.name}
                                    </span>
                                  </Show>
                                </div>
                                <p class="mt-0.5 text-sm compact:text-xs text-base-content truncate" title={issue.fields.summary}>
                                  {issue.fields.summary}
                                </p>
                                <Show when={config.viewDensity !== "compact" && issue.fields.assignee?.displayName}>
                                  <p class="mt-0.5 text-xs text-base-content/50">
                                    {issue.fields.assignee!.displayName}
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
                      No matching issues in {projectKey}
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
