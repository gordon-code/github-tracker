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
import type { Issue, PullRequest, WorkflowRun } from "../../services/api";
import { createPollCoordinator, fetchAllData, type DashboardData } from "../../services/poll";
import { clearAuth, user, onAuthCleared, DASHBOARD_STORAGE_KEY } from "../../stores/auth";

// ── Shared dashboard store (module-level to survive navigation) ─────────────

const CACHE_VERSION = 1;

interface DashboardStore {
  issues: Issue[];
  pullRequests: PullRequest[];
  workflowRuns: WorkflowRun[];
  loading: boolean;
  lastRefreshedAt: Date | null;
}

const initialDashboardState: DashboardStore = {
  issues: [],
  pullRequests: [],
  workflowRuns: [],
  loading: true,
  lastRefreshedAt: null,
};

function loadCachedDashboard(): DashboardStore {
  try {
    const raw = localStorage.getItem?.(DASHBOARD_STORAGE_KEY);
    if (!raw) return { ...initialDashboardState };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // Invalidate cache on schema version mismatch
    if (parsed._v !== CACHE_VERSION) return { ...initialDashboardState };
    // Validate expected shape — arrays must be arrays
    if (!Array.isArray(parsed.issues) || !Array.isArray(parsed.pullRequests) || !Array.isArray(parsed.workflowRuns)) {
      return { ...initialDashboardState };
    }
    return {
      issues: parsed.issues as Issue[],
      pullRequests: parsed.pullRequests as PullRequest[],
      workflowRuns: parsed.workflowRuns as WorkflowRun[],
      loading: false,
      lastRefreshedAt: typeof parsed.lastRefreshedAt === "string" ? new Date(parsed.lastRefreshedAt) : null,
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
  const coord = _coordinator();
  if (coord) {
    coord.destroy();
    _setCoordinator(null);
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
        loading: false,
        lastRefreshedAt: now,
      });
      // Persist for stale-while-revalidate on full page reload.
      // Errors are transient and not persisted. Deferred to avoid blocking paint.
      const cachePayload = {
        _v: CACHE_VERSION,
        issues: data.issues,
        pullRequests: data.pullRequests,
        workflowRuns: data.workflowRuns,
        lastRefreshedAt: now.toISOString(),
      };
      setTimeout(() => {
        try {
          localStorage.setItem(DASHBOARD_STORAGE_KEY, JSON.stringify(cachePayload));
        } catch {
          // localStorage full or unavailable — non-fatal
        }
      }, 0);
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

const [_coordinator, _setCoordinator] = createSignal<ReturnType<typeof createPollCoordinator> | null>(null);

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
    if (!_coordinator()) {
      _setCoordinator(createPollCoordinator(() => config.refreshInterval, pollFetch));
    }
    onCleanup(() => {
      _coordinator()?.destroy();
      _setCoordinator(null);
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
          isRefreshing={_coordinator()?.isRefreshing() ?? dashboardData.loading}
          lastRefreshedAt={_coordinator()?.lastRefreshAt() ?? dashboardData.lastRefreshedAt}
          onRefresh={() => _coordinator()?.manualRefresh()}
        />

        <main class="flex-1 overflow-auto">
          <Switch>
            <Match when={activeTab() === "issues"}>
              <IssuesTab
                issues={dashboardData.issues}
                loading={dashboardData.loading}
                userLogin={userLogin()}
              />
            </Match>
            <Match when={activeTab() === "pullRequests"}>
              <PullRequestsTab
                pullRequests={dashboardData.pullRequests}
                loading={dashboardData.loading}
                userLogin={userLogin()}
              />
            </Match>
            <Match when={activeTab() === "actions"}>
              <ActionsTab
                workflowRuns={dashboardData.workflowRuns}
                loading={dashboardData.loading}
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
