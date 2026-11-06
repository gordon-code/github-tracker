import { describe, it, expect, beforeEach } from "vitest";
import type { ChangelogEntry } from "../../src/shared/changelog-schema";
import {
  compareSemver,
  hasUnseen,
  isStrictSemver,
  loadChangelog,
  unseenEntries,
  _resetChangelogCacheForTest,
} from "../../src/app/lib/changelog";

const SAMPLE_ENTRIES: ChangelogEntry[] = [
  {
    version: "0.10.0",
    date: "2026-11-20",
    sections: [{ title: "Features", items: [{ text: "feat: ten" }] }],
  },
  {
    version: "0.2.0",
    date: "2026-11-10",
    sections: [{ title: "Features", items: [{ text: "feat: two" }] }],
  },
  {
    version: "0.1.1",
    date: "2026-11-05",
    sections: [{ title: "Bug Fixes", items: [{ text: "fix: one-one" }] }],
  },
  {
    version: "0.1.0",
    date: "2026-11-01",
    sections: [{ title: "Features", items: [{ text: "feat: initial" }] }],
  },
];

describe("lib/changelog", () => {
  beforeEach(() => {
    _resetChangelogCacheForTest();
  });

  it("validates strict x.y.z semver strings", () => {
    expect(isStrictSemver("0.1.0")).toBe(true);
    expect(isStrictSemver("10.20.30")).toBe(true);
    expect(isStrictSemver("0.1.0-beta.1")).toBe(false);
    expect(isStrictSemver("v0.1.0")).toBe(false);
    expect(isStrictSemver("0.1")).toBe(false);
    expect(isStrictSemver("")).toBe(false);
  });

  it("compares semver numerically across major, minor, and patch segments", () => {
    expect(compareSemver("0.10.0", "0.2.0")).toBe(1);
    expect(compareSemver("0.2.0", "0.10.0")).toBe(-1);
    expect(compareSemver("1.0.0", "0.99.99")).toBe(1);
    expect(compareSemver("0.1.2", "0.1.1")).toBe(1);
    expect(compareSemver("0.1.1", "0.1.1")).toBe(0);
    expect(compareSemver("invalid", "0.1.0")).toBe(0);
  });

  it("returns only the newest entry when lastSeen is null, undefined, or not strict x.y.z", () => {
    expect(unseenEntries(SAMPLE_ENTRIES, null)).toEqual([SAMPLE_ENTRIES[0]]);
    expect(unseenEntries(SAMPLE_ENTRIES, undefined)).toEqual([SAMPLE_ENTRIES[0]]);
    expect(unseenEntries(SAMPLE_ENTRIES, "")).toEqual([SAMPLE_ENTRIES[0]]);
    expect(unseenEntries(SAMPLE_ENTRIES, "0.1.1-test")).toEqual([SAMPLE_ENTRIES[0]]);
    expect(unseenEntries(SAMPLE_ENTRIES, "v0.1.1")).toEqual([SAMPLE_ENTRIES[0]]);
    expect(unseenEntries([], null)).toEqual([]);
  });

  it("returns all entries with semver > lastSeen and empty array when up to date", () => {
    expect(unseenEntries(SAMPLE_ENTRIES, "0.1.1")).toEqual([
      SAMPLE_ENTRIES[0],
      SAMPLE_ENTRIES[1],
    ]);
    expect(unseenEntries(SAMPLE_ENTRIES, "0.2.0")).toEqual([SAMPLE_ENTRIES[0]]);
    expect(unseenEntries(SAMPLE_ENTRIES, "0.10.0")).toEqual([]);
    expect(unseenEntries(SAMPLE_ENTRIES, "1.0.0")).toEqual([]);
  });

  it("computes hasUnseen boolean from unseenEntries", () => {
    expect(hasUnseen(SAMPLE_ENTRIES, null)).toBe(true);
    expect(hasUnseen(SAMPLE_ENTRIES, "0.2.0")).toBe(true);
    expect(hasUnseen(SAMPLE_ENTRIES, "0.10.0")).toBe(false);
    expect(hasUnseen([], null)).toBe(false);
  });

  it("loads and validates virtual:changelog and caches the result", async () => {
    const first = await loadChangelog();
    const second = await loadChangelog();
    expect(first).toHaveLength(2);
    expect(first[0].version).toBe("0.1.0");
    expect(second).toBe(first);
  });
});
