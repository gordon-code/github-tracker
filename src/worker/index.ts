import { CryptoEnv, deriveKey, sealToken, SEAL_SALT } from "./crypto";
import { SessionEnv, ensureSession } from "./session";
import { TurnstileEnv, verifyTurnstile, extractTurnstileToken } from "./turnstile";
import { validateProxyRequest, validateOrigin } from "./validation";

interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env extends CryptoEnv, SessionEnv, TurnstileEnv {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  ALLOWED_ORIGIN: string;
  SENTRY_DSN?: string; // e.g. "https://key@o123456.ingest.sentry.io/7890123"
  SENTRY_SECURITY_TOKEN?: string; // Optional: Sentry security token for Allowed Domains validation
  PROXY_RATE_LIMITER: RateLimiter; // Workers Rate Limiting Binding
}

// Predefined error strings only (SDR-006)
type ErrorCode =
  | "token_exchange_failed"
  | "invalid_request"
  | "method_not_allowed"
  | "not_found"
  | "origin_mismatch"
  | "cross_site_request"
  | "missing_csrf_header"
  | "invalid_content_type"
  | "turnstile_failed"
  | "rate_limited"
  | "seal_failed";

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
  corsHeaders: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
      ...SECURITY_HEADERS,
    },
  });
}

const SECURITY_HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
};

// Simple in-memory rate limiter factory.
// Not durable across isolate restarts, but catches burst abuse.
// Note: CF-Connecting-IP is set by Cloudflare's proxy layer; if the workers.dev
// route is enabled, an attacker could spoof this header. Disable the workers.dev
// route in the Cloudflare dashboard for production use.
const PRUNE_THRESHOLD = 100;

function createIpRateLimiter(limit: number, windowMs: number): { check(ip: string): boolean } {
  const map = new Map<string, { count: number; resetAt: number }>();
  return {
    check(ip: string): boolean {
      const now = Date.now();
      const entry = map.get(ip);
      if (!entry || now >= entry.resetAt) {
        map.set(ip, { count: 1, resetAt: now + windowMs });
        return true;
      }
      entry.count++;
      if (entry.count > limit) return false;
      // Periodic cleanup to prevent unbounded map growth.
      if (map.size >= PRUNE_THRESHOLD) {
        for (const [k, e] of map) {
          if (now >= e.resetAt) map.delete(k);
        }
      }
      return true;
    },
  };
}

const tokenRateLimiter = createIpRateLimiter(10, 60_000);    // token exchange: 10/min
const sentryRateLimiter = createIpRateLimiter(15, 60_000);   // sentry tunnel: 15/min
const cspRateLimiter = createIpRateLimiter(15, 60_000);      // csp report: 15/min
const proxyPreGateLimiter = createIpRateLimiter(60, 60_000); // proxy pre-gate: complements CF binding

// Content-Length pre-check helper — optimization only, not a security boundary.
// Absent or unparseable Content-Length passes through (post-read check is authoritative).
function checkContentLength(request: Request, maxBytes: number): boolean {
  const cl = request.headers.get("Content-Length");
  if (cl === null) return true;
  const parsed = Number(cl);
  if (!Number.isInteger(parsed) || parsed < 0) return true;
  return parsed <= maxBytes;
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

// ── Proxy CORS headers ─────────────────────────────────────────────────────
// SC-7: Must check requestOrigin === allowedOrigin before reflecting.
// Returns empty object if no match — never reflects untrusted origins.
function getProxyCorsHeaders(
  requestOrigin: string | null,
  allowedOrigin: string
): Record<string, string> {
  if (requestOrigin !== allowedOrigin) return {};
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, GET",
    "Access-Control-Allow-Headers": "Content-Type, X-Requested-With, cf-turnstile-response",
    "Vary": "Origin",
  };
}

// ── Proxy route patterns ─────────────────────────────────────────────────────
function isProxyPath(pathname: string): boolean {
  return (
    pathname.startsWith("/api/proxy/") ||
    pathname.startsWith("/api/jira/")
  );
}

