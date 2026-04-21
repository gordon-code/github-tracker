import { viewState, setTabFilter, resetAllTabFilters, setCustomTabFilter, resetCustomTabFilters } from "../stores/view";

type BuiltinTabKey = "issues" | "pullRequests" | "actions";

/**
 * Merge filter state for a tab: schema defaults → preset → stored runtime overrides.
 * Resolves the _self sentinel when resolveLogin is provided.
 */
export function mergeActiveFilters<T>(
  schema: { safeParse: (v: unknown) => { success: boolean; data?: T } },
  defaults: T,
  customTabId: string | undefined,
  builtinFilters: T,
  opts: { preset?: Record<string, string>; resolveLogin?: string }
): T {
  if (!customTabId) return builtinFilters;
  const stored = viewState.customTabFilters[customTabId] ?? {};
  const preset = opts.preset ?? {};
  const merged = { ...(defaults as Record<string, string>), ...preset, ...stored } as Record<string, string>;
  if (opts.resolveLogin !== undefined && merged["user"] === "_self") {
    merged["user"] = opts.resolveLogin || "all";
  }
  return schema.safeParse(merged).data ?? defaults;
}

/**
 * Creates filter change handlers that dispatch to either custom tab or built-in tab filter state.
 * Eliminates the identical if/else dispatch pattern across IssuesTab, PullRequestsTab, and ActionsTab.
 */
export function createTabFilterHandlers(
  builtinTab: BuiltinTabKey,
  getCustomTabId: () => string | undefined
) {
  function handleFilterChange(field: string, value: string) {
    const customTabId = getCustomTabId();
    if (customTabId) {
      setCustomTabFilter(customTabId, field, value);
    } else {
      // Field is known-valid at each call site; generic variance prevents static proof
      (setTabFilter as (tab: BuiltinTabKey, field: string, value: string) => void)(builtinTab, field, value);
    }
  }

  function handleResetFilters() {
    const customTabId = getCustomTabId();
    if (customTabId) {
      resetCustomTabFilters(customTabId);
    } else {
      resetAllTabFilters(builtinTab);
    }
  }

  return { handleFilterChange, handleResetFilters };
}
