const CHUNK_RELOAD_KEY = "github-tracker:chunk-reload";
const CHUNK_RELOAD_MAX_AGE_MS = 10_000;

/**
 * Reloads the page to pick up current hashed assets after a dynamic import
 * failed (a tab that outlived a deploy). Reloads at most once per
 * CHUNK_RELOAD_MAX_AGE_MS so a persistently missing chunk cannot cause a
 * reload loop. Returns true when a reload was triggered.
 */
export function reloadOnceForStaleChunk(): boolean {
  const last = sessionStorage.getItem(CHUNK_RELOAD_KEY);
  if (last && Date.now() - Number(last) <= CHUNK_RELOAD_MAX_AGE_MS) return false;
  sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()));
  window.location.reload();
  return true;
}
