import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker, { type Env } from "../../src/worker/index";

const ALLOWED_ORIGIN = "https://gh.gordoncode.dev";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ASSETS: { fetch: async () => new Response("asset") },
    GITHUB_CLIENT_ID: "test_client_id",
    GITHUB_CLIENT_SECRET: "test_client_secret",
    ALLOWED_ORIGIN,
    ...overrides,
  };
}

function makeRequest(
  method: string,
  path: string,
  options: { body?: unknown; origin?: string; contentType?: string } = {}
): Request {
  const url = `https://gh.gordoncode.dev${path}`;
  const headers: Record<string, string> = {};
  if (options.origin !== undefined) {
    headers["Origin"] = options.origin;
  } else {
    headers["Origin"] = ALLOWED_ORIGIN;
  }
  if (options.body !== undefined) {
    headers["Content-Type"] = options.contentType ?? "application/json";
  }
  return new Request(url, {
    method,
    headers,
    body:
      options.body !== undefined
        ? JSON.stringify(options.body)
        : undefined,
  });
}

// Valid 20-char hex code
const VALID_CODE = "a1b2c3d4e5f6a1b2c3d4";

describe("Worker OAuth endpoint", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ── Token exchange ─────────────────────────────────────────────────────────

  it("POST /api/oauth/token with valid code returns access_token, token_type, scope", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "ghu_access123",
          token_type: "bearer",
          scope: "repo read:org notifications",
          extra_field: "should_not_be_returned",
        }),
        { status: 200 }
      )
    );

    const req = makeRequest("POST", "/api/oauth/token", { body: { code: VALID_CODE } });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(200);

    const json = await res.json() as Record<string, unknown>;
    expect(json["access_token"]).toBe("ghu_access123");
    expect(json["token_type"]).toBe("bearer");
    // Must not include expires_in (OAuth App tokens are permanent)
    expect(json["expires_in"]).toBeUndefined();
    // Must not include extra fields
    expect(json["extra_field"]).toBeUndefined();
    // Must not set a cookie (no refresh token for OAuth App)
    expect(res.headers.get("Set-Cookie")).toBeNull();
    // Must not include Access-Control-Allow-Credentials
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  it("POST /api/oauth/token forwards client_id and client_secret to GitHub", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: "ghu_tok", token_type: "bearer" }), {
        status: 200,
      })
    );
    globalThis.fetch = mockFetch;

    const req = makeRequest("POST", "/api/oauth/token", { body: { code: VALID_CODE } });
    await worker.fetch(req, makeEnv());

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://github.com/login/oauth/access_token");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body["client_id"]).toBe("test_client_id");
    expect(body["client_secret"]).toBe("test_client_secret");
    expect(body["code"]).toBe(VALID_CODE);
  });

  it("POST /api/oauth/token with GitHub error field returns generic error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: "bad_verification_code", error_description: "The code passed is incorrect." }),
        { status: 200 }
      )
    );

    const req = makeRequest("POST", "/api/oauth/token", { body: { code: VALID_CODE } });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);

    const json = await res.json() as Record<string, unknown>;
    expect(json["error"]).toBe("token_exchange_failed");
    // GitHub error description must NOT be forwarded (SDR-006)
    expect(JSON.stringify(json)).not.toContain("bad_verification_code");
    expect(JSON.stringify(json)).not.toContain("incorrect");
  });

  it("POST /api/oauth/token with missing code returns 400", async () => {
    const req = makeRequest("POST", "/api/oauth/token", { body: {} });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);
    const json = await res.json() as Record<string, unknown>;
    expect(json["error"]).toBe("invalid_request");
  });

  it("POST /api/oauth/token with invalid code format returns 400 (not 20-char hex)", async () => {
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch;

    const cases = [
      "a".repeat(41),         // exceeds 40-char limit
      "",                      // empty string
      "abc def",               // contains space
      "abc!@#$%^&*()",         // contains special chars
    ];

    for (const code of cases) {
      const req = makeRequest("POST", "/api/oauth/token", { body: { code } });
      const res = await worker.fetch(req, makeEnv());
      expect(res.status, `Expected 400 for code: ${code}`).toBe(400);
      const json = await res.json() as Record<string, unknown>;
      expect(json["error"]).toBe("invalid_request");
    }

    // Must not have called GitHub for invalid codes
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // ── qa-6: Code regex boundary tests ─────────────────────────────────────────

  it("POST /api/oauth/token with a 40-character code is valid (reaches GitHub)", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: "ghu_tok", token_type: "bearer" }), {
        status: 200,
      })
    );
    globalThis.fetch = mockFetch;

    const code40 = "a".repeat(40); // exactly 40 chars — within /^[a-zA-Z0-9_-]{1,40}$/
    const req = makeRequest("POST", "/api/oauth/token", { body: { code: code40 } });
    const res = await worker.fetch(req, makeEnv());
    // Should have passed validation and reached GitHub
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(res.status).toBe(200);
  });

  it("POST /api/oauth/token with a 41-character code returns 400 (exceeds max length)", async () => {
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch;

    const code41 = "a".repeat(41); // 41 chars — exceeds /^[a-zA-Z0-9_-]{1,40}$/
    const req = makeRequest("POST", "/api/oauth/token", { body: { code: code41 } });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);
    const json = await res.json() as Record<string, unknown>;
    expect(json["error"]).toBe("invalid_request");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("POST /api/oauth/token with _ and - in code is valid (special chars allowed)", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: "ghu_tok", token_type: "bearer" }), {
        status: 200,
      })
    );
    globalThis.fetch = mockFetch;

    const codeWithSpecial = "abc_def-ghi_jkl-mno"; // underscore and dash are allowed
    const req = makeRequest("POST", "/api/oauth/token", { body: { code: codeWithSpecial } });
    const res = await worker.fetch(req, makeEnv());
    // Should have passed validation and reached GitHub
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(res.status).toBe(200);
  });

  it("POST /api/oauth/token with empty string code returns 400", async () => {
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch;

    const req = makeRequest("POST", "/api/oauth/token", { body: { code: "" } });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);
    const json = await res.json() as Record<string, unknown>;
    expect(json["error"]).toBe("invalid_request");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("POST /api/oauth/token with invalid Content-Type returns 400", async () => {
    const req = makeRequest("POST", "/api/oauth/token", {
      body: { code: VALID_CODE },
      contentType: "text/plain",
    });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);
    const json = await res.json() as Record<string, unknown>;
    expect(json["error"]).toBe("invalid_request");
  });

  it("POST /api/oauth/token when GitHub fetch fails returns generic error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network error"));

    const req = makeRequest("POST", "/api/oauth/token", { body: { code: VALID_CODE } });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);
    const json = await res.json() as Record<string, unknown>;
    expect(json["error"]).toBe("token_exchange_failed");
    // Stack trace must not be in response (SDR-006)
    expect(JSON.stringify(json)).not.toContain("Error");
  });

  it("GET /api/oauth/token returns 405", async () => {
    const req = makeRequest("GET", "/api/oauth/token");
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(405);
    const json = await res.json() as Record<string, unknown>;
    expect(json["error"]).toBe("method_not_allowed");
  });

  // ── Removed endpoints return 404 ────────────────────────────────────────────

  it("POST /api/oauth/refresh returns 404 (endpoint removed for OAuth App)", async () => {
    const req = makeRequest("POST", "/api/oauth/refresh");
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(404);
    const json = await res.json() as Record<string, unknown>;
    expect(json["error"]).toBe("not_found");
  });

  it("POST /api/oauth/logout returns 404 (endpoint removed for OAuth App)", async () => {
    const req = makeRequest("POST", "/api/oauth/logout");
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(404);
    const json = await res.json() as Record<string, unknown>;
    expect(json["error"]).toBe("not_found");
  });

  // ── CORS ────────────────────────────────────────────────────────────────────

  it("CORS headers are present for matching origin", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: "ghu_tok", token_type: "bearer" }), {
        status: 200,
      })
    );

    const req = makeRequest("POST", "/api/oauth/token", {
      body: { code: VALID_CODE },
      origin: ALLOWED_ORIGIN,
    });
    const res = await worker.fetch(req, makeEnv());
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
    expect(res.headers.get("Access-Control-Allow-Methods")).toBe("POST");
    expect(res.headers.get("Access-Control-Allow-Headers")).toBe("Content-Type");
    // No credentials header for OAuth App (no cookies)
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  it("CORS headers are absent for non-matching origin (SDR-004)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: "ghu_tok", token_type: "bearer" }), {
        status: 200,
      })
    );

    const req = makeRequest("POST", "/api/oauth/token", {
      body: { code: VALID_CODE },
      origin: "https://evil.example.com",
    });
    const res = await worker.fetch(req, makeEnv());
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("CORS headers are absent for substring-matching origin (SDR-004 strict equality)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: "ghu_tok", token_type: "bearer" }), {
        status: 200,
      })
    );

    // A domain that contains the allowed origin as a substring
    const req = makeRequest("POST", "/api/oauth/token", {
      body: { code: VALID_CODE },
      origin: `https://gh.gordoncode.dev.evil.com`,
    });
    const res = await worker.fetch(req, makeEnv());
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  // ── OPTIONS preflight ───────────────────────────────────────────────────────

  it("OPTIONS /api/oauth/token returns 204 with CORS headers", async () => {
    const req = makeRequest("OPTIONS", "/api/oauth/token", {
      origin: ALLOWED_ORIGIN,
    });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
  });

  it("OPTIONS /api/oauth/refresh returns 404 (preflight narrowed to /token only)", async () => {
    const req = makeRequest("OPTIONS", "/api/oauth/refresh", {
      origin: ALLOWED_ORIGIN,
    });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(404);
  });

  it("OPTIONS /api/oauth/logout returns 404 (preflight narrowed to /token only)", async () => {
    const req = makeRequest("OPTIONS", "/api/oauth/logout", {
      origin: ALLOWED_ORIGIN,
    });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(404);
  });

  // ── Health and routing ──────────────────────────────────────────────────────

  it("GET /api/health returns 200 OK", async () => {
    const req = makeRequest("GET", "/api/health");
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK");
  });

  it("POST /api/unknown returns 404 with predefined error", async () => {
    const req = makeRequest("POST", "/api/unknown");
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(404);
    const json = await res.json() as Record<string, unknown>;
    expect(json["error"]).toBe("not_found");
  });

  // ── Security headers ────────────────────────────────────────────────────────

  it("Security headers present on token exchange response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: "ghu_tok", token_type: "bearer" }), {
        status: 200,
      })
    );

    const req = makeRequest("POST", "/api/oauth/token", { body: { code: VALID_CODE } });
    const res = await worker.fetch(req, makeEnv());
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("Security headers present on error responses", async () => {
    const req = makeRequest("POST", "/api/oauth/token", { body: {} });
    const res = await worker.fetch(req, makeEnv());
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("Security headers present on health response", async () => {
    const req = makeRequest("GET", "/api/health");
    const res = await worker.fetch(req, makeEnv());
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  // ── Non-API requests ────────────────────────────────────────────────────────

  it("Non-API requests are forwarded to ASSETS", async () => {
    const req = new Request("https://gh.gordoncode.dev/index.html");
    const assetFetch = vi.fn().mockResolvedValue(new Response("<!DOCTYPE html>", { status: 200 }));
    const res = await worker.fetch(req, makeEnv({ ASSETS: { fetch: assetFetch } }));
    expect(assetFetch).toHaveBeenCalledOnce();
    expect(res.status).toBe(200);
  });
});
