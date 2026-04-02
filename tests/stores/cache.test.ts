import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getDb,
  getCacheEntry,
  setCacheEntry,
  deleteCacheEntry,
  clearCache,
  evictStaleEntries,
  cachedFetch,
} from "../../src/app/stores/cache";

// Reset the DB singleton between tests by closing and clearing
beforeEach(async () => {
  // Clear all cache entries before each test
  const db = await getDb();
  await db.clear("cache");
});

describe("getDb", () => {
  it("resolves without error", async () => {
    const db = await getDb();
    expect(db).toBeDefined();
    expect(db.name).toBe("github-tracker-cache");
  });
});

describe("CRUD operations", () => {
  it("sets and gets a cache entry", async () => {
    await setCacheEntry("test:key", { foo: 1 }, "etag123");
    const entry = await getCacheEntry("test:key");
    expect(entry).toBeDefined();
    expect(entry!.key).toBe("test:key");
    expect(entry!.data).toEqual({ foo: 1 });
    expect(entry!.etag).toBe("etag123");
    expect(entry!.fetchedAt).toBeGreaterThan(0);
    expect(entry!.maxAge).toBeNull();
  });

  it("sets entry with explicit maxAge", async () => {
    await setCacheEntry("test:maxage", { bar: 2 }, null, 30000);
    const entry = await getCacheEntry("test:maxage");
    expect(entry!.maxAge).toBe(30000);
  });

  it("upserts an existing entry", async () => {
    await setCacheEntry("test:upsert", { v: 1 }, "etag1");
    await setCacheEntry("test:upsert", { v: 2 }, "etag2");
    const entry = await getCacheEntry("test:upsert");
    expect(entry!.data).toEqual({ v: 2 });
    expect(entry!.etag).toBe("etag2");
  });

  it("returns undefined for missing key", async () => {
    const entry = await getCacheEntry("nonexistent:key");
    expect(entry).toBeUndefined();
  });

  it("deletes a cache entry", async () => {
    await setCacheEntry("test:delete", { x: 1 }, null);
    await deleteCacheEntry("test:delete");
    const entry = await getCacheEntry("test:delete");
    expect(entry).toBeUndefined();
  });

  it("deleteCacheEntry on nonexistent key does not throw", async () => {
    await expect(deleteCacheEntry("nonexistent")).resolves.toBeUndefined();
  });

  it("clears all entries", async () => {
    await setCacheEntry("test:a", { a: 1 }, null);
    await setCacheEntry("test:b", { b: 2 }, null);
    await clearCache();
    expect(await getCacheEntry("test:a")).toBeUndefined();
    expect(await getCacheEntry("test:b")).toBeUndefined();
  });
});

describe("setCacheEntry — QuotaExceededError eviction", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("evicts oldest 50% and retries when db.put throws QuotaExceededError on first call", async () => {
    // Seed four entries so eviction has something to remove
    const db = await getDb();
    const baseTime = Date.now() - 10_000;
    for (let i = 1; i <= 4; i++) {
      await db.put("cache", {
        key: `quota-seed:${i}`,
        data: { i },
        etag: null,
        lastModified: null,
        fetchedAt: baseTime + i * 100,
        maxAge: null,
      });
    }

    const countBefore = await db.count("cache");
    expect(countBefore).toBe(4);

    // Spy on db.put: throw QuotaExceededError on the first call, succeed on subsequent calls
    let putCallCount = 0;
    const originalPut = db.put.bind(db);
    vi.spyOn(db, "put").mockImplementation(async (...args: Parameters<typeof db.put>) => {
      putCallCount++;
      if (putCallCount === 1) {
        const err = new DOMException("QuotaExceededError", "QuotaExceededError");
        throw err;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return originalPut(...(args as [any, any]));
    });

    // setCacheEntry should catch the quota error, evict ~50%, then retry
    await setCacheEntry("quota-new:key", { new: true }, "etag-new");

    const countAfter = await db.count("cache");
    // 4 original − 2 evicted (50%) + 1 new = 3
    expect(countAfter).toBeLessThan(countBefore + 1); // at least some eviction happened
    // The new entry must have been stored
    const stored = await getCacheEntry("quota-new:key");
    expect(stored).toBeDefined();
    expect(stored!.data).toEqual({ new: true });
  });

  it("logs warning and resolves when retry after eviction also fails", async () => {
    const db = await getDb();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Throw QuotaExceededError on every put call
    vi.spyOn(db, "put").mockImplementation(async () => {
      throw new DOMException("QuotaExceededError", "QuotaExceededError");
    });

    // Should resolve (not throw) — entry is silently dropped
    await setCacheEntry("quota-retry-fail:key", { data: true }, null);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Still over quota")
    );
  });
});

describe("evictStaleEntries", () => {
  it("removes only entries older than the threshold", async () => {
    const now = Date.now();
    const hoursMs = 60 * 60 * 1000;
    const db = await getDb();

    // Insert old entry (25 hours ago)
    await db.put("cache", {
      key: "old:entry",
      data: { old: true },
      etag: null,
      lastModified: null,
      fetchedAt: now - 25 * hoursMs,
      maxAge: null,
    });

    // Insert fresh entry
    await db.put("cache", {
      key: "fresh:entry",
      data: { fresh: true },
      etag: null,
      lastModified: null,
      fetchedAt: now - 1 * hoursMs,
      maxAge: null,
    });

    const count = await evictStaleEntries(24 * hoursMs);

    expect(count).toBe(1);
    expect(await getCacheEntry("old:entry")).toBeUndefined();
    expect(await getCacheEntry("fresh:entry")).toBeDefined();
  });

  it("returns 0 when no entries are stale", async () => {
    await setCacheEntry("fresh:only", { data: true }, null);
    const count = await evictStaleEntries(24 * 60 * 60 * 1000);
    expect(count).toBe(0);
  });

  it("evicts all entries when all are stale", async () => {
    const db = await getDb();
    const oldTime = Date.now() - 48 * 60 * 60 * 1000;
    await db.put("cache", {
      key: "stale:1",
      data: {},
      etag: null,
      lastModified: null,
      fetchedAt: oldTime,
      maxAge: null,
    });
    await db.put("cache", {
      key: "stale:2",
      data: {},
      etag: null,
      lastModified: null,
      fetchedAt: oldTime,
      maxAge: null,
    });

    const count = await evictStaleEntries(24 * 60 * 60 * 1000);
    expect(count).toBe(2);
  });
});

