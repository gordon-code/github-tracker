import { setTabFilter, resetAllTabFilters, setCustomTabFilter, resetCustomTabFilters } from "../stores/view";

type BuiltinTabKey = "issues" | "pullRequests" | "actions";

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
