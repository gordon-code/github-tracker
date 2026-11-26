import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Every dynamic import("./auth-401") in this file fails, as it does in a tab
// whose hashed chunk was removed by a deploy. Kept in its own file because a
// module mock that throws cannot be cleanly undone for later tests.
vi.mock("../../src/app/stores/auth-401", () => {
  throw new Error("Failed to fetch dynamically imported module");
});

vi.mock("../../src/app/stores/cache", () => ({
  clearCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/app/lib/dashboard-snapshot", () => ({
  clearSnapshot: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/app/lib/errors", () => ({
  pushNotification: vi.fn(),
  dismissNotificationBySource: vi.fn(),
}));

const mockReloadOnceForStaleChunk = vi.fn();
vi.mock("../../src/app/lib/chunk-reload", () => ({
  reloadOnceForStaleChunk: () => mockReloadOnceForStaleChunk(),
}));

const mockIsGitHubApiOutage = vi.fn().mockReturnValue(false);
const mockFetchGitHubStatus = vi.fn().mockResolvedValue(undefined);
vi.mock("../../src/app/services/github-status", () => ({
  isGitHubApiOutage: () => mockIsGitHubApiOutage(),
  fetchGitHubStatus: () => mockFetchGitHubStatus(),
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

Object.defineProperty(globalThis, "localStorage", {
  value: localStorageMock,
  writable: true,
  configurable: true,
});

const unauthorizedResponse = { ok: false, status: 401, json: () => Promise.resolve({}) };

describe("auth store when the auth-401 chunk fails to load", () => {
  let mod: typeof import("../../src/app/stores/auth");

  beforeEach(async () => {
    localStorageMock.clear();
    mockCaptureException.mockReset();
    mockReloadOnceForStaleChunk.mockReset();
    mockIsGitHubApiOutage.mockReset().mockReturnValue(false);
    mockFetchGitHubStatus.mockReset().mockResolvedValue(undefined);
    sessionStorage.clear();
    vi.resetModules();
    mod = await import("../../src/app/stores/auth");
  });

  afterEach(() => {
    mod._resetAuthVerificationState();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // Runs a runtime 401 through the stale-chunk branch, advancing past its confirmation delay.
  async function runUnauthorized(token: string) {
    vi.useFakeTimers();
    const p = mod.handleRuntimeUnauthorized(token, { endpointKind: "rest" });
    await vi.advanceTimersByTimeAsync(1_000);
    return p;
  }

  it("handleRuntimeUnauthorized preserves the token and requests a reload after a confirming 401", async () => {
    const reloadSpy = vi.spyOn(mod.authNavigation, "reloadForStaleChunk").mockImplementation(() => {});
    const redirectSpy = vi.spyOn(mod.authNavigation, "redirectToLogin").mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue(unauthorizedResponse);
    vi.stubGlobal("fetch", fetchMock);

    mod.setAuth({ access_token: "ghp_stale_chunk" });
    const outcome = await runUnauthorized("ghp_stale_chunk");

    expect(outcome).toBe("preserved");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(mockFetchGitHubStatus).toHaveBeenCalledOnce();
    expect(reloadSpy).toHaveBeenCalledOnce();
    expect(redirectSpy).not.toHaveBeenCalled();
    expect(mod.token()).toBe("ghp_stale_chunk");
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it("handleRuntimeUnauthorized does not reload when the confirming check succeeds", async () => {
    const reloadSpy = vi.spyOn(mod.authNavigation, "reloadForStaleChunk").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) }));

    mod.setAuth({ access_token: "ghp_transient" });
    expect(await runUnauthorized("ghp_transient")).toBe("preserved");
    expect(reloadSpy).not.toHaveBeenCalled();
    expect(mod.token()).toBe("ghp_transient");
  });

  it("handleRuntimeUnauthorized does not reload during a GitHub API Requests outage", async () => {
    mockIsGitHubApiOutage.mockReturnValue(true);
    const reloadSpy = vi.spyOn(mod.authNavigation, "reloadForStaleChunk").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(unauthorizedResponse));

    mod.setAuth({ access_token: "ghp_outage" });
    expect(await runUnauthorized("ghp_outage")).toBe("preserved");
    expect(mockFetchGitHubStatus).toHaveBeenCalledOnce();
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it("reloadForStaleChunk reloads at most once per session for a stale verifier chunk", () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    mockReloadOnceForStaleChunk.mockReturnValue(true);
    mod.authNavigation.reloadForStaleChunk();
    mod.authNavigation.reloadForStaleChunk();
    expect(mockReloadOnceForStaleChunk).toHaveBeenCalledOnce();
  });

  it("reloadForStaleChunk keeps its one reload available when the shared guard suppressed it", () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    mockReloadOnceForStaleChunk.mockReturnValueOnce(false).mockReturnValueOnce(true);
    mod.authNavigation.reloadForStaleChunk();
    mod.authNavigation.reloadForStaleChunk();
    expect(mockReloadOnceForStaleChunk).toHaveBeenCalledTimes(2);
  });

  it("a healthy boot validateToken clears the once-per-session reload flag", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    mockReloadOnceForStaleChunk.mockReturnValue(true);
    mod.authNavigation.reloadForStaleChunk();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ login: "octocat", avatar_url: "https://github.com/o.png", name: "Octo" }),
    }));
    mod.setAuth({ access_token: "ghp_healthy" });
    expect(await mod.validateToken()).toBe(true);

    mod.authNavigation.reloadForStaleChunk();
    expect(mockReloadOnceForStaleChunk).toHaveBeenCalledTimes(2);
  });

  it("reloadForStaleChunk requests a guarded reload when online", () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    mod.authNavigation.reloadForStaleChunk();
    expect(mockReloadOnceForStaleChunk).toHaveBeenCalledOnce();
  });

  it("reloadForStaleChunk skips the reload when offline", () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    mod.authNavigation.reloadForStaleChunk();
    expect(mockReloadOnceForStaleChunk).not.toHaveBeenCalled();
  });

  it("reloadForStaleChunk falls back to an unguarded reload when sessionStorage is unavailable", () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    const reload = vi.fn();
    vi.stubGlobal("location", { reload });
    mockReloadOnceForStaleChunk.mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    expect(() => mod.authNavigation.reloadForStaleChunk()).not.toThrow();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("validateToken returns false and keeps the token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(unauthorizedResponse);
    vi.stubGlobal("fetch", fetchMock);

    mod.setAuth({ access_token: "ghs_no_401_chunk" });
    expect(await mod.validateToken()).toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mod.token()).toBe("ghs_no_401_chunk");
    expect(mod.user()).toBeNull();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it("completeOAuthLogin returns false without fetching or persisting auth", async () => {
    const fetchMock = vi.fn().mockResolvedValue(unauthorizedResponse);
    vi.stubGlobal("fetch", fetchMock);

    expect(await mod.completeOAuthLogin("gho_no_401_chunk")).toBe(false);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mod.token()).toBeNull();
    expect(localStorageMock.getItem(mod.AUTH_STORAGE_KEY)).toBeNull();
  });
});
