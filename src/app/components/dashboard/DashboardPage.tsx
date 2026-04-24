import { createSignal, createMemo, createEffect, Show, Switch, Match, onMount, onCleanup, untrack } from "solid-js";
import { createStore, produce, unwrap } from "solid-js/store";
import Header from "../layout/Header";
import TabBar, { TabId } from "../layout/TabBar";
import FilterBar from "../layout/FilterBar";
import ActionsTab from "./ActionsTab";
import IssuesTab from "./IssuesTab";
import PullRequestsTab from "./PullRequestsTab";
import TrackedTab from "./TrackedTab";
import PersonalSummaryStrip from "./PersonalSummaryStrip";
import { config, setConfig, getCustomTab, isBuiltinTab, type TrackedUser } from "../../stores/config";
import { viewState, updateViewState, setSortPreference, pruneClosedTrackedItems, removeCustomTabState, IssueFiltersSchema, PullRequestFiltersSchema, ActionsFiltersSchema } from "../../stores/view";
import type { SortOption } from "../shared/SortDropdown";
import type { Issue, PullRequest, WorkflowRun } from "../../services/api";
import { fetchOrgs } from "../../services/api";
import {
  createPollCoordinator,
  createHotPollCoordinator,
  createEventsPollCoordinator,
  rebuildHotSets,
  seedHotSetsFromTargeted,
  clearHotSets,
  getHotPollGeneration,
  fetchAllData,
  type DashboardData,
} from "../../services/poll";
import { expireToken, user, onAuthCleared, DASHBOARD_STORAGE_KEY } from "../../stores/auth";
import { updateRelaySnapshot } from "../../lib/mcp-relay";
import { pushNotification, pushError } from "../../lib/errors";
import { detectNewItems, dispatchNotifications } from "../../lib/notifications";
import { getClient, getGraphqlRateLimit, fetchRateLimitDetails } from "../../services/github";
import { formatCount, prSizeCategory, rateLimitCssClass } from "../../lib/format";
import { setsEqual } from "../../lib/collections";
import { withScrollLock } from "../../lib/scroll";
import { Tooltip } from "../shared/Tooltip";
import { isIssueVisible, isPrVisible, isRunVisible } from "../../lib/filters";
import { isUserInvolved } from "../../lib/grouping";
import { KNOWN_CONCLUSIONS, KNOWN_EVENTS } from "../shared/filterTypes";
import CustomTabModal from "../shared/CustomTabModal";
import { mergeActiveFilters } from "../../lib/tabFilters";
import type { CustomTab } from "../../stores/config";

// Hoisted to module scope — these are constant values (Zod schema defaults).
const ISSUE_FILTER_DEFAULTS = IssueFiltersSchema.parse({});
const PR_FILTER_DEFAULTS = PullRequestFiltersSchema.parse({});
const ACTIONS_FILTER_DEFAULTS = ActionsFiltersSchema.parse({});

/** Build a scope matcher for a custom tab's org/repo scope. Shared between customTabData and tabCounts. */
function buildTabScopeMatcher(tab: CustomTab): (repoFullName: string) => boolean {
  const orgSet = tab.orgScope.length > 0 ? new Set(tab.orgScope.map((o) => o.toLowerCase())) : null;
  const repoSet = tab.repoScope.length > 0 ? new Set(tab.repoScope.map((r) => r.fullName.toLowerCase())) : null;
  return (repoFullName: string) => {
    if (repoSet && repoSet.has(repoFullName.toLowerCase())) return true;
    if (orgSet && orgSet.has(repoFullName.split("/")[0].toLowerCase())) return true;
    return !orgSet && !repoSet;
  };
}

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

