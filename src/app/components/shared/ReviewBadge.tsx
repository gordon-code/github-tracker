import { Show } from "solid-js";

interface ReviewBadgeProps {
  decision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
}

const REVIEW_CONFIG = {
  APPROVED: {
    label: "Approved",
    class: "badge badge-success badge-sm",
  },
  CHANGES_REQUESTED: {
    label: "Changes",
    class: "badge badge-warning badge-sm",
  },
  REVIEW_REQUIRED: {
    label: "Review needed",
    class: "badge badge-info badge-sm",
  },
} as const;

export default function ReviewBadge(props: ReviewBadgeProps) {
  return (
    <Show when={props.decision !== null}>
      <span class={REVIEW_CONFIG[props.decision!].class}>
        {REVIEW_CONFIG[props.decision!].label}
      </span>
    </Show>
  );
}
