import { For, Show } from "solid-js";

interface RoleBadgeProps {
  roles: ("author" | "reviewer" | "assignee")[];
}

const ROLE_CONFIG = {
  author: {
    label: "Author",
    class: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
  },
  reviewer: {
    label: "Reviewer",
    class: "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300",
  },
  assignee: {
    label: "Assignee",
    class: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900 dark:text-cyan-300",
  },
} as const;

export default function RoleBadge(props: RoleBadgeProps) {
  return (
    <Show when={props.roles.length > 0}>
      <span class="flex items-center gap-1">
        <For each={props.roles}>
          {(role) => (
            <span class={`inline-flex items-center rounded-full text-xs px-2 py-0.5 font-medium ${ROLE_CONFIG[role].class}`}>
              {ROLE_CONFIG[role].label}
            </span>
          )}
        </For>
      </span>
    </Show>
  );
}
