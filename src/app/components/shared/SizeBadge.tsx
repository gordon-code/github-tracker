import { Show } from "solid-js";
import { prSizeCategory } from "../../lib/format";

interface SizeBadgeProps {
  additions: number;
  deletions: number;
  changedFiles: number;
  category?: "XS" | "S" | "M" | "L" | "XL";
}

const SIZE_CONFIG = {
  XS: "badge badge-success badge-sm",
  S: "badge badge-success badge-sm",
  M: "badge badge-warning badge-sm",
  L: "badge badge-error badge-sm",
  XL: "badge badge-error badge-sm",
} as const;

export default function SizeBadge(props: SizeBadgeProps) {
  const size = () => props.category ?? prSizeCategory(props.additions, props.deletions);

  return (
    <Show when={props.additions + props.deletions > 0 || props.changedFiles > 0}>
      <span class="flex items-center gap-1 text-xs">
        <span class={SIZE_CONFIG[size()]}>
          {size()}
        </span>
        <span class="text-success">+{props.additions}</span>
        <span class="text-error">-{props.deletions}</span>
        <span class="text-base-content/50">{props.changedFiles} {props.changedFiles === 1 ? "file" : "files"}</span>
      </span>
    </Show>
  );
}
