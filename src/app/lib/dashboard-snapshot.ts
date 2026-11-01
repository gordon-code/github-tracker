import { openDB, type IDBPDatabase } from "idb";
import { pushNotification } from "./errors";
import type { Issue, PullRequest, WorkflowRun } from "../services/api";

const DB_NAME = "github-tracker-snapshot";
const DB_VERSION = 1;
const STORE_NAME = "snapshot";
const RECORD_KEY = "current";

export const MAX_SNAPSHOT_ITEMS = 5_000;
export const DEBOUNCE_MS = 5_000;

// Bump only for breaking item-schema changes (renames, type changes); records with a
// different version are discarded on load. Additive optional fields don't require a
// bump — missing fields deserialize as undefined.
const SNAPSHOT_VERSION = 1;

try {
  if (typeof localStorage !== "undefined") {
    localStorage.removeItem?.("github-tracker:dashboard");
  }
} catch {
  // Ignore storage errors in restricted environments
}

export interface DashboardSnapshotState {
  issues: Issue[];
  pullRequests: PullRequest[];
  workflowRuns: WorkflowRun[];
  lastRefreshedAt: Date | null;
}

export interface DashboardSnapshot extends DashboardSnapshotState {
  _v: typeof SNAPSHOT_VERSION;
  login: string;
  savedAt: number;
}

interface SnapshotDB {
  snapshot: {
    key: string;
    value: DashboardSnapshot;
  };
}

let dbPromise: Promise<IDBPDatabase<SnapshotDB>> | null = null;
let _writeToken = 0;
let _sizeWarned = false;
// Set once an over-cap write has queued the stored-record delete; cleared by the
// next under-cap write so repeated over-cap writes don't queue redundant deletes.
let _discardQueued = false;
let _pendingTimer: ReturnType<typeof setTimeout> | null = null;
let _pendingMode: "immediate" | "debounced" | null = null;
let _pendingPayload: DashboardSnapshot | null = null;
let _pendingToken = 0;
let _inFlightMutation: Promise<void> | null = null;

function getDb(): Promise<IDBPDatabase<SnapshotDB>> {
  if (!dbPromise) {
    let currentPromise: Promise<IDBPDatabase<SnapshotDB>> | null = null;
    currentPromise = openDB<SnapshotDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      },
      blocking(_currentVersion, _blockedVersion, event) {
        const target = event?.target as IDBDatabase | null | undefined;
        target?.close?.();
        void currentPromise?.then((db) => db.close()).catch(() => {});
        if (dbPromise === currentPromise) {
          dbPromise = null;
        }
      },
      terminated() {
        if (dbPromise === currentPromise) {
          dbPromise = null;
        }
      },
    }).catch((err: unknown) => {
      if (dbPromise === currentPromise) {
        dbPromise = null;
      }
      throw err;
    });
    dbPromise = currentPromise;
  }
  return dbPromise;
}

function isValidKeyedArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        item !== null &&
        typeof item === "object" &&
        typeof (item as Record<string, unknown>).id === "number",
    )
  );
}

export async function loadSnapshot(login: string): Promise<DashboardSnapshot | null> {
  if (typeof indexedDB === "undefined" || !login) {
    return null;
  }
  try {
    const db = await getDb();
    const raw = (await db.get(STORE_NAME, RECORD_KEY)) as unknown;
    if (!raw || typeof raw !== "object") {
      return null;
    }
    const record = raw as Record<string, unknown>;
    if (record._v !== SNAPSHOT_VERSION) {
      return null;
    }
    if (
      typeof record.login !== "string" ||
      record.login.toLowerCase() !== login.toLowerCase()
    ) {
      return null;
    }
    if (record.savedAt !== undefined && typeof record.savedAt !== "number") {
      return null;
    }
    if (
      !isValidKeyedArray(record.issues) ||
      !isValidKeyedArray(record.pullRequests) ||
      !isValidKeyedArray(record.workflowRuns)
    ) {
      return null;
    }
    let lastRefreshedAt: Date | null = null;
    if (record.lastRefreshedAt === null) {
      lastRefreshedAt = null;
    } else if (record.lastRefreshedAt instanceof Date) {
      if (Number.isNaN(record.lastRefreshedAt.getTime())) {
        return null;
      }
      lastRefreshedAt = record.lastRefreshedAt;
    } else if (typeof record.lastRefreshedAt === "string") {
      const parsedDate = new Date(record.lastRefreshedAt);
      if (Number.isNaN(parsedDate.getTime())) {
        return null;
      }
      lastRefreshedAt = parsedDate;
    } else {
      return null;
    }

    return {
      _v: SNAPSHOT_VERSION,
      login: record.login,
      savedAt: typeof record.savedAt === "number" ? record.savedAt : 0,
      issues: record.issues as Issue[],
      pullRequests: record.pullRequests as PullRequest[],
      workflowRuns: record.workflowRuns as WorkflowRun[],
      lastRefreshedAt,
    };
  } catch (err) {
    console.warn("[dashboard-snapshot] Failed to load dashboard snapshot:", err);
    return null;
  }
}

