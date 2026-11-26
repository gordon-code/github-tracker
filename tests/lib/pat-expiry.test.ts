import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRoot } from "solid-js";
import {
  PAT_EXPIRY_DISMISSED_KEY,
  PAT_EXPIRY_NOTIFICATION_SOURCE,
  PAT_SETTINGS_ACTION,
  daysUntilPatExpiry,
  getPatExpiryStatus,
  checkPatExpiryReminder,
  clearPatExpiryDismissal,
  _resetPatExpiryState,
} from "../../src/app/lib/pat-expiry";
import {
  getNotifications,
  dismissError,
  addMutedSource,
  isMuted,
  resetNotificationState,
} from "../../src/app/lib/errors";
import { clearAuth } from "../../src/app/stores/auth";

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, val: string) => {
      store[key] = val;
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

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 25, 12, 0, 0)); // 2026-11-25 12:00:00 local
  localStorageMock.clear();
  resetNotificationState();
  _resetPatExpiryState();
});

afterEach(() => {
  _resetPatExpiryState();
  resetNotificationState();
  localStorageMock.clear();
  vi.useRealTimers();
});

describe("PAT_SETTINGS_ACTION", () => {
  it("points to /settings#data", () => {
    expect(PAT_SETTINGS_ACTION).toEqual({
      label: "Update PAT in Settings",
      href: "/settings#data",
    });
  });
});

describe("daysUntilPatExpiry", () => {
  it("computes exact integer days at boundary dates", () => {
    const now = new Date(2026, 10, 25, 12, 0, 0);
    expect(daysUntilPatExpiry("2026-12-03", now)).toBe(8);
    expect(daysUntilPatExpiry("2026-12-02", now)).toBe(7);
    expect(daysUntilPatExpiry("2026-11-29", now)).toBe(4);
    expect(daysUntilPatExpiry("2026-11-28", now)).toBe(3);
    expect(daysUntilPatExpiry("2026-11-27", now)).toBe(2);
    expect(daysUntilPatExpiry("2026-11-26", now)).toBe(1);
    expect(daysUntilPatExpiry("2026-11-25", now)).toBe(0);
    expect(daysUntilPatExpiry("2026-11-24", now)).toBe(-1);
    expect(daysUntilPatExpiry("2026-10-26", now)).toBe(-30);
  });

  it("is stable across local-day extremes (00:00:01 and 23:59:59)", () => {
    const startOfDay = new Date(2026, 10, 25, 0, 0, 1);
    const endOfDay = new Date(2026, 10, 25, 23, 59, 59);
    expect(daysUntilPatExpiry("2026-11-26", startOfDay)).toBe(1);
    expect(daysUntilPatExpiry("2026-11-26", endOfDay)).toBe(1);
    expect(daysUntilPatExpiry("2026-11-25", startOfDay)).toBe(0);
    expect(daysUntilPatExpiry("2026-11-25", endOfDay)).toBe(0);
  });

  it("is immune to DST spring-forward and fall-back transitions", () => {
    // US DST spring-forward 2026-03-08, fall-back 2026-11-01
    expect(daysUntilPatExpiry("2026-03-09", new Date(2026, 2, 7, 12, 0, 0))).toBe(2);
    expect(daysUntilPatExpiry("2026-11-02", new Date(2026, 9, 31, 12, 0, 0))).toBe(2);
  });

  it("validates leap years and rejects invalid calendar dates or formats", () => {
    const now = new Date(2026, 10, 25, 12, 0, 0);
    expect(daysUntilPatExpiry("2028-02-29", now)).toBe(461);
    expect(daysUntilPatExpiry("2026-02-29", now)).toBeNull();
    expect(daysUntilPatExpiry("2026-04-31", now)).toBeNull();
    expect(daysUntilPatExpiry("2026/11/25", now)).toBeNull();
    expect(daysUntilPatExpiry("", now)).toBeNull();
  });

  it("preserves 2-digit years 0000-0099 parity with z.iso.date() (not mapped to 1900-1999)", () => {
    const now = new Date(2026, 10, 25, 12, 0, 0);
    for (const dateStr of ["0000-01-01", "0000-02-29", "0027-06-01", "0099-12-31"]) {
      const days = daysUntilPatExpiry(dateStr, now);
      expect(days).not.toBeNull();
      expect(Number.isInteger(days)).toBe(true);
      expect(days!).toBeLessThan(-700_000);
    }
  });
});

