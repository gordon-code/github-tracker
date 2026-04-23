import { Show } from "solid-js";
import { prSizeCategory } from "../../lib/format";
import { Tooltip } from "./Tooltip";

interface SizeBadgeProps {
  additions: number;
  deletions: number;
  changedFiles: number;
  category?: "XS" | "S" | "M" | "L" | "XL" | "XXL";
  filesUrl?: string;
}

const SIZE_CONFIG = {
  XS: "badge badge-success badge-sm",
  S: "badge badge-success badge-sm",
  M: "badge badge-warning badge-sm",
  L: "badge badge-error badge-sm",
  XL: "badge badge-error badge-sm",
  XXL: "badge badge-error badge-sm",
} as const;

const SIZE_TOOLTIP: Record<"XS" | "S" | "M" | "L" | "XL" | "XXL", string> = {
  XS: "XS: <10 lines changed",
  S: "S: 10–29 lines changed",
  M: "M: 30–99 lines changed",
  L: "L: 100–499 lines changed",
  XL: "XL: 500–999 lines changed",
  XXL: "XXL: 1000+ lines changed",
};

export default function SizeBadge(props: SizeBadgeProps) {
  const size = () => props.category ?? prSizeCategory(props.additions, props.deletions);

  return (
    <Show when={props.additions + props.deletions > 0 || props.changedFiles > 0}>
      <span class="flex items-center gap-1 text-xs">
        <Tooltip content={SIZE_TOOLTIP[size()]} focusable={!props.filesUrl}>
          <span class={SIZE_CONFIG[size()]}>
            {size()}
          </span>
        </Tooltip>
        <Show when={props.filesUrl} fallback={
          <>
            <span class="text-success">+{props.additions}</span>
            <span class="text-error">-{props.deletions}</span>
            <span class="text-base-content/50">{props.changedFiles} {props.changedFiles === 1 ? "file" : "files"}</span>
          </>
        }>
          {(url) => (
            <a
              href={url()}
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex items-center gap-1 hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              <span class="text-success">+{props.additions}</span>
              <span class="text-error">-{props.deletions}</span>
              <span class="text-base-content/50">{props.changedFiles} {props.changedFiles === 1 ? "file" : "files"}</span>
            </a>
          )}
        </Show>
      </span>
    </Show>
  );
}
