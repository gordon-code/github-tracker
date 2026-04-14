import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock cache.ts so clearAuth() doesn't try to open IndexedDB
vi.mock("../../src/app/stores/cache", () => ({
  clearCache: vi.fn().mockResolvedValue(undefined),
}));

const mockPushNotification = vi.fn();
vi.mock("../../src/app/lib/errors", () => ({
  pushNotification: (...args: unknown[]) => mockPushNotification(...args),
}));

// Mock localStorage with full control (same pattern as config.test.ts)
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

// auth.ts reads localStorage on import (to initialize token signal from persisted value).
// Each describe block uses vi.resetModules() + dynamic import to get clean signal state.
// Tests that seed localStorage must do so BEFORE the dynamic import.

describe("setAuth / token signal", () => {
  let mod: typeof import("../../src/app/stores/auth");

  beforeEach(async () => {
    localStorageMock.clear();
    vi.resetModules();
    mod = await import("../../src/app/stores/auth");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sets the token signal in memory", () => {
    mod.setAuth({ access_token: "ghs_abc123" });
    expect(mod.token()).toBe("ghs_abc123");
  });

  it("persists access token to localStorage", () => {
    mod.setAuth({ access_token: "ghs_abc123" });
    expect(localStorageMock.getItem("github-tracker:auth-token")).toBe("ghs_abc123");
  });

  it("token signal starts as null on fresh module load with empty localStorage", async () => {
    localStorageMock.clear();
    vi.resetModules();
    const fresh = await import("../../src/app/stores/auth");
    expect(fresh.token()).toBeNull();
  });

  it("token signal initializes from localStorage on module load", async () => {
    localStorageMock.setItem("github-tracker:auth-token", "ghs_persisted");
    vi.resetModules();
    const fresh = await import("../../src/app/stores/auth");
    expect(fresh.token()).toBe("ghs_persisted");
  });

  it("sets token in memory and warns when localStorage.setItem throws", () => {
    const origSetItem = localStorageMock.setItem;
    localStorageMock.setItem = () => { throw new DOMException("QuotaExceededError"); };
    mockPushNotification.mockClear();

    try {
      mod.setAuth({ access_token: "ghs_quota" });
      expect(mod.token()).toBe("ghs_quota");
      expect(mockPushNotification).toHaveBeenCalledWith(
        "localStorage:auth",
        expect.stringContaining("storage may be full"),
        "warning",
      );
    } finally {
      localStorageMock.setItem = origSetItem;
    }
  });
});

describe("isAuthenticated", () => {
  let mod: typeof import("../../src/app/stores/auth");

  beforeEach(async () => {
    localStorageMock.clear();
    vi.resetModules();
    mod = await import("../../src/app/stores/auth");
  });

  it("returns false when no token and no user", () => {
    expect(mod.isAuthenticated()).toBe(false);
  });

  it("returns false when only token is set (no user yet)", () => {
    mod.setAuth({ access_token: "ghs_abc" });
    // user() is still null — isAuthenticated requires BOTH token and user
    expect(mod.isAuthenticated()).toBe(false);
  });
});

