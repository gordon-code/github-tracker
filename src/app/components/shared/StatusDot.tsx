export interface StatusDotProps {
  status: "success" | "pending" | "failure" | "error" | null;
}

const STATUS_CONFIG = {
  success: {
    bg: "bg-green-500",
    label: "All checks passed",
    pulse: false,
  },
  pending: {
    bg: "bg-yellow-500",
    label: "Checks pending",
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
} as const;

export default function StatusDot(props: StatusDotProps) {
  const cfg = () =>
    props.status !== null
      ? STATUS_CONFIG[props.status]
      : { bg: "bg-gray-300", label: "No checks", pulse: false };

  return (
    <span
      class="relative inline-flex items-center justify-center"
      style={{ width: "12px", height: "12px" }}
      title={cfg().label}
      aria-label={cfg().label}
    >
      {cfg().pulse && (
        <span
          class={`absolute inline-flex h-full w-full rounded-full ${cfg().bg} opacity-75 animate-ping`}
        />
      )}
      <span
        class={`relative inline-flex rounded-full ${cfg().bg}`}
        style={{ width: "8px", height: "8px" }}
      />
    </span>
  );
}
