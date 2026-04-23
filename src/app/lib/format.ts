// Re-exports from shared/format for backward compat with existing importers.
export { relativeTime, shortRelativeTime, labelTextColor, formatDuration, prSizeCategory, deriveInvolvementRoles, formatCount, formatStarCount } from "../../shared/format";

export function rateLimitCssClass(remaining: number, limit: number): string {
  if (remaining === 0) return "text-error";
  if (remaining < limit * 0.1) return "text-warning";
  return "";
}

/** Format scope counts as "N org(s), M repo(s)". When elideZero is true, omit zero-count segments. */
export function formatScopeSummary(orgCount: number, repoCount: number, elideZero = false): string {
  if (orgCount === 0 && repoCount === 0) return "All repos";
  if (elideZero) {
    const parts: string[] = [];
    if (orgCount > 0) parts.push(`${orgCount} org${orgCount !== 1 ? "s" : ""}`);
    if (repoCount > 0) parts.push(`${repoCount} repo${repoCount !== 1 ? "s" : ""}`);
    return parts.join(", ");
  }
  return `${orgCount} org${orgCount !== 1 ? "s" : ""}, ${repoCount} repo${repoCount !== 1 ? "s" : ""}`;
}
