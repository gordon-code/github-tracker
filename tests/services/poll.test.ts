import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, createSignal } from "solid-js";
import {
  createPollCoordinator,
  processBackfillErrors,
  resetPollState,
  WAKE_GRACE_MS,
  ONLINE_RECOVERY_GRACE_MS,
  type DashboardData,
} from "../../src/app/services/poll";
import { PR_ENRICHMENT_NOTIFICATION_SOURCE, PR_ENRICHMENT_DEGRADED_MESSAGE } from "../../src/shared/types";
import * as githubMod from "../../src/app/services/github";
import * as githubStatusMod from "../../src/app/services/github-status";
import { makePullRequest } from "../helpers/factories";

// Mock pushError and pushNotification so we can spy on them
const mockPushError = vi.fn();
const mockPushNotification = vi.fn();
const mockDismissNotificationBySource = vi.fn();
const mockStartCycleTracking = vi.fn();
const mockEndCycleTracking = vi.fn(() => new Set<string>());
const mockGetNotifications = vi.fn(() => [] as import("../../src/app/lib/errors").AppNotification[]);
vi.mock("../../src/app/lib/errors", () => ({
  pushError: (...args: unknown[]) => mockPushError(...args),
  clearErrors: vi.fn(),
  getErrors: vi.fn(() => []),
  getNotifications: () => mockGetNotifications(),
  dismissNotificationBySource: (source: string) => mockDismissNotificationBySource(source),
  startCycleTracking: () => mockStartCycleTracking(),
  endCycleTracking: () => mockEndCycleTracking(),
  pushNotification: (...args: unknown[]) => mockPushNotification(...args),
  clearNotifications: vi.fn(),
  resetNotificationState: vi.fn(),
  addMutedSource: vi.fn(),
  isMuted: vi.fn(() => false),
  clearMutedSources: vi.fn(),
}));

// Mock notifications so doFetch doesn't fail on detectNewItems
vi.mock("../../src/app/lib/notifications", () => ({
  detectNewItems: vi.fn(() => []),
  dispatchNotifications: vi.fn(),
  _resetNotificationState: vi.fn(),
}));

// Mock github module — fetchRateLimitDetails runs concurrently (fire-and-forget) in doFetch
vi.mock("../../src/app/services/github", () => ({
  getClient: vi.fn(() => null),
  fetchRateLimitDetails: vi.fn(() => Promise.resolve(null)),
  onApiRequest: vi.fn(),
  initClientWatcher: vi.fn(),
}));

// Mock github-status module — fetchGitHubStatus runs concurrently (fire-and-forget)
// in doFetch, same pattern as fetchRateLimitDetails above.
vi.mock("../../src/app/services/github-status", () => ({
  fetchGitHubStatus: vi.fn(() => Promise.resolve()),
}));

// Mock config so doFetch doesn't fail when accessing config.selectedRepos
vi.mock("../../src/app/stores/config", () => ({
  config: {
    selectedRepos: [],
    maxWorkflowsPerRepo: 5,
    maxRunsPerWorkflow: 3,
  },
}));

