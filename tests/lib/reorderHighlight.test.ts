import { describe, it, expect, vi } from "vitest";
import { createRoot, createSignal, batch, type Accessor } from "solid-js";
import { createReorderHighlight } from "../../src/app/lib/reorderHighlight";

describe("createReorderHighlight", () => {
  it("returns an accessor that starts as empty set", () => {
    createRoot((dispose) => {
      const [order] = createSignal<string[]>(["a", "b"]);
      const [locked] = createSignal<string[]>([]);
      const [ignored] = createSignal(0);
      const highlighted = createReorderHighlight(order, locked, ignored);

      expect(highlighted()).toBeInstanceOf(Set);
      expect(highlighted().size).toBe(0);

      dispose();
    });
  });

  it("does not highlight on first render (initialization)", () => {
    createRoot((dispose) => {
      const [order] = createSignal<string[]>(["a", "b", "c"]);
      const [locked] = createSignal<string[]>([]);
      const [ignored] = createSignal(0);
      const highlighted = createReorderHighlight(order, locked, ignored);

      // First render seeds prevOrder — no detection
      expect(highlighted().size).toBe(0);
      dispose();
    });
  });

  it("highlights reordered repos when ignored count is unchanged", () => {
    let highlighted!: Accessor<ReadonlySet<string>>;
    let setOrder!: (v: string[]) => void;
    let disposeRoot!: () => void;

    createRoot((dispose) => {
      const [order, _setOrder] = createSignal<string[]>(["a", "b", "c"]);
      const [locked] = createSignal<string[]>([]);
      const [ignored] = createSignal(0);
      setOrder = _setOrder;
      highlighted = createReorderHighlight(order, locked, ignored);
      disposeRoot = dispose;
    });

    // Seed complete — reorder outside batch to trigger effect synchronously
    setOrder(["c", "a", "b"]);
    expect(highlighted().size).toBeGreaterThan(0);

    disposeRoot();
  });

  it("suppresses highlight when ignored count changes simultaneously with reorder", () => {
    let highlighted!: Accessor<ReadonlySet<string>>;
    let setOrder!: (v: string[]) => void;
    let setIgnored!: (v: number) => void;
    let disposeRoot!: () => void;

    createRoot((dispose) => {
      const [order, _setOrder] = createSignal<string[]>(["a", "b", "c"]);
      const [locked] = createSignal<string[]>([]);
      const [ignored, _setIgnored] = createSignal(0);
      setOrder = _setOrder;
      setIgnored = _setIgnored;
      highlighted = createReorderHighlight(order, locked, ignored);
      disposeRoot = dispose;
    });

    // Reorder AND increment ignored count in single batch — should suppress
    batch(() => {
      setIgnored(1);
      setOrder(["c", "a", "b"]);
    });
    expect(highlighted().size).toBe(0);

    disposeRoot();
  });

  it("resumes highlighting after an ignored-count-change cycle", () => {
    let highlighted!: Accessor<ReadonlySet<string>>;
    let setOrder!: (v: string[]) => void;
    let setIgnored!: (v: number) => void;
    let disposeRoot!: () => void;

    createRoot((dispose) => {
      const [order, _setOrder] = createSignal<string[]>(["a", "b", "c"]);
      const [locked] = createSignal<string[]>([]);
      const [ignored, _setIgnored] = createSignal(0);
      setOrder = _setOrder;
      setIgnored = _setIgnored;
      highlighted = createReorderHighlight(order, locked, ignored);
      disposeRoot = dispose;
    });

    // Suppress via batched ignored count change + reorder
    batch(() => {
      setIgnored(1);
      setOrder(["c", "a", "b"]);
    });
    expect(highlighted().size).toBe(0);

    // Next reorder without ignore change — should highlight again
    setOrder(["b", "c", "a"]);
    expect(highlighted().size).toBeGreaterThan(0);

    disposeRoot();
  });

  it("seeds prevIgnoredCount correctly with non-zero initial value", () => {
    let highlighted!: Accessor<ReadonlySet<string>>;
    let setOrder!: (v: string[]) => void;
    let disposeRoot!: () => void;

    createRoot((dispose) => {
      const [order, _setOrder] = createSignal<string[]>(["a", "b", "c"]);
      const [locked] = createSignal<string[]>([]);
      const [ignored] = createSignal(3);
      setOrder = _setOrder;
      highlighted = createReorderHighlight(order, locked, ignored);
      disposeRoot = dispose;
    });

    // Reorder without changing ignored count (still 3) — should highlight
    setOrder(["c", "a", "b"]);
    expect(highlighted().size).toBeGreaterThan(0);

    disposeRoot();
  });

  it("suppresses highlight when ignored count decrements (un-ignore)", () => {
    let highlighted!: Accessor<ReadonlySet<string>>;
    let setOrder!: (v: string[]) => void;
    let setIgnored!: (v: number) => void;
    let disposeRoot!: () => void;

    createRoot((dispose) => {
      const [order, _setOrder] = createSignal<string[]>(["a", "b", "c"]);
      const [locked] = createSignal<string[]>([]);
      const [ignored, _setIgnored] = createSignal(2);
      setOrder = _setOrder;
      setIgnored = _setIgnored;
      highlighted = createReorderHighlight(order, locked, ignored);
      disposeRoot = dispose;
    });

    // Reorder AND decrement ignored count in single batch — should suppress
    batch(() => {
      setIgnored(1);
      setOrder(["c", "a", "b"]);
    });
    expect(highlighted().size).toBe(0);

    disposeRoot();
  });

  it("suppresses highlight when locked repos change simultaneously with reorder", () => {
    let highlighted!: Accessor<ReadonlySet<string>>;
    let setOrder!: (v: string[]) => void;
    let setLocked!: (v: string[]) => void;
    let disposeRoot!: () => void;

    createRoot((dispose) => {
      const [order, _setOrder] = createSignal<string[]>(["a", "b", "c"]);
      const [locked, _setLocked] = createSignal<string[]>([]);
      const [ignored] = createSignal(0);
      setOrder = _setOrder;
      setLocked = _setLocked;
      highlighted = createReorderHighlight(order, locked, ignored);
      disposeRoot = dispose;
    });

    // Reorder AND add a lock in single batch — should suppress
    batch(() => {
      setLocked(["c"]);
      setOrder(["c", "a", "b"]);
    });
    expect(highlighted().size).toBe(0);

    // Next reorder without lock change — should highlight
    setOrder(["b", "c", "a"]);
    expect(highlighted().size).toBeGreaterThan(0);

    disposeRoot();
  });

  it("clears highlight after 1500ms timeout", () => {
    vi.useFakeTimers();

    let highlighted!: Accessor<ReadonlySet<string>>;
    let setOrder!: (v: string[]) => void;
    let disposeRoot!: () => void;

    createRoot((dispose) => {
      const [order, _setOrder] = createSignal<string[]>(["a", "b", "c"]);
      const [locked] = createSignal<string[]>([]);
      const [ignored] = createSignal(0);
      setOrder = _setOrder;
      highlighted = createReorderHighlight(order, locked, ignored);
      disposeRoot = dispose;
    });

    setOrder(["c", "a", "b"]);
    expect(highlighted().size).toBeGreaterThan(0);

    // Advance past the 1500ms clear timeout
    vi.advanceTimersByTime(1500);
    expect(highlighted().size).toBe(0);

    disposeRoot();
    vi.useRealTimers();
  });
});
