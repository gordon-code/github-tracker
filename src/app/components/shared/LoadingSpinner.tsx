interface LoadingSpinnerProps {
  size?: "sm" | "md" | "lg";
  label?: string;
}

const sizeClasses = {
  sm: "h-4 w-4",
  md: "h-8 w-8",
  lg: "h-12 w-12",
};

export default function LoadingSpinner(props: LoadingSpinnerProps) {
  const size = () => props.size ?? "md";

  return (
    <div class="flex flex-col items-center gap-2" role="status">
      <svg
        class={`animate-spin text-gray-400 dark:text-gray-500 ${sizeClasses[size()]}`}
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <circle
          class="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          stroke-width="4"
        />
        <path
          class="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
        />
      </svg>
      {props.label && (
        <span class="text-sm text-gray-500 dark:text-gray-400">
          {props.label}
        </span>
      )}
    </div>
  );
}
