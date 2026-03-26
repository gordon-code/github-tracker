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
            class="btn btn-ghost btn-xs"
          >
            Select All
          </button>
          <button
            type="button"
            onClick={deselectAll}
            disabled={props.selected.length === 0}
            class="btn btn-ghost btn-xs"
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
        <div class="alert alert-error text-sm">
          Failed to load organizations. Please check your connection and try again.
        </div>
      </Show>

      <Show when={!orgs.loading && !orgs.error}>
        <Show
          when={filteredOrgs().length > 0}
          fallback={
            <p class="py-4 text-center text-sm text-base-content/60">
              No organizations match your filter.
            </p>
          }
        >
          <ul class="divide-y divide-base-300 overflow-hidden rounded-lg border border-base-300">
            <For each={filteredOrgs()}>
              {(org) => {
                return (
                  <li>
                    <label class="flex cursor-pointer items-center gap-3 px-4 py-3 hover:bg-base-200">
                      <input
                        type="checkbox"
                        checked={isSelected(org.login)}
                        onChange={() => toggleOrg(org.login)}
                        class="checkbox checkbox-primary checkbox-sm"
                      />
                      <img
                        src={org.avatarUrl}
                        alt=""
                        class="h-7 w-7 rounded-full"
                        aria-hidden="true"
                      />
                      <span class="flex-1 text-sm font-medium text-base-content">
                        {org.login}
                      </span>
                      <span class="text-xs text-base-content/40">
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
          <p class="text-xs text-base-content/60">
            {props.selected.length} of {(orgs() ?? []).length} selected
          </p>
        </Show>
      </Show>
    </div>
  );
}