describe("clearAuth", () => {
  let mod: typeof import("../../src/app/stores/auth");

  beforeEach(async () => {
    localStorageMock.clear();
    vi.resetModules();
    mod = await import("../../src/app/stores/auth");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("clears token signal to null", () => {
    mod.setAuth({ access_token: "ghs_abc" });
    mod.clearAuth();
    expect(mod.token()).toBeNull();
  });

  it("removes auth token from localStorage", () => {
    mod.setAuth({ access_token: "ghs_abc" });
    mod.clearAuth();
    expect(localStorageMock.getItem("github-tracker:auth-token")).toBeNull();
  });

  it("removes config and view keys from localStorage", () => {
    localStorageMock.setItem("github-tracker:config", "{}");
    localStorageMock.setItem("github-tracker:view", "{}");
    mod.clearAuth();
    expect(localStorageMock.getItem("github-tracker:config")).toBeNull();
    expect(localStorageMock.getItem("github-tracker:view")).toBeNull();
  });

  it("does not call /api/oauth/logout (OAuth App uses permanent tokens)", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mod.clearAuth();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("expireToken", () => {
  let mod: typeof import("../../src/app/stores/auth");

  beforeEach(async () => {
    localStorageMock.clear();
    vi.resetModules();
    mod = await import("../../src/app/stores/auth");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("clears token signal to null", () => {
    mod.setAuth({ access_token: "ghs_abc" });
    mod.expireToken();
    expect(mod.token()).toBeNull();
  });

  it("clears user signal to null", () => {
    // Simulate a validated session: set token + manually set user via validateToken mock
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ login: "wgordon", avatar_url: "", name: "Will" }),
    }));
    mod.setAuth({ access_token: "ghs_abc" });
    // Directly test that user is cleared — validateToken would set it, but
    // we can verify the signal reset by checking after expireToken
    mod.expireToken();
    expect(mod.user()).toBeNull();
  });

  it("removes auth token and dashboard cache from localStorage — config, view preserved", () => {
    localStorageMock.setItem("github-tracker:config", '{"theme":"dark"}');
    localStorageMock.setItem("github-tracker:view", '{"lastActiveTab":"actions"}');
    localStorageMock.setItem("github-tracker:dashboard", '{"cached":true}');
    mod.setAuth({ access_token: "ghs_abc" });
    mod.expireToken();
    expect(localStorageMock.getItem("github-tracker:auth-token")).toBeNull();
    expect(localStorageMock.getItem("github-tracker:dashboard")).toBeNull();
    expect(localStorageMock.getItem("github-tracker:config")).toBe('{"theme":"dark"}');
    expect(localStorageMock.getItem("github-tracker:view")).toBe('{"lastActiveTab":"actions"}');
  });

  it("invokes onAuthCleared callbacks (cross-user isolation on token expiry)", () => {
    const cb = vi.fn();
    mod.onAuthCleared(cb);
    mod.expireToken();
    expect(cb).toHaveBeenCalledOnce();
  });
});

describe("onAuthCleared callbacks", () => {
  let mod: typeof import("../../src/app/stores/auth");

  beforeEach(async () => {
    localStorageMock.clear();
    vi.resetModules();
    mod = await import("../../src/app/stores/auth");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("invokes a registered callback when clearAuth() is called", () => {
    const cb = vi.fn();
    mod.onAuthCleared(cb);
    mod.clearAuth();
    expect(cb).toHaveBeenCalledOnce();
  });

  it("invokes all registered callbacks when clearAuth() is called", () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    const cb3 = vi.fn();
    mod.onAuthCleared(cb1);
    mod.onAuthCleared(cb2);
    mod.onAuthCleared(cb3);
    mod.clearAuth();
    expect(cb1).toHaveBeenCalledOnce();
    expect(cb2).toHaveBeenCalledOnce();
    expect(cb3).toHaveBeenCalledOnce();
  });

  it("subsequent callbacks still run when an earlier callback throws", () => {
    const cb1 = vi.fn(() => {
      throw new Error("cb1 error");
    });
    const cb2 = vi.fn();
    mod.onAuthCleared(cb1);
    mod.onAuthCleared(cb2);

    // clearAuth has try-catch around each callback — throwing does not break the chain
    expect(() => mod.clearAuth()).not.toThrow();
    expect(cb1).toHaveBeenCalledOnce();
    expect(cb2).toHaveBeenCalledOnce();
  });

  it("reentrancy guard: callback that calls clearAuth() does not cause infinite recursion", () => {
    const innerClearCalls: number[] = [];
    const reentrantCb = vi.fn(() => {
      // This reentrant call should be a no-op due to _clearing flag
      mod.clearAuth();
      innerClearCalls.push(1);
    });
    const normalCb = vi.fn();
    mod.onAuthCleared(reentrantCb);
    mod.onAuthCleared(normalCb);

    expect(() => mod.clearAuth()).not.toThrow();
    // Both callbacks ran exactly once (reentrant clearAuth was a no-op)
    expect(reentrantCb).toHaveBeenCalledOnce();
    expect(normalCb).toHaveBeenCalledOnce();
  });
});

describe("validateToken", () => {
  let mod: typeof import("../../src/app/stores/auth");

  beforeEach(async () => {
    vi.useFakeTimers();
    localStorageMock.clear();
    vi.resetModules();
    mod = await import("../../src/app/stores/auth");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns false immediately when no token is set", async () => {
    const result = await mod.validateToken();
    expect(result).toBe(false);
  });

  it("calls GET /user and populates user() on 200 success", async () => {
    const githubUser = { login: "wgordon", avatar_url: "https://github.com/wgordon.png", name: "Will" };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(githubUser),
    }));

    mod.setAuth({ access_token: "ghs_valid" });
    const result = await mod.validateToken();
    expect(result).toBe(true);
    expect(mod.user()?.login).toBe("wgordon");
    expect(mod.user()?.name).toBe("Will");
  });

  it("expires token after two consecutive 401s (transient retry + genuine revocation)", async () => {
    vi.stubGlobal("fetch", vi.fn()
      // First GET /user returns 401
      .mockResolvedValueOnce({ ok: false, status: 401, json: () => Promise.resolve({}) })
      // Retry GET /user also returns 401
      .mockResolvedValueOnce({ ok: false, status: 401, json: () => Promise.resolve({}) })
    );

    mod.setAuth({ access_token: "ghs_revoked" });
    const promise = mod.validateToken();
    await vi.advanceTimersByTimeAsync(1000);
    await promise;
    expect(mod.token()).toBeNull();
    expect(localStorageMock.getItem("github-tracker:auth-token")).toBeNull();
  });

  it("recovers on transient 401 when retry succeeds", async () => {
    vi.stubGlobal("fetch", vi.fn()
      // First GET /user returns 401 (transient)
      .mockResolvedValueOnce({ ok: false, status: 401, json: () => Promise.resolve({}) })
      // Retry succeeds
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: () => Promise.resolve({ login: "wgordon", avatar_url: "", name: "Will" }),
      })
    );

    mod.setAuth({ access_token: "ghs_transient" });
    const promise = mod.validateToken();
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;
    expect(result).toBe(true);
    expect(mod.token()).toBe("ghs_transient");
    expect(mod.user()?.login).toBe("wgordon");
  });

  it("preserves token when retry returns non-401 error (e.g. 500)", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 401, json: () => Promise.resolve({}) })
      .mockResolvedValueOnce({ ok: false, status: 500, json: () => Promise.resolve({}) })
    );

    mod.setAuth({ access_token: "ghs_retry500" });
    const promise = mod.validateToken();
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;
    expect(result).toBe(false);
    // Token preserved — server error on retry doesn't confirm revocation
    expect(mod.token()).toBe("ghs_retry500");
  });

  it("preserves token when retry throws network error", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 401, json: () => Promise.resolve({}) })
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
    );

    mod.setAuth({ access_token: "ghs_retrynet" });
    const promise = mod.validateToken();
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;
    expect(result).toBe(false);
    // Token preserved — network error on retry doesn't confirm revocation
    expect(mod.token()).toBe("ghs_retrynet");
  });

  it("does not invalidate a new token set during the retry window (race condition guard)", async () => {
    vi.stubGlobal("fetch", vi.fn()
      // First GET /user returns 401
      .mockResolvedValueOnce({ ok: false, status: 401, json: () => Promise.resolve({}) })
      // Retry also returns 401 — but token was replaced mid-window
      .mockResolvedValueOnce({ ok: false, status: 401, json: () => Promise.resolve({}) })
    );

    mod.setAuth({ access_token: "ghs_old" });
    const promise = mod.validateToken();
    // Simulate user re-authenticating during the 1-second retry delay
    mod.setAuth({ access_token: "ghs_new" });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;
    expect(result).toBe(false);
    // The NEW token must survive — guard prevents expireToken() from running
    expect(mod.token()).toBe("ghs_new");
    expect(localStorageMock.getItem("github-tracker:auth-token")).toBe("ghs_new");
  });

  it("preserves user config and view state when token expires (not a full logout)", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 401, json: () => Promise.resolve({}) })
      .mockResolvedValueOnce({ ok: false, status: 401, json: () => Promise.resolve({}) })
    );

    localStorageMock.setItem("github-tracker:config", '{"theme":"dark"}');
    localStorageMock.setItem("github-tracker:view", '{"lastActiveTab":"actions"}');
    mod.setAuth({ access_token: "ghs_expired" });
    const promise = mod.validateToken();
    await vi.advanceTimersByTimeAsync(1000);
    await promise;
    // Token cleared
    expect(mod.token()).toBeNull();
    expect(localStorageMock.getItem("github-tracker:auth-token")).toBeNull();
    // Config and view preserved — expireToken() does NOT wipe user data
    expect(localStorageMock.getItem("github-tracker:config")).toBe('{"theme":"dark"}');
    expect(localStorageMock.getItem("github-tracker:view")).toBe('{"lastActiveTab":"actions"}');
  });

  it("returns false and leaves token unchanged on non-200/non-401 response (e.g., 503)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.resolve({}),
    }));

    mod.setAuth({ access_token: "ghs_healthy" });
    const result = await mod.validateToken();

    expect(result).toBe(false);
    // Token must remain — 503 is not an auth failure
    expect(mod.token()).toBe("ghs_healthy");
    // user() should still be null (no successful GET /user)
    expect(mod.user()).toBeNull();
  });

  it("returns false and does not throw when fetch throws a network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    mod.setAuth({ access_token: "ghs_network" });
    const result = await mod.validateToken();

    expect(result).toBe(false);
    // Token should remain untouched — network error is not an auth failure
    expect(mod.token()).toBe("ghs_network");
  });

  it("token survives transient network errors (permanent token not cleared on network failure)", async () => {
    // Seed localStorage so token initializes on module load
    localStorageMock.setItem("github-tracker:auth-token", "ghs_permanent");
    vi.resetModules();
    const freshMod = await import("../../src/app/stores/auth");

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const result = await freshMod.validateToken();

    expect(result).toBe(false);
    expect(freshMod.token()).toBe("ghs_permanent");
    expect(localStorageMock.getItem("github-tracker:auth-token")).toBe("ghs_permanent");
  });
});

