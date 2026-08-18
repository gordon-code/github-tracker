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

export const DEP_TITLE_PATTERN = /^(Bump |Update dependency |\[Snyk\]|(?:chore|fix|build)\(deps[^)]*\):\s*(?:update |pin |lock file |bump ))/i;

export const DEP_TOOL_LABEL_NAMES = new Set([
  "dependencies",
  "renovate",
]);

const KNOWN_DEP_BOT_BASE_NAMES = new Set(
  [...KNOWN_DEP_BOT_LOGINS].map((l) => l.replace(/\[bot\]$/, ""))
);

export function isKnownDepBot(login: string): boolean {
  const lower = login.toLowerCase();
  return KNOWN_DEP_BOT_LOGINS.has(lower) || KNOWN_DEP_BOT_BASE_NAMES.has(lower.replace(/\[bot\]$/, ""));
}

export function expandBotLogins(logins: string[]): Set<string> {
  const set = new Set<string>();
  for (const login of logins) {
    set.add(login);
    const base = login.replace(/\[bot\]$/, "");
    set.add(base);
    if (base === login) set.add(`${login}[bot]`);
  }
  return set;
}

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

const VERSION_SPECIFIER_RE = /^[><=!~^]+/;

export function stripVersionSpecifier(v: string): string {
  return v.replace(VERSION_SPECIFIER_RE, "");
}

function parseSemver(v: string): [number, number, number] | null {
  const cleaned = stripVersionSpecifier(v).replace(/^v/, "");
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
  updateType?: "major" | "minor" | "patch" | "pin" | "digest";
}

export function extractVersionInfo(title: string): VersionInfo | null {
  const cleaned = title.replace(/\s*\[[\w\s]+\]\s*$/, "").replace(/\s*-\s*abandoned$/i, "").trim();

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

  // "update X requirement from >=A to >=B" (Dependabot Python)
  const reqMatch = /^update\s+(.+?)\s+requirement\s+from\s+([^\s]+)\s+to\s+([^\s]+)/i.exec(body);
  if (reqMatch) {
    const from = stripVersionSpecifier(reqMatch[2]!);
    const to = stripVersionSpecifier(reqMatch[3]!);
    return { packageName: reqMatch[1]!, from, to, updateType: semverUpdateType(from, to) ?? undefined };
  }

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

  // "Update (rust) crate X to vY"
  const crateMatch = /^Update\s+(?:rust\s+)?crate\s+(.+?)\s+to\s+(v?[\w.\-+]+)/i.exec(body);
  if (crateMatch && /^v?\d/.test(crateMatch[2]!)) {
    return { packageName: crateMatch[1]!, to: crateMatch[2]! };
  }

  // "Update X Docker tag to vY"
  const dockerMatch = /^Update\s+(.+?)\s+docker\s+tag\s+to\s+(v?[\w.\-+]+)/i.exec(body);
  if (dockerMatch && /^v?\d/.test(dockerMatch[2]!)) {
    return { packageName: dockerMatch[1]!, to: dockerMatch[2]! };
  }

  // Generic "from A to B" anywhere
  const genericMatch = /\bfrom\s+([\w.\-+]+)\s+to\s+([\w.\-+]+)/i.exec(body);
  if (genericMatch) {
    return { from: genericMatch[1]!, to: genericMatch[2]!, updateType: semverUpdateType(genericMatch[1]!, genericMatch[2]!) ?? undefined };
  }

  // Generic "Update X to vY" (last resort, single-target version only)
  const singleTargetMatch = /^Update\s+(.+?)\s+to\s+(v?[\w.\-+]+)$/i.exec(body);
  if (singleTargetMatch && /^v?\d/.test(singleTargetMatch[2]!)) {
    return { packageName: singleTargetMatch[1]!, to: singleTargetMatch[2]! };
  }

  return null;
}

const VALID_UPDATE_TYPES = new Set(["major", "minor", "patch", "pin", "digest"]);
const VERSION_ARROW_RE = /`?([^`\s]+)`?\s*→\s*`?([^`\s]+)`?/;

function stripMarkdownLink(cell: string): string {
  const m = /^\[([^\]]+)\]/.exec(cell);
  return m ? m[1] : cell;
}

export function parseRenovateBody(body: string): VersionInfo | null {
  const lines = body.split("\n");

  let packageIdx = -1;
  let updateIdx = -1;
  let changeIdx = -1;
  let headerLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const cells = lines[i].split("|").map((c) => c.trim()).filter(Boolean);
    if (cells.length < 2) continue;
    const headers = cells.map((c) => stripMarkdownLink(c).toLowerCase());
    const pIdx = headers.indexOf("package");
    if (pIdx === -1) continue;
    packageIdx = pIdx;
    updateIdx = headers.indexOf("update");
    changeIdx = headers.indexOf("change");
    headerLine = i;
    break;
  }

  if (headerLine === -1) return null;

  for (let i = headerLine + 1; i < lines.length; i++) {
    const cells = lines[i].split("|").map((c) => c.trim()).filter(Boolean);
    if (cells.length < 2) continue;
    if (cells.every((c) => /^[-:]+$/.test(c))) continue;

    const result: VersionInfo = {};

    if (packageIdx >= 0 && packageIdx < cells.length) {
      result.packageName = stripMarkdownLink(cells[packageIdx]);
    }

    if (updateIdx >= 0 && updateIdx < cells.length) {
      const val = cells[updateIdx].toLowerCase();
      if (VALID_UPDATE_TYPES.has(val)) result.updateType = val as VersionInfo["updateType"];
    }

    if (changeIdx >= 0 && changeIdx < cells.length) {
      const m = VERSION_ARROW_RE.exec(cells[changeIdx]);
      if (m) { result.from = stripVersionSpecifier(m[1]); result.to = stripVersionSpecifier(m[2]); }
    }

    if (!result.from) {
      for (const cell of cells) {
        const m = VERSION_ARROW_RE.exec(cell);
        if (m) { result.from = stripVersionSpecifier(m[1]); result.to = stripVersionSpecifier(m[2]); break; }
      }
    }

    if (!result.updateType && result.from && result.to) {
      result.updateType = semverUpdateType(result.from, result.to) ?? undefined;
    }

    if (result.updateType || result.from) return result;
  }

  return null;
}

export function needsBodyFallback(pr: PullRequest): boolean {
  if (!pr.nodeId) return false;
  const vi = extractVersionInfo(pr.title);
  if (vi?.updateType) return false;
  if (/pin\s+dep/i.test(pr.title)) return false;
  if (/lock\s*file\s+maintenance/i.test(pr.title)) return false;
  for (const l of pr.labels) {
    const name = l.name.toLowerCase();
    if (name === "major" || name === "minor" || name === "patch") return false;
  }
  return true;
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
