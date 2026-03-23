export interface Env {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  ALLOWED_ORIGIN: string;
}

// Predefined error strings only (SDR-006)
type ErrorCode =
  | "token_exchange_failed"
  | "invalid_request"
  | "method_not_allowed"
  | "not_found";

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
      "Access-Control-Allow-Credentials": "true",
      "Vary": "Origin",
    };
  }
  return {};
}

// ── Refresh token cookie helpers ─────────────────────────────────────────────

const RT_COOKIE_NAME = "github_tracker_rt";
const RT_MAX_AGE = 15_552_000; // ~6 months, matches GitHub refresh token lifetime

function setRefreshTokenCookie(token: string, env: Env): string {
  const isLocal = env.ALLOWED_ORIGIN.startsWith("http://localhost");
  const secure = isLocal ? "" : " Secure;";
  const sameSite = isLocal ? "Lax" : "Strict";
  return `${RT_COOKIE_NAME}=${token}; HttpOnly;${secure} SameSite=${sameSite}; Path=/api; Max-Age=${RT_MAX_AGE}`;
}

function clearRefreshTokenCookie(env: Env): string {
  const isLocal = env.ALLOWED_ORIGIN.startsWith("http://localhost");
  const secure = isLocal ? "" : " Secure;";
  const sameSite = isLocal ? "Lax" : "Strict";
  return `${RT_COOKIE_NAME}=; HttpOnly;${secure} SameSite=${sameSite}; Path=/api; Max-Age=0`;
}

function getRefreshTokenFromCookie(request: Request): string | null {
  const cookie = request.headers.get("Cookie");
  if (!cookie) return null;
  const match = cookie.match(new RegExp(`${RT_COOKIE_NAME}=([^;]+)`));
  return match ? match[1] : null;
}

// GitHub OAuth code format validation (SDR-005): alphanumeric, 1-40 chars.
// GitHub's code format is undocumented and has changed historically — validate
// loosely here; GitHub's server validates the actual code.
const VALID_CODE_RE = /^[a-zA-Z0-9_-]{1,40}$/;

// GitHub App refresh token format validation (SEC-003): ghr_ prefix + alphanumeric/underscore
const VALID_REFRESH_TOKEN_RE = /^ghr_[A-Za-z0-9_]{20,255}$/;

async function handleTokenExchange(
  request: Request,
  env: Env,
  cors: Record<string, string>
): Promise<Response> {
  if (request.method !== "POST") {
    return errorResponse("method_not_allowed", 405, cors);
  }

  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.includes("application/json")) {
    return errorResponse("invalid_request", 400, cors);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("invalid_request", 400, cors);
  }

  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as Record<string, unknown>)["code"] !== "string"
  ) {
    return errorResponse("invalid_request", 400, cors);
  }

  const code = (body as Record<string, unknown>)["code"] as string;

  // Strict code format validation before touching GitHub (SDR-005)
  if (!VALID_CODE_RE.test(code)) {
    return errorResponse("invalid_request", 400, cors);
  }

  let githubData: Record<string, unknown>;
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
    githubData = (await githubResp.json()) as Record<string, unknown>;
  } catch {
    return errorResponse("token_exchange_failed", 400, cors);
  }

  // GitHub returns 200 even on error — check for error field (SDR-006)
  if (
    typeof githubData["error"] === "string" ||
    typeof githubData["access_token"] !== "string"
  ) {
    return errorResponse("token_exchange_failed", 400, cors);
  }

  // Return only allowed fields — never forward full GitHub response.
  // Refresh token goes into an HttpOnly cookie, NOT the response body.
  const refreshToken = typeof githubData["refresh_token"] === "string"
    ? githubData["refresh_token"]
    : null;

  const allowed = {
    access_token: githubData["access_token"],
    token_type: githubData["token_type"] ?? "bearer",
    scope: githubData["scope"] ?? "",
    expires_in: githubData["expires_in"] ?? null,
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...cors,
    ...securityHeaders(),
  };
  if (refreshToken) {
    headers["Set-Cookie"] = setRefreshTokenCookie(refreshToken, env);
  }

  return new Response(JSON.stringify(allowed), { status: 200, headers });
}

async function handleRefreshToken(
  request: Request,
  env: Env,
  cors: Record<string, string>
): Promise<Response> {
  if (request.method !== "POST") {
    return errorResponse("method_not_allowed", 405, cors);
  }

  // Read refresh token from HttpOnly cookie (not request body)
  const refreshToken = getRefreshTokenFromCookie(request);
  if (!refreshToken || !VALID_REFRESH_TOKEN_RE.test(refreshToken)) {
    return errorResponse("invalid_request", 400, cors);
  }

  let githubData: Record<string, unknown>;
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
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
      }
    );
    githubData = (await githubResp.json()) as Record<string, unknown>;
  } catch {
    return errorResponse("token_exchange_failed", 400, cors);
  }

  if (
    typeof githubData["error"] === "string" ||
    typeof githubData["access_token"] !== "string"
  ) {
    return errorResponse("token_exchange_failed", 400, cors);
  }

  // Rotated refresh token goes into HttpOnly cookie, not response body
  const newRefreshToken = typeof githubData["refresh_token"] === "string"
    ? githubData["refresh_token"]
    : null;

  const allowed = {
    access_token: githubData["access_token"],
    token_type: githubData["token_type"] ?? "bearer",
    expires_in: githubData["expires_in"] ?? null,
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...cors,
    ...securityHeaders(),
  };
  if (newRefreshToken) {
    headers["Set-Cookie"] = setRefreshTokenCookie(newRefreshToken, env);
  }

  return new Response(JSON.stringify(allowed), { status: 200, headers });
}

async function handleLogout(
  request: Request,
  env: Env,
  cors: Record<string, string>
): Promise<Response> {
  if (request.method !== "POST") {
    return errorResponse("method_not_allowed", 405, cors);
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": clearRefreshTokenCookie(env),
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

    // CORS preflight
    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      return new Response(null, {
        status: 204,
        headers: { ...cors, "Access-Control-Max-Age": "86400", ...securityHeaders() },
      });
    }

    if (url.pathname === "/api/oauth/token") {
      return handleTokenExchange(request, env, cors);
    }

    if (url.pathname === "/api/oauth/refresh") {
      return handleRefreshToken(request, env, cors);
    }

    if (url.pathname === "/api/oauth/logout") {
      return handleLogout(request, env, cors);
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      return new Response("OK", {
        headers: securityHeaders(),
      });
    }

    if (url.pathname.startsWith("/api/")) {
      return errorResponse("not_found", 404, cors);
    }

    // Forward non-API requests to static assets
    return env.ASSETS.fetch(request);
  },
};
