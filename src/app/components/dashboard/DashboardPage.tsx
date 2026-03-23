import { createSignal, createMemo, Switch, Match, onMount } from "solid-js";
import { createStore } from "solid-js/store";
import { useNavigate } from "@solidjs/router";
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

// ── Shared dashboard store ──────────────────────────────────────────────────

interface DashboardStore {
  issues: Issue[];
  pullRequests: PullRequest[];
  workflowRuns: WorkflowRun[];
  errors: ApiError[];
  loading: boolean;
  lastRefreshedAt: Date | null;
}

export default function DashboardPage() {
  const navigate = useNavigate();

  const [dashboardData, setDashboardData] = createStore<DashboardStore>({
    issues: [],
    pullRequests: [],
    workflowRuns: [],
    errors: [],
    loading: true,
    lastRefreshedAt: null,
  });

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
          navigate("/login");
        }
        // If refreshed, the token signal will update the client — let the next poll pick it up
      }
      setDashboardData("loading", false);
      throw err;
    }
  }

  const [coordinator, setCoordinator] = createSignal<ReturnType<typeof createPollCoordinator> | null>(null);

  onMount(() => {
    setCoordinator(
      createPollCoordinator(() => config.refreshInterval, pollFetch)
    );
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
          isRefreshing={coordinator()?.isRefreshing() ?? dashboardData.loading}
          lastRefreshedAt={coordinator()?.lastRefreshAt() ?? dashboardData.lastRefreshedAt}
          onRefresh={() => coordinator()?.manualRefresh()}
        />

        {/* Global error banner */}
        <ErrorBannerList
          errors={getErrors().map((e) => ({ repo: e.source, message: e.message, retryable: e.retryable }) as ApiError)}
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
      </div>
    </div>
  );
}
