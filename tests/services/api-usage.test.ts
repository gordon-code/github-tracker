import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock auth so module-level onAuthCleared() doesn't fail ───────────────────

vi.mock("../../src/app/stores/auth", () => ({
  onAuthCleared: vi.fn(),
}));

vi.mock("../../src/app/lib/errors", () => ({
  pushNotification: vi.fn(),
}));

vi.mock("../../src/app/services/github", () => ({
  onApiRequest: vi.fn(),
}));

// ── localStorage mock ─────────────────────────────────────────────────────────

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
  };
})();

Object.defineProperty(globalThis, "localStorage", {
  value: localStorageMock,
  writable: true,
  configurable: true,
});

// api-usage.ts reads localStorage at module scope (initializes _usageData).
// Each describe block uses vi.resetModules() + dynamic import for clean state.
// Seed localStorage BEFORE dynamic import when testing load-from-storage behavior.

// ── Step 1: trackApiCall ──────────────────────────────────────────────────────

describe("trackApiCall — increment and record creation", () => {
  let mod: typeof import("../../src/app/services/api-usage");

  beforeEach(async () => {
    localStorageMock.clear();
    vi.resetModules();
    vi.useFakeTimers();
    mod = await import("../../src/app/services/api-usage");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("creates a new record for a new source/pool pair", () => {
    mod.trackApiCall("lightSearch", "graphql");
    const snapshot = mod.getUsageSnapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].source).toBe("lightSearch");
    expect(snapshot[0].pool).toBe("graphql");
    expect(snapshot[0].count).toBe(1);
  });

  it("increments count when same source/pool called again", () => {
    mod.trackApiCall("lightSearch", "graphql");
    mod.trackApiCall("lightSearch", "graphql");
    const snapshot = mod.getUsageSnapshot();
    expect(snapshot[0].count).toBe(2);
  });

  it("increments by custom count", () => {
    mod.trackApiCall("fetchOrgs", "core", 5);
    const snapshot = mod.getUsageSnapshot();
    expect(snapshot[0].count).toBe(5);
  });

  it("accumulates custom count on top of existing count", () => {
    mod.trackApiCall("fetchOrgs", "core", 2);
    mod.trackApiCall("fetchOrgs", "core", 3);
    const snapshot = mod.getUsageSnapshot();
    expect(snapshot[0].count).toBe(5);
  });

  it("updates lastCalledAt to current time on each call", () => {
    vi.setSystemTime(new Date("2026-01-01T10:00:00Z"));
    mod.trackApiCall("workflowRuns", "core");
    const before = mod.getUsageSnapshot()[0].lastCalledAt;

    vi.setSystemTime(new Date("2026-01-01T10:00:05Z"));
    mod.trackApiCall("workflowRuns", "core");
    const after = mod.getUsageSnapshot()[0].lastCalledAt;

    expect(after).toBeGreaterThan(before);
    expect(after).toBe(new Date("2026-01-01T10:00:05Z").getTime());
  });

  it("tracks separate records for different pool types", () => {
    mod.trackApiCall("notifications", "core");
    mod.trackApiCall("lightSearch", "graphql");
    const snapshot = mod.getUsageSnapshot();
    expect(snapshot).toHaveLength(2);
    expect(snapshot.map(r => r.pool)).toEqual(expect.arrayContaining(["core", "graphql"]));
  });

  it("returns empty array when no calls tracked", () => {
    expect(mod.getUsageSnapshot()).toHaveLength(0);
  });
});

// ── Step 1: getUsageSnapshot sorting ─────────────────────────────────────────

