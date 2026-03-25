import { For } from "solid-js";

export interface SortOption {
  label: string;
  field: string;
  type: "date" | "text" | "number";
}

interface SortDropdownProps {
  options: SortOption[];
  value: string;
  direction: "asc" | "desc";
  onChange: (field: string, direction: "asc" | "desc") => void;
}

function suffixFor(type: SortOption["type"], dir: "asc" | "desc"): string {
  if (type === "date") return dir === "desc" ? "(newest first)" : "(oldest first)";
  if (type === "text") return dir === "asc" ? "(A-Z)" : "(Z-A)";
  return dir === "desc" ? "(most)" : "(fewest)";
}

export default function SortDropdown(props: SortDropdownProps) {
  const selected = () => `${props.value}:${props.direction}`;

  function handleChange(e: Event) {
    const val = (e.currentTarget as HTMLSelectElement).value;
    const lastColon = val.lastIndexOf(":");
    const field = val.slice(0, lastColon);
    const dir = val.slice(lastColon + 1) as "asc" | "desc";
    props.onChange(field, dir);
  }

  return (
    <select
      aria-label="Sort by"
      value={selected()}
      onChange={handleChange}
      class="text-sm rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
    >
      <For each={props.options}>
        {(opt) => (
          <>
            <option value={`${opt.field}:desc`}>
              {opt.label} {suffixFor(opt.type, "desc")}
            </option>
            <option value={`${opt.field}:asc`}>
              {opt.label} {suffixFor(opt.type, "asc")}
            </option>
          </>
        )}
      </For>
    </select>
  );
}
