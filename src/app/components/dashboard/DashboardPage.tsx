import { createSignal, createMemo, Switch, Match, onMount } from "solid-js";
import { createStore } from "solid-js/store";
import Header from "../layout/Header";
import TabBar from "../layout/TabBar";
import { TabId } from "../layout/TabBar";
import FilterBar from "../layout/FilterBar";
import ActionsTab from "./ActionsTab";
import { config } from "../../stores/config";
import { viewState, updateViewState } from "../../stores/view";
import type { Issue, PullRequest, WorkflowRun, ApiError } from "../../services/api";
import { fetchIssues, fetchPullRequests, fetchWorkflowRuns } from "../../services/api";
import { getClient } from "../../services/github";

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
  const [dashboardData, setDashboardData] = createStore<DashboardData>({
    issues: [],
    pullRequests: [],
    workflowRuns: [],
    errors: [],
    loading: true,
    lastRefreshedAt: null,
  });

  const [isRefreshing, setIsRefreshing] = createSignal(false);

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

  async function loadData() {
    const octokit = getClient();
    if (!octokit) return;

    setIsRefreshing(true);
    setDashboardData("loading", true);

    try {
      const repos = config.selectedRepos;

      // Fetch user login from auth store is not directly available here,
      // so we derive it from the octokit instance by calling /user lazily.
      // For now pass empty string — fetchIssues/fetchPullRequests handle it.
      const userLogin = "";

      const [issueResults, prResults, runResults] = await Promise.allSettled([
        fetchIssues(octokit, repos, userLogin),
        fetchPullRequests(octokit, repos, userLogin),
        fetchWorkflowRuns(
          octokit,
          repos,
          config.maxWorkflowsPerRepo,
          config.maxRunsPerWorkflow
        ),
      ]);

      setDashboardData({
        issues: issueResults.status === "fulfilled" ? issueResults.value : [],
        pullRequests:
          prResults.status === "fulfilled" ? prResults.value : [],
        workflowRuns:
          runResults.status === "fulfilled" ? runResults.value : [],
        errors: [],
        loading: false,
        lastRefreshedAt: new Date(),
      });
    } catch {
      setDashboardData("loading", false);
    } finally {
      setIsRefreshing(false);
    }
  }

  onMount(() => {
    void loadData();
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
          isRefreshing={isRefreshing()}
          lastRefreshedAt={dashboardData.lastRefreshedAt}
          onRefresh={() => void loadData()}
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
