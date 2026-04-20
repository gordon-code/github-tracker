import RepoGitHubLink from "./RepoGitHubLink";
import RepoLockControls from "./RepoLockControls";

export default function EmptyLockedRepoRow(props: {
  repoFullName: string;
  section: "issues" | "pulls" | "actions";
}) {
  return (
    <div
      class="group/repo-header flex items-center border-y border-base-300 bg-base-200/30 opacity-40"
      data-repo-group={props.repoFullName}
    >
      <span class="flex-1 flex items-center gap-2 px-4 py-1.5 compact:py-0.5">
        <span class="h-3.5 w-3.5 shrink-0" />
        <span class="text-sm text-base-content/60">{props.repoFullName}</span>
      </span>
      <RepoGitHubLink repoFullName={props.repoFullName} section={props.section} />
      <RepoLockControls repoFullName={props.repoFullName} />
    </div>
  );
}