async function flushPromises(): Promise<void> {
  // doFetch() awaits fetchAll and fires fetchRateLimitDetails concurrently;
  // 10 iterations ensures all chained microtasks settle regardless of depth.
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const emptyData: DashboardData = {
  issues: [],
  pullRequests: [],
  workflowRuns: [],
  errors: [],
};

function makeFetchAll(impl?: () => Promise<DashboardData>) {
  return vi.fn(impl ?? (() => Promise.resolve(emptyData)));
}

function makeGetInterval(sec: number) {
  return () => sec;
}

// Simulate document visibility change
function setDocumentVisible(visible: boolean) {
  Object.defineProperty(document, "visibilityState", {
    value: visible ? "visible" : "hidden",
    writable: true,
    configurable: true,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("createPollCoordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetPollState();
    // Start with document visible and browser online
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      writable: true,
      configurable: true,
    });
    Object.defineProperty(navigator, "onLine", {
      value: true,
      writable: true,
      configurable: true,
    });
    // Reset mock functions
    mockPushError.mockClear();
    mockPushNotification.mockClear();
    mockDismissNotificationBySource.mockClear();
    mockStartCycleTracking.mockClear();
    mockEndCycleTracking.mockClear().mockReturnValue(new Set<string>());
    mockGetNotifications.mockClear().mockReturnValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("triggers an immediate fetch on init", async () => {
    const fetchAll = makeFetchAll();

    await createRoot(async (dispose) => {
      createPollCoordinator(makeGetInterval(60), fetchAll);
      // Flush microtasks
      await Promise.resolve();
      dispose();
    });

    expect(fetchAll).toHaveBeenCalledTimes(1);
  });

  it("fires at the configured interval", async () => {
    const fetchAll = makeFetchAll();

    await createRoot(async (dispose) => {
      createPollCoordinator(makeGetInterval(60), fetchAll);
      await flushPromises(); // initial fetch

      // Advance 1 full interval (with jitter ±30s, 60s is within [30s, 90s])
      // Use 90s to be safe and hit the interval regardless of jitter
      vi.advanceTimersByTime(90_000);
      await flushPromises();

      expect(fetchAll.mock.calls.length).toBeGreaterThanOrEqual(2);
      dispose();
    });
  });

  it("pauses polling when document is hidden (no 304 shortcut for GraphQL)", async () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5); // jitter = 0
    const fetchAll = makeFetchAll();

    await createRoot(async (dispose) => {
      createPollCoordinator(makeGetInterval(60), fetchAll);
      await flushPromises(); // initial fetch

      const callsAfterInit = fetchAll.mock.calls.length;

      // Hide document
      setDocumentVisible(false);

      // Advance past the interval (60s with 0 jitter)
      vi.advanceTimersByTime(61_000);
      await flushPromises();

      // Should NOT have fetched — background polls skipped (no 304 shortcut)
      expect(fetchAll.mock.calls.length).toBe(callsAfterInit);
      dispose();
    });

    randomSpy.mockRestore();
  });

  it("triggers immediate refresh on re-visible after >2 minutes hidden", async () => {
    const fetchAll = makeFetchAll();

    await createRoot(async (dispose) => {
      createPollCoordinator(makeGetInterval(300), fetchAll);
      await flushPromises(); // initial fetch

      const callsAfterInit = fetchAll.mock.calls.length;

      // Hide the document
      setDocumentVisible(false);

      // Advance time past 2 minutes while hidden
      vi.advanceTimersByTime(130_000); // 2 min 10 sec

      // Restore visibility — catch-up waits WAKE_GRACE_MS (2_000ms)
      setDocumentVisible(true);
      await flushPromises();
      expect(fetchAll.mock.calls.length).toBe(callsAfterInit);

      vi.advanceTimersByTime(WAKE_GRACE_MS);
      await flushPromises();

      // Should have triggered a catch-up fetch after WAKE_GRACE_MS
      expect(fetchAll.mock.calls.length).toBeGreaterThanOrEqual(callsAfterInit + 1);
      dispose();
    });
  });

  it("does NOT trigger immediate refresh on re-visible within 2 minutes", async () => {
    // Pin jitter to 0 so 300s interval is exactly 300s (no background poll in 90s)
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);
    const fetchAll = makeFetchAll();

    await createRoot(async (dispose) => {
      createPollCoordinator(makeGetInterval(300), fetchAll);
      await Promise.resolve(); // initial fetch

      const callsAfterInit = fetchAll.mock.calls.length;

      // Hide for under 2 minutes
      setDocumentVisible(false);
      vi.advanceTimersByTime(90_000); // 1.5 min

      // Restore visibility
      setDocumentVisible(true);
      await Promise.resolve();

      // Should NOT have triggered an extra fetch
      expect(fetchAll.mock.calls.length).toBe(callsAfterInit);
      dispose();
    });

    randomSpy.mockRestore();
  });

  it("resets timer on re-visible after >2 min, fires catch-up then waits full interval", async () => {
    // Pin jitter to 0 so 60s interval is exactly 60s
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);
    const fetchAll = makeFetchAll();

    await createRoot(async (dispose) => {
      createPollCoordinator(makeGetInterval(60), fetchAll);
      await flushPromises(); // initial fetch

      const callsAfterInit = fetchAll.mock.calls.length;

      // Hide for >2 min — background polls are SKIPPED (no 304 shortcut)
      setDocumentVisible(false);
      vi.advanceTimersByTime(130_000);
      await flushPromises();

      // No polls while hidden
      expect(fetchAll.mock.calls.length).toBe(callsAfterInit);

      // Restore visibility — timer resets immediately, catch-up fires after WAKE_GRACE_MS
      setDocumentVisible(true);
      await flushPromises();
      expect(fetchAll.mock.calls.length).toBe(callsAfterInit);

      vi.advanceTimersByTime(WAKE_GRACE_MS);
      await flushPromises();

      const callsAfterRevisible = fetchAll.mock.calls.length;
      expect(callsAfterRevisible).toBeGreaterThan(callsAfterInit);

      // Advance 30s — should NOT fire (timer was reset to full 60s interval)
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
      expect(fetchAll.mock.calls.length).toBe(callsAfterRevisible);

      // Advance another 31s (past 60s from reset) — timer fires
      vi.advanceTimersByTime(31_000);
      await flushPromises();
      expect(fetchAll.mock.calls.length).toBeGreaterThan(callsAfterRevisible);

      dispose();
    });

    randomSpy.mockRestore();
  });

  it("manual refresh triggers fetch and resets the timer", async () => {
    const fetchAll = makeFetchAll();

    await createRoot(async (dispose) => {
      const coordinator = createPollCoordinator(makeGetInterval(60), fetchAll);
      await flushPromises(); // initial fetch

      const callsAfterInit = fetchAll.mock.calls.length;

      coordinator.manualRefresh();
      await flushPromises();

      expect(fetchAll.mock.calls.length).toBe(callsAfterInit + 1);
      dispose();
    });
  });

  it("config change (interval change) restarts the interval", async () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5); // jitter = 0
    const fetchAll = makeFetchAll();

    await createRoot(async (dispose) => {
      const [interval, setInterval] = createSignal(300);

      createPollCoordinator(interval, fetchAll);
      await Promise.resolve(); // initial fetch

      const callsAfterInit = fetchAll.mock.calls.length;

      // At 300s interval, 90s should NOT fire
      vi.advanceTimersByTime(90_000);
      await Promise.resolve();
      expect(fetchAll.mock.calls.length).toBe(callsAfterInit);

      // Change interval to 60s — createEffect re-fires, timer restarts
      setInterval(60);
      await Promise.resolve(); // let effect run

      // Advance 61s — new 60s interval should fire
      vi.advanceTimersByTime(61_000);
      await Promise.resolve();
      expect(fetchAll.mock.calls.length).toBeGreaterThan(callsAfterInit);

      dispose();
    });

    randomSpy.mockRestore();
  });

  it("interval=0 disables auto-refresh (no setInterval)", async () => {
    const fetchAll = makeFetchAll();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

    await createRoot(async (dispose) => {
      createPollCoordinator(makeGetInterval(0), fetchAll);
      await Promise.resolve(); // initial fetch

      // Advance a long time
      vi.advanceTimersByTime(600_000);
      await Promise.resolve();

      // setInterval should NOT have been called (interval=0 means no auto-poll)
      expect(setIntervalSpy).not.toHaveBeenCalled();

      // But initial fetch still happened
      expect(fetchAll).toHaveBeenCalledTimes(1);

      dispose();
    });

    setIntervalSpy.mockRestore();
  });

  it("exposes isRefreshing signal that is true during fetch", async () => {
    let resolvePromise!: () => void;
    const fetchAll = vi.fn(
      () =>
        new Promise<DashboardData>((resolve) => {
          resolvePromise = () => resolve(emptyData);
        })
    );

    await createRoot(async (dispose) => {
      const coordinator = createPollCoordinator(makeGetInterval(0), fetchAll);

      // During the in-flight fetch, isRefreshing should be true
      expect(coordinator.isRefreshing()).toBe(true);

      await Promise.resolve(); // flush microtasks so fetchAll is called
      resolvePromise();
      await Promise.resolve();
      await Promise.resolve(); // allow finally block to run

      expect(coordinator.isRefreshing()).toBe(false);
      dispose();
    });
  });

  it("exposes lastRefreshAt signal updated after each fetch", async () => {
    const fetchAll = makeFetchAll();

    await createRoot(async (dispose) => {
      const before = Date.now();
      const coordinator = createPollCoordinator(makeGetInterval(0), fetchAll);
      await Promise.resolve();
      await Promise.resolve();

      const after = Date.now();
      const refreshAt = coordinator.lastRefreshAt();
      expect(refreshAt).not.toBeNull();
      expect(refreshAt!.getTime()).toBeGreaterThanOrEqual(before);
      expect(refreshAt!.getTime()).toBeLessThanOrEqual(after + 10);
      dispose();
    });
  });

  // ── qa-3: fetchAll rejection pushes error and clears isRefreshing ────────────

  it("pushes error to pushError and clears isRefreshing when fetchAll rejects", async () => {
    mockPushError.mockClear();
    const fetchAll = vi.fn().mockRejectedValue(new Error("fetch blew up"));

    await createRoot(async (dispose) => {
      const coordinator = createPollCoordinator(makeGetInterval(0), fetchAll);

      // isRefreshing should be true immediately (fetch in flight)
      expect(coordinator.isRefreshing()).toBe(true);

      // Let the rejection propagate through the catch block
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(coordinator.isRefreshing()).toBe(false);
      expect(mockPushError).toHaveBeenCalledWith(
        "poll",
        "fetch blew up",
        true
      );
      dispose();
    });
  });

  // ── qa-4: Concurrent doFetch guard — second call while first is in-flight ───

  it("concurrent doFetch guard: second manualRefresh while first is in-flight queues a force retry", async () => {
    const resolvers: Array<() => void> = [];
    const fetchAll = vi.fn(
      () =>
        new Promise<DashboardData>((resolve) => {
          resolvers.push(() => resolve(emptyData));
        })
    );

    await createRoot(async (dispose) => {
      const coordinator = createPollCoordinator(makeGetInterval(0), fetchAll);

      // First fetch is in-flight (unresolved)
      expect(coordinator.isRefreshing()).toBe(true);
      await Promise.resolve(); // flush microtasks so fetchAll is called
      expect(fetchAll).toHaveBeenCalledTimes(1);

      // Trigger a second fetch while the first is still in-flight
      coordinator.manualRefresh();
      await Promise.resolve();

      // Guard should prevent a second concurrent invocation — pendingForce queued instead
      expect(fetchAll).toHaveBeenCalledTimes(1);

      // Resolve the first fetch — the finally block fires the queued force retry
      resolvers[0]();
      await flushPromises();

      // The force retry should now be in-flight (fetchAll called twice)
      expect(fetchAll).toHaveBeenCalledTimes(2);
      expect(coordinator.isRefreshing()).toBe(true);

      // Resolve the second (forced) fetch
      resolvers[1]();
      await flushPromises();

      expect(coordinator.isRefreshing()).toBe(false);
      dispose();
    });
  });

  // ── qa-3b: reconciliation — resolved error is dismissed ───────────────────────

  it("dismisses resolved errors: source in previous cycle but not pushed in current cycle", async () => {
    mockPushError.mockClear();
    mockDismissNotificationBySource.mockClear();

    // Simulate "graphql" was present in previous cycle
    mockGetNotifications.mockReturnValue([
      { id: "n1", source: "graphql", message: "Rate limited", timestamp: Date.now(), retryable: true, severity: "error" as const, read: false },
    ]);
    // endCycleTracking returns only "poll" — "graphql" was NOT pushed this cycle
    mockEndCycleTracking.mockReturnValue(new Set(["poll"]));

    const fetchAll = vi.fn().mockResolvedValue(emptyData);

    await createRoot(async (dispose) => {
      createPollCoordinator(makeGetInterval(0), fetchAll);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(mockDismissNotificationBySource).toHaveBeenCalledWith("graphql");
      dispose();
    });

    mockGetNotifications.mockReturnValue([]);
    mockEndCycleTracking.mockReturnValue(new Set());
  });

  // ── qa-3c: reconciliation — persistent error not dismissed ────────────────────

  it("does not dismiss persistent errors pushed in both cycles", async () => {
    mockDismissNotificationBySource.mockClear();

    // "graphql" in previous cycle
    mockGetNotifications.mockReturnValue([
      { id: "n1", source: "graphql", message: "Rate limited", timestamp: Date.now(), retryable: true, severity: "error" as const, read: false },
    ]);
    // endCycleTracking includes "graphql" — it was pushed this cycle too
    mockEndCycleTracking.mockReturnValue(new Set(["graphql"]));

    const fetchAll = vi.fn().mockResolvedValue(emptyData);

    await createRoot(async (dispose) => {
      createPollCoordinator(makeGetInterval(0), fetchAll);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(mockDismissNotificationBySource).not.toHaveBeenCalledWith("graphql");
      dispose();
    });

    mockGetNotifications.mockReturnValue([]);
    mockEndCycleTracking.mockReturnValue(new Set());
  });


  // ── qa-11: Jitter test with fixed Math.random to make interval deterministic ──

  it("fires at the configured interval with deterministic jitter (Math.random = 0)", async () => {
    // Math.random() = 0 → jitter = (0 * 2 - 1) * 30_000 = -30_000
    // withJitter(60_000) = max(60_000 + (-30_000), 1000) = 30_000ms
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    const fetchAll = makeFetchAll();

    await createRoot(async (dispose) => {
      createPollCoordinator(makeGetInterval(60), fetchAll);
      await flushPromises(); // initial fetch

      const callsAfterInit = fetchAll.mock.calls.length;

      // Advance exactly past the deterministic 30s interval
      vi.advanceTimersByTime(30_001);
      await flushPromises();

      expect(fetchAll.mock.calls.length).toBe(callsAfterInit + 1);
      dispose();
    });

    randomSpy.mockRestore();
  });

  it("destroy() stops future fetches and removes visibility listener", async () => {
    const fetchAll = makeFetchAll();

    await createRoot(async (dispose) => {
      const coordinator = createPollCoordinator(makeGetInterval(60), fetchAll);
      await Promise.resolve(); // initial fetch

      const callsAfterInit = fetchAll.mock.calls.length;

      coordinator.destroy();

      // Advance past the interval — no fetch should fire
      vi.advanceTimersByTime(90_000);
      await Promise.resolve();
      expect(fetchAll.mock.calls.length).toBe(callsAfterInit);

      // Visibility change should not trigger a fetch either
      setDocumentVisible(false);
      vi.advanceTimersByTime(130_000);
      setDocumentVisible(true);
      await Promise.resolve();
      expect(fetchAll.mock.calls.length).toBe(callsAfterInit);

      // Manual refresh should also be blocked (doFetch checks destroyed flag)
      coordinator.manualRefresh();
      await Promise.resolve();
      expect(fetchAll.mock.calls.length).toBe(callsAfterInit);

      dispose();
    });
  });

  it("destroy() clears pendingForce: queued retry does not fire after destroy", async () => {
    const resolvers: Array<() => void> = [];
    const fetchAll = vi.fn(
      () =>
        new Promise<DashboardData>((resolve) => {
          resolvers.push(() => resolve(emptyData));
        })
    );

    await createRoot(async (dispose) => {
      const coordinator = createPollCoordinator(makeGetInterval(0), fetchAll);

      await Promise.resolve();
      expect(fetchAll).toHaveBeenCalledTimes(1);

      coordinator.manualRefresh();
      await Promise.resolve();

      expect(fetchAll).toHaveBeenCalledTimes(1);

      coordinator.destroy();

      resolvers[0]();
      await flushPromises();

      expect(fetchAll).toHaveBeenCalledTimes(1);

      dispose();
    });
  });

  it("fetchRateLimitDetails is called exactly once per doFetch cycle", async () => {
    const fetchRateLimitDetailsSpy = vi.mocked(githubMod.fetchRateLimitDetails);
    fetchRateLimitDetailsSpy.mockClear();

    const fetchAll = makeFetchAll();

    await createRoot(async (dispose) => {
      createPollCoordinator(makeGetInterval(0), fetchAll);
      await flushPromises();

      expect(fetchRateLimitDetailsSpy).toHaveBeenCalledTimes(1);
      dispose();
    });
  });

  it("fetchGitHubStatus is called once on initial mount", async () => {
    const fetchGitHubStatusSpy = vi.mocked(githubStatusMod.fetchGitHubStatus);
    fetchGitHubStatusSpy.mockClear();

    const fetchAll = makeFetchAll();

    await createRoot(async (dispose) => {
      createPollCoordinator(makeGetInterval(0), fetchAll);
      await flushPromises();

      expect(fetchGitHubStatusSpy).toHaveBeenCalledTimes(1);
      dispose();
    });
  });

  it("manualRefresh() triggers another fetchGitHubStatus call", async () => {
    const fetchGitHubStatusSpy = vi.mocked(githubStatusMod.fetchGitHubStatus);
    fetchGitHubStatusSpy.mockClear();

    const fetchAll = makeFetchAll();

    await createRoot(async (dispose) => {
      const coordinator = createPollCoordinator(makeGetInterval(0), fetchAll);
      await flushPromises();
      expect(fetchGitHubStatusSpy).toHaveBeenCalledTimes(1);

      coordinator.manualRefresh();
      await flushPromises();

      expect(fetchGitHubStatusSpy).toHaveBeenCalledTimes(2);
      dispose();
    });
  });

  it("threads force = false on automatic polls and force = true on manualRefresh()", async () => {
    const fetchAll = makeFetchAll();

    await createRoot(async (dispose) => {
      const coordinator = createPollCoordinator(makeGetInterval(0), fetchAll);
      await flushPromises();

      expect(fetchAll).toHaveBeenCalledTimes(1);
      expect(fetchAll).toHaveBeenLastCalledWith(false);

      coordinator.manualRefresh();
      await flushPromises();

      expect(fetchAll).toHaveBeenCalledTimes(2);
      expect(fetchAll).toHaveBeenLastCalledWith(true);
      dispose();
    });
  });

  it("cancels pending wake grace timer on re-hide (preserving hiddenAt), manualRefresh(), and destroy()", async () => {
    const fetchAll = makeFetchAll();

    await createRoot(async (dispose) => {
      const coordinator = createPollCoordinator(makeGetInterval(0), fetchAll);
      await flushPromises();
      expect(fetchAll).toHaveBeenCalledTimes(1);

      // Hide > 2m, become visible, then re-hide within WAKE_GRACE_MS
      setDocumentVisible(false);
      vi.advanceTimersByTime(130_000);
      setDocumentVisible(true);
      vi.advanceTimersByTime(500);
      setDocumentVisible(false);

      // Advancing past WAKE_GRACE_MS while hidden does not fire catch-up
      vi.advanceTimersByTime(WAKE_GRACE_MS + 1_000);
      await flushPromises();
      expect(fetchAll).toHaveBeenCalledTimes(1);

      // Becoming visible again still remembers the >2m hiddenAt obligation
      setDocumentVisible(true);
      vi.advanceTimersByTime(WAKE_GRACE_MS);
      await flushPromises();
      expect(fetchAll).toHaveBeenCalledTimes(2);

      // manualRefresh() during wake grace window cancels pending wake timer
      setDocumentVisible(false);
      vi.advanceTimersByTime(130_000);
      setDocumentVisible(true);
      vi.advanceTimersByTime(500);
      coordinator.manualRefresh();
      await flushPromises();
      expect(fetchAll).toHaveBeenCalledTimes(3);
      expect(fetchAll).toHaveBeenLastCalledWith(true);

      // Elapsing the remainder of WAKE_GRACE_MS must NOT fire a duplicate fetch
      vi.advanceTimersByTime(WAKE_GRACE_MS + 500);
      await flushPromises();
      expect(fetchAll).toHaveBeenCalledTimes(3);

      // destroy() during wake grace window cancels pending wake timer
      setDocumentVisible(false);
      vi.advanceTimersByTime(130_000);
      setDocumentVisible(true);
      vi.advanceTimersByTime(500);
      coordinator.destroy();
      vi.advanceTimersByTime(WAKE_GRACE_MS + 500);
      await flushPromises();
      expect(fetchAll).toHaveBeenCalledTimes(3);

      dispose();
    });
  });

  it("skips automatic polls and wake catch-up while navigator.onLine === false and recovers after ONLINE_RECOVERY_GRACE_MS on 'online' event", async () => {
    const fetchAll = makeFetchAll();

    await createRoot(async (dispose) => {
      const coordinator = createPollCoordinator(makeGetInterval(60), fetchAll);
      await flushPromises();
      expect(fetchAll).toHaveBeenCalledTimes(1);

      // Go offline
      Object.defineProperty(navigator, "onLine", {
        value: false,
        writable: true,
        configurable: true,
      });

      // Interval tick while offline is skipped
      vi.advanceTimersByTime(95_000);
      await flushPromises();
      expect(fetchAll).toHaveBeenCalledTimes(1);

      // Wake catch-up while offline is also skipped
      setDocumentVisible(false);
      vi.advanceTimersByTime(130_000);
      setDocumentVisible(true);
      vi.advanceTimersByTime(WAKE_GRACE_MS);
      await flushPromises();
      expect(fetchAll).toHaveBeenCalledTimes(1);

      // Restore online state and fire window 'online' event
      Object.defineProperty(navigator, "onLine", {
        value: true,
        writable: true,
        configurable: true,
      });
      window.dispatchEvent(new Event("online"));

      // Does not fire before ONLINE_RECOVERY_GRACE_MS (1_500ms)
      vi.advanceTimersByTime(ONLINE_RECOVERY_GRACE_MS - 100);
      await flushPromises();
      expect(fetchAll).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(100);
      await flushPromises();
      expect(fetchAll).toHaveBeenCalledTimes(2);

      // Manual refresh (force = true) still runs even if navigator.onLine is false
      Object.defineProperty(navigator, "onLine", {
        value: false,
        writable: true,
        configurable: true,
      });
      coordinator.manualRefresh();
      await flushPromises();
      expect(fetchAll).toHaveBeenCalledTimes(3);

      dispose();
    });
  });

  it("implements 3-Tier backfill-batch-* escalation, retains Tier 1 across search failures only while PRs are degraded, and auto-dismisses on clean poll", async () => {
    const enrichedPR = makePullRequest({ id: 1, enriched: true, checkStatus: "success" });
    const unenrichedPR = makePullRequest({ id: 2, enriched: false, checkStatus: null });
    const backfillErr = {
      repo: "backfill-batch-1/1",
      statusCode: null,
      message: "Failed to fetch",
      retryable: true,
    };

    let nextResult: DashboardData = {
      issues: [],
      pullRequests: [enrichedPR],
      workflowRuns: [],
      errors: [backfillErr],
    };
    const fetchAll = vi.fn(async () => nextResult);

    await createRoot(async (dispose) => {
      // Poll 1 (failure #1 with all PRs enriched via cache/fallback): Tier 0 silent
      const coordinator = createPollCoordinator(makeGetInterval(0), fetchAll);
      await flushPromises();

      expect(mockPushError).not.toHaveBeenCalled();
      expect(mockPushNotification).not.toHaveBeenCalled();

      // Poll 2 (failure #2 with all PRs enriched): Tier 0 silent
      coordinator.manualRefresh();
      await flushPromises();
      expect(mockPushError).not.toHaveBeenCalled();
      expect(mockPushNotification).not.toHaveBeenCalled();

      // Poll 3 (failure #3 consecutive): escalates to Tier 1 silentToast warning
      coordinator.manualRefresh();
      await flushPromises();
      expect(mockPushError).not.toHaveBeenCalled();
      expect(mockPushNotification).toHaveBeenCalledWith(
        PR_ENRICHMENT_NOTIFICATION_SOURCE,
        PR_ENRICHMENT_DEGRADED_MESSAGE,
        "warning",
        true,
        undefined,
        { silentToast: true }
      );

      // Poll 4: light-search total failure (pullRequests: [], errors: [light-batch-1/1])
      // Surfaces 'light-batch-1/1' via pushError; with no degraded PRs on screen the
      // 'pr-enrichment' warning is not re-pushed (cycle tracking then dismisses it)
      mockPushNotification.mockClear();
      mockPushError.mockClear();
      mockGetNotifications.mockReturnValue([
        {
          id: "n-pr",
          source: PR_ENRICHMENT_NOTIFICATION_SOURCE,
          message: PR_ENRICHMENT_DEGRADED_MESSAGE,
          timestamp: Date.now(),
          retryable: true,
          severity: "warning",
          read: false,
          silentToast: true,
        },
      ]);
      mockEndCycleTracking.mockReturnValue(
        new Set(["light-batch-1/1", PR_ENRICHMENT_NOTIFICATION_SOURCE])
      );
      nextResult = {
        issues: [],
        pullRequests: [],
        workflowRuns: [],
        errors: [{ repo: "light-batch-1/1", statusCode: 500, message: "Server Error", retryable: true }],
      };
      coordinator.manualRefresh();
      await flushPromises();
      expect(mockPushError).toHaveBeenCalledWith("light-batch-1/1", "Server Error", true);
      expect(mockPushNotification).not.toHaveBeenCalled();

      // Partial light-search failure with only enriched PRs: warning not re-pushed either
      mockPushError.mockClear();
      nextResult = {
        issues: [],
        pullRequests: [enrichedPR],
        workflowRuns: [],
        errors: [{ repo: "light-batch-2/2", statusCode: 502, message: "Bad Gateway", retryable: true }],
      };
      coordinator.manualRefresh();
      await flushPromises();
      expect(mockPushError).toHaveBeenCalledWith("light-batch-2/2", "Bad Gateway", true);
      expect(mockPushNotification).not.toHaveBeenCalled();

      // Partial light-search failure that leaves a degraded PR: retains Tier 1 'pr-enrichment'
      mockPushNotification.mockClear();
      mockPushError.mockClear();
      nextResult = {
        issues: [],
        pullRequests: [enrichedPR, unenrichedPR],
        workflowRuns: [],
        errors: [{ repo: "light-batch-2/2", statusCode: 502, message: "Bad Gateway", retryable: true }],
      };
      coordinator.manualRefresh();
      await flushPromises();
      expect(mockPushError).toHaveBeenCalledWith("light-batch-2/2", "Bad Gateway", true);
      expect(mockPushNotification).toHaveBeenCalledWith(
        PR_ENRICHMENT_NOTIFICATION_SOURCE,
        PR_ENRICHMENT_DEGRADED_MESSAGE,
        "warning",
        true,
        undefined,
        { silentToast: true }
      );
      expect(mockDismissNotificationBySource).not.toHaveBeenCalledWith(
        PR_ENRICHMENT_NOTIFICATION_SOURCE
      );

      // Poll 5: clean poll with enriched PRs resets streak and auto-dismisses 'pr-enrichment'
      mockPushNotification.mockClear();
      mockPushError.mockClear();
      mockEndCycleTracking.mockReturnValue(new Set());
      nextResult = {
        issues: [],
        pullRequests: [enrichedPR],
        workflowRuns: [],
        errors: [],
      };
      coordinator.manualRefresh();
      await flushPromises();
      expect(mockPushNotification).not.toHaveBeenCalled();
      expect(mockDismissNotificationBySource).toHaveBeenCalledWith(
        PR_ENRICHMENT_NOTIFICATION_SOURCE
      );

      // Poll 6: cold-start failure #1 with an unenriched PR (enriched: false) escalates immediately to Tier 1
      mockGetNotifications.mockReturnValue([]);
      mockDismissNotificationBySource.mockClear();
      nextResult = {
        issues: [],
        pullRequests: [unenrichedPR],
        workflowRuns: [],
        errors: [backfillErr],
      };
      coordinator.manualRefresh();
      await flushPromises();
      expect(mockPushError).not.toHaveBeenCalled();
      expect(mockPushNotification).toHaveBeenCalledWith(
        PR_ENRICHMENT_NOTIFICATION_SOURCE,
        PR_ENRICHMENT_DEGRADED_MESSAGE,
        "warning",
        true,
        undefined,
        { silentToast: true }
      );

      // Poll 7: reset streak, then verify failure #1 with checkStatusStale: true also escalates immediately to Tier 1
      resetPollState();
      mockPushNotification.mockClear();
      const stalePR = makePullRequest({
        id: 3,
        repoFullName: "owner/repo",
        enriched: true,
        checkStatus: null,
        checkStatusStale: true,
      });
      nextResult = {
        issues: [],
        pullRequests: [stalePR],
        workflowRuns: [],
        errors: [backfillErr],
      };
      coordinator.manualRefresh();
      await flushPromises();
      expect(mockPushNotification).toHaveBeenCalledWith(
        PR_ENRICHMENT_NOTIFICATION_SOURCE,
        PR_ENRICHMENT_DEGRADED_MESSAGE,
        "warning",
        true,
        undefined,
        { silentToast: true }
      );

      // Poll 8: reset streak, then verify failure #1 with a non-retryable backfill error escalates immediately to Tier 1
      resetPollState();
      mockPushNotification.mockClear();
      nextResult = {
        issues: [],
        pullRequests: [enrichedPR],
        workflowRuns: [],
        errors: [{ ...backfillErr, statusCode: 403, retryable: false }],
      };
      coordinator.manualRefresh();
      await flushPromises();
      expect(mockPushNotification).toHaveBeenCalledWith(
        PR_ENRICHMENT_NOTIFICATION_SOURCE,
        PR_ENRICHMENT_DEGRADED_MESSAGE,
        "warning",
        true,
        undefined,
        { silentToast: true }
      );

      dispose();
    });
  });

  it("defers online recovery fetch when tab is hidden and catches up after WAKE_GRACE_MS on tab focus", async () => {
    await createRoot(async (dispose) => {
      const fetchAll = vi.fn().mockResolvedValue({
        issues: [],
        pullRequests: [],
        workflowRuns: [],
        errors: [],
      });
      const coordinator = createPollCoordinator(() => 300, fetchAll);
      await flushPromises();
      expect(fetchAll).toHaveBeenCalledTimes(1);

      // Go offline and trigger an interval tick while offline so the 'online' listener registers
      Object.defineProperty(navigator, "onLine", {
        value: false,
        writable: true,
        configurable: true,
      });
      vi.advanceTimersByTime(360_000);
      await flushPromises();
      expect(fetchAll).toHaveBeenCalledTimes(1);

      // Hide tab (< 2m) before online recovery fires
      setDocumentVisible(false);
      Object.defineProperty(navigator, "onLine", {
        value: true,
        writable: true,
        configurable: true,
      });
      window.dispatchEvent(new Event("online"));
      vi.advanceTimersByTime(ONLINE_RECOVERY_GRACE_MS);
      await flushPromises();
      // Should NOT fetch while hidden, but should backdate hiddenAt
      expect(fetchAll).toHaveBeenCalledTimes(1);

      // Become visible 5 seconds later (< 2m since last hide, but backdated by online recovery)
      vi.advanceTimersByTime(5_000);
      setDocumentVisible(true);
      vi.advanceTimersByTime(WAKE_GRACE_MS);
      await flushPromises();
      expect(fetchAll).toHaveBeenCalledTimes(2);

      // Go offline again, fire 'online', then flap back to offline before ONLINE_RECOVERY_GRACE_MS elapses
      Object.defineProperty(navigator, "onLine", {
        value: false,
        writable: true,
        configurable: true,
      });
      vi.advanceTimersByTime(360_000);
      await flushPromises();
      expect(fetchAll).toHaveBeenCalledTimes(2);

      window.dispatchEvent(new Event("online"));
      vi.advanceTimersByTime(ONLINE_RECOVERY_GRACE_MS);
      await flushPromises();
      // Still offline -> did not fetch, but re-registered 'online' listener
      expect(fetchAll).toHaveBeenCalledTimes(2);

      // Now genuinely come back online -> second 'online' event triggers recovery fetch
      Object.defineProperty(navigator, "onLine", {
        value: true,
        writable: true,
        configurable: true,
      });
      window.dispatchEvent(new Event("online"));
      vi.advanceTimersByTime(ONLINE_RECOVERY_GRACE_MS);
      await flushPromises();
      expect(fetchAll).toHaveBeenCalledTimes(3);

      coordinator.destroy();
      dispose();
    });
  });
});

