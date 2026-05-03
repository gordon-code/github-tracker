import type { PullRequest } from "../../shared/types.js";

export const KNOWN_DEP_BOT_LOGINS = new Set([
  "dependabot[bot]",
  "renovate[bot]",
  "snyk-bot",
  "depfu[bot]",
  "pyup-bot",
  "scala-steward",
  "mend-renovate-bot",
]);

export const DEP_BRANCH_PREFIXES = [
  "dependabot/",
  "renovate/",
  "snyk-fix-",
  "snyk-upgrade-",
  "pyup-update-",
];

export const DEP_TITLE_PATTERN = /^(Bump |Update dependency |chore\(deps|fix\(deps|build\(deps|\[Snyk\])/i;

export type DepStatus = "needs-review" | "waiting" | "stale";

export function isDependencyPr(pr: PullRequest, trackedBotLogins: Set<string>): boolean {
  const login = pr.userLogin.toLowerCase();

  if (KNOWN_DEP_BOT_LOGINS.has(login)) return true;
  if (trackedBotLogins.has(login)) return true;

  const branch = pr.headRef.toLowerCase();
  for (const prefix of DEP_BRANCH_PREFIXES) {
    if (branch.startsWith(prefix)) return true;
  }

  if (DEP_TITLE_PATTERN.test(pr.title)) return true;

  if (pr.labels.some((l) => l.name.toLowerCase() === "dependencies")) return true;

  return false;
}

function parseSemver(v: string): [number, number, number] | null {
  const cleaned = v.replace(/^v/, "");
  const parts = cleaned.split(".");
  if (parts.length < 2) return null;
  const nums = parts.slice(0, 3).map(Number);
  if (nums.some(isNaN)) return null;
  return [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0];
}

function semverUpdateType(from: string, to: string): "major" | "minor" | "patch" | null {
  const f = parseSemver(from);
  const t = parseSemver(to);
  if (!f || !t) return null;
  if (t[0] !== f[0]) return "major";
  if (t[1] !== f[1]) return "minor";
  if (t[2] !== f[2]) return "patch";
  return null;
}

export function extractVersionInfo(
  title: string
): { from?: string; to?: string; updateType?: "major" | "minor" | "patch" } | null {
  // Strip trailing annotations like " [security]"
  const cleaned = title.replace(/\s*\[[\w\s]+\]\s*$/, "").trim();

  // Maintenance titles — no version classification
  if (/pin dependencies/i.test(cleaned)) return null;
  if (/lock file maintenance/i.test(cleaned)) return null;

  // Dependabot "Bump X from A to B"
  const bumpMatch = /\bfrom\s+([\w.\-+]+)\s+to\s+([\w.\-+]+)/i.exec(cleaned);
  if (bumpMatch) {
    const from = bumpMatch[1]!;
    const to = bumpMatch[2]!;
    const updateType = semverUpdateType(from, to) ?? undefined;
    return { from, to, updateType };
  }

  // Renovate group: "update all major dependencies"
  if (/update all major/i.test(cleaned)) return { updateType: "major" };
  // Renovate group: "update all non-major dependencies"
  if (/update all non-major/i.test(cleaned)) return { updateType: "minor" };

  // Renovate single-dep: "update dependency X to vY" or "update X action to vY"
  const renovateMatch = /\bupdate\b.+\bto\s+(v?[\w.\-+]+)/i.exec(cleaned);
  if (renovateMatch) {
    const to = renovateMatch[1]!;
    // Only treat as version if it looks like a version (starts with digit or v+digit)
    if (/^v?\d/.test(to)) return { to };
  }

  return null;
}

export function isRebasing(pr: PullRequest, rebaseLabel: string): boolean {
  const target = rebaseLabel.toLowerCase();
  // SEC-003: plain string equality, never used in regex constructor
  return pr.labels.some((l) => l.name.toLowerCase() === target);
}

const STALE_THRESHOLD_DEFAULT_DAYS = 14;

export function classifyDepStatus(
  pr: PullRequest,
  _rebaseLabel: string,
  staleThresholdDays: number = STALE_THRESHOLD_DEFAULT_DAYS
): DepStatus {
  // needs-review: enriched, not draft, CI passing, not yet approved
  if (
    pr.enriched !== false &&
    !pr.draft &&
    pr.checkStatus === "success" &&
    pr.reviewDecision !== "APPROVED"
  ) {
    return "needs-review";
  }

  // stale: not updated recently (even drafts/CI-pending get stale)
  const ageMs = Date.now() - new Date(pr.updatedAt).getTime();
  if (ageMs > staleThresholdDays * 86_400_000) {
    return "stale";
  }

  // waiting: CI pending, draft, rebasing, unenriched, approved-but-not-merged
  return "waiting";
}
