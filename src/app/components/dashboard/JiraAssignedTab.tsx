import { createEffect, createMemo, createSignal, For, Show, on, onCleanup } from "solid-js";
import type { JiraIssue } from "../../../shared/jira-types";
import { viewState, setTabFilter, JiraFiltersSchema, trackItem, untrackJiraItem, setAllExpanded, setJiraCustomOrder, JIRA_CUSTOM_ORDER_SCOPE, JIRA_CUSTOM_SORT_FIELD } from "../../stores/view";
import { config } from "../../stores/config";
import JiraFieldValue from "./JiraFieldValue";
import { jiraStatusCategoryClass, stripParenthetical } from "../../lib/format";
import { isSafeJiraSiteUrl } from "../../lib/url";
import { groupByRepo, computePageLayout, slicePageGroups, ensureLockedRepoGroups, orderRepoGroups, applyCustomOrder } from "../../lib/grouping";
import { withScrollLock } from "../../lib/scroll";
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

const BUILTIN_SCOPE_OPTIONS = [
  { value: "assigned", label: "Assigned to me" },
  { value: "reported", label: "Created by me" },
  { value: "watching", label: "Watching" },
];

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
  { label: "Priority", field: "priority", type: "priority", preferredDirection: "asc" },
  { label: "Status", field: "status", type: "status", preferredDirection: "asc" },
  { label: "Key", field: "key", type: "text", preferredDirection: "asc" },
  { label: "Updated", field: "updated", type: "date" },
  { label: "Created", field: "created", type: "date" },
  { label: "Title", field: "title", type: "text", preferredDirection: "asc" },
];

const PRIORITY_ORDER = Object.assign(Object.create(null) as Record<string, number>, {
  Highest: 0, High: 1, Medium: 2, Low: 3, Lowest: 4,
});

const STATUS_CATEGORY_ORDER = Object.assign(Object.create(null) as Record<string, number>, {
  new: 0, indeterminate: 1, done: 2,
});

// Sub-ordering for indeterminate statuses based on SDLC progression.
// Derived from Red Hat Jira MGMT project workflows + common patterns.
// Unknown statuses get FALLBACK_STATUS_ORDER and sort alphabetically among themselves.
const FALLBACK_STATUS_ORDER = 4;
const STATUS_SDLC_ORDER: Record<string, number> = Object.assign(Object.create(null) as Record<string, number>, {
  "ASSIGNED": 0, "Selected for Development": 0, "Selected to Development": 0,
  "In Progress": 1, "In Development": 1, "Dev In Progress": 1, "Development": 1,
  "Coding In Progress": 1, "Work in progress": 1, "Implementation": 1,
  "Code Review": 2, "Peer Review": 2, "In Review": 2, "Review": 2,
  "Ready for Review": 2, "PR Opened": 2, "Needs Peer Review": 2,
  "Needs Review": 2, "Under Review": 2, "Ready For Review": 2,
  "Dev Complete": 3, "Development Complete": 3, "Feature Complete": 3, "MODIFIED": 3, "Merged": 3,
  "ON_QA": 5, "QA": 5, "In QA": 5, "QA In Progress": 5, "In Test": 5,
  "Testing": 5, "Ready for QA": 5, "Ready for QE": 5, "QE InProgress": 5,
  "In Testing": 5, "QA READY": 5, "QE Verification": 5,
  "Approved": 6, "Pending Approval": 6, "PM Approved": 6, "Story Approved": 6, "POST": 6,
  "Ready for Release": 7, "Release Pending": 7, "Preparing Release": 7,
  "Push Ready": 7, "Ready to Release": 7, "Ready For Release": 7,
  "Blocked": 8, "On Hold/Blocked": 8, "Blocked External": 8, "ENG BLOCKED": 8,
  "Stalled / Blocked": 8, "Blocked/On Hold": 8, "QA Blocked": 8,
});

let _jiraExpandInitialized = false;

export function _resetJiraTabState() {
  _jiraExpandInitialized = false;
  itemRefs.clear();
}

