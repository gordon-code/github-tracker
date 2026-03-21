import { createSignal, createEffect, onCleanup } from "solid-js";
import { getClient } from "./github";
import { config } from "../stores/config";
import { user, onAuthCleared } from "../stores/auth";
import {
  fetchIssues,
  fetchPullRequests,
  fetchWorkflowRuns,
  aggregateErrors,
  type Issue,
  type PullRequest,
  type WorkflowRun,
  type ApiError,
} from "./api";
import { detectNewItems, dispatchNotifications } from "../lib/notifications";
import { pushError, clearErrors } from "../lib/errors";

// ── Types ────────────────────────────────────────────────────────────────────

export interface DashboardData {
  issues: Issue[];
  pullRequests: PullRequest[];
  workflowRuns: WorkflowRun[];
  errors: ApiError[];
  /** True when notifications gate determined nothing changed — consumer should keep existing data */
  skipped?: boolean;
}

export interface PollCoordinator {
  isRefreshing: () => boolean;
  lastRefreshAt: () => Date | null;
  manualRefresh: () => void;
}

// ── Notifications gate ───────────────────────────────────────────────────────

let _notifLastModified: string | null = null;
let _notifGateDisabled = false; // Disabled after 403 (missing notifications permission)

function resetPollState(): void {
  _notifLastModified = null;
  _lastSuccessfulFetch = null;
  _notifGateDisabled = false;
}

// Auto-reset poll state on logout (avoids circular dep with auth.ts)
onAuthCleared(resetPollState);

/**
 * Checks if anything changed since last poll using the Notifications API.
 * Returns true if there are new notifications (or first check), false if unchanged.
 * Uses If-Modified-Since for zero-cost 304 checks (doesn't count against rate limit).
 *
 * Auto-disables after a 403 (missing notifications permission) to stop wasting
 * rate limit tokens on requests that will always fail.
 */
async function hasNotificationChanges(): Promise<boolean> {
  if (_notifGateDisabled) return true;

  const octokit = getClient();
  if (!octokit) return true;

  try {
    const headers: Record<string, string> = {};
    if (_notifLastModified) {
      headers["If-Modified-Since"] = _notifLastModified;
    }

    const response = await octokit.request("GET /notifications", {
      per_page: 1,
      headers,
    });

    // Store Last-Modified for next conditional request
    const lastMod = (response.headers as Record<string, string>)["last-modified"];
    if (lastMod) {
      _notifLastModified = lastMod;
    }

    return true; // 200 = something changed
  } catch (err) {
    if (
      typeof err === "object" &&
      err !== null &&
      (err as { status?: number }).status === 304
    ) {
      return false; // Nothing changed since last check
    }
    // 403 = missing notifications permission — disable gate permanently
    // to stop burning rate limit tokens on every poll cycle
    if (
      typeof err === "object" &&
      err !== null &&
      (err as { status?: number }).status === 403
    ) {
      console.warn("[poll] Notifications API returned 403 — disabling gate");
      _notifGateDisabled = true;
    }
    return true;
  }
}

// ── Incremental fetch timestamps ─────────────────────────────────────────────

let _lastSuccessfulFetch: Date | null = null;

// Force a full fetch if the notifications gate has been skipping for too long.
// Notifications don't cover all change types (e.g., workflow runs on unwatched
// repos, label changes without notification), so we cap staleness.
const MAX_GATE_STALENESS_MS = 10 * 60 * 1000; // 10 minutes

// ── fetchAllData orchestrator ─────────────────────────────────────────────────

