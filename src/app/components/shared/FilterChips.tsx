import { For, Show } from "solid-js";

export interface FilterChipGroupDef {
  label: string;
  field: string;
  options: { value: string; label: string }[];
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
    props.groups.some((g) => props.values[g.field] !== "all" && props.values[g.field] !== undefined);

  return (
    <div class="flex flex-wrap items-center gap-3">
      <For each={props.groups}>
        {(group) => {
          const current = () => props.values[group.field] ?? "all";
          const isActive = () => current() !== "all";

          return (
            <div class="flex items-center gap-1">
              <span class="text-xs text-gray-500 dark:text-gray-400 mr-1">{group.label}:</span>
              <div role="group" aria-label={group.label}>
                <button
                  type="button"
                  onClick={() => props.onChange(group.field, "all")}
                  aria-pressed={current() === "all"}
                  class={`rounded-full text-xs px-2 py-0.5 cursor-pointer transition-colors ${
                    current() === "all"
                      ? "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300"
                      : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                  }`}
                >
                  All
                </button>
                <For each={group.options}>
                  {(opt) => (
                    <button
                      type="button"
                      onClick={() => props.onChange(group.field, opt.value)}
                      aria-pressed={current() === opt.value}
                      class={`rounded-full text-xs px-2 py-0.5 cursor-pointer transition-colors ${
                        current() === opt.value
                          ? "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300"
                          : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
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
                  class="text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 ml-0.5"
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
          class="text-xs text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
        >
          Reset all
        </button>
      </Show>
    </div>
  );
}