describe("cachedFetch", () => {
  it("calls fetchFn with null headers when no cache entry exists", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      data: { result: "fresh" },
      etag: "new-etag",
      lastModified: null,
      status: 200,
    });

    const result = await cachedFetch("no:cache", fetchFn);

    expect(fetchFn).toHaveBeenCalledWith({ etag: null, lastModified: null });
    expect(result.data).toEqual({ result: "fresh" });
    expect(result.fromCache).toBe(false);
  });

  it("calls fetchFn with stored etag when cache entry exists", async () => {
    await setCacheEntry("etag:test", { cached: true }, "stored-etag");

    const fetchFn = vi.fn().mockResolvedValue({
      data: { cached: true },
      etag: "stored-etag",
      lastModified: null,
      status: 304,
    });

    await cachedFetch("etag:test", fetchFn);

    expect(fetchFn).toHaveBeenCalledWith({ etag: "stored-etag", lastModified: null });
  });

  it("returns cached data on 304 response", async () => {
    await setCacheEntry("cache:304", { original: "data" }, "my-etag");

    const fetchFn = vi.fn().mockResolvedValue({
      data: null,
      etag: null,
      lastModified: null,
      status: 304,
    });

    const result = await cachedFetch("cache:304", fetchFn);

    expect(result.data).toEqual({ original: "data" });
    expect(result.fromCache).toBe(true);
  });

  it("updates cache and returns new data on 200 response", async () => {
    await setCacheEntry("cache:200", { old: "data" }, "old-etag");

    const fetchFn = vi.fn().mockResolvedValue({
      data: { new: "data" },
      etag: "new-etag",
      lastModified: "Thu, 20 Mar 2026 12:00:00 GMT",
      status: 200,
    });

    const result = await cachedFetch("cache:200", fetchFn);

    expect(result.data).toEqual({ new: "data" });
    expect(result.fromCache).toBe(false);

    const stored = await getCacheEntry("cache:200");
    expect(stored!.data).toEqual({ new: "data" });
    expect(stored!.etag).toBe("new-etag");
    expect(stored!.lastModified).toBe("Thu, 20 Mar 2026 12:00:00 GMT");
  });

  it("passes lastModified from cache when etag is null", async () => {
    await setCacheEntry("lm:test", { data: 1 }, null, undefined, "Thu, 20 Mar 2026 12:00:00 GMT");

    const fetchFn = vi.fn().mockResolvedValue({
      data: { data: 1 },
      etag: null,
      lastModified: "Thu, 20 Mar 2026 12:00:00 GMT",
      status: 304,
    });

    await cachedFetch("lm:test", fetchFn);

    expect(fetchFn).toHaveBeenCalledWith({
      etag: null,
      lastModified: "Thu, 20 Mar 2026 12:00:00 GMT",
    });
  });

  it("respects per-entry maxAge — expired entry treated as cache miss", async () => {
    const db = await getDb();
    const expiredTime = Date.now() - 2 * 60 * 1000; // 2 minutes ago

    // Store entry with 1 minute maxAge (already expired)
    await db.put("cache", {
      key: "maxage:expired",
      data: { old: true },
      etag: "old-etag",
      lastModified: null,
      fetchedAt: expiredTime,
      maxAge: 60 * 1000, // 1 minute
    });

    const fetchFn = vi.fn().mockResolvedValue({
      data: { fresh: true },
      etag: "fresh-etag",
      lastModified: null,
      status: 200,
    });

    await cachedFetch("maxage:expired", fetchFn);

    // Should have been called with nulls (cache miss due to expiry)
    expect(fetchFn).toHaveBeenCalledWith({ etag: null, lastModified: null });
  });

  it("uses cached etag when per-entry maxAge has not expired", async () => {
    const db = await getDb();
    const recentTime = Date.now() - 30 * 1000; // 30 seconds ago

    // Store entry with 5 minute maxAge (not expired)
    await db.put("cache", {
      key: "maxage:fresh",
      data: { cached: true },
      etag: "valid-etag",
      lastModified: null,
      fetchedAt: recentTime,
      maxAge: 5 * 60 * 1000, // 5 minutes
    });

    const fetchFn = vi.fn().mockResolvedValue({
      data: { cached: true },
      etag: "valid-etag",
      lastModified: null,
      status: 304,
    });

    const result = await cachedFetch("maxage:fresh", fetchFn);

    expect(fetchFn).toHaveBeenCalledWith({ etag: "valid-etag", lastModified: null });
    expect(result.fromCache).toBe(true);
  });

  it("propagates errors from fetchFn", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("network error"));
    await expect(cachedFetch("error:key", fetchFn)).rejects.toThrow(
      "network error"
    );
  });

  it("throws on unexpected status codes", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      data: null,
      etag: null,
      lastModified: null,
      status: 500,
    });
    await expect(cachedFetch("bad:status", fetchFn)).rejects.toThrow(
      "Unexpected fetch status: 500"
    );
  });
});
