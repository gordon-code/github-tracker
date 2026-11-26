import { createSignal } from "solid-js";
import * as z from "zod/mini";
import { captureException } from "../lib/sentry-facade";
import { clearCache } from "./cache";
import { clearSnapshot } from "../lib/dashboard-snapshot";
import { CONFIG_STORAGE_KEY, resetConfig, updateConfig, config } from "./config";
import { VIEW_STORAGE_KEY, resetViewState } from "./view";
import { pushNotification, dismissNotificationBySource } from "../lib/errors";
import { clearJiraKeyCache } from "../services/jira-keys";
import { JIRA_SETTINGS_ACTION, type JiraAuthState } from "../../shared/jira-types";
import { JiraConfigSchema } from "../../shared/schemas";
import {
  AUTH_OUTAGE_NOTIFICATION_SOURCE,
  DASHBOARD_BODIES_STORAGE_KEY,
  PAT_EXPIRY_DISMISSED_KEY,
} from "../../shared/types";

// Zod schema for JiraAuthState — validates the localStorage-persisted blob on load.
const JiraAuthStateSchema = z.object({
  accessToken: z.string().check(z.minLength(1)),
  sealedRefreshToken: z.string(),
  expiresAt: z.number(),
  cloudId: z.string().check(z.minLength(1)),
  siteUrl: z.url(),
  siteName: z.string().check(z.minLength(1)),
  email: z.optional(z.string()),
});

export type { JiraAuthState } from "../../shared/jira-types";

export const AUTH_STORAGE_KEY = "github-tracker:auth-token";
export const LAST_USER_STORAGE_KEY = "github-tracker:last-user";
export const DASHBOARD_STORAGE_KEY = "github-tracker:dashboard";
export const DEP_META_STORAGE_KEY = "github-tracker:dep-meta";
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

function safeGetStorage(key: string): string | null {
  try {
    return localStorage.getItem?.(key) ?? null;
  } catch {
    return null;
  }
}

function safeRemoveStorage(key: string): void {
  try {
    localStorage.removeItem?.(key);
  } catch {
    // ignore
  }
}

// ── Signals ─────────────────────────────────────────────────────────────────

// Access token is persisted to localStorage for permanent OAuth App tokens.
// On page reload, validateToken() reads from localStorage and verifies with GitHub.
// Optional chaining: happy-dom initializes localStorage methods lazily, so getItem
// may not be a function yet during early module initialization in tests.
const [_token, _setToken] = createSignal<string | null>(safeGetStorage(AUTH_STORAGE_KEY));
const [user, _setUser] = createSignal<GitHubUser | null>(null);

function setUser(u: GitHubUser | null): void {
  _setUser(u);
  if (u !== null) {
    const trimmed = u.login.trim();
    if (trimmed.length > 0) {
      try {
        localStorage.setItem(LAST_USER_STORAGE_KEY, trimmed.toLowerCase());
      } catch {
        // best-effort: storage full or private mode
      }
    }
  }
}

export const token = _token;

export function isAuthenticated(): boolean {
  return _token() !== null && user() !== null;
}

export { user };

let _identityEpoch = 0;

/**
 * Monotonically increasing counter tracking identity boundaries.
 * Invariant: Every increment of _identityEpoch is followed by either the
 * onAuthCleared callbacks (which reset module-level fetch flags) or a full
 * page reload. Never increment on same-user token rotation.
 */
export function identityEpoch(): number {
  return _identityEpoch;
}

// ── Jira auth signals ────────────────────────────────────────────────────────

