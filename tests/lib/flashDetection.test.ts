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
        isRepoExpanded: () => false,
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
        isRepoExpanded: () => false,
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
        isRepoExpanded: () => false,
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
        isRepoExpanded: () => false,
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

  it("builds a peek update when a hot-polled item changes status and its repo is collapsed", async () => {
    await createRoot(async (dispose) => {
      const [items, setItems] = createSignal<MockItem[]>([
        { id: 1, repoFullName: "org/repo", status: "pending" },
      ]);
      const { flashingIds, peekUpdates } = createFlashDetection({
        getItems: items,
        getHotIds: () => new Set([1]),
        isRepoExpanded: () => false,
        trackKey: (item) => item.status,
        itemLabel: (item) => `Item ${item.id}`,
        itemStatus: (item) => item.status,
      });

      // Let the initial effect seed prevValues (Solid schedules effects as microtasks)
      await Promise.resolve();

      // Status change on a hot-polled item whose repo is collapsed — peek expected
      setItems([{ id: 1, repoFullName: "org/repo", status: "success" }]);
      await Promise.resolve();

      expect(flashingIds().has(1)).toBe(true);
      expect(peekUpdates().size).toBe(1);
      expect(peekUpdates().get("org/repo")).toEqual({
        itemLabel: "Item 1",
        newStatus: "success",
      });

      dispose();
    });
  });

  it("suppresses the peek update when the item's repo is expanded", async () => {
    await createRoot(async (dispose) => {
      const [items, setItems] = createSignal<MockItem[]>([
        { id: 1, repoFullName: "org/repo", status: "pending" },
      ]);
      const { flashingIds, peekUpdates } = createFlashDetection({
        getItems: items,
        getHotIds: () => new Set([1]),
        isRepoExpanded: () => true,
        trackKey: (item) => item.status,
        itemLabel: (item) => `Item ${item.id}`,
        itemStatus: (item) => item.status,
      });

      // Let the initial effect seed prevValues (Solid schedules effects as microtasks)
      await Promise.resolve();

      // Status change on a hot-polled item whose repo is expanded — flash still
      // fires, but the peek preview is suppressed for the expanded repo
      setItems([{ id: 1, repoFullName: "org/repo", status: "success" }]);
      await Promise.resolve();

      expect(flashingIds().has(1)).toBe(true);
      expect(peekUpdates().size).toBe(0);

      dispose();
    });
  });

  it("aggregates the peek label when multiple items in a collapsed repo change", async () => {
    await createRoot(async (dispose) => {
      const [items, setItems] = createSignal<MockItem[]>([
        { id: 1, repoFullName: "org/repo", status: "pending" },
        { id: 2, repoFullName: "org/repo", status: "pending" },
      ]);
      const { peekUpdates } = createFlashDetection({
        getItems: items,
        getHotIds: () => new Set([1, 2]),
        isRepoExpanded: () => false,
        trackKey: (item) => item.status,
        itemLabel: (item) => `Item ${item.id}`,
        itemStatus: (item) => item.status,
      });

      // Let the initial effect seed prevValues (Solid schedules effects as microtasks)
      await Promise.resolve();

      // Two hot-polled items in the same collapsed repo change — the peek label
      // aggregates into a "first + N more" summary. The differing statuses confirm
      // the aggregated newStatus reflects the first changed item, not the last.
      setItems([
        { id: 1, repoFullName: "org/repo", status: "success" },
        { id: 2, repoFullName: "org/repo", status: "failure" },
      ]);
      await Promise.resolve();

      expect(peekUpdates().size).toBe(1);
      expect(peekUpdates().get("org/repo")).toEqual({
        itemLabel: "Item 1 + 1 more",
        newStatus: "success",
      });

      dispose();
    });
  });
});
