import { describe, it, expect, beforeEach } from "vitest";
import {
  getErrors,
  getNotifications,
  getUnreadCount,
  pushError,
  pushNotification,
  dismissError,
  dismissNotificationBySource,
  markAllAsRead,
  clearErrors,
  clearNotifications,
  resetNotificationState,
  startCycleTracking,
  endCycleTracking,
  addMutedSource,
  isMuted,
  clearMutedSources,
} from "../../src/app/lib/errors";
import { createRoot } from "solid-js";

// errors.ts uses module-level signals — clearErrors() in beforeEach is essential
// to prevent state leaking between tests.
beforeEach(() => {
  clearErrors();
  clearMutedSources();
  // Also end any stale cycle tracking
  endCycleTracking();
});

describe("getErrors", () => {
  it("returns empty array initially (after clear)", () => {
    createRoot((dispose) => {
      expect(getErrors()).toEqual([]);
      dispose();
    });
  });
});

describe("getNotifications", () => {
  it("returns same signal as getErrors", () => {
    createRoot((dispose) => {
      pushError("api", "test");
      expect(getNotifications()).toHaveLength(1);
      expect(getErrors()).toHaveLength(1);
      dispose();
    });
  });
});

describe("pushError", () => {
  it("adds an error with auto-generated id and timestamp", () => {
    createRoot((dispose) => {
      pushError("api", "Something went wrong");
      const errs = getErrors();
      expect(errs).toHaveLength(1);
      expect(errs[0].source).toBe("api");
      expect(errs[0].message).toBe("Something went wrong");
      expect(typeof errs[0].id).toBe("string");
      expect(errs[0].id.length).toBeGreaterThan(0);
      expect(typeof errs[0].timestamp).toBe("number");
      expect(errs[0].timestamp).toBeGreaterThan(0);
      dispose();
    });
  });

  it("sets retryable = false by default", () => {
    createRoot((dispose) => {
      pushError("api", "Network error");
      expect(getErrors()[0].retryable).toBe(false);
      dispose();
    });
  });

  it("sets retryable = true when passed", () => {
    createRoot((dispose) => {
      pushError("poll", "Timeout", true);
      expect(getErrors()[0].retryable).toBe(true);
      dispose();
    });
  });

  it("accumulates multiple errors", () => {
    createRoot((dispose) => {
      pushError("api", "Error 1");
      pushError("poll", "Error 2");
      pushError("auth", "Error 3");
      expect(getErrors()).toHaveLength(3);
      dispose();
    });
  });

  it("each error has a unique id", () => {
    createRoot((dispose) => {
      pushError("a", "msg1");
      pushError("b", "msg2");
      const ids = getErrors().map((e) => e.id);
      expect(new Set(ids).size).toBe(2);
      dispose();
    });
  });

  it("creates notification with severity 'error'", () => {
    createRoot((dispose) => {
      pushError("api", "Error happened");
      expect(getErrors()[0].severity).toBe("error");
      dispose();
    });
  });

  it("creates notification with read: false", () => {
    createRoot((dispose) => {
      pushError("api", "Error happened");
      expect(getErrors()[0].read).toBe(false);
      dispose();
    });
  });
});

