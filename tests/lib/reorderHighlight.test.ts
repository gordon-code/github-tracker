import { describe, it, expect, vi, afterEach } from "vitest";
import { createRoot, createSignal } from "solid-js";
import { createReorderHighlight } from "../../src/app/lib/reorderHighlight";

describe("createReorderHighlight", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("returns an accessor that starts as empty set", () => {
    createRoot((dispose) => {
      const [order] = createSignal<string[]>(["a", "b"]);
      const [locked] = createSignal<string[]>([]);
      const highlighted = createReorderHighlight(order, locked);

      expect(highlighted()).toBeInstanceOf(Set);
      expect(highlighted().size).toBe(0);

      dispose();
    });
  });

  it("does not highlight on first render (initialization)", () => {
    createRoot((dispose) => {
      const [order] = createSignal<string[]>(["a", "b", "c"]);
      const [locked] = createSignal<string[]>([]);
      const highlighted = createReorderHighlight(order, locked);

      // First render seeds prevOrder — no detection
      expect(highlighted().size).toBe(0);
      dispose();
    });
  });

  it("cleans up timeout on dispose", () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    createRoot((dispose) => {
      const [order] = createSignal<string[]>(["a", "b"]);
      const [locked] = createSignal<string[]>([]);
      createReorderHighlight(order, locked);
      dispose();
    });
    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });
});
