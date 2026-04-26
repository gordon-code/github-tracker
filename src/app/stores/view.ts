import { z } from "zod";
import { createStore, produce } from "solid-js/store";
import { createEffect, onCleanup, untrack } from "solid-js";
import { pushNotification } from "../lib/errors";

export const VIEW_STORAGE_KEY = "github-tracker:view";
const IGNORED_ITEMS_CAP = 500;
const TRACKED_ITEMS_CAP = 200;
export const LOCKED_REPOS_CAP = 50;

export const TrackedItemSchema = z.object({
  id: z.number(),
  number: z.number().optional(),
  type: z.enum(["issue", "pullRequest", "jiraIssue"]),
  source: z.enum(["github", "jira"]).default("github"),
  repoFullName: z.string(),
  title: z.string(),
  addedAt: z.number(),
  jiraKey: z.string().optional(),
  jiraProjectKey: z.string().optional(),
  jiraStatus: z.string().optional(),
  htmlUrl: z.string().optional(),
});

export type TrackedItem = z.infer<typeof TrackedItemSchema>;

export const IssueFiltersSchema = z.object({
  scope: z.enum(["involves_me", "all"]).default("involves_me"),
  role: z.enum(["all", "author", "assignee"]).default("all"),
  comments: z.enum(["all", "has", "none"]).default("all"),
  user: z.enum(["all"]).or(z.string()).default("all"),
});

export const PullRequestFiltersSchema = z.object({
  scope: z.enum(["involves_me", "all"]).default("involves_me"),
  role: z.enum(["all", "author", "reviewer", "assignee"]).default("all"),
  reviewDecision: z.enum(["all", "APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED", "mergeable"]).default("all"),
  draft: z.enum(["all", "draft", "ready"]).default("all"),
  checkStatus: z.enum(["all", "success", "failure", "pending", "conflict", "blocked", "none"]).default("all"),
  sizeCategory: z.enum(["all", "XS", "S", "M", "L", "XL", "XXL"]).default("all"),
  user: z.enum(["all"]).or(z.string()).default("all"),
});

export const ActionsFiltersSchema = z.object({
  conclusion: z.enum(["all", "success", "failure", "cancelled", "running", "other"]).default("all"),
  event: z.enum(["all", "push", "pull_request", "schedule", "workflow_dispatch", "other"]).default("all"),
});

// "done" intentionally excluded — JQL `statusCategory != Done` never returns Done items
export const JiraFiltersSchema = z.object({
  scope: z.enum(["assigned", "reported", "watching"]).default("assigned"),
  statusCategory: z.enum(["all", "new", "indeterminate"]).default("all"),
  priority: z.enum(["all", "Highest", "High", "Medium", "Low", "Lowest"]).default("all"),
  sortField: z.string().default("status"),
  sortDirection: z.enum(["asc", "desc"]).default("asc"),
});

export type IssueFilters = z.infer<typeof IssueFiltersSchema>;
export type IssueFilterField = keyof IssueFilters;
export type PullRequestFilters = z.infer<typeof PullRequestFiltersSchema>;
export type PullRequestFilterField = keyof PullRequestFilters;
export type ActionsFilters = z.infer<typeof ActionsFiltersSchema>;
export type ActionsFilterField = keyof ActionsFilters;
export type JiraFilters = z.infer<typeof JiraFiltersSchema>;
export type JiraFilterField = keyof JiraFilters;

