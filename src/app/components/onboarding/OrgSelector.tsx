import { createSignal, createResource, For, Show } from "solid-js";
import { fetchOrgs, OrgEntry } from "../../services/api";
import { getClient } from "../../services/github";
import LoadingSpinner from "../shared/LoadingSpinner";
import FilterInput from "../shared/FilterInput";

interface OrgSelectorProps {
  selected: string[];
  onChange: (selected: string[]) => void;
}

export default function OrgSelector(props: OrgSelectorProps) {
  const [filter, setFilter] = createSignal("");

  const [orgs] = createResource<OrgEntry[]>(async () => {
    const client = getClient();
    if (!client) throw new Error("No GitHub client available");
    return fetchOrgs(client);
  });

  const filteredOrgs = () => {
    const all = orgs() ?? [];
    const q = filter().toLowerCase().trim();
    if (!q) return all;
    return all.filter((o) => o.login.toLowerCase().includes(q));
  };

  const isSelected = (login: string) => props.selected.includes(login);

  function toggleOrg(login: string) {
    if (isSelected(login)) {
      props.onChange(props.selected.filter((l) => l !== login));
    } else {
      props.onChange([...props.selected, login]);
    }
  }

  function selectAll() {
    const visible = filteredOrgs().map((o) => o.login);
    const current = new Set(props.selected);
    for (const login of visible) current.add(login);
    props.onChange([...current]);
  }

  function deselectAll() {
    const visible = new Set(filteredOrgs().map((o) => o.login));
    props.onChange(props.selected.filter((l) => !visible.has(l)));
  }

  const allVisibleSelected = () => {
    const visible = filteredOrgs();
    return visible.length > 0 && visible.every((o) => isSelected(o.login));
  };

  return (
    <div class="flex flex-col gap-4">
      <div class="flex items-center justify-between gap-3">
        <FilterInput
          placeholder="Filter orgs..."
          onFilter={setFilter}
        />
        <div class="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={selectAll}
            disabled={allVisibleSelected() || filteredOrgs().length === 0}
            class="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            Select All
          </button>
          <button
            type="button"
            onClick={deselectAll}
            disabled={props.selected.length === 0}
            class="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            Deselect All
          </button>
        </div>
      </div>

      <Show when={orgs.loading}>
        <div class="flex justify-center py-8">
          <LoadingSpinner label="Loading organizations..." />
        </div>
      </Show>

      <Show when={orgs.error}>
        <div class="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400">
          Failed to load organizations. Please check your connection and try again.
        </div>
      </Show>

      <Show when={!orgs.loading && !orgs.error}>
        <Show
          when={filteredOrgs().length > 0}
          fallback={
            <p class="py-4 text-center text-sm text-gray-500 dark:text-gray-400">
              No organizations match your filter.
            </p>
          }
        >
          <ul class="divide-y divide-gray-100 overflow-hidden rounded-lg border border-gray-200 dark:divide-gray-700 dark:border-gray-700">
            <For each={filteredOrgs()}>
              {(org) => {
                return (
                  <li>
                    <label class="flex cursor-pointer items-center gap-3 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800/50">
                      <input
                        type="checkbox"
                        checked={isSelected(org.login)}
                        onChange={() => toggleOrg(org.login)}
                        class="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:focus:ring-blue-400"
                      />
                      <img
                        src={org.avatarUrl}
                        alt=""
                        class="h-7 w-7 rounded-full"
                        aria-hidden="true"
                      />
                      <span class="flex-1 text-sm font-medium text-gray-900 dark:text-gray-100">
                        {org.login}
                      </span>
                      <span class="text-xs text-gray-400 dark:text-gray-500">
                        {org.type === "user" ? "Personal" : "Org"}
                      </span>
                    </label>
                  </li>
                );
              }}
            </For>
          </ul>
        </Show>

        <Show when={(orgs() ?? []).length > 0}>
          <p class="text-xs text-gray-500 dark:text-gray-400">
            {props.selected.length} of {(orgs() ?? []).length} selected
          </p>
        </Show>
      </Show>
    </div>
  );
}
