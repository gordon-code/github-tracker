import * as Sentry from "@sentry/solid";
import { beforeBreadcrumbHandler, beforeSendHandler } from "./sentry";

export function initSdk(): typeof Sentry {
  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
  if (import.meta.env.DEV || !dsn) return Sentry;

  Sentry.init({
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

  return Sentry;
}

export const initSentry = initSdk;
