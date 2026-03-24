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
      "Vary": "Origin",
    };
  }
  return {};
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
