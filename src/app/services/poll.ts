import { createSignal, createEffect, createRoot, untrack, onCleanup } from "solid-js";
import * as Sentry from "@sentry/solid";
import { getClient, fetchRateLimitDetails } from "./github";
import { config } from "../stores/config";
import { user, onAuthCleared } from "../stores/auth";
import { checkAndResetIfExpired } from "./api-usage";
import {
  fetchIssuesAndPullRequests,
  fetchWorkflowRuns,
  fetchHotPRStatus,
  fetchWorkflowRunById,
  pooledAllSettled,
  type Issue,
  type PullRequest,
  type WorkflowRun,
  type ApiError,
  type HotPRStatusUpdate,
  type HotWorkflowRunUpdate,
  resetEmptyActionRepos,
} from "./api";
import { fetchUserEvents, parseRepoEvents, resetEventsState, type RepoEventSummary } from "./events";
import { detectNewItems, dispatchNotifications, _resetNotificationState } from "../lib/notifications";
import { pushError, getNotifications, dismissNotificationBySource, startCycleTracking, endCycleTracking, resetNotificationState } from "../lib/errors";

// ── Types ────────────────────────────────────────────────────────────────────

export interface DashboardData {
  issues: Issue[];
  pullRequests: PullRequest[];
  workflowRuns: WorkflowRun[];
  errors: ApiError[];
}

export interface PollCoordinator {
  isRefreshing: () => boolean;
  lastRefreshAt: () => Date | null;
  manualRefresh: () => void;
  destroy: () => void;
}

// ── Hot poll state ────────────────────────────────────────────────────────────

/** PRs with pending/null check status: maps GraphQL node ID → databaseId */
const _hotPRs = new Map<string, number>();
/** Inverse index for O(1) eviction: maps databaseId → nodeId */
const _hotPRsByDbId = new Map<number, string>();
const MAX_HOT_PRS = 200;

/** In-progress workflow runs: maps run ID → repo descriptor */
const _hotRuns = new Map<number, { owner: string; repo: string }>();
const MAX_HOT_RUNS = 30;
const HOT_RUNS_CONCURRENCY = 10;

/** Incremented each time rebuildHotSets() is called (full refresh completed).
 * Allows hot poll callbacks to detect stale results that overlap with a fresh
 * full refresh — if the captured generation no longer matches the current one,
 * the hot data is discarded. */
let _hotPollGeneration = 0;

export function getHotPollGeneration(): number {
  return _hotPollGeneration;
}

export function clearHotSets(): void {
  _hotPRs.clear();
  _hotPRsByDbId.clear();
  _hotRuns.clear();
}

export function resetPollState(): void {
  _hotPRs.clear();
  _hotPRsByDbId.clear();
  _hotRuns.clear();
  _hotPollGeneration = 0;
  _resetNotificationState();
  resetEmptyActionRepos();
  resetNotificationState();
  resetEventsState();
  _repoLastTargeted.clear();
}

// Auto-reset poll state on logout (avoids circular dep with auth.ts)
onAuthCleared(resetPollState);

// When tracked users or monitored repos change, reset notification state so the
// next poll cycle silently seeds items without flooding "new item" notifications.
// Tracks a serialized key (sorted logins/fullNames) so swapping entries at the
// same array length still triggers the reset. Boolean mount flags ensure the
// initial effect run is always skipped (key="" is a valid state for empty arrays).
// NOTE: Mount flags are intentionally permanent (module lifetime) and NOT cleared
// by resetPollState(). The createRoot runs once at module load; the effects
// continue tracking config changes across auth cycles without re-mounting.
let _trackedUsersMounted = false;
let _trackedUsersKey = "";
let _monitoredReposMounted = false;
let _monitoredReposKey = "";
createRoot(() => {
  createEffect(() => {
    const key = (config.trackedUsers ?? []).map((u) => u.login).sort().join(",");
    if (!_trackedUsersMounted) {
      _trackedUsersMounted = true;
      _trackedUsersKey = key;
      return;
    }
    if (key !== _trackedUsersKey) {
      _trackedUsersKey = key;
      untrack(() => {
        _resetNotificationState();
        resetEventsState();
      });
    }
  });

  createEffect(() => {
    const key = (config.monitoredRepos ?? []).map((r) => r.fullName).sort().join(",");
    if (!_monitoredReposMounted) {
      _monitoredReposMounted = true;
      _monitoredReposKey = key;
      return;
    }
    if (key !== _monitoredReposKey) {
      _monitoredReposKey = key;
      untrack(() => {
        _resetNotificationState();
        resetEventsState();
      });
    }
  });
});

