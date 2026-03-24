export default function ChevronIcon(props: { size: "sm" | "md"; rotated: boolean }) {
  const sizeClass = () => (props.size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5");
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      class={`${sizeClass()} text-gray-400 transition-transform ${props.rotated ? "-rotate-90" : ""}`}
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        fill-rule="evenodd"
        d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
        clip-rule="evenodd"
      />
    </svg>
  );
}
