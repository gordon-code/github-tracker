export interface Env {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  ALLOWED_ORIGIN: string;
  SENTRY_HOST: string;    // e.g. "o123456.ingest.sentry.io"
  SENTRY_PROJECT_ID: string; // e.g. "7890123"
}

// Predefined error strings only (SDR-006)
type ErrorCode =
  | "token_exchange_failed"
  | "invalid_request"
  | "method_not_allowed"
  | "not_found";

// Structured logging — Cloudflare auto-indexes JSON fields for querying.
// NEVER log secrets: codes, tokens, client_secret, cookie values.
function log(
  level: "info" | "warn" | "error",
  event: string,
  data: Record<string, unknown>,
  request?: Request
): void {
  const entry: Record<string, unknown> = {
    worker: "github-tracker",
    event,
    ...data,
  };
  if (request) {
    const cf = (request as unknown as { cf?: Record<string, unknown> }).cf;
    entry.origin = request.headers.get("Origin");
    entry.user_agent = request.headers.get("User-Agent");
    entry.cf_country = cf?.country;
    entry.cf_colo = cf?.colo;
    entry.cf_city = cf?.city;
  }
  console[level](JSON.stringify(entry));
}

function errorResponse(
  code: ErrorCode,
  status: number,
  corsHeaders: Record<string, string>
): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
      ...securityHeaders(),
    },
  });
}

function securityHeaders(): Record<string, string> {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
  };
}

// CORS: strict equality only (SDR-004)
function getCorsHeaders(
  requestOrigin: string | null,
  allowedOrigin: string
): Record<string, string> {
  if (requestOrigin === allowedOrigin) {
    return {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Methods": "POST",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };
  }
  return {};
}

// ── Sentry tunnel ─────────────────────────────────────────────────────────
// Proxies Sentry event envelopes through our own domain so the browser
// treats them as same-origin (no CSP change, no ad-blocker interference).
// The DSN is validated against env.SENTRY_HOST + env.SENTRY_PROJECT_ID to
// prevent abuse as an open proxy.
const SENTRY_ENVELOPE_MAX_BYTES = 256 * 1024; // 256 KB — Sentry rejects >200KB compressed

async function handleSentryTunnel(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: securityHeaders() });
  }

  if (!env.SENTRY_HOST || !env.SENTRY_PROJECT_ID) {
    log("warn", "sentry_tunnel_not_configured", {}, request);
    return new Response(null, { status: 404, headers: securityHeaders() });
  }

  const contentLength = parseInt(request.headers.get("Content-Length") ?? "0", 10);
  if (contentLength > SENTRY_ENVELOPE_MAX_BYTES) {
    log("warn", "sentry_tunnel_payload_too_large", { content_length: contentLength }, request);
    return new Response(null, { status: 413, headers: securityHeaders() });
  }

  let body: string;
  try {
    body = await request.text();
  } catch {
    return new Response(null, { status: 400, headers: securityHeaders() });
  }

  // Sentry envelope format: first line is JSON header with dsn field
  const firstNewline = body.indexOf("\n");
  if (firstNewline === -1) {
    log("warn", "sentry_tunnel_invalid_envelope", {}, request);
    return new Response(null, { status: 400, headers: securityHeaders() });
  }

  let envelopeHeader: { dsn?: string };
  try {
    envelopeHeader = JSON.parse(body.substring(0, firstNewline));
  } catch {
    log("warn", "sentry_tunnel_header_parse_failed", {}, request);
    return new Response(null, { status: 400, headers: securityHeaders() });
  }

  if (typeof envelopeHeader.dsn !== "string") {
    // client_report envelopes may omit dsn — forward if host is configured
    log("info", "sentry_tunnel_no_dsn", {}, request);
    return new Response(null, { status: 200, headers: securityHeaders() });
  }

  // Validate DSN matches our project — prevents open proxy abuse
  let dsnUrl: URL;
  try {
    dsnUrl = new URL(envelopeHeader.dsn);
  } catch {
    log("warn", "sentry_tunnel_invalid_dsn", {}, request);
    return new Response(null, { status: 400, headers: securityHeaders() });
  }

  const dsnProjectId = dsnUrl.pathname.replace(/\//g, "");
  if (dsnUrl.hostname !== env.SENTRY_HOST || dsnProjectId !== env.SENTRY_PROJECT_ID) {
    log("warn", "sentry_tunnel_dsn_mismatch", {
      dsn_host: dsnUrl.hostname,
      dsn_project: dsnProjectId,
    }, request);
    return new Response(null, { status: 403, headers: securityHeaders() });
  }

  // Forward to Sentry ingest endpoint
  const sentryUrl = `https://${env.SENTRY_HOST}/api/${env.SENTRY_PROJECT_ID}/envelope/`;
  try {
    const sentryResp = await fetch(sentryUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-sentry-envelope" },
      body,
    });

    log("info", "sentry_tunnel_forwarded", {
      sentry_status: sentryResp.status,
    }, request);

    return new Response(null, {
      status: sentryResp.status,
      headers: securityHeaders(),
    });
  } catch (err) {
    log("error", "sentry_tunnel_fetch_failed", {
      error: err instanceof Error ? err.message : "unknown",
    }, request);
    return new Response(null, { status: 502, headers: securityHeaders() });
  }
}

