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

afterEach(() => {
  for (const id of pendingTimers) {
    originalClearTimeout(id);
  }
  pendingTimers.clear();
});
