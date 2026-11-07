import { createSignal } from "solid-js";
import { BUILD_SHA_LENGTH, VersionInfoSchema, type VersionInfo } from "../../shared/build-meta";

export { VersionInfoSchema, type VersionInfo };

export const APP_VERSION: string = __APP_VERSION__;
export const GIT_SHA: string = __GIT_SHA__;
export const BUILD_TIME: string = __BUILD_TIME__;

let currentAppVersion: string = APP_VERSION;
let currentGitSha: string = GIT_SHA;

/** The running build's version (equals `APP_VERSION`; tests can override it). */
export function getAppVersion(): string {
  return currentAppVersion;
}

export function displayVersion(): string {
  return `${currentAppVersion}+${GIT_SHA.slice(0, 7)}`;
}

const UPDATE_RELOADED_SHA_KEY = "github-tracker:update-reloaded-sha";
export const VERSION_WATCH_INITIAL_DELAY_MS = 30_000;

const [updateAvailable, setUpdateAvailable] = createSignal<VersionInfo | null>(null);
export { updateAvailable };

let checkInFlight: Promise<void> | null = null;

export function checkForUpdate(): Promise<void> {
  if (checkInFlight) return checkInFlight;
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
      const parsed = VersionInfoSchema.safeParse(raw);
      if (!parsed.success) return;
      if (currentGitSha === "dev" || parsed.data.sha === "dev") return;
      const sameBuild =
        parsed.data.sha.slice(0, BUILD_SHA_LENGTH) ===
        currentGitSha.toLowerCase().slice(0, BUILD_SHA_LENGTH);
      // The deployed build is authoritative: it clears a previously flagged update
      // when the server reports the running build again (e.g. after a rollback).
      setUpdateAvailable(sameBuild ? null : parsed.data);
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
export function _setUpdateAvailableForTests(info: VersionInfo | null): void {
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

/** @internal Test-only helper to reset version checker state */
export function _resetVersionStateForTests(): void {
  currentAppVersion = APP_VERSION;
  currentGitSha = GIT_SHA;
  setUpdateAvailable(null);
  checkInFlight = null;
  try {
    sessionStorage.removeItem(UPDATE_RELOADED_SHA_KEY);
  } catch {
    // Ignore storage errors in restricted environments
  }
}
