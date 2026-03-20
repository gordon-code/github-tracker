import { createSignal } from "solid-js";
import { clearCache } from "./cache";

const AUTH_STORAGE_KEY = "github-tracker:auth";

export interface AuthTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
}

export interface GitHubUser {
  login: string;
  avatar_url: string;
  name: string | null;
}

interface TokenExchangeResponse {
  access_token: string;
  token_type?: string;
  scope?: string;
  refresh_token?: string | null;
  expires_in?: number | null;
}

// ── Internal helpers ────────────────────────────────────────────────────────

function readStoredTokens(): AuthTokens | null {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>)["accessToken"] === "string"
    ) {
      return parsed as AuthTokens;
    }
    return null;
  } catch {
    return null;
  }
}

function writeStoredTokens(tokens: AuthTokens): void {
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(tokens));
}

function removeStoredTokens(): void {
  localStorage.removeItem(AUTH_STORAGE_KEY);
}

// ── Signals ─────────────────────────────────────────────────────────────────

const stored = readStoredTokens();

const [_token, _setToken] = createSignal<string | null>(
  stored?.accessToken ?? null
);
const [user, setUser] = createSignal<GitHubUser | null>(null);

export const token = _token;

export function isAuthenticated(): boolean {
  return _token() !== null && user() !== null;
}

export { user };

// ── Actions ─────────────────────────────────────────────────────────────────

export function setAuth(response: TokenExchangeResponse): void {
  const expiresAt = response.expires_in
    ? Date.now() + response.expires_in * 1000
    : null;

  const tokens: AuthTokens = {
    accessToken: response.access_token,
    refreshToken: response.refresh_token ?? null,
    expiresAt,
  };

  writeStoredTokens(tokens);
  _setToken(response.access_token);
  console.info("[auth] tokens stored");
}

export function clearAuth(): void {
  removeStoredTokens();
  // Clear config and view state to prevent data leakage between users (SDR-016)
  localStorage.removeItem("github-tracker:config");
  localStorage.removeItem("github-tracker:view");
  _setToken(null);
  setUser(null);
  // Clear IndexedDB cache to prevent data leakage between users (SDR-016)
  clearCache().catch(() => {
    // Non-fatal — cache clear failure should not block logout
  });
  console.info("[auth] auth cleared");
}

export async function refreshAccessToken(): Promise<boolean> {
  const stored = readStoredTokens();
  if (!stored?.refreshToken) {
    console.info("[auth] no refresh token available");
    clearAuth();
    return false;
  }

  try {
    const resp = await fetch("/api/oauth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: stored.refreshToken }),
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

    setAuth(data);

    // Validate the new token before committing (SDR-013)
    const valid = await validateToken();
    if (!valid) {
      console.info("[auth] new token failed validation — clearing auth");
      clearAuth();
      return false;
    }

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
