import { createSignal, createEffect, onCleanup, type Accessor } from "solid-js";
import type { PeekUpdate } from "./grouping";

export function createFlashDetection<T extends { id: number; repoFullName: string }>(opts: {
  getItems: Accessor<T[]>;
  getHotIds: Accessor<ReadonlySet<number> | undefined>;
  getExpandedRepos: Accessor<Record<string, boolean>>;
  trackKey: (item: T) => string;
  itemLabel: (item: T) => string;
  itemStatus: (item: T) => string;
}): {
  flashingIds: Accessor<ReadonlySet<number>>;
  peekUpdates: Accessor<ReadonlyMap<string, PeekUpdate>>;
} {
  const [peekUpdates, setPeekUpdates] = createSignal<ReadonlyMap<string, PeekUpdate>>(new Map());
  let peekTimeout: ReturnType<typeof setTimeout> | undefined;

  let prevValues = new Map<number, string>();
  let initialized = false;
  let flashTimeout: ReturnType<typeof setTimeout> | undefined;
  const [flashingIds, setFlashingIds] = createSignal<ReadonlySet<number>>(new Set());

  createEffect(() => {
    const items = opts.getItems();
    const hotIds = opts.getHotIds();

    if (!initialized) {
      initialized = true;
      prevValues = new Map(items.map(item => [item.id, opts.trackKey(item)]));
      return;
    }

    // Full refresh path — rebuild map to prune stale entries.
    // Items only leave the dataset on full refresh (hotIds empty), not during hot polls.
    if (!hotIds || hotIds.size === 0) {
      prevValues = new Map(items.map(item => [item.id, opts.trackKey(item)]));
      return;
    }

    const changed = new Set<number>();
    for (const item of items) {
      if (!hotIds.has(item.id)) continue;
      const prev = prevValues.get(item.id);
      if (prev !== undefined && prev !== opts.trackKey(item)) {
        changed.add(item.id);
      }
    }

    // Hot-poll path — update in-place (items don't change set between hot polls)
    for (const item of items) {
      prevValues.set(item.id, opts.trackKey(item));
    }

    if (changed.size > 0) {
      setFlashingIds(prev => new Set([...prev, ...changed]));
      clearTimeout(flashTimeout);
      flashTimeout = setTimeout(() => setFlashingIds(new Set<number>()), 1000);

      const peeks = new Map<string, PeekUpdate>();
      const peekCounts = new Map<string, number>();
      const peekFirstLabels = new Map<string, string>();
      const expandedRepos = opts.getExpandedRepos();
      for (const item of items) {
        if (changed.has(item.id)) {
          if (!expandedRepos[item.repoFullName]) {
            const count = (peekCounts.get(item.repoFullName) ?? 0) + 1;
            peekCounts.set(item.repoFullName, count);
            if (count === 1) {
              const label = opts.itemLabel(item);
              peekFirstLabels.set(item.repoFullName, label);
              peeks.set(item.repoFullName, {
                itemLabel: label,
                newStatus: opts.itemStatus(item),
              });
            } else {
              peeks.set(item.repoFullName, {
                itemLabel: `${peekFirstLabels.get(item.repoFullName)} + ${count - 1} more`,
                newStatus: peeks.get(item.repoFullName)!.newStatus,
              });
            }
          }
        }
      }
      if (peeks.size > 0) {
        setPeekUpdates(peeks);
        clearTimeout(peekTimeout);
        peekTimeout = setTimeout(() => setPeekUpdates(new Map()), 3000);
      }
    }
  });

  onCleanup(() => {
    clearTimeout(flashTimeout);
    clearTimeout(peekTimeout);
  });

  return { flashingIds, peekUpdates };
}
