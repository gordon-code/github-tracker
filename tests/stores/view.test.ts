import { describe, it, expect, beforeEach, vi } from "vitest";
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
} from "../../src/app/stores/view";
import type { IgnoredItem } from "../../src/app/stores/view";

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
    id: "issue-1",
    type: "issue",
    repo: "owner/repo",
    title: "Bug fix",
    ignoredAt: 1711000000000,
  };
  const item2: IgnoredItem = {
    id: "pr-42",
    type: "pullRequest",
    repo: "owner/repo",
    title: "Add feature",
    ignoredAt: 1711000001000,
  };

  it("ignoreItem adds an item to ignoredItems", () => {
    ignoreItem(item1);
    expect(viewState.ignoredItems).toHaveLength(1);
    expect(viewState.ignoredItems[0].id).toBe("issue-1");
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
    unignoreItem("issue-1");
    expect(viewState.ignoredItems).toHaveLength(1);
    expect(viewState.ignoredItems[0].id).toBe("pr-42");
  });

  it("unignoreItem is a no-op for an unknown id", () => {
    ignoreItem(item1);
    unignoreItem("does-not-exist");
    expect(viewState.ignoredItems).toHaveLength(1);
  });

  it("evicts oldest item when at 500 cap (FIFO)", () => {
    // Fill to 500
    for (let i = 0; i < 500; i++) {
      ignoreItem({ id: `item-${i}`, type: "issue", repo: "o/r", title: `T${i}`, ignoredAt: 1000 + i });
    }
    expect(viewState.ignoredItems).toHaveLength(500);

    // Adding 501st should evict item-0 (oldest)
    ignoreItem({ id: "item-new", type: "issue", repo: "o/r", title: "New", ignoredAt: 2000 });
    expect(viewState.ignoredItems).toHaveLength(500);
    expect(viewState.ignoredItems[0].id).toBe("item-1"); // item-0 evicted
    expect(viewState.ignoredItems[499].id).toBe("item-new");
  });
});

describe("pruneStaleIgnoredItems", () => {
  it("removes items older than 30 days", () => {
    const now = Date.now();
    const old = now - 31 * 24 * 60 * 60 * 1000;
    const recent = now - 1 * 24 * 60 * 60 * 1000;

    ignoreItem({ id: "old-1", type: "issue", repo: "o/r", title: "Old", ignoredAt: old });
    ignoreItem({ id: "recent-1", type: "pullRequest", repo: "o/r", title: "Recent", ignoredAt: recent });
    expect(viewState.ignoredItems).toHaveLength(2);

    pruneStaleIgnoredItems();
    expect(viewState.ignoredItems).toHaveLength(1);
    expect(viewState.ignoredItems[0].id).toBe("recent-1");
  });

  it("is a no-op when ignoredItems is empty", () => {
    pruneStaleIgnoredItems();
    expect(viewState.ignoredItems).toHaveLength(0);
  });

  it("keeps items exactly at the 30-day boundary", () => {
    const now = Date.now();
    const exactly30 = now - 30 * 24 * 60 * 60 * 1000 + 1000;

    ignoreItem({ id: "boundary", type: "issue", repo: "o/r", title: "Edge", ignoredAt: exactly30 });
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

  it("safeParse returns success=false for invalid data", () => {
    const result = ViewStateSchema.safeParse({ lastActiveTab: "invalid-tab-name" });
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
