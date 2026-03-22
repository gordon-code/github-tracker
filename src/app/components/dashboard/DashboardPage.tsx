import { createSignal, createMemo, For, Show, Switch, Match, onMount } from "solid-js";
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

// ── Shared dashboard store ──────────────────────────────────────────────────

interface DashboardData {
  issues: Issue[];
  pullRequests: PullRequest[];
  workflowRuns: WorkflowRun[];
  errors: ApiError[];
  loading: boolean;
  lastRefreshedAt: Date | null;
}

export default function DashboardPage() {
  const navigate = useNavigate();

  const [dashboardData, setDashboardData] = createStore<DashboardData>({
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
        <Show when={getErrors().length > 0}>
          <div class="px-4 pt-2 space-y-1">
            <For each={getErrors()}>
              {(err) => (
                <div
                  role="alert"
                  class="flex items-center gap-2 rounded-md bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 px-3 py-2 text-sm text-red-700 dark:text-red-300"
                >
                  <svg class="h-4 w-4 shrink-0" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                    <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd" />
                  </svg>
                  <span class="flex-1">
                    <strong>{err.source}:</strong> {err.message}
                    {err.retryable && " (will retry)"}
                  </span>
                  <button
                    onClick={() => dismissError(err.id)}
                    class="shrink-0 text-red-400 hover:text-red-600 dark:hover:text-red-200"
                    aria-label="Dismiss error"
                  >
                    <svg class="h-4 w-4" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                      <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" />
                    </svg>
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>

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
