export interface StatusDotProps {
  status: "success" | "pending" | "failure" | "error" | null;
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
    bg: "bg-error",
    label: "Checks failing",
    pulse: false,
  },
  error: {
    bg: "bg-error",
    label: "Checks failing",
    pulse: false,
  },
} as const;

export default function StatusDot(props: StatusDotProps) {
  const cfg = () =>
    props.status !== null
      ? STATUS_CONFIG[props.status]
      : { bg: "bg-base-300", label: "No checks", pulse: false };

  return (
    <span
      class="relative inline-flex items-center justify-center"
      style={{ width: "12px", height: "12px" }}
      title={cfg().label}
      aria-label={cfg().label}
    >
      {cfg().pulse && (
        <span
          class={`absolute inline-flex h-full w-full rounded-full ${cfg().bg} animate-slow-pulse`}
        />
      )}
      <span
        class={`relative inline-flex rounded-full ${cfg().bg}`}
        style={{ width: "8px", height: "8px" }}
      />
    </span>
  );
}
