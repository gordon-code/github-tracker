import { createSignal, createMemo, createEffect, Show, Switch, Match, onMount, onCleanup } from "solid-js";
import { createStore, produce } from "solid-js/store";
import Header from "../layout/Header";
import TabBar, { TabId } from "../layout/TabBar";
import FilterBar from "../layout/FilterBar";
import ActionsTab from "./ActionsTab";
import IssuesTab from "./IssuesTab";
import PullRequestsTab from "./PullRequestsTab";
import TrackedTab from "./TrackedTab";
import PersonalSummaryStrip from "./PersonalSummaryStrip";
import { config, setConfig, type TrackedUser } from "../../stores/config";
import { viewState, updateViewState, setSortPreference, pruneClosedTrackedItems } from "../../stores/view";
import type { SortOption } from "../shared/SortDropdown";
import type { Issue, PullRequest, WorkflowRun } from "../../services/api";
import { fetchOrgs } from "../../services/api";
import {
  createPollCoordinator,
  createHotPollCoordinator,
  rebuildHotSets,
  clearHotSets,
  getHotPollGeneration,
  fetchAllData,
  type DashboardData,
} from "../../services/poll";
import { expireToken, user, onAuthCleared, DASHBOARD_STORAGE_KEY } from "../../stores/auth";
import { pushNotification } from "../../lib/errors";
import { getClient, getGraphqlRateLimit, fetchRateLimitDetails } from "../../services/github";
import { trackApiCall } from "../../services/api-usage";
import { formatCount } from "../../lib/format";
import { setsEqual } from "../../lib/collections";
import { withScrollLock } from "../../lib/scroll";
import { Tooltip } from "../shared/Tooltip";

const globalSortOptions: SortOption[] = [
  { label: "Repo", field: "repo", type: "text" },
  { label: "Title", field: "title", type: "text" },
  { label: "Author", field: "author", type: "text" },
  { label: "Comments", field: "comments", type: "number" },
  { label: "Checks", field: "checkStatus", type: "text" },
  { label: "Review", field: "reviewDecision", type: "text" },
  { label: "Size", field: "size", type: "number" },
  { label: "Created", field: "createdAt", type: "date" },
  { label: "Updated", field: "updatedAt", type: "date" },
];

// ── Shared dashboard store (module-level to survive navigation) ─────────────

// Bump only for breaking schema changes (renames, type changes). Additive optional
// fields (e.g., nodeId?: string) don't require a bump — missing fields deserialize
// as undefined, which consuming code handles gracefully.
const CACHE_VERSION = 2;

interface DashboardStore {
  issues: Issue[];
  pullRequests: PullRequest[];
  workflowRuns: WorkflowRun[];
  loading: boolean;
  lastRefreshedAt: Date | null;
}

const initialDashboardState: DashboardStore = {
  issues: [],
  pullRequests: [],
  workflowRuns: [],
  loading: true,
  lastRefreshedAt: null,
};

function loadCachedDashboard(): DashboardStore {
  try {
    const raw = localStorage.getItem?.(DASHBOARD_STORAGE_KEY);
    if (!raw) return { ...initialDashboardState };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // Invalidate cache on schema version mismatch
    if (parsed._v !== CACHE_VERSION) return { ...initialDashboardState };
    // Validate expected shape — arrays must be arrays
    if (!Array.isArray(parsed.issues) || !Array.isArray(parsed.pullRequests) || !Array.isArray(parsed.workflowRuns)) {
      return { ...initialDashboardState };
    }
    return {
      issues: parsed.issues as Issue[],
      pullRequests: parsed.pullRequests as PullRequest[],
      workflowRuns: parsed.workflowRuns as WorkflowRun[],
      loading: false,
      lastRefreshedAt: typeof parsed.lastRefreshedAt === "string" ? new Date(parsed.lastRefreshedAt) : null,
    };
  } catch {
    return { ...initialDashboardState };
  }
}

