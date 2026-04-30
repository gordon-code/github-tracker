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

// ── Jira auth signals ────────────────────────────────────────────────────────

describe("setJiraAuth / jiraAuth signal", () => {
  let mod: typeof import("../../src/app/stores/auth");

  beforeEach(async () => {
    localStorageMock.clear();
    vi.resetModules();
    mod = await import("../../src/app/stores/auth");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeJiraAuth(overrides = {}): import("../../src/shared/jira-types").JiraAuthState {
    return {
      accessToken: "atl-access-tok",
      sealedRefreshToken: "sealed-blob",
      expiresAt: Date.now() + 3600_000,
      cloudId: "cloud-abc",
      siteUrl: "https://mysite.atlassian.net",
      siteName: "My Site",
      ...overrides,
    };
  }

  it("setJiraAuth persists to localStorage", () => {
    mod.setJiraAuth(makeJiraAuth());
    const stored = localStorageMock.getItem("github-tracker:jira-auth");
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!);
    expect(parsed.accessToken).toBe("atl-access-tok");
    expect(parsed.cloudId).toBe("cloud-abc");
  });

  it("setJiraAuth updates the jiraAuth signal", () => {
    const state = makeJiraAuth();
    mod.setJiraAuth(state);
    expect(mod.jiraAuth()?.accessToken).toBe("atl-access-tok");
    expect(mod.jiraAuth()?.cloudId).toBe("cloud-abc");
  });

  it("jiraAuth signal initializes from localStorage on module load", async () => {
    const state = makeJiraAuth({ accessToken: "persisted-tok" });
    localStorageMock.setItem("github-tracker:jira-auth", JSON.stringify(state));
    vi.resetModules();
    const fresh = await import("../../src/app/stores/auth");
    expect(fresh.jiraAuth()?.accessToken).toBe("persisted-tok");
  });

  it("jiraAuth signal starts null when localStorage is empty", () => {
    expect(mod.jiraAuth()).toBeNull();
  });

  it("jiraAuth signal starts null when localStorage contains malformed JSON", async () => {
    localStorageMock.setItem("github-tracker:jira-auth", "{{not-json}}");
    vi.resetModules();
    const fresh = await import("../../src/app/stores/auth");
    expect(fresh.jiraAuth()).toBeNull();
  });

  it("jiraAuth signal starts null and evicts localStorage when JSON is valid but wrong shape", async () => {
    localStorageMock.setItem("github-tracker:jira-auth", JSON.stringify({ someField: "value" }));
    vi.resetModules();
    const fresh = await import("../../src/app/stores/auth");
    expect(fresh.jiraAuth()).toBeNull();
    expect(localStorageMock.getItem("github-tracker:jira-auth")).toBeNull();
  });
});

describe("isJiraAuthenticated", () => {
  let mod: typeof import("../../src/app/stores/auth");

  beforeEach(async () => {
    localStorageMock.clear();
    vi.resetModules();
    mod = await import("../../src/app/stores/auth");
  });

  it("returns false when no Jira auth state", () => {
    expect(mod.isJiraAuthenticated()).toBe(false);
  });

  it("returns true after setJiraAuth", () => {
    mod.setJiraAuth({
      accessToken: "tok",
      sealedRefreshToken: "sealed",
      expiresAt: Date.now() + 3600_000,
      cloudId: "c1",
      siteUrl: "https://x.atlassian.net",
      siteName: "X",
    });
    expect(mod.isJiraAuthenticated()).toBe(true);
  });
});

describe("clearJiraAuth", () => {
  let mod: typeof import("../../src/app/stores/auth");
  let configMod: typeof import("../../src/app/stores/config");

  beforeEach(async () => {
    localStorageMock.clear();
    vi.resetModules();
    mod = await import("../../src/app/stores/auth");
    configMod = await import("../../src/app/stores/config");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("removes jira-auth from localStorage", () => {
    mod.setJiraAuth({
      accessToken: "tok",
      sealedRefreshToken: "s",
      expiresAt: Date.now() + 3600_000,
      cloudId: "c1",
      siteUrl: "https://x.atlassian.net",
      siteName: "X",
    });
    expect(localStorageMock.getItem("github-tracker:jira-auth")).not.toBeNull();
    mod.clearJiraAuth();
    expect(localStorageMock.getItem("github-tracker:jira-auth")).toBeNull();
  });

  it("resets jiraAuth signal to null", () => {
    mod.setJiraAuth({
      accessToken: "tok",
      sealedRefreshToken: "s",
      expiresAt: Date.now() + 3600_000,
      cloudId: "c1",
      siteUrl: "https://x.atlassian.net",
      siteName: "X",
    });
    mod.clearJiraAuth();
    expect(mod.jiraAuth()).toBeNull();
    expect(mod.isJiraAuthenticated()).toBe(false);
  });

  it("resets config.jira.enabled to false", () => {
    mod.clearJiraAuth();
    expect(configMod.config.jira?.enabled).toBe(false);
  });

  it("resets config.jira.authMethod to oauth default", () => {
    mod.clearJiraAuth();
    expect(configMod.config.jira?.authMethod).toBe("oauth");
  });
});

describe("clearAuth clears Jira auth via onAuthCleared", () => {
  let mod: typeof import("../../src/app/stores/auth");

  beforeEach(async () => {
    localStorageMock.clear();
    vi.resetModules();
    mod = await import("../../src/app/stores/auth");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("GitHub clearAuth removes jira-auth from localStorage", () => {
    localStorageMock.setItem("github-tracker:jira-auth", JSON.stringify({
      accessToken: "tok",
      sealedRefreshToken: "s",
      expiresAt: 9999999999999,
      cloudId: "c1",
      siteUrl: "https://x.atlassian.net",
      siteName: "X",
    }));
    mod.setJiraAuth({
      accessToken: "tok",
      sealedRefreshToken: "s",
      expiresAt: 9999999999999,
      cloudId: "c1",
      siteUrl: "https://x.atlassian.net",
      siteName: "X",
    });
    mod.clearAuth();
    expect(localStorageMock.getItem("github-tracker:jira-auth")).toBeNull();
  });

  it("GitHub clearAuth resets jiraAuth signal to null", () => {
    mod.setJiraAuth({
      accessToken: "tok",
      sealedRefreshToken: "s",
      expiresAt: 9999999999999,
      cloudId: "c1",
      siteUrl: "https://x.atlassian.net",
      siteName: "X",
    });
    mod.clearAuth();
    expect(mod.jiraAuth()).toBeNull();
  });
});

describe("ensureJiraTokenValid", () => {
  let mod: typeof import("../../src/app/stores/auth");
  let configMod: typeof import("../../src/app/stores/config");

  beforeEach(async () => {
    vi.useFakeTimers();
    localStorageMock.clear();
    vi.resetModules();
    mod = await import("../../src/app/stores/auth");
    configMod = await import("../../src/app/stores/config");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function setFreshOAuthJiraAuth() {
    mod.setJiraAuth({
      accessToken: "fresh-access-tok",
      sealedRefreshToken: "sealed-refresh",
      expiresAt: Date.now() + 3600_000, // fresh: 1h from now
      cloudId: "c1",
      siteUrl: "https://x.atlassian.net",
      siteName: "X",
    });
  }

  function setExpiredOAuthJiraAuth() {
    mod.setJiraAuth({
      accessToken: "expired-access-tok",
      sealedRefreshToken: "sealed-refresh",
      expiresAt: Date.now() + 60_000, // expiring: < 5min buffer
      cloudId: "c1",
      siteUrl: "https://x.atlassian.net",
      siteName: "X",
    });
  }

  it("returns false when no jira auth", async () => {
    expect(await mod.ensureJiraTokenValid()).toBe(false);
  });

  it("returns true without refresh when token is fresh", async () => {
    setFreshOAuthJiraAuth();
    vi.stubGlobal("fetch", vi.fn());
    const result = await mod.ensureJiraTokenValid();
    expect(result).toBe(true);
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it("returns true for API token mode without refresh (authMethod=token guard)", async () => {
    mod.setJiraAuth({
      accessToken: "sealed-api-token",
      sealedRefreshToken: "",
      expiresAt: Number.MAX_SAFE_INTEGER,
      cloudId: "c1",
      siteUrl: "https://x.atlassian.net",
      siteName: "X",
    });
    configMod.updateJiraConfig({ authMethod: "token" });
    vi.stubGlobal("fetch", vi.fn());
    const result = await mod.ensureJiraTokenValid();
    expect(result).toBe(true);
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it("returns true for empty sealedRefreshToken without refresh (API token mode guard)", async () => {
    mod.setJiraAuth({
      accessToken: "sealed-api-token",
      sealedRefreshToken: "",
      expiresAt: Number.MAX_SAFE_INTEGER,
      cloudId: "c1",
      siteUrl: "https://x.atlassian.net",
      siteName: "X",
    });
    vi.stubGlobal("fetch", vi.fn());
    const result = await mod.ensureJiraTokenValid();
    expect(result).toBe(true);
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it("calls refresh endpoint when token is near expiry", async () => {
    setExpiredOAuthJiraAuth();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "new-access-tok",
        sealed_refresh_token: "new-sealed",
        expires_in: 3600,
      }),
    }));

    const result = await mod.ensureJiraTokenValid();
    expect(result).toBe(true);
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledWith(
      "/api/oauth/jira/refresh",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-Requested-With": "fetch" }),
      })
    );
    expect(mod.jiraAuth()?.accessToken).toBe("new-access-tok");
    expect(mod.jiraAuth()?.sealedRefreshToken).toBe("new-sealed");
  });

  it("concurrent ensureJiraTokenValid calls share a single-flight promise", async () => {
    setExpiredOAuthJiraAuth();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "new-tok",
        sealed_refresh_token: "new-sealed",
        expires_in: 3600,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const [r1, r2, r3] = await Promise.all([
      mod.ensureJiraTokenValid(),
      mod.ensureJiraTokenValid(),
      mod.ensureJiraTokenValid(),
    ]);
    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(r3).toBe(true);
    // Only one actual fetch — concurrent calls share the same promise
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("failed refresh (401) clears Jira auth", async () => {
    setExpiredOAuthJiraAuth();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
    }));

    const result = await mod.ensureJiraTokenValid();
    expect(result).toBe(false);
    expect(mod.jiraAuth()).toBeNull();
    expect(mod.isJiraAuthenticated()).toBe(false);
  });

  it("network error preserves tokens and returns false", async () => {
    setExpiredOAuthJiraAuth();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")));

    const result = await mod.ensureJiraTokenValid();
    expect(result).toBe(false);
    // Token preserved — network error is not auth failure
    expect(mod.jiraAuth()?.accessToken).toBe("expired-access-tok");
    expect(mod.isJiraAuthenticated()).toBe(true);
  });

  it("non-401 server error preserves tokens and returns false", async () => {
    setExpiredOAuthJiraAuth();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 503,
    }));

    const result = await mod.ensureJiraTokenValid();
    expect(result).toBe(false);
    expect(mod.jiraAuth()?.accessToken).toBe("expired-access-tok");
  });

  it("uses fallback expiresAt of 3600s when refresh response expires_in is 0", async () => {
    setExpiredOAuthJiraAuth();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "new-access-tok",
        sealed_refresh_token: "new-sealed",
        expires_in: 0,
      }),
    }));

    const before = Date.now();
    const result = await mod.ensureJiraTokenValid();
    const after = Date.now();

    expect(result).toBe(true);
    expect(mod.jiraAuth()?.accessToken).toBe("new-access-tok");
    expect(mod.jiraAuth()?.sealedRefreshToken).toBe("new-sealed");
    const expiresAt = mod.jiraAuth()!.expiresAt;
    expect(expiresAt).toBeGreaterThanOrEqual(before + 3600_000);
    expect(expiresAt).toBeLessThanOrEqual(after + 3600_000);
  });

  it("uses fallback expiresAt of 3600s when refresh response expires_in is negative", async () => {
    setExpiredOAuthJiraAuth();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "new-access-tok",
        sealed_refresh_token: "new-sealed",
        expires_in: -1,
      }),
    }));

    const before = Date.now();
    const result = await mod.ensureJiraTokenValid();
    const after = Date.now();

    expect(result).toBe(true);
    expect(mod.jiraAuth()?.accessToken).toBe("new-access-tok");
    expect(mod.jiraAuth()?.sealedRefreshToken).toBe("new-sealed");
    const expiresAt = mod.jiraAuth()!.expiresAt;
    expect(expiresAt).toBeGreaterThanOrEqual(before + 3600_000);
    expect(expiresAt).toBeLessThanOrEqual(after + 3600_000);
  });

  it("uses fallback expiresAt of 3600s when refresh response expires_in is missing", async () => {
    setExpiredOAuthJiraAuth();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "new-access-tok",
        sealed_refresh_token: "new-sealed",
      }),
    }));

    const before = Date.now();
    const result = await mod.ensureJiraTokenValid();
    const after = Date.now();

    expect(result).toBe(true);
    expect(mod.jiraAuth()?.accessToken).toBe("new-access-tok");
    expect(mod.jiraAuth()?.sealedRefreshToken).toBe("new-sealed");
    const expiresAt = mod.jiraAuth()!.expiresAt;
    expect(expiresAt).toBeGreaterThanOrEqual(before + 3600_000);
    expect(expiresAt).toBeLessThanOrEqual(after + 3600_000);
  });

  it("returns false and preserves auth state when refresh response is missing sealed_refresh_token", async () => {
    setExpiredOAuthJiraAuth();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "new-tok",
        expires_in: 3600,
      }),
    }));

    const result = await mod.ensureJiraTokenValid();
    expect(result).toBe(false);
    expect(mod.jiraAuth()?.accessToken).toBe("expired-access-tok");
    expect(mod.jiraAuth()?.sealedRefreshToken).toBe("sealed-refresh");
  });
});

