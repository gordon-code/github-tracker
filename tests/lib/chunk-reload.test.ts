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
import { createRoot } from "solid-js";

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
});