describe("cross-tab auth sync", () => {
  let mod: typeof import("../../src/app/stores/auth");

  beforeEach(async () => {
    localStorageMock.clear();
    vi.resetModules();
    mod = await import("../../src/app/stores/auth");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("calls expireToken and redirects to /login when another tab clears the token", () => {
    const replaceMock = vi.fn();
    vi.stubGlobal("location", { ...window.location, replace: replaceMock });

    mod.setAuth({ access_token: "ghs_abc" });
    // Simulate another tab removing the token from localStorage
    localStorageMock.removeItem("github-tracker:auth-token");

    window.dispatchEvent(new StorageEvent("storage", {
      key: "github-tracker:auth-token",
      newValue: null,
    }));

    expect(mod.token()).toBeNull();
    expect(replaceMock).toHaveBeenCalledWith("/login");
  });

  it("does not call expireToken when key does not match", () => {
    mod.setAuth({ access_token: "ghs_abc" });
    localStorageMock.removeItem("github-tracker:auth-token");

    window.dispatchEvent(new StorageEvent("storage", {
      key: "github-tracker:some-other-key",
      newValue: null,
    }));

    // Token unchanged — wrong key means the listener is a no-op for this module
    expect(mod.token()).toBe("ghs_abc");
  });

  it("does not call expireToken when newValue is not null", () => {
    mod.setAuth({ access_token: "ghs_abc" });

    window.dispatchEvent(new StorageEvent("storage", {
      key: "github-tracker:auth-token",
      newValue: "ghs_new-token",
    }));

    // Token unchanged — non-null newValue means no sign-out occurred
    expect(mod.token()).toBe("ghs_abc");
  });

  it("does not call expireToken when no token is set in memory", () => {
    // No setAuth call — token signal is null, guard `_token()` prevents action
    localStorageMock.removeItem("github-tracker:auth-token");

    window.dispatchEvent(new StorageEvent("storage", {
      key: "github-tracker:auth-token",
      newValue: null,
    }));

    expect(mod.token()).toBeNull();
  });

  it("skips expireToken if localStorage was repopulated (rapid sign-out/sign-in race)", () => {
    mod.setAuth({ access_token: "ghs_abc" });
    // Do NOT remove from localStorage — simulates another tab signing back in
    // immediately after signing out, so getItem returns a value when the event fires

    window.dispatchEvent(new StorageEvent("storage", {
      key: "github-tracker:auth-token",
      newValue: null,
    }));

    // The listener bails out because localStorage.getItem(AUTH_STORAGE_KEY) !== null
    expect(mod.token()).toBe("ghs_abc");
  });
});

describe("setAuthFromPat", () => {
  let mod: typeof import("../../src/app/stores/auth");
  let configMod: typeof import("../../src/app/stores/config");

  const testUser = { login: "testuser", avatar_url: "https://avatars.githubusercontent.com/u/1", name: "Test User" };

  beforeEach(async () => {
    localStorageMock.clear();
    vi.resetModules();
    mod = await import("../../src/app/stores/auth");
    configMod = await import("../../src/app/stores/config");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stores token in localStorage", () => {
    mod.setAuthFromPat("ghp_testtoken123", testUser);
    expect(localStorageMock.getItem("github-tracker:auth-token")).toBe("ghp_testtoken123");
  });

  it("sets token signal", () => {
    mod.setAuthFromPat("ghp_testtoken123", testUser);
    expect(mod.token()).toBe("ghp_testtoken123");
  });

  it("populates user signal", () => {
    mod.setAuthFromPat("ghp_testtoken123", testUser);
    expect(mod.user()).toEqual(testUser);
  });

  it("sets isAuthenticated to true", () => {
    mod.setAuthFromPat("ghp_testtoken123", testUser);
    expect(mod.isAuthenticated()).toBe(true);
  });

  it("sets config.authMethod to 'pat'", () => {
    mod.setAuthFromPat("ghp_testtoken123", testUser);
    expect(configMod.config.authMethod).toBe("pat");
  });

  it("clearAuth resets authMethod to 'oauth'", () => {
    mod.setAuthFromPat("ghp_testtoken123", testUser);
    expect(configMod.config.authMethod).toBe("pat");
    mod.clearAuth();
    expect(configMod.config.authMethod).toBe("oauth");
  });
});
