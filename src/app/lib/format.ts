const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/**
 * Formats an ISO date string as a relative time string (e.g., "2 hours ago").
 * Uses Intl.RelativeTimeFormat for natural language output.
 */
export function relativeTime(isoString: string): string {
  const diffMs = Date.now() - Date.parse(isoString);
  if (isNaN(diffMs)) return "";
  if (diffMs < 0) return rtf.format(0, "second");
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 60) return rtf.format(-diffSec, "second");
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return rtf.format(-diffMin, "minute");
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return rtf.format(-diffHr, "hour");
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return rtf.format(-diffDay, "day");
  const diffMonth = Math.floor(diffDay / 30);
  if (diffMonth < 12) return rtf.format(-diffMonth, "month");
  return rtf.format(-Math.floor(diffMonth / 12), "year");
}

/**
 * Formats an ISO date string as a compact relative time string (e.g., "3h", "7d", "2mo").
 * Returns "now" for differences under 60 seconds or future timestamps (clock skew).
 * Returns "" for invalid input.
 */
export function shortRelativeTime(isoString: string): string {
  const diffMs = Date.now() - Date.parse(isoString);
  if (isNaN(diffMs)) return "";
  if (diffMs < 0) return "now";
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d`;
  const diffMonth = Math.floor(diffDay / 30);
  if (diffMonth < 12) return `${diffMonth}mo`;
  return `${Math.floor(diffMonth / 12)}y`;
}

/**
 * Computes text color (black or white) for a GitHub label hex color.
 * Based on perceived luminance.
 */
export function labelTextColor(hexColor: string): string {
  const r = parseInt(hexColor.slice(0, 2), 16);
  const g = parseInt(hexColor.slice(2, 4), 16);
  const b = parseInt(hexColor.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? "#000000" : "#ffffff";
}

/**
 * Formats a duration between two ISO timestamps as a human-readable string.
 * Example outputs: "2m 34s", "1h 12m", "45s"
 */
export function formatDuration(startedAt: string, completedAt: string | null): string {
  if (!startedAt) return "--";
  if (!completedAt) return "--";
  const diffMs = Date.parse(completedAt) - Date.parse(startedAt);
  if (isNaN(diffMs) || diffMs <= 0) return "--";
  const totalSec = Math.floor(diffMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0) parts.push(`${s}s`);
  if (parts.length === 0) return diffMs > 0 ? "<1s" : "--";
  return parts.join(" ");
}

/**
 * Categorizes a PR by size based on total lines changed.
 */
export function prSizeCategory(additions: number, deletions: number): "XS" | "S" | "M" | "L" | "XL" {
  const total = (additions || 0) + (deletions || 0);
  if (total < 10) return "XS";
  if (total < 100) return "S";
  if (total < 500) return "M";
  if (total < 1000) return "L";
  return "XL";
}

/**
 * Derives the roles a user has in a PR/issue (author, reviewer, assignee).
 * Uses case-insensitive comparison since GitHub logins are case-insensitive.
 */
export function deriveInvolvementRoles(
  userLogin: string,
  authorLogin: string,
  assigneeLogins: string[],
  reviewerLogins: string[],
  isUpstream?: boolean,
): ("author" | "reviewer" | "assignee" | "involved")[] {
  if (!userLogin) return [];
  const login = userLogin.toLowerCase();
  const roles: ("author" | "reviewer" | "assignee" | "involved")[] = [];
  if (authorLogin.toLowerCase() === login) roles.push("author");
  if (reviewerLogins.some((r) => r.toLowerCase() === login)) roles.push("reviewer");
  if (assigneeLogins.some((a) => a.toLowerCase() === login)) roles.push("assignee");
  if (roles.length === 0 && isUpstream) roles.push("involved");
  return roles;
}

/**
 * Formats a number in compact form (e.g., 1500 → "1.5k").
 */
export function formatCount(n: number): string {
  if (n >= 1000) {
    const k = n / 1000;
    return k % 1 === 0 ? `${k}k` : `${parseFloat(k.toFixed(1))}k`;
  }
  return String(n);
}
