import { createSignal, createMemo, Switch, Match, onMount } from "solid-js";
import { createStore } from "solid-js/store";
import { useNavigate } from "@solidjs/router";
import Header from "../layout/Header";
import TabBar from "../layout/TabBar";
import { TabId } from "../layout/TabBar";
import FilterBar from "../layout/FilterBar";
import ActionsTab from "./ActionsTab";
import { config } from "../../stores/config";
import { viewState, updateViewState } from "../../stores/view";
import type { Issue, PullRequest, WorkflowRun, ApiError } from "../../services/api";
import { createPollCoordinator, fetchAllData } from "../../services/poll";
import { refreshAccessToken, clearAuth } from "../../stores/auth";

// ── Shared dashboard store ──────────────────────────────────────────────────

interface DashboardData {
  issues: Issue[];
  pullRequests: PullRequest[];
  workflowRuns: WorkflowRun[];
  errors: ApiError[];
  loading: boolean;
  lastRefreshedAt: Date | null;
}

// IssuesTab is implemented by Task 11 (parallel). Use lazy import so this
// compiles even if the file doesn't exist yet.
let IssuesTabComponent: (() => import("solid-js").JSX.Element) | null = null;
try {
  // Dynamic require so TypeScript won't error on a missing module path
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = (await import("./IssuesTab")) as any;
  IssuesTabComponent = mod.default as () => import("solid-js").JSX.Element;
} catch {
  // Task 11 not yet landed — fall through to placeholder
}

function IssuesPlaceholder() {
  return (
    <div class="p-8 text-center text-gray-500 dark:text-gray-400">
      <p class="text-lg font-medium">Issues</p>
      <p class="text-sm mt-1">Issues tab coming soon (Task 11).</p>
    </div>
  );
}

function PullRequestsPlaceholder() {
  return (
    <div class="p-8 text-center text-gray-500 dark:text-gray-400">
      <p class="text-lg font-medium">Pull Requests</p>
      <p class="text-sm mt-1">Pull Requests tab coming soon (Task 12).</p>
    </div>
  );
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

  // Stores previous snapshot for notification diffing (Task 16)
  const [_previousData, setPreviousData] = createSignal<DashboardData | null>(null);

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
      // Save previous snapshot before updating (for Task 16 notification diffing)
      setPreviousData({
        issues: dashboardData.issues,
        pullRequests: dashboardData.pullRequests,
        workflowRuns: dashboardData.workflowRuns,
        errors: dashboardData.errors,
        loading: dashboardData.loading,
        lastRefreshedAt: dashboardData.lastRefreshedAt,
      });
      setDashboardData({
        issues: data.issues,
        pullRequests: data.pullRequests,
        workflowRuns: data.workflowRuns,
        errors: data.errors,
        loading: false,
        lastRefreshedAt: new Date(),
      });
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

        <main class="flex-1 overflow-auto">
          <Switch>
            <Match when={activeTab() === "issues"}>
              {IssuesTabComponent ? (
                <IssuesTabComponent />
              ) : (
                <IssuesPlaceholder />
              )}
            </Match>
            <Match when={activeTab() === "pullRequests"}>
              <PullRequestsPlaceholder />
            </Match>
            <Match when={activeTab() === "actions"}>
              <ActionsTab
                workflowRuns={dashboardData.workflowRuns}
                loading={dashboardData.loading}
              />
            </Match>
          </Switch>
        </main>
      </div>
    </div>
  );
}
