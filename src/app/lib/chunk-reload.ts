import { lazy } from "solid-js";
import { flushPersistedState } from "./flush-persistence";
import { checkForUpdate, updateAvailable } from "./version";

export const CHUNK_RELOAD_KEY = "github-tracker:chunk-reload";
export const CHUNK_RELOAD_MAX_AGE = 10_000;

export function reloadOnceForStaleChunk(): boolean {
  // Offline, a failed chunk load is a network failure rather than a stale deployment,
  // and a reload would only land on the browser's offline page. Returning false leaves
  // the failure to the caller's own error handling.
  if (!navigator.onLine) return false;
  const now = Date.now();
  try {
    const last = sessionStorage.getItem(CHUNK_RELOAD_KEY);
    if (!last || now - Number(last) > CHUNK_RELOAD_MAX_AGE) {
      sessionStorage.setItem(CHUNK_RELOAD_KEY, String(now));
      flushPersistedState();
      window.location.reload();
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * A failed chunk load alone doesn't prove a new deployment (a blocked or flaky request fails
 * the same way), so the page reloads only once a newer build is known. When one is already
 * known the failed import is cancelled and the page reloads at once; otherwise the caller's
 * own error handling runs while the update check confirms, and the reload follows if it does.
 */
function handleVitePreloadError(event: Event): void {
  if (updateAvailable()) {
    if (reloadOnceForStaleChunk()) event.preventDefault();
    return;
  }
  void checkForUpdate().then(() => {
    if (updateAvailable()) reloadOnceForStaleChunk();
    return undefined;
  });
}

export function installChunkReloadHandler(): () => void {
  window.addEventListener("vite:preloadError", handleVitePreloadError);
  return () => {
    window.removeEventListener("vite:preloadError", handleVitePreloadError);
  };
}

/**
 * Solid `lazy()` whose chunk-load failure reloads the page once (see
 * reloadOnceForStaleChunk) instead of reaching the nearest ErrorBoundary.
 */
export const lazyWithReload: typeof lazy = (loader) =>
  lazy(() =>
    loader()
      .then((mod) => {
        // A cancelled `vite:preloadError` (see installChunkReloadHandler) makes Vite's
        // preload helper resolve the import with `undefined` while the page reloads.
        // Stay on the Suspense fallback instead of failing on a missing module.
        if (mod === undefined) {
          return new Promise<never>(() => {});
        }
        return mod;
      })
      .catch((err) => {
        if (reloadOnceForStaleChunk()) {
          return new Promise<never>(() => {});
        }
        throw err;
      }),
  );
