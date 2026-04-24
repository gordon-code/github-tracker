import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker, { type Env } from "../../src/worker/index";
import { collectLogs, findLog, ALLOWED_ORIGIN } from "./helpers";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ASSETS: { fetch: async () => new Response("asset") },
    GITHUB_CLIENT_ID: "test_client_id",
    GITHUB_CLIENT_SECRET: "test_client_secret",
    ALLOWED_ORIGIN,
    SENTRY_DSN: "https://abc123@o123456.ingest.sentry.io/7890123",
    SESSION_KEY: "dGVzdC1zZXNzaW9uLWtleQ==",
    SEAL_KEY: "dGVzdC1zZWFsLWtleQ==",
    TURNSTILE_SECRET_KEY: "test-turnstile-secret",
    PROXY_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
    ...overrides,
  };
}

let _requestCounter = 0;

function makeRequest(
  method: string,
  path: string,
  options: { body?: unknown; origin?: string; contentType?: string } = {}
): Request {
  const url = `https://gh.gordoncode.dev${path}`;
  const headers: Record<string, string> = {
    // Unique IP per request to avoid hitting the in-memory rate limiter across tests
    "CF-Connecting-IP": `10.1.0.${++_requestCounter}`,
  };
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
  let consoleSpy: {
    info: ReturnType<typeof vi.spyOn>;
    warn: ReturnType<typeof vi.spyOn>;
    error: ReturnType<typeof vi.spyOn>;
  };

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    consoleSpy = {
      info: vi.spyOn(console, "info").mockImplementation(() => {}),
      warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
      error: vi.spyOn(console, "error").mockImplementation(() => {}),
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ── Rate limiting ────────────────────────────────────────────────────────

  it("returns 429 after exceeding 10 requests per minute from the same IP", async () => {
    const fixedIp = "10.1.99.1";
    function makeRateLimitRequest() {
      return new Request("https://gh.gordoncode.dev/api/oauth/token", {
        method: "POST",
        headers: {
          Origin: ALLOWED_ORIGIN,
          "Content-Type": "application/json",
          "CF-Connecting-IP": fixedIp,
        },
        body: JSON.stringify({ code: VALID_CODE }),
      });
    }

    // Mock successful GitHub response
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ access_token: "tok", token_type: "bearer", scope: "repo" }),
        { status: 200 }
      )
    );

    const env = makeEnv();
    // First 10 requests should succeed
    for (let i = 0; i < 10; i++) {
      const resp = await worker.fetch(makeRateLimitRequest(), env);
      expect(resp.status).not.toBe(429);
    }
    // 11th request should be rate-limited
    const resp = await worker.fetch(makeRateLimitRequest(), env);
    expect(resp.status).toBe(429);
    const body = await resp.json() as { error: string };
    expect(body.error).toBe("rate_limited");
    expect(resp.headers.get("Retry-After")).toBe("60");
    // Should include security headers
    expect(resp.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("allows requests again after the rate-limit window expires", async () => {
    const fixedIp = "10.1.99.2";
    function makeRateLimitRequest() {
      return new Request("https://gh.gordoncode.dev/api/oauth/token", {
        method: "POST",
        headers: {
          Origin: ALLOWED_ORIGIN,
          "Content-Type": "application/json",
          "CF-Connecting-IP": fixedIp,
        },
        body: JSON.stringify({ code: VALID_CODE }),
      });
    }

    vi.useFakeTimers();
    try {
      // Mock successful GitHub response
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ access_token: "tok", token_type: "bearer", scope: "repo" }),
          { status: 200 }
        )
      );

      const env = makeEnv();
      // Exhaust the 10-request limit — 11th triggers rate limit
      for (let i = 0; i < 10; i++) {
        await worker.fetch(makeRateLimitRequest(), env);
      }
      const limited = await worker.fetch(makeRateLimitRequest(), env);
      expect(limited.status).toBe(429);

      // Advance time past the 60-second window
      vi.advanceTimersByTime(61_000);

      // Next request should get a fresh window — not rate-limited
      const afterReset = await worker.fetch(makeRateLimitRequest(), env);
      expect(afterReset.status).not.toBe(429);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects token exchange when durable rate limiter returns failure", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: "ghu_test", token_type: "bearer", scope: "repo" }), { status: 200 })
    );
    const env = makeEnv({ PROXY_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: false }) } });
    const req = makeRequest("POST", "/api/oauth/token", { body: { code: VALID_CODE } });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
  });

  it("continues token exchange when durable rate limiter throws (fail-open)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: "ghu_test", token_type: "bearer", scope: "repo" }), { status: 200 })
    );
    const env = makeEnv({ PROXY_RATE_LIMITER: { limit: vi.fn().mockRejectedValue(new Error("binding error")) } });
    const req = makeRequest("POST", "/api/oauth/token", { body: { code: VALID_CODE } });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);

    const logs = collectLogs(consoleSpy);
    const failLog = findLog(logs, "token_rate_limiter_failed");
    expect(failLog).toBeDefined();
  });

  it("rejects token exchange with 400 when CF-Connecting-IP is absent", async () => {
    const req = new Request("https://gh.gordoncode.dev/api/oauth/token", {
      method: "POST",
      headers: { "Origin": ALLOWED_ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ code: VALID_CODE }),
    });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);
  });

  it("returns 503 when PROXY_RATE_LIMITER binding is missing", async () => {
    const req = makeRequest("POST", "/api/oauth/token", { body: { code: VALID_CODE } });
    const env = makeEnv({ PROXY_RATE_LIMITER: undefined as unknown as Env["PROXY_RATE_LIMITER"] });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(503);

    const logs = collectLogs(consoleSpy);
    const bindingLog = findLog(logs, "rate_limiter_binding_missing");
    expect(bindingLog).toBeDefined();
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
    // GitHub error description must NOT be forwarded
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
    // Stack trace must not be in response
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
    expect(res.headers.get("Access-Control-Allow-Headers")).toBe("Content-Type, X-Requested-With, cf-turnstile-response");
    // No credentials header for OAuth App (no cookies)
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  it("CORS headers are absent for non-matching origin", async () => {
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

  it("CORS headers are absent for substring-matching origin (strict equality)", async () => {
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

  // ── Structured logging ────────────────────────────────────────────────────

  describe("Structured logging", () => {
    // ── Log format & metadata ─────────────────────────────────────────────

    it("logs are valid JSON with worker identifier and event name", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ access_token: "ghu_tok", token_type: "bearer" }), { status: 200 })
      );

      const req = makeRequest("POST", "/api/oauth/token", { body: { code: VALID_CODE } });
      await worker.fetch(req, makeEnv());

      const logs = collectLogs(consoleSpy);
      expect(logs.length).toBeGreaterThan(0);
      for (const { entry } of logs) {
        expect(entry.worker).toBe("github-tracker");
        expect(typeof entry.event).toBe("string");
        expect((entry.event as string).length).toBeGreaterThan(0);
      }
    });

    it("logs include request metadata (origin, user_agent)", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ access_token: "ghu_tok", token_type: "bearer" }), { status: 200 })
      );

      const req = makeRequest("POST", "/api/oauth/token", { body: { code: VALID_CODE } });
      await worker.fetch(req, makeEnv());

      const logs = collectLogs(consoleSpy);
      const apiLog = findLog(logs, "api_request");
      expect(apiLog).toBeDefined();
      expect(apiLog!.entry.origin).toBe(ALLOWED_ORIGIN);
    });

    // ── API request & CORS logging ────────────────────────────────────────

    it("logs api_request for every /api/ request", async () => {
      const req = makeRequest("POST", "/api/oauth/token", { body: {} });
      await worker.fetch(req, makeEnv());

      const logs = collectLogs(consoleSpy);
      const apiLog = findLog(logs, "api_request");
      expect(apiLog).toBeDefined();
      expect(apiLog!.level).toBe("info");
      expect(apiLog!.entry.method).toBe("POST");
      expect(apiLog!.entry.pathname).toBe("/api/oauth/token");
      expect(apiLog!.entry.cors_matched).toBe(true);
    });

    it("logs cors_origin_mismatch when origin does not match", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ access_token: "ghu_tok", token_type: "bearer" }), { status: 200 })
      );

      const req = makeRequest("POST", "/api/oauth/token", {
        body: { code: VALID_CODE },
        origin: "https://evil.example.com",
      });
      await worker.fetch(req, makeEnv());

      const logs = collectLogs(consoleSpy);
      const corsLog = findLog(logs, "cors_origin_mismatch");
      expect(corsLog).toBeDefined();
      expect(corsLog!.level).toBe("warn");
      expect(corsLog!.entry.request_origin).toBe("https://evil.example.com");
      expect(corsLog!.entry.allowed_origin).toBe(ALLOWED_ORIGIN);
    });

    it("does not log cors_origin_mismatch when origin matches", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ access_token: "ghu_tok", token_type: "bearer" }), { status: 200 })
      );

      const req = makeRequest("POST", "/api/oauth/token", {
        body: { code: VALID_CODE },
        origin: ALLOWED_ORIGIN,
      });
      await worker.fetch(req, makeEnv());

      const logs = collectLogs(consoleSpy);
      expect(findLog(logs, "cors_origin_mismatch")).toBeUndefined();
    });

    it("does not log cors_origin_mismatch when origin header is absent", async () => {
      const req = new Request("https://gh.gordoncode.dev/api/health", { method: "GET" });
      await worker.fetch(req, makeEnv());

      const logs = collectLogs(consoleSpy);
      expect(findLog(logs, "cors_origin_mismatch")).toBeUndefined();
    });

    it("logs cors_preflight for OPTIONS /api/oauth/token", async () => {
      const req = makeRequest("OPTIONS", "/api/oauth/token", { origin: ALLOWED_ORIGIN });
      await worker.fetch(req, makeEnv());

      const logs = collectLogs(consoleSpy);
      const preflightLog = findLog(logs, "cors_preflight");
      expect(preflightLog).toBeDefined();
      expect(preflightLog!.level).toBe("info");
      expect(preflightLog!.entry.cors_matched).toBe(true);
    });

    it("does not log api_request for non-API routes (static assets)", async () => {
      const req = new Request("https://gh.gordoncode.dev/index.html");
      await worker.fetch(req, makeEnv());

      const logs = collectLogs(consoleSpy);
      expect(findLog(logs, "api_request")).toBeUndefined();
    });

    it("logs api_not_found for unknown API routes", async () => {
      const req = makeRequest("GET", "/api/nonexistent");
      await worker.fetch(req, makeEnv());

      const logs = collectLogs(consoleSpy);
      const notFoundLog = findLog(logs, "api_not_found");
      expect(notFoundLog).toBeDefined();
      expect(notFoundLog!.level).toBe("warn");
      expect(notFoundLog!.entry.pathname).toBe("/api/nonexistent");
    });

    // ── Token exchange lifecycle logging ──────────────────────────────────

    it("logs full success lifecycle: api_request → token_exchange_started → github_oauth_request_sent → token_exchange_succeeded", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({
          access_token: "ghu_tok",
          token_type: "bearer",
          scope: "repo read:org",
        }), { status: 200 })
      );

      const req = makeRequest("POST", "/api/oauth/token", { body: { code: VALID_CODE } });
      await worker.fetch(req, makeEnv());

      const logs = collectLogs(consoleSpy);
      const events = logs.map((l) => l.entry.event);
      expect(events).toContain("api_request");
      expect(events).toContain("token_exchange_started");
      expect(events).toContain("github_oauth_request_sent");
      expect(events).toContain("token_exchange_succeeded");

      const successLog = findLog(logs, "token_exchange_succeeded")!;
      expect(successLog.level).toBe("info");
      expect(successLog.entry.scope).toBe("repo read:org");
      expect(successLog.entry.token_type).toBe("bearer");
      expect(successLog.entry.github_status).toBe(200);
    });

    it("logs token_exchange_wrong_method for non-POST requests", async () => {
      const req = makeRequest("GET", "/api/oauth/token");
      await worker.fetch(req, makeEnv());

      const logs = collectLogs(consoleSpy);
      const methodLog = findLog(logs, "token_exchange_wrong_method");
      expect(methodLog).toBeDefined();
      expect(methodLog!.level).toBe("warn");
      expect(methodLog!.entry.method).toBe("GET");
    });

    it("logs token_exchange_bad_content_type for wrong Content-Type", async () => {
      const req = makeRequest("POST", "/api/oauth/token", {
        body: { code: VALID_CODE },
        contentType: "text/plain",
      });
      await worker.fetch(req, makeEnv());

      const logs = collectLogs(consoleSpy);
      const ctLog = findLog(logs, "token_exchange_bad_content_type");
      expect(ctLog).toBeDefined();
      expect(ctLog!.level).toBe("warn");
      expect(ctLog!.entry.content_type).toBe("text/plain");
    });

    it("logs token_exchange_json_parse_failed for malformed JSON body", async () => {
      const req = new Request("https://gh.gordoncode.dev/api/oauth/token", {
        method: "POST",
        headers: {
          "Origin": ALLOWED_ORIGIN,
          "Content-Type": "application/json",
          "CF-Connecting-IP": `10.1.0.${++_requestCounter}`,
        },
        body: "not-valid-json{{{",
      });
      await worker.fetch(req, makeEnv());

      const logs = collectLogs(consoleSpy);
      const parseLog = findLog(logs, "token_exchange_json_parse_failed");
      expect(parseLog).toBeDefined();
      expect(parseLog!.level).toBe("warn");
      expect(typeof parseLog!.entry.error).toBe("string");
    });

    it("logs token_exchange_missing_code when code field is absent", async () => {
      const req = makeRequest("POST", "/api/oauth/token", { body: { not_code: "abc" } });
      await worker.fetch(req, makeEnv());

      const logs = collectLogs(consoleSpy);
      const codeLog = findLog(logs, "token_exchange_missing_code");
      expect(codeLog).toBeDefined();
      expect(codeLog!.level).toBe("warn");
      expect(codeLog!.entry.has_code).toBe(false);
    });

    it("logs token_exchange_missing_code when code is not a string", async () => {
      const req = makeRequest("POST", "/api/oauth/token", { body: { code: 12345 } });
      await worker.fetch(req, makeEnv());

      const logs = collectLogs(consoleSpy);
      const codeLog = findLog(logs, "token_exchange_missing_code");
      expect(codeLog).toBeDefined();
      expect(codeLog!.entry.has_code).toBe(true);
      expect(codeLog!.entry.code_type).toBe("number");
    });

    it("logs token_exchange_invalid_code_format for regex-failing codes", async () => {
      const req = makeRequest("POST", "/api/oauth/token", { body: { code: "abc def!!" } });
      await worker.fetch(req, makeEnv());

      const logs = collectLogs(consoleSpy);
      const fmtLog = findLog(logs, "token_exchange_invalid_code_format");
      expect(fmtLog).toBeDefined();
      expect(fmtLog!.level).toBe("warn");
      expect(fmtLog!.entry.code_length).toBe(9);
      expect(fmtLog!.entry.code_has_spaces).toBe(true);
    });

    it("logs github_oauth_fetch_failed when GitHub is unreachable", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));

      const req = makeRequest("POST", "/api/oauth/token", { body: { code: VALID_CODE } });
      await worker.fetch(req, makeEnv());

      const logs = collectLogs(consoleSpy);
      const fetchLog = findLog(logs, "github_oauth_fetch_failed");
      expect(fetchLog).toBeDefined();
      expect(fetchLog!.level).toBe("error");
      expect(fetchLog!.entry.error).toBe("fetch failed");
      expect(fetchLog!.entry.error_name).toBe("TypeError");
    });

    it("logs github_oauth_error_response with GitHub error details", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({
          error: "bad_verification_code",
          error_description: "The code passed is incorrect or expired.",
          error_uri: "https://docs.github.com/apps/managing-oauth-apps/troubleshooting-oauth-app-access-token-request-errors/#bad-verification-code",
        }), { status: 200 })
      );

      const req = makeRequest("POST", "/api/oauth/token", { body: { code: VALID_CODE } });
      await worker.fetch(req, makeEnv());

      const logs = collectLogs(consoleSpy);
      const errLog = findLog(logs, "github_oauth_error_response");
      expect(errLog).toBeDefined();
      expect(errLog!.level).toBe("error");
      expect(errLog!.entry.github_error).toBe("bad_verification_code");
      expect(errLog!.entry.github_error_description).toBe("The code passed is incorrect or expired.");
      expect(errLog!.entry.github_error_uri).toContain("docs.github.com");
      expect(errLog!.entry.has_access_token).toBe(false);
    });

    it("logs github_oauth_error_response when access_token is missing from GitHub response", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ token_type: "bearer" }), { status: 200 })
      );

      const req = makeRequest("POST", "/api/oauth/token", { body: { code: VALID_CODE } });
      await worker.fetch(req, makeEnv());

      const logs = collectLogs(consoleSpy);
      const errLog = findLog(logs, "github_oauth_error_response");
      expect(errLog).toBeDefined();
      expect(errLog!.entry.has_access_token).toBe(false);
    });

    // ── Security: logs must NEVER contain secrets ─────────────────────────

    it("logs never contain access tokens, codes, or client secrets", async () => {
      const sensitiveToken = "ghu_SuperSecretToken123";
      const sensitiveSecret = "test_client_secret";

      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({
          access_token: sensitiveToken,
          token_type: "bearer",
          scope: "repo",
        }), { status: 200 })
      );

      const req = makeRequest("POST", "/api/oauth/token", { body: { code: VALID_CODE } });
      await worker.fetch(req, makeEnv());

      const logs = collectLogs(consoleSpy);
      const allLogText = logs.map((l) => JSON.stringify(l.entry)).join("\n");

      expect(allLogText).not.toContain(sensitiveToken);
      expect(allLogText).not.toContain(sensitiveSecret);
      expect(allLogText).not.toContain(VALID_CODE);
    });

    it("logs never contain secrets on error paths either", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({
          error: "bad_verification_code",
          error_description: "The code is wrong",
        }), { status: 200 })
      );

      const req = makeRequest("POST", "/api/oauth/token", { body: { code: VALID_CODE } });
      await worker.fetch(req, makeEnv());

      const logs = collectLogs(consoleSpy);
      const allLogText = logs.map((l) => JSON.stringify(l.entry)).join("\n");

      expect(allLogText).not.toContain(VALID_CODE);
      expect(allLogText).not.toContain("test_client_secret");
    });
  });

});
