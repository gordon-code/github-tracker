import { createSignal, createEffect, onCleanup, type Accessor } from "solid-js";
import { detectReorderedRepos } from "./grouping";

export function createReorderHighlight(
  getRepoOrder: Accessor<string[]>,
  getLockedOrder: Accessor<string[]>,
): Accessor<ReadonlySet<string>> {
  let prevOrder: string[] = [];
  let prevLocked: string[] = [];
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const [highlighted, setHighlighted] = createSignal<ReadonlySet<string>>(new Set());

  createEffect(() => {
    const currentOrder = getRepoOrder();
    const currentLocked = getLockedOrder();

    const lockedChanged = currentLocked.length !== prevLocked.length
      || currentLocked.some((r, i) => r !== prevLocked[i]);

    if (prevOrder.length > 0 && !lockedChanged) {
      const moved = detectReorderedRepos(prevOrder, currentOrder);
      if (moved.size > 0) {
        setHighlighted(moved);
        clearTimeout(timeout);
        timeout = setTimeout(() => setHighlighted(new Set<string>()), 1500);
      }
    }

    prevOrder = currentOrder;
    prevLocked = [...currentLocked];
  });
  onCleanup(() => clearTimeout(timeout));

  return highlighted;
}