describe("getPatExpiryStatus", () => {
  const now = new Date(2026, 10, 25, 12, 0, 0);

  it("returns null for null or invalid dates", () => {
    expect(getPatExpiryStatus(null, now)).toBeNull();
    expect(getPatExpiryStatus("2026-02-29", now)).toBeNull();
    expect(getPatExpiryStatus("invalid", now)).toBeNull();
  });

  it("maps exact boundary days to expected tiers, severities, and messages", () => {
    const d8 = getPatExpiryStatus("2026-12-03", now);
    expect(d8).toMatchObject({ tier: "ok", daysRemaining: 8, severity: "info" });

    const d7 = getPatExpiryStatus("2026-12-02", now);
    expect(d7).toMatchObject({ tier: "7d", daysRemaining: 7, severity: "warning" });
    expect(d7?.message).toContain("within 7 days");

    const d4 = getPatExpiryStatus("2026-11-29", now);
    expect(d4).toMatchObject({ tier: "7d", daysRemaining: 4, severity: "warning" });

    const d3 = getPatExpiryStatus("2026-11-28", now);
    expect(d3).toMatchObject({ tier: "3d", daysRemaining: 3, severity: "warning" });
    expect(d3?.message).toContain("within 3 days");

    const d2 = getPatExpiryStatus("2026-11-27", now);
    expect(d2).toMatchObject({ tier: "3d", daysRemaining: 2, severity: "warning" });

    const d1 = getPatExpiryStatus("2026-11-26", now);
    expect(d1).toMatchObject({ tier: "1d", daysRemaining: 1, severity: "error" });
    expect(d1?.message).toContain("tomorrow");

    const d0 = getPatExpiryStatus("2026-11-25", now);
    expect(d0).toMatchObject({ tier: "1d", daysRemaining: 0, severity: "error" });
    expect(d0?.message).toContain("today");

    const dm1 = getPatExpiryStatus("2026-11-24", now);
    expect(dm1).toMatchObject({ tier: "expired", daysRemaining: -1, severity: "error" });
    expect(dm1?.message).toContain("expired on 2026-11-24");

    const dm30 = getPatExpiryStatus("2026-10-26", now);
    expect(dm30).toMatchObject({ tier: "expired", daysRemaining: -30, severity: "error" });
  });
});

