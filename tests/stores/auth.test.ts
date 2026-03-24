import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock cache.ts so clearAuth() doesn't try to open IndexedDB
vi.mock("../../src/app/stores/cache", () => ({
  clearCache: vi.fn().mockResolvedValue(undefined),
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

  it("removes config and view keys from localStorage (SDR-016)", () => {
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
    localStorageMock.clear();
    vi.resetModules();
    mod = await import("../../src/app/stores/auth");
  });

  afterEach(() => {
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

  it("clears auth on 401 (permanent token revoked — no refresh fallback)", async () => {
    vi.stubGlobal("fetch", vi.fn()
      // GET /user returns 401 (access token revoked)
      .mockResolvedValueOnce({ ok: false, status: 401, json: () => Promise.resolve({}) })
    );

    mod.setAuth({ access_token: "ghs_revoked" });
    await mod.validateToken();
    expect(mod.token()).toBeNull();
    expect(localStorageMock.getItem("github-tracker:auth-token")).toBeNull();
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
