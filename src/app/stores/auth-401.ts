import { captureException } from "../lib/sentry-facade";
import { pushNotification } from "../lib/errors";
import { discardResponseBody } from "../lib/http-errors";
import { AUTH_OUTAGE_NOTIFICATION_SOURCE } from "../../shared/types";
import type { Config } from "../../shared/schemas";
import { config, updateConfig } from "./config";
import {
  authInternals,
  authNavigation,
  clearAuthOutageSuspension,
  clearIdentityData,
  expireToken,
  setAuth,
  type GitHubUser,
  type UnauthorizedContext,
  type UnauthorizedOutcome,
} from "./auth";

const UNAUTHORIZED_RETRY_DELAYS_MS = [1_000, 2_000] as const;
const UNAUTHORIZED_PRESERVED_COOLDOWN_MS = 15_000;
const TOTAL_VERIFICATION_ATTEMPTS = UNAUTHORIZED_RETRY_DELAYS_MS.length + 1;
const OUTAGE_401_SUSPEND_CAP_MS = 30 * 60_000;
const GITHUB_REQUEST_ID_RE = /^[A-Za-z0-9:_-]{1,64}$/;
const INCONCLUSIVE_401_LOG = "[auth] 401 verification inconclusive (status/network)";

export interface Auth401Deps {
  isCurrentSession: () => boolean;
  fetchUserCheck: () => Promise<Response>;
  parseGitHubUserPayload: (raw: unknown) => GitHubUser | null;
  clearAuthOutageSuspension: () => void;
  getOutageSuspendStartedAt: () => number | null;
  setOutageSuspendStartedAt: (ts: number) => void;
  getAuthMethod: () => Config["authMethod"];
  expireToken: () => void;
  redirectToLogin: () => void;
}