export const ViewStateSchema = z.object({
  lastActiveTab: z.string().default("issues"),
  globalSort: z.object({
    field: z.string(),
    direction: z.enum(["asc", "desc"]),
  }).default({ field: "updatedAt", direction: "desc" }),
  ignoredItems: z
    .array(
      z.object({
        id: z.coerce.number(),
        type: z.enum(["issue", "pullRequest", "workflowRun"]),
        repo: z.string(),
        title: z.string(),
        ignoredAt: z.number(),
      })
    )
    .max(IGNORED_ITEMS_CAP)
    .default([]),
  globalFilter: z
    .object({
      org: z.string().nullable().default(null),
      repo: z.string().nullable().default(null),
    })
    .default({ org: null, repo: null }),
  tabFilters: z.object({
    issues: IssueFiltersSchema.default({ scope: "involves_me", role: "all", comments: "all", user: "all" }),
    pullRequests: PullRequestFiltersSchema.default({ scope: "involves_me", role: "all", reviewDecision: "all", draft: "all", checkStatus: "all", sizeCategory: "all", user: "all" }),
    actions: ActionsFiltersSchema.default({ conclusion: "all", event: "all" }),
    jiraAssigned: JiraFiltersSchema.default({ scope: "assigned", statusCategory: "all", priority: "all", sortField: "status", sortDirection: "asc" }),
  }).default({
    issues: { scope: "involves_me", role: "all", comments: "all", user: "all" },
    pullRequests: { scope: "involves_me", role: "all", reviewDecision: "all", draft: "all", checkStatus: "all", sizeCategory: "all", user: "all" },
    actions: { conclusion: "all", event: "all" },
    jiraAssigned: { scope: "assigned", statusCategory: "all", priority: "all", sortField: "status", sortDirection: "asc" },
  }),
  showPrRuns: z.boolean().default(false),
  hideDepDashboard: z.boolean().default(true),
  customTabFilters: z.record(
    z.string(),
    z.record(z.string(), z.string())
  ).default({}),
  expandedRepos: z.record(
    z.string(),
    z.record(z.string(), z.boolean()).default({})
  ).default({
    issues: {},
    pullRequests: {},
    actions: {},
    jiraAssigned: {},
  }),
  lockedRepos: z.record(z.string(), z.array(z.string().max(200)).max(LOCKED_REPOS_CAP)).default({ issues: [], pullRequests: [], actions: [], jiraAssigned: [] }),
  trackedItems: z.array(TrackedItemSchema).max(TRACKED_ITEMS_CAP).default([]),
});

export type ViewState = z.infer<typeof ViewStateSchema>;
export type IgnoredItem = ViewState["ignoredItems"][number];

const REPO_STATE_TAB_IDS = ["issues", "pullRequests", "actions", "jiraAssigned"] as const;

export function migrateLockedRepos(raw: unknown): unknown {
  if (raw == null) return { issues: [], pullRequests: [], actions: [], jiraAssigned: [] };
  if (Array.isArray(raw)) {
    // Flat array → copy to all built-in tabs
    const arr = raw.filter((item): item is string => typeof item === "string").slice(0, LOCKED_REPOS_CAP);
    return { issues: [...arr], pullRequests: [...arr], actions: [...arr], jiraAssigned: [] };
  }
  if (typeof raw === "object") {
    // Object → pass through as-is; loadViewState cap-guard sanitizes malformed entries
    return raw;
  }
  return { issues: [], pullRequests: [], actions: [], jiraAssigned: [] };
}

function loadViewState(): ViewState {
  try {
    const raw = localStorage.getItem(VIEW_STORAGE_KEY);
    if (raw === null) return ViewStateSchema.parse({});
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return ViewStateSchema.parse({});
    }
    const obj = parsed as Record<string, unknown>;
    obj.lockedRepos = migrateLockedRepos(obj.lockedRepos);
    // Cap lockedRepos entries before Zod validates — a corrupt or oversized entry would
    // fail .max(LOCKED_REPOS_CAP) and reject the ENTIRE ViewState, wiping all settings.
    if (typeof obj.lockedRepos === "object" && obj.lockedRepos !== null && !Array.isArray(obj.lockedRepos)) {
      const record = obj.lockedRepos as Record<string, unknown>;
      for (const [key, val] of Object.entries(record)) {
        if (!Array.isArray(val)) {
          delete record[key];
        } else {
          const filtered = val.filter((item): item is string => typeof item === "string");
          record[key] = filtered.length > LOCKED_REPOS_CAP ? filtered.slice(0, LOCKED_REPOS_CAP) : filtered;
        }
      }
    }
    const result = ViewStateSchema.safeParse(parsed);
    if (result.success) return result.data;
    return ViewStateSchema.parse({});
  } catch {
    return ViewStateSchema.parse({});
  }
}

