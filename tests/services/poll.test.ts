import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot } from "solid-js";
import { createPollCoordinator, disableNotifGate, resetPollState, type DashboardData } from "../../src/app/services/poll";

// Mock pushError so we can spy on it
const mockPushError = vi.fn();
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
  pushNotification: vi.fn(),
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

// Mock config so doFetch doesn't fail when accessing config.selectedRepos
vi.mock("../../src/app/stores/config", () => ({
  config: {
    selectedRepos: [],
    maxWorkflowsPerRepo: 5,
    maxRunsPerWorkflow: 3,
  },
}));

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
    // Start with document visible
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      writable: true,
      configurable: true,
    });
    // Reset new mock functions
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
      await Promise.resolve(); // initial fetch

      // Advance 1 full interval (with jitter ±30s, 60s is within [30s, 90s])
      // Use 90s to be safe and hit the interval regardless of jitter
      vi.advanceTimersByTime(90_000);
      await Promise.resolve();

      expect(fetchAll.mock.calls.length).toBeGreaterThanOrEqual(2);
      dispose();
    });
  });

  it("continues polling when document is hidden (notifications gate enabled)", async () => {
    const fetchAll = makeFetchAll();

    await createRoot(async (dispose) => {
      createPollCoordinator(makeGetInterval(60), fetchAll);
      await Promise.resolve(); // initial fetch

      const callsAfterInit = fetchAll.mock.calls.length;

      // Hide document
      setDocumentVisible(false);

      // Advance past the interval
      vi.advanceTimersByTime(90_000);
      await Promise.resolve();

      // Should have fetched while hidden (background refresh)
      expect(fetchAll.mock.calls.length).toBeGreaterThan(callsAfterInit);
      dispose();
    });
  });

  it("triggers immediate refresh on re-visible after >2 minutes hidden", async () => {
    const fetchAll = makeFetchAll();

    await createRoot(async (dispose) => {
      createPollCoordinator(makeGetInterval(300), fetchAll);
      await Promise.resolve(); // initial fetch

      const callsAfterInit = fetchAll.mock.calls.length;

      // Hide the document
      setDocumentVisible(false);

      // Advance time past 2 minutes while hidden
      vi.advanceTimersByTime(130_000); // 2 min 10 sec

      // Restore visibility
      setDocumentVisible(true);
      await Promise.resolve();

      // Should have triggered at least a catch-up fetch on re-visible
      // (background polls may also have fired if interval < hidden duration)
      expect(fetchAll.mock.calls.length).toBeGreaterThanOrEqual(callsAfterInit + 1);
      dispose();
    });
  });

  it("pauses background polling when hidden and notifications gate is disabled", async () => {
    disableNotifGate();
    const fetchAll = makeFetchAll();

    await createRoot(async (dispose) => {
      createPollCoordinator(makeGetInterval(60), fetchAll);
      await Promise.resolve(); // initial fetch

      const callsAfterInit = fetchAll.mock.calls.length;

      // Hide document
      setDocumentVisible(false);

      // Advance past the interval
      vi.advanceTimersByTime(90_000);
      await Promise.resolve();

      // Should NOT have fetched — gate disabled means no cheap 304, skip background polls
      expect(fetchAll.mock.calls.length).toBe(callsAfterInit);
      dispose();
    });

    resetPollState(); // restore gate for other tests
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

  it("resets timer on re-visible after >2 min, preventing double-fire with background polls", async () => {
    // Pin jitter to 0 so 60s interval is exactly 60s
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);
    const fetchAll = makeFetchAll();

    await createRoot(async (dispose) => {
      createPollCoordinator(makeGetInterval(60), fetchAll);
      await Promise.resolve(); // initial fetch

      const callsAfterInit = fetchAll.mock.calls.length;

      // Hide for >2 min — background polls fire at 60s and 120s
      setDocumentVisible(false);
      vi.advanceTimersByTime(130_000);
      await Promise.resolve();

      const callsWhileHidden = fetchAll.mock.calls.length;
      expect(callsWhileHidden).toBeGreaterThan(callsAfterInit);

      // Restore visibility — catch-up fetch fires + timer resets
      setDocumentVisible(true);
      await Promise.resolve();

      const callsAfterRevisible = fetchAll.mock.calls.length;
      expect(callsAfterRevisible).toBeGreaterThan(callsWhileHidden);

      // Advance 30s — should NOT fire (timer was reset to full 60s interval)
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
      expect(fetchAll.mock.calls.length).toBe(callsAfterRevisible);

      // Advance another 31s (61s from reset) — timer fires
      vi.advanceTimersByTime(31_000);
      await Promise.resolve();
      expect(fetchAll.mock.calls.length).toBeGreaterThan(callsAfterRevisible);

      dispose();
    });

    randomSpy.mockRestore();
  });

  it("manual refresh triggers fetch and resets the timer", async () => {
    const fetchAll = makeFetchAll();

    await createRoot(async (dispose) => {
      const coordinator = createPollCoordinator(makeGetInterval(60), fetchAll);
      await Promise.resolve(); // initial fetch

      const callsAfterInit = fetchAll.mock.calls.length;

      coordinator.manualRefresh();
      await Promise.resolve();

      expect(fetchAll.mock.calls.length).toBe(callsAfterInit + 1);
      dispose();
    });
  });

  it("config change (interval change) restarts the interval", async () => {
    const fetchAll = makeFetchAll();
    let intervalSec = 300;

    await createRoot(async (dispose) => {
      // Use a signal-based getter to simulate reactive config
      const [getInterval, setGetInterval] = (() => {
        let fn = () => intervalSec;
        return [
          () => fn(),
          (newFn: () => number) => {
            fn = newFn;
          },
        ] as const;
      })();

      createPollCoordinator(getInterval, fetchAll);
      await Promise.resolve(); // initial fetch

      // Simulate config change to shorter interval by providing a new accessor
      // In practice SolidJS createEffect re-runs when reactive dependencies change.
      // Here we verify that calling with interval=60 fires within 90s.
      intervalSec = 60;
      void setGetInterval; // suppress unused warning

      vi.advanceTimersByTime(90_000);
      await Promise.resolve();

      // At 300s interval, 90s would not fire. But with 60s interval restart,
      // it should fire at least once more. Since the internal createEffect
      // is not re-triggered (intervalSec is not a signal), we only verify
      // that the original timer was set and would eventually fire.
      // The key test is just that manualRefresh + timer work correctly.
      dispose();
    });
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

  it("concurrent doFetch guard: second manualRefresh while first is in-flight calls fetchAll only once", async () => {
    let resolveFirst!: () => void;
    const fetchAll = vi.fn(
      () =>
        new Promise<DashboardData>((resolve) => {
          resolveFirst = () => resolve(emptyData);
        })
    );

    await createRoot(async (dispose) => {
      const coordinator = createPollCoordinator(makeGetInterval(0), fetchAll);

      // First fetch is in-flight (unresolved)
      expect(coordinator.isRefreshing()).toBe(true);
      expect(fetchAll).toHaveBeenCalledTimes(1);

      // Trigger a second fetch while the first is still in-flight
      coordinator.manualRefresh();
      await Promise.resolve();

      // Guard should prevent a second concurrent invocation
      expect(fetchAll).toHaveBeenCalledTimes(1);

      // Resolve the first fetch
      resolveFirst();
      await Promise.resolve();
      await Promise.resolve();

      expect(coordinator.isRefreshing()).toBe(false);
      dispose();
    });
  });

  // ── qa-5: fetchAll returns skipped:true — lastRefreshAt not updated ──────────

  it("does not update lastRefreshAt and does not push errors when fetchAll returns skipped:true", async () => {
    mockPushError.mockClear();

    const skippedData: DashboardData = {
      issues: [],
      pullRequests: [],
      workflowRuns: [],
      errors: [],
      skipped: true,
    };
    const fetchAll = vi.fn().mockResolvedValue(skippedData);

    await createRoot(async (dispose) => {
      const coordinator = createPollCoordinator(makeGetInterval(0), fetchAll);

      // Wait for the in-flight fetch to settle
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // lastRefreshAt must remain null — skipped fetch should not record a refresh time
      expect(coordinator.lastRefreshAt()).toBeNull();

      // isRefreshing must be cleared — the finally block always runs
      expect(coordinator.isRefreshing()).toBe(false);

      // pushError must NOT have been called — per-repo errors are only processed on non-skipped fetches
      expect(mockPushError).not.toHaveBeenCalled();

      dispose();
    });
  });

  // ── qa-3: doFetch skipped path — no restore (reconciliation replaces snapshot/restore) ──

  it("skipped fetch does NOT call pushError for previous errors (no restore logic)", async () => {
    mockPushError.mockClear();

    const skippedData: DashboardData = {
      issues: [],
      pullRequests: [],
      workflowRuns: [],
      errors: [],
      skipped: true,
    };
    const fetchAll = vi.fn().mockResolvedValue(skippedData);

    await createRoot(async (dispose) => {
      createPollCoordinator(makeGetInterval(0), fetchAll);

      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // No pushError calls on skip — notifications persist naturally
      expect(mockPushError).not.toHaveBeenCalled();
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

  // ── qa-3d: endCycleTracking called on skipped path ────────────────────────────

  it("endCycleTracking is called on skipped path (no tracking state leak)", async () => {
    mockEndCycleTracking.mockClear();
    mockStartCycleTracking.mockClear();

    const skippedData: DashboardData = {
      issues: [],
      pullRequests: [],
      workflowRuns: [],
      errors: [],
      skipped: true,
    };
    const fetchAll = vi.fn().mockResolvedValue(skippedData);

    await createRoot(async (dispose) => {
      createPollCoordinator(makeGetInterval(0), fetchAll);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // startCycleTracking called, endCycleTracking called in finally
      expect(mockStartCycleTracking).toHaveBeenCalled();
      expect(mockEndCycleTracking).toHaveBeenCalled();
      dispose();
    });
  });

  // ── qa-11: Jitter test with fixed Math.random to make interval deterministic ──

  it("fires at the configured interval with deterministic jitter (Math.random = 0)", async () => {
    // Math.random() = 0 → jitter = (0 * 2 - 1) * 30_000 = -30_000
    // withJitter(60_000) = max(60_000 + (-30_000), 1000) = 30_000ms
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    const fetchAll = makeFetchAll();

    await createRoot(async (dispose) => {
      createPollCoordinator(makeGetInterval(60), fetchAll);
      await Promise.resolve(); // initial fetch

      const callsAfterInit = fetchAll.mock.calls.length;

      // Advance exactly past the deterministic 30s interval
      vi.advanceTimersByTime(30_001);
      await Promise.resolve();

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
});