// ── Validation gate for proxy routes ─────────────────────────────────────────
// Returns a Response if rejected, null if validation passes.
// Caller must ensure pathname is a proxy path before calling.
function validateAndGuardProxyRoute(request: Request, env: Env, pathname: string): Response | null {
  const origin = request.headers.get("Origin");

  // Handle OPTIONS preflight for proxy routes explicitly.
  // Legitimate SPA requests are same-origin and don't trigger preflight,
  // so this handler exists only to explicitly reject cross-origin preflights.
  if (request.method === "OPTIONS") {
    const corsHeaders = getProxyCorsHeaders(origin, env.ALLOWED_ORIGIN);
    if (Object.keys(corsHeaders).length === 0) {
      return new Response(null, { status: 403, headers: SECURITY_HEADERS });
    }
    return new Response(null, {
      status: 204,
      headers: { ...corsHeaders, "Access-Control-Max-Age": "86400", ...SECURITY_HEADERS },
    });
  }

  const result = validateProxyRequest(request, env.ALLOWED_ORIGIN);
  if (!result.ok) {
    log("warn", "proxy_validation_failed", { code: result.code, pathname }, request);
    const corsHeaders = getProxyCorsHeaders(origin, env.ALLOWED_ORIGIN);
    return errorResponse(result.code as ErrorCode, result.status, corsHeaders);
  }

  return null;
}

// ── Sealed-token endpoint ────────────────────────────────────────────────────
const VALID_PURPOSES = new Set(["jira-api-token", "jira-refresh-token"]);

// Module-level cache for derived seal keys, keyed by "<raw>:<purpose>".
// SEAL_KEY is a deployment constant — safe to cache per-isolate (follows _sessionKeyCache pattern).
const _sealKeyCache = new Map<string, CryptoKey>();

async function handleProxySeal(request: Request, env: Env, sessionId: string): Promise<Response> {
  if (request.method !== "POST") {
    return errorResponse("method_not_allowed", 405);
  }

  // Session + rate limiting (done by caller, sessionId passed in)
  // Extract Turnstile token and verify
  const turnstileToken = extractTurnstileToken(request);
  if (!turnstileToken) {
    log("warn", "seal_turnstile_missing", {}, request);
    return errorResponse("turnstile_failed", 403);
  }
  if (turnstileToken.length > 2048) {
    log("warn", "seal_turnstile_token_too_long", { token_length: turnstileToken.length }, request);
    return errorResponse("turnstile_failed", 403);
  }

  const ip = request.headers.get("CF-Connecting-IP");
  const turnstileResult = await verifyTurnstile(turnstileToken, ip, env);
  if (!turnstileResult.success) {
    log("warn", "seal_turnstile_failed", { error_codes: turnstileResult.errorCodes }, request);
    return errorResponse("turnstile_failed", 403);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("invalid_request", 400);
  }

  if (typeof body !== "object" || body === null) {
    return errorResponse("invalid_request", 400);
  }

  const token = (body as Record<string, unknown>)["token"];
  const purpose = (body as Record<string, unknown>)["purpose"];

  if (typeof token !== "string") {
    return errorResponse("invalid_request", 400);
  }
  if (token.length > 2048) {
    return errorResponse("invalid_request", 400);
  }
  // SC-8: purpose field required for token audience binding
  if (typeof purpose !== "string" || purpose.length === 0) {
    return errorResponse("invalid_request", 400);
  }
  if (purpose.length > 64 || !VALID_PURPOSES.has(purpose)) {
    return errorResponse("invalid_request", 400);
  }

  let sealed: string;
  try {
    // SC-8: derive key with purpose-scoped info string (cached per-isolate, bounded by VALID_PURPOSES size)
    const cacheKey = env.SEAL_KEY + ":" + purpose;
    let key = _sealKeyCache.get(cacheKey);
    if (key === undefined) {
      key = await deriveKey(env.SEAL_KEY, SEAL_SALT, "aes-gcm-key:" + purpose, "encrypt");
      _sealKeyCache.set(cacheKey, key);
    }
    sealed = await sealToken(token, key);
  } catch (err) {
    // SC-9: log error server-side but DO NOT include crypto error in response
    log("error", "seal_failed", {
      error: err instanceof Error ? err.message : "unknown",
    }, request);
    return errorResponse("seal_failed", 500);
  }

  // SC-11: log seal operations (sessionId for correlation)
  log("info", "token_sealed", {
    sessionId,
    purpose,
    token_length: token.length,
  }, request);

  return new Response(JSON.stringify({ sealed }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ...SECURITY_HEADERS,
    },
  });
}

