import { z } from "zod";
import { createStore, produce } from "solid-js/store";
import { createEffect, onCleanup, untrack } from "solid-js";
import { pushNotification } from "../lib/errors";

export const VIEW_STORAGE_KEY = "github-tracker:view";

const IssueFiltersSchema = z.object({
  role: z.enum(["all", "author", "assignee"]).default("all"),
  comments: z.enum(["all", "has", "none"]).default("all"),
  user: z.enum(["all"]).or(z.string()).default("all"),
});

const PullRequestFiltersSchema = z.object({
  role: z.enum(["all", "author", "reviewer", "assignee"]).default("all"),
  reviewDecision: z.enum(["all", "APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]).default("all"),
  draft: z.enum(["all", "draft", "ready"]).default("all"),
  checkStatus: z.enum(["all", "success", "failure", "pending", "conflict", "none"]).default("all"),
  sizeCategory: z.enum(["all", "XS", "S", "M", "L", "XL"]).default("all"),
  user: z.enum(["all"]).or(z.string()).default("all"),
});

const ActionsFiltersSchema = z.object({
  conclusion: z.enum(["all", "success", "failure", "cancelled", "running", "other"]).default("all"),
  event: z.enum(["all", "push", "pull_request", "schedule", "workflow_dispatch", "other"]).default("all"),
});

export type IssueFilters = z.infer<typeof IssueFiltersSchema>;
export type IssueFilterField = keyof IssueFilters;
export type PullRequestFilters = z.infer<typeof PullRequestFiltersSchema>;
export type PullRequestFilterField = keyof PullRequestFilters;
export type ActionsFilters = z.infer<typeof ActionsFiltersSchema>;
export type ActionsFilterField = keyof ActionsFilters;

export const ViewStateSchema = z.object({
  lastActiveTab: z
    .enum(["issues", "pullRequests", "actions"])
    .default("issues"),
  sortPreferences: z
    .record(
      z.string(),
      z.object({
        field: z.string(),
        direction: z.enum(["asc", "desc"]),
      })
    )
    .default({}),
  ignoredItems: z
    .array(
      z.object({
        id: z.string(),
        type: z.enum(["issue", "pullRequest", "workflowRun"]),
        repo: z.string(),
        title: z.string(),
        ignoredAt: z.number(),
      })
    )
    .default([]),
  globalFilter: z
    .object({
      org: z.string().nullable().default(null),
      repo: z.string().nullable().default(null),
    })
    .default({ org: null, repo: null }),
  tabFilters: z.object({
    issues: IssueFiltersSchema.default({ role: "all", comments: "all", user: "all" }),
    pullRequests: PullRequestFiltersSchema.default({ role: "all", reviewDecision: "all", draft: "all", checkStatus: "all", sizeCategory: "all", user: "all" }),
    actions: ActionsFiltersSchema.default({ conclusion: "all", event: "all" }),
  }).default({
    issues: { role: "all", comments: "all", user: "all" },
    pullRequests: { role: "all", reviewDecision: "all", draft: "all", checkStatus: "all", sizeCategory: "all", user: "all" },
    actions: { conclusion: "all", event: "all" },
  }),
  showPrRuns: z.boolean().default(false),
  hideDepDashboard: z.boolean().default(true),
  expandedRepos: z.object({
    issues: z.record(z.string(), z.boolean()).default({}),
    pullRequests: z.record(z.string(), z.boolean()).default({}),
    actions: z.record(z.string(), z.boolean()).default({}),
  }).default({
    issues: {},
    pullRequests: {},
    actions: {},
  }),
  lockedRepos: z.object({
    issues: z.array(z.string()).default([]),
    pullRequests: z.array(z.string()).default([]),
    actions: z.array(z.string()).default([]),
  }).default({
    issues: [],
    pullRequests: [],
    actions: [],
  }),
});

export type ViewState = z.infer<typeof ViewStateSchema>;
export type IgnoredItem = ViewState["ignoredItems"][number];
export type SortPreference = ViewState["sortPreferences"][string];
export type LockedReposTab = keyof ViewState["lockedRepos"];

function loadViewState(): ViewState {
  try {
    const raw = localStorage.getItem(VIEW_STORAGE_KEY);
    if (raw === null) return ViewStateSchema.parse({});
    const parsed = JSON.parse(raw) as unknown;
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
  updateViewState({
    lastActiveTab: "issues",
    sortPreferences: {},
    ignoredItems: [],
    globalFilter: { org: null, repo: null },
    tabFilters: {
      issues: { role: "all", comments: "all", user: "all" },
      pullRequests: { role: "all", reviewDecision: "all", draft: "all", checkStatus: "all", sizeCategory: "all", user: "all" },
      actions: { conclusion: "all", event: "all" },
    },
    showPrRuns: false,
    hideDepDashboard: true,
    expandedRepos: { issues: {}, pullRequests: {}, actions: {} },
    lockedRepos: { issues: [], pullRequests: [], actions: [] },
  });
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
        draft.ignoredItems.push(item);
      }
    })
  );
}

