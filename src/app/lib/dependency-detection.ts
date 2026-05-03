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

export const DEP_TOOL_LABEL_NAMES = new Set([
  "dependencies",
  "renovate",
]);

export type DepStatus = "mergeable" | "needs-action" | "stale" | "pending-rebase";

export const ALL_DEP_STATUSES: readonly DepStatus[] = [
  "mergeable",
  "pending-rebase",
  "needs-action",
  "stale",
];

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

export interface VersionInfo {
  packageName?: string;
  from?: string;
  to?: string;
  updateType?: "major" | "minor" | "patch";
}

export function extractVersionInfo(title: string): VersionInfo | null {
  const cleaned = title.replace(/\s*\[[\w\s]+\]\s*$/, "").trim();

  if (/pin dependencies/i.test(cleaned)) return null;
  if (/lock file maintenance/i.test(cleaned)) return null;

  // Strip conventional commit prefix: chore(deps): / fix(deps-dev): / build(deps):
  let body = cleaned;
  const ccPrefix = /^(?:chore|fix|build)\(deps[^)]*\):\s*/i.exec(body);
  if (ccPrefix) body = body.slice(ccPrefix[0].length);

  // "Bump X from A to B" or "Bump X from A to B in /dir"
  const bumpMatch = /^Bump\s+(.+?)\s+from\s+([\w.\-+]+)\s+to\s+([\w.\-+]+)/i.exec(body);
  if (bumpMatch) {
    return { packageName: bumpMatch[1]!, from: bumpMatch[2]!, to: bumpMatch[3]!, updateType: semverUpdateType(bumpMatch[2]!, bumpMatch[3]!) ?? undefined };
  }

  // "update all major/non-major dependencies"
  if (/update all major/i.test(body)) return { updateType: "major" };
  if (/update all non-major/i.test(body)) return { updateType: "minor" };

  // "Update dependency X to vY"
  const depMatch = /^Update\s+dependency\s+(.+?)\s+to\s+(v?[\w.\-+]+)/i.exec(body);
  if (depMatch && /^v?\d/.test(depMatch[2]!)) {
    return { packageName: depMatch[1]!, to: depMatch[2]! };
  }

  // "Update X action to vY"
  const actionMatch = /^Update\s+(.+?)\s+action\s+to\s+(v?[\w.\-+]+)/i.exec(body);
  if (actionMatch && /^v?\d/.test(actionMatch[2]!)) {
    return { packageName: actionMatch[1]!, to: actionMatch[2]! };
  }

  // Generic "from A to B" anywhere
  const genericMatch = /\bfrom\s+([\w.\-+]+)\s+to\s+([\w.\-+]+)/i.exec(body);
  if (genericMatch) {
    return { from: genericMatch[1]!, to: genericMatch[2]!, updateType: semverUpdateType(genericMatch[1]!, genericMatch[2]!) ?? undefined };
  }

  return null;
}

export function isRebasing(pr: PullRequest, rebaseLabel: string): boolean {
  const target = rebaseLabel.toLowerCase();
  // SEC-003: plain string equality, never used in regex constructor
  return pr.labels.some((l) => l.name.toLowerCase() === target);
}

export const STALE_THRESHOLD_DEFAULT_DAYS = 14;

export function classifyDepStatus(
  pr: PullRequest,
  rebaseLabel: string = "",
  staleThresholdDays: number = STALE_THRESHOLD_DEFAULT_DAYS
): DepStatus {
  // 1. Rebase label → pending-rebase
  if (rebaseLabel && isRebasing(pr, rebaseLabel)) {
    return "pending-rebase";
  }

  // 2. Enriched + CI green + not draft + not approved → mergeable
  if (
    pr.enriched !== false &&
    !pr.draft &&
    pr.checkStatus === "success" &&
    pr.reviewDecision !== "APPROVED"
  ) {
    return "mergeable";
  }

  // 3. Stale: not updated recently
  const ageMs = Date.now() - new Date(pr.updatedAt).getTime();
  if (ageMs > staleThresholdDays * 86_400_000) {
    return "stale";
  }

  // 4. Everything else → needs-action
  return "needs-action";
}
