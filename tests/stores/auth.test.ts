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

  it("stores refresh token in localStorage", () => {
    mod.setAuth({ access_token: "ghs_abc", refresh_token: "ghr_xyz" });
    const stored = JSON.parse(localStorageMock.getItem(AUTH_KEY)!);
    expect(stored.refreshToken).toBe("ghr_xyz");
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
      JSON.stringify({ accessToken: "ghs_preloaded", refreshToken: null, expiresAt: null })
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
    mod = await import("../../src/app/stores/auth");
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

  it("clears auth when 401 and no refresh token available", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 401, json: () => Promise.resolve({}) })
    );

    // setAuth with no refresh token stored
    mod.setAuth({ access_token: "ghs_expired" });
    // No refresh_token in storage — refreshAccessToken calls clearAuth immediately
    await mod.validateToken();
    expect(mod.token()).toBeNull();
  });
});

describe("refreshAccessToken", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns false and clears auth when no refresh token is stored", async () => {
    localStorageMock.clear();
    vi.resetModules();
    const mod = await import("../../src/app/stores/auth");

    mod.setAuth({ access_token: "ghs_abc" }); // no refresh_token
    const result = await mod.refreshAccessToken();
    expect(result).toBe(false);
    expect(mod.token()).toBeNull();
  });

  it("sends refresh_token to /api/oauth/refresh and updates tokens on success", async () => {
    const newTokenResponse = { access_token: "ghs_new", refresh_token: "ghr_new", expires_in: 3600 };
    const githubUser = { login: "wgordon", avatar_url: "https://avatar.url", name: "Will" };

    vi.stubGlobal("fetch", vi.fn()
      // POST /api/oauth/refresh
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(newTokenResponse) })
      // GET https://api.github.com/user (validation)
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(githubUser) })
    );

    // Store a refresh token BEFORE module import so readStoredTokens() picks it up
    localStorageMock.clear();
    localStorageMock.setItem(
      AUTH_KEY,
      JSON.stringify({ accessToken: "ghs_old", refreshToken: "ghr_old", expiresAt: null })
    );
    vi.resetModules();
    const mod = await import("../../src/app/stores/auth");

    const result = await mod.refreshAccessToken();
    expect(result).toBe(true);
    expect(mod.token()).toBe("ghs_new");
  });

  it("returns false and calls clearAuth() on non-ok refresh response", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValue({ ok: false, status: 401, json: () => Promise.resolve({}) })
    );

    localStorageMock.clear();
    localStorageMock.setItem(
      AUTH_KEY,
      JSON.stringify({ accessToken: "ghs_old", refreshToken: "ghr_old", expiresAt: null })
    );
    vi.resetModules();
    const mod = await import("../../src/app/stores/auth");

    const result = await mod.refreshAccessToken();
    expect(result).toBe(false);
    expect(localStorageMock.getItem(AUTH_KEY)).toBeNull();
  });
});
