import { captureException, init } from "@sentry/solid";
import { beforeBreadcrumbHandler, beforeSendHandler } from "./sentry";

export interface SentrySdkClient {
  captureException: typeof captureException;
}

export function initSdk(): SentrySdkClient {
  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
  if (import.meta.env.DEV || !dsn) return { captureException };

  init({
    dsn,
    tunnel: "/api/error-reporting",
    environment: import.meta.env.MODE,
    enhanceFetchErrorMessages: "report-only",

    // ── Privacy: absolute minimum data ──────────────────────────
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
    },

    // ── Disable performance tracing (tracesSampleRate omitted = undefined = no spans) ───
    profileSessionSampleRate: 0,

    // ── Only capture errors from our own code ───────────────────
    allowUrls: [
      new RegExp(
        `^${window.location.origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[/\\?#])`,
      ),
    ],

    // ── Scrub sensitive data before it leaves the browser ────────
    beforeSend: beforeSendHandler,
    beforeBreadcrumb: beforeBreadcrumbHandler,
  });

  return { captureException };
}