// GitHub OAuth code format validation (SDR-005): alphanumeric, 1-40 chars.
// GitHub's code format is undocumented and has changed historically — validate
// loosely here; GitHub's server validates the actual code.
const VALID_CODE_RE = /^[a-zA-Z0-9_-]{1,40}$/;

async function handleTokenExchange(
  request: Request,
  env: Env,
  cors: Record<string, string>
): Promise<Response> {
  log("info", "token_exchange_started", { method: request.method }, request);

  if (request.method !== "POST") {
    log("warn", "token_exchange_wrong_method", { method: request.method }, request);
    return errorResponse("method_not_allowed", 405, cors);
  }

  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.includes("application/json")) {
    log("warn", "token_exchange_bad_content_type", { content_type: contentType }, request);
    return errorResponse("invalid_request", 400, cors);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch (err) {
    log("warn", "token_exchange_json_parse_failed", {
      error: err instanceof Error ? err.message : "unknown",
    }, request);
    return errorResponse("invalid_request", 400, cors);
  }

  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as Record<string, unknown>)["code"] !== "string"
  ) {
    log("warn", "token_exchange_missing_code", {
      body_type: typeof body,
      body_is_null: body === null,
      has_code: body !== null && typeof body === "object" && "code" in body,
      code_type: body !== null && typeof body === "object"
        ? typeof (body as Record<string, unknown>)["code"]
        : "n/a",
    }, request);
    return errorResponse("invalid_request", 400, cors);
  }

  const code = (body as Record<string, unknown>)["code"] as string;

  // Strict code format validation before touching GitHub (SDR-005)
  if (!VALID_CODE_RE.test(code)) {
    log("warn", "token_exchange_invalid_code_format", {
      code_length: code.length,
      code_has_spaces: code.includes(" "),
      code_has_newlines: code.includes("\n"),
    }, request);
    return errorResponse("invalid_request", 400, cors);
  }

  log("info", "github_oauth_request_sent", {}, request);

  let githubData: Record<string, unknown>;
  let githubStatus: number;
  try {
    const githubResp = await fetch(
      "https://github.com/login/oauth/access_token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          code,
        }),
      }
    );
    githubStatus = githubResp.status;
    githubData = (await githubResp.json()) as Record<string, unknown>;
  } catch (err) {
    log("error", "github_oauth_fetch_failed", {
      error: err instanceof Error ? err.message : "unknown",
      error_name: err instanceof Error ? err.name : "unknown",
    }, request);
    return errorResponse("token_exchange_failed", 400, cors);
  }

  // GitHub returns 200 even on error — check for error field (SDR-006)
  if (
    typeof githubData["error"] === "string" ||
    typeof githubData["access_token"] !== "string"
  ) {
    log("error", "github_oauth_error_response", {
      github_status: githubStatus,
      github_error: githubData["error"],
      github_error_description: githubData["error_description"],
      github_error_uri: githubData["error_uri"],
      has_access_token: "access_token" in githubData,
    }, request);
    return errorResponse("token_exchange_failed", 400, cors);
  }

  log("info", "token_exchange_succeeded", {
    github_status: githubStatus,
    scope: githubData["scope"],
    token_type: githubData["token_type"],
  }, request);

  // Return only allowed fields — never forward full GitHub response.
  const allowed = {
    access_token: githubData["access_token"],
    token_type: githubData["token_type"] ?? "bearer",
    scope: githubData["scope"] ?? "",
  };

  return new Response(JSON.stringify(allowed), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ...cors,
      ...securityHeaders(),
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const cors = getCorsHeaders(origin, env.ALLOWED_ORIGIN);
    const corsMatched = Object.keys(cors).length > 0;

    // Log all API requests (skip static asset requests to reduce noise)
    if (url.pathname.startsWith("/api/")) {
      log("info", "api_request", {
        method: request.method,
        pathname: url.pathname,
        cors_matched: corsMatched,
        allowed_origin: env.ALLOWED_ORIGIN,
      }, request);

      if (!corsMatched && origin !== null) {
        log("warn", "cors_origin_mismatch", {
          request_origin: origin,
          allowed_origin: env.ALLOWED_ORIGIN,
        }, request);
      }
    }

    // CORS preflight for the token exchange endpoint only
    if (request.method === "OPTIONS" && url.pathname === "/api/oauth/token") {
      log("info", "cors_preflight", { cors_matched: corsMatched }, request);
      return new Response(null, {
        status: 204,
        headers: { ...cors, "Access-Control-Max-Age": "86400", ...securityHeaders() },
      });
    }

    // Sentry tunnel — same-origin proxy, no CORS needed (browser sends as first-party)
    if (url.pathname === "/api/error-reporting") {
      return handleSentryTunnel(request, env);
    }

    if (url.pathname === "/api/oauth/token") {
      return handleTokenExchange(request, env, cors);
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      return new Response("OK", {
        headers: securityHeaders(),
      });
    }

    if (url.pathname.startsWith("/api/")) {
      log("warn", "api_not_found", {
        method: request.method,
        pathname: url.pathname,
      }, request);
      return errorResponse("not_found", 404, cors);
    }

    // Forward non-API requests to static assets
    return env.ASSETS.fetch(request);
  },
};