const [_jiraAuth, _setJiraAuth] = createSignal<JiraAuthState | null>(
  (() => {
    try {
      const raw = safeGetStorage(JIRA_AUTH_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as unknown;
      const result = JiraAuthStateSchema.safeParse(parsed);
      if (!result.success) {
        // Corrupt or outdated auth blob — evict it so user is prompted to reconnect
        localStorage.removeItem?.(JIRA_AUTH_STORAGE_KEY);
        return null;
      }
      return result.data;
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
  const prev = _jiraAuth();
  localStorage.removeItem(JIRA_AUTH_STORAGE_KEY);
  _setJiraAuth(null);
  if (
    config.jira?.enabled &&
    prev &&
    (!config.jira.cloudId || config.jira.cloudId === prev.cloudId)
  ) {
    updateConfig({
      jira: {
        ...config.jira,
        cloudId: config.jira.cloudId ?? prev.cloudId,
        siteUrl: config.jira.siteUrl ?? prev.siteUrl,
        siteName: config.jira.siteName ?? prev.siteName,
        ...(prev.email && !config.jira.email ? { email: prev.email } : {}),
      },
    });
  }
  clearJiraKeyCache();
}

export function clearJiraConfigFull(): void {
  localStorage.removeItem(JIRA_AUTH_STORAGE_KEY);
  _setJiraAuth(null);
  updateConfig({ jira: JiraConfigSchema.parse({}) });
  clearJiraKeyCache();
}

function wipeJiraAuthForIdentityReset(): void {
  safeRemoveStorage(JIRA_AUTH_STORAGE_KEY);
  _setJiraAuth(null);
  clearJiraKeyCache();
}

function classifyIncomingIdentity(incomingLogin: string): "same" | "mismatch" | "unknown_with_jira" {
  const storedLastUser = safeGetStorage(LAST_USER_STORAGE_KEY)?.trim() || null;
  const currentLogin = user()?.login?.trim() || null;
  const previousOwner = currentLogin ?? storedLastUser;

  if (previousOwner !== null && previousOwner.toLowerCase() !== incomingLogin.trim().toLowerCase()) {
    return "mismatch";
  }
  if (previousOwner === null && (_jiraAuth() !== null || safeGetStorage(JIRA_AUTH_STORAGE_KEY) !== null)) {
    return "unknown_with_jira";
  }
  return "same";
}

// ── Jira token refresh ───────────────────────────────────────────────────────

let _refreshingJira: Promise<boolean> | null = null;

export async function ensureJiraTokenValid(): Promise<boolean> {
  const auth = _jiraAuth();
  if (!auth) return false;

  // API token mode: two explicit guards prevent refresh (authMethod check,
  // empty sealedRefreshToken). Token auth sets expiresAt = MAX_SAFE_INTEGER,
  // so the expiry arithmetic below also short-circuits, but implicitly.
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
          headers: { "Content-Type": "application/json", "X-Requested-With": "fetch" },
          body: JSON.stringify({ sealed_refresh_token: auth.sealedRefreshToken }),
        });
      } catch {
        // Network error — preserve tokens, transient failure
        return false;
      }

      if (resp.status === 401) {
        // Refresh token expired or revoked
        clearJiraAuth();
        pushNotification("jira:refresh", "Jira session expired — please reconnect in Settings.", "warning", false, JIRA_SETTINGS_ACTION);
        return false;
      }

      if (!resp.ok) return false;

      const data = (await resp.json()) as { access_token: string; sealed_refresh_token: string; expires_in: number };
      if (!data.access_token || !data.sealed_refresh_token) return false;

      const current = _jiraAuth();
      if (!current) return false;

      const expiresIn = typeof data.expires_in === "number" && data.expires_in > 0
        ? data.expires_in
        : 3600;
      setJiraAuth({
        ...current,
        accessToken: data.access_token,
        sealedRefreshToken: data.sealed_refresh_token,
        expiresAt: Date.now() + expiresIn * 1000,
      });
      return true;
    } finally {
      _refreshingJira = null;
    }
  })();

  return _refreshingJira;
}

// ── Token verification & outage suspension state ─────────────────────────────

const TOKEN_CHECK_TIMEOUT_MS = 10_000;
const UNAUTHORIZED_PRESERVED_COOLDOWN_MS = 15_000;

export interface UnauthorizedContext {
  endpointKind?: "user" | "graphql" | "rest";
  requestId?: string | null;
}

export type UnauthorizedOutcome = "expired" | "preserved" | "ignored";

export const authNavigation = {
  redirectToLogin(): void {
    window.location.replace("/login");
  },
};

let _tokenPersistedToStorage = safeGetStorage(AUTH_STORAGE_KEY) !== null;
const _activeVerificationControllers = new Set<AbortController>();
let _pendingVerification: {
  token: string;
  epoch: number;
  controller: AbortController;
  promise: Promise<UnauthorizedOutcome>;
} | null = null;
let _preservedCooldown: {
  token: string;
  epoch: number;
  until: number;
} | null = null;
let _outageSuspendStartedAt: number | null = null;

