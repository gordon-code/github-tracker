import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Guards the healthy-token path: a valid token must cost exactly one GET /user, may use the HTTP
// cache, and must never load the lazy 401 verifier or the GitHub status module.
const lazyModuleLoads: string[] = [];
vi.mock("../../src/app/stores/auth-401", () => {
  lazyModuleLoads.push("auth-401");
  return {};
});
vi.mock("../../src/app/services/github-status", () => {
  lazyModuleLoads.push("github-status");
  return {};
});

const mockClearCache = vi.fn().mockResolvedValue(undefined);
vi.mock("../../src/app/stores/cache", () => ({
  clearCache: (...args: unknown[]) => mockClearCache(...args),
}));
vi.mock("../../src/app/lib/dashboard-snapshot", () => ({
  clearSnapshot: vi.fn().mockResolvedValue(undefined),
}));
const mockPushNotification = vi.fn();
vi.mock("../../src/app/lib/errors", () => ({
  pushNotification: (...args: unknown[]) => mockPushNotification(...args),
  dismissNotificationBySource: vi.fn(),
}));
const mockCaptureException = vi.fn();
vi.mock("../../src/app/lib/sentry-facade", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

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
Object.defineProperty(globalThis, "localStorage", { value: localStorageMock, writable: true, configurable: true });

const octocat = { login: "octocat", avatar_url: "https://github.com/octocat.png", name: "Octo Cat" };

describe("auth happy path", () => {
  let mod: typeof import("../../src/app/stores/auth");

  beforeEach(async () => {
    lazyModuleLoads.length = 0;
    localStorageMock.clear();
    mockClearCache.mockClear();
    mockPushNotification.mockClear();
    mockCaptureException.mockClear();
    vi.resetModules();
    localStorageMock.setItem("github-tracker:auth-token", "ghp_healthy");
    localStorageMock.setItem("github-tracker:last-user", "octocat");
    mod = await import("../../src/app/stores/auth");
  });

  afterEach(() => {
    mod._resetAuthVerificationState();
    vi.unstubAllGlobals();
  });

  it("boot validateToken makes exactly one cacheable GET /user and loads no lazy modules", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(octocat) });
    vi.stubGlobal("fetch", fetchMock);

    expect(await mod.validateToken()).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/user",
      expect.objectContaining({ cache: "default" })
    );
    expect(lazyModuleLoads).toEqual([]);
    expect(mod.user()?.login).toBe("octocat");
  });

  it("a returning same-user boot performs no identity wipe, notification, or Sentry report", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(octocat) }));

    expect(await mod.validateToken()).toBe(true);

    expect(mockClearCache).not.toHaveBeenCalled();
    expect(mockPushNotification).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(localStorageMock.getItem("github-tracker:auth-token")).toBe("ghp_healthy");
  });

  it("clearAuthOutageSuspension on every 2xx is a no-op when no suspension is active", () => {
    for (let i = 0; i < 100; i++) mod.clearAuthOutageSuspension();
    expect(lazyModuleLoads).toEqual([]);
  });
});
