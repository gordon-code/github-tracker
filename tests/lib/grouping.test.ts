import { describe, it, expect } from "vitest";
import { groupByRepo, computePageLayout, slicePageGroups, isUserInvolved, ensureLockedRepoGroups, type RepoGroup } from "../../src/app/lib/grouping";

interface Item {
  repoFullName: string;
  id: number;
  starCount?: number;
}

function makeItem(repo: string, id: number, starCount?: number): Item {
  const item: Item = { repoFullName: repo, id };
  if (starCount !== undefined) item.starCount = starCount;
  return item;
}

function makeGroup(repo: string, count: number): RepoGroup<Item> {
  return {
    repoFullName: repo,
    items: Array.from({ length: count }, (_, i) => makeItem(repo, i)),
  };
}

describe("groupByRepo", () => {
  it("groups items by repoFullName preserving insertion order", () => {
    const items = [
      makeItem("org/a", 1),
      makeItem("org/b", 2),
      makeItem("org/a", 3),
    ];
    const groups = groupByRepo(items);
    expect(groups).toHaveLength(2);
    expect(groups[0].repoFullName).toBe("org/a");
    expect(groups[0].items).toHaveLength(2);
    expect(groups[1].repoFullName).toBe("org/b");
    expect(groups[1].items).toHaveLength(1);
  });

  it("returns empty array for empty input", () => {
    expect(groupByRepo([])).toEqual([]);
  });

  it("returns single group when all items share a repo", () => {
    const items = [makeItem("org/repo", 1), makeItem("org/repo", 2)];
    const groups = groupByRepo(items);
    expect(groups).toHaveLength(1);
    expect(groups[0].items).toHaveLength(2);
  });

  it("propagates starCount from first item in group", () => {
    const items = [makeItem("org/repo", 1, 42), makeItem("org/repo", 2, 42)];
    const groups = groupByRepo(items);
    expect(groups[0].starCount).toBe(42);
  });

  it("leaves starCount undefined when items have no starCount", () => {
    const items = [makeItem("org/repo", 1), makeItem("org/repo", 2)];
    const groups = groupByRepo(items);
    expect(groups[0].starCount).toBeUndefined();
  });
});

describe("isUserInvolved", () => {
  const base = { repoFullName: "org/repo", userLogin: "author", assigneeLogins: [] as string[] };
  const monitored = new Set(["org/monitored"]);

  it("returns true when surfacedBy is non-empty (main user)", () => {
    expect(isUserInvolved({ ...base, surfacedBy: ["me"] }, "me", monitored)).toBe(true);
  });

  it("returns true when surfacedBy contains only a tracked user (not the main user)", () => {
    expect(isUserInvolved({ ...base, surfacedBy: ["tracked-bot[bot]"] }, "me", monitored)).toBe(true);
  });

  it("returns true when surfacedBy contains multiple tracked users but not the main user", () => {
    expect(isUserInvolved({ ...base, surfacedBy: ["bot1[bot]", "bot2"] }, "me", monitored)).toBe(true);
  });

  it("returns true for monitored repo item with surfacedBy (tier 1 before tier 2)", () => {
    expect(isUserInvolved({ ...base, repoFullName: "org/monitored", surfacedBy: ["tracked-bot[bot]"] }, "me", monitored)).toBe(true);
  });

  it("returns true for non-monitored item with no surfacedBy (fetched via involves:{user})", () => {
    expect(isUserInvolved(base, "me", monitored)).toBe(true);
  });

  it("returns true for monitored repo item when user is author", () => {
    expect(isUserInvolved({ ...base, repoFullName: "org/monitored", userLogin: "me" }, "me", monitored)).toBe(true);
  });

  it("returns true for monitored repo item when user is assignee", () => {
    expect(isUserInvolved({ ...base, repoFullName: "org/monitored", assigneeLogins: ["me"] }, "me", monitored)).toBe(true);
  });

  it("returns false for monitored repo item when user is not author/assignee", () => {
    expect(isUserInvolved({ ...base, repoFullName: "org/monitored" }, "me", monitored)).toBe(false);
  });

  it("returns true for monitored repo item when user is in reviewerLogins", () => {
    expect(isUserInvolved({ ...base, repoFullName: "org/monitored" }, "me", monitored, ["me"])).toBe(true);
  });

  it("does not check reviewerLogins when not provided", () => {
    expect(isUserInvolved({ ...base, repoFullName: "org/monitored" }, "me", monitored)).toBe(false);
  });
});

