import * as Sentry from "@sentry/solid";
import type { ErrorEvent, Breadcrumb } from "@sentry/solid";

/** Strip OAuth credentials and tokens from any captured URL or query string. */
export function scrubUrl(url: string): string {
  return url
    .replace(/code=[^&\s"]+/g, "code=[REDACTED]")
    .replace(/state=[^&\s"]+/g, "state=[REDACTED]")
    .replace(/access_token=[^&\s"]+/g, "access_token=[REDACTED]")
    .replace(/client_secret=[^&\s"]+/gi, "client_secret=[REDACTED]")
    .replace(/\b(ghu_|ghp_|gho_|github_pat_)[A-Za-z0-9_]+/g, "$1[REDACTED]");
}

/** Allowed console breadcrumb prefixes — drop everything else. */
const ALLOWED_CONSOLE_PREFIXES = [
  "[app]",
  "[auth]",
  "[api]",
  "[poll]",
  "[dashboard]",
  "[settings]",
  "[hot-poll]",
  "[cache]",
  "[github]",
  "[mcp-relay]",
  "[notifications]",
];

export function beforeSendHandler(event: ErrorEvent): ErrorEvent | null {
  // Strip OAuth params from captured URLs
  if (event.request?.url) {
    event.request.url = scrubUrl(event.request.url);
  }
  if (event.request?.query_string) {
    event.request.query_string =
      typeof event.request.query_string === "string"
        ? scrubUrl(event.request.query_string)
        : "[REDACTED]";
  }
  // Remove headers, cookies, and request body entirely
  delete event.request?.headers;
  delete event.request?.cookies;
  delete event.request?.data;
  // Remove user identity — we never want to track users
  delete event.user;
  // Scrub URLs in stack trace frames and exception messages
  if (event.exception?.values) {
    for (const ex of event.exception.values) {
      if (ex.stacktrace?.frames) {
        for (const frame of ex.stacktrace.frames) {
          if (frame.abs_path) {
            frame.abs_path = scrubUrl(frame.abs_path);
          }
        }
      }
      // Scrub exception message strings — defense-in-depth for token leakage
      if (ex.value) {
        ex.value = scrubUrl(ex.value);
      }
    }
  }
  return event;
}

export function beforeBreadcrumbHandler(
  breadcrumb: Breadcrumb,
): Breadcrumb | null {
  // Scrub URLs in navigation breadcrumbs
  if (breadcrumb.category === "navigation") {
    if (breadcrumb.data?.from)
      breadcrumb.data.from = scrubUrl(breadcrumb.data.from as string);
    if (breadcrumb.data?.to)
      breadcrumb.data.to = scrubUrl(breadcrumb.data.to as string);
  }
  // Scrub URLs in fetch/xhr breadcrumbs
  if (
    breadcrumb.category === "fetch" ||
    breadcrumb.category === "xhr"
  ) {
    if (breadcrumb.data?.url)
      breadcrumb.data.url = scrubUrl(breadcrumb.data.url as string);
  }
  // Only keep our own tagged console logs — drop third-party noise
  if (breadcrumb.category === "console") {
    const msg = breadcrumb.message ?? "";
    if (!ALLOWED_CONSOLE_PREFIXES.some((p) => msg.startsWith(p))) {
      return null;
    }
  }
  return breadcrumb;
}

export function initSentry(): void {
  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
  if (import.meta.env.DEV || !dsn) return;

  Sentry.init({
    dsn,
    tunnel: "/api/error-reporting",
    environment: import.meta.env.MODE,

    // ── Privacy: absolute minimum data ──────────────────────────
    sendDefaultPii: false,

    // ── Disable performance tracing (tracesSampleRate omitted = undefined = no spans) ───
    profilesSampleRate: 0,

    // ── Only capture errors from our own code ───────────────────
    allowUrls: [new RegExp(`^${window.location.origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[/\\?#])`)],

    // ── Scrub sensitive data before it leaves the browser ────────
    beforeSend: beforeSendHandler,
    beforeBreadcrumb: beforeBreadcrumbHandler,
  });
}