describe("processBackfillErrors", () => {
  const backfillErr = { repo: "backfill-batch-1/1", statusCode: null, message: "Failed to fetch", retryable: true };
  const enrichedPR = makePullRequest({ id: 1, enriched: true, checkStatus: "success" });
  const degradedArgs = [
    PR_ENRICHMENT_NOTIFICATION_SOURCE,
    PR_ENRICHMENT_DEGRADED_MESSAGE,
    "warning",
    true,
    undefined,
    { silentToast: true },
  ] as const;

  beforeEach(() => {
    resetPollState();
    mockPushNotification.mockClear();
    mockGetNotifications.mockClear().mockReturnValue([]);
  });

  it("resets the consecutive-failure streak on a clean poll", () => {
    processBackfillErrors([backfillErr], [enrichedPR]);
    processBackfillErrors([backfillErr], [enrichedPR]);
    expect(processBackfillErrors([], [enrichedPR])).toEqual([]);
    // Without the reset this would be failure #3 and escalate.
    processBackfillErrors([backfillErr], [enrichedPR]);
    expect(mockPushNotification).not.toHaveBeenCalled();
  });

  it("keeps the streak on an unfiltered-batch search error and re-pushes an active warning only while a PR is degraded", () => {
    const stalePR = makePullRequest({ id: 2, enriched: true, checkStatus: null, checkStatusStale: true });
    processBackfillErrors([backfillErr], [enrichedPR]);
    processBackfillErrors([backfillErr], [enrichedPR]);
    expect(mockPushNotification).not.toHaveBeenCalled();

    mockGetNotifications.mockReturnValue([
      {
        id: "n-pr",
        source: PR_ENRICHMENT_NOTIFICATION_SOURCE,
        message: PR_ENRICHMENT_DEGRADED_MESSAGE,
        timestamp: Date.now(),
        retryable: true,
        severity: "warning",
        read: false,
        silentToast: true,
      },
    ]);
    const unfilteredErr = { repo: "unfiltered-batch-1/1", statusCode: 502, message: "Bad Gateway", retryable: true };
    // Every PR fully enriched: the active warning is not kept alive by the search error
    expect(processBackfillErrors([unfilteredErr], [enrichedPR])).toEqual([unfilteredErr]);
    expect(mockPushNotification).not.toHaveBeenCalled();
    // A degraded PR on screen: the active warning is re-pushed
    processBackfillErrors([unfilteredErr], [enrichedPR, stalePR]);
    expect(mockPushNotification).toHaveBeenCalledWith(...degradedArgs);

    // Streak was kept at 2, so the next backfill failure is #3 and escalates.
    mockPushNotification.mockClear();
    mockGetNotifications.mockReturnValue([]);
    processBackfillErrors([backfillErr], [enrichedPR]);
    expect(mockPushNotification).toHaveBeenCalledWith(...degradedArgs);
  });
});
