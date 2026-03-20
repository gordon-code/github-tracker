import { createMemo, createSignal, For, Show } from "solid-js";
import { config } from "../../stores/config";
import { viewState, setSortPreference, ignoreItem } from "../../stores/view";
import type { PullRequest, ApiError } from "../../services/api";
import ItemRow from "./ItemRow";
import StatusDot from "../shared/StatusDot";

export interface PullRequestsTabProps {
  pullRequests: PullRequest[];
  loading?: boolean;
  errors?: ApiError[];
}

type SortField = "repo" | "title" | "author" | "createdAt" | "updatedAt" | "checkStatus";

function checkStatusOrder(status: PullRequest["checkStatus"]): number {
  switch (status) {
    case "failure":
      return 0;
    case "pending":
      return 1;
    case "success":
      return 2;
    default:
      return 3;
  }
}

function SortIcon(props: { active: boolean; direction: "asc" | "desc" }) {
  return (
    <span
      class={`inline-block ml-1 transition-opacity ${props.active ? "opacity-100" : "opacity-30"}`}
      aria-hidden="true"
    >
      {props.direction === "asc" || !props.active ? "↑" : "↓"}
    </span>
  );
}

export default function PullRequestsTab(props: PullRequestsTabProps) {
  const [page, setPage] = createSignal(0);

  const sortPref = createMemo(() => {
    const pref = viewState.sortPreferences["pullRequests"];
    return pref ?? { field: "updatedAt", direction: "desc" as const };
  });

  const filteredSorted = createMemo(() => {
    const filter = viewState.globalFilter;
    const ignored = new Set(
      viewState.ignoredItems
        .filter((i) => i.type === "pullRequest")
        .map((i) => i.id)
    );

    let items = props.pullRequests.filter((pr) => {
      if (ignored.has(String(pr.id))) return false;
      if (filter.repo && pr.repoFullName !== filter.repo) return false;
      if (filter.org && !pr.repoFullName.startsWith(filter.org + "/")) return false;
      return true;
    });

    const { field, direction } = sortPref();
    items = [...items].sort((a, b) => {
      let cmp = 0;
      switch (field as SortField) {
        case "repo":
          cmp = a.repoFullName.localeCompare(b.repoFullName);
          break;
        case "title":
          cmp = a.title.localeCompare(b.title);
          break;
        case "author":
          cmp = a.userLogin.localeCompare(b.userLogin);
          break;
        case "createdAt":
          cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
          break;
        case "checkStatus":
          cmp = checkStatusOrder(a.checkStatus) - checkStatusOrder(b.checkStatus);
          break;
        case "updatedAt":
        default:
          cmp = new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
          break;
      }
      return direction === "asc" ? cmp : -cmp;
    });

    return items;
  });

  const pageSize = createMemo(() => config.itemsPerPage);

  const pageCount = createMemo(() =>
    Math.max(1, Math.ceil(filteredSorted().length / pageSize()))
  );

  const pagedItems = createMemo(() => {
    const p = Math.min(page(), pageCount() - 1);
    const start = p * pageSize();
    return filteredSorted().slice(start, start + pageSize());
  });

  function handleSort(field: SortField) {
    const current = sortPref();
    const direction =
      current.field === field && current.direction === "desc" ? "asc" : "desc";
    setSortPreference("pullRequests", field, direction);
    setPage(0);
  }

  function handleIgnore(pr: PullRequest) {
    ignoreItem({
      id: String(pr.id),
      type: "pullRequest",
      repo: pr.repoFullName,
      title: pr.title,
      ignoredAt: Date.now(),
    });
  }

  const columnHeaders: { label: string; field: SortField }[] = [
    { label: "Repo", field: "repo" },
    { label: "Title", field: "title" },
    { label: "Author", field: "author" },
    { label: "Checks", field: "checkStatus" },
    { label: "Created", field: "createdAt" },
    { label: "Updated", field: "updatedAt" },
  ];

  return (
    <div class="flex flex-col h-full">
      {/* Error banners */}
      <Show when={props.errors && props.errors.length > 0}>
        <div class="px-4 pt-3 space-y-1">
          <For each={props.errors}>
            {(err) => (
              <div
                role="alert"
                class="flex items-center gap-2 rounded-md bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 px-3 py-2 text-sm text-red-700 dark:text-red-300"
              >
                <svg
                  class="h-4 w-4 shrink-0"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                  aria-hidden="true"
                >
                  <path
                    fill-rule="evenodd"
                    d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                    clip-rule="evenodd"
                  />
                </svg>
                <span>
                  <strong>{err.repo}:</strong> {err.message}
                  {err.retryable && " (will retry)"}
                </span>
              </div>
            )}
          </For>
        </div>
      </Show>

      {/* Column headers */}
      <div
        role="rowgroup"
        class="flex items-center gap-2 px-4 py-1.5 bg-gray-100 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 text-xs font-medium text-gray-600 dark:text-gray-400 select-none"
      >
        <For each={columnHeaders}>
          {(col) => (
            <button
              onClick={() => handleSort(col.field)}
              class="hover:text-gray-900 dark:hover:text-gray-100 transition-colors focus:outline-none focus:underline"
              aria-label={`Sort by ${col.label}`}
            >
              {col.label}
              <SortIcon
                active={sortPref().field === col.field}
                direction={sortPref().direction}
              />
            </button>
          )}
        </For>
        <div class="flex-1" />
        <div data-ignore-badge-slot />
      </div>

      {/* Loading state */}
      <Show when={props.loading}>
        <div class="flex flex-col gap-2 p-4" role="status" aria-label="Loading pull requests">
          <For each={Array(5).fill(null)}>
            {() => (
              <div class="flex items-center gap-3 animate-pulse">
                <div class="h-5 w-24 rounded-full bg-gray-200 dark:bg-gray-700" />
                <div class="h-4 flex-1 rounded bg-gray-200 dark:bg-gray-700" />
                <div class="h-4 w-16 rounded bg-gray-200 dark:bg-gray-700" />
              </div>
            )}
          </For>
        </div>
      </Show>

      {/* PR rows */}
      <Show when={!props.loading}>
        <Show
          when={pagedItems().length > 0}
          fallback={
            <div class="flex flex-col items-center justify-center gap-2 py-16 text-gray-500 dark:text-gray-400">
              <svg
                class="h-10 w-10 opacity-40"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="1.5"
                  d="M8 7h8m-8 5h5m-5 5h8M5 3h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2z"
                />
              </svg>
              <p class="text-sm font-medium">No open pull requests involving you</p>
              <p class="text-xs">
                PRs where you are the author, assignee, or reviewer will appear here.
              </p>
            </div>
          }
        >
          <div role="list" class="divide-y divide-gray-200 dark:divide-gray-700">
            <For each={pagedItems()}>
              {(pr) => (
                <div role="listitem">
                  <ItemRow
                    repo={pr.repoFullName}
                    number={pr.number}
                    title={pr.title}
                    author={pr.userLogin}
                    createdAt={pr.createdAt}
                    url={pr.htmlUrl}
                    labels={[]}
                    onIgnore={() => handleIgnore(pr)}
                    density={config.viewDensity}
                  >
                    <div class="flex items-center gap-2 flex-wrap">
                      <StatusDot status={pr.checkStatus} />
                      <Show when={pr.draft}>
                        <span class="inline-flex items-center rounded-full bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 text-xs px-2 py-0.5 font-medium">
                          Draft
                        </span>
                      </Show>
                      <Show when={pr.reviewerLogins.length > 0}>
                        <span class="text-xs text-gray-500 dark:text-gray-400">
                          Reviewers: {pr.reviewerLogins.join(", ")}
                        </span>
                      </Show>
                    </div>
                  </ItemRow>
                </div>
              )}
            </For>
          </div>
        </Show>
      </Show>

      {/* Pagination */}
      <Show when={!props.loading && pageCount() > 1}>
        <div class="flex items-center justify-between px-4 py-2 border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-sm text-gray-600 dark:text-gray-400">
          <span>
            Page {Math.min(page(), pageCount() - 1) + 1} of {pageCount()}
            {" · "}
            {filteredSorted().length} pull request{filteredSorted().length !== 1 ? "s" : ""}
          </span>
          <div class="flex gap-2">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page() === 0}
              class="px-3 py-1 rounded-md border border-gray-300 dark:border-gray-600
                bg-white dark:bg-gray-800
                hover:bg-gray-50 dark:hover:bg-gray-700
                disabled:opacity-40 disabled:cursor-not-allowed
                transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500"
              aria-label="Previous page"
            >
              Prev
            </button>
            <button
              onClick={() => setPage((p) => Math.min(pageCount() - 1, p + 1))}
              disabled={page() >= pageCount() - 1}
              class="px-3 py-1 rounded-md border border-gray-300 dark:border-gray-600
                bg-white dark:bg-gray-800
                hover:bg-gray-50 dark:hover:bg-gray-700
                disabled:opacity-40 disabled:cursor-not-allowed
                transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500"
              aria-label="Next page"
            >
              Next
            </button>
          </div>
        </div>
      </Show>
    </div>
  );
}
