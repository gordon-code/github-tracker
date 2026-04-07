import { For, Show, Switch, Match, createMemo } from "solid-js";
import { config } from "../../stores/config";
import { viewState, ignoreItem, untrackItem, moveTrackedItem } from "../../stores/view";
import type { Issue, PullRequest } from "../../services/api";
import ItemRow from "./ItemRow";
import { Tooltip } from "../shared/Tooltip";

export interface TrackedTabProps {
  issues: Issue[];
  pullRequests: PullRequest[];
  refreshTick?: number;
}

export default function TrackedTab(props: TrackedTabProps) {
  const maps = createMemo(() => {
    const issueMap = new Map<number, Issue>();
    for (const issue of props.issues) {
      issueMap.set(issue.id, issue);
    }
    const prMap = new Map<number, PullRequest>();
    for (const pr of props.pullRequests) {
      prMap.set(pr.id, pr);
    }
    return { issueMap, prMap };
  });

  return (
    <div class="flex flex-col h-full">
      <Show
        when={viewState.trackedItems.length > 0}
        fallback={
          <div class="flex items-center justify-center py-16 text-center text-base-content/50 text-sm px-4">
            No tracked items. Pin issues or PRs from the Issues and Pull Requests tabs.
          </div>
        }
      >
        <div class="divide-y divide-base-300">
          <For each={viewState.trackedItems}>
            {(item, index) => {
              const liveData = () =>
                item.type === "issue"
                  ? maps().issueMap.get(item.id)
                  : maps().prMap.get(item.id);

              const isFirst = () => index() === 0;
              const isLast = () => index() === viewState.trackedItems.length - 1;

              return (
                <div class="flex items-center gap-1">
                  {/* Arrow buttons */}
                  <div class="flex flex-col shrink-0 pl-2">
                    <button
                      class="btn btn-ghost btn-xs"
                      disabled={isFirst()}
                      aria-label={`Move up: ${item.title}`}
                      onClick={() => moveTrackedItem(item.id, item.type, "up")}
                    >
                      ▲
                    </button>
                    <button
                      class="btn btn-ghost btn-xs"
                      disabled={isLast()}
                      aria-label={`Move down: ${item.title}`}
                      onClick={() => moveTrackedItem(item.id, item.type, "down")}
                    >
                      ▼
                    </button>
                  </div>

                  {/* Row content */}
                  <div class="flex-1 min-w-0">
                    <Show
                      when={liveData()}
                      fallback={
                        /* Fallback row when live data not found */
                        <div class="flex items-center gap-3 px-4 py-3 hover:bg-base-200 transition-colors">
                          <div class="flex-1 min-w-0">
                            <div class="flex items-center gap-2 flex-wrap">
                              <span class="font-medium text-sm text-base-content truncate">
                                {item.title}
                              </span>
                              <Switch>
                                <Match when={item.type === "issue"}>
                                  <span class="badge badge-outline badge-sm badge-info">Issue</span>
                                </Match>
                                <Match when={item.type === "pullRequest"}>
                                  <span class="badge badge-outline badge-sm badge-success">PR</span>
                                </Match>
                              </Switch>
                            </div>
                            <div class="text-xs text-base-content/60 mt-0.5">
                              {item.repoFullName}{" "}
                              <span class="text-base-content/40">(not in current data)</span>
                            </div>
                          </div>
                          <Tooltip content="Untrack this item">
                            <button
                              class="relative z-10 shrink-0 self-center rounded p-1 text-primary transition-opacity focus:outline-none focus:ring-2 focus:ring-primary"
                              aria-label={`Unpin #${item.number} ${item.title}`}
                              onClick={() => untrackItem(item.id, item.type)}
                            >
                            {/* Solid bookmark */}
                              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="h-4 w-4"><path fill-rule="evenodd" d="M6.32 2.577a49.255 49.255 0 0 1 11.36 0c1.497.174 2.57 1.46 2.57 2.93V21a.75.75 0 0 1-1.085.67L12 18.089l-7.165 3.583A.75.75 0 0 1 3.75 21V5.507c0-1.47 1.073-2.756 2.57-2.93Z" clip-rule="evenodd" /></svg>
                            </button>
                          </Tooltip>
                        </div>
                      }
                    >
                      {(live) => (
                        <ItemRow
                          hideRepo={false}
                          repo={live().repoFullName}
                          number={live().number}
                          title={live().title}
                          author={live().userLogin}
                          createdAt={live().createdAt}
                          updatedAt={live().updatedAt}
                          refreshTick={props.refreshTick}
                          url={live().htmlUrl}
                          labels={live().labels}
                          onTrack={() => untrackItem(item.id, item.type)}
                          isTracked={true}
                          onIgnore={() => {
                            ignoreItem({
                              id: String(item.id),
                              type: item.type,
                              repo: live().repoFullName,
                              title: live().title,
                              ignoredAt: Date.now(),
                            });
                            untrackItem(item.id, item.type);
                          }}
                          density={config.viewDensity}
                        >
                          <Switch>
                            <Match when={item.type === "issue"}>
                              <span class="badge badge-outline badge-sm badge-info">Issue</span>
                            </Match>
                            <Match when={item.type === "pullRequest"}>
                              <span class="badge badge-outline badge-sm badge-success">PR</span>
                            </Match>
                          </Switch>
                        </ItemRow>
                      )}
                    </Show>
                  </div>
                </div>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
}
