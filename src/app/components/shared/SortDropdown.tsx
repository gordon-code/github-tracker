import { createMemo } from "solid-js";
import { Select } from "@kobalte/core/select";

export interface SortOption {
  label: string;
  field: string;
  type: "date" | "text" | "number" | "priority" | "status";
  preferredDirection?: "asc" | "desc";
}

interface SortDropdownProps {
  options: SortOption[];
  value: string;
  direction: "asc" | "desc";
  onChange: (field: string, direction: "asc" | "desc") => void;
}

interface FlatOption {
  value: string;
  label: string;
}

function suffixFor(type: SortOption["type"], dir: "asc" | "desc"): string {
  if (type === "date") return dir === "desc" ? "(newest first)" : "(oldest first)";
  if (type === "text") return dir === "asc" ? "(A-Z)" : "(Z-A)";
  if (type === "priority") return dir === "asc" ? "(highest first)" : "(lowest first)";
  if (type === "status") return dir === "asc" ? "(To Do → Done)" : "(Done → To Do)";
  return dir === "desc" ? "(most)" : "(fewest)";
}

export default function SortDropdown(props: SortDropdownProps) {
  const flatOptions = createMemo<FlatOption[]>(() =>
    props.options.flatMap((opt) => {
      const first = opt.preferredDirection ?? "desc";
      const second = first === "desc" ? "asc" : "desc";
      return [
        { value: `${opt.field}:${first}`, label: `${opt.label} ${suffixFor(opt.type, first)}` },
        { value: `${opt.field}:${second}`, label: `${opt.label} ${suffixFor(opt.type, second)}` },
      ];
    })
  );

  const selected = () => `${props.value}:${props.direction}`;

  function handleChange(val: string | null) {
    if (!val) return;
    const lastColon = val.lastIndexOf(":");
    const field = val.slice(0, lastColon);
    const dir = val.slice(lastColon + 1) as "asc" | "desc";
    props.onChange(field, dir);
  }

  return (
    <Select
      options={flatOptions()}
      optionValue="value"
      optionTextValue="label"
      value={flatOptions().find((o) => o.value === selected()) ?? null}
      onChange={(opt) => handleChange(opt?.value ?? null)}
      itemComponent={(itemProps) => (
        <Select.Item
          item={itemProps.item}
          class="px-3 py-2 cursor-pointer hover:bg-base-200 data-[highlighted]:bg-base-200 outline-none"
        >
          <Select.ItemLabel>{itemProps.item.rawValue.label}</Select.ItemLabel>
        </Select.Item>
      )}
    >
      <Select.Trigger
        aria-label="Sort by"
        class="btn btn-outline btn-sm compact:btn-xs w-auto min-w-[180px] justify-between"
      >
        <Select.Value<FlatOption>>{(state) => state.selectedOption()?.label ?? "Sort by"}</Select.Value>
        <Select.Icon class="ml-2">▾</Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content class="bg-base-100 border border-base-300 rounded-lg shadow-lg z-50 py-1">
          <Select.Listbox />
        </Select.Content>
      </Select.Portal>
    </Select>
  );
}
