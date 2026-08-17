import { describe, it, expect } from "vitest";
import { isRepoExcludedFromDependencies } from "../../src/app/lib/dependency-exclusion.js";

describe("isRepoExcludedFromDependencies", () => {
  it("returns true when the repo is in excludedRepos (exact fullName match)", () => {
    const excludedRepos = [{ fullName: "owner/repo" }];
    expect(isRepoExcludedFromDependencies("owner/repo", [], excludedRepos)).toBe(true);
  });

  it("returns true when the repo's owner is in excludedOrgs", () => {
    expect(isRepoExcludedFromDependencies("owner/repo", ["owner"], [])).toBe(true);
  });

  it("returns false when neither list contains the repo", () => {
    const excludedRepos = [{ fullName: "other-owner/other-repo" }];
    expect(isRepoExcludedFromDependencies("owner/repo", ["other-org"], excludedRepos)).toBe(false);
  });

  it("matches org exclusion case-insensitively", () => {
    expect(isRepoExcludedFromDependencies("some-org/repo", ["Some-Org"], [])).toBe(true);
  });

  it("matches repo exclusion case-insensitively", () => {
    const excludedRepos = [{ fullName: "Some-Org/Repo" }];
    expect(isRepoExcludedFromDependencies("some-org/repo", [], excludedRepos)).toBe(true);
  });

  it("returns false when excludedOrgs and excludedRepos are both empty", () => {
    expect(isRepoExcludedFromDependencies("owner/repo", [], [])).toBe(false);
  });
});