describe("getUsageSnapshot — sorting", () => {
  let mod: typeof import("../../src/app/services/api-usage");

  beforeEach(async () => {
    localStorageMock.clear();
    vi.resetModules();
    vi.useFakeTimers();
    mod = await import("../../src/app/services/api-usage");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns records sorted by count descending", () => {
    mod.trackApiCall("notifications", "core", 1);
    mod.trackApiCall("lightSearch", "graphql", 5);
    mod.trackApiCall("workflowRuns", "core", 3);
    const snapshot = mod.getUsageSnapshot();
    expect(snapshot[0].count).toBe(5);
    expect(snapshot[1].count).toBe(3);
    expect(snapshot[2].count).toBe(1);
  });

  it("tiebreaks by lastCalledAt descending when counts are equal", () => {
    vi.setSystemTime(new Date("2026-01-01T10:00:00Z"));
    mod.trackApiCall("notifications", "core", 2);

    vi.setSystemTime(new Date("2026-01-01T10:00:10Z"));
    mod.trackApiCall("lightSearch", "graphql", 2);

    const snapshot = mod.getUsageSnapshot();
    // lightSearch called more recently — should be first
    expect(snapshot[0].source).toBe("lightSearch");
    expect(snapshot[1].source).toBe("notifications");
  });
});

// ── Step 2: persistence ───────────────────────────────────────────────────────

describe("flushUsageData / loadUsageData", () => {
  let mod: typeof import("../../src/app/services/api-usage");

  beforeEach(async () => {
    localStorageMock.clear();
    vi.resetModules();
    vi.useFakeTimers();
    mod = await import("../../src/app/services/api-usage");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("flushUsageData writes to localStorage key github-tracker:api-usage", () => {
    mod.trackApiCall("lightSearch", "graphql");
    // Advance timer past 500ms debounce to trigger flush
    vi.advanceTimersByTime(600);
    const raw = localStorageMock.getItem("github-tracker:api-usage");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.records["lightSearch:graphql"]).toBeDefined();
    expect(parsed.records["lightSearch:graphql"].count).toBe(1);
  });

  it("loadUsageData returns defaults when localStorage is empty", async () => {
    const data = mod.loadUsageData();
    expect(data).toEqual({ records: {}, resetAt: null });
  });

  it("loadUsageData returns defaults when localStorage contains invalid JSON", async () => {
    localStorageMock.setItem("github-tracker:api-usage", "not-valid-json{{{");
    vi.resetModules();
    const freshMod = await import("../../src/app/services/api-usage");
    expect(freshMod.getUsageSnapshot()).toHaveLength(0);
  });

  it("calls pushNotification when localStorage.setItem throws (quota exceeded)", async () => {
    const { pushNotification } = await import("../../src/app/lib/errors");
    vi.spyOn(localStorageMock, "setItem").mockImplementationOnce(() => { throw new DOMException("QuotaExceededError"); });
    mod.trackApiCall("lightSearch", "graphql");
    vi.advanceTimersByTime(600); // fire debounced flush
    expect(vi.mocked(pushNotification)).toHaveBeenCalledWith(
      "localStorage:api-usage",
      expect.stringContaining("write failed"),
      "warning"
    );
  });

  it("loadUsageData restores state on module init from valid localStorage", async () => {
    const storedData = {
      records: {
        "hotPRStatus:graphql": { source: "hotPRStatus", pool: "graphql", count: 7, lastCalledAt: 1000 },
      },
      resetAt: null,
    };
    localStorageMock.setItem("github-tracker:api-usage", JSON.stringify(storedData));
    vi.resetModules();
    const freshMod = await import("../../src/app/services/api-usage");
    const snapshot = freshMod.getUsageSnapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].source).toBe("hotPRStatus");
    expect(snapshot[0].count).toBe(7);
  });
});

describe("resetUsageData", () => {
  let mod: typeof import("../../src/app/services/api-usage");

  beforeEach(async () => {
    localStorageMock.clear();
    vi.resetModules();
    vi.useFakeTimers();
    mod = await import("../../src/app/services/api-usage");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears records but preserves resetAt", () => {
    mod.trackApiCall("lightSearch", "graphql");
    mod.updateResetAt(9999999);
    mod.resetUsageData();
    expect(mod.getUsageSnapshot()).toHaveLength(0);
    expect(mod.getUsageResetAt()).toBe(9999999);
  });

  it("writes cleared state to localStorage immediately", () => {
    mod.trackApiCall("lightSearch", "graphql");
    mod.resetUsageData();
    const raw = localStorageMock.getItem("github-tracker:api-usage");
    const parsed = JSON.parse(raw!);
    expect(Object.keys(parsed.records)).toHaveLength(0);
  });
});