const [dashboardData, setDashboardData] = createStore<DashboardStore>(loadCachedDashboard());

function resetDashboardData(): void {
  setDashboardData({ ...initialDashboardState });
  localStorage.removeItem?.(DASHBOARD_STORAGE_KEY);
}

const [hasFetchedFresh, setHasFetchedFresh] = createSignal(false);
export function _resetHasFetchedFresh(value = false) { setHasFetchedFresh(value); }

// Clear dashboard data and stop polling on logout to prevent cross-user data leakage
onAuthCleared(() => {
  resetDashboardData();
  setHasFetchedFresh(false);
  const coord = _coordinator();
  if (coord) {
    coord.destroy();
    if (_coordinator() === coord) _setCoordinator(null);
  }
  const hotCoord = _hotCoordinator();
  if (hotCoord) {
    hotCoord.destroy();
    if (_hotCoordinator() === hotCoord) _setHotCoordinator(null);
  }
  clearHotSets();
});

async function pollFetch(): Promise<DashboardData> {
  // Only show skeleton on initial load (no data yet).
  // Subsequent refreshes keep existing data visible — the coordinator's
  // isRefreshing signal handles the "Refreshing..." indicator.
  if (!dashboardData.lastRefreshedAt) {
    setDashboardData("loading", true);
  }
  try {
    // Two-phase rendering: phase 1 callback fires with light issues + PRs
    // so the UI renders immediately. Phase 2 (enrichment + workflow runs)
    // arrives when fetchAllData resolves.
    let phaseOneFired = false;
    const data = await fetchAllData((lightData) => {
      // Phase 1: render light issues + PRs immediately — but only on initial
      // load (no cached data). On reload with cached data, the cache already
      // has enriched PRs; replacing them with light PRs would cause a visible
      // flicker (badges disappear then reappear when phase 2 arrives).
      if (dashboardData.pullRequests.length === 0) {
        phaseOneFired = true;
        setDashboardData({
          issues: lightData.issues,
          pullRequests: lightData.pullRequests,
          loading: false,
          lastRefreshedAt: new Date(),
        });
      }
    });
    // When notifications gate says nothing changed, keep existing data
    if (!data.skipped) {
      setHasFetchedFresh(true);
      const now = new Date();

      if (phaseOneFired) {
        // Phase 1 fired — use fine-grained merge for the light→enriched
        // transition. Only update heavy fields to avoid re-rendering the
        // entire list (light fields haven't changed within this poll cycle).
        const enrichedMap = new Map<number, PullRequest>();
        for (const pr of data.pullRequests) enrichedMap.set(pr.id, pr);

        setDashboardData(produce((state) => {
          state.issues = data.issues;
          state.workflowRuns = data.workflowRuns;
          state.loading = false;
          state.lastRefreshedAt = now;

          let canMerge = state.pullRequests.length === enrichedMap.size;
          if (canMerge) {
            for (let i = 0; i < state.pullRequests.length; i++) {
              if (!enrichedMap.has(state.pullRequests[i].id)) { canMerge = false; break; }
            }
          }

          if (canMerge) {
            for (let i = 0; i < state.pullRequests.length; i++) {
              const e = enrichedMap.get(state.pullRequests[i].id)!;
              const pr = state.pullRequests[i];
              pr.headSha = e.headSha;
              pr.assigneeLogins = e.assigneeLogins;
              pr.reviewerLogins = e.reviewerLogins;
              pr.checkStatus = e.checkStatus;
              pr.additions = e.additions;
              pr.deletions = e.deletions;
              pr.changedFiles = e.changedFiles;
              pr.comments = e.comments;
              pr.reviewThreads = e.reviewThreads;
              pr.totalReviewCount = e.totalReviewCount;
              pr.enriched = e.enriched;
              pr.nodeId = e.nodeId;
              pr.surfacedBy = e.surfacedBy;
              pr.starCount = e.starCount;
            }
          } else {
            state.pullRequests = data.pullRequests;
          }
        }));
      } else {
        // Phase 1 did NOT fire (cached data existed or subsequent poll).
        // Full atomic replacement — all fields (light + heavy) may have
        // changed since the last cycle. Preserve scroll position: SolidJS
        // DOM updates are synchronous within the setter, so save/restore
        // around it to prevent scroll reset from <For> DOM rebuild.
        withScrollLock(() => {
          setDashboardData({
            issues: data.issues,
            pullRequests: data.pullRequests,
            workflowRuns: data.workflowRuns,
            loading: false,
            lastRefreshedAt: now,
          });
        });
      }
      rebuildHotSets(data);
      // Persist for stale-while-revalidate on full page reload.
      // Errors are transient and not persisted. Deferred to avoid blocking paint.
      const cachePayload = {
        _v: CACHE_VERSION,
        issues: data.issues,
        pullRequests: data.pullRequests,
        workflowRuns: data.workflowRuns,
        lastRefreshedAt: now.toISOString(),
      };
      setTimeout(() => {
        try {
          localStorage.setItem(DASHBOARD_STORAGE_KEY, JSON.stringify(cachePayload));
        } catch {
          pushNotification("localStorage:dashboard", "Dashboard cache write failed — storage may be full", "warning");
        }
      }, 0);
    } else {
      setDashboardData("loading", false);
    }
    return data;
  } catch (err) {
    // Handle 401 auth errors
    const status =
      typeof err === "object" &&
      err !== null &&
      typeof (err as Record<string, unknown>)["status"] === "number"
        ? (err as Record<string, unknown>)["status"]
        : null;

    if (status === 401) {
      // Token invalid — clear token only, preserve user config/view/dashboard.
      // Hard redirect forces a full page reload, clearing module-level state.
      expireToken();
      window.location.replace("/login");
    }
    setDashboardData("loading", false);
    throw err;
  }
}

