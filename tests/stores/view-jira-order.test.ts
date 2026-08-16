import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRoot } from "solid-js";
import {
  viewState,
  resetViewState,
  setJiraCustomOrder,
  pruneJiraCustomOrder,
  initViewPersistence,
  ViewStateSchema,
  VIEW_STORAGE_KEY,
  JIRA_CUSTOM_ORDER_CAP,
} from "../../src/app/stores/view";

describe("jira custom order store actions", () => {
  beforeEach(() => {
    resetViewState();
  });

  describe("setJiraCustomOrder", () => {
    it("replaces the array wholesale", () => {
      setJiraCustomOrder(["PROJ-1", "PROJ-2", "PROJ-3"]);
      expect(viewState.jiraCustomOrder).toEqual(["PROJ-1", "PROJ-2", "PROJ-3"]);
    });

    it("overwrites a previous order", () => {
      setJiraCustomOrder(["PROJ-1", "PROJ-2"]);
      setJiraCustomOrder(["PROJ-3", "PROJ-1"]);
      expect(viewState.jiraCustomOrder).toEqual(["PROJ-3", "PROJ-1"]);
    });

    it("truncates to JIRA_CUSTOM_ORDER_CAP when longer", () => {
      const oversized = Array.from({ length: JIRA_CUSTOM_ORDER_CAP + 50 }, (_, i) => `KEY-${i}`);
      setJiraCustomOrder(oversized);
      expect(viewState.jiraCustomOrder.length).toBe(JIRA_CUSTOM_ORDER_CAP);
      expect(viewState.jiraCustomOrder[0]).toBe("KEY-0");
      expect(viewState.jiraCustomOrder[JIRA_CUSTOM_ORDER_CAP - 1]).toBe(`KEY-${JIRA_CUSTOM_ORDER_CAP - 1}`);
    });

    it("accepts an empty array", () => {
      setJiraCustomOrder(["PROJ-1"]);
      setJiraCustomOrder([]);
      expect(viewState.jiraCustomOrder).toEqual([]);
    });

    it("does not truncate when exactly at cap", () => {
      const exact = Array.from({ length: JIRA_CUSTOM_ORDER_CAP }, (_, i) => `KEY-${i}`);
      setJiraCustomOrder(exact);
      expect(viewState.jiraCustomOrder.length).toBe(JIRA_CUSTOM_ORDER_CAP);
    });
  });

  describe("pruneJiraCustomOrder", () => {
    it("drops stale keys and preserves order of active ones", () => {
      setJiraCustomOrder(["PROJ-1", "PROJ-2", "PROJ-3", "PROJ-4"]);
      pruneJiraCustomOrder(new Set(["PROJ-1", "PROJ-3"]));
      expect(viewState.jiraCustomOrder).toEqual(["PROJ-1", "PROJ-3"]);
    });

    it("is a no-op when the order is empty", () => {
      pruneJiraCustomOrder(new Set(["PROJ-1"]));
      expect(viewState.jiraCustomOrder).toEqual([]);
    });

    it("is a no-op when all keys are active", () => {
      setJiraCustomOrder(["PROJ-1", "PROJ-2"]);
      pruneJiraCustomOrder(new Set(["PROJ-1", "PROJ-2", "PROJ-3"]));
      expect(viewState.jiraCustomOrder).toEqual(["PROJ-1", "PROJ-2"]);
    });

    it("clears the order when no keys are active", () => {
      setJiraCustomOrder(["PROJ-1", "PROJ-2"]);
      pruneJiraCustomOrder(new Set(["PROJ-99"]));
      expect(viewState.jiraCustomOrder).toEqual([]);
    });
  });

  describe("resetViewState", () => {
    it("clears jiraCustomOrder", () => {
      setJiraCustomOrder(["PROJ-1", "PROJ-2"]);
      resetViewState();
      expect(viewState.jiraCustomOrder).toEqual([]);
    });

    it("resets sortField to 'custom'", () => {
      resetViewState();
      expect(viewState.tabFilters.jiraAssigned.sortField).toBe("custom");
    });
  });

  describe("schema defaults", () => {
    it("defaults jiraAssigned.sortField to 'custom' on fresh parse", () => {
      const result = ViewStateSchema.parse({});
      expect(result.tabFilters.jiraAssigned.sortField).toBe("custom");
    });

    it("defaults jiraCustomOrder to empty array on fresh parse", () => {
      const result = ViewStateSchema.parse({});
      expect(result.jiraCustomOrder).toEqual([]);
    });

    it("preserves existing sortField from persisted state", () => {
      const result = ViewStateSchema.parse({
        tabFilters: {
          jiraAssigned: { sortField: "priority", sortDirection: "asc", scope: "assigned", statusCategory: "all", priority: "all" },
        },
      });
      expect(result.tabFilters.jiraAssigned.sortField).toBe("priority");
    });
  });
});

