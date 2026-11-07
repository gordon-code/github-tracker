import { createEffect, createSignal, on, onCleanup } from "solid-js";
import { pushNotification } from "./errors";
import {
  hasPendingFields,
  mergeFieldsForWrite,
  takeForeignFields,
  toFieldJson,
  type FieldBaseline,
} from "./persisted-fields";

export interface FieldPersistenceOptions {
  /** localStorage key holding the store's JSON blob. */
  storageKey: string;
  /** The store's current contents as plain JSON, read without tracking. */
  snapshot: () => Record<string, unknown>;
  /** The same contents, read inside a reactive scope so the persistence effect tracks the store. */
  trackedSnapshot: () => Record<string, unknown>;
  /** Validates a parsed blob key by key; returns undefined for anything that is not a plain object. */
  validate: (parsed: unknown) => Record<string, unknown> | undefined;
  /** Applies values adopted from another tab to the live store. */
  apply: (patch: Record<string, unknown>) => void;
  /** While true, nothing is written to or adopted from localStorage (see also `suspendPersistence`). */
  isReadOnly: () => boolean;
  failureSource: string;
  failureMessage: string;
}

export interface FieldPersistence {
  /** Adopts what is on disk, listens for other tabs' writes, and schedules debounced writes. Call inside a Solid root. */
  init: () => void;
  /** Synchronously commits this tab's pending changes (no-op when there are none). */
  flush: () => void;
  /** Makes the next write replace the whole stored blob, and ignores other tabs' writes until it lands. */
  requestFullOverwrite: () => void;
  /** Writes these keys on the next commit even if they match what this tab last saved. */
  forceKeys: (keys: Iterable<string>) => void;
  /** Schedules a write even when no tracked store value changed. */
  schedule: () => void;
  /** Treats the store's current contents as already saved and cancels any scheduled write. */
  discardPending: () => void;
}

const DEBOUNCE_MS = 200;

// While true, no persisted store reads or writes localStorage. Set while a tab cannot yet tell
// whether another tab's sign-in changed the identity its in-memory state belongs to.
const [persistenceSuspended, setPersistenceSuspended] = createSignal(false);

/** Pauses every persisted store's reads and writes until `resumePersistence()` (or a reload). */
export function suspendPersistence(): void {
  setPersistenceSuspended(true);
}

// Reconcile callbacks of every initialised store, run when persistence resumes.
const reconcilers = new Set<() => void>();

/**
 * Lifts the pause, then has every initialised store re-read what other tabs saved while it was
 * paused and schedule a write for anything this tab changed meanwhile.
 */
export function resumePersistence(): void {
  setPersistenceSuspended(false);
  for (const reconcile of reconcilers) reconcile();
}

/**
 * Debounced, per-top-level-key persistence of one store to one localStorage blob, shared
 * by every open tab. Each tab writes only the keys it changed, on top of whatever is on
 * disk, and adopts the keys other tabs write (see persisted-fields.ts for the baseline
 * rules).
 */
