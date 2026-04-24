import { Show } from "solid-js";
import type { JiraIssue } from "../../../shared/jira-types";

interface JiraBadgeProps {
  issueKey: string;
  issue: JiraIssue | null | undefined;
  siteUrl: string;
}

function statusCategoryClass(key: string): string {
  switch (key) {
    case "new": return "badge-info";
    case "indeterminate": return "badge-warning";
    case "done": return "badge-success";
    default: return "badge-ghost";
  }
}

export default function JiraBadge(props: JiraBadgeProps) {
  return (
    <Show when={props.issue !== undefined} fallback={null}>
      <Show
        when={props.issue !== null}
        fallback={
          <span class="badge badge-xs badge-ghost font-mono text-[10px]">
            {props.issueKey}
          </span>
        }
      >
        {/* props.issue is JiraIssue here */}
        <a
          href={`${props.siteUrl}/browse/${props.issueKey}`}
          target="_blank"
          rel="noopener noreferrer"
          class={`badge badge-xs font-mono text-[10px] no-underline ${statusCategoryClass(props.issue!.fields.status.statusCategory.key)}`}
          title={`${props.issueKey}: ${props.issue!.fields.status.name}`}
        >
          {props.issueKey}
        </a>
      </Show>
    </Show>
  );
}
