import { describe, it, expect } from "vitest";
import { orderRepoGroups, detectReorderedRepos } from "../../src/app/lib/grouping";

describe("orderRepoGroups", () => {
  it("places locked repos first in locked order", () => {
    const groups = [
      { repoFullName: "org/c", items: [] },
      { repoFullName: "org/a", items: [] },
      { repoFullName: "org/b", items: [] },
    ];
    const result = orderRepoGroups(groups, ["org/b", "org/a"]);
    expect(result.map(g => g.repoFullName)).toEqual(["org/b", "org/a", "org/c"]);
  });

  it("returns original order with empty locked array", () => {
    const groups = [
      { repoFullName: "org/c", items: [] },
      { repoFullName: "org/a", items: [] },
    ];
    const result = orderRepoGroups(groups, []);
    expect(result.map(g => g.repoFullName)).toEqual(["org/c", "org/a"]);
  });

  it("ignores stale locked names not in groups", () => {
    const groups = [
      { repoFullName: "org/a", items: [] },
      { repoFullName: "org/b", items: [] },
    ];
    const result = orderRepoGroups(groups, ["org/z", "org/a"]);
    expect(result.map(g => g.repoFullName)).toEqual(["org/a", "org/b"]);
  });

  it("works with objects that have extra fields", () => {
    const groups = [
      { repoFullName: "org/a", workflows: [{ id: 1 }] },
      { repoFullName: "org/b", workflows: [] },
    ];
    const result = orderRepoGroups(groups, ["org/b"]);
    expect(result.map(g => g.repoFullName)).toEqual(["org/b", "org/a"]);
    expect(result[1]).toHaveProperty("workflows");
  });
});

describe("detectReorderedRepos", () => {
  it("detects moved repos", () => {
    const prev = ["org/a", "org/b", "org/c"];
    const curr = ["org/c", "org/a", "org/b"];
    const moved = detectReorderedRepos(prev, curr);
    expect(moved).toEqual(new Set(["org/a", "org/b", "org/c"]));
  });

  it("returns empty set when order unchanged", () => {
    const order = ["org/a", "org/b"];
    expect(detectReorderedRepos(order, order)).toEqual(new Set());
  });

  it("ignores new repos not in previous", () => {
    const prev = ["org/a"];
    const curr = ["org/a", "org/b"];
    expect(detectReorderedRepos(prev, curr)).toEqual(new Set());
  });

  it("does not flash remaining repos when a repo is removed", () => {
    const prev = ["org/a", "org/b", "org/c"];
    const curr = ["org/b", "org/c"];
    // org/a removed — org/b and org/c kept same relative order
    expect(detectReorderedRepos(prev, curr)).toEqual(new Set());
  });

  it("detects reorder even when a repo is simultaneously removed", () => {
    const prev = ["org/a", "org/b", "org/c"];
    const curr = ["org/c", "org/b"];
    // org/a removed, and org/b + org/c swapped relative order
    expect(detectReorderedRepos(prev, curr)).toEqual(new Set(["org/b", "org/c"]));
  });
});