export const [viewState, setViewState] = createStore<ViewState>(
  loadViewState()
);

export function resetViewState(): void {
  setViewState(
    produce((draft) => {
      // Delete dynamic custom tab keys that Object.assign wouldn't clear
      for (const key of Object.keys(draft.expandedRepos)) {
        if (!(REPO_STATE_TAB_IDS as readonly string[]).includes(key)) {
          delete draft.expandedRepos[key];
        }
      }
      for (const key of Object.keys(draft.customTabFilters)) {
        delete draft.customTabFilters[key];
      }
      for (const key of Object.keys(draft.lockedRepos)) {
        if (!(REPO_STATE_TAB_IDS as readonly string[]).includes(key)) {
          delete draft.lockedRepos[key];
        }
      }
      Object.assign(draft, {
        lastActiveTab: "issues",
        globalSort: { field: "updatedAt", direction: "desc" },
        ignoredItems: [],
        globalFilter: { org: null, repo: null },
        tabFilters: {
          issues: { scope: "involves_me", role: "all", comments: "all", user: "all" },
          pullRequests: { scope: "involves_me", role: "all", reviewDecision: "all", draft: "all", checkStatus: "all", sizeCategory: "all", user: "all" },
          actions: { conclusion: "all", event: "all" },
          jiraAssigned: { scope: "assigned", statusCategory: "all", priority: "all", sortField: "status", sortDirection: "asc" },
        },
        showPrRuns: false,
        hideDepDashboard: true,
        customTabFilters: {},
        expandedRepos: { issues: {}, pullRequests: {}, actions: {}, jiraAssigned: {} },
        lockedRepos: { issues: [], pullRequests: [], actions: [], jiraAssigned: [] },
        trackedItems: [],
      });
    })
  );
}

export function updateViewState(partial: Partial<ViewState>): void {
  setViewState(
    produce((draft) => {
      Object.assign(draft, partial);
    })
  );
}

export function ignoreItem(item: IgnoredItem): void {
  setViewState(
    produce((draft) => {
      const already = draft.ignoredItems.some((i) => i.id === item.id);
      if (!already) {
        // FIFO eviction: remove oldest if at cap
        if (draft.ignoredItems.length >= IGNORED_ITEMS_CAP) {
          draft.ignoredItems.shift();
        }
        draft.ignoredItems.push(item);
      }
    })
  );
}

export function unignoreItem(id: number): void {
  setViewState(
    produce((draft) => {
      draft.ignoredItems = draft.ignoredItems.filter((i) => i.id !== id);
    })
  );
}

export function pruneStaleIgnoredItems(): void {
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  setViewState(
    produce((draft) => {
      draft.ignoredItems = draft.ignoredItems.filter(
        (i) => i.ignoredAt > thirtyDaysAgo
      );
    })
  );
}

export function setSortPreference(
  field: string,
  direction: "asc" | "desc"
): void {
  setViewState(
    produce((draft) => {
      draft.globalSort = { field, direction };
    })
  );
}

export function setGlobalFilter(
  org: string | null,
  repo: string | null
): void {
  setViewState(
    produce((draft) => {
      draft.globalFilter = { org, repo };
    })
  );
}

type TabFilterField = {
  issues: keyof IssueFilters;
  pullRequests: keyof PullRequestFilters;
  actions: keyof ActionsFilters;
  jiraAssigned: keyof JiraFilters;
};

export function setTabFilter<T extends keyof TabFilterField>(
  tab: T,
  field: TabFilterField[T],
  value: string
): void {
  setViewState(
    produce((draft) => {
      (draft.tabFilters[tab] as Record<string, string>)[field as string] = value;
    })
  );
}

