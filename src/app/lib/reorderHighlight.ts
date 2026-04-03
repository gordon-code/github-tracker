import { createSignal, createEffect, onCleanup, type Accessor } from "solid-js";
import { detectReorderedRepos } from "./grouping";

export function createReorderHighlight(
  getRepoOrder: Accessor<string[]>,
  getLockedOrder: Accessor<string[]>,
  getIgnoredCount: Accessor<number>,
  getFilterKey?: Accessor<string>,
): Accessor<ReadonlySet<string>> {
  let prevOrder: string[] = [];
  let prevLocked: string[] = [];
  let prevIgnoredCount = getIgnoredCount();
  let prevFilterKey = getFilterKey?.() ?? "";
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const [highlighted, setHighlighted] = createSignal<ReadonlySet<string>>(new Set());

  createEffect(() => {
    const currentOrder = getRepoOrder();
    const currentLocked = getLockedOrder();
    const currentIgnoredCount = getIgnoredCount();
    const currentFilterKey = getFilterKey?.() ?? "";

    const lockedChanged = currentLocked.length !== prevLocked.length
      || currentLocked.some((r, i) => r !== prevLocked[i]);
    const ignoredChanged = currentIgnoredCount !== prevIgnoredCount;
    const filterChanged = currentFilterKey !== prevFilterKey;

    if (prevOrder.length > 0 && !lockedChanged && !ignoredChanged && !filterChanged) {
      const moved = detectReorderedRepos(prevOrder, currentOrder);
      if (moved.size > 0) {
        setHighlighted(moved);
        clearTimeout(timeout);
        timeout = setTimeout(() => setHighlighted(new Set<string>()), 1500);
      }
    }

    prevOrder = currentOrder;
    prevLocked = [...currentLocked];
    prevIgnoredCount = currentIgnoredCount;
    prevFilterKey = currentFilterKey;
  });
  onCleanup(() => clearTimeout(timeout));

  return highlighted;
}
