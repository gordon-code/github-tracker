import { createSignal } from "solid-js";
import { clearCache } from "./cache";
import { CONFIG_STORAGE_KEY, resetConfig, updateConfig, config } from "./config";
import { VIEW_STORAGE_KEY, resetViewState } from "./view";
import { pushNotification } from "../lib/errors";

export const AUTH_STORAGE_KEY = "github-tracker:auth-token";
export const DASHBOARD_STORAGE_KEY = "github-tracker:dashboard";

export interface GitHubUser {
  login: string;
  avatar_url: string;
  name: string | null;
}

interface TokenExchangeResponse {
  access_token: string;
  token_type?: string;
  scope?: string;
}

// ── Signals ─────────────────────────────────────────────────────────────────

// Access token is persisted to localStorage for permanent OAuth App tokens.
// On page reload, validateToken() reads from localStorage and verifies with GitHub.
// Optional chaining: happy-dom initializes localStorage methods lazily, so getItem
// may not be a function yet during early module initialization in tests.
const [_token, _setToken] = createSignal<string | null>(
  localStorage.getItem?.(AUTH_STORAGE_KEY) ?? null
);
const [user, setUser] = createSignal<GitHubUser | null>(null);

export const token = _token;

export function isAuthenticated(): boolean {
  return _token() !== null && user() !== null;
}

export { user };

// ── Actions ─────────────────────────────────────────────────────────────────

export function setAuth(response: TokenExchangeResponse): void {
  try {
    localStorage.setItem(AUTH_STORAGE_KEY, response.access_token);
  } catch {
    pushNotification("localStorage:auth", "Auth token write failed — storage may be full. Token exists in memory only this session.", "warning");
  }
  _setToken(response.access_token);
  console.info("[auth] access token set");
}

export function setAuthFromPat(token: string, userData: GitHubUser): void {
  setAuth({ access_token: token });
  setUser({ login: userData.login, avatar_url: userData.avatar_url, name: userData.name });
  updateConfig({ authMethod: "pat" });
}

const _onClearCallbacks: (() => void)[] = [];

/** Register a callback to run when auth is cleared. Avoids circular imports. */
export function onAuthCleared(cb: () => void): void {
  _onClearCallbacks.push(cb);
}

let _clearing = false;

export function clearAuth(): void {
  if (_clearing) return;
  _clearing = true;
  try {
    // Reset in-memory stores to defaults BEFORE clearing localStorage,
    // so the persistence effects re-write defaults (not stale user data).
    resetConfig();
    resetViewState();
    // Clear localStorage entries (persistence effects will write back defaults)
    localStorage.removeItem(AUTH_STORAGE_KEY);
    localStorage.removeItem(CONFIG_STORAGE_KEY);
    localStorage.removeItem(VIEW_STORAGE_KEY);
    localStorage.removeItem(DASHBOARD_STORAGE_KEY);
    _setToken(null);
    setUser(null);
    // Clear IndexedDB cache to prevent data leakage between users (SDR-016)
    clearCache().catch(() => {
      // Non-fatal — cache clear failure should not block logout
    });
    // Run registered cleanup callbacks (e.g., poll state reset)
    for (const cb of _onClearCallbacks) {
      try { cb(); } catch (e) { console.warn("[auth] onAuthCleared callback threw:", e); }
    }
    console.info("[auth] auth cleared");
  } finally {
    _clearing = false;
  }
}

/** Clear only the auth token. Preserves all user data (config, view state, dashboard
 *  cache) so the same user's preferences and cached data survive re-authentication.
 *  Used when a token becomes invalid (expired PAT, revoked OAuth) — NOT for explicit
 *  logout. Full data wipe (cross-user data isolation) is handled by clearAuth()
 *  which is reserved for explicit user actions (Sign out, Reset all).
 *
 *  Callers MUST navigate away after calling this (e.g., window.location.replace or
 *  router navigate to /login). Fires onAuthCleared callbacks (resets poll state,
 *  clears API usage data). Use clearAuth() if not navigating. */
export function expireToken(): void {
  localStorage.removeItem(AUTH_STORAGE_KEY);
  localStorage.removeItem(DASHBOARD_STORAGE_KEY);
  _setToken(null);
  setUser(null);
  _onClearCallbacks.forEach((cb) => { try { cb(); } catch (e) { console.warn("[auth] callback failed during expireToken:", e); } });
  console.info("[auth] token expired (dashboard cache cleared)");
}

const VALIDATE_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
} as const;

export async function validateToken(): Promise<boolean> {
  const currentToken = _token();
  if (!currentToken) return false;

  const headers = { ...VALIDATE_HEADERS, Authorization: `Bearer ${currentToken}` };

  function handleSuccess(userData: GitHubUser): true {
    setUser({ login: userData.login, avatar_url: userData.avatar_url, name: userData.name });
    navigator.storage?.persist?.()?.catch(() => {});
    return true;
  }

  try {
    const resp = await fetch("https://api.github.com/user", { headers });

    if (resp.ok) {
      return handleSuccess((await resp.json()) as GitHubUser);
    }

    if (resp.status === 401) {
      // GitHub API can return transient 401s due to database replication lag.
      // Retry once after a delay before invalidating the token.
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const retry = await fetch("https://api.github.com/user", { headers });
        if (retry.ok) {
          return handleSuccess((await retry.json()) as GitHubUser);
        }
        if (retry.status !== 401) {
          // Non-auth error on retry (e.g. 500) — preserve token, try next load
          return false;
        }
      } catch {
        // Network error on retry — preserve token, try next load
        return false;
      }

      // Guard: if the token was replaced during the retry window (e.g., user
      // re-authenticated via OAuth callback), don't invalidate the new token.
      if (_token() !== currentToken) {
        return false;
      }

      // Both attempts returned 401 — token is genuinely invalid
      console.info(
        config.authMethod === "pat"
          ? "[auth] PAT invalid or expired — clearing token"
          : "[auth] access token invalid — clearing token"
      );
      expireToken();
      return false;
    }

    return false;
  } catch {
    // Network error — permanent token survives transient failures
    return false;
  }
}

// Cross-tab auth sync: if another tab clears the token, this tab should also clear.
// Uses expireToken() (not clearAuth()) to avoid wiping config/view that may still be valid.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e: StorageEvent) => {
    if (e.key === AUTH_STORAGE_KEY && e.newValue === null && _token()) {
      // Re-check: a rapid sign-out/sign-in may have already replaced the token
      if (localStorage.getItem(AUTH_STORAGE_KEY) !== null) return;
      expireToken();
      window.location.replace("/login");
    }
  });
}
