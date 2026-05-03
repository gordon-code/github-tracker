import type { Issue, PullRequest } from "../../shared/types.js";
import { KNOWN_DEP_BOT_LOGINS } from "./dependency-detection.js";

export interface AbandonedDependency {
  datasource: string;
  packageName: string;
  lastUpdated: string;
}

export interface DashboardIssueInfo {
  issueNumber: number;
  htmlUrl: string;
  repoFullName: string;
  abandonedDeps: AbandonedDependency[];
}

/** SEC-002: escapes ALL regex metacharacters. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Finds Renovate Dashboard issues from the issue list.
 * Filters by title "Dependency Dashboard" (case-insensitive), bot author, open state,
 * and defined nodeId (cached pre-migration issues lack nodeId).
 */
export function findDashboardIssues(
  issues: Issue[],
  botLogins: Set<string>
): { issueNumber: number; nodeId: string; repoFullName: string; htmlUrl: string }[] {
  const allBotLogins = new Set([...KNOWN_DEP_BOT_LOGINS, ...botLogins]);
  return issues
    .filter((issue) => {
      if (issue.nodeId == null) return false;
      if (issue.state !== "OPEN") return false;
      if (issue.title.toLowerCase() !== "dependency dashboard") return false;
      if (!allBotLogins.has(issue.userLogin.toLowerCase())) return false;
      return true;
    })
    .map((issue) => ({
      issueNumber: issue.number,
      nodeId: issue.nodeId!,
      repoFullName: issue.repoFullName,
      htmlUrl: issue.htmlUrl,
    }));
}

/**
 * Parses the abandoned dependencies section from a Renovate Dashboard issue body.
 * Fault-tolerant: returns [] on any parse failure — never throws.
 */
export function parseAbandonedSection(body: string): AbandonedDependency[] {
  try {
    if (!body) return [];

    // Find the Abandoned section header (## or ###)
    const abandonedMatch = /^#{2,3}\s+Abandoned\b/im.exec(body);
    if (!abandonedMatch) return [];

    const sectionStart = abandonedMatch.index;
    // Find the next section header (same or higher level) to bound our search
    const afterSection = body.slice(sectionStart + abandonedMatch[0].length);
    const nextHeaderMatch = /^#{2,3}\s+/m.exec(afterSection);
    const sectionBody = nextHeaderMatch
      ? afterSection.slice(0, nextHeaderMatch.index)
      : afterSection;

    // Find the table — look for rows with pipe-separated values
    // Table format: | Datasource | Package | Last Updated |
    // Skip the header row and separator row, then parse data rows
    const tableRows = sectionBody
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("|") && l.endsWith("|"));

    if (tableRows.length < 3) return []; // need header + separator + at least one data row

    const deps: AbandonedDependency[] = [];
    // Skip header (index 0) and separator (index 1)
    for (let i = 2; i < tableRows.length; i++) {
      const row = tableRows[i]!;
      // Split on pipe, trim cells, drop leading/trailing empty from outer pipes
      const cells = row
        .split("|")
        .map((c) => c.trim())
        .filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);

      if (cells.length < 3) continue;
      const [datasource, packageName, lastUpdated] = cells as [string, string, string, ...string[]];
      if (!datasource || !packageName || !lastUpdated) continue;

      deps.push({ datasource, packageName, lastUpdated });
    }

    return deps;
  } catch {
    return [];
  }
}

/**
 * Checks if a dep PR's title references an abandoned package name.
 * Uses word-boundary regex with escaped package name (SEC-002).
 */
export function matchAbandonedToPr(
  pr: PullRequest,
  abandonedDeps: AbandonedDependency[]
): AbandonedDependency | null {
  for (const dep of abandonedDeps) {
    // SEC-002: escape package name before using in regex
    // Use (?:^|\W) and (?:\W|$) instead of \b to correctly handle scoped packages like @scope/pkg
    // \b fails when package name starts/ends with non-word chars (e.g. @, /)
    const escaped = escapeRegex(dep.packageName);
    const pattern = new RegExp("(?:^|\\W)" + escaped + "(?:\\W|$)", "i");
    if (pattern.test(pr.title)) return dep;
  }
  return null;
}
