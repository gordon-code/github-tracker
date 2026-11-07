import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  CHUNK_RELOAD_KEY,
  CHUNK_RELOAD_MAX_AGE,
  reloadOnceForStaleChunk,
  installChunkReloadHandler,
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
import { lazyWithReload } from "../../src/app/App";

describe("chunk-reload", () => {
  const originalLocation = window.location;
  let reloadMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
    localStorage.clear();
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
    vi.useRealTimers();
  });

  it("reloads and prevents default on the first vite:preloadError, suppresses within 10s, and reloads again after 10s", () => {
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

  it("index.tsx installs the chunk reload handler before mounting App", () => {
    const source = readFileSync(resolve(process.cwd(), "src/app/index.tsx"), "utf8");
    const installIdx = source.indexOf("installChunkReloadHandler()");
    const renderIdx = source.indexOf("render(");
    expect(installIdx).toBeGreaterThan(-1);
    expect(renderIdx).toBeGreaterThan(installIdx);
  });
});