export async function fetchAllData(): Promise<DashboardData> {
  const octokit = getClient();
  if (!octokit) {
    return { issues: [], pullRequests: [], workflowRuns: [], errors: [] };
  }

  // On subsequent polls, check notifications first (free when 304)
  if (_lastSuccessfulFetch) {
    const staleness = Date.now() - _lastSuccessfulFetch.getTime();
    if (staleness < MAX_GATE_STALENESS_MS) {
      const changed = await hasNotificationChanges();
      if (!changed) {
        console.info("[poll] No notification changes — skipping full fetch");
        return { issues: [], pullRequests: [], workflowRuns: [], errors: [], skipped: true };
      }
    }
    // If staleness >= MAX_GATE_STALENESS_MS, skip the gate and force a full fetch
  }

  const repos = config.selectedRepos;
  const userLogin = user()?.login ?? "";

  // Note: NOT using updated:>= or created:>= filters on any endpoint because
  // the dashboard uses full-replacement — each poll replaces all data. Date filters
  // would cause unchanged items to vanish from the display. ETag caching already
  // handles the "nothing changed" case for workflow runs (304 = free).

  const [issueResult, prResult, runResult] = await Promise.allSettled([
    fetchIssues(octokit, repos, userLogin),
    fetchPullRequests(octokit, repos, userLogin),
    fetchWorkflowRuns(
      octokit,
      repos,
      config.maxWorkflowsPerRepo,
      config.maxRunsPerWorkflow
    ),
  ]);

  // Collect top-level errors (total function failures)
  const topLevelErrors = aggregateErrors([
    [issueResult, "issues"],
    [prResult, "pull-requests"],
    [runResult, "workflow-runs"],
  ]);

  // Extract data and per-batch errors from successful results
  const issueData = issueResult.status === "fulfilled" ? issueResult.value : null;
  const prData = prResult.status === "fulfilled" ? prResult.value : null;
  const runData = runResult.status === "fulfilled" ? runResult.value : null;

  // Merge all error sources: top-level failures + per-batch partial failures
  const errors = [
    ...topLevelErrors,
    ...(issueData?.errors ?? []),
    ...(prData?.errors ?? []),
    ...(runData?.errors ?? []),
  ];

  // Only activate the notifications gate if at least one fetch succeeded.
  // If all three failed (e.g., network outage), we don't want the gate to
  // suppress retries on the next poll cycle.
  const anySucceeded = issueData !== null || prData !== null || runData !== null;
  if (anySucceeded) {
    _lastSuccessfulFetch = new Date();
  }

  return {
    issues: issueData?.issues ?? [],
    pullRequests: prData?.pullRequests ?? [],
    workflowRuns: runData?.workflowRuns ?? [],
    errors,
  };
}

// ── Poll coordinator ──────────────────────────────────────────────────────────

const REJITTER_WINDOW_MS = 30_000; // ±30 seconds jitter
const REVISIT_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes

function withJitter(intervalMs: number): number {
  const jitter = (Math.random() * 2 - 1) * REJITTER_WINDOW_MS;
  return Math.max(intervalMs + jitter, 1000);
}

/**
 * Creates a poll coordinator that:
 * - Triggers an immediate fetch on init
 * - Polls at getInterval() seconds (reactive — restarts when interval changes)
 * - If getInterval() === 0, disables auto-polling (SDR-017)
 * - Pauses when document is hidden; resumes on visibility restore
 * - Refreshes immediately on re-visible if hidden for >2 min
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
    setIsRefreshing(true);
    try {
      const data = await fetchAll();
      // When notifications gate determined nothing changed, skip all processing
      if (data.skipped) return;
      setLastRefreshAt(new Date());
      // Surface per-repo API errors globally
      clearErrors();
      for (const err of data.errors) {
        pushError(err.repo, err.message, err.retryable);
      }
      const newItems = detectNewItems(data);
      dispatchNotifications(newItems, config);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error during data fetch";
      pushError("poll", message, true);
    } finally {
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
      if (document.visibilityState === "hidden") return;
      void doFetch();
    }, intervalMs);
  }

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

  onCleanup(() => {
    destroyed = true;
    clearTimer();
    document.removeEventListener("visibilitychange", handleVisibilityChange);
  });

  function manualRefresh(): void {
    void doFetch();
    // Reset interval timer so next auto-poll is a full interval from now
    const currentInterval = getInterval();
    if (currentInterval > 0) {
      startTimer(currentInterval);
    }
  }

  return { isRefreshing, lastRefreshAt, manualRefresh };
}