const [lastFetchHadErrors, setLastFetchHadErrors] = createSignal(false);

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
  const eventsCoord = _eventsCoordinator();
  if (eventsCoord) {
    eventsCoord.destroy();
    if (_eventsCoordinator() === eventsCoord) _setEventsCoordinator(null);
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
    const hasErrors = data.errors.length > 0;
    setLastFetchHadErrors(hasErrors);

    // When the fetch had errors and returned no data, keep stale dashboard
    // visible rather than wiping it to empty. This prevents the summary strip,
    // tab counts, and tracked items from vanishing during rate limiting.
    if (hasErrors && data.issues.length === 0 && data.pullRequests.length === 0 && data.workflowRuns.length === 0) {
      setDashboardData("loading", false);
      return data;
    }

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
const [_eventsCoordinator, _setEventsCoordinator] = createSignal<{ destroy: () => void } | null>(null);

// Mutates data.issues[].surfacedBy and data.pullRequests[].surfacedBy in-place before merging.
function handleTargetedData(data: DashboardData, affectedRepos: string[]): void {
  const affectedSet = new Set(affectedRepos.map(r => r.toLowerCase()));

  // Build surfacedBy index from old store items BEFORE the merge
  const oldSurfacedByIssues = new Map<number, string[]>();
  for (const i of dashboardData.issues) {
    if (affectedSet.has(i.repoFullName.toLowerCase()) && i.surfacedBy?.length) {
      oldSurfacedByIssues.set(i.id, i.surfacedBy);
    }
  }
  const oldSurfacedByPRs = new Map<number, string[]>();
  for (const pr of dashboardData.pullRequests) {
    if (affectedSet.has(pr.repoFullName.toLowerCase()) && pr.surfacedBy?.length) {
      oldSurfacedByPRs.set(pr.id, pr.surfacedBy);
    }
  }

  // Merge surfacedBy into targeted results before appending
  for (const item of data.issues) {
    const oldSb = oldSurfacedByIssues.get(item.id);
    if (oldSb) {
      item.surfacedBy = [...new Set([...(item.surfacedBy ?? []), ...oldSb])];
    }
  }
  for (const pr of data.pullRequests) {
    const oldSb = oldSurfacedByPRs.get(pr.id);
    if (oldSb) {
      pr.surfacedBy = [...new Set([...(pr.surfacedBy ?? []), ...oldSb])];
    }
  }

  withScrollLock(() => {
    setDashboardData(produce((state) => {
      // ID-based merge: replace targeted items, keep unaffected + tracked-user-only items
      const newIssueIds = new Set(data.issues.map(i => i.id));
      state.issues = [
        ...state.issues.filter(i =>
          !affectedSet.has(i.repoFullName.toLowerCase()) ||
          !newIssueIds.has(i.id)
        ),
        ...data.issues,
      ];
      const newPRIds = new Set(data.pullRequests.map(pr => pr.id));
      state.pullRequests = [
        ...state.pullRequests.filter(pr =>
          !affectedSet.has(pr.repoFullName.toLowerCase()) ||
          !newPRIds.has(pr.id)
        ),
        ...data.pullRequests,
      ];
      const newRunIds = new Set(data.workflowRuns.map(r => r.id));
      state.workflowRuns = [
        ...state.workflowRuns.filter(r =>
          !affectedSet.has(r.repoFullName.toLowerCase()) ||
          !newRunIds.has(r.id)
        ),
        ...data.workflowRuns,
      ];
    }));
  });

  for (const err of data.errors) {
    pushError(err.repo, err.message, err.retryable);
  }

  const newItems = detectNewItems(data);
  dispatchNotifications(newItems, config);

  seedHotSetsFromTargeted(data);

  // Capture snapshot eagerly — a concurrent hot poll can mutate the store via produce
  // between here and the deferred setTimeout write.
  const lastRefreshed = dashboardData.lastRefreshedAt;
  const snapshot = {
    _v: CACHE_VERSION,
    issues: [...dashboardData.issues],
    pullRequests: [...dashboardData.pullRequests],
    workflowRuns: [...dashboardData.workflowRuns],
    lastRefreshedAt: lastRefreshed?.toISOString() ?? null,
  };
  setTimeout(() => {
    try {
      localStorage.setItem(DASHBOARD_STORAGE_KEY, JSON.stringify(snapshot));
    } catch {
      // Non-fatal
    }
  }, 0);
}

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
      const resetTime = detail.graphql.resetAt.toLocaleTimeString();
      setRlDetail(
        `Core:    ${detail.core.remaining.toLocaleString()}/${detail.core.limit.toLocaleString()} remaining\n` +
        `GraphQL: ${detail.graphql.remaining.toLocaleString()}/${detail.graphql.limit.toLocaleString()} remaining\n` +
        `Resets:  ${resetTime}`
      );
    });
  }

  if (import.meta.env.DEV) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__debug = {
      forceHotPoll: () => {
        const allPrIds = new Set<number>(dashboardData.pullRequests.map(pr => pr.id));
        setHotPollingPRIds(allPrIds);
        console.info(`[debug] Shimmer ON for ${allPrIds.size} PRs. Call __debug.clearHotPoll() to stop.`);
      },
      clearHotPoll: () => {
        setHotPollingPRIds(new Set<number>());
        setHotPollingRunIds(new Set<number>());
        console.info("[debug] Shimmer OFF");
      },
    };
  }

  function resolveInitialTab(): TabId {
    const tab = config.rememberLastTab ? viewState.lastActiveTab : config.defaultTab;
    if (tab === "tracked" && !config.enableTracking) return "issues";
    // Validate custom tab still exists; fall back to "issues" if stale
    if (!isBuiltinTab(tab) && !config.customTabs.some((t) => t.id === tab)) return "issues";
    return tab;
  }

  const [activeTab, setActiveTab] = createSignal<TabId>(resolveInitialTab());

  function handleTabChange(tab: TabId) {
    // Reject invalid tab IDs to prevent persisting stale state
    if (!isBuiltinTab(tab) && !config.customTabs.some((t) => t.id === tab)) return;
    setActiveTab(tab);
    updateViewState({ lastActiveTab: tab });
  }

  const [clockTick, setClockTick] = createSignal(0);
  const [showCustomTabModal, setShowCustomTabModal] = createSignal(false);
  const [editingTabId, setEditingTabId] = createSignal<string | null>(null);
  const editingTab = createMemo(() => {
    const id = editingTabId();
    if (!id) return undefined;
    return getCustomTab(id);
  });

  // Redirect away from tracked tab when tracking is disabled at runtime
  createEffect(() => {
    if (!config.enableTracking && activeTab() === "tracked") {
      handleTabChange("issues");
    }
  });

  // Redirect away from a custom tab that was deleted while active
  createEffect(() => {
    const tab = activeTab();
    if (!isBuiltinTab(tab) && !config.customTabs.some((t) => t.id === tab)) {
      handleTabChange("issues");
    }
  });

  // Close modal if the tab being edited is deleted (CR-014)
  createEffect(() => {
    const id = editingTabId();
    if (id && !config.customTabs.some((t) => t.id === id)) {
      setShowCustomTabModal(false);
      setEditingTabId(null);
    }
  });

  // Auto-prune tracked items that are closed/merged (absent from is:open results)
  createEffect(() => {
    // IMPORTANT: Access reactive store fields BEFORE early-return guards
    // so SolidJS registers them as dependencies even when the guard short-circuits
    const issues = dashboardData.issues;
    const prs = dashboardData.pullRequests;
    if (!config.enableTracking || viewState.trackedItems.length === 0 || !hasFetchedFresh()) return;
    // Never prune when the last fetch had errors (rate limit, network failure, etc.)
    // — the missing items are likely just unfetched, not closed/merged.
    if (lastFetchHadErrors()) return;

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

    if (!_eventsCoordinator()) {
      _setEventsCoordinator(createEventsPollCoordinator(
        () => user()?.login ?? "",
        () => {
          const repos = new Set<string>();
          for (const r of [...config.selectedRepos, ...(config.upstreamRepos ?? []), ...(config.monitoredRepos ?? [])]) {
            repos.add(`${r.owner}/${r.name}`.toLowerCase());
          }
          return repos;
        },
        () => _coordinator()?.isRefreshing() ?? false,
        handleTargetedData,
      ));
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
          const terminalPrIds = new Set<number>();
          for (const [prId, update] of prUpdates) {
            const s = update.state;
            if (s === "CLOSED" || s === "MERGED") terminalPrIds.add(prId);
          }
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
            if (terminalPrIds.size > 0) {
              state.pullRequests = state.pullRequests.filter((pr) => !terminalPrIds.has(pr.id));
            }
          }));
          if (terminalPrIds.size > 0) {
            console.info(`[hot-poll] Spliced ${terminalPrIds.size} terminal PR(s) from store`);
            setTimeout(() => {
              try {
                const cachePayload = {
                  _v: CACHE_VERSION,
                  issues: dashboardData.issues,
                  pullRequests: dashboardData.pullRequests,
                  workflowRuns: dashboardData.workflowRuns,
                  lastRefreshedAt: dashboardData.lastRefreshedAt?.toISOString(),
                };
                localStorage.setItem(DASHBOARD_STORAGE_KEY, JSON.stringify(cachePayload));
              } catch {
                pushNotification("localStorage:dashboard", "Dashboard cache write failed — storage may be full", "warning");
              }
            }, 0);
          }
          // Prune tracked PRs that became closed/merged via hot poll.
          // The auto-prune createEffect only fires when the pullRequests array
          // reference changes (full refresh). Hot poll mutates nested pr.state
          // in-place via produce(), leaving the array ref unchanged.
          if (config.enableTracking && viewState.trackedItems.length > 0 && prUpdates.size > 0) {
            const pruneKeys = new Set<string>();
            for (const [prId, update] of prUpdates) {
              if (update.state === "CLOSED" || update.state === "MERGED") {
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
      const eventsCoord = _eventsCoordinator();
      coord?.destroy();
      if (_coordinator() === coord) _setCoordinator(null);
      hotCoord?.destroy();
      if (_hotCoordinator() === hotCoord) _setHotCoordinator(null);
      eventsCoord?.destroy();
      if (_eventsCoordinator() === eventsCoord) _setEventsCoordinator(null);
      clearHotSets();
      clearInterval(clockInterval);
    });
  });

  const refreshTick = createMemo(() => (dashboardData.lastRefreshedAt?.getTime() ?? 0) + clockTick());

  const userLogin = createMemo(() => user()?.login ?? "");
  const allUsers = createMemo(() => {
    const login = userLogin().toLowerCase();
    if (!login) return [];
    return [
      { login, label: "Me" },
      ...config.trackedUsers.map((u: TrackedUser) => ({ login: u.login, label: u.login })),
    ];
  });

  // Eagerly compute scoped data for exclusive custom tabs (needed by exclusiveOwnership).
  // Non-exclusive tabs only compute when they are the active tab.
  const customTabData = createMemo(() => {
    const currentTabId = activeTab();
    const result: Record<string, { issues: typeof dashboardData.issues; pullRequests: typeof dashboardData.pullRequests; workflowRuns: typeof dashboardData.workflowRuns }> = {};
    for (const tab of config.customTabs) {
      if (!tab.exclusive && tab.id !== currentTabId) continue;
      const matchesScope = buildTabScopeMatcher(tab);
      result[tab.id] = {
        issues: tab.baseType === "issues" ? dashboardData.issues.filter((i) => matchesScope(i.repoFullName)) : [],
        pullRequests: tab.baseType === "pullRequests" ? dashboardData.pullRequests.filter((p) => matchesScope(p.repoFullName)) : [],
        workflowRuns: tab.baseType === "actions" ? dashboardData.workflowRuns.filter((w) => matchesScope(w.repoFullName)) : [],
      };
    }
    return result;
  });

  // Item-level exclusive ownership: first exclusive tab claiming an item wins.
  // Only claims items matching the tab's baseType (an exclusive Issues tab must
  // not hide PRs or workflow runs from their respective tabs).
  const exclusiveOwnership = createMemo(() => {
    const issueOwner = new Map<number, string>();
    const prOwner = new Map<number, string>();
    const runOwner = new Map<number, string>();
    for (const tab of config.customTabs) {
      if (!tab.exclusive) continue;
      const data = customTabData()[tab.id];
      if (!data) continue;
      if (tab.baseType === "issues") {
        for (const i of data.issues) if (!issueOwner.has(i.id)) issueOwner.set(i.id, tab.id);
      } else if (tab.baseType === "pullRequests") {
        for (const p of data.pullRequests) if (!prOwner.has(p.id)) prOwner.set(p.id, tab.id);
      } else {
        for (const w of data.workflowRuns) if (!runOwner.has(w.id)) runOwner.set(w.id, tab.id);
      }
    }
    return { issues: issueOwner, pullRequests: prOwner, actions: runOwner };
  });

  function isItemVisibleOnTab(ownerMap: Map<number, string>, itemId: number, viewingTabId: string): boolean {
    const owner = ownerMap.get(itemId);
    if (!owner) return true; // not claimed by any exclusive tab
    return owner === viewingTabId; // only visible on its owning tab
  }

  // Visible data for built-in tabs — filters out exclusively-owned items
  const visibleIssues = createMemo(() => {
    const map = exclusiveOwnership().issues;
    if (map.size === 0) return dashboardData.issues.filter((i) => i.state === "OPEN");
    return dashboardData.issues.filter((i) => i.state === "OPEN" && isItemVisibleOnTab(map, i.id, "issues"));
  });
  const visiblePullRequests = createMemo(() => {
    const map = exclusiveOwnership().pullRequests;
    if (map.size === 0) return dashboardData.pullRequests.filter((p) => p.state === "OPEN");
    return dashboardData.pullRequests.filter((p) => p.state === "OPEN" && isItemVisibleOnTab(map, p.id, "pullRequests"));
  });
  const visibleWorkflowRuns = createMemo(() => {
    const map = exclusiveOwnership().actions;
    if (map.size === 0) return dashboardData.workflowRuns;
    return dashboardData.workflowRuns.filter((w) => isItemVisibleOnTab(map, w.id, "actions"));
  });

  const tabCounts = createMemo(() => {
    const { org, repo } = viewState.globalFilter;
    const ignoredIssues = new Set<number>();
    const ignoredPRs = new Set<number>();
    const ignoredRuns = new Set<number>();
    for (const item of viewState.ignoredItems) {
      if (item.type === "issue") ignoredIssues.add(item.id);
      else if (item.type === "pullRequest") ignoredPRs.add(item.id);
      else ignoredRuns.add(item.id);
    }
    const ownership = exclusiveOwnership();

    const builtinFilter = { org, repo };
    const login = userLogin().toLowerCase();
    const monitoredSet = new Set((config.monitoredRepos ?? []).map((r) => r.fullName));
    const users = allUsers();
    const customCounts: Record<string, number> = {};
    for (const tab of config.customTabs) {
      // customTabData skips non-exclusive inactive tabs (perf optimization),
      // so compute scope on demand for tabs absent from the memo.
      let data = customTabData()[tab.id];
      if (!data) {
        const matchesScope = buildTabScopeMatcher(tab);
        data = {
          issues: tab.baseType === "issues" ? dashboardData.issues.filter((i) => matchesScope(i.repoFullName)) : [],
          pullRequests: tab.baseType === "pullRequests" ? dashboardData.pullRequests.filter((p) => matchesScope(p.repoFullName)) : [],
          workflowRuns: tab.baseType === "actions" ? dashboardData.workflowRuns.filter((w) => matchesScope(w.repoFullName)) : [],
        };
      }
      // Merge filter chain via shared helper (same as tab components)
      const preset = tab.filterPreset;
      if (tab.baseType === "issues") {
        const f = mergeActiveFilters(IssueFiltersSchema, ISSUE_FILTER_DEFAULTS, tab.id, ISSUE_FILTER_DEFAULTS, {
          preset, resolveLogin: login,
        });
        customCounts[tab.id] = data.issues.filter((i) => {
          if (i.state !== "OPEN") return false;
          if (!isItemVisibleOnTab(ownership.issues, i.id, tab.id)) return false;
          if (!isIssueVisible(i, { ignoredIds: ignoredIssues, hideDepDashboard: viewState.hideDepDashboard, globalFilter: null })) return false;
          if (f.scope === "involves_me" && !isUserInvolved(i, login, monitoredSet)) return false;
          if (f.role === "author" && i.userLogin.toLowerCase() !== login) return false;
          if (f.role === "assignee" && !i.assigneeLogins?.some((a) => a.toLowerCase() === login)) return false;
          if (f.comments === "has" && (i.comments ?? 0) === 0) return false;
          if (f.comments === "none" && (i.comments ?? 0) > 0) return false;
          if (f.user !== "all") {
            const validUser = !users.length || users.some((u) => u.login === f.user);
            if (validUser && !monitoredSet.has(i.repoFullName)) {
              const surfacedBy = i.surfacedBy ?? [login];
              if (!surfacedBy.includes(f.user)) return false;
            }
          }
          return true;
        }).length;
      } else if (tab.baseType === "pullRequests") {
        const f = mergeActiveFilters(PullRequestFiltersSchema, PR_FILTER_DEFAULTS, tab.id, PR_FILTER_DEFAULTS, {
          preset, resolveLogin: login,
        });
        customCounts[tab.id] = data.pullRequests.filter((p) => {
          if (p.state !== "OPEN") return false;
          if (!isItemVisibleOnTab(ownership.pullRequests, p.id, tab.id)) return false;
          if (!isPrVisible(p, { ignoredIds: ignoredPRs, globalFilter: null })) return false;
          if (f.scope === "involves_me" && !isUserInvolved(p, login, monitoredSet, p.enriched !== false ? p.reviewerLogins : undefined)) return false;
          // Guard role filter on enriched: light-phase PRs have empty reviewerLogins/assigneeLogins
          if (p.enriched !== false) {
            if (f.role === "author" && p.userLogin.toLowerCase() !== login) return false;
            if (f.role === "reviewer" && !p.reviewerLogins?.some((r) => r.toLowerCase() === login)) return false;
            if (f.role === "assignee" && !p.assigneeLogins?.some((a) => a.toLowerCase() === login)) return false;
          } else {
            if (f.role === "author" && p.userLogin.toLowerCase() !== login) return false;
          }
          if (f.draft === "draft" && !p.draft) return false;
          if (f.draft === "ready" && p.draft) return false;
          if (f.checkStatus !== "all" && p.enriched !== false) {
            if (f.checkStatus === "none") { if (p.checkStatus !== null) return false; }
            else if (f.checkStatus === "blocked") { if (p.checkStatus !== "failure" && p.checkStatus !== "conflict") return false; }
            else if (p.checkStatus !== f.checkStatus) return false;
          }
          if (f.reviewDecision !== "all") {
            if (f.reviewDecision === "mergeable") {
              if (p.reviewDecision !== "APPROVED" && p.reviewDecision !== null) return false;
            } else if (p.reviewDecision !== f.reviewDecision) return false;
          }
          if (f.sizeCategory !== "all" && p.enriched !== false) {
            if (prSizeCategory(p.additions, p.deletions) !== f.sizeCategory) return false;
          }
          if (f.user !== "all") {
            const validUser = !users.length || users.some((u) => u.login === f.user);
            if (validUser && !monitoredSet.has(p.repoFullName)) {
              const surfacedBy = p.surfacedBy ?? [login];
              if (!surfacedBy.includes(f.user)) return false;
            }
          }
          return true;
        }).length;
      } else {
        const f = mergeActiveFilters(ActionsFiltersSchema, ACTIONS_FILTER_DEFAULTS, tab.id, ACTIONS_FILTER_DEFAULTS, { preset });
        customCounts[tab.id] = data.workflowRuns.filter((w) => {
          if (!isItemVisibleOnTab(ownership.actions, w.id, tab.id)) return false;
          if (!isRunVisible(w, { ignoredIds: ignoredRuns, showPrRuns: viewState.showPrRuns, globalFilter: null })) return false;
          if (f.conclusion !== "all") {
            if (f.conclusion === "running") { if (w.status !== "in_progress") return false; }
            else if (f.conclusion === "other") { if (w.conclusion === null || (KNOWN_CONCLUSIONS as readonly string[]).includes(w.conclusion)) return false; }
            else if (w.conclusion !== f.conclusion) return false;
          }
          if (f.event !== "all") {
            if (f.event === "other") { if ((KNOWN_EVENTS as readonly string[]).includes(w.event)) return false; }
            else if (w.event !== f.event) return false;
          }
          return true;
        }).length;
      }
    }

    return {
      issues: visibleIssues().filter((i) =>
        isIssueVisible(i, { ignoredIds: ignoredIssues, hideDepDashboard: viewState.hideDepDashboard, globalFilter: builtinFilter })
      ).length,
      pullRequests: visiblePullRequests().filter((p) =>
        isPrVisible(p, { ignoredIds: ignoredPRs, globalFilter: builtinFilter })
      ).length,
      actions: visibleWorkflowRuns().filter((w) =>
        isRunVisible(w, { ignoredIds: ignoredRuns, showPrRuns: viewState.showPrRuns, globalFilter: builtinFilter })
      ).length,
      ...(config.enableTracking ? { tracked: viewState.trackedItems.length } : {}),
      ...customCounts,
    };
  });

  // Reactive cleanup: prune orphaned view state when customTabs list changes
  createEffect(() => {
    const activeIds = new Set(config.customTabs.map((t) => t.id));
    const staleIds = untrack(() => {
      const keys = new Set([
        ...Object.keys(viewState.customTabFilters),
        ...Object.keys(viewState.expandedRepos).filter((k) => !isBuiltinTab(k)),
        ...Object.keys(viewState.lockedRepos).filter((k) => !isBuiltinTab(k)),
      ]);
      return [...keys].filter((id) => !activeIds.has(id));
    });
    for (const id of staleIds) removeCustomTabState(id);
  });

  // Memo for the active custom tab definition (null when a built-in tab is active)
  const activeCustomTab = createMemo(() => {
    const id = activeTab();
    if (isBuiltinTab(id)) return null;
    return getCustomTab(id) ?? null;
  });

  // Push dashboard data into the MCP relay snapshot on each full refresh.
  // Tracks lastRefreshedAt (always updated alongside data arrays in pollFetch).
  // Hot poll updates are intentionally excluded — relay reflects full-refresh data only.
  createEffect(() => {
    if (!config.mcpRelayEnabled) return;
    if (!dashboardData.lastRefreshedAt) return;
    const d = unwrap(dashboardData);
    updateRelaySnapshot({
      issues: d.issues,
      pullRequests: d.pullRequests,
      workflowRuns: d.workflowRuns,
      lastUpdatedAt: Date.now(),
    });
  });

  const configRepoNames = createMemo(() =>
    [...new Set([...config.selectedRepos, ...config.upstreamRepos, ...config.monitoredRepos].map(r => r.fullName))]
  );

  return (
    <div class="min-h-screen bg-base-200">
      <Header />

      {/* Offset for fixed header */}
      <div class="pt-14 min-h-[calc(100vh-3.5rem)] flex flex-col">
        <div class="max-w-6xl mx-auto w-full bg-base-100 shadow-lg border-x border-base-300 flex-1">
          <div class="sticky top-14 z-40 bg-base-100">
            <PersonalSummaryStrip
              issues={visibleIssues()}
              pullRequests={visiblePullRequests()}
              workflowRuns={visibleWorkflowRuns()}
              userLogin={userLogin()}
              onTabChange={handleTabChange}
            />
            <TabBar
              activeTab={activeTab()}
              onTabChange={handleTabChange}
              counts={tabCounts()}
              enableTracking={config.enableTracking}
              customTabs={config.customTabs.map((t) => ({ id: t.id, name: t.name }))}
              onAddTab={() => setShowCustomTabModal(true)}
              onEditTab={(id) => { setEditingTabId(id); setShowCustomTabModal(true); }}
            />

            <FilterBar
              isRefreshing={_coordinator()?.isRefreshing() ?? dashboardData.loading}
              lastRefreshedAt={_coordinator()?.lastRefreshAt() ?? dashboardData.lastRefreshedAt}
              onRefresh={() => _coordinator()?.manualRefresh()}
              sortOptions={globalSortOptions}
              sortValue={viewState.globalSort.field}
              sortDirection={viewState.globalSort.direction}
              onSortChange={(field, dir) => setSortPreference(field, dir)}
              hideOrgRepo={!isBuiltinTab(activeTab())}
            />
          </div>

          <main class="pb-12">
            <Switch>
              <Match when={activeTab() === "issues"}>
                <IssuesTab
                  issues={visibleIssues()}
                  loading={dashboardData.loading}
                  userLogin={userLogin()}
                  allUsers={allUsers()}
                  trackedUsers={config.trackedUsers}
                  monitoredRepos={config.monitoredRepos}
                  configRepoNames={configRepoNames()}
                  refreshTick={refreshTick()}
                />
              </Match>
              <Match when={activeTab() === "pullRequests"}>
                <PullRequestsTab
                  pullRequests={visiblePullRequests()}
                  loading={dashboardData.loading}
                  userLogin={userLogin()}
                  allUsers={allUsers()}
                  trackedUsers={config.trackedUsers}
                  hotPollingPRIds={hotPollingPRIds()}
                  monitoredRepos={config.monitoredRepos}
                  configRepoNames={configRepoNames()}
                  refreshTick={refreshTick()}
                />
              </Match>
              <Match when={activeTab() === "tracked"}>
                {/* TrackedTab intentionally receives unfiltered dashboardData — it bypasses exclusivity */}
                <TrackedTab
                  issues={dashboardData.issues}
                  pullRequests={dashboardData.pullRequests}
                  refreshTick={refreshTick()}
                  userLogin={userLogin()}
                  hotPollingPRIds={hotPollingPRIds()}
                />
              </Match>
              <Match when={activeTab() === "actions"}>
                <ActionsTab
                  workflowRuns={visibleWorkflowRuns()}
                  loading={dashboardData.loading}
                  hasUpstreamRepos={config.upstreamRepos.length > 0}
                  configRepoNames={configRepoNames()}
                  refreshTick={refreshTick()}
                  hotPollingRunIds={hotPollingRunIds()}
                />
              </Match>
              <Match when={activeCustomTab()}>
                {(tab) => {
                  // Apply exclusivity: exclude items owned by OTHER exclusive tabs
                  const data = createMemo(() => {
                    const raw = customTabData()[tab().id];
                    if (!raw) return { issues: [] as typeof dashboardData.issues, pullRequests: [] as typeof dashboardData.pullRequests, workflowRuns: [] as typeof dashboardData.workflowRuns };
                    const ownership = exclusiveOwnership();
                    return {
                      issues: raw.issues.filter((i) => isItemVisibleOnTab(ownership.issues, i.id, tab().id)),
                      pullRequests: raw.pullRequests.filter((p) => isItemVisibleOnTab(ownership.pullRequests, p.id, tab().id)),
                      workflowRuns: raw.workflowRuns.filter((w) => isItemVisibleOnTab(ownership.actions, w.id, tab().id)),
                    };
                  });
                  return (
                    <Switch>
                      <Match when={tab().baseType === "issues"}>
                        <IssuesTab
                          issues={data().issues}
                          loading={dashboardData.loading}
                          userLogin={userLogin()}
                          allUsers={allUsers()}
                          trackedUsers={config.trackedUsers}
                          monitoredRepos={config.monitoredRepos}
                          configRepoNames={configRepoNames()}
                          refreshTick={refreshTick()}
                          customTabId={tab().id}
                          filterPreset={tab().filterPreset}
                        />
                      </Match>
                      <Match when={tab().baseType === "pullRequests"}>
                        <PullRequestsTab
                          pullRequests={data().pullRequests}
                          loading={dashboardData.loading}
                          userLogin={userLogin()}
                          allUsers={allUsers()}
                          trackedUsers={config.trackedUsers}
                          hotPollingPRIds={hotPollingPRIds()}
                          monitoredRepos={config.monitoredRepos}
                          configRepoNames={configRepoNames()}
                          refreshTick={refreshTick()}
                          customTabId={tab().id}
                          filterPreset={tab().filterPreset}
                        />
                      </Match>
                      <Match when={tab().baseType === "actions"}>
                        <ActionsTab
                          workflowRuns={data().workflowRuns}
                          loading={dashboardData.loading}
                          hasUpstreamRepos={config.upstreamRepos.length > 0}
                          configRepoNames={configRepoNames()}
                          refreshTick={refreshTick()}
                          hotPollingRunIds={hotPollingRunIds()}
                          customTabId={tab().id}
                          filterPreset={tab().filterPreset}
                        />
                      </Match>
                    </Switch>
                  );
                }}
              </Match>
            </Switch>
          </main>

          <CustomTabModal
            open={showCustomTabModal()}
            onClose={() => { setShowCustomTabModal(false); setEditingTabId(null); }}
            editingTab={editingTab()}
            availableOrgs={[...new Set(config.selectedRepos.map((r) => r.owner))]}
            availableRepos={config.selectedRepos}
          />
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
                      <span class={`tabular-nums ${rateLimitCssClass(rl().remaining, rl().limit)}`}>
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
