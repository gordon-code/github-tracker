import { For } from "solid-js";

export type TabId = "issues" | "pullRequests" | "actions";

export interface TabCounts {
  issues?: number;
  pullRequests?: number;
  actions?: number;
}

interface TabBarProps {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  counts?: TabCounts;
}

interface Tab {
  id: TabId;
  label: string;
}

const TABS: Tab[] = [
  { id: "issues", label: "Issues" },
  { id: "pullRequests", label: "Pull Requests" },
  { id: "actions", label: "Actions" },
];

export default function TabBar(props: TabBarProps) {
  return (
    <nav
      class="border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900"
      aria-label="Dashboard tabs"
    >
      <div class="max-w-6xl mx-auto w-full px-4 flex">
      <For each={TABS}>
        {(tab) => {
          const count = () => props.counts?.[tab.id];
          const isActive = () => props.activeTab === tab.id;

          return (
            <button
              onClick={() => props.onTabChange(tab.id)}
              class={`relative flex items-center gap-1.5 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                isActive()
                  ? "border-blue-500 text-blue-600 dark:text-blue-400"
                  : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:border-gray-300 dark:hover:border-gray-600"
              }`}
              aria-current={isActive() ? "page" : undefined}
            >
              {tab.label}
              {count() !== undefined && (
                <span
                  class={`inline-flex items-center justify-center rounded-full px-2 py-0.5 text-xs font-medium min-w-[1.25rem] ${
                    isActive()
                      ? "bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300"
                      : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400"
                  }`}
                >
                  {count()}
                </span>
              )}
            </button>
          );
        }}
      </For>
      </div>
    </nav>
  );
}