export function unignoreItem(id: string): void {
  setViewState(
    produce((draft) => {
      draft.ignoredItems = draft.ignoredItems.filter((i) => i.id !== id);
    })
  );
}

export function setSortPreference(
  tabId: string,
  field: string,
  direction: "asc" | "desc"
): void {
  setViewState(
    produce((draft) => {
      draft.sortPreferences[tabId] = { field, direction };
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

const tabFilterDefaults: Record<string, Record<string, string>> = {
  issues: IssueFiltersSchema.parse({}) as Record<string, string>,
  pullRequests: PullRequestFiltersSchema.parse({}) as Record<string, string>,
  actions: ActionsFiltersSchema.parse({}) as Record<string, string>,
};

export function resetTabFilter<T extends keyof TabFilterField>(
  tab: T,
  field: TabFilterField[T]
): void {
  const defaultValue = tabFilterDefaults[tab]?.[field as string] ?? "all";
  setViewState(
    produce((draft) => {
      (draft.tabFilters[tab] as Record<string, string>)[field as string] = defaultValue;
    })
  );
}

export function resetAllTabFilters(
  tab: "issues" | "pullRequests" | "actions"
): void {
  setViewState(
    produce((draft) => {
      if (tab === "issues") {
        draft.tabFilters.issues = IssueFiltersSchema.parse({});
      } else if (tab === "pullRequests") {
        draft.tabFilters.pullRequests = PullRequestFiltersSchema.parse({});
      } else {
        draft.tabFilters.actions = ActionsFiltersSchema.parse({});
      }
    })
  );
}

export function toggleExpandedRepo(
  tab: keyof ViewState["expandedRepos"],
  repoFullName: string
): void {
  setViewState(
    produce((draft) => {
      if (draft.expandedRepos[tab][repoFullName]) {
        delete draft.expandedRepos[tab][repoFullName];
      } else {
        draft.expandedRepos[tab][repoFullName] = true;
      }
    })
  );
}

export function setAllExpanded(
  tab: keyof ViewState["expandedRepos"],
  repoFullNames: string[],
  expanded: boolean
): void {
  setViewState(
    produce((draft) => {
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
  tab: keyof ViewState["expandedRepos"],
  activeRepoNames: string[]
): void {
  const currentKeys = untrack(() => Object.keys(viewState.expandedRepos[tab]));
  if (currentKeys.length === 0) return;
  const activeSet = new Set(activeRepoNames);
  const staleKeys = currentKeys.filter((k) => !activeSet.has(k));
  if (staleKeys.length === 0) return;
  setViewState(
    produce((draft) => {
      for (const key of staleKeys) {
        delete draft.expandedRepos[tab][key];
      }
    })
  );
}

export function lockRepo(tab: LockedReposTab, repoFullName: string): void {
  setViewState(produce((draft) => {
    if (!draft.lockedRepos[tab].includes(repoFullName)) {
      draft.lockedRepos[tab].push(repoFullName);
    }
  }));
}

export function unlockRepo(tab: LockedReposTab, repoFullName: string): void {
  setViewState(produce((draft) => {
    draft.lockedRepos[tab] = draft.lockedRepos[tab].filter(r => r !== repoFullName);
  }));
}

export function moveLockedRepo(
  tab: LockedReposTab,
  repoFullName: string,
  direction: "up" | "down"
): void {
  setViewState(produce((draft) => {
    const arr = draft.lockedRepos[tab];
    const idx = arr.indexOf(repoFullName);
    if (idx === -1) return;
    const targetIdx = direction === "up" ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= arr.length) return;
    const tmp = arr[idx];
    arr[idx] = arr[targetIdx];
    arr[targetIdx] = tmp;
  }));
}

export function pruneLockedRepos(
  tab: LockedReposTab,
  activeRepoNames: string[]
): void {
  const current = untrack(() => viewState.lockedRepos[tab]);
  if (current.length === 0) return;
  const activeSet = new Set(activeRepoNames);
  const filtered = current.filter(name => activeSet.has(name));
  if (filtered.length === current.length) return;
  setViewState(produce((draft) => {
    draft.lockedRepos[tab] = filtered;
  }));
}

export function initViewPersistence(): void {
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    const json = JSON.stringify(viewState); // synchronous read → tracked by SolidJS
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      try {
        localStorage.setItem(VIEW_STORAGE_KEY, json);
      } catch {
        pushNotification("localStorage:view", "View state write failed — storage may be full", "warning");
      }
    }, 200);
    onCleanup(() => {
      clearTimeout(debounceTimer);
    });
  });
}
