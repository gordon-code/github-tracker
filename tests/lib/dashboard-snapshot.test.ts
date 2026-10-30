import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { openDB } from "idb";
import { makeIssue, makePullRequest, makeWorkflowRun } from "../helpers";
import type { DashboardSnapshotState } from "../../src/app/lib/dashboard-snapshot";

const idbHoisted = vi.hoisted(() => ({
  realOpenDB: null as unknown as typeof openDB,
}));
vi.mock("idb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("idb")>();
  idbHoisted.realOpenDB = actual.openDB;
  return {
    ...actual,
    openDB: vi.fn((...args: Parameters<typeof actual.openDB>) => actual.openDB(...args)),
  };
});

const mockPushNotification = vi.fn();
vi.mock("../../src/app/lib/errors", () => ({
  pushNotification: (...args: unknown[]) => mockPushNotification(...args),
}));

const DB_NAME = "github-tracker-snapshot";
const STORE_NAME = "snapshot";
const RECORD_KEY = "current";

function makeSampleState(overrides?: Partial<DashboardSnapshotState>): DashboardSnapshotState {
  return {
    issues: [makeIssue({ id: 1, title: "Issue 1" })],
    pullRequests: [makePullRequest({ id: 10, title: "PR 10" })],
    workflowRuns: [makeWorkflowRun({ id: 100, name: "CI" })],
    lastRefreshedAt: new Date("2026-10-30T12:00:00.000Z"),
    ...overrides,
  };
}

