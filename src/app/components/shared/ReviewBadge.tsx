import { Show } from "solid-js";

interface ReviewBadgeProps {
  decision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
}

const REVIEW_CONFIG = {
  APPROVED: {
    label: "Approved",
    class: "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300",
  },
  CHANGES_REQUESTED: {
    label: "Changes",
    class: "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300",
  },
  REVIEW_REQUIRED: {
    label: "Review needed",
    class: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300",
  },
} as const;

export default function ReviewBadge(props: ReviewBadgeProps) {
  return (
    <Show when={props.decision !== null}>
      <span class={`inline-flex items-center rounded-full text-xs px-2 py-0.5 font-medium ${REVIEW_CONFIG[props.decision!].class}`}>
        {REVIEW_CONFIG[props.decision!].label}
      </span>
    </Show>
  );
}
