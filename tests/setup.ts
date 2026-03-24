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
