import { Show } from "solid-js";
import { Tooltip } from "./Tooltip";

export interface StatusDotProps {
  status: "success" | "pending" | "failure" | "error" | "conflict" | null;
  href?: string;
}

const STATUS_CONFIG = {
  success: {
    bg: "bg-success",
    label: "All checks passed",
    pulse: false,
  },
  pending: {
    bg: "bg-warning",
    label: "Checks in progress",
    pulse: true,
  },
  failure: {
    bg: "bg-red-500",
    label: "Checks failing",
    pulse: false,
  },
  error: {
    bg: "bg-red-500",
    label: "Checks failing",
    pulse: false,
  },
  conflict: {
    bg: "bg-warning/60",
    label: "Checks blocked by merge conflict",
    pulse: false,
  },
} as const;

export default function StatusDot(props: StatusDotProps) {
  const cfg = () =>
    props.status !== null
      ? STATUS_CONFIG[props.status]
      : { bg: "bg-base-content/20", label: "No checks", pulse: false };

  const dot = () => (
    <span
      class={`relative inline-flex items-center justify-center w-3 h-3${props.href ? " cursor-pointer" : ""}`}
      aria-label={cfg().label}
    >
      <Show when={cfg().pulse}>
        <span
          class={`absolute inline-flex h-full w-full rounded-full ${cfg().bg} animate-slow-pulse`}
        />
      </Show>
      <span
        class={`relative inline-flex rounded-full w-2 h-2 ${cfg().bg}`}
      />
    </span>
  );

  return (
    <Tooltip content={cfg().label} focusable={!props.href}>
      <Show when={props.href} fallback={dot()}>
        {(url) => (
          <a
            href={url()}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
          >
            {dot()}
          </a>
        )}
      </Show>
    </Tooltip>
  );
}
