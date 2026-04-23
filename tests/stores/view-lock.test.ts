import { describe, it, expect, beforeEach } from "vitest";
import {
  viewState,
  resetViewState,
  lockRepo,
  unlockRepo,
  moveLockedRepo,
  pruneLockedRepos,
  migrateLockedRepos,
  ViewStateSchema,
} from "../../src/app/stores/view";

describe("view lock store (per-tab)", () => {
  beforeEach(() => {
    resetViewState();
  });

  describe("lockRepo", () => {
    it("locks a repo in the given tab", () => {
      lockRepo("issues", "org/repo-a");
      expect(viewState.lockedRepos["issues"]).toEqual(["org/repo-a"]);
    });

    it("appends to end within the same tab", () => {
      lockRepo("issues", "org/repo-a");
      lockRepo("issues", "org/repo-b");
      expect(viewState.lockedRepos["issues"]).toEqual(["org/repo-a", "org/repo-b"]);
    });

    it("deduplicates within the same tab", () => {
      lockRepo("issues", "org/repo-a");
      lockRepo("issues", "org/repo-a");
      expect(viewState.lockedRepos["issues"]).toEqual(["org/repo-a"]);
    });

    it("does not affect other tabs", () => {
      lockRepo("issues", "org/repo-a");
      expect(viewState.lockedRepos["pullRequests"]).toEqual([]);
      expect(viewState.lockedRepos["actions"]).toEqual([]);
    });

    it("locks independently in each tab", () => {
      lockRepo("issues", "org/repo-a");
      lockRepo("pullRequests", "org/repo-b");
      lockRepo("actions", "org/repo-c");
      expect(viewState.lockedRepos["issues"]).toEqual(["org/repo-a"]);
      expect(viewState.lockedRepos["pullRequests"]).toEqual(["org/repo-b"]);
      expect(viewState.lockedRepos["actions"]).toEqual(["org/repo-c"]);
    });

    it("same repo can be locked in multiple tabs independently", () => {
      lockRepo("issues", "org/shared");
      lockRepo("pullRequests", "org/shared");
      expect(viewState.lockedRepos["issues"]).toContain("org/shared");
      expect(viewState.lockedRepos["pullRequests"]).toContain("org/shared");
    });

    it("creates the tab key if absent (custom tab)", () => {
      lockRepo("custom-tab-1", "org/repo-a");
      expect(viewState.lockedRepos["custom-tab-1"]).toEqual(["org/repo-a"]);
    });

    it("silently no-ops when at LOCKED_REPOS_CAP for that tab", () => {
      for (let i = 0; i < 50; i++) {
        lockRepo("issues", `org/repo-${i}`);
      }
      expect(viewState.lockedRepos["issues"].length).toBe(50);
      lockRepo("issues", "org/repo-overflow");
      expect(viewState.lockedRepos["issues"].length).toBe(50);
      expect(viewState.lockedRepos["issues"]).not.toContain("org/repo-overflow");
    });

    it("cap is per-tab — reaching cap in one tab does not block another", () => {
      for (let i = 0; i < 50; i++) {
        lockRepo("issues", `org/repo-${i}`);
      }
      lockRepo("pullRequests", "org/repo-a");
      expect(viewState.lockedRepos["pullRequests"]).toEqual(["org/repo-a"]);
    });
  });

  describe("unlockRepo", () => {
    it("removes from locked array for the given tab", () => {
      lockRepo("issues", "org/repo-a");
      lockRepo("issues", "org/repo-b");
      unlockRepo("issues", "org/repo-a");
      expect(viewState.lockedRepos["issues"]).toEqual(["org/repo-b"]);
    });

    it("no-op if not locked in that tab", () => {
      unlockRepo("issues", "org/repo-a");
      expect(viewState.lockedRepos["issues"]).toEqual([]);
    });

    it("no-op if tab key is absent", () => {
      expect(() => unlockRepo("nonexistent-tab", "org/repo-a")).not.toThrow();
    });

    it("does not affect other tabs", () => {
      lockRepo("issues", "org/repo-a");
      lockRepo("pullRequests", "org/repo-a");
      unlockRepo("issues", "org/repo-a");
      expect(viewState.lockedRepos["issues"]).toEqual([]);
      expect(viewState.lockedRepos["pullRequests"]).toEqual(["org/repo-a"]);
    });
  });

  describe("moveLockedRepo", () => {
    it("swaps with neighbor up within the given tab", () => {
      lockRepo("issues", "org/repo-a");
      lockRepo("issues", "org/repo-b");
      lockRepo("issues", "org/repo-c");
      moveLockedRepo("issues", "org/repo-b", "up");
      expect(viewState.lockedRepos["issues"]).toEqual(["org/repo-b", "org/repo-a", "org/repo-c"]);
    });

    it("swaps with neighbor down within the given tab", () => {
      lockRepo("issues", "org/repo-a");
      lockRepo("issues", "org/repo-b");
      lockRepo("issues", "org/repo-c");
      moveLockedRepo("issues", "org/repo-b", "down");
      expect(viewState.lockedRepos["issues"]).toEqual(["org/repo-a", "org/repo-c", "org/repo-b"]);
    });

    it("no-op at top boundary", () => {
      lockRepo("issues", "org/repo-a");
      lockRepo("issues", "org/repo-b");
      moveLockedRepo("issues", "org/repo-a", "up");
      expect(viewState.lockedRepos["issues"]).toEqual(["org/repo-a", "org/repo-b"]);
    });

    it("no-op at bottom boundary", () => {
      lockRepo("issues", "org/repo-a");
      lockRepo("issues", "org/repo-b");
      moveLockedRepo("issues", "org/repo-b", "down");
      expect(viewState.lockedRepos["issues"]).toEqual(["org/repo-a", "org/repo-b"]);
    });

    it("no-op if repo not locked in that tab", () => {
      lockRepo("issues", "org/repo-a");
      moveLockedRepo("issues", "org/repo-z", "up");
      expect(viewState.lockedRepos["issues"]).toEqual(["org/repo-a"]);
    });

    it("no-op if tab key is absent", () => {
      expect(() => moveLockedRepo("nonexistent-tab", "org/repo-a", "up")).not.toThrow();
    });

    it("does not affect other tabs", () => {
      lockRepo("issues", "org/a");
      lockRepo("issues", "org/b");
      lockRepo("pullRequests", "org/a");
      lockRepo("pullRequests", "org/b");
      moveLockedRepo("issues", "org/b", "up");
      expect(viewState.lockedRepos["issues"]).toEqual(["org/b", "org/a"]);
      expect(viewState.lockedRepos["pullRequests"]).toEqual(["org/a", "org/b"]);
    });
  });

  describe("pruneLockedRepos", () => {
    it("removes stale names for the given tab", () => {
      lockRepo("issues", "org/repo-a");
      lockRepo("issues", "org/repo-b");
      lockRepo("issues", "org/repo-c");
      pruneLockedRepos("issues", ["org/repo-a", "org/repo-c"]);
      expect(viewState.lockedRepos["issues"]).toEqual(["org/repo-a", "org/repo-c"]);
    });

    it("preserves lock order of active repos", () => {
      lockRepo("issues", "org/repo-c");
      lockRepo("issues", "org/repo-a");
      lockRepo("issues", "org/repo-b");
      pruneLockedRepos("issues", ["org/repo-b", "org/repo-c"]);
      expect(viewState.lockedRepos["issues"]).toEqual(["org/repo-c", "org/repo-b"]);
    });

    it("no-op when tab is empty", () => {
      pruneLockedRepos("issues", ["org/repo-a"]);
      expect(viewState.lockedRepos["issues"]).toEqual([]);
    });

    it("no-op when all active", () => {
      lockRepo("issues", "org/repo-a");
      pruneLockedRepos("issues", ["org/repo-a", "org/repo-b"]);
      expect(viewState.lockedRepos["issues"]).toEqual(["org/repo-a"]);
    });

    it("no-op if tab key is absent", () => {
      expect(() => pruneLockedRepos("nonexistent-tab", ["org/repo-a"])).not.toThrow();
    });

    it("does not affect other tabs", () => {
      lockRepo("issues", "org/repo-a");
      lockRepo("issues", "org/repo-b");
      lockRepo("pullRequests", "org/repo-a");
      pruneLockedRepos("issues", ["org/repo-a"]);
      expect(viewState.lockedRepos["issues"]).toEqual(["org/repo-a"]);
      expect(viewState.lockedRepos["pullRequests"]).toEqual(["org/repo-a"]);
    });

    it("prunes custom tab lock list correctly", () => {
      lockRepo("custom-tab-1", "org/repo-a");
      lockRepo("custom-tab-1", "org/repo-b");
      lockRepo("custom-tab-1", "org/repo-c");
      pruneLockedRepos("custom-tab-1", ["org/repo-a", "org/repo-c"]);
      expect(viewState.lockedRepos["custom-tab-1"]).toEqual(["org/repo-a", "org/repo-c"]);
    });
  });

  describe("schema — lockedRepos defaults", () => {
    it("defaults lockedRepos to per-tab record with empty arrays", () => {
      const result = ViewStateSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.lockedRepos).toEqual({ issues: [], pullRequests: [], actions: [] });
      }
    });

    it("accepts a per-tab record shape", () => {
      const result = ViewStateSchema.safeParse({
        lockedRepos: { issues: ["org/a"], pullRequests: [], actions: ["org/b"] },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.lockedRepos["issues"]).toEqual(["org/a"]);
        expect(result.data.lockedRepos["actions"]).toEqual(["org/b"]);
      }
    });

    it("preserves other state fields when lockedRepos is present", () => {
      const result = ViewStateSchema.safeParse({
        lastActiveTab: "pullRequests",
        lockedRepos: { issues: ["org/a"], pullRequests: [], actions: [] },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.lastActiveTab).toBe("pullRequests");
        expect(result.data.lockedRepos["issues"]).toEqual(["org/a"]);
      }
    });
  });

  describe("migrateLockedRepos", () => {
    it("converts flat array to per-tab record (same list in all 3 tabs)", () => {
      const result = migrateLockedRepos(["org/a", "org/b"]);
      expect(result).toEqual({
        issues: ["org/a", "org/b"],
        pullRequests: ["org/a", "org/b"],
        actions: ["org/a", "org/b"],
      });
    });

    it("passes through existing per-tab record unchanged", () => {
      const record = { issues: ["org/a"], pullRequests: ["org/b"], actions: [] };
      expect(migrateLockedRepos(record)).toEqual(record);
    });

    it("passes through partial object (missing built-in keys remain absent)", () => {
      const partial = { issues: ["org/a"] };
      const migrated = migrateLockedRepos(partial) as Record<string, string[]>;
      expect(migrated["issues"]).toEqual(["org/a"]);
      expect(migrated["pullRequests"]).toBeUndefined();
      expect(migrated["actions"]).toBeUndefined();
    });

    it("returns default record for undefined/null", () => {
      expect(migrateLockedRepos(undefined)).toEqual({ issues: [], pullRequests: [], actions: [] });
      expect(migrateLockedRepos(null)).toEqual({ issues: [], pullRequests: [], actions: [] });
    });

    it("caps flat array at LOCKED_REPOS_CAP (50) before copying", () => {
      const bigArr = Array.from({ length: 60 }, (_, i) => `org/repo-${i}`);
      const result = migrateLockedRepos(bigArr) as Record<string, string[]>;
      expect(Array.isArray(result["issues"])).toBe(true);
      expect(result["issues"].length).toBe(50);
      expect(result["pullRequests"].length).toBe(50);
      expect(result["actions"].length).toBe(50);
    });

    it("creates independent array copies per tab (no shared references)", () => {
      const result = migrateLockedRepos(["org/a"]) as Record<string, string[]>;
      expect(result["issues"]).not.toBe(result["pullRequests"]);
      expect(result["issues"]).not.toBe(result["actions"]);
      expect(result["pullRequests"]).not.toBe(result["actions"]);
    });

    it("returns default record for non-array, non-object inputs", () => {
      expect(migrateLockedRepos(42)).toEqual({ issues: [], pullRequests: [], actions: [] });
      expect(migrateLockedRepos("bad")).toEqual({ issues: [], pullRequests: [], actions: [] });
    });

    it("filters out non-string elements from a flat mixed-type array", () => {
      const result = migrateLockedRepos([42, "org/repo", null]) as Record<string, string[]>;
      expect(result["issues"]).toEqual(["org/repo"]);
      expect(result["pullRequests"]).toEqual(["org/repo"]);
      expect(result["actions"]).toEqual(["org/repo"]);
    });
  });

  describe("resetViewState — lockedRepos", () => {
    it("clears all per-tab locked arrays", () => {
      lockRepo("issues", "org/repo-a");
      lockRepo("pullRequests", "org/repo-b");
      lockRepo("actions", "org/repo-c");
      resetViewState();
      expect(viewState.lockedRepos["issues"]).toEqual([]);
      expect(viewState.lockedRepos["pullRequests"]).toEqual([]);
      expect(viewState.lockedRepos["actions"]).toEqual([]);
    });

    it("clears custom tab lock lists as well", () => {
      lockRepo("custom-tab-1", "org/repo-a");
      resetViewState();
      expect(viewState.lockedRepos["custom-tab-1"]).toBeUndefined();
    });
  });
});