// Test-only accessor for the module-level itemRefs Map (see below) — lets
// tests verify the mode-exit cleanup effect actually clears stale DOM refs
// without exposing itemRefs itself.
export function _getItemRefsCount(): number {
  return itemRefs.size;
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
  const normalized = () => stripParenthetical(props.name);
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

// FLIP animation: record positions before a custom-order move, animate slide after
// DOM updates. Modeled on TrackedTab.tsx's recordPositions/animateMove/prefersReducedMotion
// trio — deliberately duplicated here rather than extracted into a
// shared utility (see plan Task 3, Step 5).
//
// Deviation from TrackedTab.tsx: TrackedTab's animateMove only guards with
// `if (prefersReducedMotion()) return;`, which skips the animation but leaves the
// preceding state mutation unprotected against scroll jump. That guard is kept here too
// (defense-in-depth), but the primary reduced-motion routing decision lives in
// handleCustomMove below, which decides whether to call animateMove at all or route the
// mutation through withScrollLock (src/app/lib/scroll.ts) instead.
const itemRefs = new Map<string, HTMLDivElement>();
const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function recordPositions(keys: string[]): Map<string, DOMRect> {
  const snapshot = new Map<string, DOMRect>();
  for (const key of keys) {
    const el = itemRefs.get(key);
    if (el) snapshot.set(key, el.getBoundingClientRect());
  }
  return snapshot;
}

function animateMove(before: Map<string, DOMRect>, keys: string[]) {
  if (prefersReducedMotion()) return;
  requestAnimationFrame(() => {
    for (const key of keys) {
      const el = itemRefs.get(key);
      if (!el) continue;
      const old = before.get(key);
      if (!old) continue;
      const now = el.getBoundingClientRect();
      const dy = old.top - now.top;
      if (Math.abs(dy) < 1) continue;
      el.animate(
        [{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }],
        { duration: 200, easing: "ease-in-out" }
      );
    }
  });
}

export default function JiraAssignedTab(props: JiraAssignedTabProps) {
  const [page, setPage] = createSignal(0);

  const filters = createMemo(() => viewState.tabFilters.jiraAssigned ?? JIRA_FILTER_DEFAULTS);

  const scopeOptions = createMemo(() => [
    ...BUILTIN_SCOPE_OPTIONS,
    ...(config.jira?.customScopes ?? []).map((s) => ({ value: s.id, label: s.name })),
  ]);

  // Stale scope guard: reset to "assigned" if active scope was removed from custom scopes
  createEffect(() => {
    const validValues = new Set(scopeOptions().map((o) => o.value));
    if (!validValues.has(filters().scope)) {
      setTabFilter("jiraAssigned", "scope", "assigned");
    }
  });

  const [toggledIssues, setToggledIssues] = createSignal<Set<string>>(new Set());

  // Reset toggled state when scope changes
  createEffect(on(() => filters().scope, () => setToggledIssues(new Set<string>()), { defer: true }));

  function toggleExpanded(key: string) {
    setToggledIssues((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  const expandByDefault = () => !!(config.jira?.expandIssueDetails);

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
      if (f.priority !== "all" && stripParenthetical(issue.fields.priority?.name ?? "") !== f.priority) return false;
      return true;
    });
  });

  const filteredSorted = createMemo(() => {
    if (filters().sortField === JIRA_CUSTOM_SORT_FIELD) {
      return applyCustomOrder(filtered(), viewState.jiraCustomOrder, (issue) => issue.key);
    }
    const items = [...filtered()];
    const field = filters().sortField;
    const dir = filters().sortDirection;
    items.sort((a, b) => {
      let cmp = 0;
      switch (field) {
        case "priority":
          cmp = (PRIORITY_ORDER[stripParenthetical(a.fields.priority?.name ?? "Medium")] ?? 2)
            - (PRIORITY_ORDER[stripParenthetical(b.fields.priority?.name ?? "Medium")] ?? 2);
          break;
        case "status": {
          const aCat = STATUS_CATEGORY_ORDER[a.fields.status.statusCategory.key] ?? 1;
          const bCat = STATUS_CATEGORY_ORDER[b.fields.status.statusCategory.key] ?? 1;
          cmp = aCat - bCat;
          if (cmp === 0) {
            const aSub = STATUS_SDLC_ORDER[a.fields.status.name] ?? FALLBACK_STATUS_ORDER;
            const bSub = STATUS_SDLC_ORDER[b.fields.status.name] ?? FALLBACK_STATUS_ORDER;
            cmp = aSub - bSub;
            if (cmp === 0) cmp = a.fields.status.name.localeCompare(b.fields.status.name);
          }
          break;
        }
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
        case "created": {
          const aCr = String(a.fields.created ?? "");
          const bCr = String(b.fields.created ?? "");
          cmp = aCr < bCr ? -1 : aCr > bCr ? 1 : 0;
          break;
        }
        case "title":
          cmp = a.fields.summary.localeCompare(b.fields.summary);
          break;
        default:
          break;
      }
      return dir === "asc" ? cmp : -cmp;
    });
    return items;
  });

  type JiraItem = JiraIssue & { repoFullName: string };

  // Cache wrapper objects by issue key so that a reorder (same JiraIssue references,
  // new array order) reuses the SAME JiraItem object per issue.  This preserves
  // reference equality for <For>'s keyed reconciliation, letting it move DOM nodes
  // instead of tearing down / rebuilding every row on each arrow-click (Finding 4).
  const itemsWithGroupKeyCache = new Map<string, { source: JiraIssue; wrapped: JiraItem }>();
  const itemsWithGroupKey = createMemo(() => {
    const result = filteredSorted().map((issue): JiraItem => {
      const cached = itemsWithGroupKeyCache.get(issue.key);
      if (cached && cached.source === issue) return cached.wrapped;
      const wrapped: JiraItem = { ...issue, repoFullName: issue.fields.project?.key ?? "OTHER" };
      itemsWithGroupKeyCache.set(issue.key, { source: issue, wrapped });
      return wrapped;
    });
    // Prune stale cache entries for issues that left the list (e.g. after a data
    // refresh or filter change).  The cache naturally self-limits to the active issue
    // count (capped at ~500 elsewhere in the ecosystem), so this is a hygiene measure
    // rather than a hard cap.
    if (itemsWithGroupKeyCache.size > result.length) {
      const activeKeys = new Set(result.map(item => item.key));
      for (const key of itemsWithGroupKeyCache.keys()) {
        if (!activeKeys.has(key)) itemsWithGroupKeyCache.delete(key);
      }
    }
    return result;
  });

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

  const isCustomMode = () => filters().sortField === JIRA_CUSTOM_SORT_FIELD;

  // itemsWithGroupKey() is a 1:1, order-preserving map over filteredSorted() (adds
  // repoFullName, never filters/reorders), so paginating it directly yields the same
  // slices filteredSorted() would, while giving renderIssueRow's shared JiraItem rows
  // the project key it needs for the Step 4 badge without re-deriving it.
  //
  // Both are createMemo (not plain arrow functions) because customPageItems is called
  // 3+ times per render and does a real .slice() each time (Finding 1).
  const customPageCount = createMemo(() => Math.max(1, Math.ceil(itemsWithGroupKey().length / ITEMS_PER_PAGE)));
  const customPageItems = createMemo(() => itemsWithGroupKey().slice(page() * ITEMS_PER_PAGE, (page() + 1) * ITEMS_PER_PAGE));

  // Prune itemRefs to current-page items in custom mode so the map does not grow
  // unbounded across pages, filter changes, and data refreshes (Finding 2 & 3).
  createEffect(() => {
    if (!isCustomMode()) {
      itemRefs.clear();
      return;
    }
    const pageItemKeys = new Set(customPageItems().map(item => item.key));
    for (const key of itemRefs.keys()) {
      if (!pageItemKeys.has(key)) itemRefs.delete(key);
    }
  });

  const pageLayout = createMemo(() => computePageLayout(repoGroups(), ITEMS_PER_PAGE));
  const pageCount = createMemo(() => (isCustomMode() ? customPageCount() : pageLayout().pageCount));
  const pageGroups = createMemo(() =>
    slicePageGroups(repoGroups(), pageLayout().boundaries, pageLayout().pageCount, page())
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

  // Reordering is only meaningful — and safe — against the canonical, unfiltered
  // "assigned" scope: filtered() must exclude nothing so filteredSorted()'s key list
  // is the complete set, matching what Task 4's prune gate guards against.
  const canReorder = () =>
    filters().scope === JIRA_CUSTOM_ORDER_SCOPE && filters().statusCategory === "all" && filters().priority === "all";

  const [reordering, setReordering] = createSignal(false);
  let reorderTimeoutId: ReturnType<typeof setTimeout> | undefined;

  // Clear the module-level itemRefs map when the component unmounts (e.g. tab
  // switch) so detached DOM references are not leaked across mount cycles.
  // Also clear any pending reordering-lockout timeout so it doesn't fire
  // setReordering on a disposed component after a tab switch mid-lockout.
  onCleanup(() => {
    itemRefs.clear();
    clearTimeout(reorderTimeoutId);
  });

  function handleCustomMove(jiraKey: string, direction: "up" | "down") {
    if (!canReorder()) return;
    if (reordering()) return;
    const order = filteredSorted().map((i) => i.key);
    const idx = order.indexOf(jiraKey);
    if (idx === -1) return;
    const targetIdx = direction === "up" ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= order.length) return;
    const newPage = Math.floor(targetIdx / ITEMS_PER_PAGE);
    const crossesPage = newPage !== page();
    const next = [...order];
    [next[idx], next[targetIdx]] = [next[targetIdx], next[idx]];
    const applyMove = () => {
      setJiraCustomOrder(next);
      if (crossesPage) setPage(newPage);
    };
    setReordering(true);
    if (prefersReducedMotion()) {
      // Reduced motion: no animation ever, but still guard against a viewport jump
      // from the mutation itself (matches withFlipAnimation's reduced-motion fallback in scroll.ts).
      withScrollLock(applyMove);
    } else if (crossesPage) {
      // Cross-page moves must skip the FLIP animation entirely (spike pl-feas-2): the
      // old page's rows become detached before animateMove's rAF callback runs, producing
      // a broken/misleading animation. Jump straight to the new page instead.
      applyMove();
    } else {
      const pageKeys = customPageItems().map(i => i.key);
      const before = recordPositions(pageKeys);
      applyMove();
      animateMove(before, pageKeys);
    }
    // Uniform 200ms lockout across all branches — prevents rapid clicks / key-repeat
    // from queuing moves in the reduced-motion and cross-page paths where the lockout
    // was previously reset synchronously (Finding 5).  Value matches animateMove's
    // `duration: 200` — keep them in sync.
    reorderTimeoutId = setTimeout(() => setReordering(false), 200);
  }

  function renderIssueRow(issue: JiraItem, boundary?: { isFirst: boolean; isLast: boolean }) {
    const isPinned = () => pinnedJiraKeys().has(issue.key);
    const browseUrl = () => isSafeJiraSiteUrl(props.siteUrl) ? `${props.siteUrl}/browse/${issue.key}` : "#";
    const isIssueExpanded = () => expandByDefault() ? !toggledIssues().has(issue.key) : toggledIssues().has(issue.key);
    const detailPanelId = `jira-detail-${issue.key}`;
    const reorderTitle = () => !canReorder() ? "Switch to Assigned to me with no filters to reorder" : undefined;
    return (
      <div
        role="listitem"
        class="flex items-stretch"
        ref={(el) => { if (isCustomMode()) itemRefs.set(issue.key, el); }}
      >
        <Show when={isCustomMode()}>
          <div class="flex flex-col shrink-0 justify-center gap-0.5 pl-2 compact:pl-1">
            <button
              type="button"
              class="btn btn-ghost btn-xs compact:min-h-0 compact:h-6 compact:w-7 compact:px-0"
              disabled={!canReorder() || reordering() || !!boundary?.isFirst}
              aria-label={`Move up: ${issue.key}`}
              title={reorderTitle()}
              onClick={() => handleCustomMove(issue.key, "up")}
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="h-4 w-4">
                <path fill-rule="evenodd" d="M14.77 12.79a.75.75 0 01-1.06-.02L10 8.832 6.29 12.77a.75.75 0 11-1.08-1.04l4.25-4.5a.75.75 0 011.08 0l4.25 4.5a.75.75 0 01-.02 1.06z" clip-rule="evenodd" />
              </svg>
            </button>
            <button
              type="button"
              class="btn btn-ghost btn-xs compact:min-h-0 compact:h-6 compact:w-7 compact:px-0"
              disabled={!canReorder() || reordering() || !!boundary?.isLast}
              aria-label={`Move down: ${issue.key}`}
              title={reorderTitle()}
              onClick={() => handleCustomMove(issue.key, "down")}
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="h-4 w-4">
                <path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd" />
              </svg>
            </button>
          </div>
        </Show>
        <div class="flex-1 min-w-0">
          <div
            class={`px-4 py-3 compact:py-2 flex items-start gap-3 compact:gap-2 cursor-pointer hover:bg-base-200/50 transition-colors ${isIssueExpanded() ? "pb-1 compact:pb-0.5" : ""}`}
            onClick={(e) => {
              if ((e.target as HTMLElement).closest("a, button")) return;
              toggleExpanded(issue.key);
            }}
          >
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 min-w-0">
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
                <Show when={isCustomMode()}>
                  <span class="badge badge-xs badge-ghost text-[10px]">{issue.repoFullName}</span>
                </Show>
                <Show when={config.viewDensity === "compact"}>
                  <span class="flex-1 min-w-0 text-xs text-base-content truncate" title={issue.fields.summary}>
                    {issue.fields.summary}
                  </span>
                </Show>
              </div>
              <Show when={config.viewDensity !== "compact"}>
                <p class="mt-0.5 ml-6 text-sm text-base-content truncate" title={issue.fields.summary}>
                  {issue.fields.summary}
                </p>
              </Show>
            </div>
            <div class="flex items-center gap-1.5 shrink-0">
              <Show when={issue.fields.priority?.name && stripParenthetical(issue.fields.priority.name) !== "Medium" && issue.fields.priority.name !== "Undefined"}>
                <span class="badge badge-xs badge-outline text-[10px]">
                  {stripParenthetical(issue.fields.priority!.name)}
                </span>
              </Show>
              <span
                class={`badge badge-xs ${jiraStatusCategoryClass(issue.fields.status.statusCategory.key)}`}
              >
                {issue.fields.status.name}
              </span>
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
            <button
              type="button"
              class="shrink-0 self-center rounded p-1 transition-colors text-base-content/30 hover:text-base-content focus:outline-none focus:ring-2 focus:ring-primary"
              aria-label={isIssueExpanded() ? `Collapse ${issue.key} details` : `Expand ${issue.key} details`}
              aria-expanded={isIssueExpanded()}
              aria-controls={detailPanelId}
              onClick={() => toggleExpanded(issue.key)}
            >
              <ChevronIcon size="sm" rotated={!isIssueExpanded()} />
            </button>
          </div>
          <Show when={isIssueExpanded()}>
            <div
              id={detailPanelId}
              role="region"
              aria-label={`${issue.key} custom fields`}
              class="pl-14 compact:pl-10 pb-2 pt-0.5 compact:pb-1 pr-4"
            >
              <Show
                when={(config.jira?.customFields ?? []).length > 0}
                fallback={
                  <p class="text-xs text-base-content/40 italic">
                    No custom fields configured — add them in Settings.
                  </p>
                }
              >
                <div class="flex flex-wrap gap-1.5 compact:gap-1">
                  <For each={config.jira?.customFields ?? []}>
                    {(field) => {
                      const val = () => (issue.fields as Record<string, unknown>)[field.id];
                      return (
                        <Show when={val() !== null && val() !== undefined}>
                          <span class="inline-flex items-center gap-1 rounded-full bg-base-300 px-2.5 py-0.5 compact:px-2 compact:py-px text-xs" title={field.name}>
                            <span class="text-base-content/70 font-medium">{field.name}:</span>
                            <JiraFieldValue value={val()} />
                          </span>
                        </Show>
                      );
                    }}
                  </For>
                </div>
              </Show>
            </div>
          </Show>
        </div>
      </div>
    );
  }

  return (
    <div class="flex flex-col h-full">
      {/* Filter + sort toolbar */}
      <div class="border-b border-base-300 px-4 py-2 compact:py-0.5 flex items-center gap-2 compact:gap-1.5 flex-wrap">
        <FilterPopover
          group={{
            field: "scope",
            label: "Scope",
            options: scopeOptions(),
            defaultValue: "assigned",
          }}
          value={filters().scope}
          onChange={(field, value) => {
            setTabFilter("jiraAssigned", field as "scope", value);
            setPage(0);
          }}
        />
        <span class="text-base-content/30">|</span>
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
            onClick={() => {
              setTabFilter("jiraAssigned", "statusCategory", "all");
              setTabFilter("jiraAssigned", "priority", "all");
              setPage(0);
            }}
          >
            Clear
          </button>
        </Show>
        <div class="ml-auto flex items-center gap-2">
          <span class="text-xs text-base-content/50">
            {filtered().length} issue{filtered().length !== 1 ? "s" : ""}
          </span>
          <Show when={!isCustomMode()}>
            <button
              type="button"
              class="btn btn-ghost btn-xs"
              onClick={() => {
                setTabFilter("jiraAssigned", "sortField", JIRA_CUSTOM_SORT_FIELD);
                setPage(0);
              }}
            >
              ↺ Custom order
            </button>
          </Show>
          <SortDropdown
            options={JIRA_SORT_OPTIONS}
            value={filters().sortField}
            direction={filters().sortDirection}
            placeholder={isCustomMode() ? "Custom order" : "Sort by"}
            onChange={(field, dir) => {
              setTabFilter("jiraAssigned", "sortField", field);
              setTabFilter("jiraAssigned", "sortDirection", dir);
              setPage(0);
            }}
          />
          <Show when={!isCustomMode()}>
            <ExpandCollapseButtons
              onExpandAll={() => setAllExpanded(TAB_KEY, projectKeys(), true)}
              onCollapseAll={() => setAllExpanded(TAB_KEY, projectKeys(), false)}
            />
          </Show>
        </div>
      </div>

      <Show when={props.loading && props.issues.length === 0}>
        <div class="flex justify-center py-12">
          <LoadingSpinner size="md" label="Loading Jira issues..." />
        </div>
      </Show>

      {/* Jira project groups + locked stubs, or flat custom-ordered list */}
      <Show when={isCustomMode() ? customPageItems().length > 0 : pageGroups().length > 0}>
        <Show
          when={isCustomMode()}
          fallback={
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
                            {(issue) => renderIssueRow(issue)}
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
          }
        >
          <div role="list" class="divide-y divide-base-300">
            <For each={customPageItems()}>
              {(issue, index) =>
                renderIssueRow(issue, {
                  isFirst: page() === 0 && index() === 0,
                  isLast: page() === pageCount() - 1 && index() === customPageItems().length - 1,
                })
              }
            </For>
          </div>
        </Show>
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

      {/* Empty state — shown when no actual items, whether or not locked stubs appear above */}
      <Show when={!props.loading && filtered().length === 0}>
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
            {(filters().statusCategory !== "all" || filters().priority !== "all")
              ? "No issues match current filters"
              : (() => {
                  const opt = scopeOptions().find((o) => o.value === filters().scope);
                  return `No ${opt?.label ?? "Assigned to me"} Jira issues`;
                })()}
          </p>
          <p class="text-xs">
            {(filters().statusCategory !== "all" || filters().priority !== "all")
              ? "Try adjusting your status or priority filters."
              : "Issues matching your current scope will appear here."}
          </p>
        </div>
      </Show>
    </div>
  );
}
