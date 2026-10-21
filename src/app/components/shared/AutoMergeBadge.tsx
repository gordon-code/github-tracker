import { Show } from "solid-js";
import type { AutoMergeMethod } from "../../services/api";
import { Tooltip } from "./Tooltip";

export interface AutoMergeBadgeProps {
  method?: AutoMergeMethod | null;
  compact?: boolean;
}

export default function AutoMergeBadge(props: AutoMergeBadgeProps) {
  return (
    <Show when={props.method ?? null}>
      {(method) => (
        <Tooltip content={`Auto-merge enabled (${method().toLowerCase()})`} focusable>
          <span
            data-testid="auto-merge-badge"
            aria-label={`Auto-merge enabled (${method().toLowerCase()})`}
            class={`badge badge-info badge-outline font-mono ${props.compact ? "badge-xs" : "badge-sm"}`}
          >
            auto
          </span>
        </Tooltip>
      )}
    </Show>
  );
}
