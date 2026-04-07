import { createMemo, For, Show } from "solid-js";
import FilterPopover from "./FilterPopover";
import ScopeToggle from "./ScopeToggle";
import type { FilterChipGroupDef } from "./filterTypes";

interface FilterToolbarProps {
  groups: FilterChipGroupDef[];
  values: Record<string, string>;
  onChange: (field: string, value: string) => void;
  onResetAll: () => void;
}

export default function FilterToolbar(props: FilterToolbarProps) {
  const showScope = createMemo(() => props.groups.some((g) => g.field === "scope"));

  const popoverGroups = createMemo(() =>
    showScope() ? props.groups.filter((g) => g.field !== "scope") : props.groups
  );

  const hasActiveFilter = createMemo(() =>
    props.groups.some((g) => {
      const val = props.values[g.field];
      return val !== undefined && val !== (g.defaultValue ?? "all");
    })
  );

  return (
    <div class="flex items-center gap-2 flex-wrap">
      <Show when={showScope()}>
        <ScopeToggle
          value={props.values["scope"] ?? "involves_me"}
          onChange={props.onChange}
        />
        <div class="w-px h-5 bg-base-300" />
      </Show>
      <For each={popoverGroups()}>
        {(group) => (
          <FilterPopover
            group={group}
            value={props.values[group.field] ?? (group.defaultValue ?? "all")}
            onChange={props.onChange}
          />
        )}
      </For>
      <Show when={hasActiveFilter()}>
        <button
          type="button"
          class="btn btn-ghost btn-xs"
          onClick={props.onResetAll}
        >
          Reset all
        </button>
      </Show>
    </div>
  );
}
