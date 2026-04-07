/**
 * Wraps a synchronous function call with scroll position preservation.
 * SolidJS fine-grained DOM updates complete synchronously within fn(),
 * so a single synchronous scrollTo is sufficient — no rAF needed.
 */
export function withScrollLock(fn: () => void): void {
  const y = window.scrollY;
  try { fn(); } finally { window.scrollTo(0, y); }
}

/**
 * FLIP animation for reorderable lists. Records positions of elements
 * matching `[data-repo-group]` before fn(), then animates them to their
 * new positions after the DOM update.
 *
 * Consistent with TrackedTab's FLIP: 200ms ease-in-out, respects
 * prefers-reduced-motion (falls back to withScrollLock).
 */
export function withFlipAnimation(fn: () => void): void {
  if (typeof window === "undefined") { fn(); return; }

  // Reduced motion: fall back to instant scroll lock
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    withScrollLock(fn);
    return;
  }

  // First: record positions of all repo group wrappers
  const items = document.querySelectorAll<HTMLElement>("[data-repo-group]");
  const before = new Map<string, DOMRect>();
  for (const el of items) {
    const key = el.dataset.repoGroup!;
    before.set(key, el.getBoundingClientRect());
  }

  // Execute state change (SolidJS updates DOM synchronously)
  fn();

  // Last, Invert, Play
  requestAnimationFrame(() => {
    const afterItems = document.querySelectorAll<HTMLElement>("[data-repo-group]");
    for (const el of afterItems) {
      const key = el.dataset.repoGroup!;
      const old = before.get(key);
      if (!old) continue;
      const now = el.getBoundingClientRect();
      const dy = old.top - now.top;
      if (Math.abs(dy) < 1) continue;
      el.animate(
        [{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }],
        { duration: 200, easing: "ease-in-out" },
      );
    }
  });
}
