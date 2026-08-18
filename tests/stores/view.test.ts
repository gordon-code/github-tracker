import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRoot } from "solid-js";
import {
  viewState,
  updateViewState,
  resetViewState,
  ignoreItem,
  unignoreItem,
  pruneStaleIgnoredItems,
  setSortPreference,
  setGlobalFilter,
  setTabFilter,
  resetAllTabFilters,
  initViewPersistence,
  ViewStateSchema,
  DependencyFiltersSchema,
  toggleExpandedRepo,
  setAllExpanded,
  pruneExpandedRepos,
  trackItem,
  untrackItem,
  moveTrackedItem,
  pruneClosedTrackedItems,
  setCustomTabFilter,
  resetCustomTabFilters,
  removeCustomTabState,
  lockRepo,
  untrackJiraItem,
  moveJiraItem,
  setJiraCustomOrder,
} from "../../src/app/stores/view";
import type { IgnoredItem, TrackedItem, ViewState } from "../../src/app/stores/view";
import { getNotifications, clearNotifications } from "../../src/app/lib/errors";

// view.ts uses createStore — setters work outside reactive context.
// We use createRoot only for initViewPersistence (which calls createEffect).
// State is shared at module level, so we reset in beforeEach.

const VIEW_KEY = "github-tracker:view";

// Provide a predictable localStorage mock (same pattern as config.test.ts)
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
  };
})();

Object.defineProperty(globalThis, "localStorage", {
  value: localStorageMock,
  writable: true,
  configurable: true,
});

function resetForTest() {
  resetViewState();
}

beforeEach(() => {
  resetForTest();
  localStorageMock.clear();
});

describe("updateViewState", () => {
  it("merges partial state — updates lastActiveTab", () => {
    updateViewState({ lastActiveTab: "pullRequests" });
    expect(viewState.lastActiveTab).toBe("pullRequests");
  });

  it("preserves unrelated fields when merging partial state", () => {
    updateViewState({ lastActiveTab: "actions" });
    expect(viewState.globalFilter).toEqual({ org: null, repo: null });
    expect(viewState.ignoredItems).toEqual([]);
  });

  it("is a safe no-op when called with an empty object", () => {
    updateViewState({ lastActiveTab: "pullRequests" });
    updateViewState({});
    expect(viewState.lastActiveTab).toBe("pullRequests");
  });

  // Real call sites (DashboardPage, SettingsPage, config.ts, IssuesTab) only ever pass
  // these two field/type shapes — verify both validate and apply correctly.
  it("applies a real call-site shape: { lastActiveTab: string }", () => {
    updateViewState({ lastActiveTab: "jiraAssigned" });
    expect(viewState.lastActiveTab).toBe("jiraAssigned");
  });

  it("applies a real call-site shape: { hideDepDashboard: boolean }", () => {
    expect(viewState.hideDepDashboard).toBe(true);
    updateViewState({ hideDepDashboard: false });
    expect(viewState.hideDepDashboard).toBe(false);
    updateViewState({ hideDepDashboard: true });
    expect(viewState.hideDepDashboard).toBe(true);
  });

  // Structural guard: updating ANY single field must never wipe other fields.
  // Catches Zod v4 .partial().safeParse() default inflation (BUG-001 class, mirrors config.test.ts).
  it.each([
    ["lastActiveTab", { lastActiveTab: "actions" }],
    ["showPrRuns", { showPrRuns: true }],
    ["hideDepDashboard", { hideDepDashboard: false }],
    ["dependencyExpandedGroups", { dependencyExpandedGroups: ["patch"] }],
  ] satisfies [string, Partial<ViewState>][])("updating only %s preserves other non-default fields", (_fieldName, patch) => {
    // Seed an unrelated field with a non-default value first.
    updateViewState({ lastActiveTab: "pullRequests" });
    expect(viewState.lastActiveTab).toBe("pullRequests");

    // Now update a (possibly different) single field.
    updateViewState(patch);

    // The previously-seeded field must still hold its non-default value
    // unless this iteration's patch targeted it directly.
    if (!("lastActiveTab" in patch)) {
      expect(viewState.lastActiveTab).toBe("pullRequests");
    }
  });

  describe("invalid data", () => {
    beforeEach(() => {
      clearNotifications();
    });

    it("rejects a single field with the wrong type, pushes a warning notification, and leaves the store unchanged", () => {
      const before = viewState.hideDepDashboard;
      updateViewState({ hideDepDashboard: "not-a-boolean" as unknown as boolean });

      expect(viewState.hideDepDashboard).toBe(before);

      const notifications = getNotifications();
      expect(notifications).toHaveLength(1);
      expect(notifications[0].source).toBe("view:updateViewState");
      expect(notifications[0].severity).toBe("warning");
    });
  });
});

describe("setGlobalFilter", () => {
  it("sets org and repo filter", () => {
    setGlobalFilter("myorg", "myrepo");
    expect(viewState.globalFilter.org).toBe("myorg");
    expect(viewState.globalFilter.repo).toBe("myrepo");
  });

  it("accepts null for both org and repo", () => {
    setGlobalFilter("myorg", "myrepo");
    setGlobalFilter(null, null);
    expect(viewState.globalFilter.org).toBeNull();
    expect(viewState.globalFilter.repo).toBeNull();
  });

  it("allows org without repo", () => {
    setGlobalFilter("myorg", null);
    expect(viewState.globalFilter.org).toBe("myorg");
    expect(viewState.globalFilter.repo).toBeNull();
  });
});

describe("setSortPreference", () => {
  it("sets global sort field and direction", () => {
    setSortPreference("updatedAt", "desc");
    expect(viewState.globalSort).toEqual({ field: "updatedAt", direction: "desc" });
  });

  it("updates existing global sort preference", () => {
    setSortPreference("updatedAt", "desc");
    setSortPreference("title", "asc");
    expect(viewState.globalSort).toEqual({ field: "title", direction: "asc" });
  });
});

describe("ignoreItem / unignoreItem", () => {
  const item1: IgnoredItem = {
    id: 1,
    type: "issue",
    repo: "owner/repo",
    title: "Bug fix",
    ignoredAt: 1711000000000,
  };
  const item2: IgnoredItem = {
    id: 42,
    type: "pullRequest",
    repo: "owner/repo",
    title: "Add feature",
    ignoredAt: 1711000001000,
  };

  it("ignoreItem adds an item to ignoredItems", () => {
    ignoreItem(item1);
    expect(viewState.ignoredItems).toHaveLength(1);
    expect(viewState.ignoredItems[0].id).toBe(1);
  });

  it("ignoreItem does not add duplicates", () => {
    ignoreItem(item1);
    ignoreItem(item1);
    expect(viewState.ignoredItems).toHaveLength(1);
  });

  it("ignoreItem can add multiple distinct items", () => {
    ignoreItem(item1);
    ignoreItem(item2);
    expect(viewState.ignoredItems).toHaveLength(2);
  });

  it("unignoreItem removes the item with the given id", () => {
    ignoreItem(item1);
    ignoreItem(item2);
    unignoreItem(1);
    expect(viewState.ignoredItems).toHaveLength(1);
    expect(viewState.ignoredItems[0].id).toBe(42);
  });

  it("unignoreItem is a no-op for an unknown id", () => {
    ignoreItem(item1);
    unignoreItem(9999);
    expect(viewState.ignoredItems).toHaveLength(1);
  });

  it("evicts oldest item when at 500 cap (FIFO)", () => {
    // Fill to 500
    for (let i = 0; i < 500; i++) {
      ignoreItem({ id: i, type: "issue", repo: "o/r", title: `T${i}`, ignoredAt: 1000 + i });
    }
    expect(viewState.ignoredItems).toHaveLength(500);

    // Adding 501st should evict item-0 (oldest)
    ignoreItem({ id: 9999, type: "issue", repo: "o/r", title: "New", ignoredAt: 2000 });
    expect(viewState.ignoredItems).toHaveLength(500);
    expect(viewState.ignoredItems[0].id).toBe(1); // item-0 evicted
    expect(viewState.ignoredItems[499].id).toBe(9999);
  });
});