describe("pushNotification", () => {
  it("creates notification with correct severity and read: false", () => {
    createRoot((dispose) => {
      pushNotification("search", "Results may be incomplete", "warning");
      const notifs = getNotifications();
      expect(notifs).toHaveLength(1);
      expect(notifs[0].source).toBe("search");
      expect(notifs[0].message).toBe("Results may be incomplete");
      expect(notifs[0].severity).toBe("warning");
      expect(notifs[0].read).toBe(false);
      dispose();
    });
  });

  it("supports info severity", () => {
    createRoot((dispose) => {
      pushNotification("graphql", "Using REST fallback", "info", true);
      const notifs = getNotifications();
      expect(notifs[0].severity).toBe("info");
      expect(notifs[0].retryable).toBe(true);
      dispose();
    });
  });

  it("deduplicates by source: resets read and updates timestamp when message changes", () => {
    createRoot((dispose) => {
      pushNotification("search", "First message", "warning");
      const firstNotif = getNotifications()[0];
      // Mark as read to verify it gets reset
      markAllAsRead();
      expect(getNotifications()[0].read).toBe(true);

      pushNotification("search", "Updated message", "warning");
      const notifs = getNotifications();
      expect(notifs).toHaveLength(1);
      expect(notifs[0].message).toBe("Updated message");
      expect(notifs[0].read).toBe(false); // reset to unread
      expect(notifs[0].id).toBe(firstNotif.id); // same id preserved
      dispose();
    });
  });

  it("dedup with same message: no-op — timestamp and read state unchanged", () => {
    createRoot((dispose) => {
      pushNotification("search", "Same message", "warning");
      markAllAsRead();
      const firstTimestamp = getNotifications()[0].timestamp;

      pushNotification("search", "Same message", "warning");
      const notifs = getNotifications();
      expect(notifs).toHaveLength(1);
      expect(notifs[0].read).toBe(true); // NOT reset — same message is no-op
      expect(notifs[0].timestamp).toBe(firstTimestamp); // timestamp unchanged
      dispose();
    });
  });

  it("FIFO cap: push 51 notifications, oldest is dropped", () => {
    createRoot((dispose) => {
      for (let i = 0; i < 51; i++) {
        pushNotification(`source-${i}`, `Message ${i}`, "info");
      }
      const notifs = getNotifications();
      expect(notifs).toHaveLength(50);
      // Oldest (source-0) should be dropped, newest (source-50) should be present
      expect(notifs.find((n) => n.source === "source-0")).toBeUndefined();
      expect(notifs.find((n) => n.source === "source-50")).toBeDefined();
      dispose();
    });
  });
});

describe("dismissError", () => {
  it("removes only the specified error by id", () => {
    createRoot((dispose) => {
      pushError("api", "Error A");
      pushError("poll", "Error B");
      const [errA, errB] = getErrors();
      dismissError(errA.id);
      const remaining = getErrors();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(errB.id);
      dispose();
    });
  });

  it("deduplicates errors by source — replaces message", () => {
    createRoot((dispose) => {
      pushError("api", "First error");
      pushError("api", "Updated error");
      const errs = getErrors();
      expect(errs).toHaveLength(1);
      expect(errs[0].message).toBe("Updated error");
      dispose();
    });
  });

  it("is a no-op for an unknown id", () => {
    createRoot((dispose) => {
      pushError("api", "Error A");
      dismissError("does-not-exist");
      expect(getErrors()).toHaveLength(1);
      dispose();
    });
  });
});

describe("dismissNotificationBySource", () => {
  it("removes all notifications with given source", () => {
    createRoot((dispose) => {
      pushNotification("search", "Warning 1", "warning");
      pushNotification("graphql", "Info 1", "info");
      dismissNotificationBySource("search");
      const notifs = getNotifications();
      expect(notifs).toHaveLength(1);
      expect(notifs[0].source).toBe("graphql");
      dispose();
    });
  });

  it("is a no-op for unknown source", () => {
    createRoot((dispose) => {
      pushNotification("search", "Warning", "warning");
      dismissNotificationBySource("nonexistent");
      expect(getNotifications()).toHaveLength(1);
      dispose();
    });
  });
});

describe("markAllAsRead", () => {
  it("sets all read to true and getUnreadCount returns 0", () => {
    createRoot((dispose) => {
      pushNotification("a", "msg1", "error");
      pushNotification("b", "msg2", "warning");
      pushNotification("c", "msg3", "info");
      expect(getUnreadCount()).toBe(3);
      markAllAsRead();
      expect(getUnreadCount()).toBe(0);
      expect(getNotifications().every((n) => n.read)).toBe(true);
      dispose();
    });
  });
});

