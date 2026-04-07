import { For, Show, Switch, Match, createMemo } from "solid-js";
import { config } from "../../stores/config";
import { viewState, untrackItem, moveTrackedItem } from "../../stores/view";
import type { TrackedItem } from "../../stores/view";
import type { Issue, PullRequest } from "../../services/api";
import ItemRow from "./ItemRow";
import { Tooltip } from "../shared/Tooltip";

function TypeBadge(props: { type: TrackedItem["type"] }) {
  return (
    <Switch>
      <Match when={props.type === "issue"}>
        <span class="badge badge-outline badge-sm badge-info">Issue</span>
      </Match>
      <Match when={props.type === "pullRequest"}>
        <span class="badge badge-outline badge-sm badge-success">PR</span>
      </Match>
    </Switch>
  );
}

// FLIP animation: record positions before move, animate slide after DOM updates
const itemRefs = new Map<string, HTMLDivElement>();
const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function recordPositions(): Map<string, DOMRect> {
  const snapshot = new Map<string, DOMRect>();
  for (const [key, el] of itemRefs) {
    snapshot.set(key, el.getBoundingClientRect());
  }
  return snapshot;
}

function animateMove(before: Map<string, DOMRect>) {
  if (prefersReducedMotion()) return;
  requestAnimationFrame(() => {
    for (const [key, el] of itemRefs) {
      const old = before.get(key);
      if (!old) continue;
      const now = el.getBoundingClientRect();
      const dy = old.top - now.top;
      if (Math.abs(dy) < 1) continue;
      el.animate(
        [{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }],
        { duration: 200, easing: "ease-in-out" }
      );
    }
  });
}

function handleMove(id: number, type: "issue" | "pullRequest", direction: "up" | "down") {
  const before = recordPositions();
  moveTrackedItem(id, type, direction);
  animateMove(before);
}

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
              const itemKey = `${item.type}:${item.id}`;

              return (
                <div
                  class="flex items-center gap-1"
                  ref={(el) => { itemRefs.set(itemKey, el); }}
                >
                  {/* Reorder buttons */}
                  <div class="flex flex-col shrink-0 pl-2">
                    <button
                      class="btn btn-ghost btn-xs"
                      disabled={isFirst()}
                      aria-label={`Move up: ${item.title}`}
                      onClick={() => handleMove(item.id, item.type, "up")}
                    >
                      {/* Heroicons 20px solid: chevron-up */}
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="h-3.5 w-3.5">
                        <path fill-rule="evenodd" d="M14.77 12.79a.75.75 0 01-1.06-.02L10 8.832 6.29 12.77a.75.75 0 11-1.08-1.04l4.25-4.5a.75.75 0 011.08 0l4.25 4.5a.75.75 0 01-.02 1.06z" clip-rule="evenodd" />
                      </svg>
                    </button>
                    <button
                      class="btn btn-ghost btn-xs"
                      disabled={isLast()}
                      aria-label={`Move down: ${item.title}`}
                      onClick={() => handleMove(item.id, item.type, "down")}
                    >
                      {/* Heroicons 20px solid: chevron-down */}
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="h-3.5 w-3.5">
                        <path fill-rule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clip-rule="evenodd" />
                      </svg>
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
                              <TypeBadge type={item.type} />
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
                          density={config.viewDensity}
                        >
                          <TypeBadge type={item.type} />
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
