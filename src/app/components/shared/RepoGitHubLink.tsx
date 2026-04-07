import ExternalLinkIcon from "./ExternalLinkIcon";
import { Tooltip } from "./Tooltip";

const sectionLabels = {
  issues: "issues",
  pulls: "pull requests",
  actions: "actions",
} as const;

export default function RepoGitHubLink(props: {
  repoFullName: string;
  section: "issues" | "pulls" | "actions";
}) {
  const label = () => sectionLabels[props.section];

  return (
    <Tooltip content={`Open ${props.repoFullName} ${label()} on GitHub`}>
      <a
        href={`https://github.com/${props.repoFullName}/${props.section}`}
        target="_blank"
        rel="noopener noreferrer"
        class="opacity-0 group-hover/repo-header:opacity-100 focus-visible:opacity-100 transition-opacity text-base-content/40 hover:text-primary px-1"
        aria-label={`Open ${props.repoFullName} ${label()} on GitHub`}
      >
        <ExternalLinkIcon />
      </a>
    </Tooltip>
  );
}
