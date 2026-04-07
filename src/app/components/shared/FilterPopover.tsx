import { createSignal, For, Show } from "solid-js";
import { Popover } from "@kobalte/core/popover";
import type { FilterChipGroupDef } from "./filterTypes";

interface FilterPopoverProps {
  group: FilterChipGroupDef;
  value: string;
  onChange: (field: string, value: string) => void;
}

export default function FilterPopover(props: FilterPopoverProps) {
  const [open, setOpen] = createSignal(false);

  const isDefault = () =>
    props.value === (props.group.defaultValue ?? "all");

  const activeLabel = () => {
    const opt = props.group.options.find((o) => o.value === props.value);
    if (opt) return opt.label;
    return props.value === "all" ? "All" : props.value;
  };

  return (
    <Popover open={open()} onOpenChange={setOpen} placement="bottom-end">
      <Popover.Trigger
        as="button"
        type="button"
        aria-label={`Filter by ${props.group.label}`}
        class={`btn btn-sm ${isDefault() ? "btn-ghost" : "btn-primary"}`}
      >
        <Show when={isDefault()} fallback={<>{props.group.label}: {activeLabel()}</>}>
          {props.group.label}
        </Show>
        <svg
          class="ml-1 h-3 w-3 inline-block"
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
        >
          <path
            fill-rule="evenodd"
            d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
            clip-rule="evenodd"
          />
        </svg>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content class="filter-popover-content bg-base-100 border border-base-300 rounded-lg shadow-lg z-50 p-2 min-w-40 max-h-64 overflow-y-auto">
          <Show when={!props.group.defaultValue}>
            <button
              type="button"
              class={`w-full text-left px-3 py-1.5 rounded hover:bg-base-200 text-sm ${props.value === "all" || props.value === undefined ? "font-medium" : ""}`}
              onClick={() => {
                props.onChange(props.group.field, "all");
                setOpen(false);
              }}
            >
              {(props.value === "all" || props.value === undefined) && "✓ "}All
            </button>
          </Show>
          <For each={props.group.options}>
            {(opt) => (
              <button
                type="button"
                class="w-full text-left px-3 py-1.5 rounded hover:bg-base-200 text-sm"
                onClick={() => {
                  props.onChange(props.group.field, opt.value);
                  setOpen(false);
                }}
              >
                {props.value === opt.value && "✓ "}{opt.label}
              </button>
            )}
          </For>
        </Popover.Content>
      </Popover.Portal>
    </Popover>
  );
}