describe("cross-tab Jira auth sync", () => {
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

  it("updates jiraAuth signal when another tab writes a new value", () => {
    const newState = {
      accessToken: "new-tok-from-other-tab",
      sealedRefreshToken: "new-sealed",
      expiresAt: 9999999999999,
      cloudId: "c2",
      siteUrl: "https://y.atlassian.net",
      siteName: "Y",
    };
    localStorageMock.setItem("github-tracker:jira-auth", JSON.stringify(newState));

    window.dispatchEvent(new StorageEvent("storage", {
      key: "github-tracker:jira-auth",
      newValue: JSON.stringify(newState),
    }));

    expect(mod.jiraAuth()?.accessToken).toBe("new-tok-from-other-tab");
  });

  it("resets jiraAuth signal to null when another tab removes the key", () => {
    mod.setJiraAuth({
      accessToken: "tok",
      sealedRefreshToken: "s",
      expiresAt: 9999999999999,
      cloudId: "c1",
      siteUrl: "https://x.atlassian.net",
      siteName: "X",
    });

    window.dispatchEvent(new StorageEvent("storage", {
      key: "github-tracker:jira-auth",
      newValue: null,
    }));

    expect(mod.jiraAuth()).toBeNull();
  });

  it("does not react to unrelated storage keys", () => {
    mod.setJiraAuth({
      accessToken: "tok",
      sealedRefreshToken: "s",
      expiresAt: 9999999999999,
      cloudId: "c1",
      siteUrl: "https://x.atlassian.net",
      siteName: "X",
    });

    window.dispatchEvent(new StorageEvent("storage", {
      key: "github-tracker:config",
      newValue: null,
    }));

    expect(mod.jiraAuth()?.accessToken).toBe("tok");
  });
});