// ── Sentry tunnel ─────────────────────────────────────────────────────────
// Proxies Sentry event envelopes through our own domain so the browser
// treats them as same-origin (no CSP change, no ad-blocker interference).
// The envelope DSN is validated against env.SENTRY_DSN to prevent open proxy abuse.
const SENTRY_ENVELOPE_MAX_BYTES = 256 * 1024; // 256 KB — Sentry rejects >200KB compressed

interface ParsedDsn { host: string; projectId: string; publicKey: string }

// Module-level cache is safe here: value derived entirely from env.SENTRY_DSN
// (a deployment constant, never user input). Shared across requests in the same
// Worker isolate, which is intentional for performance. Do NOT follow this pattern
// for request-scoped or user-controlled data.
let _dsnCache: { dsn: string; parsed: ParsedDsn | null } | undefined;

/** Parse host, project ID, and public key from a Sentry DSN URL. Returns null if invalid. */
function parseSentryDsn(dsn: string): ParsedDsn | null {
  if (!dsn) return null;
  try {
    const url = new URL(dsn);
    const projectId = url.pathname.split("/").filter(Boolean).pop() ?? "";
    if (!url.hostname || !projectId || !url.username) return null;
    return { host: url.hostname, projectId, publicKey: url.username };
  } catch {
    return null;
  }
}

/** Get cached parsed DSN, re-parsing only when the DSN string changes. */
function getOrCacheDsn(env: Env): ParsedDsn | null {
  const dsn = env.SENTRY_DSN ?? "";
  if (!_dsnCache || _dsnCache.dsn !== dsn) {
    _dsnCache = { dsn, parsed: parseSentryDsn(dsn) };
  }
  return _dsnCache.parsed;
}

