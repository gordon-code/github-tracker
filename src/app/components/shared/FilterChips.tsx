import { For, Show } from "solid-js";

export interface FilterChipGroupDef {
  label: string;
  field: string;
  options: { value: string; label: string }[];
  defaultValue?: string; // When set, replaces "all" as the "no filter active" value
}

interface FilterChipsProps {
  groups: FilterChipGroupDef[];
  values: Record<string, string>;
  onChange: (field: string, value: string) => void;
  onReset: (field: string) => void;
  onResetAll: () => void;
}

export default function FilterChips(props: FilterChipsProps) {
  const hasActiveFilter = () =>
    props.groups.some((g) => props.values[g.field] !== undefined && props.values[g.field] !== (g.defaultValue ?? "all"));

  return (
    <div class="flex flex-wrap items-center gap-3">
      <For each={props.groups}>
        {(group) => {
          const current = () => props.values[group.field] ?? (group.defaultValue ?? "all");
          const isActive = () => current() !== (group.defaultValue ?? "all");

          return (
            <div class="flex items-center gap-1">
              <span class="text-xs text-base-content/50 mr-1">{group.label}:</span>
              <div role="group" aria-label={group.label}>
                <Show when={!group.defaultValue}>
                  <button
                    type="button"
                    onClick={() => props.onChange(group.field, "all")}
                    aria-pressed={current() === "all"}
                    class={`badge cursor-pointer transition-colors ${
                      current() === "all"
                        ? "badge-primary"
                        : "badge-ghost"
                    }`}
                  >
                    All
                  </button>
                </Show>
                <For each={group.options}>
                  {(opt) => (
                    <button
                      type="button"
                      onClick={() => props.onChange(group.field, opt.value)}
                      aria-pressed={current() === opt.value}
                      class={`badge cursor-pointer transition-colors ${
                        current() === opt.value
                          ? "badge-primary"
                          : "badge-ghost"
                      }`}
                    >
                      {opt.label}
                    </button>
                  )}
                </For>
              </div>
              <Show when={isActive()}>
                <button
                  type="button"
                  onClick={() => props.onReset(group.field)}
                  aria-label={`Reset ${group.label} filter`}
                  class="btn btn-ghost btn-xs ml-0.5"
                >
                  ×
                </button>
              </Show>
            </div>
          );
        }}
      </For>
      <Show when={hasActiveFilter()}>
        <button
          type="button"
          onClick={props.onResetAll}
          class="btn btn-ghost btn-xs"
        >
          Reset all
        </button>
      </Show>
    </div>
  );
}