describe("cross-tab sync for jiraCustomOrder", () => {
  let dispose: (() => void) | undefined;

  beforeEach(() => {
    resetViewState();
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  function setupPersistence() {
    createRoot((d) => {
      dispose = d;
      initViewPersistence();
    });
  }

  function dispatchStorageEvent(newValue: string | null) {
    window.dispatchEvent(new StorageEvent("storage", {
      key: VIEW_STORAGE_KEY,
      newValue,
    }));
  }

  it("updates jiraCustomOrder from another tab's storage write", () => {
    setupPersistence();
    const blob = JSON.stringify({ jiraCustomOrder: ["PROJ-A", "PROJ-B"] });
    dispatchStorageEvent(blob);
    expect(viewState.jiraCustomOrder).toEqual(["PROJ-A", "PROJ-B"]);
  });

  it("ignores storage events for unrelated keys", () => {
    setupPersistence();
    setJiraCustomOrder(["PROJ-1"]);
    window.dispatchEvent(new StorageEvent("storage", {
      key: "some-other-key",
      newValue: JSON.stringify({ jiraCustomOrder: ["PROJ-X"] }),
    }));
    expect(viewState.jiraCustomOrder).toEqual(["PROJ-1"]);
  });

  it("rejects incoming blob exceeding JIRA_CUSTOM_ORDER_CAP (safeParse fails)", () => {
    setupPersistence();
    setJiraCustomOrder(["PROJ-1"]);
    const oversized = Array.from({ length: JIRA_CUSTOM_ORDER_CAP + 100 }, (_, i) => `KEY-${i}`);
    dispatchStorageEvent(JSON.stringify({ jiraCustomOrder: oversized }));
    expect(viewState.jiraCustomOrder).toEqual(["PROJ-1"]);
  });

  it("does not touch other viewState fields when syncing jiraCustomOrder", () => {
    setupPersistence();
    const blob = JSON.stringify({
      lastActiveTab: "actions",
      jiraCustomOrder: ["PROJ-Z"],
    });
    dispatchStorageEvent(blob);
    expect(viewState.jiraCustomOrder).toEqual(["PROJ-Z"]);
    expect(viewState.lastActiveTab).toBe("issues");
  });

  it("handles malformed JSON in newValue without throwing", () => {
    setupPersistence();
    setJiraCustomOrder(["PROJ-1"]);
    expect(() => dispatchStorageEvent("not valid json")).not.toThrow();
    expect(viewState.jiraCustomOrder).toEqual(["PROJ-1"]);
  });

  it("ignores null newValue", () => {
    setupPersistence();
    setJiraCustomOrder(["PROJ-1"]);
    dispatchStorageEvent(null);
    expect(viewState.jiraCustomOrder).toEqual(["PROJ-1"]);
  });

  it("is a no-op when incoming order matches current (dedup guard)", () => {
    setupPersistence();
    setJiraCustomOrder(["PROJ-1", "PROJ-2"]);
    const blob = JSON.stringify({ jiraCustomOrder: ["PROJ-1", "PROJ-2"] });
    dispatchStorageEvent(blob);
    expect(viewState.jiraCustomOrder).toEqual(["PROJ-1", "PROJ-2"]);
  });

  it("removes listener after dispose so subsequent events have no effect", () => {
    setupPersistence();
    dispose?.();
    dispose = undefined;
    dispatchStorageEvent(JSON.stringify({ jiraCustomOrder: ["PROJ-NEW"] }));
    expect(viewState.jiraCustomOrder).toEqual([]);
  });
});