describe("computePageLayout", () => {
  it("returns single page for empty groups", () => {
    const result = computePageLayout([], 10);
    expect(result).toEqual({ boundaries: [0], pageCount: 1 });
  });

  it("keeps all groups on one page when total items <= pageSize", () => {
    const groups = [makeGroup("org/a", 3), makeGroup("org/b", 4)];
    const result = computePageLayout(groups, 10);
    expect(result).toEqual({ boundaries: [0], pageCount: 1 });
  });

  it("splits groups across pages when total exceeds pageSize", () => {
    const groups = [makeGroup("org/a", 6), makeGroup("org/b", 6)];
    const result = computePageLayout(groups, 10);
    expect(result).toEqual({ boundaries: [0, 1], pageCount: 2 });
  });

  it("does not split a single oversized group", () => {
    const groups = [makeGroup("org/big", 20)];
    const result = computePageLayout(groups, 10);
    expect(result).toEqual({ boundaries: [0], pageCount: 1 });
  });

  it("keeps groups exactly at pageSize on one page", () => {
    const groups = [makeGroup("org/a", 5), makeGroup("org/b", 5)];
    const result = computePageLayout(groups, 10);
    expect(result).toEqual({ boundaries: [0], pageCount: 1 });
  });

  it("splits when adding next group exceeds pageSize", () => {
    const groups = [makeGroup("org/a", 5), makeGroup("org/b", 6)];
    const result = computePageLayout(groups, 10);
    expect(result).toEqual({ boundaries: [0, 1], pageCount: 2 });
  });

  it("handles three pages", () => {
    const groups = [
      makeGroup("org/a", 6),
      makeGroup("org/b", 6),
      makeGroup("org/c", 6),
    ];
    const result = computePageLayout(groups, 10);
    expect(result).toEqual({ boundaries: [0, 1, 2], pageCount: 3 });
  });

  it("packs multiple small groups onto one page", () => {
    const groups = [
      makeGroup("org/a", 2),
      makeGroup("org/b", 3),
      makeGroup("org/c", 4),
    ];
    const result = computePageLayout(groups, 10);
    expect(result).toEqual({ boundaries: [0], pageCount: 1 });
  });

  it("splits when small groups accumulate past pageSize", () => {
    const groups = [
      makeGroup("org/a", 4),
      makeGroup("org/b", 4),
      makeGroup("org/c", 4),
    ];
    const result = computePageLayout(groups, 10);
    expect(result).toEqual({ boundaries: [0, 2], pageCount: 2 });
  });
});