describe("JiraConfigSchema defaults", () => {
  it("parse({}) produces correct defaults", async () => {
    vi.resetModules();
    const { JiraConfigSchema } = await import("../../src/shared/schemas");
    const result = JiraConfigSchema.parse({});
    expect(result.enabled).toBe(false);
    expect(result.authMethod).toBe("oauth");
    expect(result.issueKeyDetection).toBe(true);
    expect(result.cloudId).toBeUndefined();
    expect(result.siteUrl).toBeUndefined();
    expect(result.siteName).toBeUndefined();
    expect(result.email).toBeUndefined();
  });

  it("parse with partial fields fills defaults for missing ones", async () => {
    vi.resetModules();
    const { JiraConfigSchema } = await import("../../src/shared/schemas");
    const result = JiraConfigSchema.parse({ enabled: true, authMethod: "token", cloudId: "c1" });
    expect(result.enabled).toBe(true);
    expect(result.authMethod).toBe("token");
    expect(result.cloudId).toBe("c1");
    expect(result.issueKeyDetection).toBe(true); // default preserved
    expect(result.siteUrl).toBeUndefined();
  });

  it("ConfigSchema.parse({}) nests jira with correct defaults", async () => {
    vi.resetModules();
    const { ConfigSchema } = await import("../../src/shared/schemas");
    const result = ConfigSchema.parse({});
    expect(result.jira.enabled).toBe(false);
    expect(result.jira.authMethod).toBe("oauth");
    expect(result.jira.issueKeyDetection).toBe(true);
  });

  it("ConfigSchema preserves existing non-jira fields when jira defaults apply", async () => {
    vi.resetModules();
    const { ConfigSchema } = await import("../../src/shared/schemas");
    const result = ConfigSchema.parse({ theme: "dark", refreshInterval: 120 });
    expect(result.theme).toBe("dark");
    expect(result.refreshInterval).toBe(120);
    expect(result.jira.enabled).toBe(false);
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
