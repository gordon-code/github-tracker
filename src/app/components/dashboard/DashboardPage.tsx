import { createSignal, createMemo, Switch, Match, onMount, onCleanup } from "solid-js";
import { createStore } from "solid-js/store";
import Header from "../layout/Header";
import TabBar, { TabId } from "../layout/TabBar";
import FilterBar from "../layout/FilterBar";
import ActionsTab from "./ActionsTab";
import IssuesTab from "./IssuesTab";
import PullRequestsTab from "./PullRequestsTab";
import { config } from "../../stores/config";
import { viewState, updateViewState } from "../../stores/view";
import type { Issue, PullRequest, WorkflowRun, ApiError } from "../../services/api";
import { createPollCoordinator, fetchAllData, type DashboardData } from "../../services/poll";
import { clearAuth, user, onAuthCleared } from "../../stores/auth";
import { getErrors, dismissError } from "../../lib/errors";
import ErrorBannerList from "../shared/ErrorBannerList";

// ── Shared dashboard store (module-level to survive navigation) ─────────────

export const DASHBOARD_STORAGE_KEY = "github-tracker:dashboard";

interface DashboardStore {
  issues: Issue[];
  pullRequests: PullRequest[];
  workflowRuns: WorkflowRun[];
  errors: ApiError[];
  loading: boolean;
  lastRefreshedAt: Date | null;
}

const initialDashboardState: DashboardStore = {
  issues: [],
  pullRequests: [],
  workflowRuns: [],
  errors: [],
  loading: true,
  lastRefreshedAt: null,
};

function loadCachedDashboard(): DashboardStore {
  try {
    const raw = localStorage.getItem?.(DASHBOARD_STORAGE_KEY);
    if (!raw) return { ...initialDashboardState };
    const parsed = JSON.parse(raw) as DashboardStore;
    // Restore Date from ISO string
    return {
      issues: parsed.issues ?? [],
      pullRequests: parsed.pullRequests ?? [],
      workflowRuns: parsed.workflowRuns ?? [],
      errors: [],
      loading: false,
      lastRefreshedAt: parsed.lastRefreshedAt ? new Date(parsed.lastRefreshedAt) : null,
    };
  } catch {
    return { ...initialDashboardState };
  }
}

const [dashboardData, setDashboardData] = createStore<DashboardStore>(loadCachedDashboard());

function resetDashboardData(): void {
  setDashboardData({ ...initialDashboardState });
  localStorage.removeItem?.(DASHBOARD_STORAGE_KEY);
}

// Clear dashboard data and stop polling on logout to prevent cross-user data leakage
onAuthCleared(() => {
  resetDashboardData();
  if (_coordinator) {
    _coordinator.destroy();
    _coordinator = null;
  }
});

async function pollFetch(): Promise<DashboardData> {
  // Only show skeleton on initial load (no data yet).
  // Subsequent refreshes keep existing data visible — the coordinator's
  // isRefreshing signal handles the "Refreshing..." indicator.
  if (!dashboardData.lastRefreshedAt) {
    setDashboardData("loading", true);
  }
  try {
    const data = await fetchAllData();
    // When notifications gate says nothing changed, keep existing data
    if (!data.skipped) {
      const now = new Date();
      setDashboardData({
        issues: data.issues,
        pullRequests: data.pullRequests,
        workflowRuns: data.workflowRuns,
        errors: data.errors,
        loading: false,
        lastRefreshedAt: now,
      });
      // Persist for stale-while-revalidate on full page reload.
      // Errors are transient and not persisted.
      try {
        localStorage.setItem(DASHBOARD_STORAGE_KEY, JSON.stringify({
          issues: data.issues,
          pullRequests: data.pullRequests,
          workflowRuns: data.workflowRuns,
          lastRefreshedAt: now.toISOString(),
        }));
      } catch {
        // localStorage full or unavailable — non-fatal
      }
    } else {
      setDashboardData("loading", false);
    }
    return data;
  } catch (err) {
    // Handle 401 auth errors
    const status =
      typeof err === "object" &&
      err !== null &&
      typeof (err as Record<string, unknown>)["status"] === "number"
        ? (err as Record<string, unknown>)["status"]
        : null;

    if (status === 401) {
      // Hard redirect (not navigate()) forces a full page reload, which clears
      // module-level state like _coordinator and dashboardData for the next user.
      clearAuth();
      window.location.replace("/login");
    }
    setDashboardData("loading", false);
    throw err;
  }
}

