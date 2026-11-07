import { createSignal } from "solid-js";
import * as z from "zod/mini";

export let APP_VERSION: string = __APP_VERSION__;
export const GIT_SHA: string = __GIT_SHA__;
export const BUILD_TIME: string = __BUILD_TIME__;

export function displayVersion(): string {
  return `${APP_VERSION}+${GIT_SHA.slice(0, 7)}`;
}

export const VersionInfoSchema = z.object({
  version: z.string().check(z.maxLength(32)),
  sha: z.string().check(z.regex(/^[0-9a-f]{7,40}$|^dev$/)),
  builtAt: z.string().check(z.maxLength(40)),
});

export type VersionInfo = z.infer<typeof VersionInfoSchema>;

export const UPDATE_RELOADED_SHA_KEY = "github-tracker:update-reloaded-sha";
export const VERSION_WATCH_INITIAL_DELAY_MS = 30_000;

const [updateAvailable, setUpdateAvailable] = createSignal<VersionInfo | null>(null);
export { updateAvailable };

let currentGitSha: string = GIT_SHA;
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
      if (
        currentGitSha !== "dev" &&
        parsed.data.sha !== "dev" &&
        parsed.data.sha.slice(0, 12) !== currentGitSha.toLowerCase().slice(0, 12)
      ) {
        setUpdateAvailable(parsed.data);
      }
    } catch {
      // Best-effort — network errors or non-JSON bodies are ignored silently.
    } finally {
      checkInFlight = null;
    }
  })();
  return checkInFlight;
}

export function reloadOncePerTarget(targetSha: string): boolean {
  const normalized = targetSha.slice(0, 12);
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
export function _setUpdateAvailableForTest(info: VersionInfo | null): void {
  setUpdateAvailable(info);
}

/** @internal Test-only helper to override local build APP_VERSION */
export function _setAppVersionForTest(version: string): void {
  APP_VERSION = version;
}

/** @internal Test-only helper to override local build GIT_SHA */
export function _setGitShaForTest(sha: string): void {
  currentGitSha = sha;
}

/** @internal Test-only helper to reset version checker state */
export function _resetVersionStateForTest(): void {
  APP_VERSION = __APP_VERSION__;
  setUpdateAvailable(null);
  currentGitSha = GIT_SHA;
  checkInFlight = null;
  try {
    sessionStorage.removeItem(UPDATE_RELOADED_SHA_KEY);
  } catch {
    // Ignore storage errors in restricted environments
  }
}
