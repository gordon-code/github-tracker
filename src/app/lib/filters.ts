import type { Issue, PullRequest, WorkflowRun } from "../../shared/types";

export interface ItemFilterOpts {
  ignoredIds: Set<number>;
  hideDepDashboard?: boolean;
  showPrRuns?: boolean;
  // null = bypass globalFilter (custom tabs have their own scope)
  globalFilter?: { org: string | null; repo: string | null } | null;
}

export function isIssueVisible(issue: Issue, opts: ItemFilterOpts): boolean {
  if (opts.ignoredIds.has(issue.id)) return false;
  if (opts.hideDepDashboard && issue.title === "Dependency Dashboard") return false;
  if (opts.globalFilter) {
    const { org, repo } = opts.globalFilter;
    if (repo && issue.repoFullName !== repo) return false;
    if (org && !issue.repoFullName.startsWith(org + "/")) return false;
  }
  return true;
}

export function isPrVisible(pr: PullRequest, opts: ItemFilterOpts): boolean {
  if (opts.ignoredIds.has(pr.id)) return false;
  if (opts.globalFilter) {
    const { org, repo } = opts.globalFilter;
    if (repo && pr.repoFullName !== repo) return false;
    if (org && !pr.repoFullName.startsWith(org + "/")) return false;
  }
  return true;
}

export function isRunVisible(run: WorkflowRun, opts: ItemFilterOpts): boolean {
  if (opts.ignoredIds.has(run.id)) return false;
  if (opts.showPrRuns === false && run.isPrRun) return false;
  if (opts.globalFilter) {
    const { org, repo } = opts.globalFilter;
    if (repo && run.repoFullName !== repo) return false;
    if (org && !run.repoFullName.startsWith(org + "/")) return false;
  }
  return true;
}
