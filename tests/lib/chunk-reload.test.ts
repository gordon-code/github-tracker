import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  CHUNK_RELOAD_KEY,
  CHUNK_RELOAD_MAX_AGE,
  reloadOnceForStaleChunk,
  installChunkReloadHandler,
  lazyWithReload,
} from "../../src/app/lib/chunk-reload";
import {
  CONFIG_STORAGE_KEY,
  updateConfig,
  resetConfig,
  initConfigPersistence,
} from "../../src/app/stores/config";
import {
  VIEW_STORAGE_KEY,
  updateViewState,
  resetViewState,
  initViewPersistence,
} from "../../src/app/stores/view";
import { createRoot, ErrorBoundary, Suspense } from "solid-js";
import { render, waitFor } from "@solidjs/testing-library";
import {
  GIT_SHA,
  _resetVersionStateForTests,
  _setUpdateAvailableForTests,
  updateAvailable,
} from "../../src/app/lib/version";

const NEWER_BUILD = { version: "9.9.9", sha: "fedcba987654", builtAt: "2026-01-02T00:00:00.000Z" };

function versionResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("chunk-reload", () => {
  const originalLocation = window.location;
  let reloadMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
    localStorage.clear();
    _resetVersionStateForTests();
    resetConfig();
    resetViewState();

    reloadMock = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: {
        reload: reloadMock,
        href: "",
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: originalLocation,
    });
    _resetVersionStateForTests();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe("when no newer deployment is known yet", () => {
    it("leaves the failed import to its caller and reloads only after the update check finds a newer build", async () => {
      const fetchMock = vi.fn().mockResolvedValue(versionResponse(NEWER_BUILD));
      vi.stubGlobal("fetch", fetchMock);
      const cleanup = installChunkReloadHandler();

      const event = new Event("vite:preloadError", { cancelable: true });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(reloadMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledWith("/version.json", expect.objectContaining({ cache: "no-store" }));
      expect(updateAvailable()).toEqual(NEWER_BUILD);
      expect(reloadMock).toHaveBeenCalledTimes(1);

      cleanup();
    });

    it("does not reload when the update check reports the running build (a blocked or flaky chunk)", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(versionResponse({ ...NEWER_BUILD, sha: GIT_SHA })),
      );
      const cleanup = installChunkReloadHandler();

      window.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));
      await vi.advanceTimersByTimeAsync(0);

      expect(updateAvailable()).toBeNull();
      expect(reloadMock).not.toHaveBeenCalled();
      cleanup();
    });

    it("does not reload when the update check itself fails", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
      const cleanup = installChunkReloadHandler();

      window.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));
      await vi.advanceTimersByTimeAsync(0);

      expect(reloadMock).not.toHaveBeenCalled();
      cleanup();
    });
  });

  it("reloads and prevents default on the first vite:preloadError once a newer build is known, suppresses within 10s, and reloads again after 10s", () => {
    _setUpdateAvailableForTests(NEWER_BUILD);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(versionResponse(NEWER_BUILD)));
    const cleanup = installChunkReloadHandler();

    const event1 = new Event("vite:preloadError", { cancelable: true });
    window.dispatchEvent(event1);

    expect(reloadMock).toHaveBeenCalledTimes(1);
    expect(event1.defaultPrevented).toBe(true);
    expect(sessionStorage.getItem(CHUNK_RELOAD_KEY)).not.toBeNull();

    // Within 10s window — no reload and default not prevented
    vi.advanceTimersByTime(CHUNK_RELOAD_MAX_AGE - 100);
    const event2 = new Event("vite:preloadError", { cancelable: true });
    window.dispatchEvent(event2);

    expect(reloadMock).toHaveBeenCalledTimes(1);
    expect(event2.defaultPrevented).toBe(false);

    // Past 10s window — reloads again
    vi.advanceTimersByTime(200);
    const event3 = new Event("vite:preloadError", { cancelable: true });
    window.dispatchEvent(event3);

    expect(reloadMock).toHaveBeenCalledTimes(2);
    expect(event3.defaultPrevented).toBe(true);

    cleanup();

    // After cleanup, listener is removed even after the 10s window elapses
    vi.advanceTimersByTime(CHUNK_RELOAD_MAX_AGE + 100);
    const event4 = new Event("vite:preloadError", { cancelable: true });
    window.dispatchEvent(event4);
    expect(reloadMock).toHaveBeenCalledTimes(2);
    expect(event4.defaultPrevented).toBe(false);
  });

  it("returns false and does not prevent default when sessionStorage throws", () => {
    _setUpdateAvailableForTests(NEWER_BUILD);
    const origGetItem = sessionStorage.getItem.bind(sessionStorage);
    vi.spyOn(sessionStorage, "getItem").mockImplementation(() => {
      throw new DOMException("Storage disabled", "SecurityError");
    });

    const cleanup = installChunkReloadHandler();
    const event = new Event("vite:preloadError", { cancelable: true });
    window.dispatchEvent(event);

    expect(reloadMock).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);

    cleanup();
    vi.restoreAllMocks();
    Object.defineProperty(sessionStorage, "getItem", {
      value: origGetItem,
      configurable: true,
      writable: true,
    });
  });

  it("flushes debounced config and viewState persistence before reloading", () => {
    let dispose!: () => void;
    createRoot((d) => {
      dispose = d;
      initConfigPersistence();
      initViewPersistence();
    });

    updateConfig({ theme: "dracula" });
    updateViewState({ lastActiveTab: "pullRequests" });

    // Before the 200ms debounce fires, trigger stale-chunk reload
    expect(reloadOnceForStaleChunk()).toBe(true);
    expect(reloadMock).toHaveBeenCalledTimes(1);

    const savedConfig = JSON.parse(localStorage.getItem(CONFIG_STORAGE_KEY) ?? "{}") as {
      theme?: string;
    };
    const savedView = JSON.parse(localStorage.getItem(VIEW_STORAGE_KEY) ?? "{}") as {
      lastActiveTab?: string;
    };
    expect(savedConfig.theme).toBe("dracula");
    expect(savedView.lastActiveTab).toBe("pullRequests");

    dispose();
  });

  it("lazyWithReload stays on the Suspense fallback, never reaching the ErrorBoundary, when a cancelled vite:preloadError resolves the import to undefined", async () => {
    vi.useRealTimers();
    const errorBoundarySpy = vi.fn();

    // Vite's preload helper resolves `import()` with `undefined` once a listener calls preventDefault().
    const PreventedLazy = lazyWithReload(() => Promise.resolve(undefined as never));
    const { container } = render(() =>
      ErrorBoundary({
        fallback: (err) => {
          errorBoundarySpy(err);
          return "Fallback";
        },
        get children() {
          return Suspense({
            fallback: "Loading",
            get children() {
              return PreventedLazy({});
            },
          });
        },
      }),
    );

    await new Promise((done) => setTimeout(done, 20));

    expect(errorBoundarySpy).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Loading");
    expect(container.textContent).not.toContain("Fallback");
  });

  it("lazyWithReload triggers reload without invoking ErrorBoundary on first rejection, and rethrows to ErrorBoundary within 10s cooldown", async () => {
    vi.useRealTimers();
    const errorBoundarySpy = vi.fn();

    const FailingLazy1 = lazyWithReload(() => Promise.reject(new Error("chunk load failed")));
    render(() =>
      ErrorBoundary({
        fallback: (err) => {
          errorBoundarySpy(err);
          return "Fallback";
        },
        get children() {
          return Suspense({
            fallback: "Loading",
            get children() {
              return FailingLazy1({});
            },
          });
        },
      }),
    );

    await waitFor(() => {
      expect(reloadMock).toHaveBeenCalledTimes(1);
    });
    expect(errorBoundarySpy).not.toHaveBeenCalled();

    // Second rejection within the 10s cooldown rethrows to ErrorBoundary
    const FailingLazy2 = lazyWithReload(() => Promise.reject(new Error("chunk load failed again")));
    render(() =>
      ErrorBoundary({
        fallback: (err) => {
          errorBoundarySpy(err);
          return "Fallback";
        },
        get children() {
          return Suspense({
            fallback: "Loading",
            get children() {
              return FailingLazy2({});
            },
          });
        },
      }),
    );

    await waitFor(() => {
      expect(errorBoundarySpy).toHaveBeenCalledTimes(1);
    });
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  describe("while the browser is offline", () => {
    beforeEach(() => {
      _setUpdateAvailableForTests(NEWER_BUILD);
      Object.defineProperty(navigator, "onLine", {
        value: false,
        writable: true,
        configurable: true,
      });
    });

    afterEach(() => {
      Reflect.deleteProperty(navigator, "onLine");
    });

    it("does not reload, record the reload time, or prevent default on vite:preloadError, and reloads on the next failure once back online", () => {
      const cleanup = installChunkReloadHandler();

      const offlineEvent = new Event("vite:preloadError", { cancelable: true });
      window.dispatchEvent(offlineEvent);

      expect(reloadMock).not.toHaveBeenCalled();
      expect(offlineEvent.defaultPrevented).toBe(false);
      expect(sessionStorage.getItem(CHUNK_RELOAD_KEY)).toBeNull();

      Object.defineProperty(navigator, "onLine", {
        value: true,
        writable: true,
        configurable: true,
      });
      const onlineEvent = new Event("vite:preloadError", { cancelable: true });
      window.dispatchEvent(onlineEvent);

      expect(reloadMock).toHaveBeenCalledTimes(1);
      expect(onlineEvent.defaultPrevented).toBe(true);

      cleanup();
    });

    it("lazyWithReload rethrows a failed import to the ErrorBoundary without reloading", async () => {
      vi.useRealTimers();
      const errorBoundarySpy = vi.fn();

      const FailingLazy = lazyWithReload(() => Promise.reject(new Error("chunk load failed")));
      render(() =>
        ErrorBoundary({
          fallback: (err) => {
            errorBoundarySpy(err);
            return "Fallback";
          },
          get children() {
            return Suspense({
              fallback: "Loading",
              get children() {
                return FailingLazy({});
              },
            });
          },
        }),
      );

      await waitFor(() => {
        expect(errorBoundarySpy).toHaveBeenCalledTimes(1);
      });
      expect(reloadMock).not.toHaveBeenCalled();
    });
  });

  it("index.tsx installs the chunk reload handler before mounting App", () => {
    const source = readFileSync(resolve(process.cwd(), "src/app/index.tsx"), "utf8");
    const installIdx = source.indexOf("installChunkReloadHandler()");
    const renderIdx = source.indexOf("render(");
    expect(installIdx).toBeGreaterThan(-1);
    expect(renderIdx).toBeGreaterThan(installIdx);
  });

  it("routes every lazy-loaded component in src/app through lazyWithReload", () => {
    const appDir = resolve(process.cwd(), "src/app");
    const offenders = readdirSync(appDir, { encoding: "utf8", recursive: true })
      .filter((file) => /\.(ts|tsx)$/.test(file) && file !== join("lib", "chunk-reload.ts"))
      .filter((file) => /\blazy\(/.test(readFileSync(join(appDir, file), "utf8")));
    expect(offenders).toEqual([]);
  });
});
