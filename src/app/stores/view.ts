import { z } from "zod";
import { createStore, produce } from "solid-js/store";
import { createEffect } from "solid-js";

const STORAGE_KEY = "github-tracker:view";

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

export function isItemIgnored(id: string): boolean {
  return viewState.ignoredItems.some((i) => i.id === id);
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

export function initViewPersistence(): void {
  createEffect(() => {
    const snapshot = JSON.parse(JSON.stringify(viewState)) as ViewState;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  });
}
