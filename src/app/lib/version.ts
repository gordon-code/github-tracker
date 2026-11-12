import { createSignal } from "solid-js";
import {
  BUILD_SHA_LENGTH,
  BuildInfoSchema,
  DISPLAY_SHA_LENGTH,
  type BuildInfo,
} from "../../shared/build-meta";

export const APP_VERSION: string = __APP_VERSION__;
export const GIT_SHA: string = __GIT_SHA__;
export const SCHEMA_FP: string = __SCHEMA_FP__;

let currentAppVersion: string = APP_VERSION;
let currentGitSha: string = GIT_SHA;

/** The running build's version (equals `APP_VERSION`; tests can override it). */
export function getAppVersion(): string {
  return currentAppVersion;
}

export function displayVersion(): string {
  return `${currentAppVersion}+${currentGitSha.slice(0, DISPLAY_SHA_LENGTH)}`;
}

const UPDATE_RELOADED_SHA_KEY = "github-tracker:update-reloaded-sha";
export const VERSION_WATCH_INITIAL_DELAY_MS = 30_000;

/** Minimum gap between throttled (poll-driven) update checks. */
export const VERSION_CHECK_MIN_INTERVAL_MS = 60_000;

const [updateAvailable, setUpdateAvailable] = createSignal<BuildInfo | null>(null);
export { updateAvailable };

// True while the deployed build stores config/view data in a different layout than this
// tab's build, so this tab must not write or adopt persisted state until it reloads.
const [schemaStale, setSchemaStale] = createSignal(false);
export { schemaStale };

let checkInFlight: Promise<void> | null = null;
let loadedAt = Date.now();
let lastCheckStartedAt = Number.NEGATIVE_INFINITY;

/**
 * Fetches `/version.json` and flags a newer deployment. Tab-visibility and timer checks
 * always run; a `throttled` (poll-driven) check is skipped during the first
 * `VERSION_WATCH_INITIAL_DELAY_MS` after load, which keeps the request off the boot path,
 * and when another check started less than `VERSION_CHECK_MIN_INTERVAL_MS` ago.
 */
export function checkForUpdate(options: { throttled?: boolean } = {}): Promise<void> {
  if (checkInFlight) return checkInFlight;
  if (options.throttled) {
    const now = Date.now();
    if (
      now - loadedAt < VERSION_WATCH_INITIAL_DELAY_MS ||
      now - lastCheckStartedAt < VERSION_CHECK_MIN_INTERVAL_MS
    ) {
      return Promise.resolve();
    }
  }
  lastCheckStartedAt = Date.now();
  checkInFlight = (async () => {
    try {
      const res = await fetch("/version.json", {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!res.ok) return;
      const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
      if (!contentType.includes("application/json")) return;
      const raw: unknown = await res.json();
      const parsed = BuildInfoSchema.safeParse(raw);
      if (!parsed.success) return;
      if (currentGitSha === "dev" || parsed.data.sha === "dev") return;
      const sameBuild =
        parsed.data.sha.slice(0, BUILD_SHA_LENGTH) ===
        currentGitSha.toLowerCase().slice(0, BUILD_SHA_LENGTH);
      // The deployed build is authoritative: it clears a previously flagged update
      // when the server reports the running build again (e.g. after a rollback).
      setUpdateAvailable(sameBuild ? null : parsed.data);
      setSchemaStale(parsed.data.schemaFp !== undefined && parsed.data.schemaFp !== SCHEMA_FP);
    } catch {
      // Best-effort — network errors or non-JSON bodies are ignored silently.
    } finally {
      checkInFlight = null;
    }
  })();
  return checkInFlight;
}

export function reloadOncePerTarget(targetSha: string): boolean {
  const normalized = targetSha.slice(0, BUILD_SHA_LENGTH);
  if (!normalized || normalized === "dev") return false;
  try {
    if (sessionStorage.getItem(UPDATE_RELOADED_SHA_KEY) === normalized) {
      return false;
    }
    sessionStorage.setItem(UPDATE_RELOADED_SHA_KEY, normalized);
    return true;
  } catch {
    return false;
  }
}

export function startVersionWatch(): () => void {
  const handleVisibilityChange = () => {
    if (document.visibilityState === "visible") {
      void checkForUpdate();
    }
  };
  document.addEventListener("visibilitychange", handleVisibilityChange);
  const timerId = setTimeout(() => {
    void checkForUpdate();
  }, VERSION_WATCH_INITIAL_DELAY_MS);

  return () => {
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    clearTimeout(timerId);
  };
}

/** @internal Test-only helper to set updateAvailable signal directly */
export function _setUpdateAvailableForTests(info: BuildInfo | null): void {
  setUpdateAvailable(info);
}

/** @internal Test-only helper to override the running build's version */
export function _setAppVersionForTests(version: string): void {
  currentAppVersion = version;
}

/** @internal Test-only helper to override the running build's git SHA */
export function _setGitShaForTests(sha: string): void {
  currentGitSha = sha;
}

/** @internal Test-only helper to set the schema-stale signal directly */
export function _setSchemaStaleForTests(stale: boolean): void {
  setSchemaStale(stale);
}

/** @internal Test-only helper to set when this module counts as loaded (boot-window checks) */
export function _setLoadedAtForTests(timestampMs: number): void {
  loadedAt = timestampMs;
}

/** @internal Test-only helper to reset version checker state */
export function _resetVersionStateForTests(): void {
  currentAppVersion = APP_VERSION;
  currentGitSha = GIT_SHA;
  setUpdateAvailable(null);
  setSchemaStale(false);
  checkInFlight = null;
  loadedAt = Number.NEGATIVE_INFINITY;
  lastCheckStartedAt = Number.NEGATIVE_INFINITY;
  try {
    sessionStorage.removeItem(UPDATE_RELOADED_SHA_KEY);
  } catch {
    // Ignore storage errors in restricted environments
  }
}