const [_coordinator, _setCoordinator] = createSignal<ReturnType<typeof createPollCoordinator> | null>(null);
const [_hotCoordinator, _setHotCoordinator] = createSignal<{ destroy: () => void } | null>(null);

export default function DashboardPage() {
  const [hotPollingPRIds, setHotPollingPRIds] = createSignal<ReadonlySet<number>>(new Set());
  const [hotPollingRunIds, setHotPollingRunIds] = createSignal<ReadonlySet<number>>(new Set());
  const [rlDetail, setRlDetail] = createSignal<string>("Loading...");

  function fetchAndSetRlDetail(): void {
    void fetchRateLimitDetails().then((detail) => {
      if (!detail) {
        setRlDetail("Failed to load");
        return;
      }
      if (!detail.fromCache) trackApiCall("rateLimitCheck", "core");
      const resetTime = detail.core.resetAt.toLocaleTimeString();
      setRlDetail(
        `Core:    ${detail.core.remaining.toLocaleString()}/${detail.core.limit.toLocaleString()} remaining\n` +
        `GraphQL: ${detail.graphql.remaining.toLocaleString()}/${detail.graphql.limit.toLocaleString()} remaining\n` +
        `Resets:  ${resetTime}`
      );
    });
  }

  function resolveInitialTab(): TabId {
    const tab = config.rememberLastTab ? viewState.lastActiveTab : config.defaultTab;
    if (tab === "tracked" && !config.enableTracking) return "issues";
    return tab;
  }

  const [activeTab, setActiveTab] = createSignal<TabId>(resolveInitialTab());

  function handleTabChange(tab: TabId) {
    setActiveTab(tab);
    updateViewState({ lastActiveTab: tab });
  }

  const [clockTick, setClockTick] = createSignal(0);

  // Redirect away from tracked tab when tracking is disabled at runtime
  createEffect(() => {
    if (!config.enableTracking && activeTab() === "tracked") {
      handleTabChange("issues");
    }
  });

  // Auto-prune tracked items that are closed/merged (absent from is:open results)
  createEffect(() => {
    // IMPORTANT: Access reactive store fields BEFORE early-return guards
    // so SolidJS registers them as dependencies even when the guard short-circuits
    const issues = dashboardData.issues;
    const prs = dashboardData.pullRequests;
    if (!config.enableTracking || viewState.trackedItems.length === 0 || !hasFetchedFresh()) return;

    const polledRepos = new Set([
      ...config.selectedRepos.map((r) => r.fullName),
      ...config.upstreamRepos.map((r) => r.fullName),
    ]);
    const liveIssueIds = new Set(issues.map((i) => i.id));
    const livePrIds = new Set(prs.map((p) => p.id));

    const pruneKeys = new Set<string>();
    for (const item of viewState.trackedItems) {
      if (!polledRepos.has(item.repoFullName)) continue; // repo deselected — keep item
      const isLive = item.type === "issue" ? liveIssueIds.has(item.id) : livePrIds.has(item.id);
      if (!isLive) pruneKeys.add(`${item.type}:${item.id}`);
    }
    if (pruneKeys.size > 0) pruneClosedTrackedItems(pruneKeys);
  });

  onMount(() => {
    if (!_coordinator()) {
      _setCoordinator(createPollCoordinator(() => config.refreshInterval, pollFetch));
    }

    if (!_hotCoordinator()) {
      _setHotCoordinator(createHotPollCoordinator(
        () => config.hotPollInterval,
        (prUpdates, runUpdates, fetchGeneration) => {
          // Guard against stale hot poll results overlapping with a full refresh.
          // fetchGeneration was captured BEFORE fetchHotData() started its async work.
          // If a full refresh completed during the fetch, _hotPollGeneration will have
          // been incremented by rebuildHotSets(), and fetchGeneration will be stale.
          if (fetchGeneration !== getHotPollGeneration()) return; // stale, discard
          setDashboardData(produce((state) => {
            // Apply PR status updates
            for (const pr of state.pullRequests) {
              const update = prUpdates.get(pr.id);
              if (!update) continue;
              pr.state = update.state; // detect closed/merged quickly
              pr.checkStatus = update.checkStatus;
              pr.reviewDecision = update.reviewDecision;
            }
            // Apply workflow run updates
            for (const run of state.workflowRuns) {
              const update = runUpdates.get(run.id);
              if (!update) continue;
              run.status = update.status;
              run.conclusion = update.conclusion;
              run.updatedAt = update.updatedAt;
              run.completedAt = update.completedAt;
            }
          }));
          // Prune tracked PRs that became closed/merged via hot poll.
          // The auto-prune createEffect only fires when the pullRequests array
          // reference changes (full refresh). Hot poll mutates nested pr.state
          // in-place via produce(), leaving the array ref unchanged.
          if (config.enableTracking && viewState.trackedItems.length > 0 && prUpdates.size > 0) {
            const pruneKeys = new Set<string>();
            for (const [prId, update] of prUpdates) {
              const stateVal = update.state?.toUpperCase();
              if (stateVal === "CLOSED" || stateVal === "MERGED") {
                if (viewState.trackedItems.some(t => t.type === "pullRequest" && t.id === prId)) {
                  pruneKeys.add(`pullRequest:${prId}`);
                }
              }
            }
            if (pruneKeys.size > 0) pruneClosedTrackedItems(pruneKeys);
          }
        },
        {
          onStart: (prDbIds, runIds) => {
            if (!setsEqual(hotPollingPRIds(), prDbIds)) setHotPollingPRIds(prDbIds);
            if (!setsEqual(hotPollingRunIds(), runIds)) setHotPollingRunIds(runIds);
          },
          onEnd: () => {
            if (hotPollingPRIds().size > 0) setHotPollingPRIds(new Set<number>());
            if (hotPollingRunIds().size > 0) setHotPollingRunIds(new Set<number>());
          },
        }
      ));
    }

    // Auto-sync orgs on dashboard load — picks up newly accessible orgs
    // after re-auth, scope changes, or org policy updates.
    // Only adds orgs to the filter list — repos are user-selected via Settings.
    const client = getClient();
    if (client && config.onboardingComplete) {
      void fetchOrgs(client).then((allOrgs) => {
        const currentSet = new Set(config.selectedOrgs.map((o) => o.toLowerCase()));
        const newOrgs = allOrgs
          .map((o) => o.login)
          .filter((login) => !currentSet.has(login.toLowerCase()));
        if (newOrgs.length > 0) {
          setConfig("selectedOrgs", [...config.selectedOrgs, ...newOrgs]);
          console.info(`[dashboard] auto-synced ${newOrgs.length} new org(s)`);
        }
      }).catch(() => {
        // Non-fatal — org sync failure doesn't block dashboard
      });
    }

    // Wall-clock tick keeps relative time displays fresh between full poll cycles.
    const clockInterval = setInterval(() => setClockTick((t) => t + 1), 60_000);

    onCleanup(() => {
      const coord = _coordinator();
      const hotCoord = _hotCoordinator();
      coord?.destroy();
      if (_coordinator() === coord) _setCoordinator(null);
      hotCoord?.destroy();
      if (_hotCoordinator() === hotCoord) _setHotCoordinator(null);
      clearHotSets();
      clearInterval(clockInterval);
    });
  });

  const refreshTick = createMemo(() => (dashboardData.lastRefreshedAt?.getTime() ?? 0) + clockTick());

  const tabCounts = createMemo(() => {
    const { org, repo } = viewState.globalFilter;
    const ignoredByType = (type: string) =>
      new Set(viewState.ignoredItems.filter((i) => i.type === type).map((i) => i.id));

    const ignoredIssues = ignoredByType("issue");
    const ignoredPRs = ignoredByType("pullRequest");
    const ignoredRuns = ignoredByType("workflowRun");

    return {
      issues: dashboardData.issues.filter((i) => {
        if (ignoredIssues.has(i.id)) return false;
        if (viewState.hideDepDashboard && i.title === "Dependency Dashboard") return false;
        if (repo && i.repoFullName !== repo) return false;
        if (org && !i.repoFullName.startsWith(org + "/")) return false;
        return true;
      }).length,
      pullRequests: dashboardData.pullRequests.filter((p) => {
        if (ignoredPRs.has(p.id)) return false;
        if (repo && p.repoFullName !== repo) return false;
        if (org && !p.repoFullName.startsWith(org + "/")) return false;
        return true;
      }).length,
      actions: dashboardData.workflowRuns.filter((w) => {
        if (ignoredRuns.has(w.id)) return false;
        if (!viewState.showPrRuns && w.isPrRun) return false;
        if (repo && w.repoFullName !== repo) return false;
        if (org && !w.repoFullName.startsWith(org + "/")) return false;
        return true;
      }).length,
      ...(config.enableTracking ? { tracked: viewState.trackedItems.length } : {}),
    };
  });

  const userLogin = createMemo(() => user()?.login ?? "");
  const allUsers = createMemo(() => {
    const login = userLogin().toLowerCase();
    if (!login) return [];
    return [
      { login, label: "Me" },
      ...config.trackedUsers.map((u: TrackedUser) => ({ login: u.login, label: u.login })),
    ];
  });

  return (
    <div class="min-h-screen bg-base-200">
      <Header />

      {/* Offset for fixed header */}
      <div class="pt-14 min-h-[calc(100vh-3.5rem)] flex flex-col">
        <div class="max-w-6xl mx-auto w-full bg-base-100 shadow-lg border-x border-base-300 flex-1">
          <div class="sticky top-14 z-40 bg-base-100">
            <PersonalSummaryStrip
              issues={dashboardData.issues}
              pullRequests={dashboardData.pullRequests}
              workflowRuns={dashboardData.workflowRuns}
              userLogin={userLogin()}
              onTabChange={handleTabChange}
            />
            <TabBar
              activeTab={activeTab()}
              onTabChange={handleTabChange}
              counts={tabCounts()}
              enableTracking={config.enableTracking}
            />

            <FilterBar
              isRefreshing={_coordinator()?.isRefreshing() ?? dashboardData.loading}
              lastRefreshedAt={_coordinator()?.lastRefreshAt() ?? dashboardData.lastRefreshedAt}
              onRefresh={() => _coordinator()?.manualRefresh()}
              sortOptions={globalSortOptions}
              sortValue={viewState.globalSort.field}
              sortDirection={viewState.globalSort.direction}
              onSortChange={(field, dir) => setSortPreference(field, dir)}
            />
          </div>

          <main class="pb-12">
            <Switch>
              <Match when={activeTab() === "issues"}>
                <IssuesTab
                  issues={dashboardData.issues}
                  loading={dashboardData.loading}
                  userLogin={userLogin()}
                  allUsers={allUsers()}
                  trackedUsers={config.trackedUsers}
                  monitoredRepos={config.monitoredRepos}
                  refreshTick={refreshTick()}
                />
              </Match>
              <Match when={activeTab() === "pullRequests"}>
                <PullRequestsTab
                  pullRequests={dashboardData.pullRequests}
                  loading={dashboardData.loading}
                  userLogin={userLogin()}
                  allUsers={allUsers()}
                  trackedUsers={config.trackedUsers}
                  hotPollingPRIds={hotPollingPRIds()}
                  monitoredRepos={config.monitoredRepos}
                  refreshTick={refreshTick()}
                />
              </Match>
              <Match when={activeTab() === "tracked"}>
                <TrackedTab
                  issues={dashboardData.issues}
                  pullRequests={dashboardData.pullRequests}
                  refreshTick={refreshTick()}
                />
              </Match>
              <Match when={activeTab() === "actions"}>
                <ActionsTab
                  workflowRuns={dashboardData.workflowRuns}
                  loading={dashboardData.loading}
                  hasUpstreamRepos={config.upstreamRepos.length > 0}
                  refreshTick={refreshTick()}
                  hotPollingRunIds={hotPollingRunIds()}
                />
              </Match>
            </Switch>
          </main>
        </div>

        <footer class="app-footer fixed bottom-0 left-0 right-0 z-30 border-t border-base-300 bg-base-100 py-3 text-xs text-base-content/50">
          <div class="max-w-6xl mx-auto w-full px-4 grid grid-cols-3 items-center">
            <div />
            <div class="flex items-center justify-center gap-3">
              <a
                href="https://github.com/gordon-code/github-tracker"
                target="_blank"
                rel="noopener noreferrer"
                class="link link-hover"
              >
                Source
              </a>
              <span aria-hidden="true">&middot;</span>
              <a
                href="https://github.com/gordon-code/github-tracker/blob/main/docs/USER_GUIDE.md"
                target="_blank"
                rel="noopener noreferrer"
                class="link link-hover"
              >
                Guide
              </a>
              <span aria-hidden="true">&middot;</span>
              <a
                href="/privacy"
                class="link link-hover"
              >
                Privacy
              </a>
            </div>
            <div class="flex justify-end">
              <Show when={getGraphqlRateLimit()}>
                {(rl) => (
                  <div onPointerEnter={fetchAndSetRlDetail} onFocusIn={fetchAndSetRlDetail}>
                    <Tooltip content={rlDetail()} placement="left" focusable contentClass="whitespace-pre font-mono text-xs">
                      <span class={`tabular-nums ${rl().remaining < rl().limit * 0.1 ? "text-warning" : ""}`}>
                        API RL: {rl().remaining.toLocaleString()}/{formatCount(rl().limit)}/hr
                      </span>
                    </Tooltip>
                  </div>
                )}
              </Show>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