describe("slicePageGroups", () => {
  const groups = [
    makeGroup("org/a", 6),
    makeGroup("org/b", 6),
    makeGroup("org/c", 6),
  ];
  const boundaries = [0, 1, 2];
  const pageCount = 3;

  it("returns first page groups", () => {
    const result = slicePageGroups(groups, boundaries, pageCount, 0);
    expect(result).toHaveLength(1);
    expect(result[0].repoFullName).toBe("org/a");
  });

  it("returns middle page groups", () => {
    const result = slicePageGroups(groups, boundaries, pageCount, 1);
    expect(result).toHaveLength(1);
    expect(result[0].repoFullName).toBe("org/b");
  });

  it("returns last page groups", () => {
    const result = slicePageGroups(groups, boundaries, pageCount, 2);
    expect(result).toHaveLength(1);
    expect(result[0].repoFullName).toBe("org/c");
  });

  it("clamps page below zero", () => {
    const result = slicePageGroups(groups, boundaries, pageCount, -1);
    expect(result).toHaveLength(1);
    expect(result[0].repoFullName).toBe("org/a");
  });

  it("clamps page above max", () => {
    const result = slicePageGroups(groups, boundaries, pageCount, 99);
    expect(result).toHaveLength(1);
    expect(result[0].repoFullName).toBe("org/c");
  });

  it("returns all groups when single page", () => {
    const singleBoundaries = [0];
    const result = slicePageGroups(groups, singleBoundaries, 1, 0);
    expect(result).toHaveLength(3);
  });

  it("returns multiple groups packed on one page", () => {
    // boundaries [0, 2] means page 0 has groups 0-1, page 1 has group 2
    const result = slicePageGroups(groups, [0, 2], 2, 0);
    expect(result).toHaveLength(2);
    expect(result[0].repoFullName).toBe("org/a");
    expect(result[1].repoFullName).toBe("org/b");
  });
});

describe("ensureLockedRepoGroups", () => {
  const emptyFactory = (name: string): RepoGroup<Item> => ({
    repoFullName: name,
    items: [],
  });

  it("returns groups unchanged when all locked repos are present", () => {
    const groups = [makeGroup("org/a", 3), makeGroup("org/b", 2)];
    const result = ensureLockedRepoGroups(groups, ["org/a", "org/b"], emptyFactory);
    expect(result).toBe(groups); // same reference — no copy
  });

  it("injects empty stubs for missing locked repos", () => {
    const groups = [makeGroup("org/a", 3)];
    const result = ensureLockedRepoGroups(groups, ["org/a", "org/b", "org/c"], emptyFactory);
    expect(result).toHaveLength(3);
    expect(result[0].repoFullName).toBe("org/a");
    expect(result[0].items).toHaveLength(3);
    expect(result[1].repoFullName).toBe("org/b");
    expect(result[1].items).toHaveLength(0);
    expect(result[2].repoFullName).toBe("org/c");
    expect(result[2].items).toHaveLength(0);
  });

  it("preserves existing groups in original order with stubs appended", () => {
    const groups = [makeGroup("org/x", 1), makeGroup("org/y", 2)];
    const result = ensureLockedRepoGroups(groups, ["org/missing"], emptyFactory);
    expect(result).toHaveLength(3);
    expect(result[0].repoFullName).toBe("org/x");
    expect(result[1].repoFullName).toBe("org/y");
    expect(result[2].repoFullName).toBe("org/missing");
  });

  it("no-op when lockedOrder is empty", () => {
    const groups = [makeGroup("org/a", 3)];
    const result = ensureLockedRepoGroups(groups, [], emptyFactory);
    expect(result).toBe(groups);
  });

  it("no-op when groups is empty and lockedOrder is empty", () => {
    const result = ensureLockedRepoGroups([], [], emptyFactory);
    expect(result).toEqual([]);
  });

  it("injects all locked repos when groups is empty", () => {
    const result = ensureLockedRepoGroups([], ["org/a", "org/b"], emptyFactory);
    expect(result).toHaveLength(2);
    expect(result[0].repoFullName).toBe("org/a");
    expect(result[0].items).toHaveLength(0);
    expect(result[1].repoFullName).toBe("org/b");
    expect(result[1].items).toHaveLength(0);
  });

  it("works with custom factory for different group shapes", () => {
    interface WfGroup { repoFullName: string; workflows: string[] }
    const wfFactory = (name: string): WfGroup => ({ repoFullName: name, workflows: [] });
    const groups: WfGroup[] = [{ repoFullName: "org/a", workflows: ["ci"] }];
    const result = ensureLockedRepoGroups(groups, ["org/a", "org/b"], wfFactory);
    expect(result).toHaveLength(2);
    expect(result[1].workflows).toEqual([]);
  });
});
