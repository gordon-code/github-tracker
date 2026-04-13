import { requestDataIntegration, type CloudflareOptions } from "@sentry/cloudflare";

// Minimal event interface — avoids transitive SDK type imports in test files.
// query_string is string | unknown[] in the Sentry SDK (QueryParams type).
interface WorkerSentryEvent {
  request?: {
    url?: string;
    query_string?: string | unknown;
    headers?: unknown;
    cookies?: unknown;
    data?: unknown;
  };
  user?: unknown;
  exception?: {
    values?: Array<{
      value?: string;
      stacktrace?: {
        frames?: Array<{ abs_path?: string }>;
      };
    }>;
  };
}

interface SentryEnv {
  SENTRY_DSN?: string;
}

/** Strip OAuth credentials and client_secret from any captured URL or string. */
function scrubSensitive(s: string): string {
  return s
    .replace(/code=[^&\s"]+/g, "code=[REDACTED]")
    .replace(/state=[^&\s"]+/g, "state=[REDACTED]")
    .replace(/access_token=[^&\s"]+/g, "access_token=[REDACTED]")
    .replace(/client_secret=[^&\s"]+/g, "client_secret=[REDACTED]")
    .replace(/"client_secret":"[^"]+"/g, '"client_secret":"[REDACTED]"')
    .replace(/\b(ghu_|ghp_|gho_|github_pat_)[A-Za-z0-9_]+/g, "$1[REDACTED]");
}

export function workerBeforeSendHandler(
  event: WorkerSentryEvent
): WorkerSentryEvent | null {
  // Strip OAuth params and secrets from captured URLs
  if (event.request?.url) {
    event.request.url = scrubSensitive(event.request.url);
  }
  if (event.request?.query_string) {
    event.request.query_string =
      typeof event.request.query_string === "string"
        ? scrubSensitive(event.request.query_string)
        : "[REDACTED]";
  }

  // Delete headers, cookies, and request body entirely — may contain
  // Authorization, Cookie, CF-Connecting-IP, and sealed API tokens
  delete event.request?.headers;
  delete event.request?.cookies;
  delete event.request?.data;

  // Remove user identity
  delete event.user;

  // Scrub stack trace frame abs_path values
  if (event.exception?.values) {
    for (const ex of event.exception.values) {
      if (ex.stacktrace?.frames) {
        for (const frame of ex.stacktrace.frames) {
          if (frame.abs_path) {
            frame.abs_path = scrubSensitive(frame.abs_path);
          }
        }
      }
      // Scrub exception message strings — defense-in-depth for token leakage
      if (ex.value) {
        ex.value = scrubSensitive(ex.value);
      }
    }
  }

  return event;
}

export function getWorkerSentryOptions(env: SentryEnv): CloudflareOptions {
  return {
    dsn: env.SENTRY_DSN,
    environment: "production",
    sendDefaultPii: false,
    // tracesSampleRate omitted (undefined) — hasSpansEnabled() returns false, no span overhead
    // Cast: workerBeforeSendHandler uses a minimal local interface for testability
    // but is fully compatible with ErrorEvent at runtime.
    beforeSend: workerBeforeSendHandler as CloudflareOptions["beforeSend"],
    // Disable all default integrations (which include consoleIntegration capturing
    // structured JSON logs as breadcrumbs) and add only what we need explicitly.
    defaultIntegrations: false,
    integrations: [
      requestDataIntegration({
        include: { headers: false, cookies: false, data: false },
      }),
    ],
  };
}