export function clearAuthOutageSuspension(): void {
  if (_outageSuspendStartedAt === null) return;
  _outageSuspendStartedAt = null;
  dismissNotificationBySource(AUTH_OUTAGE_NOTIFICATION_SOURCE);
}

function abortAndClearPendingVerifications(): void {
  for (const controller of _activeVerificationControllers) {
    controller.abort();
  }
  _activeVerificationControllers.clear();
  _pendingVerification = null;
  _preservedCooldown = null;
}

function setTokenInternal(nextToken: string | null, persisted: boolean): void {
  _tokenPersistedToStorage = persisted;
  if (nextToken !== _token()) {
    abortAndClearPendingVerifications();
    clearAuthOutageSuspension();
    _setToken(nextToken);
  }
}

export function _resetAuthVerificationState(): void {
  abortAndClearPendingVerifications();
  _outageSuspendStartedAt = null;
  _tokenPersistedToStorage = safeGetStorage(AUTH_STORAGE_KEY) !== null;
}

// ── Actions ─────────────────────────────────────────────────────────────────

export function setAuth(response: TokenExchangeResponse): void {
  let persisted = false;
  try {
    localStorage.setItem(AUTH_STORAGE_KEY, response.access_token);
    persisted = true;
  } catch {
    pushNotification("localStorage:auth", "Auth token write failed — storage may be full. Token exists in memory only this session.", "warning");
  }
  abortAndClearPendingVerifications();
  clearAuthOutageSuspension();
  setTokenInternal(response.access_token, persisted);
  console.info("[auth] access token set");
}

function resetPerIdentityLocalState(): void {
  resetConfig();
  resetViewState();
  safeRemoveStorage(CONFIG_STORAGE_KEY);
  safeRemoveStorage(VIEW_STORAGE_KEY);
}

export function setAuthFromPat(
  patToken: string,
  userData: GitHubUser,
  patExpiresAt: string | null = null
): void {
  const normalizedExpiry =
    typeof patExpiresAt === "string" && z.iso.date().safeParse(patExpiresAt).success
      ? patExpiresAt
      : null;
  const identityClass = classifyIncomingIdentity(userData.login);

  if (identityClass === "mismatch") {
    // A different GitHub identity is taking over this browser tab/session
    // (Settings > Replace token, used for a user switch rather than rotating
    // one's own token) — do a full reset matching clearAuth(): config
    // (selectedRepos/selectedOrgs/trackedUsers/etc.) and view state are
    // genuinely per-identity data, not just UI preferences, so the incoming
    // identity must not inherit the outgoing one's. Reset in-memory stores
    // BEFORE clearing localStorage, so the persistence effects re-write
    // defaults (not stale user data) — same ordering as clearAuth(). We do
    // NOT touch AUTH_STORAGE_KEY or DASHBOARD_STORAGE_KEY here: the former is
    // overwritten below with the new token, and the latter is already
    // cleared by resetDashboardData() in the callback loop below.
    resetPerIdentityLocalState();
    // Clear IndexedDB cache + per-identity in-memory state. Fire-and-forget
    // here (preserving this synchronous path's long-standing non-blocking
    // behavior — the callback loop still runs synchronously because it precedes
    // the awaited cache clear inside clearIdentityData). The pre-auth Login-page
    // import path calls `await clearIdentityData()` directly when it needs a
    // real ordering guarantee before establishing a new identity.
    void clearIdentityData();
  } else if (identityClass === "unknown_with_jira") {
    wipeJiraAuthForIdentityReset();
  }

  setAuth({ access_token: patToken });
  setUser({ login: userData.login, avatar_url: userData.avatar_url, name: userData.name });
  updateConfig({ authMethod: "pat", patExpiresAt: normalizedExpiry });
  safeRemoveStorage(PAT_EXPIRY_DISMISSED_KEY);
}

/**
 * One-line self-documenting alias: an imported credential (PAT or OAuth) is
 * established via the same identity-agnostic mechanics as a PAT replacement
 * (store token, store user, detect identity switch, reset per-identity state).
 * The alias makes that agnosticism visible at the import call site without a
 * reader tracing into `setAuthFromPat`.
 */
export const setAuthFromCredential = setAuthFromPat;

function clearSnapshotLogged(): Promise<void> {
  return clearSnapshot().catch((err: unknown) => {
    console.warn("[auth] failed to clear dashboard snapshot:", err);
  });
}

