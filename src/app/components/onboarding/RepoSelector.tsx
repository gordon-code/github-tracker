import {
  createSignal,
  createEffect,
  createMemo,
  untrack,
  Show,
  Index,
  For,
} from "solid-js";
import { fetchOrgs, fetchRepos, discoverUpstreamRepos, OrgEntry, RepoRef, RepoEntry } from "../../services/api";
import { getClient } from "../../services/github";
import { user } from "../../stores/auth";
import type { TrackedUser } from "../../stores/config";
import { relativeTime } from "../../lib/format";
import { VALID_REPO_NAME } from "../../../shared/validation";
import LoadingSpinner from "../shared/LoadingSpinner";
import FilterInput from "../shared/FilterInput";
import { Tooltip, InfoTooltip } from "../shared/Tooltip";
import ChevronIcon from "../shared/ChevronIcon";
import { Accordion } from "@kobalte/core";

interface RepoSelectorProps {
  selectedOrgs: string[];
  orgEntries?: OrgEntry[]; // Pre-fetched org entries — skip internal fetchOrgs when provided
  selected: RepoRef[];
  onChange: (selected: RepoRef[]) => void;
  showUpstreamDiscovery?: boolean;
  upstreamRepos?: RepoRef[];
  onUpstreamChange?: (repos: RepoRef[]) => void;
  trackedUsers?: TrackedUser[];
  monitoredRepos?: RepoRef[];
  onMonitorToggle?: (repo: RepoRef, monitored: boolean) => void;
}

interface OrgRepoState {
  org: string;
  type: "org" | "user";
  repos: RepoEntry[];
  loading: boolean;
  error: string | null;
}

interface OrgContentProps {
  state: OrgRepoState;
  visible: RepoEntry[];
  isSelected: (fullName: string) => boolean;
  toggleRepo: (repo: RepoEntry) => void;
  retryOrg: (org: string) => void;
  q: string;
  monitoredSet: Set<string>;
  upstreamSelectedSet: Set<string>;
  toRepoRef: (entry: RepoEntry) => RepoRef;
  onMonitorToggle?: (repo: RepoRef, monitored: boolean) => void;
}

function OrgContent(props: OrgContentProps) {
  return (
    <>
      <Show when={props.state.loading}>
        <div class="flex justify-center py-6">
          <LoadingSpinner size="sm" label="Loading..." />
        </div>
      </Show>

      <Show when={!props.state.loading && props.state.error !== null}>
        <div class="flex items-center justify-between px-4 py-3">
          <span class="text-sm text-error">
            {props.state.error}
          </span>
          <button
            type="button"
            onClick={() => props.retryOrg(props.state.org)}
            class="btn btn-ghost btn-xs ml-3"
          >
            Retry
          </button>
        </div>
      </Show>

      <Show when={!props.state.loading && props.state.error === null}>
        <Show
          when={props.visible.length > 0}
          fallback={
            <p class="px-4 py-4 text-center text-sm text-base-content/50">
              {props.q
                ? "No repos match your filter."
                : "No repositories found."}
            </p>
          }
        >
          <div class="max-h-[300px] overflow-y-auto">
            <ul class="divide-y divide-base-300">
              <Index each={props.visible}>
                {(repo) => (
                  <li>
                    <div class="flex items-center">
                      <label class="flex cursor-pointer items-start gap-3 px-4 py-3 hover:bg-base-200 flex-1">
                        <input
                          type="checkbox"
                          checked={props.isSelected(repo().fullName)}
                          onChange={() => props.toggleRepo(repo())}
                          class="checkbox checkbox-primary checkbox-sm mt-0.5"
                        />
                        <div class="min-w-0 flex-1">
                          <div class="flex items-center gap-2">
                            <span class="min-w-0 truncate text-sm font-medium text-base-content">
                              {repo().name}
                            </span>
                            <Show when={repo().pushedAt}>
                              <span class="ml-auto shrink-0 text-xs text-base-content/60">
                                {relativeTime(repo().pushedAt!)}
                              </span>
                            </Show>
                          </div>
                        </div>
                      </label>
                      <Show when={props.isSelected(repo().fullName) && props.onMonitorToggle && !props.upstreamSelectedSet.has(repo().fullName)}>
                        <Tooltip content={props.monitoredSet.has(repo().fullName) ? "Stop monitoring all activity" : "Monitor all activity"}>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              props.onMonitorToggle?.(props.toRepoRef(repo()), !props.monitoredSet.has(repo().fullName));
                            }}
                            class="btn btn-ghost btn-sm btn-circle mr-2"
                            classList={{
                              "text-info": props.monitoredSet.has(repo().fullName),
                              "text-base-content/20": !props.monitoredSet.has(repo().fullName),
                            }}
                            aria-label={props.monitoredSet.has(repo().fullName) ? "Stop monitoring all activity" : "Monitor all activity"}
                            aria-pressed={props.monitoredSet.has(repo().fullName)}
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width={2} aria-hidden="true">
                              <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                              <path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                            </svg>
                          </button>
                        </Tooltip>
                      </Show>
                    </div>
                  </li>
                )}
              </Index>
            </ul>
          </div>
        </Show>
      </Show>
    </>
  );
}

