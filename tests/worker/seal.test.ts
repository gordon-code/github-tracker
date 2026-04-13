import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker, { type Env } from "../../src/worker/index";
import { collectLogs, findLog } from "./helpers";

const ALLOWED_ORIGIN = "https://gh.gordoncode.dev";

// Base64-encoded test keys for testing (HKDF accepts any length input key material)
// "test-session-key" base64-encoded
const TEST_SESSION_KEY = "dGVzdC1zZXNzaW9uLWtleQ==";
// "test-seal-key" base64-encoded
const TEST_SEAL_KEY = "dGVzdC1zZWFsLWtleQ==";

let _requestCounter = 0;

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ASSETS: { fetch: async () => new Response("asset") },
    GITHUB_CLIENT_ID: "test_client_id",
    GITHUB_CLIENT_SECRET: "test_client_secret",
    ALLOWED_ORIGIN,
    SESSION_KEY: TEST_SESSION_KEY,
    SEAL_KEY: TEST_SEAL_KEY,
    TURNSTILE_SECRET_KEY: "test-turnstile-secret",
    PROXY_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
    ...overrides,
  };
}

function makeSealRequest(options: {
  body?: unknown;
  origin?: string;
  addXRequestedWith?: boolean;
  addContentType?: boolean;
  turnstileToken?: string;
  method?: string;
} = {}): Request {
  const {
    body = { token: "ghp_test_token_123", purpose: "jira-api-token" },
    origin = ALLOWED_ORIGIN,
    addXRequestedWith = true,
    addContentType = true,
    turnstileToken = "valid-turnstile-token",
    method = "POST",
  } = options;

  const headers: Record<string, string> = {
    // Unique IP per request to avoid hitting the in-memory IP pre-gate rate limiter across tests
    "CF-Connecting-IP": `10.4.0.${++_requestCounter}`,
  };
  if (origin) headers["Origin"] = origin;
  if (addXRequestedWith) headers["X-Requested-With"] = "fetch";
  if (addContentType) headers["Content-Type"] = "application/json";
  if (turnstileToken) headers["cf-turnstile-response"] = turnstileToken;
  // Sec-Fetch-Site is omitted to simulate legacy browser (passes validation)

  return new Request(`https://gh.gordoncode.dev/api/proxy/seal`, {
    method,
    headers,
    body: method !== "GET" && body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe("Worker /api/proxy/seal endpoint", () => {
  let originalFetch: typeof globalThis.fetch;
  let consoleSpy: { info: ReturnType<typeof vi.spyOn>; warn: ReturnType<typeof vi.spyOn>; error: ReturnType<typeof vi.spyOn> };

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

  // ── Valid request ─────────────────────────────────────────────────────────

  it("valid request with all headers + mocked Turnstile returns sealed token", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 })
    );

    const req = makeSealRequest();
    const res = await worker.fetch(req, makeEnv());

    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(typeof json["sealed"]).toBe("string");
    expect((json["sealed"] as string).length).toBeGreaterThan(0);
    // Sealed token should be base64url (no +, /, = chars)
    expect(json["sealed"]).not.toMatch(/[+/=]/);
  });

  // ── Validation failures ───────────────────────────────────────────────────

  it("request missing X-Requested-With returns 403 with missing_csrf_header", async () => {
    const req = makeSealRequest({ addXRequestedWith: false });
    const res = await worker.fetch(req, makeEnv());

    expect(res.status).toBe(403);
    const json = await res.json() as Record<string, unknown>;
    expect(json["error"]).toBe("missing_csrf_header");
  });

  it("request with wrong Origin returns 403 with origin_mismatch", async () => {
    const req = makeSealRequest({ origin: "https://evil.example.com" });
    const res = await worker.fetch(req, makeEnv());

    expect(res.status).toBe(403);
    const json = await res.json() as Record<string, unknown>;
    expect(json["error"]).toBe("origin_mismatch");
  });

  it("request with Sec-Fetch-Site: cross-site returns 403 with cross_site_request", async () => {
    const headers: Record<string, string> = {
      "Origin": ALLOWED_ORIGIN,
      "X-Requested-With": "fetch",
      "Content-Type": "application/json",
      "cf-turnstile-response": "valid-token",
      "Sec-Fetch-Site": "cross-site",
    };
    const req = new Request("https://gh.gordoncode.dev/api/proxy/seal", {
      method: "POST",
      headers,
      body: JSON.stringify({ token: "test", purpose: "jira-api-token" }),
    });
    const res = await worker.fetch(req, makeEnv());

    expect(res.status).toBe(403);
    const json = await res.json() as Record<string, unknown>;
    expect(json["error"]).toBe("cross_site_request");
  });

  // ── Turnstile failures ────────────────────────────────────────────────────

  it("request with failed Turnstile returns 403 with turnstile_failed", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ success: false, "error-codes": ["timeout-or-duplicate"] }),
        { status: 200 }
      )
    );

    const req = makeSealRequest();
    const res = await worker.fetch(req, makeEnv());

    expect(res.status).toBe(403);
    const json = await res.json() as Record<string, unknown>;
    expect(json["error"]).toBe("turnstile_failed");
  });

  it("request with missing Turnstile token returns 403 with turnstile_failed", async () => {
    const req = makeSealRequest({ turnstileToken: "" });
    const res = await worker.fetch(req, makeEnv());

    expect(res.status).toBe(403);
    const json = await res.json() as Record<string, unknown>;
    expect(json["error"]).toBe("turnstile_failed");
  });

  it("request with oversized Turnstile header (>2048 chars) returns 403 with turnstile_failed", async () => {
    const oversizedToken = "a".repeat(2049);
    const req = makeSealRequest({ turnstileToken: oversizedToken });
    const res = await worker.fetch(req, makeEnv());

    expect(res.status).toBe(403);
    const json = await res.json() as Record<string, unknown>;
    expect(json["error"]).toBe("turnstile_failed");
  });

  it("request with Turnstile header exactly 2048 chars is not rejected by length guard", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 })
    );

    const maxToken = "a".repeat(2048);
    const req = makeSealRequest({ turnstileToken: maxToken });
    const res = await worker.fetch(req, makeEnv());

    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(typeof json["sealed"]).toBe("string");
  });

  // ── Rate limiting ─────────────────────────────────────────────────────────

  it("request exceeding rate limit returns 429 with rate_limited and Retry-After header", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 })
    );

    const rateLimiter = { limit: vi.fn().mockResolvedValue({ success: false }) };
    const req = makeSealRequest();
    const res = await worker.fetch(req, makeEnv({ PROXY_RATE_LIMITER: rateLimiter }));

    expect(res.status).toBe(429);
    const json = await res.json() as Record<string, unknown>;
    expect(json["error"]).toBe("rate_limited");
    expect(res.headers.get("Retry-After")).toBe("60");
  });

  it("request proceeds when rate limiter throws (fail-open)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 })
    );

    const rateLimiter = { limit: vi.fn().mockRejectedValue(new Error("binding unavailable")) };
    const req = makeSealRequest();
    const res = await worker.fetch(req, makeEnv({ PROXY_RATE_LIMITER: rateLimiter }));

    // Should NOT be 429 or 500 — rate limiter failure is fail-open
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json["sealed"]).toBeDefined();
  });

  // ── Input validation ──────────────────────────────────────────────────────

  it("request with token exceeding 2048 chars returns 400 with invalid_request", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 })
    );

    const longToken = "a".repeat(2049);
    const req = makeSealRequest({ body: { token: longToken, purpose: "jira-api-token" } });
    const res = await worker.fetch(req, makeEnv());

    expect(res.status).toBe(400);
    const json = await res.json() as Record<string, unknown>;
    expect(json["error"]).toBe("invalid_request");
  });

  it("request with token exactly 2048 chars is accepted", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 })
    );

    const maxToken = "a".repeat(2048);
    const req = makeSealRequest({ body: { token: maxToken, purpose: "jira-api-token" } });
    const res = await worker.fetch(req, makeEnv());

    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(typeof json["sealed"]).toBe("string");
  });

  it("request with missing purpose returns 400 with invalid_request", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 })
    );

    const req = makeSealRequest({ body: { token: "ghp_test" } });
    const res = await worker.fetch(req, makeEnv());

    expect(res.status).toBe(400);
    const json = await res.json() as Record<string, unknown>;
    expect(json["error"]).toBe("invalid_request");
  });

  it("request with empty purpose string returns 400 with invalid_request", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 })
    );

    const req = makeSealRequest({ body: { token: "ghp_test", purpose: "" } });
    const res = await worker.fetch(req, makeEnv());

    expect(res.status).toBe(400);
    const json = await res.json() as Record<string, unknown>;
    expect(json["error"]).toBe("invalid_request");
  });

  it("request with invalid purpose (not in VALID_PURPOSES) returns 400", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 })
    );

    const req = makeSealRequest({ body: { token: "ghp_test", purpose: "github-pat" } });
    const res = await worker.fetch(req, makeEnv());

    expect(res.status).toBe(400);
    const json = await res.json() as Record<string, unknown>;
    expect(json["error"]).toBe("invalid_request");
  });

  it("request with missing token returns 400 with invalid_request", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 })
    );

    const req = makeSealRequest({ body: { purpose: "jira-api-token" } });
    const res = await worker.fetch(req, makeEnv());

    expect(res.status).toBe(400);
    const json = await res.json() as Record<string, unknown>;
    expect(json["error"]).toBe("invalid_request");
  });

  // ── OPTIONS preflight ─────────────────────────────────────────────────────

  it("OPTIONS preflight with valid origin returns 204 with correct CORS headers", async () => {
    const req = new Request("https://gh.gordoncode.dev/api/proxy/seal", {
      method: "OPTIONS",
      headers: {
        "Origin": ALLOWED_ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type, X-Requested-With, cf-turnstile-response",
      },
    });
    const res = await worker.fetch(req, makeEnv());

    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
    const allowHeaders = res.headers.get("Access-Control-Allow-Headers") ?? "";
    expect(allowHeaders).toContain("Content-Type");
    expect(allowHeaders).toContain("X-Requested-With");
    expect(allowHeaders).toContain("cf-turnstile-response");
    const allowMethods = res.headers.get("Access-Control-Allow-Methods") ?? "";
    expect(allowMethods).toContain("POST");
  });

  it("OPTIONS preflight with wrong origin returns 403", async () => {
    const req = new Request("https://gh.gordoncode.dev/api/proxy/seal", {
      method: "OPTIONS",
      headers: {
        "Origin": "https://evil.example.com",
        "Access-Control-Request-Method": "POST",
      },
    });
    const res = await worker.fetch(req, makeEnv());

    expect(res.status).toBe(403);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  // ── Non-POST method rejection ─────────────────────────────────────────────

  it("GET request to /api/proxy/seal returns 405 with method_not_allowed", async () => {
    const req = makeSealRequest({ method: "GET" });
    const res = await worker.fetch(req, makeEnv());

    expect(res.status).toBe(405);
    const json = await res.json() as Record<string, unknown>;
    expect(json["error"]).toBe("method_not_allowed");
  });

  it("successful POST to /api/proxy/seal does not set Access-Control-Allow-Origin", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 })
    );

    const req = makeSealRequest();
    const res = await worker.fetch(req, makeEnv());

    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  // ── Unimplemented proxy routes ────────────────────────────────────────────

  it("valid POST to /api/jira/issues falls through to 404 with not_found", async () => {
    const req = new Request("https://gh.gordoncode.dev/api/jira/issues", {
      method: "POST",
      headers: {
        "Origin": ALLOWED_ORIGIN,
        "X-Requested-With": "fetch",
        "Content-Type": "application/json",
        "CF-Connecting-IP": `10.4.0.${++_requestCounter}`,
      },
      body: JSON.stringify({}),
    });
    const res = await worker.fetch(req, makeEnv());

    expect(res.status).toBe(404);
    const json = await res.json() as Record<string, unknown>;
    expect(json["error"]).toBe("not_found");
  });

  // ── Session cookie issuance ───────────────────────────────────────────────

  it("first request issues a session cookie in Set-Cookie", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 })
    );

    const req = makeSealRequest();
    const res = await worker.fetch(req, makeEnv());

    expect(res.status).toBe(200);
    const setCookie = res.headers.get("Set-Cookie");
    expect(setCookie).not.toBeNull();
    expect(setCookie).toContain("__Host-session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
  });

  // ── Crypto failure (sealToken throws) ────────────────────────────────────

  it("when sealToken fails due to invalid key, returns 500 with seal_failed", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 })
    );

    // Use an invalid (non-base64url) key to force a crypto failure in deriveKey
    const req = makeSealRequest();
    const res = await worker.fetch(req, makeEnv({ SEAL_KEY: "!!not-valid-base64!!" }));

    expect(res.status).toBe(500);
    const json = await res.json() as Record<string, unknown>;
    expect(json["error"]).toBe("seal_failed");
    // Must not include crypto error details in response (SC-9)
    expect(JSON.stringify(json)).not.toContain("DOMException");
    expect(JSON.stringify(json)).not.toContain("DataError");
  });

  // ── Security headers ──────────────────────────────────────────────────────

  it("responses include security headers", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 })
    );

    const req = makeSealRequest();
    const res = await worker.fetch(req, makeEnv());

    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });

  // ── SC-11: seal operation logging ─────────────────────────────────────────

  it("successful seal logs token_sealed event with purpose and token_length", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 })
    );

    const req = makeSealRequest({ body: { token: "ghp_abc123", purpose: "jira-api-token" } });
    await worker.fetch(req, makeEnv());

    const allLogs = collectLogs(consoleSpy);
    const sealLog = findLog(allLogs, "token_sealed");
    expect(sealLog).toBeDefined();
    expect(sealLog!.entry["purpose"]).toBe("jira-api-token");
    expect(sealLog!.entry["token_length"]).toBe(10); // "ghp_abc123".length
    // Must NOT log the actual token value
    const allLogText = allLogs.map((l) => JSON.stringify(l.entry)).join("\n");
    expect(allLogText).not.toContain("ghp_abc123");
  });

  // ── Proxy IP pre-gate ─────────────────────────────────────────────────────

  describe("proxy IP pre-gate", () => {
    it("rejects proxy requests after IP threshold exceeded", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true }), { status: 200 })
      );

      const env = makeEnv();
      const fixedIp = "10.4.99.1";
      // Send 60 requests — all should pass
      for (let i = 0; i < 60; i++) {
        const req = new Request("https://gh.gordoncode.dev/api/proxy/seal", {
          method: "POST",
          headers: {
            "CF-Connecting-IP": fixedIp,
            "Origin": ALLOWED_ORIGIN,
            "X-Requested-With": "fetch",
            "Content-Type": "application/json",
            "cf-turnstile-response": "valid-turnstile-token",
          },
          body: JSON.stringify({ token: "ghp_test", purpose: "jira-api-token" }),
        });
        const res = await worker.fetch(req, env);
        expect(res.status).not.toBe(429);
      }
      // 61st request from same IP should be rejected
      const req = new Request("https://gh.gordoncode.dev/api/proxy/seal", {
        method: "POST",
        headers: {
          "CF-Connecting-IP": fixedIp,
          "Origin": ALLOWED_ORIGIN,
          "X-Requested-With": "fetch",
          "Content-Type": "application/json",
          "cf-turnstile-response": "valid-turnstile-token",
        },
        body: JSON.stringify({ token: "ghp_test", purpose: "jira-api-token" }),
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBe("60");
      // TCG-003: pre-gate 429 response body must contain {error: "rate_limited"}
      const body = await res.json() as Record<string, unknown>;
      expect(body["error"]).toBe("rate_limited");
    });

    it("does not issue session cookie when IP pre-gate rejects", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true }), { status: 200 })
      );

      const env = makeEnv();
      const fixedIp = "10.4.99.4";
      // Exhaust the 60/min limit
      for (let i = 0; i < 60; i++) {
        await worker.fetch(new Request("https://gh.gordoncode.dev/api/proxy/seal", {
          method: "POST",
          headers: {
            "CF-Connecting-IP": fixedIp,
            "Origin": ALLOWED_ORIGIN,
            "X-Requested-With": "fetch",
            "Content-Type": "application/json",
            "cf-turnstile-response": "valid-turnstile-token",
          },
          body: JSON.stringify({ token: "ghp_test", purpose: "jira-api-token" }),
        }), env);
      }
      // 61st — should be rejected with no Set-Cookie (ensureSession was never called)
      const req = new Request("https://gh.gordoncode.dev/api/proxy/seal", {
        method: "POST",
        headers: {
          "CF-Connecting-IP": fixedIp,
          "Origin": ALLOWED_ORIGIN,
          "X-Requested-With": "fetch",
          "Content-Type": "application/json",
          "cf-turnstile-response": "valid-turnstile-token",
        },
        body: JSON.stringify({ token: "ghp_test", purpose: "jira-api-token" }),
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(429);
      expect(res.headers.get("Set-Cookie")).toBeNull();
    });

    it("IP pre-gate is independent of session-based rate limiter", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true }), { status: 200 })
      );

      // A request that passes the IP pre-gate should still go through session + CF rate limiter as normal
      const env = makeEnv();
      const req = makeSealRequest();
      const res = await worker.fetch(req, env);
      // Should succeed — IP pre-gate passed, session created, CF limiter allowed
      expect(res.status).toBe(200);
      const json = await res.json() as Record<string, unknown>;
      expect(typeof json["sealed"]).toBe("string");
    });
  });
});