export function resetAllTabFilters(
  tab: "issues" | "pullRequests" | "actions" | "jiraAssigned"
): void {
  setViewState(
    produce((draft) => {
      if (tab === "issues") {
        draft.tabFilters.issues = IssueFiltersSchema.parse({});
      } else if (tab === "pullRequests") {
        draft.tabFilters.pullRequests = PullRequestFiltersSchema.parse({});
      } else if (tab === "jiraAssigned") {
        draft.tabFilters.jiraAssigned = JiraFiltersSchema.parse({});
      } else {
        draft.tabFilters.actions = ActionsFiltersSchema.parse({});
      }
    })
  );
}

export function toggleExpandedRepo(
  tab: string,
  repoFullName: string
): void {
  setViewState(
    produce((draft) => {
      if (!draft.expandedRepos[tab]) draft.expandedRepos[tab] = {};
      if (draft.expandedRepos[tab][repoFullName]) {
        delete draft.expandedRepos[tab][repoFullName];
      } else {
        draft.expandedRepos[tab][repoFullName] = true;
      }
    })
  );
}

export function setAllExpanded(
  tab: string,
  repoFullNames: string[],
  expanded: boolean
): void {
  setViewState(
    produce((draft) => {
      if (!draft.expandedRepos[tab]) draft.expandedRepos[tab] = {};
      if (expanded) {
        for (const name of repoFullNames) {
          draft.expandedRepos[tab][name] = true;
        }
      } else {
        for (const name of repoFullNames) {
          delete draft.expandedRepos[tab][name];
        }
      }
    })
  );
}

export function pruneExpandedRepos(
  tab: string,
  activeRepoNames: string[]
): void {
  const currentKeys = untrack(() => Object.keys(viewState.expandedRepos[tab] ?? {}));
  if (currentKeys.length === 0) return;
  const activeSet = new Set(activeRepoNames);
  const staleKeys = currentKeys.filter((k) => !activeSet.has(k));
  if (staleKeys.length === 0) return;
  setViewState(
    produce((draft) => {
      if (!draft.expandedRepos[tab]) return;
      for (const key of staleKeys) {
        delete draft.expandedRepos[tab][key];
      }
    })
  );
}

export function setCustomTabFilter(tabId: string, field: string, value: string): void {
  setViewState(
    produce((draft) => {
      if (!draft.customTabFilters[tabId]) draft.customTabFilters[tabId] = {};
      draft.customTabFilters[tabId][field] = value;
    })
  );
}

export function resetCustomTabFilters(tabId: string): void {
  setViewState(
    produce((draft) => {
      draft.customTabFilters[tabId] = {};
    })
  );
}

export function removeCustomTabState(tabId: string): void {
  setViewState(
    produce((draft) => {
      delete draft.customTabFilters[tabId];
      delete draft.expandedRepos[tabId];
      delete draft.lockedRepos[tabId];
    })
  );
}

export function lockRepo(tabKey: string, repoFullName: string): void {
  setViewState(
    produce((draft) => {
      if (!draft.lockedRepos[tabKey]) draft.lockedRepos[tabKey] = [];
      const arr = draft.lockedRepos[tabKey];
      if (!arr.includes(repoFullName) && arr.length < LOCKED_REPOS_CAP) {
        arr.push(repoFullName);
      }
    })
  );
}

export function unlockRepo(tabKey: string, repoFullName: string): void {
  setViewState(
    produce((draft) => {
      if (!draft.lockedRepos[tabKey]) return;
      draft.lockedRepos[tabKey] = draft.lockedRepos[tabKey].filter((r) => r !== repoFullName);
    })
  );
}

export function moveLockedRepo(
  tabKey: string,
  repoFullName: string,
  direction: "up" | "down"
): void {
  setViewState(
    produce((draft) => {
      if (!draft.lockedRepos[tabKey]) return;
      const arr = draft.lockedRepos[tabKey];
      const idx = arr.indexOf(repoFullName);
      if (idx === -1) return;
      const targetIdx = direction === "up" ? idx - 1 : idx + 1;
      if (targetIdx < 0 || targetIdx >= arr.length) return;
      const tmp = arr[idx];
      arr[idx] = arr[targetIdx];
      arr[targetIdx] = tmp;
    })
  );
}