describe("pruneStaleIgnoredItems", () => {
  it("removes items older than 30 days", () => {
    const now = Date.now();
    const old = now - 31 * 24 * 60 * 60 * 1000;
    const recent = now - 1 * 24 * 60 * 60 * 1000;

    ignoreItem({ id: 1, type: "issue", repo: "o/r", title: "Old", ignoredAt: old });
    ignoreItem({ id: 2, type: "pullRequest", repo: "o/r", title: "Recent", ignoredAt: recent });
    expect(viewState.ignoredItems).toHaveLength(2);

    pruneStaleIgnoredItems();
    expect(viewState.ignoredItems).toHaveLength(1);
    expect(viewState.ignoredItems[0].id).toBe(2);
  });

  it("is a no-op when ignoredItems is empty", () => {
    pruneStaleIgnoredItems();
    expect(viewState.ignoredItems).toHaveLength(0);
  });

  it("keeps items exactly at the 30-day boundary", () => {
    const now = Date.now();
    const exactly30 = now - 30 * 24 * 60 * 60 * 1000 + 1000;

    ignoreItem({ id: 1, type: "issue", repo: "o/r", title: "Edge", ignoredAt: exactly30 });
    pruneStaleIgnoredItems();
    expect(viewState.ignoredItems).toHaveLength(1);
  });
});

