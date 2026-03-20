import { createMemo, For } from "solid-js";
import { config } from "../../stores/config";
import { viewState, setGlobalFilter } from "../../stores/view";

interface FilterBarProps {
  isRefreshing?: boolean;
  lastRefreshedAt?: Date | null;
  onRefresh?: () => void;
}

export default function FilterBar(props: FilterBarProps) {
  const orgs = createMemo(() => config.selectedOrgs);

  const repos = createMemo(() => {
    const selectedOrg = viewState.globalFilter.org;
    if (!selectedOrg) return config.selectedRepos;
    return config.selectedRepos.filter((r) => r.owner === selectedOrg);
  });

  function handleOrgChange(e: Event) {
    const value = (e.target as HTMLSelectElement).value;
    const org = value === "" ? null : value;
    // Reset repo filter when org changes
    setGlobalFilter(org, null);
  }

  function handleRepoChange(e: Event) {
    const value = (e.target as HTMLSelectElement).value;
    const repo = value === "" ? null : value;
    setGlobalFilter(viewState.globalFilter.org, repo);
  }

  const updatedLabel = createMemo(() => {
    if (props.isRefreshing) return "Refreshing...";
    if (!props.lastRefreshedAt) return null;
    const diffMs = Date.now() - props.lastRefreshedAt.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 60) return `Updated ${diffSec}s ago`;
    const diffMin = Math.floor(diffSec / 60);
    return `Updated ${diffMin}m ago`;
  });

  return (
    <div class="flex items-center gap-3 px-4 py-2 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
      <select
        value={viewState.globalFilter.org ?? ""}
        onChange={handleOrgChange}
        class="text-sm rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
        aria-label="Filter by organization"
      >
        <option value="">All orgs</option>
        <For each={orgs()}>
          {(org) => <option value={org}>{org}</option>}
        </For>
      </select>

      <select
        value={viewState.globalFilter.repo ?? ""}
        onChange={handleRepoChange}
        class="text-sm rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
        aria-label="Filter by repository"
      >
        <option value="">All repos</option>
        <For each={repos()}>
          {(repo) => (
            <option value={repo.fullName}>{repo.fullName}</option>
          )}
        </For>
      </select>

      <div class="flex-1" />

      {updatedLabel() && (
        <span class="text-xs text-gray-500 dark:text-gray-400">
          {updatedLabel()}
        </span>
      )}

      <button
        onClick={props.onRefresh}
        disabled={props.isRefreshing}
        class="text-sm px-3 py-1 rounded-md bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500"
        aria-label="Refresh data"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          class={`h-4 w-4 inline-block mr-1 ${props.isRefreshing ? "animate-spin" : ""}`}
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
        >
          <path
            fill-rule="evenodd"
            d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z"
            clip-rule="evenodd"
          />
        </svg>
        Refresh
      </button>
    </div>
  );
}
