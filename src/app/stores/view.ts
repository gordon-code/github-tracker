import { z } from "zod";
import { createStore, produce } from "solid-js/store";
import { createEffect } from "solid-js";

const STORAGE_KEY = "github-tracker:view";

const IssueFiltersSchema = z.object({
  role: z.enum(["all", "author", "assignee"]).default("all"),
  comments: z.enum(["all", "has", "none"]).default("all"),
});

const PullRequestFiltersSchema = z.object({
  role: z.enum(["all", "author", "reviewer", "assignee"]).default("all"),
  reviewDecision: z.enum(["all", "APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]).default("all"),
  draft: z.enum(["all", "draft", "ready"]).default("all"),
  checkStatus: z.enum(["all", "success", "failure", "pending", "none"]).default("all"),
  sizeCategory: z.enum(["all", "XS", "S", "M", "L", "XL"]).default("all"),
});

const ActionsFiltersSchema = z.object({
  conclusion: z.enum(["all", "success", "failure", "cancelled", "running", "other"]).default("all"),
  event: z.enum(["all", "push", "pull_request", "schedule", "workflow_dispatch", "other"]).default("all"),
});

export type IssueFilters = z.infer<typeof IssueFiltersSchema>;
export type PullRequestFilters = z.infer<typeof PullRequestFiltersSchema>;
export type ActionsFilters = z.infer<typeof ActionsFiltersSchema>;

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
    issues: IssueFiltersSchema.default({ role: "all", comments: "all" }),
    pullRequests: PullRequestFiltersSchema.default({ role: "all", reviewDecision: "all", draft: "all", checkStatus: "all", sizeCategory: "all" }),
    actions: ActionsFiltersSchema.default({ conclusion: "all", event: "all" }),
  }).default({
    issues: { role: "all", comments: "all" },
    pullRequests: { role: "all", reviewDecision: "all", draft: "all", checkStatus: "all", sizeCategory: "all" },
    actions: { conclusion: "all", event: "all" },
  }),
  showPrRuns: z.boolean().default(false),
});

export type ViewState = z.infer<typeof ViewStateSchema>;
export type IgnoredItem = ViewState["ignoredItems"][number];
export type SortPreference = ViewState["sortPreferences"][string];

function loadViewState(): ViewState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
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

export function resetTabFilter<T extends keyof TabFilterField>(
  tab: T,
  field: TabFilterField[T]
): void {
  setViewState(
    produce((draft) => {
      (draft.tabFilters[tab] as Record<string, string>)[field as string] = "all";
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

export function initViewPersistence(): void {
  createEffect(() => {
    const snapshot = JSON.parse(JSON.stringify(viewState)) as ViewState;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    } catch {
      // QuotaExceededError — silently fail rather than kill the reactive graph
    }
  });
}
