import { createMemo, For, Show } from "solid-js";
import FilterPopover from "./FilterPopover";
import ScopeToggle from "./ScopeToggle";
import { Tooltip } from "./Tooltip";
import { scopeFilterGroup } from "./filterTypes";
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
        <Tooltip content="Toggle between your activity and all activity">
          <ScopeToggle
            value={props.values["scope"] ?? scopeFilterGroup.defaultValue ?? "all"}
            onChange={props.onChange}
          />
        </Tooltip>
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
        <Tooltip content="Reset all filters to defaults">
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            onClick={props.onResetAll}
          >
            Reset all
          </button>
        </Tooltip>
      </Show>
    </div>
  );
}