/**
 * Clears per-identity data: the `onAuthCleared` callback loop (poll data,
 * notifications, toast dedup, dashboard cache), the IndexedDB
 * dashboard snapshot, AND the IndexedDB API cache. The callbacks and the
 * snapshot clear's synchronous part (cancelling pending snapshot writes) run
 * before the first `await`, so a fire-and-forget `void clearIdentityData()`
 * preserves `setAuthFromPat`'s historical synchronous callback behavior; both
 * IndexedDB clears are AWAITED (not fire-and-forget) so a caller doing
 * `await clearIdentityData()` gets a real ordering guarantee — required by the
 * pre-auth Login-page import path, where `setAuthFromPat`'s own cache-clear is
 * inert (`isIdentitySwitch` needs `user()` non-null) and `expireToken()` never
 * clears the API cache (`clearCache`).
 */
function clearDashboardStorageKeys(): void {
  safeRemoveStorage(DASHBOARD_STORAGE_KEY);
  safeRemoveStorage(DEP_META_STORAGE_KEY);
  safeRemoveStorage(DASHBOARD_BODIES_STORAGE_KEY);
}

function runOnClearCallbacks(): void {
  for (const cb of _onClearCallbacks) {
    try { cb(); } catch (e) { console.warn("[auth] onAuthCleared callback threw:", e); }
  }
}

export async function clearIdentityData(): Promise<void> {
  safeRemoveStorage(LAST_USER_STORAGE_KEY);
  safeRemoveStorage(PAT_EXPIRY_DISMISSED_KEY);
  wipeJiraAuthForIdentityReset();
  clearDashboardStorageKeys();
  _identityEpoch++;
  // Synchronous per-identity resets first (matches the ordering the identity-
  // switch branch has always had: callbacks complete before the awaited work).
  runOnClearCallbacks();
  const snapshotClear = clearSnapshotLogged();
  // IndexedDB cache clear — AWAITED so callers can sequence work strictly after it
  // (prevents a new identity rendering the previous identity's cached data).
  try {
    await clearCache();
  } catch (err) {
    console.warn("[auth] Cache clear failed during identity data clear:", err);
    captureException(err, { tags: { source: "auth-identity-data-cache-clear" } });
  }
  await snapshotClear;
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
    safeRemoveStorage(AUTH_STORAGE_KEY);
    safeRemoveStorage(LAST_USER_STORAGE_KEY);
    safeRemoveStorage(PAT_EXPIRY_DISMISSED_KEY);
    wipeJiraAuthForIdentityReset();
    safeRemoveStorage(CONFIG_STORAGE_KEY);
    safeRemoveStorage(VIEW_STORAGE_KEY);
    clearDashboardStorageKeys();
    setTokenInternal(null, false);
    setUser(null);
    _identityEpoch++;
    // Clear IndexedDB cache and snapshot to prevent data leakage between users
    clearCache().catch((err) => {
      console.warn("[auth] Cache clear failed during logout:", err);
      captureException(err, { tags: { source: "auth-logout-cache-clear" } });
    });
    void clearSnapshotLogged();
    // Run registered cleanup callbacks (e.g., poll state reset)
    runOnClearCallbacks();
    console.info("[auth] auth cleared");
  } finally {
    _clearing = false;
  }
}

/** Clear the auth token and dashboard snapshot/cache while preserving user
 *  preferences (config and view state) so they survive re-authentication.
 *  Used when a token becomes invalid (expired PAT, revoked OAuth) — NOT for explicit
 *  logout. Full data wipe (cross-user data isolation) is handled by clearAuth()
 *  which is reserved for explicit user actions (Sign out, Reset all).
 *
 *  Callers MUST navigate away after calling this (e.g., window.location.replace or
 *  router navigate to /login). Fires onAuthCleared callbacks (resets poll state,
 *  clears API usage data). Use clearAuth() if not navigating. */
export function expireToken(): void {
  safeRemoveStorage(AUTH_STORAGE_KEY);
  clearDashboardStorageKeys();
  setTokenInternal(null, false);
  setUser(null);
  _identityEpoch++;
  void clearSnapshotLogged();
  runOnClearCallbacks();
  console.info("[auth] token expired (dashboard cache cleared)");
}

const VALIDATE_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
} as const;