describe("dashboard-snapshot", () => {
  beforeEach(async () => {
    vi.useRealTimers();
    mockPushNotification.mockClear();
    vi.mocked(openDB).mockImplementation((...args: Parameters<typeof openDB>) =>
      idbHoisted.realOpenDB(...args),
    );
    const mod = await import("../../src/app/lib/dashboard-snapshot");
    await mod.clearSnapshot();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.mocked(openDB).mockImplementation((...args: Parameters<typeof openDB>) =>
      idbHoisted.realOpenDB(...args),
    );
    const mod = await import("../../src/app/lib/dashboard-snapshot");
    await mod.clearSnapshot();
    vi.restoreAllMocks();
  });

  it("removes legacy localStorage key 'github-tracker:dashboard' on module import", async () => {
    localStorage.setItem("github-tracker:dashboard", '{"legacy":true}');
    vi.resetModules();
    await import("../../src/app/lib/dashboard-snapshot");
    expect(localStorage.getItem("github-tracker:dashboard")).toBeNull();
  });

  it("round-trips a snapshot through writeSnapshot (immediate) and loadSnapshot (case-insensitive login)", async () => {
    const { writeSnapshot, loadSnapshot } = await import("../../src/app/lib/dashboard-snapshot");
    const state = makeSampleState();

    writeSnapshot(state, "Alice", "immediate");
    await new Promise((resolve) => setTimeout(resolve, 25));

    const loaded = await loadSnapshot("alice");
    expect(loaded).not.toBeNull();
    expect(loaded!._v).toBe(1);
    expect(loaded!.login).toBe("Alice");
    expect(loaded!.issues).toEqual(state.issues);
    expect(loaded!.pullRequests).toEqual(state.pullRequests);
    expect(loaded!.workflowRuns).toEqual(state.workflowRuns);
    expect(loaded!.lastRefreshedAt).toEqual(new Date("2026-10-30T12:00:00.000Z"));
  });

  it("returns null on login mismatch", async () => {
    const { writeSnapshot, loadSnapshot } = await import("../../src/app/lib/dashboard-snapshot");
    writeSnapshot(makeSampleState(), "alice", "immediate");
    await new Promise((resolve) => setTimeout(resolve, 25));

    const loaded = await loadSnapshot("bob");
    expect(loaded).toBeNull();
  });

  it("returns null on version or shape mismatch", async () => {
    const { loadSnapshot } = await import("../../src/app/lib/dashboard-snapshot");
    const db = await idbHoisted.realOpenDB(DB_NAME, 1, {
      upgrade(d) {
        if (!d.objectStoreNames.contains(STORE_NAME)) {
          d.createObjectStore(STORE_NAME);
        }
      },
    });

    // Version mismatch
    await db.put(
      STORE_NAME,
      {
        _v: 2,
        login: "alice",
        savedAt: Date.now(),
        issues: [],
        pullRequests: [],
        workflowRuns: [],
        lastRefreshedAt: null,
      },
      RECORD_KEY,
    );
    expect(await loadSnapshot("alice")).toBeNull();

    // Non-array issues
    await db.put(
      STORE_NAME,
      {
        _v: 1,
        login: "alice",
        savedAt: Date.now(),
        issues: "not-an-array",
        pullRequests: [],
        workflowRuns: [],
        lastRefreshedAt: null,
      },
      RECORD_KEY,
    );
    expect(await loadSnapshot("alice")).toBeNull();

    // Invalid lastRefreshedAt type
    await db.put(
      STORE_NAME,
      {
        _v: 1,
        login: "alice",
        savedAt: Date.now(),
        issues: [],
        pullRequests: [],
        workflowRuns: [],
        lastRefreshedAt: 12345,
      },
      RECORD_KEY,
    );
    expect(await loadSnapshot("alice")).toBeNull();

    db.close();
  });

  it("coalesces 5 debounced writes into 1 IDB put", async () => {
    vi.resetModules();
    const idb = await import("idb");
    let putCount = 0;

    vi.mocked(idb.openDB).mockImplementation(async (...args: Parameters<typeof idbHoisted.realOpenDB>) => {
      const db = await idbHoisted.realOpenDB(...args);
      const origPut = db.put.bind(db);
      vi.spyOn(db, "put").mockImplementation((async (...putArgs: Parameters<typeof origPut>) => {
        putCount++;
        return origPut(...putArgs);
      }) as typeof db.put);
      return db;
    });

    const { writeSnapshot, loadSnapshot, DEBOUNCE_MS } = await import(
      "../../src/app/lib/dashboard-snapshot"
    );

    vi.useFakeTimers({ shouldAdvanceTime: true });

    for (let i = 1; i <= 5; i++) {
      writeSnapshot(
        makeSampleState({ issues: [makeIssue({ id: i, title: `Issue ${i}` })] }),
        "alice",
        "debounced",
      );
      await vi.advanceTimersByTimeAsync(1_000);
    }

    // 5 * 1000ms elapsed, last write still needs ~4000ms to fire
    expect(putCount).toBe(0);

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(putCount).toBe(1);

    const snap = await loadSnapshot("alice");
    expect(snap?.issues.map((i) => i.id)).toEqual([5]);
  });

  it("commits an immediate write on the next macrotask without waiting for the 5s debounce", async () => {
    const { writeSnapshot, loadSnapshot } = await import("../../src/app/lib/dashboard-snapshot");
    vi.useFakeTimers({ shouldAdvanceTime: true });

    writeSnapshot(
      makeSampleState({ issues: [makeIssue({ id: 42, title: "Immediate" })] }),
      "alice",
      "immediate",
    );

    // Advance only past setTimeout(0), not 5000ms
    await vi.advanceTimersByTimeAsync(10);
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 25));

    const snap = await loadSnapshot("alice");
    expect(snap).not.toBeNull();
    expect(snap!.issues[0]?.id).toBe(42);
  });

  it("cancels a pending debounced write when clearSnapshot() runs before debounce elapses", async () => {
    const { writeSnapshot, clearSnapshot, loadSnapshot, DEBOUNCE_MS } = await import(
      "../../src/app/lib/dashboard-snapshot"
    );
    vi.useFakeTimers({ shouldAdvanceTime: true });

    writeSnapshot(makeSampleState(), "alice", "debounced");
    const clearPromise = clearSnapshot();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1_000);
    vi.useRealTimers();
    await clearPromise;
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(await loadSnapshot("alice")).toBeNull();
  });

  it("drops an in-flight flush awaiting getDb() when clearSnapshot() runs concurrently", async () => {
    vi.resetModules();
    const idb = await import("idb");

    let resolveOpenDb!: () => void;
    const openGate = new Promise<void>((resolve) => {
      resolveOpenDb = resolve;
    });
    let putCalls = 0;

    vi.mocked(idb.openDB).mockImplementation(async (...args: Parameters<typeof idbHoisted.realOpenDB>) => {
      await openGate;
      const db = await idbHoisted.realOpenDB(...args);
      const origPut = db.put.bind(db);
      vi.spyOn(db, "put").mockImplementation((async (...putArgs: Parameters<typeof origPut>) => {
        putCalls++;
        return origPut(...putArgs);
      }) as typeof db.put);
      return db;
    });

    const { writeSnapshot, flushSnapshot, clearSnapshot, loadSnapshot } = await import(
      "../../src/app/lib/dashboard-snapshot"
    );

    writeSnapshot(makeSampleState(), "alice", "debounced");
    const flushPromise = flushSnapshot();

    // While flushSnapshot is suspended awaiting getDb(), clearSnapshot runs synchronously
    const clearPromise = clearSnapshot();

    // Release getDb()
    resolveOpenDb();
    await Promise.all([flushPromise, clearPromise]);

    expect(putCalls).toBe(0);
    expect(await loadSnapshot("alice")).toBeNull();
  });

  it("skips writing and logs console.warn once when total items exceed MAX_SNAPSHOT_ITEMS (5000)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { writeSnapshot, loadSnapshot, MAX_SNAPSHOT_ITEMS } = await import(
      "../../src/app/lib/dashboard-snapshot"
    );

    const oversizedIssues = Array.from({ length: MAX_SNAPSHOT_ITEMS + 1 }, (_, i) =>
      makeIssue({ id: i + 1 }),
    );

    writeSnapshot(makeSampleState({ issues: oversizedIssues }), "alice", "immediate");
    writeSnapshot(makeSampleState({ issues: oversizedIssues }), "alice", "immediate");
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("exceeds 5000 items"));
    expect(await loadSnapshot("alice")).toBeNull();
  });

  it("pushes a single warning notification and does not throw on IDB quota error", async () => {
    vi.resetModules();
    const idb = await import("idb");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    vi.mocked(idb.openDB).mockImplementation(async (...args: Parameters<typeof idbHoisted.realOpenDB>) => {
      const db = await idbHoisted.realOpenDB(...args);
      vi.spyOn(db, "put").mockRejectedValue(
        new DOMException("QuotaExceededError", "QuotaExceededError"),
      );
      return db;
    });

    const { writeSnapshot, flushSnapshot } = await import("../../src/app/lib/dashboard-snapshot");
    writeSnapshot(makeSampleState(), "alice", "immediate");

    await expect(flushSnapshot()).resolves.toBeUndefined();
    expect(mockPushNotification).toHaveBeenCalledTimes(1);
    expect(mockPushNotification).toHaveBeenCalledWith(
      "snapshot:write",
      expect.stringContaining("storage may be full"),
      "warning",
    );
  });
});
