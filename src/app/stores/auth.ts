import { createSignal } from "solid-js";
import { clearCache } from "./cache";
import { CONFIG_STORAGE_KEY, resetConfig } from "./config";
import { VIEW_STORAGE_KEY, resetViewState } from "./view";

export interface GitHubUser {
  login: string;
  avatar_url: string;
  name: string | null;
}

interface TokenExchangeResponse {
  access_token: string;
  token_type?: string;
  scope?: string;
  expires_in?: number | null;
}

// ── Signals ─────────────────────────────────────────────────────────────────

// Access token is kept in-memory only (never persisted to localStorage).
// On page reload, refreshAccessToken() uses the HttpOnly refresh token cookie
// to obtain a fresh access token from the Worker.
const [_token, _setToken] = createSignal<string | null>(null);
const [user, setUser] = createSignal<GitHubUser | null>(null);

export const token = _token;

export function isAuthenticated(): boolean {
  return _token() !== null && user() !== null;
}

export { user };

// ── Actions ─────────────────────────────────────────────────────────────────

export function setAuth(response: TokenExchangeResponse): void {
  _setToken(response.access_token);
  console.info("[auth] access token set (in-memory)");
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
  localStorage.removeItem(CONFIG_STORAGE_KEY);
  localStorage.removeItem(VIEW_STORAGE_KEY);
  _setToken(null);
  setUser(null);
  // Clear HttpOnly refresh token cookie via Worker (fire-and-forget)
  fetch("/api/oauth/logout", { method: "POST" }).catch(() => {});
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

export async function refreshAccessToken(): Promise<boolean> {
  try {
    // Refresh token is in an HttpOnly cookie — the browser sends it automatically
    const resp = await fetch("/api/oauth/refresh", {
      method: "POST",
    });

    if (!resp.ok) {
      console.info("[auth] token refresh failed — clearing auth");
      clearAuth();
      return false;
    }

    const data = (await resp.json()) as TokenExchangeResponse;

    if (typeof data.access_token !== "string") {
      console.info("[auth] token refresh returned invalid response");
      clearAuth();
      return false;
    }

    // Validate the new token before setting it (SDR-013)
    const validationResp = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${data.access_token}`,
        Accept: "application/vnd.github+json",
      },
    });

    if (!validationResp.ok) {
      console.info("[auth] new token failed validation — clearing auth");
      clearAuth();
      return false;
    }

    // Token is valid — set it in memory
    setAuth(data);

    // Populate user signal from validation response
    const userData = (await validationResp.json()) as {
      login: string;
      avatar_url: string;
      name: string | null;
    };
    setUser(userData);

    console.info("[auth] token refresh succeeded");
    return true;
  } catch {
    console.info("[auth] token refresh error — clearing auth");
    clearAuth();
    return false;
  }
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
      console.info("[auth] access token expired — attempting refresh");
      return refreshAccessToken();
    }

    return false;
  } catch {
    return false;
  }
}