function delayWithAbort(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function logTransientRecovery(attemptNum: number): void {
  console.warn(
    `[auth] transient 401 recovered during verification (attempt ${attemptNum}/${TOTAL_VERIFICATION_ATTEMPTS})`
  );
}

function maybeNotifyOutageSuspension(deps: Auth401Deps): boolean {
  let startedAt = deps.getOutageSuspendStartedAt();
  if (startedAt === null) {
    startedAt = Date.now();
    deps.setOutageSuspendStartedAt(startedAt);
  }
  if (Date.now() - startedAt < OUTAGE_401_SUSPEND_CAP_MS) {
    pushNotification(
      AUTH_OUTAGE_NOTIFICATION_SOURCE,
      "GitHub API outage detected — session verification paused. If your token was revoked, sign in again.",
      "warning",
      false,
      { label: "Sign in again", href: "/login" }
    );
    return true;
  }
  return false;
}

export async function handle401SlowPath(
  mode: "runtime" | "validate",
  signal: AbortSignal,
  deps: Auth401Deps,
  ctx?: UnauthorizedContext
): Promise<{ outcome: UnauthorizedOutcome; userData?: GitHubUser }> {
  if (!deps.isCurrentSession()) return { outcome: "ignored" };

  // Slow-path-only dynamic import after a 401 has occurred (never on normal 200 boot)
  const statusMod = await import("../services/github-status").catch(() => null);
  if (!deps.isCurrentSession()) return { outcome: "ignored" };

  if (mode === "runtime" && statusMod?.isGitHubApiOutage()) {
    if (maybeNotifyOutageSuspension(deps)) {
      return { outcome: "preserved" };
    }
  }

  for (let i = 0; i < UNAUTHORIZED_RETRY_DELAYS_MS.length; i++) {
    const attemptNum = i + 2;
    // oxlint-disable-next-line eslint/no-await-in-loop
    const proceeded = await delayWithAbort(UNAUTHORIZED_RETRY_DELAYS_MS[i], signal);
    if (!proceeded || !deps.isCurrentSession()) return { outcome: "ignored" };

    let retryResp: Response;
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop
      retryResp = await deps.fetchUserCheck();
    } catch {
      if (!deps.isCurrentSession()) return { outcome: "ignored" };
      console.warn(INCONCLUSIVE_401_LOG);
      return { outcome: "preserved" };
    }
    if (!deps.isCurrentSession()) return { outcome: "ignored" };

    if (retryResp.ok) {
      if (mode === "validate") {
        let raw: unknown;
        try {
          // oxlint-disable-next-line eslint/no-await-in-loop
          raw = await retryResp.json();
        } catch {
          if (!deps.isCurrentSession()) return { outcome: "ignored" };
          console.warn(INCONCLUSIVE_401_LOG);
          return { outcome: "preserved" };
        }
        if (!deps.isCurrentSession()) return { outcome: "ignored" };
        const userData = deps.parseGitHubUserPayload(raw);
        if (userData === null) {
          return { outcome: "preserved" };
        }
        deps.clearAuthOutageSuspension();
        logTransientRecovery(attemptNum);
        return { outcome: "preserved", userData };
      }
      discardResponseBody(retryResp);
      deps.clearAuthOutageSuspension();
      logTransientRecovery(attemptNum);
      return { outcome: "preserved" };
    }

    discardResponseBody(retryResp);
    if (retryResp.status !== 401) {
      console.warn(INCONCLUSIVE_401_LOG);
      return { outcome: "preserved" };
    }
  }

  if (statusMod) {
    await statusMod.fetchGitHubStatus();
    if (!deps.isCurrentSession()) return { outcome: "ignored" };
    if (statusMod.isGitHubApiOutage()) {
      if (mode === "validate") {
        return { outcome: "preserved" };
      }
      if (maybeNotifyOutageSuspension(deps)) {
        return { outcome: "preserved" };
      }
    }
  }

  const safeRequestId =
    typeof ctx?.requestId === "string" && GITHUB_REQUEST_ID_RE.test(ctx.requestId)
      ? ctx.requestId
      : undefined;

  const authMethod = deps.getAuthMethod();
  captureException(new Error("Confirmed GitHub 401 — expiring token"), {
    tags: {
      source: mode === "runtime" ? "auth-runtime-401" : "auth-validate-401",
      authMethod,
      endpointKind: ctx?.endpointKind ?? "user",
      apiRequestsStatus: statusMod?.getGitHubStatus()?.apiSeverity ?? "unknown",
      ...(safeRequestId ? { githubRequestId: safeRequestId } : {}),
    },
  });

  console.info(
    authMethod === "pat"
      ? "[auth] PAT invalid or expired — clearing token"
      : "[auth] access token invalid — clearing token"
  );
  deps.clearAuthOutageSuspension();
  deps.expireToken();
  if (mode === "runtime") {
    deps.redirectToLogin();
  }
  return { outcome: "expired" };
}

export async function retryOAuthUserCheck(
  fetchOnce: () => Promise<Response>,
  parseGitHubUserPayload: (raw: unknown) => GitHubUser | null
): Promise<GitHubUser | null> {
  for (const delayMs of UNAUTHORIZED_RETRY_DELAYS_MS) {
    // oxlint-disable-next-line eslint/no-await-in-loop
    await delayWithAbort(delayMs);

    let resp: Response;
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop
      resp = await fetchOnce();
    } catch {
      return null;
    }

    if (resp.ok) {
      try {
        // oxlint-disable-next-line eslint/no-await-in-loop
        const raw: unknown = await resp.json();
        return parseGitHubUserPayload(raw);
      } catch {
        return null;
      }
    }

    discardResponseBody(resp);
    if (resp.status !== 401) {
      return null;
    }
  }

  return null;
}

// ── Runtime / boot entry points (called from `auth.ts` after this chunk loads) ──

let _pendingVerification: {
  token: string;
  epoch: number;
  gen: number;
  promise: Promise<UnauthorizedOutcome>;
} | null = null;
let _preservedCooldown: { token: string; epoch: number; gen: number; until: number } | null = null;

function makeDeps(token: string, epoch: number, signal: AbortSignal): Auth401Deps {
  return {
    isCurrentSession: () => authInternals.isCurrentSession(token, epoch, signal),
    fetchUserCheck: authInternals.makeUserCheckFetcher(token, signal),
    parseGitHubUserPayload: authInternals.parseGitHubUserPayload,
    clearAuthOutageSuspension,
    getOutageSuspendStartedAt: authInternals.getOutageSuspendStartedAt,
    setOutageSuspendStartedAt: authInternals.setOutageSuspendStartedAt,
    getAuthMethod: () => config.authMethod,
    expireToken,
    redirectToLogin: () => authNavigation.redirectToLogin(),
  };
}