async function handleSentryTunnel(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: SECURITY_HEADERS });
  }

  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!sentryRateLimiter.check(ip)) {
    log("warn", "sentry_tunnel_rate_limited", {}, request);
    return new Response(null, { status: 429, headers: { "Retry-After": "60", ...SECURITY_HEADERS } });
  }

  const originResult = validateOrigin(request, env.ALLOWED_ORIGIN);
  if (!originResult.ok) {
    log("warn", "sentry_tunnel_origin_rejected", { origin: request.headers.get("Origin") }, request);
    return new Response(null, { status: 403, headers: SECURITY_HEADERS });
  }

  if (!checkContentLength(request, SENTRY_ENVELOPE_MAX_BYTES)) {
    log("warn", "sentry_tunnel_content_length_exceeded", {
      content_length: request.headers.get("Content-Length"),
    }, request);
    return new Response(null, { status: 413, headers: SECURITY_HEADERS });
  }

  const allowedDsn = getOrCacheDsn(env);
  if (!allowedDsn) {
    log("warn", "sentry_tunnel_not_configured", {}, request);
    return new Response(null, { status: 404, headers: SECURITY_HEADERS });
  }

  let body: string;
  try {
    body = await request.text();
  } catch {
    log("warn", "sentry_tunnel_body_read_failed", {}, request);
    return new Response(null, { status: 400, headers: SECURITY_HEADERS });
  }

  if (body.length > SENTRY_ENVELOPE_MAX_BYTES) {
    log("warn", "sentry_tunnel_payload_too_large", { body_length: body.length }, request);
    return new Response(null, { status: 413, headers: SECURITY_HEADERS });
  }

  // Sentry envelope format: first line is JSON header with dsn field
  const firstNewline = body.indexOf("\n");
  if (firstNewline === -1) {
    log("warn", "sentry_tunnel_invalid_envelope", {}, request);
    return new Response(null, { status: 400, headers: SECURITY_HEADERS });
  }

  let envelopeHeader: { dsn?: string };
  try {
    envelopeHeader = JSON.parse(body.substring(0, firstNewline));
  } catch {
    log("warn", "sentry_tunnel_header_parse_failed", {}, request);
    return new Response(null, { status: 400, headers: SECURITY_HEADERS });
  }

  if (typeof envelopeHeader.dsn !== "string") {
    // client_report envelopes may omit dsn — drop silently
    log("info", "sentry_tunnel_no_dsn", {}, request);
    return new Response(null, { status: 200, headers: SECURITY_HEADERS });
  }

  // Validate envelope DSN matches our project — prevents open proxy abuse
  const envelopeDsn = parseSentryDsn(envelopeHeader.dsn);
  if (!envelopeDsn) {
    log("warn", "sentry_tunnel_invalid_dsn", {}, request);
    return new Response(null, { status: 400, headers: SECURITY_HEADERS });
  }

  if (envelopeDsn.host !== allowedDsn.host || envelopeDsn.projectId !== allowedDsn.projectId) {
    log("warn", "sentry_tunnel_dsn_mismatch", {
      dsn_host: envelopeDsn.host,
      dsn_project: envelopeDsn.projectId,
    }, request);
    return new Response(null, { status: 403, headers: SECURITY_HEADERS });
  }

  // Forward to Sentry ingest endpoint
  const sentryUrl = `https://${allowedDsn.host}/api/${allowedDsn.projectId}/envelope/`;
  try {
    const sentryHeaders: Record<string, string> = {
      "Content-Type": "application/x-sentry-envelope",
    };
    if (env.SENTRY_SECURITY_TOKEN) {
      sentryHeaders["X-Sentry-Token"] = env.SENTRY_SECURITY_TOKEN;
    }
    const sentryResp = await fetch(sentryUrl, {
      method: "POST",
      headers: sentryHeaders,
      body,
      redirect: "error",
    });

    log("info", "sentry_tunnel_forwarded", {
      sentry_status: sentryResp.status,
    }, request);

    return new Response(null, {
      status: sentryResp.status,
      headers: SECURITY_HEADERS,
    });
  } catch (err) {
    log("error", "sentry_tunnel_fetch_failed", {
      error: err instanceof Error ? err.message : "unknown",
    }, request);
    return new Response(null, { status: 502, headers: SECURITY_HEADERS });
  }
}

// ── CSP report tunnel ────────────────────────────────────────────────────
// Receives browser CSP violation reports, scrubs OAuth params from URLs,
// then forwards to Sentry's security ingest endpoint.
const CSP_REPORT_MAX_BYTES = 64 * 1024;
const CSP_OAUTH_PARAMS_RE = /([?&])(code|state|access_token)=[^&\s]*/g;

function scrubReportUrl(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  return url.replace(CSP_OAUTH_PARAMS_RE, "$1$2=[REDACTED]");
}

function scrubCspReportBody(body: Record<string, unknown>): Record<string, unknown> {
  const scrubbed = { ...body };
  // Legacy report-uri format uses kebab-case keys
  for (const key of ["document-uri", "blocked-uri", "source-file", "referrer"]) {
    if (typeof scrubbed[key] === "string") scrubbed[key] = scrubReportUrl(scrubbed[key]);
  }
  // report-to format uses camelCase keys
  for (const key of ["documentURL", "blockedURL", "sourceFile", "referrer"]) {
    if (typeof scrubbed[key] === "string") scrubbed[key] = scrubReportUrl(scrubbed[key]);
  }
  return scrubbed;
}

