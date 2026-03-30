import { describe, it, expect, beforeEach } from "vitest";
import {
  viewState,
  resetViewState,
  lockRepo,
  unlockRepo,
  moveLockedRepo,
  pruneLockedRepos,
  ViewStateSchema,
} from "../../src/app/stores/view";

describe("view lock store", () => {
  beforeEach(() => {
    resetViewState();
  });

  describe("lockRepo", () => {
    it("locks a repo", () => {
      lockRepo("issues", "org/repo-a");
      expect(viewState.lockedRepos.issues).toEqual(["org/repo-a"]);
    });

    it("appends to end", () => {
      lockRepo("issues", "org/repo-a");
      lockRepo("issues", "org/repo-b");
      expect(viewState.lockedRepos.issues).toEqual(["org/repo-a", "org/repo-b"]);
    });

    it("deduplicates", () => {
      lockRepo("issues", "org/repo-a");
      lockRepo("issues", "org/repo-a");
      expect(viewState.lockedRepos.issues).toEqual(["org/repo-a"]);
    });

    it("locks per-tab independently", () => {
      lockRepo("issues", "org/repo-a");
      lockRepo("pullRequests", "org/repo-b");
      expect(viewState.lockedRepos.issues).toEqual(["org/repo-a"]);
      expect(viewState.lockedRepos.pullRequests).toEqual(["org/repo-b"]);
      expect(viewState.lockedRepos.actions).toEqual([]);
    });
  });

  describe("unlockRepo", () => {
    it("removes from locked array", () => {
      lockRepo("issues", "org/repo-a");
      lockRepo("issues", "org/repo-b");
      unlockRepo("issues", "org/repo-a");
      expect(viewState.lockedRepos.issues).toEqual(["org/repo-b"]);
    });

    it("no-op if not locked", () => {
      unlockRepo("issues", "org/repo-a");
      expect(viewState.lockedRepos.issues).toEqual([]);
    });
  });

  describe("moveLockedRepo", () => {
    it("swaps with neighbor up", () => {
      lockRepo("issues", "org/repo-a");
      lockRepo("issues", "org/repo-b");
      lockRepo("issues", "org/repo-c");
      moveLockedRepo("issues", "org/repo-b", "up");
      expect(viewState.lockedRepos.issues).toEqual(["org/repo-b", "org/repo-a", "org/repo-c"]);
    });

    it("swaps with neighbor down", () => {
      lockRepo("issues", "org/repo-a");
      lockRepo("issues", "org/repo-b");
      lockRepo("issues", "org/repo-c");
      moveLockedRepo("issues", "org/repo-b", "down");
      expect(viewState.lockedRepos.issues).toEqual(["org/repo-a", "org/repo-c", "org/repo-b"]);
    });

    it("no-op at top boundary", () => {
      lockRepo("issues", "org/repo-a");
      lockRepo("issues", "org/repo-b");
      moveLockedRepo("issues", "org/repo-a", "up");
      expect(viewState.lockedRepos.issues).toEqual(["org/repo-a", "org/repo-b"]);
    });

    it("no-op at bottom boundary", () => {
      lockRepo("issues", "org/repo-a");
      lockRepo("issues", "org/repo-b");
      moveLockedRepo("issues", "org/repo-b", "down");
      expect(viewState.lockedRepos.issues).toEqual(["org/repo-a", "org/repo-b"]);
    });

    it("no-op if not locked", () => {
      lockRepo("issues", "org/repo-a");
      moveLockedRepo("issues", "org/repo-z", "up");
      expect(viewState.lockedRepos.issues).toEqual(["org/repo-a"]);
    });
  });

  describe("pruneLockedRepos", () => {
    it("removes stale names", () => {
      lockRepo("pullRequests", "org/repo-a");
      lockRepo("pullRequests", "org/repo-b");
      lockRepo("pullRequests", "org/repo-c");
      pruneLockedRepos("pullRequests", ["org/repo-a", "org/repo-c"]);
      expect(viewState.lockedRepos.pullRequests).toEqual(["org/repo-a", "org/repo-c"]);
    });

    it("preserves order of active repos", () => {
      lockRepo("pullRequests", "org/repo-c");
      lockRepo("pullRequests", "org/repo-a");
      lockRepo("pullRequests", "org/repo-b");
      pruneLockedRepos("pullRequests", ["org/repo-b", "org/repo-c"]);
      expect(viewState.lockedRepos.pullRequests).toEqual(["org/repo-c", "org/repo-b"]);
    });

    it("no-op when empty", () => {
      pruneLockedRepos("pullRequests", ["org/repo-a"]);
      expect(viewState.lockedRepos.pullRequests).toEqual([]);
    });

    it("no-op when all active", () => {
      lockRepo("actions", "org/repo-a");
      pruneLockedRepos("actions", ["org/repo-a", "org/repo-b"]);
      expect(viewState.lockedRepos.actions).toEqual(["org/repo-a"]);
    });
  });

  describe("schema migration", () => {
    it("defaults lockedRepos when absent", () => {
      const result = ViewStateSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.lockedRepos).toEqual({
          issues: [],
          pullRequests: [],
          actions: [],
        });
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
        expect(result.data.lockedRepos).toEqual({
          issues: [],
          pullRequests: [],
          actions: [],
        });
      }
    });
  });
});
