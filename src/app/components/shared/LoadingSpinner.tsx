interface LoadingSpinnerProps {
  size?: "sm" | "md" | "lg";
  label?: string;
}

const sizeClasses = {
  sm: "loading-sm",
  md: "loading-md",
  lg: "loading-lg",
};

export default function LoadingSpinner(props: LoadingSpinnerProps) {
  const size = () => props.size ?? "md";

  return (
    <div class="flex flex-col items-center gap-2" role="status" aria-label={props.label ?? "Loading"}>
      <span class={`loading loading-spinner ${sizeClasses[size()]}`} aria-hidden="true" />
      {props.label && (
        <span class="text-sm text-base-content/60">
          {props.label}
        </span>
      )}
    </div>
  );
}
