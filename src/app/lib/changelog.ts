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
      .catch(() => []);
  }
  return cachedChangelogPromise;
}

export function unseenEntries(
  entries: readonly ChangelogEntry[],
  lastSeen: string | null | undefined,
): ChangelogEntry[] {
  if (entries.length === 0) return [];
  if (!lastSeen || !isStrictSemver(lastSeen)) {
    return [entries[0]];
  }
  return entries.filter((entry) => compareSemver(entry.version, lastSeen) > 0);
}

export function hasUnseen(
  entries: readonly ChangelogEntry[],
  lastSeen: string | null | undefined,
): boolean {
  return unseenEntries(entries, lastSeen).length > 0;
}

/** @internal Test-only helper to clear cached changelog promise */
export function _resetChangelogCacheForTest(): void {
  cachedChangelogPromise = null;
}