describe("initViewPersistence", () => {
  // Shared harness: every test in this block needs fake timers, a createRoot
  // to host initViewPersistence()'s effect, and real-timer restoration
  // afterward. `fn` receives `dispose` so tests can end the root whenever
  // their scenario requires (immediately, to test flush-on-disposal; or at
  // the end, after asserting the debounced write). `dispose()` is called
  // unconditionally in `finally` (idempotent in Solid — a no-op if the test
  // already called it) so a thrown assertion mid-test can't leave this
  // root's createEffect/storage-listener live against the shared, module-level
  // `viewState`, where it would keep firing (with real timers already
  // restored) against later, unrelated tests.
  async function withViewPersistence(fn: (dispose: () => void) => Promise<void> | void): Promise<void> {
    vi.useFakeTimers();
    let dispose!: () => void;
    createRoot((d) => {
      dispose = d;
      initViewPersistence();
    });
    try {
      await fn(dispose);
    } finally {
      dispose();
      vi.useRealTimers();
    }
  }

  // Reads whatever's currently on disk, or falls back to the live in-memory
  // viewState on the very first write of a test.
  function currentOnDisk(): Record<string, unknown> {
    return JSON.parse(localStorageMock.getItem(VIEW_KEY) ?? JSON.stringify(viewState));
  }

  // Simulates another tab writing directly to localStorage — merges `overrides`
  // onto whatever's already on disk.
  function seedOtherTabWrite(overrides: Record<string, unknown>): void {
    localStorageMock.setItem(VIEW_KEY, JSON.stringify({ ...currentOnDisk(), ...overrides }));
  }

  it("persists state changes to localStorage via createEffect", async () => {
    await withViewPersistence(async (dispose) => {
      setGlobalFilter("testorg", "testrepo");
      // SolidJS effects are scheduled as microtasks — flush with a tick
      await Promise.resolve();
      // Persistence is debounced by 200ms
      vi.advanceTimersByTime(200);

      const raw = localStorageMock.getItem(VIEW_KEY);
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!);
      expect(parsed.globalFilter.org).toBe("testorg");
      expect(parsed.globalFilter.repo).toBe("testrepo");
      dispose();
    });
  });

  it("coalesces two separate changes within the debounce window into a single write of the latest state", async () => {
    // Regression test: the debounce effect's flush-on-cleanup must be
    // registered on the OUTER owner, not nested inside createEffect. Solid
    // invokes onCleanup on both disposal AND recomputation — if nested
    // inside the effect, a second change arriving before the first change's
    // 200ms timer fires would flush the FIRST (stale) snapshot immediately
    // instead of coalescing into one trailing write of the latest state.
    await withViewPersistence(async (dispose) => {
      const setItemSpy = vi.spyOn(localStorageMock, "setItem");

      setGlobalFilter("org1", "repo1");
      await Promise.resolve();
      vi.advanceTimersByTime(50); // well within the 200ms window

      setGlobalFilter("org2", "repo2");
      await Promise.resolve();
      // No write should have happened yet from either change.
      expect(setItemSpy).not.toHaveBeenCalled();

      vi.advanceTimersByTime(200);

      // Exactly one write, reflecting the latest (second) state.
      expect(setItemSpy).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(localStorageMock.getItem(VIEW_KEY)!);
      expect(parsed.globalFilter.org).toBe("org2");
      expect(parsed.globalFilter.repo).toBe("repo2");

      setItemSpy.mockRestore();
      dispose();
    });
  });

  it("preserves another tab's concurrent write to a field this tab didn't touch (merge-on-write)", async () => {
    await withViewPersistence(async (dispose) => {
      // Simulate another tab writing directly to localStorage — a full
      // ViewState-shaped blob differing only in jiraCustomOrder, a field this
      // tab has never touched (still at its boot-time baseline of []).
      seedOtherTabWrite({ jiraCustomOrder: ["OTHER-1"] });

      // This tab changes an unrelated field, triggering its own debounced write.
      setGlobalFilter("org1", "repo1");
      await Promise.resolve();
      vi.advanceTimersByTime(200);

      const parsed = JSON.parse(localStorageMock.getItem(VIEW_KEY)!);
      expect(parsed.globalFilter.org).toBe("org1");
      // The other tab's jiraCustomOrder write must survive — this tab never
      // touched that field, so its own stale in-memory copy (still []) must
      // NOT clobber what's already on disk.
      expect(parsed.jiraCustomOrder).toEqual(["OTHER-1"]);

      dispose();
    });
  });

  it("this tab's own concurrent change to a field wins over a divergent on-disk value for that same field", async () => {
    await withViewPersistence(async (dispose) => {
      seedOtherTabWrite({ jiraCustomOrder: ["OTHER-1"] });

      // This tab ALSO changes jiraCustomOrder itself — its own value should win
      // over whatever the other tab wrote, since this tab's change is more recent.
      setJiraCustomOrder(["MINE-1", "MINE-2"]);
      await Promise.resolve();
      vi.advanceTimersByTime(200);

      const parsed = JSON.parse(localStorageMock.getItem(VIEW_KEY)!);
      expect(parsed.jiraCustomOrder).toEqual(["MINE-1", "MINE-2"]);

      dispose();
    });
  });

  it("drops unknown/unrecognized keys from the on-disk blob before merging (schema allowlist)", async () => {
    // Regression test: localStorage is writable by any same-origin script
    // (extensions, a stale/incompatible schema version, manual tampering).
    // readOnDiskState() must filter the parsed blob down to known
    // ViewStateSchema top-level keys before commitSnapshot() folds it into
    // the merged write — otherwise unrecognized content would be perpetually
    // re-persisted instead of self-healing on the next write.
    await withViewPersistence(async (dispose) => {
      const onDiskBeforeTamper = JSON.parse(localStorageMock.getItem(VIEW_KEY) ?? JSON.stringify(viewState));
      const taintedJson = JSON.stringify({ ...onDiskBeforeTamper, maliciousInjectedField: "should not survive" });
      // Splice in a literal "__proto__" key at the JSON-text level — `{...x, __proto__: y}`
      // as an object-literal would set the object's actual prototype (a language special
      // case) rather than produce JSON text containing a "__proto__" key. JSON.parse, by
      // contrast, does NOT apply that special-case magic: parsing `{"__proto__":{...}}`
      // creates a plain OWN property literally named "__proto__" — which is the actual
      // shape a tampered localStorage blob would take, and what readOnDiskState() must
      // filter out via the schema allowlist rather than relying on spread's inertness alone.
      const tainted = taintedJson.slice(0, -1) + ',"__proto__":{"polluted":true}}';
      localStorageMock.setItem(VIEW_KEY, tainted);

      setGlobalFilter("org1", "repo1");
      await Promise.resolve();
      vi.advanceTimersByTime(200);

      const parsed = JSON.parse(localStorageMock.getItem(VIEW_KEY)!);
      expect(parsed.globalFilter.org).toBe("org1");
      expect(parsed.maliciousInjectedField).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(parsed, "__proto__")).toBe(false);
      expect(Object.getPrototypeOf({})).not.toHaveProperty("polluted");

      dispose();
    });
  });

  it("drops a known key's value from the on-disk blob when it fails that field's own schema validation", async () => {
    // Regression test: the allowlist in readOnDiskState() must validate each
    // known key's VALUE against ViewStateSchema (not just its NAME) before
    // folding it into the merge — a structurally-valid-key-but-malformed-value
    // (e.g. jiraCustomOrder holding an object instead of a string array)
    // would otherwise survive the {...onDisk} spread untouched and be
    // re-persisted forever, never passing through Zod validation on write.
    await withViewPersistence(async (dispose) => {
      const onDiskBeforeTamper = JSON.parse(localStorageMock.getItem(VIEW_KEY) ?? JSON.stringify(viewState));
      localStorageMock.setItem(VIEW_KEY, JSON.stringify({
        ...onDiskBeforeTamper,
        jiraCustomOrder: { foo: "bar" }, // wrong shape: object instead of string[]
      }));

      setGlobalFilter("org1", "repo1");
      await Promise.resolve();
      vi.advanceTimersByTime(200);

      const parsed = JSON.parse(localStorageMock.getItem(VIEW_KEY)!);
      expect(parsed.globalFilter.org).toBe("org1");
      // The malformed jiraCustomOrder must be dropped, not echoed back — this
      // tab's own (valid, empty) value fills the gap instead.
      expect(parsed.jiraCustomOrder).toEqual([]);

      dispose();
    });
  });

  it("preserves this tab's known value for a key missing entirely from a corrupted/stale on-disk blob", async () => {
    await withViewPersistence(async (dispose) => {
      setJiraCustomOrder(["MINE-1"]);
      await Promise.resolve();
      vi.advanceTimersByTime(200);
      expect(JSON.parse(localStorageMock.getItem(VIEW_KEY)!).jiraCustomOrder).toEqual(["MINE-1"]);

      // Simulate a stale/corrupted on-disk blob missing jiraCustomOrder entirely
      // (version skew, manual tampering) — this tab's own last-known value for
      // that key must survive even though it hasn't changed since baseline.
      const onDisk = JSON.parse(localStorageMock.getItem(VIEW_KEY)!);
      delete onDisk.jiraCustomOrder;
      localStorageMock.setItem(VIEW_KEY, JSON.stringify(onDisk));

      setGlobalFilter("org1", "repo1");
      await Promise.resolve();
      vi.advanceTimersByTime(200);

      const parsed = JSON.parse(localStorageMock.getItem(VIEW_KEY)!);
      expect(parsed.globalFilter.org).toBe("org1");
      expect(parsed.jiraCustomOrder).toEqual(["MINE-1"]);

      dispose();
    });
  });

  it("falls back to this tab's own full snapshot when the on-disk blob is malformed JSON", async () => {
    await withViewPersistence(async (dispose) => {
      localStorageMock.setItem(VIEW_KEY, "{not valid json");

      expect(() => {
        setGlobalFilter("org1", "repo1");
      }).not.toThrow();
      await Promise.resolve();
      expect(() => vi.advanceTimersByTime(200)).not.toThrow();

      const parsed = JSON.parse(localStorageMock.getItem(VIEW_KEY)!);
      expect(parsed.globalFilter.org).toBe("org1");
      // Must be the FULL snapshot, not just the one field this test changed —
      // an untouched default field must also be present, ruling out a
      // regression that wrote only a partial object on this fallback path.
      expect(parsed.lastActiveTab).toBe("issues");
      expect(parsed.jiraCustomOrder).toEqual([]);

      dispose();
    });
  });

  it("falls back to this tab's own full snapshot when the on-disk blob is a JSON array or primitive", async () => {
    await withViewPersistence(async (dispose) => {
      localStorageMock.setItem(VIEW_KEY, "[1,2,3]");

      setGlobalFilter("org1", "repo1");
      await Promise.resolve();
      vi.advanceTimersByTime(200);

      const parsed = JSON.parse(localStorageMock.getItem(VIEW_KEY)!);
      expect(parsed.globalFilter.org).toBe("org1");
      expect(parsed.lastActiveTab).toBe("issues");

      dispose();
    });
  });

  it("pushes a warning notification and does not throw when localStorage.setItem fails (e.g. quota exceeded)", async () => {
    await withViewPersistence(async (dispose) => {
      clearNotifications();
      vi.spyOn(localStorageMock, "setItem").mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });

      setGlobalFilter("org1", "repo1");
      await Promise.resolve();
      expect(() => vi.advanceTimersByTime(200)).not.toThrow();

      const notifications = getNotifications();
      expect(notifications.some((n) => n.source === "localStorage:view")).toBe(true);

      vi.mocked(localStorageMock.setItem).mockRestore();
      dispose();
    });
  });

  it("flushes a pending debounced write synchronously on disposal (unmount/HMR)", async () => {
    await withViewPersistence(async (dispose) => {
      setGlobalFilter("unmount-org", "unmount-repo");
      await Promise.resolve();
      // Dispose before the 200ms debounce timer ever fires.
      dispose();

      const raw = localStorageMock.getItem(VIEW_KEY);
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!);
      expect(parsed.globalFilter.org).toBe("unmount-org");
      expect(parsed.globalFilter.repo).toBe("unmount-repo");
    });
  });
});

