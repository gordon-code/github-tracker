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
} from "../../src/app/stores/view";
import type { IgnoredItem, TrackedItem } from "../../src/app/stores/view";

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
  it("persists state changes to localStorage via createEffect", async () => {
    vi.useFakeTimers();
    let dispose!: () => void;
    createRoot((d) => {
      dispose = d;
      initViewPersistence();
      setGlobalFilter("testorg", "testrepo");
    });

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
    expect(result.hideDepDashboard).toBe(true);
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
    expect(result.expandedRepos).toEqual({ issues: {}, pullRequests: {}, actions: {} });
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

describe("hideDepDashboard", () => {
  beforeEach(() => resetViewState());

  it("defaults to true", () => {
    expect(viewState.hideDepDashboard).toBe(true);
  });

  it("can be toggled via updateViewState", () => {
    updateViewState({ hideDepDashboard: false });
    expect(viewState.hideDepDashboard).toBe(false);
    updateViewState({ hideDepDashboard: true });
    expect(viewState.hideDepDashboard).toBe(true);
  });

  it("is not affected by resetAllTabFilters", () => {
    updateViewState({ hideDepDashboard: false });
    resetAllTabFilters("issues");
    expect(viewState.hideDepDashboard).toBe(false);
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

  it("is reset by resetViewState", () => {
    updateViewState({ hideDepDashboard: false });
    resetViewState();
    expect(viewState.hideDepDashboard).toBe(true);
  });
});

describe("tracked items", () => {
  const item1: TrackedItem = {
    id: 1001,
    number: 101,
    type: "issue",
    repoFullName: "owner/repo",
    title: "Bug fix",
    addedAt: 1711000000000,
  };
  const item2: TrackedItem = {
    id: 2002,
    number: 202,
    type: "pullRequest",
    repoFullName: "owner/repo",
    title: "Add feature",
    addedAt: 1711000001000,
  };
  const item3: TrackedItem = {
    id: 3003,
    number: 303,
    type: "issue",
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
        trackItem({ id: i, number: i, type: "issue", repoFullName: "o/r", title: `T${i}`, addedAt: 1000 + i });
      }
      expect(viewState.trackedItems).toHaveLength(200);

      // Adding 201st should evict item with id:0 (oldest)
      trackItem({ id: 9999, number: 9999, type: "issue", repoFullName: "o/r", title: "New", addedAt: 2000 });
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
});
