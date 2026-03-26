import { createMemo, createSignal, createEffect, onCleanup, Show } from "solid-js";
import { Select } from "@kobalte/core/select";
import { config } from "../../stores/config";
import { viewState, setGlobalFilter } from "../../stores/view";

interface FilterBarProps {
  isRefreshing?: boolean;
  lastRefreshedAt?: Date | null;
  onRefresh?: () => void;
}

export default function FilterBar(props: FilterBarProps) {
  const [tick, setTick] = createSignal(0);
  const tickTimer = setInterval(() => setTick((t) => t + 1), 30_000);
  onCleanup(() => clearInterval(tickTimer));

  // Fade out the "Updated X ago" label after 8 seconds
  const [labelVisible, setLabelVisible] = createSignal(false);
  createEffect(() => {
    const ts = props.lastRefreshedAt;
    if (!ts) return;
    setLabelVisible(true);
    const id = setTimeout(() => setLabelVisible(false), 8_000);
    onCleanup(() => clearTimeout(id));
  });

  const orgs = createMemo(() => config.selectedOrgs);

  const repos = createMemo(() => {
    const selectedOrg = viewState.globalFilter.org;
    if (!selectedOrg) return config.selectedRepos;
    return config.selectedRepos.filter((r) => r.owner === selectedOrg);
  });

  function handleOrgChange(value: string | null) {
    const org = value === "" || value === null ? null : value;
    // Reset repo filter when org changes
    setGlobalFilter(org, null);
  }

  function handleRepoChange(value: string | null) {
    const repo = value === "" || value === null ? null : value;
    setGlobalFilter(viewState.globalFilter.org, repo);
  }

  const updatedLabel = createMemo(() => {
    tick(); // Force recompute every 30s
    if (props.isRefreshing) return "Refreshing...";
    if (!props.lastRefreshedAt) return null;
    const diffMs = Date.now() - props.lastRefreshedAt.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 60) return `Updated ${diffSec}s ago`;
    const diffMin = Math.floor(diffSec / 60);
    return `Updated ${diffMin}m ago`;
  });

  return (
    <div class="flex items-center gap-3 px-4 py-2 bg-base-100 border-b border-base-300 shadow-sm">
      <Select<string>
        value={viewState.globalFilter.org ?? ""}
        onChange={handleOrgChange}
        options={["", ...orgs()]}
        itemComponent={(itemProps) => (
          <Select.Item item={itemProps.item} class="px-3 py-1.5 cursor-pointer hover:bg-base-200 data-[highlighted]:bg-base-200 text-sm">
            <Select.ItemLabel>
              {itemProps.item.rawValue === "" ? "All orgs" : itemProps.item.rawValue}
            </Select.ItemLabel>
          </Select.Item>
        )}
      >
        <Select.Trigger
          class="btn btn-sm btn-outline"
          aria-label="Filter by organization"
        >
          {viewState.globalFilter.org ?? "All orgs"}
        </Select.Trigger>
        <Select.Portal>
          <Select.Content class="bg-base-100 border border-base-300 rounded-lg shadow-lg z-50">
            <Select.Listbox />
          </Select.Content>
        </Select.Portal>
      </Select>

      <Select<string>
        value={viewState.globalFilter.repo ?? ""}
        onChange={handleRepoChange}
        options={["", ...repos().map((r) => r.fullName)]}
        itemComponent={(itemProps) => (
          <Select.Item item={itemProps.item} class="px-3 py-1.5 cursor-pointer hover:bg-base-200 data-[highlighted]:bg-base-200 text-sm">
            <Select.ItemLabel>
              {itemProps.item.rawValue === "" ? "All repos" : itemProps.item.rawValue}
            </Select.ItemLabel>
          </Select.Item>
        )}
      >
        <Select.Trigger
          class="btn btn-sm btn-outline"
          aria-label="Filter by repository"
        >
          {viewState.globalFilter.repo ?? "All repos"}
        </Select.Trigger>
        <Select.Portal>
          <Select.Content class="bg-base-100 border border-base-300 rounded-lg shadow-lg z-50">
            <Select.Listbox />
          </Select.Content>
        </Select.Portal>
      </Select>

      <div class="flex-1" />

      <Show when={updatedLabel()}>
        <span
          class={`text-xs text-base-content/50 transition-opacity duration-1000 ${
            props.isRefreshing || labelVisible() ? "opacity-100" : "opacity-0"
          }`}
        >
          {updatedLabel()}
        </span>
      </Show>

      <button
        onClick={props.onRefresh}
        disabled={props.isRefreshing}
        class="btn btn-ghost btn-sm"
        aria-label="Refresh data"
      >
        <Show
          when={props.isRefreshing}
          fallback={
            <svg
              xmlns="http://www.w3.org/2000/svg"
              class="h-4 w-4 inline-block mr-1"
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
          }
        >
          <span class="loading loading-spinner loading-xs mr-1" />
        </Show>
        Refresh
      </button>
    </div>
  );
}