describe("initViewPersistence — genuine two-tab concurrency", () => {
  // Unlike the "preserves another tab's concurrent write" tests above (which
  // simulate "tab B" via a single synchronous localStorage.setItem call
  // representing an already-completed write), this describe block spins up
  // TWO fully independent module instances of stores/view.ts via
  // vi.resetModules() + fresh dynamic imports — each with its own in-memory
  // viewState, its own commitSnapshot()/lastSyncedSnapshot closure, and its
  // own live createEffect/debounce timer — sharing only the same
  // localStorageMock (the one durable channel two real browser tabs would
  // actually share). This exercises the hardest case for the merge-on-write
  // algorithm: two tabs changing the SAME field around the same time.
  beforeEach(() => {
    localStorageMock.clear();
  });

  async function importFreshViewModule() {
    vi.resetModules();
    return import("../../src/app/stores/view");
  }

  it("whichever tab's commitSnapshot() actually runs last wins when both change the same field at the same tick", async () => {
    vi.useFakeTimers();
    const tabA = await importFreshViewModule();
    const tabB = await importFreshViewModule();

    let disposeA!: () => void;
    let disposeB!: () => void;
    createRoot((d) => { disposeA = d; tabA.initViewPersistence(); });
    createRoot((d) => { disposeB = d; tabB.initViewPersistence(); });

    // A changes first, B changes second, both at essentially the same fake-timer
    // tick — both 200ms timers are scheduled for the identical target time, so
    // JS timer FIFO ordering (registration order) fires A's callback before B's.
    tabA.setJiraCustomOrder(["FROM-A"]);
    await Promise.resolve();
    tabB.setJiraCustomOrder(["FROM-B"]);
    await Promise.resolve();

    vi.advanceTimersByTime(200);

    // B's commit runs strictly after A's (registered later, same target time),
    // so B's write is the one that lands last on disk.
    const parsed = JSON.parse(localStorageMock.getItem(VIEW_KEY)!);
    expect(parsed.jiraCustomOrder).toEqual(["FROM-B"]);

    disposeA();
    disposeB();
    vi.useRealTimers();
  });

  it("reversing which tab changes the field last reverses which value wins", async () => {
    vi.useFakeTimers();
    const tabA = await importFreshViewModule();
    const tabB = await importFreshViewModule();

    let disposeA!: () => void;
    let disposeB!: () => void;
    createRoot((d) => { disposeA = d; tabA.initViewPersistence(); });
    createRoot((d) => { disposeB = d; tabB.initViewPersistence(); });

    // B changes first this time, A changes second — A's commit should now
    // run last and win.
    tabB.setJiraCustomOrder(["FROM-B"]);
    await Promise.resolve();
    tabA.setJiraCustomOrder(["FROM-A"]);
    await Promise.resolve();

    vi.advanceTimersByTime(200);

    const parsed = JSON.parse(localStorageMock.getItem(VIEW_KEY)!);
    expect(parsed.jiraCustomOrder).toEqual(["FROM-A"]);

    disposeA();
    disposeB();
    vi.useRealTimers();
  });

  it("a tab's unrelated field change does not clobber the other tab's more recent same-field write", async () => {
    vi.useFakeTimers();
    const tabA = await importFreshViewModule();
    const tabB = await importFreshViewModule();

    let disposeA!: () => void;
    let disposeB!: () => void;
    createRoot((d) => { disposeA = d; tabA.initViewPersistence(); });
    createRoot((d) => { disposeB = d; tabB.initViewPersistence(); });

    // B writes jiraCustomOrder and its debounced commit fully completes first.
    tabB.setJiraCustomOrder(["FROM-B"]);
    await Promise.resolve();
    vi.advanceTimersByTime(200);
    expect(JSON.parse(localStorageMock.getItem(VIEW_KEY)!).jiraCustomOrder).toEqual(["FROM-B"]);

    // A, which never touched jiraCustomOrder, now changes an unrelated field.
    // A's own stale in-memory jiraCustomOrder ([]) must NOT overwrite B's
    // already-committed value merely because A is writing at all.
    tabA.setGlobalFilter("org1", "repo1");
    await Promise.resolve();
    vi.advanceTimersByTime(200);

    const parsed = JSON.parse(localStorageMock.getItem(VIEW_KEY)!);
    expect(parsed.globalFilter.org).toBe("org1");
    expect(parsed.jiraCustomOrder).toEqual(["FROM-B"]);

    disposeA();
    disposeB();
    vi.useRealTimers();
  });
});

