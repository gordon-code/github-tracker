import { createSignal } from "solid-js";
import { clearCache } from "./cache";
import { CONFIG_STORAGE_KEY, resetConfig } from "./config";
import { VIEW_STORAGE_KEY, resetViewState } from "./view";

export const AUTH_STORAGE_KEY = "github-tracker:auth-token";

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
const [_token, _setToken] = createSignal<string | null>(
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  typeof localStorage !== "undefined" ? (localStorage.getItem?.(AUTH_STORAGE_KEY) ?? null) : null
);
const [user, setUser] = createSignal<GitHubUser | null>(null);

export const token = _token;

export function isAuthenticated(): boolean {
  return _token() !== null && user() !== null;
}

export { user };

// ── Actions ─────────────────────────────────────────────────────────────────

export function setAuth(response: TokenExchangeResponse): void {
  localStorage.setItem(AUTH_STORAGE_KEY, response.access_token);
  _setToken(response.access_token);
  console.info("[auth] access token set (localStorage)");
}

const _onClearCallbacks: (() => void)[] = [];

/** Register a callback to run when auth is cleared. Avoids circular imports. */
export function onAuthCleared(cb: () => void): void {
  _onClearCallbacks.push(cb);
}

export function clearAuth(): void {
  // Reset in-memory stores to defaults BEFORE clearing localStorage,
  // so the persistence effects re-write defaults (not stale user data).
  resetConfig();
  resetViewState();
  // Clear localStorage entries (persistence effects will write back defaults)
  localStorage.removeItem(AUTH_STORAGE_KEY);
  localStorage.removeItem(CONFIG_STORAGE_KEY);
  localStorage.removeItem(VIEW_STORAGE_KEY);
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
}

export async function validateToken(): Promise<boolean> {
  const currentToken = _token();
  if (!currentToken) return false;

  try {
    const resp = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${currentToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (resp.ok) {
      const userData = (await resp.json()) as GitHubUser;
      setUser({
        login: userData.login,
        avatar_url: userData.avatar_url,
        name: userData.name,
      });
      return true;
    }

    if (resp.status === 401) {
      // Permanent token is revoked — clear auth and redirect to login
      console.info("[auth] access token invalid — clearing auth");
      clearAuth();
      return false;
    }

    return false;
  } catch {
    // Network error — permanent token survives transient failures
    return false;
  }
}
