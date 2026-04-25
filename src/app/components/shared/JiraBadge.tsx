import { Show } from "solid-js";
import type { JiraIssue } from "../../../shared/jira-types";
import { jiraStatusCategoryClass } from "../../lib/format";
import { isSafeJiraSiteUrl } from "../../lib/url";
import { Tooltip } from "./Tooltip";

interface JiraBadgeProps {
  issueKey: string;
  issue: JiraIssue | null | undefined;
  siteUrl: string;
  source?: "title" | "branch" | "title & branch";
}

export default function JiraBadge(props: JiraBadgeProps) {
  const tooltipContent = () => {
    const parts: string[] = [props.issueKey];
    if (props.issue) parts[0] += `: ${props.issue.fields.status.name}`;
    if (props.issue?.fields.summary) parts.push(props.issue.fields.summary);
    if (props.source) parts.push(`from: ${props.source}`);
    return parts.join("\n");
  };

  return (
    <Show when={props.issue !== undefined} fallback={null}>
      <Tooltip content={tooltipContent()} focusable>
        <Show
          when={props.issue ?? undefined}
          fallback={
            <span class="badge badge-xs badge-ghost font-mono text-[10px]">
              {props.issueKey}
            </span>
          }
        >
          {(issue) => (
            <a
              href={isSafeJiraSiteUrl(props.siteUrl) ? `${props.siteUrl}/browse/${props.issueKey}` : "#"}
              target="_blank"
              rel="noopener noreferrer"
              class={`badge badge-xs font-mono text-[10px] no-underline ${jiraStatusCategoryClass(issue().fields.status.statusCategory.key)}`}
            >
              {props.issueKey}
            </a>
          )}
        </Show>
      </Tooltip>
    </Show>
  );
}