let _coordinator: ReturnType<typeof createPollCoordinator> | null = null;

export default function DashboardPage() {

  const initialTab = createMemo<TabId>(() => {
    if (config.rememberLastTab) {
      return viewState.lastActiveTab;
    }
    return config.defaultTab;
  });

  const [activeTab, setActiveTab] = createSignal<TabId>(initialTab());

  function handleTabChange(tab: TabId) {
    setActiveTab(tab);
    updateViewState({ lastActiveTab: tab });
  }

  onMount(() => {
    if (!_coordinator) {
      _coordinator = createPollCoordinator(() => config.refreshInterval, pollFetch);
    }
    // Null the reference on unmount so a fresh coordinator is created on remount.
    // onCleanup inside createPollCoordinator marks it destroyed; this ensures
    // the guard in onMount doesn't skip recreation on the next navigation back.
    onCleanup(() => {
      _coordinator = null;
    });
  });

  const tabCounts = createMemo(() => ({
    issues: dashboardData.issues.length,
    pullRequests: dashboardData.pullRequests.length,
    actions: dashboardData.workflowRuns.length,
  }));

  const userLogin = createMemo(() => user()?.login ?? "");

  return (
    <div class="min-h-screen bg-gray-50 dark:bg-gray-900">
      <Header />

      {/* Offset for fixed header */}
      <div class="pt-14 flex flex-col h-screen">
        <TabBar
          activeTab={activeTab()}
          onTabChange={handleTabChange}
          counts={tabCounts()}
        />

        <FilterBar
          isRefreshing={_coordinator?.isRefreshing() ?? dashboardData.loading}
          lastRefreshedAt={_coordinator?.lastRefreshAt() ?? dashboardData.lastRefreshedAt}
          onRefresh={() => _coordinator?.manualRefresh()}
        />

        {/* Global error banner */}
        <ErrorBannerList
          errors={getErrors().map((e) => ({ source: e.source, message: e.message, retryable: e.retryable }))}
          onDismiss={(index) => dismissError(getErrors()[index].id)}
        />

        <main class="flex-1 overflow-auto">
          <Switch>
            <Match when={activeTab() === "issues"}>
              <IssuesTab
                issues={dashboardData.issues}
                loading={dashboardData.loading}
                errors={dashboardData.errors}
                userLogin={userLogin()}
              />
            </Match>
            <Match when={activeTab() === "pullRequests"}>
              <PullRequestsTab
                pullRequests={dashboardData.pullRequests}
                loading={dashboardData.loading}
                errors={dashboardData.errors}
                userLogin={userLogin()}
              />
            </Match>
            <Match when={activeTab() === "actions"}>
              <ActionsTab
                workflowRuns={dashboardData.workflowRuns}
                loading={dashboardData.loading}
                errors={dashboardData.errors}
              />
            </Match>
          </Switch>
        </main>

        <footer class="border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-3 flex items-center justify-center gap-3 text-xs text-gray-400 dark:text-gray-500 shrink-0">
          <a
            href="https://github.com/gordon-code/github-tracker"
            target="_blank"
            rel="noopener noreferrer"
            class="hover:text-gray-600 dark:hover:text-gray-300"
          >
            Source
          </a>
          <span aria-hidden="true">&middot;</span>
          <a
            href="/privacy"
            class="hover:text-gray-600 dark:hover:text-gray-300"
          >
            Privacy
          </a>
        </footer>
      </div>
    </div>
  );
}