function parseGitHubUserPayload(raw: unknown): GitHubUser | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.login !== "string" || typeof r.avatar_url !== "string") return null;
  if (r.name !== null && typeof r.name !== "string") return null;
  const trimmedLogin = r.login.trim();
  if (trimmedLogin.length === 0) return null;
  return { login: trimmedLogin, avatar_url: r.avatar_url, name: r.name };
}

function isCurrentSession(
  capturedToken: string,
  capturedEpoch: number,
  signal: AbortSignal
): boolean {
  if (signal.aborted || _token() !== capturedToken || identityEpoch() !== capturedEpoch) {
    return false;
  }
  if (!_tokenPersistedToStorage) return true;
  return safeGetStorage(AUTH_STORAGE_KEY) === capturedToken;
}

function combineAbortSignals(signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === "function") return AbortSignal.any(signals);
  const controller = new AbortController();
  const listeners: Array<[AbortSignal, () => void]> = [];
  const detach = () => {
    for (const [s, l] of listeners) s.removeEventListener("abort", l);
    listeners.length = 0;
  };
  for (const s of signals) {
    if (s.aborted) {
      controller.abort(s.reason);
      detach();
      break;
    }
    const onAbort = () => {
      controller.abort(s.reason);
      detach();
    };
    listeners.push([s, onAbort]);
    s.addEventListener("abort", onAbort, { once: true });
  }
  return controller.signal;
}

function makeUserCheckFetcher(capturedToken: string, signal?: AbortSignal): () => Promise<Response> {
  const headers = { ...VALIDATE_HEADERS, Authorization: `Bearer ${capturedToken}` };
  return () => {
    const timeout = AbortSignal.timeout(TOKEN_CHECK_TIMEOUT_MS);
    return fetch("https://api.github.com/user", {
      headers,
      cache: "no-store",
      signal: signal ? combineAbortSignals([signal, timeout]) : timeout,
    });
  };
}

function makeAuth401Deps(
  capturedToken: string,
  capturedEpoch: number,
  signal: AbortSignal,
  fetchUserCheck: () => Promise<Response>
) {
  return {
    isCurrentSession: () => isCurrentSession(capturedToken, capturedEpoch, signal),
    fetchUserCheck,
    parseGitHubUserPayload,
    clearAuthOutageSuspension,
    getOutageSuspendStartedAt: () => _outageSuspendStartedAt,
    setOutageSuspendStartedAt: (ts: number) => {
      _outageSuspendStartedAt = ts;
    },
    getAuthMethod: () => config.authMethod,
    expireToken,
    redirectToLogin: () => authNavigation.redirectToLogin(),
  };
}

export async function handleRuntimeUnauthorized(
  failingToken: string,
  ctx?: UnauthorizedContext
): Promise<UnauthorizedOutcome> {
  const currentEpoch = identityEpoch();
  if (!failingToken || _token() !== failingToken) {
    return "ignored";
  }
  if (_tokenPersistedToStorage && safeGetStorage(AUTH_STORAGE_KEY) !== failingToken) {
    return "ignored";
  }

  if (
    _pendingVerification !== null &&
    _pendingVerification.token === failingToken &&
    _pendingVerification.epoch === currentEpoch &&
    !_pendingVerification.controller.signal.aborted
  ) {
    return _pendingVerification.promise;
  }

  if (
    _preservedCooldown !== null &&
    _preservedCooldown.token === failingToken &&
    _preservedCooldown.epoch === currentEpoch &&
    Date.now() < _preservedCooldown.until
  ) {
    return "preserved";
  }

  const controller = new AbortController();
  _activeVerificationControllers.add(controller);

  const entry: NonNullable<typeof _pendingVerification> = {
    token: failingToken,
    epoch: currentEpoch,
    controller,
    promise: Promise.resolve("ignored"),
  };
  _pendingVerification = entry;

  entry.promise = (async (): Promise<UnauthorizedOutcome> => {
    try {
      if (!isCurrentSession(failingToken, currentEpoch, controller.signal)) {
        return "ignored";
      }

      const mod = await import("./auth-401").catch(() => null);
      if (!isCurrentSession(failingToken, currentEpoch, controller.signal)) {
        return "ignored";
      }

      let outcome: UnauthorizedOutcome;
      if (!mod) {
        outcome = "preserved";
      } else {
        const result = await mod.handle401SlowPath(
          "runtime",
          controller.signal,
          makeAuth401Deps(
            failingToken,
            currentEpoch,
            controller.signal,
            makeUserCheckFetcher(failingToken, controller.signal)
          ),
          ctx
        );
        outcome = result.outcome;
      }

      if (
        outcome === "preserved" &&
        isCurrentSession(failingToken, currentEpoch, controller.signal)
      ) {
        _preservedCooldown = {
          token: failingToken,
          epoch: currentEpoch,
          until: Date.now() + UNAUTHORIZED_PRESERVED_COOLDOWN_MS,
        };
      }
      return outcome;
    } finally {
      _activeVerificationControllers.delete(controller);
      if (_pendingVerification === entry) {
        _pendingVerification = null;
      }
    }
  })();

  return entry.promise;
}

