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

describe("view lock store", () => {
  beforeEach(() => {
    resetViewState();
  });

  describe("lockRepo", () => {
    it("locks a repo", () => {
      lockRepo("org/repo-a");
      expect(viewState.lockedRepos).toEqual(["org/repo-a"]);
    });

    it("appends to end", () => {
      lockRepo("org/repo-a");
      lockRepo("org/repo-b");
      expect(viewState.lockedRepos).toEqual(["org/repo-a", "org/repo-b"]);
    });

    it("deduplicates", () => {
      lockRepo("org/repo-a");
      lockRepo("org/repo-a");
      expect(viewState.lockedRepos).toEqual(["org/repo-a"]);
    });

    it("accumulates locks from multiple lockRepo calls", () => {
      lockRepo("org/repo-a");
      lockRepo("org/repo-b");
      expect(viewState.lockedRepos).toEqual(["org/repo-a", "org/repo-b"]);
    });
  });

  describe("unlockRepo", () => {
    it("removes from locked array", () => {
      lockRepo("org/repo-a");
      lockRepo("org/repo-b");
      unlockRepo("org/repo-a");
      expect(viewState.lockedRepos).toEqual(["org/repo-b"]);
    });

    it("no-op if not locked", () => {
      unlockRepo("org/repo-a");
      expect(viewState.lockedRepos).toEqual([]);
    });
  });

  describe("moveLockedRepo", () => {
    it("swaps with neighbor up", () => {
      lockRepo("org/repo-a");
      lockRepo("org/repo-b");
      lockRepo("org/repo-c");
      moveLockedRepo("org/repo-b", "up");
      expect(viewState.lockedRepos).toEqual(["org/repo-b", "org/repo-a", "org/repo-c"]);
    });

    it("swaps with neighbor down", () => {
      lockRepo("org/repo-a");
      lockRepo("org/repo-b");
      lockRepo("org/repo-c");
      moveLockedRepo("org/repo-b", "down");
      expect(viewState.lockedRepos).toEqual(["org/repo-a", "org/repo-c", "org/repo-b"]);
    });

    it("no-op at top boundary", () => {
      lockRepo("org/repo-a");
      lockRepo("org/repo-b");
      moveLockedRepo("org/repo-a", "up");
      expect(viewState.lockedRepos).toEqual(["org/repo-a", "org/repo-b"]);
    });

    it("no-op at bottom boundary", () => {
      lockRepo("org/repo-a");
      lockRepo("org/repo-b");
      moveLockedRepo("org/repo-b", "down");
      expect(viewState.lockedRepos).toEqual(["org/repo-a", "org/repo-b"]);
    });

    it("no-op if not locked", () => {
      lockRepo("org/repo-a");
      moveLockedRepo("org/repo-z", "up");
      expect(viewState.lockedRepos).toEqual(["org/repo-a"]);
    });
  });

  describe("pruneLockedRepos", () => {
    it("removes stale names", () => {
      lockRepo("org/repo-a");
      lockRepo("org/repo-b");
      lockRepo("org/repo-c");
      pruneLockedRepos(["org/repo-a", "org/repo-c"]);
      expect(viewState.lockedRepos).toEqual(["org/repo-a", "org/repo-c"]);
    });

    it("preserves order of active repos", () => {
      lockRepo("org/repo-c");
      lockRepo("org/repo-a");
      lockRepo("org/repo-b");
      pruneLockedRepos(["org/repo-b", "org/repo-c"]);
      expect(viewState.lockedRepos).toEqual(["org/repo-c", "org/repo-b"]);
    });

    it("no-op when empty", () => {
      pruneLockedRepos(["org/repo-a"]);
      expect(viewState.lockedRepos).toEqual([]);
    });

    it("no-op when all active", () => {
      lockRepo("org/repo-a");
      pruneLockedRepos(["org/repo-a", "org/repo-b"]);
      expect(viewState.lockedRepos).toEqual(["org/repo-a"]);
    });
  });

  describe("schema migration", () => {
    it("defaults lockedRepos when absent", () => {
      const result = ViewStateSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.lockedRepos).toEqual([]);
      }
    });

    it("preserves existing data without lockedRepos", () => {
      const result = ViewStateSchema.safeParse({
        lastActiveTab: "issues",
        expandedRepos: { issues: {}, pullRequests: {}, actions: {} },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.lastActiveTab).toBe("issues");
        expect(result.data.lockedRepos).toEqual([]);
      }
    });
  });

  describe("migrateLockedRepos", () => {
    it("deduplicates with issues-first default", () => {
      expect(migrateLockedRepos({ issues: ["a"], pullRequests: ["b"], actions: ["a"] }))
        .toEqual(["a", "b"]);
    });

    it("uses lastActiveTab for precedence", () => {
      expect(migrateLockedRepos({ issues: ["a"], pullRequests: ["b"], actions: ["a"] }, "pullRequests"))
        .toEqual(["b", "a"]);
    });

    it("handles partial object", () => {
      expect(migrateLockedRepos({ issues: ["a"], pullRequests: ["b"] }))
        .toEqual(["a", "b"]);
    });

    it("returns array unchanged", () => {
      expect(migrateLockedRepos(["a", "b"])).toEqual(["a", "b"]);
    });

    it("returns undefined unchanged", () => {
      expect(migrateLockedRepos(undefined)).toBeUndefined();
    });

    it("uses actions tab for precedence when lastActiveTab is actions", () => {
      expect(migrateLockedRepos(
        { issues: ["a"], pullRequests: ["b"], actions: ["c", "a"] },
        "actions"
      )).toEqual(["c", "a", "b"]);
    });

    it("caps output at LOCKED_REPOS_CAP when merging exceeds limit", () => {
      // 20 unique per tab × 3 tabs = 60 unique entries, exceeds cap of 50
      const issues = Array.from({ length: 20 }, (_, i) => `org/issue-${i}`);
      const prs = Array.from({ length: 20 }, (_, i) => `org/pr-${i}`);
      const actions = Array.from({ length: 20 }, (_, i) => `org/action-${i}`);
      const result = migrateLockedRepos({ issues, pullRequests: prs, actions });
      expect(Array.isArray(result)).toBe(true);
      expect((result as string[]).length).toBe(50);
      // First 20 should be issues (default preferred), then first 20 PRs, then first 10 actions
      expect((result as string[])[0]).toBe("org/issue-0");
      expect((result as string[])[20]).toBe("org/pr-0");
      expect((result as string[])[40]).toBe("org/action-0");
      expect((result as string[])[49]).toBe("org/action-9");
    });
  });

  describe("lockRepo cap enforcement", () => {
    it("silently no-ops when at LOCKED_REPOS_CAP", () => {
      // Fill to cap
      for (let i = 0; i < 50; i++) {
        lockRepo(`org/repo-${i}`);
      }
      expect(viewState.lockedRepos.length).toBe(50);
      // Attempt to add one more
      lockRepo("org/repo-overflow");
      expect(viewState.lockedRepos.length).toBe(50);
      expect(viewState.lockedRepos).not.toContain("org/repo-overflow");
    });
  });
});