async function handleCspReport(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: SECURITY_HEADERS });
  }

  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!cspRateLimiter.check(ip)) {
    log("warn", "csp_report_rate_limited", {}, request);
    return new Response(null, { status: 429, headers: { "Retry-After": "60", ...SECURITY_HEADERS } });
  }

  const origin = request.headers.get("Origin");
  if (origin !== null && origin !== env.ALLOWED_ORIGIN) {
    log("warn", "csp_report_origin_rejected", { origin }, request);
    return new Response(null, { status: 403, headers: SECURITY_HEADERS });
  }

  if (!checkContentLength(request, CSP_REPORT_MAX_BYTES)) {
    log("warn", "csp_report_content_length_exceeded", {
      content_length: request.headers.get("Content-Length"),
    }, request);
    return new Response(null, { status: 413, headers: SECURITY_HEADERS });
  }

  const allowedDsn = getOrCacheDsn(env);
  if (!allowedDsn) {
    return new Response(null, { status: 404, headers: SECURITY_HEADERS });
  }

  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch {
    return new Response(null, { status: 400, headers: SECURITY_HEADERS });
  }

  if (bodyText.length > CSP_REPORT_MAX_BYTES) {
    log("warn", "csp_report_too_large", { body_length: bodyText.length }, request);
    return new Response(null, { status: 413, headers: SECURITY_HEADERS });
  }

  const contentType = request.headers.get("Content-Type") ?? "";
  let scrubbedPayloads: Array<Record<string, unknown>> = [];

  try {
    if (contentType.includes("application/reports+json")) {
      // report-to format: array of report objects
      const reports = JSON.parse(bodyText) as Array<{ type?: string; body?: Record<string, unknown> }>;
      for (const report of reports) {
        if (report.type === "csp-violation" && report.body) {
          scrubbedPayloads.push({ "csp-report": scrubCspReportBody(report.body) });
        }
      }
    } else {
      // Legacy report-uri format: { "csp-report": { ... } }
      const parsed = JSON.parse(bodyText) as { "csp-report"?: Record<string, unknown> };
      if (parsed["csp-report"]) {
        scrubbedPayloads.push({ "csp-report": scrubCspReportBody(parsed["csp-report"]) });
      }
    }
  } catch {
    log("warn", "csp_report_parse_failed", {}, request);
    return new Response(null, { status: 400, headers: SECURITY_HEADERS });
  }

  if (scrubbedPayloads.length === 0) {
    return new Response(null, { status: 204, headers: SECURITY_HEADERS });
  }

  // Cap fan-out to prevent amplification from crafted report-to batches
  if (scrubbedPayloads.length > 20) {
    scrubbedPayloads = scrubbedPayloads.slice(0, 20);
  }

  // Sentry security endpoint expects individual csp-report JSON objects
  const sentryUrl = `https://${allowedDsn.host}/api/${allowedDsn.projectId}/security/?sentry_key=${allowedDsn.publicKey}`;

  const results = await Promise.all(
    scrubbedPayloads.map((payload) =>
      fetch(sentryUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/csp-report",
          ...(env.SENTRY_SECURITY_TOKEN ? { "X-Sentry-Token": env.SENTRY_SECURITY_TOKEN } : {}),
        },
        body: JSON.stringify(payload),
        redirect: "error",
      }).catch(() => null)
    )
  );

  log("info", "csp_report_forwarded", {
    count: scrubbedPayloads.length,
    sentry_ok: results.some((r) => r?.ok),
  }, request);

  return new Response(null, { status: 204, headers: SECURITY_HEADERS });
}

// GitHub OAuth code format validation (SDR-005): alphanumeric, hyphens, underscores, 1-40 chars.
// GitHub's code format is undocumented and has changed historically — validate
// loosely here; GitHub's server validates the actual code.
const VALID_CODE_RE = /^[a-zA-Z0-9_-]{1,40}$/;