describe("checkPatExpiryReminder & dismissal persistence", () => {
  it("persists ${date}:${tier} on dismissError(id) and stays suppressed across reloads at same tier", () => {
    createRoot((dispose) => {
      const expiresAt = "2026-12-02"; // 7 days from 2026-11-25 -> "7d"
      checkPatExpiryReminder("pat", expiresAt);

      const notifs = getNotifications();
      expect(notifs).toHaveLength(1);
      expect(notifs[0].source).toBe(PAT_EXPIRY_NOTIFICATION_SOURCE);
      expect(notifs[0].severity).toBe("warning");
      expect(notifs[0].action).toEqual(PAT_SETTINGS_ACTION);

      dismissError(notifs[0].id);
      expect(localStorage.getItem(PAT_EXPIRY_DISMISSED_KEY)).toBe("2026-12-02:7d");
      expect(getNotifications()).toHaveLength(0);

      // Repeated check at same tier stays suppressed
      checkPatExpiryReminder("pat", expiresAt);
      expect(getNotifications()).toHaveLength(0);

      // Simulate page reload: reset in-memory state, keep localStorage
      _resetPatExpiryState();
      resetNotificationState();
      checkPatExpiryReminder("pat", expiresAt);
      expect(getNotifications()).toHaveLength(0);

      dispose();
    });
  });

  it("persists ${date}:${tier} when dismissed via addMutedSource('pat-expiry')", () => {
    createRoot((dispose) => {
      checkPatExpiryReminder("pat", "2026-12-02");
      expect(getNotifications()).toHaveLength(1);

      addMutedSource(PAT_EXPIRY_NOTIFICATION_SOURCE);
      expect(localStorage.getItem(PAT_EXPIRY_DISMISSED_KEY)).toBe("2026-12-02:7d");
      dispose();
    });
  });

  it("escalates and re-pushes notification when advancing across tiers (7d -> 3d -> 1d -> expired)", () => {
    createRoot((dispose) => {
      const expiresAt = "2026-12-02";

      // Day -7: 7d tier -> dismiss
      checkPatExpiryReminder("pat", expiresAt);
      expect(getNotifications()).toHaveLength(1);
      dismissError(getNotifications()[0].id);
      expect(localStorage.getItem(PAT_EXPIRY_DISMISSED_KEY)).toBe("2026-12-02:7d");

      // Advance to Day -3 (2026-11-29): 3d tier -> re-pushes
      vi.setSystemTime(new Date(2026, 10, 29, 12, 0, 0));
      checkPatExpiryReminder("pat", expiresAt);
      expect(getNotifications()).toHaveLength(1);
      expect(getNotifications()[0].severity).toBe("warning");
      expect(getNotifications()[0].message).toContain("within 3 days");
      dismissError(getNotifications()[0].id);
      expect(localStorage.getItem(PAT_EXPIRY_DISMISSED_KEY)).toBe("2026-12-02:3d");

      // Advance to Day -1 (2026-12-01): 1d tier -> re-pushes
      vi.setSystemTime(new Date(2026, 11, 1, 12, 0, 0));
      checkPatExpiryReminder("pat", expiresAt);
      expect(getNotifications()).toHaveLength(1);
      expect(getNotifications()[0].severity).toBe("error");
      expect(getNotifications()[0].message).toContain("tomorrow");
      dismissError(getNotifications()[0].id);
      expect(localStorage.getItem(PAT_EXPIRY_DISMISSED_KEY)).toBe("2026-12-02:1d");

      // Advance to Day +1 (2026-12-03): expired tier -> re-pushes
      vi.setSystemTime(new Date(2026, 11, 3, 12, 0, 0));
      checkPatExpiryReminder("pat", expiresAt);
      expect(getNotifications()).toHaveLength(1);
      expect(getNotifications()[0].severity).toBe("error");
      expect(getNotifications()[0].message).toContain("expired on 2026-12-02");

      dispose();
    });
  });

  it("clearPatExpiryDismissal() removes storage key, clears active key, and dismisses active notification", () => {
    createRoot((dispose) => {
      checkPatExpiryReminder("pat", "2026-12-02");
      expect(getNotifications()).toHaveLength(1);

      dismissError(getNotifications()[0].id);
      expect(localStorage.getItem(PAT_EXPIRY_DISMISSED_KEY)).toBe("2026-12-02:7d");

      // Push again at escalated tier so there's an active notification
      vi.setSystemTime(new Date(2026, 10, 29, 12, 0, 0));
      checkPatExpiryReminder("pat", "2026-12-02");
      expect(getNotifications()).toHaveLength(1);

      clearPatExpiryDismissal();
      expect(localStorage.getItem(PAT_EXPIRY_DISMISSED_KEY)).toBeNull();
      expect(getNotifications()).toHaveLength(0);

      // Re-checking at same tier pushes again since dismissal was cleared
      checkPatExpiryReminder("pat", "2026-12-02");
      expect(getNotifications()).toHaveLength(1);

      dispose();
    });
  });

  it("dismisses active notification when date is extended to >7d or authMethod switches to oauth", () => {
    createRoot((dispose) => {
      checkPatExpiryReminder("pat", "2026-12-02");
      expect(getNotifications()).toHaveLength(1);

      // Extend date to >7d (8d)
      checkPatExpiryReminder("pat", "2026-12-03");
      expect(getNotifications()).toHaveLength(0);

      // Re-trigger and switch to oauth
      checkPatExpiryReminder("pat", "2026-12-02");
      expect(getNotifications()).toHaveLength(1);
      checkPatExpiryReminder("oauth", "2026-12-02");
      expect(getNotifications()).toHaveLength(0);

      dispose();
    });
  });

  it("QA-001/STRUCT-004/STRUCT-101: clearPatExpiryDismissal() and tier escalation unmute 'pat-expiry' after addMutedSource('pat-expiry')", () => {
    createRoot((dispose) => {
      const expiresAt = "2026-12-02";

      // 1. Dismiss all (addMutedSource) at 7d tier -> tier escalation to 3d unmutes
      checkPatExpiryReminder("pat", expiresAt);
      addMutedSource(PAT_EXPIRY_NOTIFICATION_SOURCE);
      expect(isMuted(PAT_EXPIRY_NOTIFICATION_SOURCE)).toBe(true);

      vi.setSystemTime(new Date(2026, 10, 29, 12, 0, 0)); // 3d tier
      checkPatExpiryReminder("pat", expiresAt);
      expect(isMuted(PAT_EXPIRY_NOTIFICATION_SOURCE)).toBe(false);
      expect(getNotifications()).toHaveLength(1);

      // 2. Dismiss all again, then clearPatExpiryDismissal() -> unmutes
      addMutedSource(PAT_EXPIRY_NOTIFICATION_SOURCE);
      expect(isMuted(PAT_EXPIRY_NOTIFICATION_SOURCE)).toBe(true);

      clearPatExpiryDismissal();
      expect(isMuted(PAT_EXPIRY_NOTIFICATION_SOURCE)).toBe(false);

      dispose();
    });
  });

  it("falls back to in-memory dismissal when localStorage throws QuotaExceededError", () => {
    const quotaErr = new DOMException("Quota exceeded", "QuotaExceededError");
    const getSpy = vi.spyOn(localStorageMock, "getItem").mockImplementation(() => {
      throw quotaErr;
    });
    const setSpy = vi.spyOn(localStorageMock, "setItem").mockImplementation(() => {
      throw quotaErr;
    });

    createRoot((dispose) => {
      const expiresAt = "2026-12-02"; // 7d tier from 2026-11-25

      checkPatExpiryReminder("pat", expiresAt);
      expect(getNotifications()).toHaveLength(1);

      // Dismiss at 7d tier while localStorage throws
      dismissError(getNotifications()[0].id);
      expect(getNotifications()).toHaveLength(0);

      // Repeated check at same tier stays suppressed via in-memory fallback
      checkPatExpiryReminder("pat", expiresAt);
      expect(getNotifications()).toHaveLength(0);

      // Escalating to next tier (3d) still re-pushes
      vi.setSystemTime(new Date(2026, 10, 29, 12, 0, 0));
      checkPatExpiryReminder("pat", expiresAt);
      expect(getNotifications()).toHaveLength(1);
      expect(getNotifications()[0].message).toContain("within 3 days");

      // Dismiss at 3d tier, then clearPatExpiryDismissal() clears in-memory fallback
      dismissError(getNotifications()[0].id);
      expect(getNotifications()).toHaveLength(0);
      clearPatExpiryDismissal();
      checkPatExpiryReminder("pat", expiresAt);
      expect(getNotifications()).toHaveLength(1);

      // Dismiss again in quota-blocked mode, then clearAuth() clears in-memory fallback via onAuthCleared
      dismissError(getNotifications()[0].id);
      expect(getNotifications()).toHaveLength(0);
      clearAuth();
      checkPatExpiryReminder("pat", expiresAt);
      expect(getNotifications()).toHaveLength(1);

      dispose();
    });

    getSpy.mockRestore();
    setSpy.mockRestore();
  });

  it("respects external localStorage removal of PAT_EXPIRY_DISMISSED_KEY on SPA sign-out/re-login", () => {
    createRoot((dispose) => {
      const expiresAt = "2026-12-02"; // 7d tier from 2026-11-25

      checkPatExpiryReminder("pat", expiresAt);
      expect(getNotifications()).toHaveLength(1);

      dismissError(getNotifications()[0].id);
      expect(localStorageMock.getItem(PAT_EXPIRY_DISMISSED_KEY)).toBe("2026-12-02:7d");

      // Simulate external removal (e.g., setAuthFromPat / clearAuth) with healthy localStorage
      localStorageMock.removeItem(PAT_EXPIRY_DISMISSED_KEY);

      checkPatExpiryReminder("pat", expiresAt);
      expect(getNotifications()).toHaveLength(1);

      dispose();
    });
  });
});