export function createFieldPersistence(options: FieldPersistenceOptions): FieldPersistence {
  const [trigger, setTrigger] = createSignal(0);
  // Per top-level key: the JSON this tab last wrote, loaded, or adopted.
  let baseline: FieldBaseline = toFieldJson(options.snapshot());
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingSnapshot: Record<string, unknown> | undefined;
  let fullOverwritePending = false;
  const forcedKeys = new Set<string>();
  // The first commit after init also repairs keys missing from disk; later commits with nothing
  // pending skip reading and validating the stored blob.
  let needsRepair = true;
  const readOnly = () => options.isReadOnly() || persistenceSuspended();

  function readOnDisk(): Record<string, unknown> | undefined {
    try {
      const raw = localStorage.getItem(options.storageKey);
      if (raw === null) return undefined;
      return options.validate(JSON.parse(raw) as unknown);
    } catch {
      return undefined;
    }
  }

  function commit(snapshot: Record<string, unknown>): void {
    if (readOnly()) return;
    if (!needsRepair && !fullOverwritePending && forcedKeys.size === 0 && !hasPendingFields(snapshot, baseline)) {
      return;
    }
    // A pending full overwrite writes the whole snapshot; otherwise only pending, forced,
    // and missing-from-disk keys are overlaid onto the validated on-disk blob. An absent or
    // unreadable blob also falls back to the whole snapshot.
    const { merged, writtenFields, changed } = mergeFieldsForWrite(
      snapshot,
      fullOverwritePending ? undefined : readOnDisk(),
      baseline,
      forcedKeys,
    );
    if (changed) {
      try {
        localStorage.setItem(options.storageKey, JSON.stringify(merged));
      } catch {
        pushNotification(options.failureSource, options.failureMessage, "warning");
        return;
      }
    }
    Object.assign(baseline, writtenFields);
    fullOverwritePending = false;
    forcedKeys.clear();
    needsRepair = false;
  }

  // A pending full overwrite ignores incoming data (the overwrite wins); a key this tab has
  // a pending or forced change to keeps the local value and is written on the next commit,
  // even if the user later reverts it to the value this tab last saved.
  function adopt(incoming: Record<string, unknown>): void {
    if (readOnly() || fullOverwritePending) return;
    const patch = takeForeignFields(incoming, options.snapshot(), baseline, forcedKeys);
    if (Object.keys(patch).length > 0) options.apply(patch);
  }

  function flush(): void {
    clearTimeout(debounceTimer);
    debounceTimer = undefined;
    pendingSnapshot = undefined;
    const snapshot = options.snapshot();
    if (!fullOverwritePending && forcedKeys.size === 0 && !hasPendingFields(snapshot, baseline)) return;
    commit(snapshot);
  }

  function init(): void {
    fullOverwritePending = false;
    forcedKeys.clear();
    needsRepair = true;
    baseline = toFieldJson(options.snapshot());
    // Picks up anything another tab saved between this module loading its state and now.
    const onDisk = readOnDisk();
    if (onDisk !== undefined) adopt(onDisk);

    const reconcile = () => {
      const stored = readOnDisk();
      if (stored !== undefined) adopt(stored);
      setTrigger((n) => n + 1);
    };
    reconcilers.add(reconcile);
    onCleanup(() => reconcilers.delete(reconcile));
    // Leaving read-only mode (the stored layout matches again) catches up the same way.
    createEffect(
      on(options.isReadOnly, (readOnlyNow, wasReadOnly) => {
        if (wasReadOnly && !readOnlyNow) reconcile();
      }),
    );

    if (typeof window !== "undefined") {
      const handleStorage = (e: StorageEvent) => {
        if (e.key !== options.storageKey || e.newValue === null) return;
        if (e.storageArea !== null && e.storageArea !== localStorage) return;
        let incoming: Record<string, unknown> | undefined;
        try {
          incoming = options.validate(JSON.parse(e.newValue) as unknown);
        } catch {
          return;
        }
        if (incoming !== undefined) adopt(incoming);
      };
      window.addEventListener("storage", handleStorage);
      onCleanup(() => window.removeEventListener("storage", handleStorage));
    }

    createEffect(() => {
      trigger();
      const snapshot = options.trackedSnapshot();
      pendingSnapshot = snapshot;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        pendingSnapshot = undefined;
        commit(snapshot);
      }, DEBOUNCE_MS);
    });

    // Registered on the outer owner, not inside the effect: Solid runs a computation's
    // cleanup on every re-run, which would flush a stale pending snapshot on each change.
    onCleanup(() => {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
      if (pendingSnapshot !== undefined) {
        commit(pendingSnapshot);
        pendingSnapshot = undefined;
      }
    });
  }

  return {
    init,
    flush,
    requestFullOverwrite: () => {
      fullOverwritePending = true;
      forcedKeys.clear();
    },
    forceKeys: (keys) => {
      for (const key of keys) forcedKeys.add(key);
    },
    schedule: () => {
      setTrigger((n) => n + 1);
    },
    discardPending: () => {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
      pendingSnapshot = undefined;
      fullOverwritePending = false;
      forcedKeys.clear();
      baseline = toFieldJson(options.snapshot());
    },
  };
}
