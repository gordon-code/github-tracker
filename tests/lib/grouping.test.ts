import { describe, it, expect } from "vitest";
import { groupByRepo, computePageLayout, slicePageGroups, type RepoGroup } from "../../src/app/lib/grouping";

interface Item {
  repoFullName: string;
  id: number;
}

function makeItem(repo: string, id: number): Item {
  return { repoFullName: repo, id };
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
