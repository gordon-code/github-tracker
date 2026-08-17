import type { RepoRef } from "../../shared/types.js";

export function isRepoExcludedFromDependencies(
  repoFullName: string,
  excludedOrgs: readonly string[],
  excludedRepos: readonly Pick<RepoRef, "fullName">[]
): boolean {
  const lower = repoFullName.toLowerCase();
  if (excludedRepos.some((r) => r.fullName.toLowerCase() === lower)) return true;
  const org = lower.split("/")[0];
  return excludedOrgs.some((o) => o.toLowerCase() === org);
}
