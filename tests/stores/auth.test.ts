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

const AUTH_KEY = "github-tracker:auth";

// auth.ts reads localStorage at module import time (readStoredTokens() on line 56-57).
// Each describe block uses vi.resetModules() + dynamic import to get clean signal state.

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

  it("stores access token in localStorage and updates token signal", () => {
    mod.setAuth({ access_token: "ghs_abc123" });
    expect(mod.token()).toBe("ghs_abc123");
    const stored = JSON.parse(localStorageMock.getItem(AUTH_KEY)!);
    expect(stored.accessToken).toBe("ghs_abc123");
  });

  it("does not store refresh token in localStorage (HttpOnly cookie only)", () => {
    mod.setAuth({ access_token: "ghs_abc" });
    const stored = JSON.parse(localStorageMock.getItem(AUTH_KEY)!);
    expect(stored.refreshToken).toBeUndefined();
  });

  it("stores expiresAt when expires_in is provided", () => {
    const before = Date.now();
    mod.setAuth({ access_token: "ghs_abc", expires_in: 3600 });
    const stored = JSON.parse(localStorageMock.getItem(AUTH_KEY)!);
    expect(stored.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000);
  });

  it("stores null expiresAt when expires_in is absent", () => {
    mod.setAuth({ access_token: "ghs_abc" });
    const stored = JSON.parse(localStorageMock.getItem(AUTH_KEY)!);
    expect(stored.expiresAt).toBeNull();
  });

  it("reads stored token from localStorage on module init", async () => {
    localStorageMock.setItem(
      AUTH_KEY,
      JSON.stringify({ accessToken: "ghs_preloaded", expiresAt: null })
    );
    vi.resetModules();
    const fresh = await import("../../src/app/stores/auth");
    expect(fresh.token()).toBe("ghs_preloaded");
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
    // Stub fetch so clearAuth's POST /api/oauth/logout doesn't hit the network
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    mod = await import("../../src/app/stores/auth");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("removes auth key from localStorage", () => {
    mod.setAuth({ access_token: "ghs_abc" });
    expect(localStorageMock.getItem(AUTH_KEY)).not.toBeNull();
    mod.clearAuth();
    expect(localStorageMock.getItem(AUTH_KEY)).toBeNull();
  });

  it("clears token signal to null", () => {
    mod.setAuth({ access_token: "ghs_abc" });
    mod.clearAuth();
    expect(mod.token()).toBeNull();
  });

  it("removes config and view keys from localStorage (SDR-016)", () => {
    localStorageMock.setItem("github-tracker:config", "{}");
    localStorageMock.setItem("github-tracker:view", "{}");
    mod.clearAuth();
    expect(localStorageMock.getItem("github-tracker:config")).toBeNull();
    expect(localStorageMock.getItem("github-tracker:view")).toBeNull();
  });
});

describe("onAuthCleared callbacks", () => {
  let mod: typeof import("../../src/app/stores/auth");

  beforeEach(async () => {
    localStorageMock.clear();
    vi.resetModules();
    // Stub fetch so clearAuth's POST /api/oauth/logout doesn't hit the network
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
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

  it("clears auth when 401 and refresh cookie is missing/expired", async () => {
    vi.stubGlobal("fetch", vi.fn()
      // GET /user returns 401 (access token expired)
      .mockResolvedValueOnce({ ok: false, status: 401, json: () => Promise.resolve({}) })
      // POST /api/oauth/refresh returns 400 (no cookie / invalid)
      .mockResolvedValueOnce({ ok: false, status: 400, json: () => Promise.resolve({ error: "invalid_request" }) })
      // POST /api/oauth/logout (fire-and-forget from clearAuth)
      .mockResolvedValue({ ok: true, json: () => Promise.resolve({}) })
    );

    mod.setAuth({ access_token: "ghs_expired" });
    await mod.validateToken();
    expect(mod.token()).toBeNull();
  });

  // ── qa-5: Non-200/non-401 response ─────────────────────────────────────────

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

  // ── qa-6: Network exception ─────────────────────────────────────────────────

  it("returns false and does not throw when fetch throws a network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    mod.setAuth({ access_token: "ghs_network" });
    const result = await mod.validateToken();

    expect(result).toBe(false);
    // Token should remain untouched — network error is not an auth failure
    expect(mod.token()).toBe("ghs_network");
  });
});

describe("refreshAccessToken", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("POSTs to /api/oauth/refresh (cookie-based) and updates token on success", async () => {
    const newTokenResponse = { access_token: "ghs_new", expires_in: 3600 };
    const githubUser = { login: "wgordon", avatar_url: "https://avatar.url", name: "Will" };

    vi.stubGlobal("fetch", vi.fn()
      // POST /api/oauth/refresh (no body — refresh token is in HttpOnly cookie)
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(newTokenResponse) })
      // GET https://api.github.com/user (validation)
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(githubUser) })
    );

    localStorageMock.clear();
    localStorageMock.setItem(
      AUTH_KEY,
      JSON.stringify({ accessToken: "ghs_old", expiresAt: null })
    );
    vi.resetModules();
    const mod = await import("../../src/app/stores/auth");

    const result = await mod.refreshAccessToken();
    expect(result).toBe(true);
    expect(mod.token()).toBe("ghs_new");

    // Verify the refresh request sent no body (cookie-based)
    const fetchMock = vi.mocked(globalThis.fetch);
    const [refreshUrl, refreshInit] = fetchMock.mock.calls[0];
    expect(refreshUrl).toBe("/api/oauth/refresh");
    expect((refreshInit as RequestInit).body).toBeUndefined();
  });

  it("returns false and calls clearAuth() on non-ok refresh response", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValue({ ok: false, status: 401, json: () => Promise.resolve({}) })
    );

    localStorageMock.clear();
    localStorageMock.setItem(
      AUTH_KEY,
      JSON.stringify({ accessToken: "ghs_old", expiresAt: null })
    );
    vi.resetModules();
    const mod = await import("../../src/app/stores/auth");

    const result = await mod.refreshAccessToken();
    expect(result).toBe(false);
    expect(localStorageMock.getItem(AUTH_KEY)).toBeNull();
  });

  it("clears auth when refresh succeeds but validation fails (SDR-013)", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          access_token: "ghs_unvalidated",
          expires_in: 28800,
        }),
      })
      .mockResolvedValueOnce({ ok: false, status: 401, json: () => Promise.resolve({}) })
      // POST /api/oauth/logout (fire-and-forget from clearAuth)
      .mockResolvedValue({ ok: true, json: () => Promise.resolve({}) })
    );

    localStorageMock.clear();
    localStorageMock.setItem(
      AUTH_KEY,
      JSON.stringify({ accessToken: "ghs_old", expiresAt: null })
    );
    vi.resetModules();
    const mod = await import("../../src/app/stores/auth");

    const result = await mod.refreshAccessToken();
    expect(result).toBe(false);
    expect(localStorageMock.getItem(AUTH_KEY)).toBeNull();
  });
});