export async function validateToken(): Promise<boolean> {
  const currentToken = _token();
  if (!currentToken) return false;

  const startEpoch = identityEpoch();
  const controller = new AbortController();
  _activeVerificationControllers.add(controller);

  try {
    if (!isCurrentSession(currentToken, startEpoch, controller.signal)) {
      return false;
    }

    const fetchUserCheck = makeUserCheckFetcher(currentToken, controller.signal);
    let resp: Response;
    try {
      resp = await fetchUserCheck();
    } catch {
      return false;
    }
    if (!isCurrentSession(currentToken, startEpoch, controller.signal)) {
      return false;
    }

    let userData: GitHubUser | undefined;
    if (resp.ok) {
      let raw: unknown;
      try {
        raw = await resp.json();
      } catch {
        return false;
      }
      if (!isCurrentSession(currentToken, startEpoch, controller.signal)) {
        return false;
      }
      const parsed = parseGitHubUserPayload(raw);
      if (parsed === null) {
        return false;
      }
      clearAuthOutageSuspension();
      userData = parsed;
    } else if (resp.status === 401) {
      const mod = await import("./auth-401").catch(() => null);
      if (!isCurrentSession(currentToken, startEpoch, controller.signal) || !mod) {
        return false;
      }
      const result = await mod.handle401SlowPath(
        "validate",
        controller.signal,
        makeAuth401Deps(currentToken, startEpoch, controller.signal, fetchUserCheck)
      );
      userData = result.userData;
    } else {
      return false;
    }

    if (!userData) {
      return false;
    }

    if (!isCurrentSession(currentToken, startEpoch, controller.signal)) {
      return false;
    }

    const identityClass = classifyIncomingIdentity(userData.login);
    if (identityClass === "mismatch") {
      resetPerIdentityLocalState();
      await clearIdentityData();
      if (controller.signal.aborted || _token() !== currentToken) {
        return false;
      }
    }

    setUser(userData);
    navigator.storage?.persist?.()?.catch(() => {});
    return true;
  } finally {
    _activeVerificationControllers.delete(controller);
  }
}

async function fetchUserForNewToken(accessToken: string): Promise<GitHubUser | null> {
  const fetchOnce = makeUserCheckFetcher(accessToken);

  let resp: Response;
  try {
    resp = await fetchOnce();
  } catch {
    return null;
  }

  if (resp.ok) {
    try {
      const raw: unknown = await resp.json();
      return parseGitHubUserPayload(raw);
    } catch {
      return null;
    }
  }

  if (resp.status !== 401) {
    return null;
  }

  const mod = await import("./auth-401").catch(() => null);
  if (!mod) {
    return null;
  }
  return mod.retryOAuthUserCheck(fetchOnce, parseGitHubUserPayload);
}

export async function completeOAuthLogin(accessToken: string): Promise<boolean> {
  if (!accessToken || !accessToken.trim()) {
    return false;
  }

  const userData = await fetchUserForNewToken(accessToken);
  if (!userData) {
    return false;
  }

  const identityClass = classifyIncomingIdentity(userData.login);
  if (identityClass === "mismatch") {
    resetPerIdentityLocalState();
    await clearIdentityData();
  } else if (identityClass === "unknown_with_jira") {
    wipeJiraAuthForIdentityReset();
  }

  setAuth({ access_token: accessToken });
  setUser(userData);
  updateConfig({ authMethod: "oauth", patExpiresAt: null });
  safeRemoveStorage(PAT_EXPIRY_DISMISSED_KEY);
  navigator.storage?.persist?.()?.catch(() => {});
  return true;
}

