import { openDB, type IDBPDatabase } from "idb";

export interface CacheEntry {
  key: string;
  data: unknown;
  etag: string | null;
  lastModified: string | null;
  fetchedAt: number;
  maxAge: number | null;
}

interface CacheDB {
  cache: {
    key: string;
    value: CacheEntry;
    indexes: { fetchedAt: number };
  };
}

let dbPromise: Promise<IDBPDatabase<CacheDB>> | null = null;

export function getDb(): Promise<IDBPDatabase<CacheDB>> {
  if (!dbPromise) {
    dbPromise = openDB<CacheDB>("github-tracker-cache", 1, {
      upgrade(db) {
        const store = db.createObjectStore("cache", { keyPath: "key" });
        store.createIndex("fetchedAt", "fetchedAt");
      },
    });
  }
  return dbPromise;
}

export async function getCacheEntry(
  key: string
): Promise<CacheEntry | undefined> {
  const db = await getDb();
  return db.get("cache", key);
}

export async function setCacheEntry(
  key: string,
  data: unknown,
  etag: string | null,
  maxAge?: number,
  lastModified?: string | null
): Promise<void> {
  const entry: CacheEntry = {
    key,
    data,
    etag,
    lastModified: lastModified ?? null,
    fetchedAt: Date.now(),
    maxAge: maxAge ?? null,
  };

  try {
    const db = await getDb();
    await db.put("cache", entry);
  } catch (err) {
    if (
      err instanceof DOMException &&
      (err.name === "QuotaExceededError" ||
        err.name === "NS_ERROR_DOM_QUOTA_REACHED")
    ) {
      // Emergency eviction: delete oldest 50% of entries, then retry once
      await evictOldestPercent(50);
      const db = await getDb();
      await db.put("cache", entry);
    } else {
      throw err;
    }
  }
}

async function evictOldestPercent(percent: number): Promise<void> {
  const db = await getDb();
  const tx = db.transaction("cache", "readwrite");
  const index = tx.store.index("fetchedAt");
  // Use cursor to get primary keys (not index keys) sorted by fetchedAt ascending
  let cursor = await index.openCursor();
  const totalCount = await tx.store.count();
  const countToDelete = Math.ceil((totalCount * percent) / 100);
  let deleted = 0;
  while (cursor && deleted < countToDelete) {
    await cursor.delete();
    deleted++;
    cursor = await cursor.continue();
  }
  await tx.done;
}

export async function deleteCacheEntry(key: string): Promise<void> {
  const db = await getDb();
  await db.delete("cache", key);
}

export async function clearCache(): Promise<void> {
  const db = await getDb();
  await db.clear("cache");
}

/**
 * Evicts cache entries whose key starts with `prefix` but is NOT in `keepKeys`.
 * Used to clean up per-PR cache entries for PRs no longer in the active set.
 */
export async function evictByPrefix(
  prefix: string,
  keepKeys: Set<string>
): Promise<number> {
  const db = await getDb();
  const tx = db.transaction("cache", "readwrite");
  let cursor = await tx.store.openCursor();
  let count = 0;
  while (cursor) {
    const key = cursor.key as string;
    if (key.startsWith(prefix) && !keepKeys.has(key)) {
      await cursor.delete();
      count++;
    }
    cursor = await cursor.continue();
  }
  await tx.done;
  return count;
}

export async function evictStaleEntries(maxAgeMs: number): Promise<number> {
  const db = await getDb();
  const tx = db.transaction("cache", "readwrite");
  const index = tx.store.index("fetchedAt");
  const cutoff = Date.now() - maxAgeMs;

  // Use cursor to delete by primary key (not index key)
  let cursor = await index.openCursor(IDBKeyRange.upperBound(cutoff));
  let count = 0;
  while (cursor) {
    await cursor.delete();
    count++;
    cursor = await cursor.continue();
  }
  await tx.done;
  return count;
}

export interface FetchResult {
  data: unknown;
  etag: string | null;
  lastModified: string | null;
  status: number;
}

export interface ConditionalHeaders {
  etag: string | null;
  lastModified: string | null;
}

export async function cachedFetch(
  key: string,
  fetchFn: (headers: ConditionalHeaders) => Promise<FetchResult>,
  maxAge?: number
): Promise<{ data: unknown; fromCache: boolean }> {
  const existing = await getCacheEntry(key);

  let conditionalHeaders: ConditionalHeaders = { etag: null, lastModified: null };

  if (existing) {
    // Check per-entry maxAge expiry
    const entryMaxAge = existing.maxAge;
    if (entryMaxAge !== null) {
      const expired = Date.now() - existing.fetchedAt > entryMaxAge;
      if (!expired) {
        conditionalHeaders = {
          etag: existing.etag,
          lastModified: existing.lastModified ?? null,
        };
      }
      // If expired, treat as cache miss
    } else {
      conditionalHeaders = {
        etag: existing.etag,
        lastModified: existing.lastModified ?? null,
      };
    }
  }

  const result = await fetchFn(conditionalHeaders);

  if (result.status === 304) {
    // Cache hit — return stored data
    return { data: existing!.data, fromCache: true };
  }

  if (result.status === 200) {
    await setCacheEntry(key, result.data, result.etag, maxAge, result.lastModified);
    return { data: result.data, fromCache: false };
  }

  throw new Error(`Unexpected fetch status: ${result.status}`);
}
