import { For, Show } from "solid-js";

interface RoleBadgeProps {
  roles: ("author" | "reviewer" | "assignee" | "involved")[];
}

const ROLE_CONFIG = {
  author: {
    label: "Author",
    class: "badge badge-primary badge-sm",
  },
  reviewer: {
    label: "Reviewer",
    class: "badge badge-secondary badge-sm",
  },
  assignee: {
    label: "Assignee",
    class: "badge badge-accent badge-sm",
  },
  involved: {
    label: "Involved",
    class: "badge badge-ghost badge-sm",
  },
} as const;

export default function RoleBadge(props: RoleBadgeProps) {
  return (
    <Show when={props.roles.length > 0}>
      <span class="flex items-center gap-1">
        <For each={props.roles}>
          {(role) => (
            <span class={ROLE_CONFIG[role].class}>
              {ROLE_CONFIG[role].label}
            </span>
          )}
        </For>
      </span>
    </Show>
  );
}
