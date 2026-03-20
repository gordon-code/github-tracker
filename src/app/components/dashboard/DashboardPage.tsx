import { createSignal, createMemo, Switch, Match } from "solid-js";
import Header from "../layout/Header";
import TabBar from "../layout/TabBar";
import { TabId } from "../layout/TabBar";
import FilterBar from "../layout/FilterBar";
import { config } from "../../stores/config";
import { viewState, updateViewState } from "../../stores/view";

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

function ActionsPlaceholder() {
  return (
    <div class="p-8 text-center text-gray-500 dark:text-gray-400">
      <p class="text-lg font-medium">Actions</p>
      <p class="text-sm mt-1">GitHub Actions tab coming soon (Task 13).</p>
    </div>
  );
}

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

  return (
    <div class="min-h-screen bg-gray-50 dark:bg-gray-900">
      <Header />

      {/* Offset for fixed header */}
      <div class="pt-14 flex flex-col h-screen">
        <TabBar
          activeTab={activeTab()}
          onTabChange={handleTabChange}
        />

        <FilterBar />

        <main class="flex-1 overflow-auto">
          <Switch>
            <Match when={activeTab() === "issues"}>
              <IssuesPlaceholder />
            </Match>
            <Match when={activeTab() === "pullRequests"}>
              <PullRequestsPlaceholder />
            </Match>
            <Match when={activeTab() === "actions"}>
              <ActionsPlaceholder />
            </Match>
          </Switch>
        </main>
      </div>
    </div>
  );
}
