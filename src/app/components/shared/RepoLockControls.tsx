import { Show, createMemo } from "solid-js";
import { viewState, lockRepo, unlockRepo, moveLockedRepo, type LockedReposTab } from "../../stores/view";

interface RepoLockControlsProps {
  tab: LockedReposTab;
  repoFullName: string;
}

export default function RepoLockControls(props: RepoLockControlsProps) {
  const lockInfo = createMemo(() => {
    const list = viewState.lockedRepos[props.tab];
    const idx = list.indexOf(props.repoFullName);
    return {
      isLocked: idx !== -1,
      isFirst: idx === 0,
      isLast: idx === list.length - 1,
    };
  });

  return (
    <div class="flex items-center gap-0.5 pr-2" onClick={(e) => e.stopPropagation()}>
      <Show
        when={lockInfo().isLocked}
        fallback={
          <button
            class="btn btn-ghost btn-xs opacity-0 group-hover/repo-header:opacity-100 max-sm:opacity-60 sm:max-lg:opacity-60 transition-opacity"
            onClick={() => lockRepo(props.tab, props.repoFullName)}
            title="Pin this repo to top of list"
            aria-label={`Pin ${props.repoFullName} to top of list`}
          >
            {/* Heroicons 20px solid: lock-open */}
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="h-4 w-4 text-base-content/40">
              <path d="M14.5 1A4.5 4.5 0 0010 5.5V9H3a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-1.5V5.5a3 3 0 116 0v2.75a.75.75 0 001.5 0V5.5A4.5 4.5 0 0014.5 1z" />
            </svg>
          </button>
        }
      >
        <button
          class="btn btn-ghost btn-xs"
          onClick={() => unlockRepo(props.tab, props.repoFullName)}
          title="Pinned to top. Click to unpin."
          aria-label={`Unpin ${props.repoFullName}`}
        >
          {/* Heroicons 20px solid: lock-closed */}
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="h-4 w-4 text-primary">
            <path fill-rule="evenodd" d="M10 1a4.5 4.5 0 00-4.5 4.5V9H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-.5V5.5A4.5 4.5 0 0010 1zm3 8V5.5a3 3 0 10-6 0V9h6z" clip-rule="evenodd" />
          </svg>
        </button>
        <button
          class="btn btn-ghost btn-xs"
          onClick={() => moveLockedRepo(props.tab, props.repoFullName, "up")}
          disabled={lockInfo().isFirst}
          aria-label={`Move ${props.repoFullName} up`}
        >
          {/* Heroicons 20px solid: chevron-up */}
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="h-3.5 w-3.5">
            <path fill-rule="evenodd" d="M14.77 12.79a.75.75 0 01-1.06-.02L10 8.832 6.29 12.77a.75.75 0 11-1.08-1.04l4.25-4.5a.75.75 0 011.08 0l4.25 4.5a.75.75 0 01-.02 1.06z" clip-rule="evenodd" />
          </svg>
        </button>
        <button
          class="btn btn-ghost btn-xs"
          onClick={() => moveLockedRepo(props.tab, props.repoFullName, "down")}
          disabled={lockInfo().isLast}
          aria-label={`Move ${props.repoFullName} down`}
        >
          {/* Heroicons 20px solid: chevron-down */}
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="h-3.5 w-3.5">
            <path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd" />
          </svg>
        </button>
      </Show>
    </div>
  );
}