describe("ViewStateSchema", () => {
  it("returns defaults for empty object", () => {
    const result = ViewStateSchema.parse({});
    expect(result.lastActiveTab).toBe("issues");
    expect(result.globalSort).toEqual({ field: "updatedAt", direction: "desc" });
    expect(result.ignoredItems).toEqual([]);
    expect(result.globalFilter).toEqual({ org: null, repo: null });
  });

  it("handles missing fields with defaults", () => {
    const result = ViewStateSchema.parse({ lastActiveTab: "actions" });
    expect(result.lastActiveTab).toBe("actions");
    expect(result.ignoredItems).toEqual([]);
  });

  it("lastActiveTab accepts custom tab ID strings", () => {
    const result = ViewStateSchema.safeParse({ lastActiveTab: "custom-abc123" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.lastActiveTab).toBe("custom-abc123");
  });

  it("safeParse returns success=false for truly invalid data", () => {
    // Verify schema still rejects genuinely invalid structures
    const result = ViewStateSchema.safeParse({ ignoredItems: "not-an-array" });
    expect(result.success).toBe(false);
  });

  it("missing expandedRepos field parses to defaults", () => {
    const result = ViewStateSchema.parse({ lastActiveTab: "actions" });
    expect(result.expandedRepos).toEqual({ issues: {}, pullRequests: {}, actions: {}, jiraAssigned: {} });
  });

  it("old localStorage data with sortPreferences parses cleanly with globalSort default", () => {
    const oldData = {
      lastActiveTab: "issues",
      sortPreferences: { issues: { field: "title", direction: "asc" } },
    };
    const result = ViewStateSchema.parse(oldData);
    expect(result.globalSort).toEqual({ field: "updatedAt", direction: "desc" });
  });
});

describe("expandedRepos helpers", () => {
  it("toggleExpandedRepo sets key to true when absent", () => {
    toggleExpandedRepo("issues", "owner/repo");
    expect(viewState.expandedRepos.issues["owner/repo"]).toBe(true);
  });

  it("toggleExpandedRepo deletes key when already true (sparse record)", () => {
    toggleExpandedRepo("issues", "owner/repo");
    expect(viewState.expandedRepos.issues["owner/repo"]).toBe(true);
    toggleExpandedRepo("issues", "owner/repo");
    expect("owner/repo" in viewState.expandedRepos.issues).toBe(false);
  });

  it("toggleExpandedRepo works independently per tab", () => {
    toggleExpandedRepo("issues", "owner/repo");
    toggleExpandedRepo("pullRequests", "owner/repo");
    expect(viewState.expandedRepos.issues["owner/repo"]).toBe(true);
    expect(viewState.expandedRepos.pullRequests["owner/repo"]).toBe(true);
    expect("owner/repo" in viewState.expandedRepos.actions).toBe(false);
  });

  it("setAllExpanded sets multiple repos to true", () => {
    setAllExpanded("issues", ["owner/a", "owner/b", "owner/c"], true);
    expect(viewState.expandedRepos.issues["owner/a"]).toBe(true);
    expect(viewState.expandedRepos.issues["owner/b"]).toBe(true);
    expect(viewState.expandedRepos.issues["owner/c"]).toBe(true);
  });

  it("setAllExpanded with empty array is a no-op", () => {
    setAllExpanded("issues", ["owner/existing"], true);
    setAllExpanded("issues", [], true);
    expect(viewState.expandedRepos.issues["owner/existing"]).toBe(true);
    setAllExpanded("issues", [], false);
    expect(viewState.expandedRepos.issues["owner/existing"]).toBe(true);
  });

  it("setAllExpanded with expanded=false deletes all keys (sparse record)", () => {
    setAllExpanded("issues", ["owner/a", "owner/b"], true);
    setAllExpanded("issues", ["owner/a", "owner/b"], false);
    expect("owner/a" in viewState.expandedRepos.issues).toBe(false);
    expect("owner/b" in viewState.expandedRepos.issues).toBe(false);
  });

  it("pruneExpandedRepos removes stale keys and keeps active ones", () => {
    setAllExpanded("actions", ["owner/active", "owner/stale"], true);
    pruneExpandedRepos("actions", ["owner/active"]);
    expect(viewState.expandedRepos.actions["owner/active"]).toBe(true);
    expect("owner/stale" in viewState.expandedRepos.actions).toBe(false);
  });

  it("pruneExpandedRepos short-circuits when no stale keys exist", () => {
    setAllExpanded("pullRequests", ["owner/a"], true);
    // Spy on setViewState indirectly: verify state is unchanged and no error thrown
    const before = JSON.stringify(viewState.expandedRepos.pullRequests);
    pruneExpandedRepos("pullRequests", ["owner/a"]);
    expect(JSON.stringify(viewState.expandedRepos.pullRequests)).toBe(before);
    expect(viewState.expandedRepos.pullRequests["owner/a"]).toBe(true);
  });

  it("localStorage round-trip: expandedRepos persists and restores via schema", async () => {
    vi.useFakeTimers();
    let dispose!: () => void;
    createRoot((d) => {
      dispose = d;
      initViewPersistence();
      toggleExpandedRepo("issues", "myorg/myrepo");
      setAllExpanded("actions", ["myorg/ci"], true);
    });

    await Promise.resolve();
    vi.advanceTimersByTime(200);

    const raw = localStorageMock.getItem(VIEW_KEY);
    expect(raw).not.toBeNull();
    const restored = ViewStateSchema.parse(JSON.parse(raw!));
    expect(restored.expandedRepos.issues["myorg/myrepo"]).toBe(true);
    expect(restored.expandedRepos.actions["myorg/ci"]).toBe(true);
    expect(restored.expandedRepos.pullRequests).toEqual({});
    dispose();
    vi.useRealTimers();
  });
});

describe("resetViewState", () => {
  it("resets globalSort to default", () => {
    setSortPreference("title", "asc");
    expect(viewState.globalSort.field).toBe("title");
    resetViewState();
    expect(viewState.globalSort).toEqual({ field: "updatedAt", direction: "desc" });
  });

  it("clears dynamically-added expandedRepos keys", () => {
    setAllExpanded("issues", ["org/repo-a", "org/repo-b"], true);
    setAllExpanded("pullRequests", ["org/repo-c"], true);
    toggleExpandedRepo("actions", "org/repo-d");
    expect(viewState.expandedRepos.issues["org/repo-a"]).toBe(true);

    resetViewState();

    expect("org/repo-a" in viewState.expandedRepos.issues).toBe(false);
    expect("org/repo-b" in viewState.expandedRepos.issues).toBe(false);
    expect("org/repo-c" in viewState.expandedRepos.pullRequests).toBe(false);
    expect("org/repo-d" in viewState.expandedRepos.actions).toBe(false);
  });
});

describe("resetAllTabFilters — scope reset", () => {
  it("resets issues scope from 'all' back to 'involves_me'", () => {
    setTabFilter("issues", "scope", "all");
    expect(viewState.tabFilters.issues.scope).toBe("all");
    resetAllTabFilters("issues");
    expect(viewState.tabFilters.issues.scope).toBe("involves_me");
  });

  it("resets pullRequests scope from 'all' back to 'involves_me'", () => {
    setTabFilter("pullRequests", "scope", "all");
    expect(viewState.tabFilters.pullRequests.scope).toBe("all");
    resetAllTabFilters("pullRequests");
    expect(viewState.tabFilters.pullRequests.scope).toBe("involves_me");
  });

  it("resets jiraAssigned filters back to defaults", () => {
    setTabFilter("jiraAssigned", "statusCategory", "indeterminate");
    expect(viewState.tabFilters.jiraAssigned.statusCategory).toBe("indeterminate");
    resetAllTabFilters("jiraAssigned");
    expect(viewState.tabFilters.jiraAssigned.statusCategory).toBe("all");
    expect(viewState.tabFilters.jiraAssigned.priority).toBe("all");
  });
});

describe("setTabFilter — jiraAssigned", () => {
  it("sets jiraAssigned statusCategory filter", () => {
    setTabFilter("jiraAssigned", "statusCategory", "new");
    expect(viewState.tabFilters.jiraAssigned.statusCategory).toBe("new");
  });

  it("sets jiraAssigned priority filter", () => {
    setTabFilter("jiraAssigned", "priority", "High");
    expect(viewState.tabFilters.jiraAssigned.priority).toBe("High");
  });

  it("preserves other jiraAssigned filters when setting one", () => {
    setTabFilter("jiraAssigned", "statusCategory", "indeterminate");
    setTabFilter("jiraAssigned", "priority", "Medium");
    expect(viewState.tabFilters.jiraAssigned.statusCategory).toBe("indeterminate");
    expect(viewState.tabFilters.jiraAssigned.priority).toBe("Medium");
  });
});

describe("tracked items", () => {
  const item1: TrackedItem = {
    id: 1001,
    number: 101,
    type: "issue",
    source: "github",
    repoFullName: "owner/repo",
    title: "Bug fix",
    addedAt: 1711000000000,
  };
  const item2: TrackedItem = {
    id: 2002,
    number: 202,
    type: "pullRequest",
    source: "github",
    repoFullName: "owner/repo",
    title: "Add feature",
    addedAt: 1711000001000,
  };
  const item3: TrackedItem = {
    id: 3003,
    number: 303,
    type: "issue",
    source: "github",
    repoFullName: "owner/other",
    title: "Another issue",
    addedAt: 1711000002000,
  };

  describe("trackItem", () => {
    it("adds an item to trackedItems", () => {
      trackItem(item1);
      expect(viewState.trackedItems).toHaveLength(1);
      expect(viewState.trackedItems[0].id).toBe(1001);
    });

    it("does not add duplicate (same id+type)", () => {
      trackItem(item1);
      trackItem(item1);
      expect(viewState.trackedItems).toHaveLength(1);
    });

    it("allows same id with different type", () => {
      trackItem(item1); // id:1001, type:issue
      trackItem({ ...item1, type: "pullRequest" }); // id:1001, type:pullRequest
      expect(viewState.trackedItems).toHaveLength(2);
    });

    it("can add multiple distinct items", () => {
      trackItem(item1);
      trackItem(item2);
      expect(viewState.trackedItems).toHaveLength(2);
    });

    it("evicts oldest item when at 200 cap (FIFO)", () => {
      // Fill to 200
      for (let i = 0; i < 200; i++) {
        trackItem({ id: i, number: i, type: "issue", source: "github", repoFullName: "o/r", title: `T${i}`, addedAt: 1000 + i });
      }
      expect(viewState.trackedItems).toHaveLength(200);

      // Adding 201st should evict item with id:0 (oldest)
      trackItem({ id: 9999, number: 9999, type: "issue", source: "github", repoFullName: "o/r", title: "New", addedAt: 2000 });
      expect(viewState.trackedItems).toHaveLength(200);
      expect(viewState.trackedItems[0].id).toBe(1); // id:0 evicted
      expect(viewState.trackedItems[199].id).toBe(9999);
    });
  });

  describe("untrackItem", () => {
    it("removes the item with the given id+type", () => {
      trackItem(item1);
      trackItem(item2);
      untrackItem(1001, "issue");
      expect(viewState.trackedItems).toHaveLength(1);
      expect(viewState.trackedItems[0].id).toBe(2002);
    });

    it("is a no-op for unknown id+type", () => {
      trackItem(item1);
      untrackItem(9999, "issue");
      expect(viewState.trackedItems).toHaveLength(1);
    });

    it("does not remove item if type does not match", () => {
      trackItem(item1); // id:1001, type:issue
      untrackItem(1001, "pullRequest"); // different type
      expect(viewState.trackedItems).toHaveLength(1);
    });
  });

  describe("moveTrackedItem", () => {
    it("moves item up by swapping with predecessor", () => {
      trackItem(item1);
      trackItem(item2);
      trackItem(item3);
      // Order: item1, item2, item3 → move item2 up → item2, item1, item3
      moveTrackedItem(2002, "pullRequest", "up");
      expect(viewState.trackedItems[0].id).toBe(2002);
      expect(viewState.trackedItems[1].id).toBe(1001);
      expect(viewState.trackedItems[2].id).toBe(3003);
    });

    it("moves item down by swapping with successor", () => {
      trackItem(item1);
      trackItem(item2);
      trackItem(item3);
      // Order: item1, item2, item3 → move item2 down → item1, item3, item2
      moveTrackedItem(2002, "pullRequest", "down");
      expect(viewState.trackedItems[0].id).toBe(1001);
      expect(viewState.trackedItems[1].id).toBe(3003);
      expect(viewState.trackedItems[2].id).toBe(2002);
    });

    it("is a no-op when moving first item up", () => {
      trackItem(item1);
      trackItem(item2);
      moveTrackedItem(1001, "issue", "up");
      expect(viewState.trackedItems[0].id).toBe(1001);
      expect(viewState.trackedItems[1].id).toBe(2002);
    });

    it("is a no-op when moving last item down", () => {
      trackItem(item1);
      trackItem(item2);
      moveTrackedItem(2002, "pullRequest", "down");
      expect(viewState.trackedItems[0].id).toBe(1001);
      expect(viewState.trackedItems[1].id).toBe(2002);
    });

    it("is a no-op for unknown id+type", () => {
      trackItem(item1);
      moveTrackedItem(9999, "issue", "up");
      expect(viewState.trackedItems).toHaveLength(1);
      expect(viewState.trackedItems[0].id).toBe(1001);
    });
  });

  describe("pruneClosedTrackedItems", () => {
    it("removes items whose type:id key is in pruneKeys", () => {
      trackItem(item1); // issue:1001
      trackItem(item2); // pullRequest:2002
      trackItem(item3); // issue:3003
      pruneClosedTrackedItems(new Set(["issue:1001", "issue:3003"]));
      expect(viewState.trackedItems).toHaveLength(1);
      expect(viewState.trackedItems[0].id).toBe(2002);
    });

    it("is a no-op when pruneKeys is empty", () => {
      trackItem(item1);
      trackItem(item2);
      pruneClosedTrackedItems(new Set());
      expect(viewState.trackedItems).toHaveLength(2);
    });

    it("is a no-op when no tracked items match pruneKeys", () => {
      trackItem(item1);
      pruneClosedTrackedItems(new Set(["pullRequest:9999"]));
      expect(viewState.trackedItems).toHaveLength(1);
    });

    it("removes all items when all keys match", () => {
      trackItem(item1);
      trackItem(item2);
      pruneClosedTrackedItems(new Set(["issue:1001", "pullRequest:2002"]));
      expect(viewState.trackedItems).toHaveLength(0);
    });
  });

  describe("resetViewState clears trackedItems", () => {
    it("resets trackedItems to empty array", () => {
      trackItem(item1);
      trackItem(item2);
      expect(viewState.trackedItems).toHaveLength(2);
      resetViewState();
      expect(viewState.trackedItems).toHaveLength(0);
    });
  });

  describe("ViewStateSchema — trackedItems", () => {
    it("defaults trackedItems to empty array", () => {
      const result = ViewStateSchema.parse({});
      expect(result.trackedItems).toEqual([]);
    });

    it("accepts lastActiveTab value 'tracked'", () => {
      const result = ViewStateSchema.parse({ lastActiveTab: "tracked" });
      expect(result.lastActiveTab).toBe("tracked");
    });
  });

  describe("Jira tracked items", () => {
    const jiraItem: TrackedItem = {
      id: -1234,
      type: "jiraIssue",
      source: "jira",
      jiraKey: "PROJ-42",
      jiraProjectKey: "PROJ",
      jiraStatus: "In Progress",
      repoFullName: "mysite.atlassian.net/PROJ",
      title: "Fix login bug",
      htmlUrl: "https://mysite.atlassian.net/browse/PROJ-42",
      addedAt: 1711000003000,
    };

    const jiraItem2: TrackedItem = {
      id: -5678,
      type: "jiraIssue",
      source: "jira",
      jiraKey: "TEAM-99",
      jiraProjectKey: "TEAM",
      jiraStatus: "To Do",
      repoFullName: "mysite.atlassian.net/TEAM",
      title: "Add dashboard",
      htmlUrl: "https://mysite.atlassian.net/browse/TEAM-99",
      addedAt: 1711000004000,
    };

    it("trackItem adds a Jira item with source=jira", () => {
      trackItem(jiraItem);
      expect(viewState.trackedItems).toHaveLength(1);
      expect(viewState.trackedItems[0].source).toBe("jira");
      expect(viewState.trackedItems[0].jiraKey).toBe("PROJ-42");
    });

    it("trackItem deduplicates by jiraKey for source=jira (not by id)", () => {
      trackItem(jiraItem);
      trackItem({ ...jiraItem, id: 9999 });
      expect(viewState.trackedItems).toHaveLength(1);
    });

    it("trackItem allows same id with different source", () => {
      const githubItem: TrackedItem = { ...item1, id: jiraItem.id };
      trackItem(githubItem);
      trackItem(jiraItem);
      expect(viewState.trackedItems).toHaveLength(2);
    });

    it("untrackJiraItem removes by jiraKey", () => {
      trackItem(jiraItem);
      trackItem(jiraItem2);
      untrackJiraItem("PROJ-42");
      expect(viewState.trackedItems).toHaveLength(1);
      expect(viewState.trackedItems[0].jiraKey).toBe("TEAM-99");
    });

    it("untrackJiraItem does not affect GitHub items", () => {
      trackItem(item1);
      trackItem(jiraItem);
      untrackJiraItem("PROJ-42");
      expect(viewState.trackedItems).toHaveLength(1);
      expect(viewState.trackedItems[0].source).toBe("github");
    });

    it("moveJiraItem reorders by jiraKey", () => {
      trackItem(jiraItem);
      trackItem(jiraItem2);
      moveJiraItem("TEAM-99", "up");
      expect(viewState.trackedItems[0].jiraKey).toBe("TEAM-99");
      expect(viewState.trackedItems[1].jiraKey).toBe("PROJ-42");
    });

    it("mixed GitHub + Jira items coexist", () => {
      trackItem(item1);
      trackItem(jiraItem);
      trackItem(item2);
      trackItem(jiraItem2);
      expect(viewState.trackedItems).toHaveLength(4);
    });

    it("items without source field default to 'github' after schema parse", () => {
      const legacy = { id: 100, number: 10, type: "issue" as const, repoFullName: "o/r", title: "old", addedAt: 0 };
      const parsed = ViewStateSchema.parse({ trackedItems: [legacy] });
      expect(parsed.trackedItems[0].source).toBe("github");
    });
  });
});

// ── Custom tab view state (setCustomTabFilter, resetCustomTabFilters, removeCustomTabState) ──

describe("setCustomTabFilter", () => {
  beforeEach(() => resetViewState());

  it("writes to the correct nested key", () => {
    setCustomTabFilter("tab-abc", "role", "author");
    expect(viewState.customTabFilters["tab-abc"]).toBeDefined();
    expect(viewState.customTabFilters["tab-abc"]["role"]).toBe("author");
  });

  it("initializes the nested record if the tab key is missing", () => {
    expect(viewState.customTabFilters["tab-new"]).toBeUndefined();
    setCustomTabFilter("tab-new", "scope", "all");
    expect(viewState.customTabFilters["tab-new"]).toBeDefined();
    expect(viewState.customTabFilters["tab-new"]["scope"]).toBe("all");
  });

  it("can write multiple fields independently", () => {
    setCustomTabFilter("tab-x", "role", "assignee");
    setCustomTabFilter("tab-x", "scope", "all");
    expect(viewState.customTabFilters["tab-x"]["role"]).toBe("assignee");
    expect(viewState.customTabFilters["tab-x"]["scope"]).toBe("all");
  });

  it("does not affect other tab IDs", () => {
    setCustomTabFilter("tab-1", "role", "author");
    setCustomTabFilter("tab-2", "role", "assignee");
    expect(viewState.customTabFilters["tab-1"]["role"]).toBe("author");
    expect(viewState.customTabFilters["tab-2"]["role"]).toBe("assignee");
  });
});

describe("resetCustomTabFilters", () => {
  beforeEach(() => resetViewState());

  it("clears stored overrides to an empty object", () => {
    setCustomTabFilter("tab-abc", "role", "author");
    setCustomTabFilter("tab-abc", "scope", "all");
    expect(Object.keys(viewState.customTabFilters["tab-abc"])).toHaveLength(2);
    resetCustomTabFilters("tab-abc");
    expect(viewState.customTabFilters["tab-abc"]).toEqual({});
  });

  it("does not affect other tab IDs when resetting one", () => {
    setCustomTabFilter("tab-1", "role", "author");
    setCustomTabFilter("tab-2", "role", "assignee");
    resetCustomTabFilters("tab-1");
    expect(viewState.customTabFilters["tab-1"]).toEqual({});
    expect(viewState.customTabFilters["tab-2"]["role"]).toBe("assignee");
  });

  it("is safe to call when the tab has no existing filters", () => {
    resetCustomTabFilters("tab-nonexistent");
    expect(viewState.customTabFilters["tab-nonexistent"]).toEqual({});
  });
});

describe("removeCustomTabState", () => {
  beforeEach(() => resetViewState());

  it("cleans customTabFilters for the given tab ID", () => {
    setCustomTabFilter("tab-abc", "role", "author");
    removeCustomTabState("tab-abc");
    expect("tab-abc" in viewState.customTabFilters).toBe(false);
  });

  it("cleans expandedRepos for the given tab ID", () => {
    toggleExpandedRepo("tab-abc", "owner/repo");
    expect(viewState.expandedRepos["tab-abc"]).toBeDefined();
    removeCustomTabState("tab-abc");
    expect("tab-abc" in viewState.expandedRepos).toBe(false);
  });

  it("removes both customTabFilters and expandedRepos in a single call", () => {
    setCustomTabFilter("tab-abc", "scope", "all");
    toggleExpandedRepo("tab-abc", "owner/repo");
    removeCustomTabState("tab-abc");
    expect("tab-abc" in viewState.customTabFilters).toBe(false);
    expect("tab-abc" in viewState.expandedRepos).toBe(false);
  });

  it("cleans lockedRepos for the given tab ID", () => {
    lockRepo("tab-abc", "owner/repo");
    expect(viewState.lockedRepos["tab-abc"]).toContain("owner/repo");
    removeCustomTabState("tab-abc");
    expect("tab-abc" in viewState.lockedRepos).toBe(false);
  });

  it("is a no-op for a nonexistent tab ID (no error thrown)", () => {
    expect(() => removeCustomTabState("tab-never-existed")).not.toThrow();
    expect("tab-never-existed" in viewState.customTabFilters).toBe(false);
  });

  it("does not affect state for other tab IDs", () => {
    setCustomTabFilter("tab-1", "role", "author");
    setCustomTabFilter("tab-2", "role", "assignee");
    toggleExpandedRepo("tab-1", "owner/repo");
    removeCustomTabState("tab-1");
    expect(viewState.customTabFilters["tab-2"]["role"]).toBe("assignee");
  });
});

describe("resetViewState — custom tab fields", () => {
  beforeEach(() => resetViewState());

  it("clears customTabFilters", () => {
    setCustomTabFilter("tab-abc", "role", "author");
    setCustomTabFilter("tab-xyz", "scope", "all");
    expect(Object.keys(viewState.customTabFilters)).toHaveLength(2);
    resetViewState();
    expect(viewState.customTabFilters).toEqual({});
  });

  it("clears custom tab keys from expandedRepos while preserving built-in keys", () => {
    toggleExpandedRepo("issues", "owner/repo");
    toggleExpandedRepo("tab-custom", "owner/repo");
    resetViewState();
    // Built-in keys reset to empty objects (not deleted)
    expect(viewState.expandedRepos["issues"]).toEqual({});
    expect(viewState.expandedRepos["pullRequests"]).toEqual({});
    expect(viewState.expandedRepos["actions"]).toEqual({});
    // Custom key is fully deleted
    expect("tab-custom" in viewState.expandedRepos).toBe(false);
  });

  it("clears custom tab keys from lockedRepos and resets built-in keys to []", () => {
    lockRepo("issues", "owner/repo");
    lockRepo("tab-custom", "owner/repo");
    resetViewState();
    // Built-in keys reset to empty arrays
    expect(viewState.lockedRepos["issues"]).toEqual([]);
    expect(viewState.lockedRepos["pullRequests"]).toEqual([]);
    expect(viewState.lockedRepos["actions"]).toEqual([]);
    // Custom key is fully deleted
    expect("tab-custom" in viewState.lockedRepos).toBe(false);
  });
});

describe("expandedRepos — dynamic tab keys", () => {
  beforeEach(() => resetViewState());

  it("accepts dynamic string keys for custom tab IDs", () => {
    toggleExpandedRepo("tab-custom-123", "owner/repo");
    expect(viewState.expandedRepos["tab-custom-123"]["owner/repo"]).toBe(true);
  });

  it("toggleExpandedRepo with a new custom tab key creates the entry", () => {
    expect(viewState.expandedRepos["tab-new"]).toBeUndefined();
    toggleExpandedRepo("tab-new", "owner/repo");
    expect(viewState.expandedRepos["tab-new"]).toBeDefined();
    expect(viewState.expandedRepos["tab-new"]["owner/repo"]).toBe(true);
  });
});

// ── DependencyFiltersSchema ───────────────────────────────────────────────────

describe("DependencyFiltersSchema", () => {
  it("parse({}) returns defaults: updateType='all', bot='all'", () => {
    const result = DependencyFiltersSchema.parse({});
    expect(result.updateType).toBe("all");
    expect(result.bot).toBe("all");
  });

  it("accepts valid updateType values", () => {
    for (const v of ["all", "major", "minor", "patch"] as const) {
      expect(DependencyFiltersSchema.parse({ updateType: v }).updateType).toBe(v);
    }
  });

  it("rejects invalid updateType values", () => {
    const result = DependencyFiltersSchema.safeParse({ updateType: "invalid" });
    expect(result.success).toBe(false);
  });

  it("accepts any string value for bot", () => {
    const result = DependencyFiltersSchema.parse({ bot: "renovate[bot]" });
    expect(result.bot).toBe("renovate[bot]");
  });

  it("defaults bot to 'all' when not provided", () => {
    const result = DependencyFiltersSchema.parse({ updateType: "major" });
    expect(result.bot).toBe("all");
  });

  it("accepts 'digest' as a valid updateType value", () => {
    const result = DependencyFiltersSchema.safeParse({ updateType: "digest", bot: "all" });
    expect(result.success).toBe(true);
  });
});

describe("setTabFilter / resetAllTabFilters — dependencies", () => {
  beforeEach(() => resetViewState());

  it("setTabFilter('dependencies', 'updateType', 'major') persists in viewState", () => {
    setTabFilter("dependencies", "updateType", "major");
    expect(viewState.tabFilters.dependencies.updateType).toBe("major");
  });

  it("setTabFilter('dependencies', 'bot', 'renovate[bot]') persists in viewState", () => {
    setTabFilter("dependencies", "bot", "renovate[bot]");
    expect(viewState.tabFilters.dependencies.bot).toBe("renovate[bot]");
  });

  it("setTabFilter for one field does not change other dependency filter fields", () => {
    setTabFilter("dependencies", "bot", "dependabot[bot]");
    // updateType should remain at its default
    expect(viewState.tabFilters.dependencies.updateType).toBe("all");
  });

  it("resetAllTabFilters('dependencies') resets updateType to 'all'", () => {
    setTabFilter("dependencies", "updateType", "patch");
    expect(viewState.tabFilters.dependencies.updateType).toBe("patch");
    resetAllTabFilters("dependencies");
    expect(viewState.tabFilters.dependencies.updateType).toBe("all");
  });

  it("resetAllTabFilters('dependencies') resets bot to 'all'", () => {
    setTabFilter("dependencies", "bot", "renovate[bot]");
    resetAllTabFilters("dependencies");
    expect(viewState.tabFilters.dependencies.bot).toBe("all");
  });

  it("resetAllTabFilters('dependencies') resets both fields simultaneously", () => {
    setTabFilter("dependencies", "updateType", "minor");
    setTabFilter("dependencies", "bot", "dependabot[bot]");
    resetAllTabFilters("dependencies");
    expect(viewState.tabFilters.dependencies.updateType).toBe("all");
    expect(viewState.tabFilters.dependencies.bot).toBe("all");
  });

  it("ViewStateSchema.parse({}) includes dependencies tabFilter defaults", () => {
    const result = ViewStateSchema.parse({});
    expect(result.tabFilters.dependencies.updateType).toBe("all");
    expect(result.tabFilters.dependencies.bot).toBe("all");
  });

  it("dependencies filter state is not affected by resetAllTabFilters('issues')", () => {
    setTabFilter("dependencies", "updateType", "minor");
    setTabFilter("issues", "role", "author");
    resetAllTabFilters("issues");
    // dependencies should be unchanged — only issues was reset
    expect(viewState.tabFilters.dependencies.updateType).toBe("minor");
  });
});

describe("loadViewState — cap-guard integration", () => {
  afterEach(() => {
    localStorageMock.clear();
  });

  it("deletes non-array lockedRepos tab values and preserves valid ones", async () => {
    localStorageMock.setItem(VIEW_KEY, JSON.stringify({
      lastActiveTab: "actions",
      lockedRepos: { issues: ["org/repo"], pullRequests: "bad-value" },
    }));

    vi.resetModules();
    const mod = await import("../../src/app/stores/view");

    expect(mod.viewState.lastActiveTab).toBe("actions");
    expect(mod.viewState.lockedRepos["issues"]).toEqual(["org/repo"]);
    expect(mod.viewState.lockedRepos["pullRequests"]).toBeUndefined();
  });

  it("truncates oversized lockedRepos arrays to LOCKED_REPOS_CAP", async () => {
    const bigArray = Array.from({ length: 60 }, (_, i) => `org/repo-${i}`);
    localStorageMock.setItem(VIEW_KEY, JSON.stringify({
      lockedRepos: { issues: bigArray },
    }));

    vi.resetModules();
    const mod = await import("../../src/app/stores/view");

    expect(mod.viewState.lockedRepos["issues"].length).toBe(mod.LOCKED_REPOS_CAP);
  });

  it("filters non-string elements from lockedRepos arrays", async () => {
    localStorageMock.setItem(VIEW_KEY, JSON.stringify({
      lockedRepos: { issues: [42, "org/repo", null, true, "org/other"] },
    }));

    vi.resetModules();
    const mod = await import("../../src/app/stores/view");

    expect(mod.viewState.lockedRepos["issues"]).toEqual(["org/repo", "org/other"]);
  });

  it("truncates oversized jiraCustomOrder arrays to JIRA_CUSTOM_ORDER_CAP", async () => {
    const bigArray = Array.from({ length: 600 }, (_, i) => `KEY-${i}`);
    localStorageMock.setItem(VIEW_KEY, JSON.stringify({
      jiraCustomOrder: bigArray,
    }));

    vi.resetModules();
    const mod = await import("../../src/app/stores/view");

    expect(mod.viewState.jiraCustomOrder.length).toBe(mod.JIRA_CUSTOM_ORDER_CAP);
    expect(mod.viewState.jiraCustomOrder[0]).toBe("KEY-0");
    expect(mod.viewState.jiraCustomOrder[mod.JIRA_CUSTOM_ORDER_CAP - 1]).toBe(
      `KEY-${mod.JIRA_CUSTOM_ORDER_CAP - 1}`
    );
  });

  it("filters non-string elements from jiraCustomOrder arrays", async () => {
    localStorageMock.setItem(VIEW_KEY, JSON.stringify({
      jiraCustomOrder: [42, "PROJ-1", null, true, "PROJ-2"],
    }));

    vi.resetModules();
    const mod = await import("../../src/app/stores/view");

    expect(mod.viewState.jiraCustomOrder).toEqual(["PROJ-1", "PROJ-2"]);
  });

  it("drops (not truncates) jiraCustomOrder entries longer than JIRA_CUSTOM_ORDER_KEY_MAX_LENGTH", async () => {
    const maxLen = 50;
    const tooLong = "X".repeat(maxLen + 1); // 51 chars — over the limit
    localStorageMock.setItem(VIEW_KEY, JSON.stringify({
      jiraCustomOrder: ["PROJ-1", tooLong],
    }));

    vi.resetModules();
    const mod = await import("../../src/app/stores/view");

    // Sanity: confirm the constant matches what this test assumes before trusting the assertions below.
    expect(mod.JIRA_CUSTOM_ORDER_KEY_MAX_LENGTH).toBe(maxLen);
    // The oversized entry is dropped entirely, NOT truncated to a 50-char prefix.
    // If the guard truncated instead of dropping, the array would be
    // ["PROJ-1", "X".repeat(50)] with length 2 — assert both the exact
    // array and the absence of a truncated variant to distinguish the two behaviors.
    expect(mod.viewState.jiraCustomOrder).toEqual(["PROJ-1"]);
    expect(mod.viewState.jiraCustomOrder).not.toContain("X".repeat(maxLen));
  });

  it("deletes a non-array (string) jiraCustomOrder value so ViewStateSchema's default applies", async () => {
    localStorageMock.setItem(VIEW_KEY, JSON.stringify({
      jiraCustomOrder: "not-an-array",
    }));

    vi.resetModules();
    const mod = await import("../../src/app/stores/view");

    expect(mod.viewState.jiraCustomOrder).toEqual([]);
  });

  it("deletes a non-array (number) jiraCustomOrder value so ViewStateSchema's default applies", async () => {
    localStorageMock.setItem(VIEW_KEY, JSON.stringify({
      jiraCustomOrder: 42,
    }));

    vi.resetModules();
    const mod = await import("../../src/app/stores/view");

    expect(mod.viewState.jiraCustomOrder).toEqual([]);
  });

  it("defaults jiraCustomOrder to [] when the key is missing from the raw blob", async () => {
    localStorageMock.setItem(VIEW_KEY, JSON.stringify({
      lastActiveTab: "jiraAssigned",
    }));

    vi.resetModules();
    const mod = await import("../../src/app/stores/view");

    expect(mod.viewState.jiraCustomOrder).toEqual([]);
    expect(mod.viewState.lastActiveTab).toBe("jiraAssigned");
  });
});
