import { captureException } from "../lib/sentry-facade";
import { pushNotification } from "../lib/errors";
import { AUTH_OUTAGE_NOTIFICATION_SOURCE } from "../../shared/types";
import type { GitHubUser, UnauthorizedContext, UnauthorizedOutcome } from "./auth";

const UNAUTHORIZED_RETRY_DELAYS_MS = [1_000, 2_000] as const;
const OUTAGE_401_SUSPEND_CAP_MS = 30 * 60_000;
const GITHUB_REQUEST_ID_RE = /^[A-Za-z0-9:_-]{1,64}$/;

export interface Auth401Deps {
  isCurrentSession: () => boolean;
  fetchUserCheck: () => Promise<Response>;
  parseGitHubUserPayload: (raw: unknown) => GitHubUser | null;
  clearAuthOutageSuspension: () => void;
  getOutageSuspendStartedAt: () => number | null;
  setOutageSuspendStartedAt: (ts: number) => void;
  getAuthMethod: () => string;
  expireToken: () => void;
  redirectToLogin: () => void;
}

function delayWithAbort(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
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
      console.warn("[auth] 401 verification inconclusive (status/network)");
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
          console.warn("[auth] 401 verification inconclusive (status/network)");
          return { outcome: "preserved" };
        }
        if (!deps.isCurrentSession()) return { outcome: "ignored" };
        const userData = deps.parseGitHubUserPayload(raw);
        if (userData === null) {
          return { outcome: "preserved" };
        }
        deps.clearAuthOutageSuspension();
        console.warn(`[auth] transient 401 recovered during verification (attempt ${attemptNum}/3)`);
        return { outcome: "preserved", userData };
      }
      void retryResp.body?.cancel();
      deps.clearAuthOutageSuspension();
      console.warn(`[auth] transient 401 recovered during verification (attempt ${attemptNum}/3)`);
      return { outcome: "preserved" };
    }

    if (retryResp.status !== 401) {
      console.warn("[auth] 401 verification inconclusive (status/network)");
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

  if (!deps.isCurrentSession()) return { outcome: "ignored" };

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
    await new Promise((r) => setTimeout(r, delayMs));

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

    if (resp.status !== 401) {
      return null;
    }
  }

  return null;
}