let _crossTabFetchGen = 0;

/**
 * Cross-tab identity-switch reload seam, extracted as a mutable object method
 * (not a bare exported function) purely for testability: the storage listener
 * below always calls through `crossTabReload.reloadForIdentitySwitch()`, so
 * `vi.spyOn(crossTabReload, "reloadForIdentitySwitch")` from a test intercepts
 * it — a plain exported function wouldn't be, since the listener's internal
 * call captures a direct reference to it rather than reading it back off the
 * module's exports object. This also sidesteps happy-dom's
 * `window.location.reload` not being reliably spyable directly.
 */
export const crossTabReload = {
  reloadForIdentitySwitch(): void {
    window.location.reload();
  },
};

// Cross-tab auth sync: if another tab clears the token, this tab should also clear.
// Uses expireToken() (not clearAuth()) to avoid wiping config/view that may still be valid.
// Also syncs Jira auth across tabs — critical for rotating refresh tokens: a stale tab
// holding an already-invalidated token would fail on its next Jira request.
function handleAuthStorage(e: StorageEvent): void {
  if (e.key === AUTH_STORAGE_KEY && e.newValue === null && _token()) {
    // Re-check: a rapid sign-out/sign-in may have already replaced the token
    if (localStorage.getItem(AUTH_STORAGE_KEY) !== null) return;
    expireToken();
    window.location.replace("/login");
  } else if (e.key === AUTH_STORAGE_KEY && e.newValue !== null && e.newValue !== _token()) {
    // Captured BEFORE the token/user update below, so the /user fetch result
    // can be compared against who THIS tab thought was signed in.
    const previousLogin = user()?.login;
    setTokenInternal(e.newValue, true);
    const gen = ++_crossTabFetchGen;
    const newToken = e.newValue;
    void (async () => {
      try {
        const r = await makeUserCheckFetcher(newToken)();
        if (!r.ok) {
          void r.body?.cancel();
          return;
        }
        const data = parseGitHubUserPayload(await r.json());
        if (data && _token() === newToken && _crossTabFetchGen === gen) {
          // Only a CONFIRMED same-user rotation (a known previous login that
          // case-insensitively matches the fetched identity) skips the
          // reload. previousLogin is undefined whenever this tab's user()
          // was already null — notably after expireToken(), which clears
          // user() but deliberately PRESERVES config/view so the same user
          // can silently re-auth. In that state we can't assume continuity:
          // this tab may still be holding a prior identity's config/view in
          // memory/localStorage even though user() reads null, so treating
          // an unconfirmed prior identity as "safe" would let a genuinely
          // different identity render using that stale data (a
          // cross-identity bleed). When in doubt, reload.
          const isSameUserRotation =
            previousLogin !== undefined && previousLogin.toLowerCase() === data.login.toLowerCase();
          if (isSameUserRotation) {
            // Same-identity token rotation — adopt the refreshed user data
            // in place, same as before. Must NOT reset config/view here.
            setUser(data);
          } else {
            // A different GitHub identity signed in via another tab (e.g.
            // Settings > Replace token in that tab), OR this tab has no
            // confirmable prior identity — the active tab has already
            // reset config/view, cleared the shared IndexedDB cache, and
            // written the new identity's token/config/view to localStorage.
            // This (passive) tab has NOT run any of that, so simply calling
            // setUser() here could leave it authenticated as the new identity
            // while still rendering a previous identity's config/view/cached
            // data. Reload instead so it re-initializes cleanly from what the
            // active tab already persisted.
            _identityEpoch++;
            // Drop any snapshot write still pending for the previous identity
            // so the reload's visibilitychange flush cannot persist it.
            void clearSnapshotLogged();
            crossTabReload.reloadForIdentitySwitch();
          }
        }
      } catch {
        // Ignore network errors during passive cross-tab user check
      }
    })();
  }
  if (e.key === JIRA_AUTH_STORAGE_KEY) {
    try {
      const raw = e.newValue;
      if (!raw) {
        _setJiraAuth(null);
        return;
      }
      const parsed = JiraAuthStateSchema.safeParse(JSON.parse(raw) as unknown);
      _setJiraAuth(parsed.success ? parsed.data : null);
    } catch {
      _setJiraAuth(null);
    }
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", handleAuthStorage);
}
