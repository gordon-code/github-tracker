import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, createSignal, untrack } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { createFieldPersistence, resumePersistence, suspendPersistence } from "../../src/app/lib/field-persistence";
import { getNotifications, resetNotificationState } from "../../src/app/lib/errors";

const KEY = "test:blob";

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
  };
})();

Object.defineProperty(globalThis, "localStorage", {
  value: localStorageMock,
  writable: true,
  configurable: true,
});

interface Fields extends Record<string, unknown> {
  a: number;
  b: string[];
  c: { x: boolean };
}

const INITIAL: Fields = { a: 1, b: ["one"], c: { x: false } };

function onDisk(): Record<string, unknown> {
  return JSON.parse(localStorageMock.getItem(KEY) ?? "{}") as Record<string, unknown>;
}

function storageEvent(value: Record<string, unknown> | null, storageArea: Storage | null = null): void {
  window.dispatchEvent(
    new StorageEvent("storage", {
      key: KEY,
      newValue: value === null ? null : JSON.stringify(value),
      storageArea,
    }),
  );
}

function setup() {
  const [store, setStore] = createStore<Fields>(structuredClone(INITIAL));
  const [readOnly, setReadOnly] = createSignal(false);
  const persistence = createFieldPersistence({
    storageKey: KEY,
    snapshot: () => JSON.parse(JSON.stringify(untrack(() => store))) as Record<string, unknown>,
    trackedSnapshot: () => JSON.parse(JSON.stringify(store)) as Record<string, unknown>,
    validate: (parsed) =>
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined,
    apply: (patch) =>
      setStore(
        produce((draft) => {
          Object.assign(draft, patch);
        }),
      ),
    isReadOnly: () => readOnly(),
    failureSource: "test:persist",
    failureMessage: "Persist failed",
  });
  return { store, setStore, persistence, setReadOnly };
}

