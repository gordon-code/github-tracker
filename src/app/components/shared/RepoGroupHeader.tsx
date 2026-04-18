import { Show, type JSX } from "solid-js";
import ChevronIcon from "./ChevronIcon";
import { formatStarCount } from "../../lib/format";

interface RepoGroupHeaderProps {
  repoFullName: string;
  starCount?: number | null;
  isExpanded: boolean;
  isHighlighted?: boolean;
  onToggle: () => void;
  collapsedSummary?: JSX.Element;
  trailing?: JSX.Element;
  badges?: JSX.Element;
}

export default function RepoGroupHeader(props: RepoGroupHeaderProps) {
  return (
    <div class={`group/repo-header flex items-center bg-info/5 border-y border-base-300 hover:bg-info/10 transition-colors duration-300 ${props.isHighlighted ? "animate-reorder-highlight" : ""}`}>
      <button
        onClick={() => props.onToggle()}
        aria-expanded={props.isExpanded}
        class="flex-1 flex items-center gap-2 px-4 py-2.5 compact:py-1.5 text-left text-base compact:text-sm font-bold repo-header-text"
      >
        <ChevronIcon size="md" rotated={!props.isExpanded} />
        {props.repoFullName}
        {props.badges}
        <Show when={props.starCount != null && props.starCount > 0}>
          <span class="text-xs text-base-content/50 font-normal" aria-label={`${props.starCount} stars`}>
            <span aria-hidden="true">★</span> {formatStarCount(props.starCount!)}
          </span>
        </Show>
        <Show when={!props.isExpanded}>
          {props.collapsedSummary}
        </Show>
      </button>
      {props.trailing}
    </div>
  );
}