// ── fetchAllData orchestrator ─────────────────────────────────────────────────

/**
 * Fetches all dashboard data. Supports two-phase progressive rendering:
 * - If onLightData is provided, fires with light issues+PRs as soon as
 *   phase 1 completes (before enrichment and workflow runs finish).
 * - The returned promise resolves with fully enriched data.
 */
export async function fetchAllData(
  onLightData?: (data: DashboardData) => void,
): Promise<DashboardData> {
  const octokit = getClient();
  if (!octokit) {
    return { issues: [], pullRequests: [], workflowRuns: [], errors: [] };
  }

  const userLogin = user()?.login ?? "";

  // Combine selectedRepos + upstreamRepos for issues/PRs, dedup by fullName.
  // Upstream repos are excluded from workflow runs (Actions not supported there).
  const selectedRepos = config.selectedRepos;
  const upstreamRepos = config.upstreamRepos ?? [];
  const seenFullNames = new Set<string>(selectedRepos.map((r) => r.fullName));
  const combinedRepos = [...selectedRepos];
  for (const repo of upstreamRepos) {
    if (!seenFullNames.has(repo.fullName)) {
      combinedRepos.push(repo);
    }
  }

  const trackedUsers = config.trackedUsers ?? [];
  const monitoredRepos = config.monitoredRepos ?? [];

  // Issues + PRs use a two-phase approach: light query first (phase 1),
  // then heavy backfill (phase 2). Workflow runs use REST core.
  // All streams run in parallel (GraphQL 5000 pts/hr + REST core 5000/hr).
  // Note: monitoredRepos are NOT added to combinedRepos for workflow runs —
  // Actions fetches are already per selectedRepo.
  const [issuesAndPrsResult, runResult] = await Promise.allSettled([
    fetchIssuesAndPullRequests(octokit, combinedRepos, userLogin, onLightData ? (lightData) => {
      // Phase 1: fire callback with light issues + PRs (no workflow runs yet)
      onLightData({
        issues: lightData.issues,
        pullRequests: lightData.pullRequests,
        workflowRuns: [],
        errors: lightData.errors,
      });
    } : undefined, trackedUsers, monitoredRepos),
    fetchWorkflowRuns(octokit, selectedRepos, config.maxWorkflowsPerRepo, config.maxRunsPerWorkflow),
  ]);

  // Collect top-level errors (total function failures)
  const topLevelErrors: ApiError[] = [];
  const settled: [PromiseSettledResult<unknown>, string][] = [
    [issuesAndPrsResult, "issues-and-prs"],
    [runResult, "workflow-runs"],
  ];
  for (const [result, label] of settled) {
    if (result.status === "rejected") {
      const err = result.reason;
      // Propagate 401 to outer handler for re-auth (don't absorb as generic error)
      if (err?.status === 401 || err?.response?.status === 401) throw err;
      const statusCode = typeof err === "object" && err !== null && typeof (err as Record<string, unknown>).status === "number"
        ? (err as Record<string, unknown>).status as number
        : null;
      const message = err instanceof Error ? err.message : String(err);
      topLevelErrors.push({ repo: label, statusCode, message, retryable: statusCode === null || (statusCode !== null && statusCode >= 500) });
    }
  }

  // Extract data and per-batch errors from successful results
  const issuesAndPrsData = issuesAndPrsResult.status === "fulfilled" ? issuesAndPrsResult.value : null;
  const runData = runResult.status === "fulfilled" ? runResult.value : null;

  // Merge all error sources: top-level failures + per-batch partial failures
  const errors = [
    ...topLevelErrors,
    ...(issuesAndPrsData?.errors ?? []),
    ...(runData?.errors ?? []),
  ];

  return {
    issues: issuesAndPrsData?.issues ?? [],
    pullRequests: issuesAndPrsData?.pullRequests ?? [],
    workflowRuns: runData?.workflowRuns ?? [],
    errors,
  };
}

// ── Poll coordinator ──────────────────────────────────────────────────────────

const REJITTER_WINDOW_MS = 30_000; // ±30 seconds jitter
const REVISIT_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes

// Sources managed by the poll coordinator — used for reconciliation
const POLL_MANAGED_SOURCES = new Set(["poll", "graphql", "rate-limit", "search/issues", "search/prs"]);

function withJitter(intervalMs: number): number {
  const jitter = (Math.random() * 2 - 1) * REJITTER_WINDOW_MS;
  return Math.max(intervalMs + jitter, 1000);
}

/**
 * Creates a poll coordinator that:
 * - Triggers an immediate fetch on init
 * - Polls at getInterval() seconds (reactive — restarts when interval changes)
 * - If getInterval() === 0, disables auto-polling
 * - Skips background polls when hidden (GraphQL POST has no 304 shortcut)
 * - On re-visible after >2 min hidden, fires catch-up fetch (safety net for
 *   browser tab throttling/freezing — Safari purge, Chrome Energy Saver)
 * - Applies ±30 second jitter to poll interval
 *
 * Must be called inside a reactive root (e.g., createRoot or component body).
 */
export function createPollCoordinator(
  getInterval: () => number,
  fetchAll: () => Promise<DashboardData>
): PollCoordinator {
  const [isRefreshing, setIsRefreshing] = createSignal(false);
  const [lastRefreshAt, setLastRefreshAt] = createSignal<Date | null>(null);

  let intervalId: ReturnType<typeof setInterval> | null = null;
  let hiddenAt: number | null = null;
  let destroyed = false;

  async function doFetch(): Promise<void> {
    if (destroyed || isRefreshing()) return;
    checkAndResetIfExpired();
    setIsRefreshing(true);
    // Fire-and-forget: seeds footer signals concurrently with fetchAll. If GET /rate_limit
    // resolves after a GraphQL response, the footer briefly shows pre-query remaining (cosmetic).
    void fetchRateLimitDetails();

    // Snapshot sources of notifications from previous cycle (for reconciliation)
    const previousSources = new Set(
      getNotifications()
        .filter((n) => POLL_MANAGED_SOURCES.has(n.source) || n.source.includes("/"))
        .map((n) => n.source)
    );
    startCycleTracking();

    try {
      const data = await fetchAll();
      setLastRefreshAt(new Date());
      // Surface per-repo API errors globally
      for (const err of data.errors) {
        pushError(err.repo, err.message, err.retryable);
      }
      // Reconcile: dismiss notifications for sources that didn't push this cycle
      const pushedThisCycle = endCycleTracking();
      for (const source of previousSources) {
        if (!pushedThisCycle.has(source)) {
          dismissNotificationBySource(source);
        }
      }
      const newItems = detectNewItems(data);
      dispatchNotifications(newItems, config);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error during data fetch";
      pushError("poll", message, true);
      // No reconciliation on catch — can't know what resolved
    } finally {
      endCycleTracking(); // Safe to call twice (returns empty Set if already ended)
      setIsRefreshing(false);
    }
  }

  function clearTimer(): void {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  function startTimer(intervalSec: number): void {
    clearTimer();
    if (intervalSec === 0 || destroyed) return;

    const intervalMs = withJitter(intervalSec * 1000);
    intervalId = setInterval(() => {
      // Full refresh (GraphQL POST) has no 304 shortcut — skip background tabs
      // to avoid burning API budget. The catch-up handler fires on tab return,
      // and the events poll continues in background tabs (ETag 304 = zero cost).
      if (document.visibilityState === "hidden") return;
      void doFetch();
    }, intervalMs);
  }

  // Safety net for browser-level tab throttling/freezing. Background polls are
  // skipped (no 304 shortcut for GraphQL), but browsers may also freeze hidden
  // tab timers (Chrome Energy Saver, Safari tab purge, Firefox timer capping).
  // When the tab becomes visible again after >2 min, fire a catch-up fetch.
  function handleVisibilityChange(): void {
    if (document.visibilityState === "hidden") {
      hiddenAt = Date.now();
    } else {
      // Became visible
      const wasHiddenFor = hiddenAt !== null ? Date.now() - hiddenAt : 0;
      hiddenAt = null;

      if (wasHiddenFor > REVISIT_THRESHOLD_MS) {
        void doFetch();
        // Reset the interval timer so we don't double-fire shortly after
        const currentInterval = getInterval();
        if (currentInterval > 0) {
          startTimer(currentInterval);
        }
      }
    }
  }

  document.addEventListener("visibilitychange", handleVisibilityChange);

  // Reactive effect: restart timer when getInterval() changes
  createEffect(() => {
    const intervalSec = getInterval();
    startTimer(intervalSec);
  });

  // Immediate fetch on init
  void doFetch();

  function destroy(): void {
    destroyed = true;
    clearTimer();
    document.removeEventListener("visibilitychange", handleVisibilityChange);
  }

  onCleanup(destroy);

  function manualRefresh(): void {
    void doFetch();
    // Reset interval timer so next auto-poll is a full interval from now
    const currentInterval = getInterval();
    if (currentInterval > 0) {
      startTimer(currentInterval);
    }
  }

  return { isRefreshing, lastRefreshAt, manualRefresh, destroy };
}

// ── Hot poll: targeted refresh for in-flight items ───────────────────────────

/**
 * Rebuilds hot item sets from fresh full refresh data. Called after each full
 * poll cycle completes. Clears and replaces both sets (full replacement, not
 * incremental). Increments the generation counter so stale hot poll results
 * from the previous cycle can be detected and discarded.
 */
export function rebuildHotSets(data: DashboardData): void {
  _hotPollGeneration++;
  _hotPRs.clear();
  _hotPRsByDbId.clear();
  _hotRuns.clear();

  for (const pr of data.pullRequests) {
    if (pr.enriched && pr.checkStatus === "pending" && pr.nodeId) {
      if (_hotPRs.size >= MAX_HOT_PRS) {
        console.warn(`[hot-poll] PR cap reached (${MAX_HOT_PRS}), skipping remaining`);
        break;
      }
      _hotPRs.set(pr.nodeId, pr.id);
      _hotPRsByDbId.set(pr.id, pr.nodeId);
    }
  }

  for (const run of data.workflowRuns) {
    if (run.status === "queued" || run.status === "in_progress") {
      if (_hotRuns.size >= MAX_HOT_RUNS) {
        console.warn(`[hot-poll] Run cap reached (${MAX_HOT_RUNS}), skipping remaining`);
        break;
      }
      const parts = run.repoFullName.split("/");
      if (parts.length === 2) {
        _hotRuns.set(run.id, { owner: parts[0], repo: parts[1] });
      }
    }
  }
}

/**
 * Fetches updated status for all hot items (pending-check PRs + in-progress runs).
 * Evicts items from the hot sets when they settle (PR closed/merged/resolved,
 * run completed). Returns captured generation alongside results so callers can
 * detect staleness.
 */
export async function fetchHotData(): Promise<{
  prUpdates: Map<number, HotPRStatusUpdate>;
  runUpdates: Map<number, HotWorkflowRunUpdate>;
  generation: number;
  hadErrors: boolean;
}> {
  // Capture generation BEFORE any async work so callers can detect if a full
  // refresh occurred while this fetch was in flight.
  const generation = _hotPollGeneration;

  const prUpdates = new Map<number, HotPRStatusUpdate>();
  const runUpdates = new Map<number, HotWorkflowRunUpdate>();
  let hadErrors = false;

  const octokit = getClient();
  if (!octokit || (_hotPRs.size === 0 && _hotRuns.size === 0)) {
    return { prUpdates, runUpdates, generation, hadErrors };
  }

  // PR status fetch — wrap in try/catch so failures don't crash the hot poll
  const nodeIds = [..._hotPRs.keys()];
  try {
    const prResult = await fetchHotPRStatus(octokit, nodeIds);
    if (prResult.hadErrors) hadErrors = true;
    for (const [id, update] of prResult.results) {
      prUpdates.set(id, update);
    }
  } catch (err) {
    hadErrors = true;
    console.warn("[hot-poll] PR status fetch failed:", err);
    Sentry.captureException(err, { tags: { source: "hot-poll-pr-fetch" } });
    // Items stay in _hotPRs for retry next cycle
  }

  // Workflow run fetches — bounded concurrency via pooledAllSettled
  const runEntries = [..._hotRuns.entries()];
  const runTasks = runEntries.map(
    ([runId, descriptor]) => async () => fetchWorkflowRunById(octokit, { id: runId, ...descriptor })
  );
  const runResults = await pooledAllSettled(runTasks, HOT_RUNS_CONCURRENCY);
  for (const result of runResults) {
    if (result.status === "fulfilled") {
      runUpdates.set(result.value.id, result.value);
    } else {
      hadErrors = true;
      console.warn("[hot-poll] Workflow run fetch failed:", result.reason);
      Sentry.captureException(result.reason, { tags: { source: "hot-poll-run-fetch" } });
    }
  }

  // Skip eviction if a full refresh rebuilt the hot sets during our async work.
  // The freshly rebuilt sets are authoritative — evicting from them based on
  // stale fetch results would corrupt the new data.
  if (generation === _hotPollGeneration) {
    // Evict settled PRs using inverse index for O(1) lookup
    for (const [databaseId, upd] of prUpdates) {
      if (
        upd.state === "CLOSED" ||
        upd.state === "MERGED" ||
        (upd.checkStatus !== "pending" && upd.checkStatus !== null)
      ) {
        const nodeId = _hotPRsByDbId.get(databaseId);
        if (nodeId) {
          _hotPRs.delete(nodeId);
          _hotPRsByDbId.delete(databaseId);
        }
      }
    }

    // Evict completed runs
    for (const [runId, runUpdate] of runUpdates) {
      if (runUpdate.status === "completed") {
        _hotRuns.delete(runId);
      }
    }
  }

  return { prUpdates, runUpdates, generation, hadErrors };
}

/**
 * Creates a hot poll coordinator that fires at configurable intervals to refresh
 * in-flight items without a full poll cycle. Uses setTimeout chains to avoid
 * overlapping concurrent fetches.
 *
 * - Pauses when document is hidden (visual-only feedback has no value in background tabs)
 * - Resumes on next scheduled cycle when tab becomes visible
 *
 * Must be called inside a SolidJS reactive root (uses createEffect + onCleanup).
 *
 * @param getInterval - Reactive accessor returning interval in seconds
 * @param onHotData - Callback invoked with fresh updates after each cycle
 */
export function createHotPollCoordinator(
  getInterval: () => number,
  onHotData: (
    prUpdates: Map<number, HotPRStatusUpdate>,
    runUpdates: Map<number, HotWorkflowRunUpdate>,
    generation: number
  ) => void,
  options?: {
    onStart?: (prDbIds: ReadonlySet<number>, runIds: ReadonlySet<number>) => void;
    onEnd?: () => void;
  }
): { destroy: () => void } {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let chainGeneration = 0;
  let consecutiveFailures = 0;
  let startedCycle = false; // tracks whether onStart was called for the active chain
  const MAX_BACKOFF_MULTIPLIER = 8; // caps at 8× the base interval

  function destroy(): void {
    // Invalidates any in-flight cycle(); createEffect captures the new value as the next chain's seed
    chainGeneration++;
    consecutiveFailures = 0;
    // Clear shimmer only if an onStart was active (avoids spurious onEnd on init)
    if (startedCycle) {
      startedCycle = false;
      options?.onEnd?.();
    }
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  }

  async function cycle(myGeneration: number): Promise<void> {
    if (myGeneration !== chainGeneration) return; // Stale chain
    checkAndResetIfExpired();

    // No-op cycle when nothing to poll
    if (_hotPRs.size === 0 && _hotRuns.size === 0) {
      schedule(myGeneration);
      return;
    }

    // Skip fetch when page is hidden — hot poll provides visual feedback
    // (shimmer, status changes) that has no value in a background tab.
    // The full poll continues in background for data freshness.
    if (document.visibilityState === "hidden") {
      schedule(myGeneration);
      return;
    }

    // Skip fetch when no authenticated client (e.g., mid-logout)
    // Guarded: getClient() can throw during auth state transitions
    let client: ReturnType<typeof getClient>;
    try {
      client = getClient();
    } catch {
      schedule(myGeneration);
      return;
    }
    if (!client) {
      schedule(myGeneration);
      return;
    }

    startedCycle = true;
    options?.onStart?.(new Set(_hotPRs.values()), new Set(_hotRuns.keys()));
    try {
      const { prUpdates, runUpdates, generation, hadErrors } = await fetchHotData();
      if (myGeneration !== chainGeneration) return; // Chain destroyed during fetch
      if (hadErrors) {
        consecutiveFailures++;
        pushError("hot-poll", "Some status updates failed — retrying with backoff", true);
      } else {
        consecutiveFailures = 0;
        dismissNotificationBySource("hot-poll");
      }
      if (prUpdates.size > 0 || runUpdates.size > 0) {
        onHotData(prUpdates, runUpdates, generation);
      }
    } catch (err) {
      consecutiveFailures++;
      const message = err instanceof Error ? err.message : "Unknown hot-poll error";
      pushError("hot-poll", message, true);
    } finally {
      if (myGeneration === chainGeneration) {
        startedCycle = false;
        options?.onEnd?.();
      }
    }

    schedule(myGeneration);
  }

  function schedule(myGeneration: number): void {
    const baseMs = getInterval() * 1000;
    if (baseMs <= 0 || myGeneration !== chainGeneration) return;
    const backoff = Math.min(2 ** consecutiveFailures, MAX_BACKOFF_MULTIPLIER);
    const ms = baseMs * backoff;
    timeoutId = setTimeout(() => void cycle(myGeneration), ms);
  }

  // Reactive effect: restart chain when interval changes
  createEffect(() => {
    const intervalSec = getInterval();
    destroy();
    if (intervalSec > 0) {
      const gen = chainGeneration;
      timeoutId = setTimeout(() => void cycle(gen), intervalSec * 1000);
    }
  });

  onCleanup(destroy);

  return { destroy };
}

// ── Targeted refresh (events-driven) ─────────────────────────────────────────

const MAX_TARGETED_REPOS = 10;
const TARGETED_COOLDOWN_MS = 2 * 60 * 1000;
const _repoLastTargeted = new Map<string, number>();

export async function fetchTargetedRepoData(
  repoSummaries: Map<string, RepoEventSummary>,
): Promise<DashboardData> {
  const octokit = getClient();
  if (!octokit) {
    return { issues: [], pullRequests: [], workflowRuns: [], errors: [] };
  }

  const userLogin = user()?.login ?? "";

  // Filter repos on cooldown (PERF-004: prevent API amplification)
  const now = Date.now();
  let entries = [...repoSummaries.entries()].filter(([key]) => {
    const lastTargeted = _repoLastTargeted.get(key);
    return !lastTargeted || (now - lastTargeted) >= TARGETED_COOLDOWN_MS;
  });

  // SEC-IMPL-003: cap targeted repos, prioritize by most recent event
  if (entries.length > MAX_TARGETED_REPOS) {
    entries.sort((a, b) => b[1].latestEventAt.localeCompare(a[1].latestEventAt));
    entries = entries.slice(0, MAX_TARGETED_REPOS);
  }

  if (entries.length === 0) {
    return { issues: [], pullRequests: [], workflowRuns: [], errors: [] };
  }

  // Record cooldown timestamps
  for (const [key] of entries) {
    _repoLastTargeted.set(key, now);
  }

  const targetRepos = entries
    .map(([, summary]) => {
      const parts = summary.repoFullName.split("/");
      if (parts.length !== 2) return null;
      return { owner: parts[0], name: parts[1], fullName: summary.repoFullName };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  const workflowRepos = entries
    .filter(([, summary]) => summary.hasWorkflowActivity)
    .map(([, summary]) => {
      const parts = summary.repoFullName.split("/");
      if (parts.length !== 2) return null;
      return { owner: parts[0], name: parts[1], fullName: summary.repoFullName };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  const [issuesAndPrsResult, runResult] = await Promise.allSettled([
    fetchIssuesAndPullRequests(octokit, targetRepos, userLogin),
    workflowRepos.length > 0
      ? fetchWorkflowRuns(octokit, workflowRepos, config.maxWorkflowsPerRepo, config.maxRunsPerWorkflow)
      : Promise.resolve({ workflowRuns: [] as WorkflowRun[], errors: [] as ApiError[] }),
  ]);

  const errors: ApiError[] = [];
  if (issuesAndPrsResult.status === "rejected") {
    const err = issuesAndPrsResult.reason;
    errors.push({ repo: "targeted-issues", statusCode: null, message: err instanceof Error ? err.message : String(err), retryable: true });
  }
  if (runResult.status === "rejected") {
    const err = runResult.reason;
    errors.push({ repo: "targeted-runs", statusCode: null, message: err instanceof Error ? err.message : String(err), retryable: true });
  }

  const issuesAndPrsData = issuesAndPrsResult.status === "fulfilled" ? issuesAndPrsResult.value : null;
  const runData = runResult.status === "fulfilled" ? runResult.value : null;

  return {
    issues: issuesAndPrsData?.issues ?? [],
    pullRequests: issuesAndPrsData?.pullRequests ?? [],
    workflowRuns: runData?.workflowRuns ?? [],
    errors: [...errors, ...(issuesAndPrsData?.errors ?? []), ...(runData?.errors ?? [])],
  };
}

// ── Hot set seeding from targeted refresh ────────────────────────────────────

export function seedHotSetsFromTargeted(data: DashboardData): void {
  for (const pr of data.pullRequests) {
    if (pr.enriched && pr.checkStatus === "pending" && pr.nodeId) {
      if (_hotPRs.size >= MAX_HOT_PRS) break;
      if (!_hotPRs.has(pr.nodeId)) {
        _hotPRs.set(pr.nodeId, pr.id);
        _hotPRsByDbId.set(pr.id, pr.nodeId);
      }
    }
  }

  for (const run of data.workflowRuns) {
    if (run.status === "queued" || run.status === "in_progress") {
      if (_hotRuns.size >= MAX_HOT_RUNS) break;
      if (!_hotRuns.has(run.id)) {
        const parts = run.repoFullName.split("/");
        if (parts.length === 2) {
          _hotRuns.set(run.id, { owner: parts[0], repo: parts[1] });
        }
      }
    }
  }
}

// ── Events poll coordinator ──────────────────────────────────────────────────

const EVENTS_POLL_INTERVAL_MS = 60_000;

export function createEventsPollCoordinator(
  getUsername: () => string,
  trackedRepoNames: () => Set<string>,
  isFullRefreshing: () => boolean,
  onTargetedData: (data: DashboardData, affectedRepos: string[]) => void,
): { destroy: () => void } {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let chainGeneration = 0;
  let consecutiveFailures = 0;
  const MAX_BACKOFF_MULTIPLIER = 8;

  function destroy(): void {
    chainGeneration++;
    consecutiveFailures = 0;
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  }

  function schedule(myGeneration: number, delayMs: number): void {
    if (myGeneration !== chainGeneration) return;
    const backoff = Math.min(2 ** consecutiveFailures, MAX_BACKOFF_MULTIPLIER);
    timeoutId = setTimeout(() => void cycle(myGeneration), delayMs * backoff);
  }

  async function cycle(myGeneration: number): Promise<void> {
    if (myGeneration !== chainGeneration) return;

    const username = getUsername();
    if (!username) {
      schedule(myGeneration, EVENTS_POLL_INTERVAL_MS);
      return;
    }

    const octokit = getClient();
    if (!octokit) {
      schedule(myGeneration, EVENTS_POLL_INTERVAL_MS);
      return;
    }

    if (isFullRefreshing()) {
      schedule(myGeneration, EVENTS_POLL_INTERVAL_MS);
      return;
    }

    try {
      const { events, changed } = await fetchUserEvents(octokit, username);
      if (myGeneration !== chainGeneration) return;

      if (!changed || events.length === 0) {
        consecutiveFailures = 0;
        schedule(myGeneration, EVENTS_POLL_INTERVAL_MS);
        return;
      }

      const repoSummaries = parseRepoEvents(events, trackedRepoNames());
      if (repoSummaries.size === 0) {
        consecutiveFailures = 0;
        schedule(myGeneration, EVENTS_POLL_INTERVAL_MS);
        return;
      }

      if (isFullRefreshing()) {
        schedule(myGeneration, EVENTS_POLL_INTERVAL_MS);
        return;
      }

      const preGeneration = getHotPollGeneration();

      const data = await fetchTargetedRepoData(repoSummaries);
      if (myGeneration !== chainGeneration) return;

      if (preGeneration !== getHotPollGeneration()) {
        schedule(myGeneration, EVENTS_POLL_INTERVAL_MS);
        return;
      }

      const affectedRepos = [...repoSummaries.values()].map((s) => s.repoFullName);
      onTargetedData(data, affectedRepos);
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures++;
      console.warn("[events-poll] cycle error:", err instanceof Error ? err.message : String(err));
    }

    schedule(myGeneration, EVENTS_POLL_INTERVAL_MS);
  }

  // First cycle fires immediately (delay=0) to establish ETag baseline
  const gen = chainGeneration;
  timeoutId = setTimeout(() => void cycle(gen), 0);

  return { destroy };
}
