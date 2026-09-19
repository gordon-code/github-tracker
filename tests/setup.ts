import { afterEach } from "vitest";

// Global test setup: ensure localStorage is available before module imports.
// auth.ts reads localStorage at module scope (to initialize the token signal from
// persisted value). happy-dom establishes window globals lazily, so this shim
// ensures localStorage exists even during early module initialization.
if (typeof localStorage === "undefined") {
  const store: Record<string, string> = {};
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => { store[key] = value; },
      removeItem: (key: string) => { delete store[key]; },
      clear: () => { Object.keys(store).forEach((k) => delete store[k]); },
    },
    writable: true,
    configurable: true,
  });
}

// Track all timer IDs created during tests so we can clear them on teardown.
// Kobalte's tooltip/popover primitives set module-level timers via
// window.setTimeout that can fire after happy-dom tears down, causing
// "ReferenceError: window is not defined".
const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;

globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
  const id = originalSetTimeout(...args);
  pendingTimers.add(id);
  return id;
}) as typeof setTimeout;

globalThis.clearTimeout = ((id?: ReturnType<typeof setTimeout>) => {
  if (id !== undefined) pendingTimers.delete(id);
  originalClearTimeout(id);
}) as typeof clearTimeout;

// happy-dom implements requestAnimationFrame via TIMER.setImmediate (Node's
// check phase), which can resolve *after* the zero-delay setTimeout chain
// @testing-library/user-event uses internally to pace synthetic events. Kobalte's
// Dialog schedules its exit-side cleanup (undoing the aria-hidden it applies to
// background content while a modal is open, and restoring document.body's
// pointer-events) via `setTimeout(() => requestAnimationFrame(fn))`. When the rAF
// hop lags behind userEvent's own timer chain, `await user.click(...)` on a modal's
// dismiss button can resolve before that cleanup runs, leaving the rest of the page
// aria-hidden/pointer-events:none for whatever assertion or interaction comes next
// in the same test. Rerouting rAF through a microtask keeps callback ordering
// deterministic relative to userEvent's chain without making rAF fully synchronous
// (real timestamp preserved so time-based animation loops, e.g. SettingsTOC's
// smooth-scroll easing, still terminate normally when a test doesn't stub rAF).
globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
  Promise.resolve().then(() => cb(performance.now()));
  return 0;
}) as typeof requestAnimationFrame;

afterEach(() => {
  for (const id of pendingTimers) {
    originalClearTimeout(id);
  }
  pendingTimers.clear();
});
