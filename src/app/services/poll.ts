import { createSignal, createEffect, onCleanup } from "solid-js";
import { getClient } from "./github";
import { config } from "../stores/config";
import { user } from "../stores/auth";
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
}

// ── fetchAllData orchestrator ─────────────────────────────────────────────────

export async function fetchAllData(): Promise<DashboardData> {
  const octokit = getClient();
  if (!octokit) {
    return { issues: [], pullRequests: [], workflowRuns: [], errors: [] };
  }

  const repos = config.selectedRepos;
  const userLogin = user()?.login ?? "";

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

  const errors = aggregateErrors([
    [issueResult, "issues"],
    [prResult, "pull-requests"],
    [runResult, "workflow-runs"],
  ]);

  return {
    issues: issueResult.status === "fulfilled" ? issueResult.value : [],
    pullRequests: prResult.status === "fulfilled" ? prResult.value : [],
    workflowRuns: runResult.status === "fulfilled" ? runResult.value : [],
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
    if (destroyed) return;
    setIsRefreshing(true);
    try {
      const data = await fetchAll();
      setLastRefreshAt(new Date());
      const newItems = detectNewItems(data);
      dispatchNotifications(newItems, config);
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
