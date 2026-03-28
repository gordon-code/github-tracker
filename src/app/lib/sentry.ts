import * as Sentry from "@sentry/solid";

/** Strip OAuth credentials from any captured URL. */
function scrubUrl(url: string): string {
  return url
    .replace(/code=[^&\s]+/g, "code=[REDACTED]")
    .replace(/state=[^&\s]+/g, "state=[REDACTED]")
    .replace(/access_token=[^&\s]+/g, "access_token=[REDACTED]");
}

/** Allowed console breadcrumb prefixes — drop everything else. */
const ALLOWED_CONSOLE_PREFIXES = [
  "[auth]",
  "[api]",
  "[poll]",
  "[dashboard]",
  "[settings]",
];

// DSN is a public project identifier, not a secret.
// Set this after creating a Sentry project.
const SENTRY_DSN = "https://4dc4335a9746201c02ff2107c0d20f73@o284235.ingest.us.sentry.io/4511122822922240";

export function initSentry(): void {
  if (import.meta.env.DEV || !SENTRY_DSN) return;

  Sentry.init({
    dsn: SENTRY_DSN,
    tunnel: "/api/error-reporting",
    environment: import.meta.env.MODE,

    // ── Privacy: absolute minimum data ──────────────────────────
    sendDefaultPii: false,

    // ── Disable everything except error tracking ────────────────
    tracesSampleRate: 0,
    profilesSampleRate: 0,
    // No replay integration — DOM capture is unnecessary for auth
    // debugging and carries high privacy cost.

    // ── Only capture errors from our own code ───────────────────
    allowUrls: [/^https:\/\/gh\.gordoncode\.dev/],

    // ── Scrub sensitive data before it leaves the browser ────────
    beforeSend(event) {
      // Strip OAuth params from captured URLs
      if (event.request?.url) {
        event.request.url = scrubUrl(event.request.url);
      }
      if (event.request?.query_string) {
        event.request.query_string = "[REDACTED]";
      }
      // Remove headers and cookies entirely
      delete event.request?.headers;
      delete event.request?.cookies;
      // Remove user identity — we never want to track users
      delete event.user;
      // Scrub URLs in stack trace frames
      if (event.exception?.values) {
        for (const ex of event.exception.values) {
          if (ex.stacktrace?.frames) {
            for (const frame of ex.stacktrace.frames) {
              if (frame.abs_path) {
                frame.abs_path = scrubUrl(frame.abs_path);
              }
            }
          }
        }
      }
      return event;
    },

    beforeBreadcrumb(breadcrumb) {
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
    },
  });
}
