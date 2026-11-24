import * as z from "zod/mini";
import { ChangelogSchema, type ChangelogEntry } from "../../shared/changelog-schema";

const STRICT_SEMVER_RE = /^\d+\.\d+\.\d+$/;
const BASE_SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)/;

let cachedChangelogPromise: Promise<ChangelogEntry[]> | null = null;

export function isStrictSemver(version: string): boolean {
  return STRICT_SEMVER_RE.test(version);
}

function parseSemverTuple(version: string): [number, number, number] | null {
  const match = BASE_SEMVER_RE.exec(version);
  if (!match) return null;
  return [
    Number.parseInt(match[1], 10),
    Number.parseInt(match[2], 10),
    Number.parseInt(match[3], 10),
  ];
}

export function compareSemver(a: string, b: string): number {
  const tupleA = parseSemverTuple(a);
  const tupleB = parseSemverTuple(b);
  if (!tupleA || !tupleB) return 0;
  for (let i = 0; i < 3; i++) {
    if (tupleA[i] !== tupleB[i]) {
      return tupleA[i] > tupleB[i] ? 1 : -1;
    }
  }
  return 0;
}

export function loadChangelog(): Promise<ChangelogEntry[]> {
  if (!cachedChangelogPromise) {
    cachedChangelogPromise = import("virtual:changelog")
      .then((mod) => {
        const parsed = z.safeParse(ChangelogSchema, mod.default);
        return parsed.success ? parsed.data : [];
      })
      .catch(() => {
        cachedChangelogPromise = null;
        return [];
      });
  }
  return cachedChangelogPromise;
}

/**
 * Whether any release is newer than `lastSeen`. Without a usable last-seen version (never
 * opened, or not strict x.y.z) only the newest release counts as unseen, so a first-time user
 * sees a single unread indicator rather than the whole history.
 */
export function hasUnseen(
  entries: readonly ChangelogEntry[],
  lastSeen: string | null | undefined,
): boolean {
  if (entries.length === 0) return false;
  if (!lastSeen || !isStrictSemver(lastSeen)) return true;
  return entries.some((entry) => compareSemver(entry.version, lastSeen) > 0);
}

/** @internal Test-only helper to clear cached changelog promise */
export function _resetChangelogCacheForTests(): void {
  cachedChangelogPromise = null;
}
