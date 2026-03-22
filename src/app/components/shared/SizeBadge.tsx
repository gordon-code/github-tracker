import { Show } from "solid-js";
import { prSizeCategory } from "../../lib/format";

interface SizeBadgeProps {
  additions: number;
  deletions: number;
  changedFiles: number;
  category?: "XS" | "S" | "M" | "L" | "XL";
}

const SIZE_CONFIG = {
  XS: "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300",
  S: "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300",
  M: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300",
  L: "bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300",
  XL: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
} as const;

export default function SizeBadge(props: SizeBadgeProps) {
  const size = () => props.category ?? prSizeCategory(props.additions, props.deletions);

  return (
    <Show when={props.additions + props.deletions > 0 || props.changedFiles > 0}>
      <span class="flex items-center gap-1 text-xs">
        <span class={`inline-flex items-center rounded-full px-2 py-0.5 font-medium ${SIZE_CONFIG[size()]}`}>
          {size()}
        </span>
        <span class="text-green-600">+{props.additions}</span>
        <span class="text-red-600">-{props.deletions}</span>
        <span class="text-gray-500 dark:text-gray-400">{props.changedFiles} {props.changedFiles === 1 ? "file" : "files"}</span>
      </span>
    </Show>
  );
}
