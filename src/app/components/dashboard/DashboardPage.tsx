import { createSignal, createMemo, Switch, Match, onMount } from "solid-js";
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
import { createPollCoordinator, fetchAllData } from "../../services/poll";
import { refreshAccessToken, clearAuth, user } from "../../stores/auth";
import { getErrors, dismissError } from "../../lib/errors";
import ErrorBannerList from "../shared/ErrorBannerList";

// ── Shared dashboard store (module-level to survive navigation) ─────────────

interface DashboardStore {
  issues: Issue[];
  pullRequests: PullRequest[];
  workflowRuns: WorkflowRun[];
  errors: ApiError[];
  loading: boolean;
  lastRefreshedAt: Date | null;
}

const [dashboardData, setDashboardData] = createStore<DashboardStore>({
  issues: [],
  pullRequests: [],
  workflowRuns: [],
  errors: [],
  loading: true,
  lastRefreshedAt: null,
});

async function pollFetch(): Promise<import("../../services/poll").DashboardData> {
  setDashboardData("loading", true);
  try {
    const data = await fetchAllData();
    // When notifications gate says nothing changed, keep existing data
    if (!data.skipped) {
      setDashboardData({
        issues: data.issues,
        pullRequests: data.pullRequests,
        workflowRuns: data.workflowRuns,
        errors: data.errors,
        loading: false,
        lastRefreshedAt: new Date(),
      });
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
      const refreshed = await refreshAccessToken();
      if (!refreshed) {
        clearAuth();
        window.location.replace("/login");
      }
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
