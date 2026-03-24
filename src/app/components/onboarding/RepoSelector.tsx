import {
  createSignal,
  createEffect,
  createMemo,
  For,
  Show,
  Index,
} from "solid-js";
import { fetchOrgs, fetchRepos, OrgEntry, RepoRef, RepoEntry } from "../../services/api";
import { getClient } from "../../services/github";
import { relativeTime } from "../../lib/format";
import LoadingSpinner from "../shared/LoadingSpinner";
import FilterInput from "../shared/FilterInput";

interface RepoSelectorProps {
  selectedOrgs: string[];
  selected: RepoRef[];
  onChange: (selected: RepoRef[]) => void;
}

interface OrgRepoState {
  org: string;
  type: "org" | "user";
  repos: RepoEntry[];
  loading: boolean;
  error: string | null;
}

export default function RepoSelector(props: RepoSelectorProps) {
  const [filter, setFilter] = createSignal("");
  const [orgStates, setOrgStates] = createSignal<OrgRepoState[]>([]);
  const [loadedCount, setLoadedCount] = createSignal(0);

  // Initialize org states and fetch repos on mount / when selectedOrgs change
  createEffect(() => {
    const orgs = props.selectedOrgs;
    if (orgs.length === 0) {
      setOrgStates([]);
      setLoadedCount(0);
      return;
    }

    // Initialize all orgs as loading
    setOrgStates(
      orgs.map((org) => ({
        org,
        type: "org" as const,
        repos: [],
        loading: true,
        error: null,
      }))
    );
    setLoadedCount(0);

    const client = getClient();
    if (!client) {
      setOrgStates(
        orgs.map((org) => ({
          org,
          type: "org" as const,
          repos: [],
          loading: false,
          error: "No GitHub client available",
        }))
      );
      setLoadedCount(orgs.length);
      return;
    }

    // Fetch org type info first, then repos incrementally
    void (async () => {
      let orgEntries: OrgEntry[] = [];
      try {
        orgEntries = await fetchOrgs(client);
      } catch {
        // If fetchOrgs fails, treat all as "org" type
      }

      const typeMap = new Map<string, "org" | "user">(
        orgEntries.map((e) => [e.login, e.type])
      );

      // Fetch repos for each org independently so results trickle in
      const promises = orgs.map(async (org) => {
        const type = typeMap.get(org) ?? "org";
        try {
          const repos = await fetchRepos(client, org, type);
          setOrgStates((prev) =>
            prev.map((s) =>
              s.org === org ? { ...s, type, repos, loading: false } : s
            )
          );
        } catch (err) {
          const message =
            err instanceof Error ? err.message : "Failed to load repositories";
          setOrgStates((prev) =>
            prev.map((s) =>
              s.org === org
                ? { ...s, type, repos: [], loading: false, error: message }
                : s
            )
          );
        } finally {
          setLoadedCount((c) => c + 1);
        }
      });

      await Promise.allSettled(promises);
    })();
  });

  function retryOrg(org: string) {
    const client = getClient();
    if (!client) return;

    setOrgStates((prev) =>
      prev.map((s) =>
        s.org === org ? { ...s, loading: true, error: null } : s
      )
    );

    const state = orgStates().find((s) => s.org === org);
    const type = state?.type ?? "org";

    void fetchRepos(client, org, type)
      .then((repos) => {
        setOrgStates((prev) =>
          prev.map((s) =>
            s.org === org ? { ...s, repos, loading: false, error: null } : s
          )
        );
      })
      .catch((err) => {
        const message =
          err instanceof Error ? err.message : "Failed to load repositories";
        setOrgStates((prev) =>
          prev.map((s) =>
            s.org === org ? { ...s, loading: false, error: message } : s
          )
        );
      });
  }

  // ── Selection helpers ──────────────────────────────────────────────────────

  const selectedSet = createMemo(() =>
    new Set(props.selected.map((r) => r.fullName))
  );

  const sortedOrgStates = createMemo(() =>
    [...orgStates()].sort((a, b) => {
      const aMax = a.repos.reduce((max, r) => r.pushedAt && r.pushedAt > max ? r.pushedAt : max, "");
      const bMax = b.repos.reduce((max, r) => r.pushedAt && r.pushedAt > max ? r.pushedAt : max, "");
      return aMax > bMax ? -1 : aMax < bMax ? 1 : 0;
    })
  );

  function toRepoRef(entry: RepoEntry): RepoRef {
    return { owner: entry.owner, name: entry.name, fullName: entry.fullName };
  }

  function isSelected(fullName: string) {
    return selectedSet().has(fullName);
  }

  function toggleRepo(repo: RepoEntry) {
    if (isSelected(repo.fullName)) {
      props.onChange(props.selected.filter((r) => r.fullName !== repo.fullName));
    } else {
      props.onChange([...props.selected, toRepoRef(repo)]);
    }
  }

  // ── Filtering ──────────────────────────────────────────────────────────────

  const q = () => filter().toLowerCase().trim();

  function filteredReposForOrg(state: OrgRepoState): RepoEntry[] {
    const query = q();
    if (!query) return state.repos;
    return state.repos.filter(
      (r) =>
        r.name.toLowerCase().includes(query) ||
        r.owner.toLowerCase().includes(query)
    );
  }

  // ── Per-org select/deselect all ───────────────────────────────────────────

  function selectAllInOrg(state: OrgRepoState) {
    const visible = filteredReposForOrg(state);
    const current = new Map(props.selected.map((r) => [r.fullName, r]));
    for (const repo of visible) current.set(repo.fullName, toRepoRef(repo));
    props.onChange([...current.values()]);
  }

  function deselectAllInOrg(state: OrgRepoState) {
    const visible = new Set(filteredReposForOrg(state).map((r) => r.fullName));
    props.onChange(props.selected.filter((r) => !visible.has(r.fullName)));
  }

  function allVisibleInOrgSelected(state: OrgRepoState): boolean {
    const visible = filteredReposForOrg(state);
    return visible.length > 0 && visible.every((r) => isSelected(r.fullName));
  }

  // ── Global select/deselect all ────────────────────────────────────────────

  function selectAll() {
    const current = new Map(props.selected.map((r) => [r.fullName, r]));
    for (const state of orgStates()) {
      for (const repo of filteredReposForOrg(state)) {
        current.set(repo.fullName, toRepoRef(repo));
      }
    }
    props.onChange([...current.values()]);
  }

  function deselectAll() {
    const allVisible = new Set(
      orgStates().flatMap((s) => filteredReposForOrg(s).map((r) => r.fullName))
    );
    props.onChange(props.selected.filter((r) => !allVisible.has(r.fullName)));
  }

  // ── Status ────────────────────────────────────────────────────────────────

  const totalOrgs = () => props.selectedOrgs.length;
  const isLoadingAny = () => orgStates().some((s) => s.loading);
  const progressLabel = () =>
    `Loading repos... ${loadedCount()} / ${totalOrgs()} orgs`;

  return (
    <div class="flex flex-col gap-4">
      {/* Filter + global controls */}
      <div class="flex items-center justify-between gap-3">
        <FilterInput placeholder="Filter repos..." onFilter={setFilter} />
        <div class="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={selectAll}
            class="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            Select All
          </button>
          <button
            type="button"
            onClick={deselectAll}
            disabled={props.selected.length === 0}
            class="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            Deselect All
          </button>
        </div>
      </div>

      {/* Loading progress */}
      <Show when={isLoadingAny()}>
        <div class="flex items-center gap-3 py-2">
          <LoadingSpinner size="sm" />
          <span class="text-sm text-gray-500 dark:text-gray-400">
            {progressLabel()}
          </span>
        </div>
      </Show>

      {/* Per-org repo lists */}
      <For each={sortedOrgStates()}>
        {(state) => {
          const visible = () => filteredReposForOrg(state);

          return (
            <div class="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
              {/* Org header */}
              <div class="flex items-center justify-between border-b border-gray-200 bg-gray-50 px-4 py-2 dark:border-gray-700 dark:bg-gray-800/60">
                <span class="text-sm font-semibold text-gray-800 dark:text-gray-200">
                  {state.org}
                </span>
                <Show when={!state.loading && !state.error}>
                  <div class="flex gap-2">
                    <button
                      type="button"
                      onClick={() => selectAllInOrg(state)}
                      disabled={
                        allVisibleInOrgSelected(state) ||
                        visible().length === 0
                      }
                      class="text-xs text-blue-600 hover:underline disabled:cursor-not-allowed disabled:opacity-40 dark:text-blue-400"
                    >
                      Select All
                    </button>
                    <span class="text-gray-300 dark:text-gray-600">·</span>
                    <button
                      type="button"
                      onClick={() => deselectAllInOrg(state)}
                      disabled={
                        visible().length === 0 ||
                        visible().every((r) => !isSelected(r.fullName))
                      }
                      class="text-xs text-blue-600 hover:underline disabled:cursor-not-allowed disabled:opacity-40 dark:text-blue-400"
                    >
                      Deselect All
                    </button>
                  </div>
                </Show>
              </div>

              {/* Loading state for this org */}
              <Show when={state.loading}>
                <div class="flex justify-center py-6">
                  <LoadingSpinner size="sm" label="Loading..." />
                </div>
              </Show>

              {/* Error state for this org */}
              <Show when={!state.loading && state.error !== null}>
                <div class="flex items-center justify-between px-4 py-3">
                  <span class="text-sm text-red-600 dark:text-red-400">
                    {state.error}
                  </span>
                  <button
                    type="button"
                    onClick={() => retryOrg(state.org)}
                    class="ml-3 text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
                  >
                    Retry
                  </button>
                </div>
              </Show>

              {/* Repo list */}
              <Show when={!state.loading && state.error === null}>
                <Show
                  when={visible().length > 0}
                  fallback={
                    <p class="px-4 py-4 text-center text-sm text-gray-400 dark:text-gray-500">
                      {q()
                        ? "No repos match your filter."
                        : "No repositories found."}
                    </p>
                  }
                >
                  <ul class="divide-y divide-gray-100 dark:divide-gray-700">
                    <Index each={visible()}>
                      {(repo) => {
                        return (
                          <li>
                            <label class="flex cursor-pointer items-start gap-3 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-800/50">
                              <input
                                type="checkbox"
                                checked={isSelected(repo().fullName)}
                                onChange={() => toggleRepo(repo())}
                                class="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:focus:ring-blue-400"
                              />
                              <div class="min-w-0 flex-1">
                                <div class="flex items-center gap-2">
                                  <span class="min-w-0 truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                                    {repo().name}
                                  </span>
                                  <Show when={repo().pushedAt}>
                                    <span class="ml-auto shrink-0 text-xs text-gray-500 dark:text-gray-400">
                                      {relativeTime(repo().pushedAt!)}
                                    </span>
                                  </Show>
                                </div>
                              </div>
                            </label>
                          </li>
                        );
                      }}
                    </Index>
                  </ul>
                </Show>
              </Show>
            </div>
          );
        }}
      </For>

      {/* Total count */}
      <Show when={!isLoadingAny() && props.selected.length > 0}>
        <p class="text-xs text-gray-500 dark:text-gray-400">
          {props.selected.length}{" "}
          {props.selected.length === 1 ? "repo" : "repos"} selected
        </p>
      </Show>
    </div>
  );
}