describe("getUnreadCount", () => {
  it("returns count of unread notifications", () => {
    createRoot((dispose) => {
      pushNotification("a", "msg1", "error");
      pushNotification("b", "msg2", "warning");
      expect(getUnreadCount()).toBe(2);
      markAllAsRead();
      expect(getUnreadCount()).toBe(0);
      pushNotification("c", "msg3", "info");
      expect(getUnreadCount()).toBe(1);
      dispose();
    });
  });
});

describe("clearErrors / clearNotifications", () => {
  it("removes all errors", () => {
    createRoot((dispose) => {
      pushError("api", "Error 1");
      pushError("poll", "Error 2");
      clearErrors();
      expect(getErrors()).toHaveLength(0);
      dispose();
    });
  });

  it("is safe to call when there are no errors", () => {
    createRoot((dispose) => {
      expect(() => clearErrors()).not.toThrow();
      expect(getErrors()).toHaveLength(0);
      dispose();
    });
  });

  it("clearNotifications also clears the store", () => {
    createRoot((dispose) => {
      pushNotification("a", "msg", "info");
      clearNotifications();
      expect(getNotifications()).toHaveLength(0);
      dispose();
    });
  });
});

describe("cycle tracking", () => {
  it("startCycleTracking + endCycleTracking tracks pushed sources", () => {
    createRoot((dispose) => {
      startCycleTracking();
      pushNotification("search", "Results incomplete", "warning");
      pushNotification("graphql", "REST fallback", "info");
      const tracked = endCycleTracking();
      expect(tracked.has("search")).toBe(true);
      expect(tracked.has("graphql")).toBe(true);
      dispose();
    });
  });

  it("tracks same-message no-ops (still records source)", () => {
    createRoot((dispose) => {
      pushNotification("search", "Same message", "warning");
      startCycleTracking();
      // Same message push is a no-op in dedup, but source should still be tracked
      pushNotification("search", "Same message", "warning");
      const tracked = endCycleTracking();
      expect(tracked.has("search")).toBe(true);
      dispose();
    });
  });

  it("endCycleTracking is safe to call twice (returns empty Set on second call)", () => {
    createRoot((dispose) => {
      startCycleTracking();
      pushNotification("a", "msg", "info");
      endCycleTracking();
      const second = endCycleTracking();
      expect(second.size).toBe(0); // returns empty Set when tracking already ended
      dispose();
    });
  });

  it("tracks nothing when not started", () => {
    createRoot((dispose) => {
      // No startCycleTracking call
      pushNotification("a", "msg", "info");
      const result = endCycleTracking();
      expect(result.size).toBe(0);
      dispose();
    });
  });

  it("startCycleTracking called twice discards first tracking set", () => {
    createRoot((dispose) => {
      startCycleTracking();
      pushNotification("a", "msg1", "info");
      startCycleTracking(); // replaces tracking set — "a" is lost
      pushNotification("b", "msg2", "warning");
      const tracked = endCycleTracking();
      expect(tracked.has("b")).toBe(true);
      expect(tracked.has("a")).toBe(false);
      dispose();
    });
  });
});

describe("resetNotificationState", () => {
  it("clears both notifications and muted sources", () => {
    createRoot((dispose) => {
      pushNotification("api", "Error", "error");
      addMutedSource("api");
      expect(getNotifications()).toHaveLength(1);
      expect(isMuted("api")).toBe(true);

      resetNotificationState();

      expect(getNotifications()).toHaveLength(0);
      expect(isMuted("api")).toBe(false);
      dispose();
    });
  });
});

describe("mutedSources", () => {
  it("addMutedSource and isMuted work together", () => {
    createRoot((dispose) => {
      expect(isMuted("api")).toBe(false);
      addMutedSource("api");
      expect(isMuted("api")).toBe(true);
      expect(isMuted("search")).toBe(false);
      dispose();
    });
  });

  it("clearMutedSources resets all muted sources", () => {
    createRoot((dispose) => {
      addMutedSource("api");
      addMutedSource("search");
      clearMutedSources();
      expect(isMuted("api")).toBe(false);
      expect(isMuted("search")).toBe(false);
      dispose();
    });
  });
});