describe("clearUsageData", () => {
  let mod: typeof import("../../src/app/services/api-usage");

  beforeEach(async () => {
    localStorageMock.clear();
    vi.resetModules();
    vi.useFakeTimers();
    mod = await import("../../src/app/services/api-usage");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("removes the localStorage key entirely", () => {
    mod.trackApiCall("lightSearch", "graphql");
    vi.advanceTimersByTime(600);
    expect(localStorageMock.getItem("github-tracker:api-usage")).not.toBeNull();
    mod.clearUsageData();
    expect(localStorageMock.getItem("github-tracker:api-usage")).toBeNull();
  });

  it("resets module state to defaults", () => {
    mod.trackApiCall("lightSearch", "graphql");
    mod.updateResetAt(9999999);
    mod.clearUsageData();
    expect(mod.getUsageSnapshot()).toHaveLength(0);
    expect(mod.getUsageResetAt()).toBeNull();
  });

  it("cancels a pending flush timer before removing (SDR-012)", () => {
    mod.trackApiCall("lightSearch", "graphql");
    // Timer is set but not yet fired (< 500ms)
    mod.clearUsageData();
    // Advance past debounce — flush should NOT fire (timer was cancelled)
    vi.advanceTimersByTime(600);
    // localStorage key should still be null (clearUsageData removed it, flush did not re-add)
    expect(localStorageMock.getItem("github-tracker:api-usage")).toBeNull();
  });
});

// ── Step 3: auto-reset ────────────────────────────────────────────────────────

describe("checkAndResetIfExpired", () => {
  let mod: typeof import("../../src/app/services/api-usage");

  beforeEach(async () => {
    localStorageMock.clear();
    vi.resetModules();
    vi.useFakeTimers();
    mod = await import("../../src/app/services/api-usage");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears records when Date.now() > resetAt", () => {
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
    mod.trackApiCall("lightSearch", "graphql");
    // Set resetAt to 1 hour ago
    mod.updateResetAt(new Date("2026-01-01T11:00:00Z").getTime());

    vi.setSystemTime(new Date("2026-01-01T12:01:00Z"));
    mod.checkAndResetIfExpired();

    expect(mod.getUsageSnapshot()).toHaveLength(0);
  });

  it("does nothing when Date.now() < resetAt (not yet expired)", () => {
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
    mod.trackApiCall("lightSearch", "graphql");
    // Set resetAt to 1 hour in the future
    mod.updateResetAt(new Date("2026-01-01T13:00:00Z").getTime());

    mod.checkAndResetIfExpired();

    expect(mod.getUsageSnapshot()).toHaveLength(1);
  });

  it("does nothing when resetAt is null", () => {
    mod.trackApiCall("lightSearch", "graphql");
    mod.checkAndResetIfExpired();
    expect(mod.getUsageSnapshot()).toHaveLength(1);
  });

  it("sets resetAt to null after reset (prevents redundant re-reset)", () => {
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
    mod.updateResetAt(new Date("2026-01-01T11:00:00Z").getTime());

    vi.setSystemTime(new Date("2026-01-01T12:01:00Z"));
    mod.checkAndResetIfExpired();

    expect(mod.getUsageResetAt()).toBeNull();
  });

  it("persists null resetAt to localStorage after reset", () => {
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
    mod.updateResetAt(new Date("2026-01-01T11:00:00Z").getTime());

    vi.setSystemTime(new Date("2026-01-01T12:01:00Z"));
    mod.checkAndResetIfExpired();

    const raw = localStorageMock.getItem("github-tracker:api-usage");
    const parsed = JSON.parse(raw!);
    expect(parsed.resetAt).toBeNull();
  });

  it("clears records and nulls resetAt atomically on expiry", () => {
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
    mod.trackApiCall("lightSearch", "graphql");
    mod.updateResetAt(new Date("2026-01-01T11:00:00Z").getTime());
    // Flush pending writes so state is settled
    vi.advanceTimersByTime(600);

    // Record localStorage state before the expiry check
    const before = localStorageMock.getItem("github-tracker:api-usage");
    const beforeParsed = JSON.parse(before!);
    expect(beforeParsed.resetAt).not.toBeNull();
    expect(Object.keys(beforeParsed.records)).toHaveLength(1);

    vi.setSystemTime(new Date("2026-01-01T12:01:00Z"));
    mod.checkAndResetIfExpired();

    // After expiry: records cleared, resetAt null — written in a single pass
    const after = localStorageMock.getItem("github-tracker:api-usage");
    const afterParsed = JSON.parse(after!);
    expect(afterParsed.resetAt).toBeNull();
    expect(Object.keys(afterParsed.records)).toHaveLength(0);
  });
});

describe("updateResetAt", () => {
  let mod: typeof import("../../src/app/services/api-usage");

  beforeEach(async () => {
    localStorageMock.clear();
    vi.resetModules();
    mod = await import("../../src/app/services/api-usage");
  });

  it("sets resetAt when current is null", () => {
    mod.updateResetAt(5000);
    expect(mod.getUsageResetAt()).toBe(5000);
  });

  it("uses Math.max — keeps the later reset time when new value is larger", () => {
    mod.updateResetAt(5000);
    mod.updateResetAt(9000);
    expect(mod.getUsageResetAt()).toBe(9000);
  });

  it("uses Math.max — keeps existing when new value is smaller", () => {
    mod.updateResetAt(9000);
    mod.updateResetAt(5000);
    expect(mod.getUsageResetAt()).toBe(9000);
  });

  it.each([0, -1, NaN, Infinity, -Infinity])("rejects invalid resetAt: %s", (val) => {
    mod.updateResetAt(val);
    expect(mod.getUsageResetAt()).toBeNull();
  });

  it("does not overwrite valid resetAt with invalid value", () => {
    mod.updateResetAt(5000);
    mod.updateResetAt(NaN);
    expect(mod.getUsageResetAt()).toBe(5000);
  });
});

// ── deriveSource ─────────────────────────────────────────────────────────────

describe("deriveSource — URL pattern matching", () => {
  let mod: typeof import("../../src/app/services/api-usage");

  beforeEach(async () => {
    localStorageMock.clear();
    vi.resetModules();
    mod = await import("../../src/app/services/api-usage");
  });

  function makeInfo(overrides: Partial<import("../../src/app/services/github").ApiRequestInfo>): import("../../src/app/services/github").ApiRequestInfo {
    return {
      url: "/unknown",
      method: "GET",
      status: 200,
      isGraphql: false,
      resetEpochMs: null,
      ...overrides,
    };
  }

  it.each([
    ["/notifications", "notifications"],
    ["/notifications?per_page=1", "notifications"],
    ["/users/octocat", "validateUser"],
    ["/user", "fetchOrgs"],
    ["/user/orgs", "fetchOrgs"],
    ["/orgs/my-org/repos", "fetchRepos"],
    ["/user/repos", "fetchRepos"],
    ["/repos/foo/bar/actions/runs/12345", "hotRunStatus"],
    ["/repos/foo/bar/actions/runs", "workflowRuns"],
    ["/rate_limit", "rateLimitCheck"],
  ] as const)("REST %s → %s", (url, expected) => {
    expect(mod.deriveSource(makeInfo({ url }))).toBe(expected);
  });

  it("returns 'rest' for unknown REST endpoints", () => {
    expect(mod.deriveSource(makeInfo({ url: "/repos/foo/bar/stargazers" }))).toBe("rest");
  });

  it("returns apiSource for GraphQL calls with custom label", () => {
    expect(mod.deriveSource(makeInfo({ isGraphql: true, url: "/graphql", apiSource: "heavyBackfill" }))).toBe("heavyBackfill");
  });

  it("returns 'graphql' for GraphQL calls without apiSource", () => {
    expect(mod.deriveSource(makeInfo({ isGraphql: true, url: "/graphql" }))).toBe("graphql");
  });

  it("hotRunStatus pattern takes priority over workflowRuns (specific before general)", () => {
    expect(mod.deriveSource(makeInfo({ url: "/repos/foo/bar/actions/runs/999" }))).toBe("hotRunStatus");
  });

  it("falls back to 'graphql' for unrecognized apiSource string", () => {
    expect(mod.deriveSource(makeInfo({ isGraphql: true, url: "/graphql", apiSource: "unknownLabel" }))).toBe("graphql");
  });
});
