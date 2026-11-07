import { flushPersistedState } from "./flush-persistence";

export const CHUNK_RELOAD_KEY = "github-tracker:chunk-reload";
export const CHUNK_RELOAD_MAX_AGE = 10_000;

export function reloadOnceForStaleChunk(): boolean {
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

function handleVitePreloadError(event: Event): void {
  if (reloadOnceForStaleChunk()) {
    event.preventDefault();
  }
}

export function installChunkReloadHandler(): () => void {
  window.addEventListener("vite:preloadError", handleVitePreloadError);
  return () => {
    window.removeEventListener("vite:preloadError", handleVitePreloadError);
  };
}