/**
 * Coalesced, cooled-down runtime 401 verification. `gen` is `auth.ts`'s verification generation
 * when the 401 was observed; any abort since then (token change, `setAuth`) invalidates the
 * coalesced flight and the preserved-outcome cooldown.
 */
export function verifyRuntimeUnauthorized(
  failingToken: string,
  epoch: number,
  gen: number,
  ctx?: UnauthorizedContext
): Promise<UnauthorizedOutcome> {
  if (authInternals.verificationGen() !== gen) return Promise.resolve("ignored");
  const pending = _pendingVerification;
  if (pending?.token === failingToken && pending.epoch === epoch && pending.gen === gen) {
    return pending.promise;
  }
  const cooldown = _preservedCooldown;
  if (
    cooldown?.token === failingToken &&
    cooldown.epoch === epoch &&
    cooldown.gen === gen &&
    Date.now() < cooldown.until
  ) {
    return Promise.resolve("preserved");
  }

  const controller = new AbortController();
  authInternals.trackController(controller);
  const entry: NonNullable<typeof _pendingVerification> = {
    token: failingToken,
    epoch,
    gen,
    promise: Promise.resolve("ignored"),
  };
  _pendingVerification = entry;
  const run = async (): Promise<UnauthorizedOutcome> => {
    try {
      if (!authInternals.isCurrentSession(failingToken, epoch, controller.signal)) return "ignored";
      const { outcome } = await handle401SlowPath(
        "runtime",
        controller.signal,
        makeDeps(failingToken, epoch, controller.signal),
        ctx
      );
      if (
        outcome === "preserved" &&
        authInternals.isCurrentSession(failingToken, epoch, controller.signal)
      ) {
        _preservedCooldown = {
          token: failingToken,
          epoch,
          gen,
          until: Date.now() + UNAUTHORIZED_PRESERVED_COOLDOWN_MS,
        };
      }
      return outcome;
    } finally {
      authInternals.untrackController(controller);
      if (_pendingVerification === entry) _pendingVerification = null;
    }
  };
  entry.promise = run();
  return entry.promise;
}

/** Boot-time 3x confirmation after `validateToken`'s first `GET /user` returned 401. */
export async function verifyBootUnauthorized(
  token: string,
  epoch: number,
  signal: AbortSignal
): Promise<GitHubUser | undefined> {
  const { userData } = await handle401SlowPath("validate", signal, makeDeps(token, epoch, signal));
  return userData;
}

async function fetchUserForNewToken(accessToken: string): Promise<GitHubUser | null> {
  const fetchOnce = authInternals.makeUserCheckFetcher(accessToken);
  let resp: Response;
  try {
    resp = await fetchOnce();
  } catch {
    return null;
  }
  if (resp.ok) {
    try {
      const raw: unknown = await resp.json();
      return authInternals.parseGitHubUserPayload(raw);
    } catch {
      return null;
    }
  }
  discardResponseBody(resp);
  if (resp.status !== 401) return null;
  return retryOAuthUserCheck(fetchOnce, authInternals.parseGitHubUserPayload);
}

/** Validates a newly exchanged OAuth token, then isolates identity data before persisting it. */
export async function completeOAuthLogin(accessToken: string): Promise<boolean> {
  const userData = await fetchUserForNewToken(accessToken);
  if (!userData) return false;

  const identityClass = authInternals.classifyIncomingIdentity(userData.login);
  if (identityClass === "mismatch") {
    authInternals.resetPerIdentityLocalState();
    await clearIdentityData();
  } else if (identityClass === "unknown_with_jira") {
    authInternals.wipeJiraAuthForIdentityReset();
  }

  setAuth({ access_token: accessToken });
  authInternals.setUser(userData);
  updateConfig({ authMethod: "oauth", patExpiresAt: null });
  authInternals.clearPatExpiryDismissalKey();
  navigator.storage?.persist?.()?.catch(() => {});
  return true;
}
