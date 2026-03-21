export default function SortIcon(props: { active: boolean; direction: "asc" | "desc" }) {
  return (
    <span
      class={`inline-block ml-1 transition-opacity ${props.active ? "opacity-100" : "opacity-30"}`}
      aria-hidden="true"
    >
      {props.direction === "asc" || !props.active ? "↑" : "↓"}
    </span>
  );
}