export default function RepoSelector(props: RepoSelectorProps) {
  const [filter, setFilter] = createSignal("");
  const [orgStates, setOrgStates] = createSignal<OrgRepoState[]>([]);
  const [loadedCount, setLoadedCount] = createSignal(0);
  let effectVersion = 0;

  // ── Upstream discovery state ───────────────────────────────────────────────
  const [discoveredRepos, setDiscoveredRepos] = createSignal<RepoRef[]>([]);
  const [discoveringUpstream, setDiscoveringUpstream] = createSignal(false);
  const [discoveryCapped, setDiscoveryCapped] = createSignal(false);
  const [manualEntry, setManualEntry] = createSignal("");
  const [validatingManual, setValidatingManual] = createSignal(false);
  const [manualEntryError, setManualEntryError] = createSignal<string | null>(null);

  // Initialize org states and fetch repos on mount / when selectedOrgs change
  createEffect(() => {
    const orgs = props.selectedOrgs;
    // Capture orgEntries synchronously so SolidJS tracks it as a reactive
    // dependency. Reading it inside the async IIFE below would be fragile —
    // it happens to work today (before any await) but would silently break
    // if the check were moved after an await.
    const preloadedEntries = props.orgEntries;
    // Version counter: if selectedOrgs changes while fetches are in-flight,
    // stale callbacks check this and bail out instead of writing to state.
    const version = ++effectVersion;
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

    if (orgs.length === 0 && !props.showUpstreamDiscovery) {
      return;
    }

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
      if (!props.showUpstreamDiscovery) return;
    }

    // Fetch org type info first, then repos incrementally
    void (async () => {
      if (orgs.length > 0 && client) {
        let entries: OrgEntry[];
        if (preloadedEntries != null) {
          entries = preloadedEntries;
        } else {
          try {
            entries = await fetchOrgs(client);
          } catch {
            entries = [];
          }
        }

        if (version !== effectVersion) return;

        const typeMap = new Map<string, "org" | "user">(
          entries.map((e) => [e.login, e.type])
        );

        // Fetch repos for each org independently so results trickle in
        const promises = orgs.map(async (org) => {
          const type = typeMap.get(org) ?? "org";
          try {
            const repos = await fetchRepos(client, org, type);
            if (version !== effectVersion) return;
            setOrgStates((prev) =>
              prev.map((s) =>
                s.org === org ? { ...s, type, repos, loading: false } : s
              )
            );
          } catch (err) {
            if (version !== effectVersion) return;
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
            if (version === effectVersion) {
              setLoadedCount((c) => c + 1);
            }
          }
        });

        await Promise.allSettled(promises);
      }

      // After all org repos have loaded, trigger upstream discovery if enabled.
      // Use untrack to prevent reactive prop reads from re-triggering the effect.
      if (props.showUpstreamDiscovery && version === effectVersion) {
        const currentUser = untrack(() => user());
        const discoveryClient = getClient();
        if (currentUser && discoveryClient) {
          setDiscoveringUpstream(true);
          setDiscoveredRepos([]);
          setDiscoveryCapped(false);
          const allOrgFullNames = new Set<string>();
          for (const state of orgStates()) {
            for (const repo of state.repos) {
              allOrgFullNames.add(repo.fullName);
            }
          }
          untrack(() => {
            for (const repo of props.selected) {
              allOrgFullNames.add(repo.fullName);
            }
            for (const repo of props.upstreamRepos ?? []) {
              allOrgFullNames.add(repo.fullName);
            }
          });
          void discoverUpstreamRepos(discoveryClient, currentUser.login, allOrgFullNames, props.trackedUsers)
            .then((repos) => {
              if (version !== effectVersion) return;
              setDiscoveredRepos(repos);
              setDiscoveryCapped(repos.length >= 100);
            })
            .catch(() => {
              // Non-fatal — partial results may already be in state
            })
            .finally(() => {
              if (version === effectVersion) setDiscoveringUpstream(false);
            });
        }
      }
    })();
  });

  function retryOrg(org: string) {
    const client = getClient();
    if (!client) return;

    const version = effectVersion;

    setOrgStates((prev) =>
      prev.map((s) =>
        s.org === org ? { ...s, loading: true, error: null } : s
      )
    );

    const state = orgStates().find((s) => s.org === org);
    const type = state?.type ?? "org";

    void fetchRepos(client, org, type)
      .then((repos) => {
        if (version !== effectVersion) return;
        setOrgStates((prev) =>
          prev.map((s) =>
            s.org === org ? { ...s, repos, loading: false, error: null } : s
          )
        );
      })
      .catch((err) => {
        if (version !== effectVersion) return;
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

  const monitoredSet = createMemo(() =>
    new Set((props.monitoredRepos ?? []).map((r) => r.fullName))
  );

  const sortedOrgStates = createMemo(() => {
    const states = orgStates();
    // Defer sorting until all orgs have loaded: prevents layout shift during
    // trickle-in, and ensures each org's type ("user" vs "org") is resolved
    // from fetchOrgs before we sort on it. loadedCount is not reset by retryOrg,
    // so sorting stays active during retries.
    if (loadedCount() < props.selectedOrgs.length) return states;
    // Order: personal org first, then remaining orgs alphabetically.
    // Repos within each org retain their existing recency order from fetchRepos.
    return [...states].sort((a, b) => {
      const aIsUser = a.type === "user" ? 0 : 1;
      const bIsUser = b.type === "user" ? 0 : 1;
      if (aIsUser !== bIsUser) return aIsUser - bIsUser;
      return a.org.localeCompare(b.org, "en");
    });
  });

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

  const q = createMemo(() => filter().toLowerCase().trim());

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

  // ── Upstream selection helpers ────────────────────────────────────────────

  const upstreamSelectedSet = createMemo(() =>
    new Set((props.upstreamRepos ?? []).map((r) => r.fullName))
  );

  function isUpstreamSelected(fullName: string) {
    return upstreamSelectedSet().has(fullName);
  }

  function toggleUpstreamRepo(repo: RepoRef) {
    const current = props.upstreamRepos ?? [];
    if (isUpstreamSelected(repo.fullName)) {
      props.onUpstreamChange?.(current.filter((r) => r.fullName !== repo.fullName));
    } else {
      props.onUpstreamChange?.([...current, repo]);
    }
  }

  async function handleManualAdd() {
    const raw = manualEntry().trim();
    if (!raw) return;
    if (!VALID_REPO_NAME.test(raw)) {
      setManualEntryError("Format must be owner/repo");
      return;
    }
    const [owner, name] = raw.split("/");
    const fullName = `${owner}/${name}`;

    // Check duplicates against org repos, upstream selected, and discovered
    if (selectedSet().has(fullName)) {
      setManualEntryError("Already in your selected repositories");
      return;
    }
    if (upstreamSelectedSet().has(fullName)) {
      setManualEntryError("Already in upstream repositories");
      return;
    }
    if (discoveredRepos().some((r) => r.fullName === fullName)) {
      setManualEntryError("Already discovered — select it from the list below");
      return;
    }

    const client = getClient();
    if (!client) {
      setManualEntryError("Not connected — try again");
      return;
    }

    setValidatingManual(true);
    setManualEntryError(null);
    try {
      await client.request("GET /repos/{owner}/{repo}", { owner, repo: name });
    } catch (err) {
      const status = typeof err === "object" && err !== null && "status" in err
        ? (err as { status: number }).status
        : null;
      if (status === 404) {
        setManualEntryError("Repository not found");
      } else {
        setManualEntryError("Could not verify repository — try again");
      }
      return;
    } finally {
      setValidatingManual(false);
    }

    const newRepo: RepoRef = { owner, name, fullName };
    props.onUpstreamChange?.([...(props.upstreamRepos ?? []), newRepo]);
    setManualEntry("");
    setManualEntryError(null);
  }

  function handleManualKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter") void handleManualAdd();
  }

  // Manually-added upstream repos not in the discovered list
  const manualUpstreamRepos = createMemo(() => {
    const discoveredSet = new Set(discoveredRepos().map(r => r.fullName));
    return (props.upstreamRepos ?? []).filter(r => !discoveredSet.has(r.fullName));
  });

  // Upstream repos visible in the discovery list (discovered + manually added that aren't org repos)
  const filteredDiscovered = createMemo(() => {
    const query = q();
    if (!query) return discoveredRepos();
    return discoveredRepos().filter(
      (r) =>
        r.name.toLowerCase().includes(query) ||
        r.owner.toLowerCase().includes(query)
    );
  });

  // ── Accordion state ───────────────────────────────────────────────────────

  const isAccordion = createMemo(() => props.selectedOrgs.length >= 6);
  // Stable default: props.selectedOrgs[0] avoids the mid-load shift that
  // occurs when sortedOrgStates switches from insertion-order to alphabetical
  const [expandedOrg, setExpandedOrg] = createSignal<string>(
    props.selectedOrgs[0] ?? ""
  );
  const safeExpandedOrg = createMemo(() => {
    const states = sortedOrgStates();
    const current = expandedOrg();
    if (states.some(s => s.org === current)) return current;
    const stateOrgs = new Set(states.map(s => s.org));
    return props.selectedOrgs.find(o => stateOrgs.has(o)) ?? (states.length > 0 ? states[0].org : "");
  });

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
            class="btn btn-ghost btn-xs"
          >
            Select All
          </button>
          <button
            type="button"
            onClick={deselectAll}
            disabled={props.selected.length === 0}
            class="btn btn-ghost btn-xs"
          >
            Deselect All
          </button>
        </div>
      </div>

      {/* Loading progress */}
      <Show when={isLoadingAny()}>
        <div class="flex items-center gap-3 py-2">
          <LoadingSpinner size="sm" />
          <span class="text-sm text-base-content/60">
            {progressLabel()}
          </span>
        </div>
      </Show>

      {/* Per-org repo lists — Index (not For) avoids tearing down every org's
           DOM subtree when a single org's state updates via setOrgStates(prev.map(...)) */}
      <Show
        when={isAccordion()}
        fallback={
          <Index each={sortedOrgStates()}>
            {(state) => {
              const visible = createMemo(() => filteredReposForOrg(state()));
              return (
                <div class="overflow-hidden rounded-lg border border-base-300" role="region" aria-label={`${state().org} repositories`}>
                  <div class="flex items-center justify-between border-b border-base-300 bg-base-200 px-4 py-2">
                    <span class="text-sm font-semibold text-base-content">
                      {state().org}
                    </span>
                    <Show when={!state().loading && !state().error}>
                      <div class="flex gap-2">
                        <button
                          type="button"
                          onClick={() => selectAllInOrg(state())}
                          disabled={
                            visible().length === 0 ||
                            visible().every((r) => isSelected(r.fullName))
                          }
                          class="btn btn-ghost btn-xs"
                        >
                          Select All
                        </button>
                        <span class="text-base-content/30">·</span>
                        <button
                          type="button"
                          onClick={() => deselectAllInOrg(state())}
                          disabled={
                            visible().length === 0 ||
                            visible().every((r) => !isSelected(r.fullName))
                          }
                          class="btn btn-ghost btn-xs"
                        >
                          Deselect All
                        </button>
                      </div>
                    </Show>
                  </div>
                  <OrgContent state={state()} visible={visible()} isSelected={isSelected} toggleRepo={toggleRepo} retryOrg={retryOrg} q={q()} monitoredSet={monitoredSet()} upstreamSelectedSet={upstreamSelectedSet()} toRepoRef={toRepoRef} onMonitorToggle={props.onMonitorToggle} />
                </div>
              );
            }}
          </Index>
        }
      >
        <Accordion.Root
          class="overflow-hidden rounded-lg border border-base-300 divide-y divide-base-300"
          value={[safeExpandedOrg()]}
          // Guard: Kobalte fires onChange([]) when clicking the open panel's trigger
          // in single-select mode. The guard enforces always-one-open by ignoring
          // empty selections. Tested indirectly via "re-click is a no-op" tests.
          onChange={(vals) => {
            if (vals.length > 0) setExpandedOrg(vals[0]);
          }}
        >
          <Index each={sortedOrgStates()}>
            {(state) => {
              const visible = createMemo(() => filteredReposForOrg(state()));
              // Count against ALL repos in the org (unfiltered) so the badge
              // doesn't mislead users into thinking selections were lost when
              // a text filter is active.
              const selectedCount = createMemo(() =>
                state().repos.filter((r) => isSelected(r.fullName)).length
              );
              const isExpanded = () => safeExpandedOrg() === state().org;
              return (
                <Accordion.Item value={state().org}>
                  <div class="flex items-center border-b border-base-300 bg-base-200">
                    <Accordion.Header class="flex-1">
                      <Accordion.Trigger class="flex w-full items-center gap-2 px-4 py-2 text-left">
                        <ChevronIcon size="md" rotated={!isExpanded()} />
                        <span class="text-sm font-semibold text-base-content flex-1">
                          {state().org}
                        </span>
                        <Show
                          when={!state().loading}
                          fallback={<span class="loading loading-spinner loading-xs" />}
                        >
                          <span class="badge badge-sm badge-ghost">{visible().length} {visible().length === 1 ? "repo" : "repos"}</span>
                          <Show when={selectedCount() > 0}>
                            <span class="badge badge-sm badge-ghost">{selectedCount()} selected</span>
                          </Show>
                        </Show>
                      </Accordion.Trigger>
                    </Accordion.Header>
                    <Show when={isExpanded() && !state().loading && !state().error}>
                      <div class="flex items-center gap-2 pr-3">
                        <button
                          type="button"
                          onClick={() => selectAllInOrg(state())}
                          disabled={
                            visible().length === 0 ||
                            visible().every((r) => isSelected(r.fullName))
                          }
                          class="btn btn-ghost btn-xs"
                        >
                          Select All
                        </button>
                        <span class="text-base-content/30">·</span>
                        <button
                          type="button"
                          onClick={() => deselectAllInOrg(state())}
                          disabled={
                            visible().length === 0 ||
                            visible().every((r) => !isSelected(r.fullName))
                          }
                          class="btn btn-ghost btn-xs"
                        >
                          Deselect All
                        </button>
                      </div>
                    </Show>
                  </div>
                  <Accordion.Content class="kb-accordion-content">
                    <OrgContent state={state()} visible={visible()} isSelected={isSelected} toggleRepo={toggleRepo} retryOrg={retryOrg} q={q()} monitoredSet={monitoredSet()} upstreamSelectedSet={upstreamSelectedSet()} toRepoRef={toRepoRef} onMonitorToggle={props.onMonitorToggle} />
                  </Accordion.Content>
                </Accordion.Item>
              );
            }}
          </Index>
        </Accordion.Root>
      </Show>

      {/* Upstream Repositories section */}
      <Show when={props.showUpstreamDiscovery}>
        <div class="flex flex-col gap-3">
          {/* Section heading */}
          <div class="border-t border-base-300 pt-3">
            <h3 class="flex items-center gap-1.5 text-sm font-semibold text-base-content">
              Upstream Repositories
              <InfoTooltip content="Repos discovered from your tracked users' activity. Issues and PRs from these repos appear in your dashboard." />
            </h3>
            <p class="text-xs text-base-content/60 mt-0.5">
              Repos you contribute to but don't own. Issues and PRs are tracked; workflow runs are not.
            </p>
          </div>

          {/* Manual entry */}
          <div class="flex items-center gap-2">
            <input
              type="text"
              placeholder="owner/repo"
              value={manualEntry()}
              onInput={(e) => {
                setManualEntry(e.currentTarget.value);
                setManualEntryError(null);
              }}
              onKeyDown={handleManualKeyDown}
              disabled={validatingManual()}
              class="input input-sm flex-1"
              aria-label="Add upstream repo manually"
            />
            <button
              type="button"
              onClick={() => void handleManualAdd()}
              disabled={validatingManual()}
              class="btn btn-sm btn-outline"
            >
              {validatingManual() ? "Checking..." : "Add"}
            </button>
          </div>
          <Show when={manualEntryError()}>
            <div role="alert" class="alert alert-error text-xs py-2">
              {manualEntryError()}
            </div>
          </Show>

          {/* Discovery loading */}
          <Show when={discoveringUpstream()}>
            <div class="flex items-center gap-3 py-2">
              <LoadingSpinner size="sm" />
              <span class="text-sm text-base-content/60">Discovering upstream repos...</span>
            </div>
          </Show>

          {/* Discovered repos list */}
          <Show when={!discoveringUpstream() && discoveredRepos().length > 0}>
            <div class="overflow-hidden rounded-lg border border-base-300">
              <div class="max-h-[300px] overflow-y-auto" role="region" aria-label="Upstream repositories">
                <ul class="divide-y divide-base-300">
                  <For each={filteredDiscovered()}>
                    {(repo) => (
                      <li>
                        <label class="flex cursor-pointer items-start gap-3 px-4 py-3 hover:bg-base-200">
                          <input
                            type="checkbox"
                            checked={isUpstreamSelected(repo.fullName)}
                            onChange={() => toggleUpstreamRepo(repo)}
                            class="checkbox checkbox-primary checkbox-sm mt-0.5"
                          />
                          <div class="min-w-0 flex-1">
                            <span class="min-w-0 truncate text-sm font-medium text-base-content">
                              {repo.fullName}
                            </span>
                          </div>
                        </label>
                      </li>
                    )}
                  </For>
                </ul>
              </div>
            </div>
            <Show when={discoveryCapped()}>
              <p class="text-xs text-base-content/50">
                Showing first 100 discovered repos. Use manual entry above to add specific repos.
              </p>
            </Show>
          </Show>

          {/* Manually-added upstream repos not in discovered list */}
          <Show when={manualUpstreamRepos().length > 0}>
            <div class="flex flex-col gap-1">
              <For each={manualUpstreamRepos()}>
                {(repo) => (
                  <div class="flex items-center gap-2 px-1">
                    <span class="text-sm flex-1">{repo.fullName}</span>
                    <button
                      type="button"
                      onClick={() => props.onUpstreamChange?.((props.upstreamRepos ?? []).filter(r => r.fullName !== repo.fullName))}
                      class="btn btn-ghost btn-xs"
                      aria-label={`Remove ${repo.fullName}`}
                    >
                      Remove
                    </button>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>

      {/* Total count */}
      <Show when={!isLoadingAny() && props.selected.length > 0}>
        <p class="text-xs text-base-content/60">
          {props.selected.length}{" "}
          {props.selected.length === 1 ? "repo" : "repos"} selected
        </p>
      </Show>

      {/* Rate limit warning for large selections */}
      <Show when={props.selected.length + (props.upstreamRepos ?? []).length > 100}>
        <div role="alert" class="alert alert-warning text-sm">
          Tracking 100+ repos may cause GitHub API rate limit issues. Consider reducing your selection.
        </div>
      </Show>
    </div>
  );
}