describe("createFieldPersistence", () => {
  let dispose: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorageMock.clear();
    resetNotificationState();
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function start() {
    const subject = setup();
    createRoot((d) => {
      dispose = d;
      subject.persistence.init();
    });
    return subject;
  }

  it("writes only the changed key on top of what is on disk, after the debounce", () => {
    localStorageMock.setItem(KEY, JSON.stringify({ ...INITIAL, b: ["from-other-tab"] }));
    const { setStore } = start();

    setStore("a", 2);
    expect(onDisk().a).toBe(1);

    vi.advanceTimersByTime(250);
    expect(onDisk()).toEqual({ a: 2, b: ["from-other-tab"], c: { x: false } });
  });

  it("flushes a pending write on dispose and cancels the timer", () => {
    const { setStore } = start();
    setStore("a", 5);
    dispose?.();
    dispose = undefined;
    expect(onDisk().a).toBe(5);
  });

  describe("read-only mode", () => {
    it("writes nothing and adopts nothing while read-only, then writes the pending change once re-enabled", () => {
      const { store, setStore, persistence, setReadOnly } = start();
      setReadOnly(true);

      setStore("a", 9);
      vi.advanceTimersByTime(250);
      persistence.flush();
      expect(localStorageMock.getItem(KEY)).toBeNull();

      storageEvent({ ...INITIAL, b: ["adopted?"] });
      expect(store.b).toEqual(["one"]);

      setReadOnly(false);
      persistence.flush();
      expect(onDisk().a).toBe(9);
    });

    it("does not adopt what is on disk at init while read-only", () => {
      localStorageMock.setItem(KEY, JSON.stringify({ ...INITIAL, a: 7 }));
      const subject = setup();
      subject.setReadOnly(true);
      createRoot((d) => {
        dispose = d;
        subject.persistence.init();
      });
      expect(subject.store.a).toBe(1);
    });
  });

  describe("suspendPersistence", () => {
    afterEach(() => {
      resumePersistence();
    });

    it("blocks writes and adoption in every store until resumed, then writes the pending change", () => {
      const { store, setStore, persistence } = start();
      suspendPersistence();

      setStore("a", 2);
      vi.advanceTimersByTime(250);
      persistence.flush();
      expect(localStorageMock.getItem(KEY)).toBeNull();

      storageEvent({ ...INITIAL, b: ["adopted?"] });
      expect(store.b).toEqual(["one"]);

      resumePersistence();
      persistence.flush();
      expect(onDisk().a).toBe(2);
    });
  });

  describe("catching up when persistence turns back on", () => {
    afterEach(() => {
      resumePersistence();
    });

    it("resumePersistence() adopts what other tabs saved meanwhile and writes this tab's own change", () => {
      const { store, setStore } = start();
      vi.advanceTimersByTime(250);
      suspendPersistence();

      setStore("a", 5);
      localStorageMock.setItem(KEY, JSON.stringify({ ...INITIAL, b: ["from-other-tab"] }));
      storageEvent({ ...INITIAL, b: ["from-other-tab"] });
      expect(store.b).toEqual(["one"]);
      vi.advanceTimersByTime(250);
      expect(onDisk().a).toBe(1);

      resumePersistence();
      expect(store.b).toEqual(["from-other-tab"]);
      expect(store.a).toBe(5);
      vi.advanceTimersByTime(250);
      expect(onDisk()).toEqual({ a: 5, b: ["from-other-tab"], c: { x: false } });
    });

    it("does not reconcile stores that were never initialised or have been disposed", () => {
      const first = setup();
      const getItem = vi.spyOn(localStorageMock, "getItem");
      resumePersistence();
      expect(getItem).not.toHaveBeenCalled();
      expect(first.store.a).toBe(1);

      const { setStore } = start();
      vi.advanceTimersByTime(250);
      dispose?.();
      dispose = undefined;
      getItem.mockClear();
      setStore("a", 2);
      resumePersistence();
      expect(getItem).not.toHaveBeenCalled();
    });

    it("catches up when read-only mode ends", () => {
      const { store, persistence, setReadOnly } = start();
      vi.advanceTimersByTime(250);
      setReadOnly(true);
      localStorageMock.setItem(KEY, JSON.stringify({ ...INITIAL, a: 9 }));
      storageEvent({ ...INITIAL, a: 9 });
      expect(store.a).toBe(1);

      setReadOnly(false);
      expect(store.a).toBe(9);
      persistence.flush();
      expect(onDisk().a).toBe(9);
    });
  });

  describe("storage events", () => {
    it("adopts a key another tab wrote and does not write it back", () => {
      const { store, persistence } = start();
      vi.advanceTimersByTime(250);
      const setItem = vi.spyOn(localStorageMock, "setItem");

      storageEvent({ ...INITIAL, a: 4 });
      expect(store.a).toBe(4);

      vi.advanceTimersByTime(250);
      persistence.flush();
      expect(setItem).not.toHaveBeenCalled();
    });

    it("ignores events from a different storage area", () => {
      const { store } = start();
      storageEvent({ ...INITIAL, a: 4 }, sessionStorage);
      expect(store.a).toBe(1);
    });

    it("accepts events whose storage area is localStorage", () => {
      const { store } = start();
      const area = localStorageMock as unknown as Storage;
      storageEvent({ ...INITIAL, a: 4 }, area);
      expect(store.a).toBe(4);
    });

    it("ignores removals, other keys, and unparseable or non-object values", () => {
      const { store } = start();
      storageEvent(null);
      window.dispatchEvent(new StorageEvent("storage", { key: "other", newValue: JSON.stringify({ a: 8 }) }));
      window.dispatchEvent(new StorageEvent("storage", { key: KEY, newValue: "{broken" }));
      window.dispatchEvent(new StorageEvent("storage", { key: KEY, newValue: "[1]" }));
      expect(store.a).toBe(1);
    });

    it("keeps a key this tab has a pending change to", () => {
      const { store, setStore } = start();
      setStore("a", 3);
      storageEvent({ ...INITIAL, a: 4, b: ["other"] });
      expect(store.a).toBe(3);
      expect(store.b).toEqual(["other"]);

      vi.advanceTimersByTime(250);
      expect(onDisk().a).toBe(3);
    });

    it("still writes a kept local value after the user reverts it to the value last saved", () => {
      const { store, setStore } = start();
      vi.advanceTimersByTime(250);
      localStorageMock.setItem(KEY, JSON.stringify({ ...INITIAL, a: 4 }));

      setStore("a", 3);
      storageEvent({ ...INITIAL, a: 4 });
      expect(store.a).toBe(3);

      // Back to the baseline: nothing differs from the last save, but the user's latest choice
      // must still win over the value the other tab wrote.
      setStore("a", 1);
      vi.advanceTimersByTime(250);
      expect(onDisk().a).toBe(1);
    });

    it("skips reading the stored blob when a commit has nothing pending", () => {
      const { store } = start();
      vi.advanceTimersByTime(250);
      const getItem = vi.spyOn(localStorageMock, "getItem");

      storageEvent({ ...INITIAL, b: ["from-other-tab"] });
      expect(store.b).toEqual(["from-other-tab"]);
      getItem.mockClear();

      vi.advanceTimersByTime(250);
      expect(getItem).not.toHaveBeenCalled();
    });

    it("stops listening after dispose", () => {
      const { store } = start();
      dispose?.();
      dispose = undefined;
      storageEvent({ ...INITIAL, a: 4 });
      expect(store.a).toBe(1);
    });
  });

  describe("requestFullOverwrite", () => {
    it("writes the whole snapshot and ignores other tabs' events until the write lands", () => {
      const { store, setStore, persistence } = start();
      localStorageMock.setItem(KEY, JSON.stringify({ a: 99, b: ["other"], c: { x: true } }));

      persistence.requestFullOverwrite();
      setStore(produce((draft) => Object.assign(draft, INITIAL)));
      persistence.schedule();

      storageEvent({ a: 50, b: ["ignored"], c: { x: true } });
      expect(store.b).toEqual(["one"]);

      vi.advanceTimersByTime(250);
      expect(onDisk()).toEqual(INITIAL);

      storageEvent({ ...INITIAL, a: 6 });
      expect(store.a).toBe(6);
    });
  });

  describe("forceKeys", () => {
    it("writes a key that matches this tab's last save, and resists an incoming event", () => {
      const { store, persistence } = start();
      vi.advanceTimersByTime(250);
      localStorageMock.setItem(KEY, JSON.stringify({ ...INITIAL, a: 77 }));

      persistence.forceKeys(["a"]);
      persistence.schedule();
      storageEvent({ ...INITIAL, a: 88 });
      expect(store.a).toBe(1);

      vi.advanceTimersByTime(250);
      expect(onDisk().a).toBe(1);
    });
  });

  describe("failed writes", () => {
    it("warns, keeps the change pending, and writes it on the next attempt", () => {
      const { setStore, persistence } = start();
      vi.advanceTimersByTime(250);
      setStore("a", 2);

      const setItem = vi.spyOn(localStorageMock, "setItem").mockImplementationOnce(() => {
        throw new DOMException("QuotaExceededError", "QuotaExceededError");
      });
      persistence.flush();
      expect(getNotifications().some((n) => n.source === "test:persist")).toBe(true);
      expect(onDisk().a).toBe(1);

      persistence.flush();
      expect(setItem).toHaveBeenCalledTimes(2);
      expect(onDisk().a).toBe(2);
    });

    it("keeps a pending full overwrite after a failed write", () => {
      const { store, setStore, persistence } = start();
      vi.advanceTimersByTime(250);

      persistence.requestFullOverwrite();
      setStore("a", 3);
      vi.spyOn(localStorageMock, "setItem").mockImplementationOnce(() => {
        throw new DOMException("QuotaExceededError", "QuotaExceededError");
      });
      persistence.flush();

      storageEvent({ ...INITIAL, b: ["ignored"] });
      expect(store.b).toEqual(["one"]);

      persistence.flush();
      expect(onDisk()).toEqual({ a: 3, b: ["one"], c: { x: false } });
    });
  });

  describe("discardPending", () => {
    it("cancels the scheduled write and treats the current contents as saved", () => {
      const { setStore, persistence } = start();
      vi.advanceTimersByTime(250);
      localStorageMock.clear();

      setStore("a", 2);
      persistence.discardPending();
      vi.advanceTimersByTime(250);
      persistence.flush();
      expect(localStorageMock.getItem(KEY)).toBeNull();

      setStore("a", 3);
      persistence.flush();
      expect(onDisk().a).toBe(3);
    });

    it("clears a pending full overwrite and forced keys", () => {
      const { store, persistence } = start();
      persistence.requestFullOverwrite();
      persistence.forceKeys(["a"]);
      persistence.discardPending();

      storageEvent({ ...INITIAL, a: 4 });
      expect(store.a).toBe(4);
    });
  });
});
