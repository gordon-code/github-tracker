import { For } from "solid-js";

export default function SkeletonRows(props: { count?: number; label?: string }) {
  const count = () => props.count ?? 5;
  return (
    <div
      class="flex flex-col gap-2 p-4"
      role="status"
      aria-label={props.label ?? "Loading"}
    >
      <For each={Array(count()).fill(null)}>
        {() => (
          <div class="flex items-center gap-3 animate-pulse">
            <div class="h-5 w-24 rounded-full bg-gray-200 dark:bg-gray-700" />
            <div class="h-4 flex-1 rounded bg-gray-200 dark:bg-gray-700" />
            <div class="h-4 w-16 rounded bg-gray-200 dark:bg-gray-700" />
          </div>
        )}
      </For>
    </div>
  );
}