export function pruneLockedRepos(
  tabKey: string,
  activeRepoNames: string[]
): void {
  const current = untrack(() => viewState.lockedRepos[tabKey] ?? []);
  if (current.length === 0) return;
  const activeSet = new Set(activeRepoNames);
  const filtered = current.filter((name) => activeSet.has(name));
  if (filtered.length === current.length) return;
  setViewState(
    produce((draft) => {
      draft.lockedRepos[tabKey] = filtered;
    })
  );
}

export function trackItem(item: TrackedItem): void {
  setViewState(
    produce((draft) => {
      // Jira items dedup by jiraKey (not id) — hash collisions are possible with 32-bit hash
      const already = draft.trackedItems.some((i) =>
        item.source === "jira"
          ? i.source === "jira" && i.jiraKey === item.jiraKey
          : i.id === item.id && i.type === item.type
      );
      if (!already) {
        // FIFO eviction: remove oldest if at cap
        if (draft.trackedItems.length >= TRACKED_ITEMS_CAP) {
          draft.trackedItems.shift();
        }
        draft.trackedItems.push(item);
      }
    })
  );
}

export function untrackJiraItem(jiraKey: string): void {
  setViewState(
    produce((draft) => {
      draft.trackedItems = draft.trackedItems.filter(
        (i) => !(i.source === "jira" && i.jiraKey === jiraKey)
      );
    })
  );
}

export function moveJiraItem(jiraKey: string, direction: "up" | "down"): void {
  setViewState(
    produce((draft) => {
      const arr = draft.trackedItems;
      const idx = arr.findIndex((i) => i.source === "jira" && i.jiraKey === jiraKey);
      if (idx === -1) return;
      const targetIdx = direction === "up" ? idx - 1 : idx + 1;
      if (targetIdx < 0 || targetIdx >= arr.length) return;
      const tmp = arr[idx];
      arr[idx] = arr[targetIdx];
      arr[targetIdx] = tmp;
    })
  );
}

export function untrackItem(id: number, type: "issue" | "pullRequest"): void {
  setViewState(
    produce((draft) => {
      draft.trackedItems = draft.trackedItems.filter(
        (i) => !(i.id === id && i.type === type)
      );
    })
  );
}

export function moveTrackedItem(
  id: number,
  type: "issue" | "pullRequest",
  direction: "up" | "down"
): void {
  setViewState(
    produce((draft) => {
      const arr = draft.trackedItems;
      const idx = arr.findIndex((i) => i.id === id && i.type === type);
      if (idx === -1) return;
      const targetIdx = direction === "up" ? idx - 1 : idx + 1;
      if (targetIdx < 0 || targetIdx >= arr.length) return;
      const tmp = arr[idx];
      arr[idx] = arr[targetIdx];
      arr[targetIdx] = tmp;
    })
  );
}

export function pruneClosedTrackedItems(pruneKeys: Set<string>): void {
  setViewState(
    produce((draft) => {
      draft.trackedItems = draft.trackedItems.filter(
        (i) => !pruneKeys.has(`${i.type}:${i.id}`)
      );
    })
  );
}

export function initViewPersistence(): void {
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingJson: string | undefined;
  createEffect(() => {
    const json = JSON.stringify(viewState); // synchronous read → tracked by SolidJS
    pendingJson = json;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      pendingJson = undefined;
      try {
        localStorage.setItem(VIEW_STORAGE_KEY, json);
      } catch {
        pushNotification("localStorage:view", "View state write failed — storage may be full", "warning");
      }
    }, 200);
    onCleanup(() => {
      clearTimeout(debounceTimer);
      // Flush pending write synchronously so HMR doesn't lose state
      if (pendingJson !== undefined) {
        try { localStorage.setItem(VIEW_STORAGE_KEY, pendingJson); } catch { /* best-effort */ }
        pendingJson = undefined;
      }
    });
  });
}
