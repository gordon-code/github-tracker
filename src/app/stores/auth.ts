import { createSignal } from "solid-js";
import * as Sentry from "@sentry/solid";
import { clearCache } from "./cache";
import { CONFIG_STORAGE_KEY, resetConfig, updateConfig, config } from "./config";
import { VIEW_STORAGE_KEY, resetViewState } from "./view";
import { pushNotification } from "../lib/errors";
import { clearJiraKeyCache } from "../services/jira-keys";
import type { JiraAuthState } from "../../shared/jira-types";
import { JiraConfigSchema } from "../../shared/schemas";

export type { JiraAuthState } from "../../shared/jira-types";

export const AUTH_STORAGE_KEY = "github-tracker:auth-token";
export const DASHBOARD_STORAGE_KEY = "github-tracker:dashboard";
export const JIRA_AUTH_STORAGE_KEY = "github-tracker:jira-auth";

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

// ── Jira auth signals ────────────────────────────────────────────────────────

const [_jiraAuth, _setJiraAuth] = createSignal<JiraAuthState | null>(
  (() => {
    try {
      const raw = localStorage.getItem?.(JIRA_AUTH_STORAGE_KEY);
      return raw ? (JSON.parse(raw) as JiraAuthState) : null;
    } catch {
      return null;
    }
  })()
);

export const jiraAuth = _jiraAuth;

export function isJiraAuthenticated(): boolean {
  return _jiraAuth() !== null;
}

export function setJiraAuth(state: JiraAuthState): void {
  try {
    localStorage.setItem(JIRA_AUTH_STORAGE_KEY, JSON.stringify(state));
  } catch {
    pushNotification("localStorage:jira-auth", "Jira auth write failed — storage may be full. Auth exists in memory only this session.", "warning");
  }
  _setJiraAuth(state);
}

export function clearJiraAuth(): void {
  localStorage.removeItem(JIRA_AUTH_STORAGE_KEY);
  _setJiraAuth(null);
  updateConfig({ jira: JiraConfigSchema.parse({}) });
  clearJiraKeyCache();
}

// ── Jira token refresh ───────────────────────────────────────────────────────

let _refreshingJira: Promise<boolean> | null = null;

export async function ensureJiraTokenValid(): Promise<boolean> {
  const auth = _jiraAuth();
  if (!auth) return false;

  // API token mode: three independent guards prevent refresh (authMethod check,
  // empty sealedRefreshToken, MAX_SAFE_INTEGER expiresAt)
  if (config.jira?.authMethod === "token") return true;
  if (!auth.sealedRefreshToken) return true;

  if (auth.expiresAt >= Date.now() + 300_000) return true;

  // Single-flight guard: concurrent calls share one refresh promise
  if (_refreshingJira !== null) return _refreshingJira;

  _refreshingJira = (async (): Promise<boolean> => {
    try {
      let resp: Response;
      try {
        resp = await fetch("/api/oauth/jira/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sealed_refresh_token: auth.sealedRefreshToken }),
        });
      } catch {
        // Network error — preserve tokens, transient failure
        return false;
      }

      if (resp.status === 401) {
        // Refresh token expired or revoked
        clearJiraAuth();
        pushNotification("jira:refresh", "Jira session expired — please reconnect in Settings.", "warning");
        return false;
      }

      if (!resp.ok) return false;

      const data = (await resp.json()) as { access_token: string; sealed_refresh_token: string; expires_in: number };
      if (!data.access_token || !data.sealed_refresh_token) return false;

      const current = _jiraAuth();
      if (!current) return false;

      setJiraAuth({
        ...current,
        accessToken: data.access_token,
        sealedRefreshToken: data.sealed_refresh_token,
        expiresAt: Date.now() + data.expires_in * 1000,
      });
      return true;
    } finally {
      _refreshingJira = null;
    }
  })();

  return _refreshingJira;
}

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
    // Clear IndexedDB cache to prevent data leakage between users
    clearCache().catch((err) => {
      console.warn("[auth] Cache clear failed during logout:", err);
      Sentry.captureException(err, { tags: { source: "auth-logout-cache-clear" } });
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

// Register Jira auth cleanup when GitHub auth is cleared (full logout).
// Only clears localStorage + signal — does NOT call updateConfig because
// clearAuth() already called resetConfig() which resets all fields to defaults.
onAuthCleared(() => {
  localStorage.removeItem(JIRA_AUTH_STORAGE_KEY);
  _setJiraAuth(null);
});

// Cross-tab auth sync: if another tab clears the token, this tab should also clear.
// Uses expireToken() (not clearAuth()) to avoid wiping config/view that may still be valid.
// Also syncs Jira auth across tabs — critical for rotating refresh tokens: a stale tab
// holding an already-invalidated token would fail on its next Jira request.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e: StorageEvent) => {
    if (e.key === AUTH_STORAGE_KEY && e.newValue === null && _token()) {
      // Re-check: a rapid sign-out/sign-in may have already replaced the token
      if (localStorage.getItem(AUTH_STORAGE_KEY) !== null) return;
      expireToken();
      window.location.replace("/login");
    }
    if (e.key === JIRA_AUTH_STORAGE_KEY) {
      try {
        const raw = e.newValue;
        _setJiraAuth(raw ? (JSON.parse(raw) as JiraAuthState) : null);
      } catch {
        _setJiraAuth(null);
      }
    }
  });
}
