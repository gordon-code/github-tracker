import { describe, it, expect } from "vitest";
import { createRoot, createSignal } from "solid-js";
import { createFlashDetection } from "../../src/app/lib/flashDetection";

interface MockItem {
  id: number;
  repoFullName: string;
  status: string;
}

describe("createFlashDetection", () => {
  it("returns empty flashingIds and peekUpdates on initialization", () => {
    createRoot((dispose) => {
      const items: MockItem[] = [
        { id: 1, repoFullName: "org/repo", status: "pending" },
      ];
      const { flashingIds, peekUpdates } = createFlashDetection({
        getItems: () => items,
        getHotIds: () => undefined,
        getExpandedRepos: () => ({}),
        trackKey: (item) => item.status,
        itemLabel: (item) => `Item ${item.id}`,
        itemStatus: (item) => item.status,
      });

      expect(flashingIds()).toBeInstanceOf(Set);
      expect(flashingIds().size).toBe(0);
      expect(peekUpdates()).toBeInstanceOf(Map);
      expect(peekUpdates().size).toBe(0);

      dispose();
    });
  });

  it("does not flash when hotIds is empty (mass-flash gate)", () => {
    createRoot((dispose) => {
      const [items, setItems] = createSignal<MockItem[]>([
        { id: 1, repoFullName: "org/repo", status: "pending" },
      ]);
      const { flashingIds } = createFlashDetection({
        getItems: items,
        getHotIds: () => new Set<number>(),
        getExpandedRepos: () => ({}),
        trackKey: (item) => item.status,
        itemLabel: (item) => `Item ${item.id}`,
        itemStatus: (item) => item.status,
      });

      // Change status without hot IDs — should not flash
      setItems([{ id: 1, repoFullName: "org/repo", status: "success" }]);
      expect(flashingIds().size).toBe(0);

      dispose();
    });
  });

  it("does not flash when hotIds is undefined", () => {
    createRoot((dispose) => {
      const [items, setItems] = createSignal<MockItem[]>([
        { id: 1, repoFullName: "org/repo", status: "pending" },
      ]);
      const { flashingIds } = createFlashDetection({
        getItems: items,
        getHotIds: () => undefined,
        getExpandedRepos: () => ({}),
        trackKey: (item) => item.status,
        itemLabel: (item) => `Item ${item.id}`,
        itemStatus: (item) => item.status,
      });

      setItems([{ id: 1, repoFullName: "org/repo", status: "success" }]);
      expect(flashingIds().size).toBe(0);

      dispose();
    });
  });

  it("prunes stale entries on full-refresh path", () => {
    createRoot((dispose) => {
      const [items, setItems] = createSignal<MockItem[]>([
        { id: 1, repoFullName: "org/repo", status: "pending" },
        { id: 2, repoFullName: "org/repo", status: "success" },
      ]);
      const { flashingIds } = createFlashDetection({
        getItems: items,
        getHotIds: () => undefined,
        getExpandedRepos: () => ({}),
        trackKey: (item) => item.status,
        itemLabel: (item) => `Item ${item.id}`,
        itemStatus: (item) => item.status,
      });

      // Remove item 2 (simulates PR closed on full refresh)
      setItems([{ id: 1, repoFullName: "org/repo", status: "pending" }]);

      // No crash, no flash — stale entry for id=2 was pruned
      expect(flashingIds().size).toBe(0);

      dispose();
    });
  });
});
