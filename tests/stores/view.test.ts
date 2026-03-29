import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRoot } from "solid-js";
import {
  viewState,
  updateViewState,
  ignoreItem,
  unignoreItem,
  setSortPreference,
  setGlobalFilter,
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

const defaultState = ViewStateSchema.parse({});

function resetViewState() {
  updateViewState({
    lastActiveTab: defaultState.lastActiveTab,
    sortPreferences: {},
    ignoredItems: [],
    globalFilter: { org: null, repo: null },
    expandedRepos: { issues: {}, pullRequests: {}, actions: {} },
  });
}

beforeEach(() => {
  resetViewState();
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
  it("sets sort field and direction for a tab", () => {
    setSortPreference("issues", "updatedAt", "desc");
    expect(viewState.sortPreferences["issues"]).toEqual({ field: "updatedAt", direction: "desc" });
  });

  it("updates existing sort preference for a tab", () => {
    setSortPreference("issues", "updatedAt", "desc");
    setSortPreference("issues", "title", "asc");
    expect(viewState.sortPreferences["issues"]).toEqual({ field: "title", direction: "asc" });
  });

  it("sets preferences for multiple tabs independently", () => {
    setSortPreference("issues", "updatedAt", "desc");
    setSortPreference("pullRequests", "createdAt", "asc");
    expect(viewState.sortPreferences["issues"].field).toBe("updatedAt");
    expect(viewState.sortPreferences["pullRequests"].field).toBe("createdAt");
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
    expect(result.sortPreferences).toEqual({});
    expect(result.ignoredItems).toEqual([]);
    expect(result.globalFilter).toEqual({ org: null, repo: null });
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