async function performWrite(payload: DashboardSnapshot, token: number): Promise<void> {
  if (token !== _writeToken) return;
  try {
    const db = await getDb();
    if (token !== _writeToken) return;
    await db.put(STORE_NAME, payload, RECORD_KEY);
  } catch (err) {
    console.warn("[dashboard-snapshot] Failed to write dashboard snapshot:", err);
    pushNotification(
      "snapshot:write",
      "Dashboard snapshot write failed — storage may be full",
      "warning",
    );
  }
}

async function performDelete(token: number): Promise<void> {
  if (token !== _writeToken) return;
  try {
    const db = await getDb();
    if (token !== _writeToken) return;
    await db.delete(STORE_NAME, RECORD_KEY);
  } catch (err) {
    console.warn("[dashboard-snapshot] Failed to discard dashboard snapshot:", err);
  }
}

// Serializes IDB mutations so each runs after the previously queued one settles.
function enqueueMutation(task: () => Promise<void>): Promise<void> {
  const previousMutation = _inFlightMutation;
  const mutationPromise = (async () => {
    if (previousMutation) {
      await previousMutation;
    }
    await task();
  })().finally(() => {
    if (_inFlightMutation === mutationPromise) {
      _inFlightMutation = null;
    }
  });
  _inFlightMutation = mutationPromise;
  return mutationPromise;
}

function cancelPendingWrite(): void {
  if (_pendingTimer !== null) {
    clearTimeout(_pendingTimer);
    _pendingTimer = null;
  }
  _pendingMode = null;
  _pendingPayload = null;
}

function flushPending(): Promise<void> {
  if (_pendingTimer !== null) {
    clearTimeout(_pendingTimer);
    _pendingTimer = null;
  }
  _pendingMode = null;
  const payload = _pendingPayload;
  const token = _pendingToken;
  _pendingPayload = null;
  if (!payload || token !== _writeToken) {
    return _inFlightMutation ?? Promise.resolve();
  }
  return enqueueMutation(() => performWrite(payload, token));
}

export function writeSnapshot(
  state: DashboardSnapshotState,
  login: string,
  mode: "immediate" | "debounced",
): void {
  if (typeof indexedDB === "undefined" || !login) {
    return;
  }
  const totalItems =
    state.issues.length + state.pullRequests.length + state.workflowRuns.length;
  if (totalItems > MAX_SNAPSHOT_ITEMS) {
    if (!_sizeWarned) {
      _sizeWarned = true;
      console.warn(
        `[dashboard-snapshot] Snapshot exceeds ${MAX_SNAPSHOT_ITEMS} items (${totalItems}); skipping write and discarding stored snapshot`,
      );
    }
    // Drop any queued under-cap payload and remove the stored record so a reload
    // never restores data older than the current dashboard.
    cancelPendingWrite();
    if (!_discardQueued) {
      _discardQueued = true;
      const deleteToken = _writeToken;
      void enqueueMutation(() => performDelete(deleteToken));
    }
    return;
  }

  _discardQueued = false;
  const capturedToken = _writeToken;
  _pendingPayload = {
    _v: SNAPSHOT_VERSION,
    login,
    savedAt: Date.now(),
    issues: state.issues,
    pullRequests: state.pullRequests,
    workflowRuns: state.workflowRuns,
    lastRefreshedAt: state.lastRefreshedAt,
  };
  _pendingToken = capturedToken;

  if (mode === "immediate") {
    if (_pendingTimer !== null) {
      clearTimeout(_pendingTimer);
    }
    _pendingMode = "immediate";
    _pendingTimer = setTimeout(() => {
      _pendingTimer = null;
      _pendingMode = null;
      void flushPending();
    }, 0);
  } else {
    if (_pendingMode === "immediate" && _pendingTimer !== null) {
      return;
    }
    if (_pendingTimer !== null) {
      clearTimeout(_pendingTimer);
    }
    _pendingMode = "debounced";
    _pendingTimer = setTimeout(() => {
      _pendingTimer = null;
      _pendingMode = null;
      void flushPending();
    }, DEBOUNCE_MS);
  }
}

export function flushSnapshot(): Promise<void> {
  return flushPending();
}

/**
 * Clears any pending or persisted dashboard snapshot.
 * Invariant: only called from the auth.ts paths that also increment identityEpoch
 * (clearAuth, expireToken, clearIdentityData, and the cross-tab identity-switch reload).
 */
export function clearSnapshot(): Promise<void> {
  cancelPendingWrite();
  _writeToken++;
  _sizeWarned = false;
  _discardQueued = false;

  if (typeof indexedDB === "undefined") {
    return Promise.resolve();
  }

  return (async () => {
    try {
      const db = await getDb();
      await db.delete(STORE_NAME, RECORD_KEY);
    } catch (err) {
      console.warn("[dashboard-snapshot] Failed to clear dashboard snapshot:", err);
    }
  })();
}

if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      void flushSnapshot();
    }
  });
}