async function handleTokenExchange(
  request: Request,
  env: Env,
  cors: Record<string, string>
): Promise<Response> {
  if (request.method !== "POST") {
    log("warn", "token_exchange_wrong_method", { method: request.method }, request);
    return errorResponse("method_not_allowed", 405, cors);
  }

  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!tokenRateLimiter.check(ip)) {
    log("warn", "token_exchange_rate_limited", {}, request);
    return new Response(JSON.stringify({ error: "rate_limited" }), {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": "60",
        ...cors,
        ...SECURITY_HEADERS,
      },
    });
  }

  log("info", "token_exchange_started", {}, request);

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
      has_code: body !== null && typeof body === "object" && "code" in body,
      code_type: body !== null && typeof body === "object" && "code" in body
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
        redirect: "error",
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
      ...SECURITY_HEADERS,
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
        headers: { ...cors, "Access-Control-Max-Age": "86400", ...SECURITY_HEADERS },
      });
    }

    // Sentry tunnel — same-origin proxy, no CORS needed (browser sends as first-party)
    if (url.pathname === "/api/error-reporting") {
      return handleSentryTunnel(request, env);
    }

    // CSP report tunnel — scrubs OAuth params before forwarding to Sentry
    if (url.pathname === "/api/csp-report") {
      return handleCspReport(request, env);
    }

    if (url.pathname === "/api/oauth/token") {
      return handleTokenExchange(request, env, cors);
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      return new Response("OK", {
        headers: SECURITY_HEADERS,
      });
    }

    // ── Proxy routes: validation, session, and rate limiting ─────────────────
    // Applies to /api/proxy/*, /api/jira/*
    // validateAndGuardProxyRoute handles OPTIONS preflight for proxy routes.
    // Proxy routes assume SPA fetch() callers — browser navigation GETs do not send Origin.
    if (isProxyPath(url.pathname)) {
      const guardResponse = validateAndGuardProxyRoute(request, env, url.pathname);
      if (guardResponse !== null) return guardResponse;

      // Step 2.5: IP pre-gate — rejects burst abuse before any crypto work (HKDF, HMAC)
      const proxyIp = request.headers.get("CF-Connecting-IP") ?? "unknown";
      if (!proxyPreGateLimiter.check(proxyIp)) {
        log("warn", "proxy_ip_rate_limited", { pathname: url.pathname }, request);
        return new Response(JSON.stringify({ error: "rate_limited" }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": "60", ...SECURITY_HEADERS },
        });
      }

      // Step 3: Session middleware — ensureSession never throws (SDR-003)
      const { sessionId, setCookie } = await ensureSession(request, env);

      // Step 4: Rate limiting using session ID as key
      let rateLimited = false;
      try {
        const { success } = await env.PROXY_RATE_LIMITER.limit({ key: sessionId });
        rateLimited = !success;
      } catch (err) {
        log("error", "rate_limiter_failed", {
          error: err instanceof Error ? err.message : "unknown",
        }, request);
        // Fail open — rate limiter misconfiguration should not block all proxy requests.
        // Turnstile and session binding still protect the seal endpoint.
      }
      if (rateLimited) {
        log("warn", "proxy_rate_limited", { pathname: url.pathname }, request);
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "Retry-After": "60",
          ...SECURITY_HEADERS,
        };
        if (setCookie) headers["Set-Cookie"] = setCookie;
        return new Response(JSON.stringify({ error: "rate_limited" }), { status: 429, headers });
      }

      // Step 5: Sealed-token endpoint
      if (url.pathname === "/api/proxy/seal") {
        const sealResponse = await handleProxySeal(request, env, sessionId);
        if (setCookie) {
          const headers = new Headers(sealResponse.headers);
          headers.set("Set-Cookie", setCookie);
          return new Response(sealResponse.body, {
            status: sealResponse.status,
            headers,
          });
        }
        return sealResponse;
      }

      // Other proxy routes not yet implemented — fall through to 404
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
