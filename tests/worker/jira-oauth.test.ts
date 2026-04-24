import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker, { type Env } from "../../src/worker/index";
import { collectLogs, ALLOWED_ORIGIN } from "./helpers";

// ── Constants ─────────────────────────────────────────────────────────────────

const TEST_SESSION_KEY = "dGVzdC1zZXNzaW9uLWtleQ=="; // "test-session-key" base64
const TEST_SEAL_KEY = "dGVzdC1zZWFsLWtleQ==";         // "test-seal-key" base64

const TEST_EMAIL = "jira-user@example.com";
const TEST_API_TOKEN = "plaintext-api-token-secret";
// Valid UUID v4 cloudId
const VALID_CLOUD_ID = "a1b2c3d4-1234-4abc-89ef-a1b2c3d4e5f6";

let _requestCounter = 0;

// ── Env factory ───────────────────────────────────────────────────────────────

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ASSETS: { fetch: async () => new Response("asset") },
    GITHUB_CLIENT_ID: "test_client_id",
    GITHUB_CLIENT_SECRET: "test_client_secret",
    JIRA_CLIENT_ID: "jira-test-client-id",
    JIRA_CLIENT_SECRET: "jira-test-client-secret",
    ALLOWED_ORIGIN,
    SESSION_KEY: TEST_SESSION_KEY,
    SEAL_KEY: TEST_SEAL_KEY,
    SENTRY_DSN: undefined,
    TURNSTILE_SECRET_KEY: "test-turnstile-secret",
    PROXY_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
    ...overrides,
  };
}

// ── Request helpers ───────────────────────────────────────────────────────────

/** Make a Jira token-exchange or refresh request (OAuth path — no X-Requested-With needed). */
function makeJiraOAuthRequest(
  path: string,
  body: unknown,
  options: { origin?: string; contentType?: string; turnstileToken?: string } = {}
): Request {
  const headers: Record<string, string> = {
    "CF-Connecting-IP": `10.2.0.${++_requestCounter}`,
    "Origin": options.origin ?? ALLOWED_ORIGIN,
    "Content-Type": options.contentType ?? "application/json",
  };
  if (options.turnstileToken !== undefined) {
    headers["cf-turnstile-response"] = options.turnstileToken;
  } else {
    // Default: present but not required for refresh (only exchange needs it)
    headers["cf-turnstile-response"] = "valid-turnstile-token";
  }
  return new Request(`https://gh.gordoncode.dev${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

/** Make a Jira proxy request (proxy path — requires Origin, X-Requested-With, Content-Type). */
function makeJiraProxyRequest(
  body: unknown,
  options: { origin?: string; addXRequestedWith?: boolean } = {}
): Request {
  const headers: Record<string, string> = {
    "CF-Connecting-IP": `10.3.0.${++_requestCounter}`,
    "Origin": options.origin ?? ALLOWED_ORIGIN,
    "Content-Type": "application/json",
  };
  if (options.addXRequestedWith !== false) {
    headers["X-Requested-With"] = "fetch";
  }
  return new Request("https://gh.gordoncode.dev/api/jira/proxy", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

/** Seal a plain token using the Worker's seal endpoint so proxy tests have a valid sealed blob. */
async function sealTestToken(token: string, purpose: "jira-api-token" | "jira-refresh-token"): Promise<string> {
  // Mock Turnstile success for the seal step
  const fetchMock = vi.fn().mockResolvedValueOnce(
    new Response(JSON.stringify({ success: true, action: "seal" }), { status: 200 })
  );
  globalThis.fetch = fetchMock;

  const req = new Request("https://gh.gordoncode.dev/api/proxy/seal", {
    method: "POST",
    headers: {
      "CF-Connecting-IP": `10.5.0.${++_requestCounter}`,
      "Origin": ALLOWED_ORIGIN,
      "X-Requested-With": "fetch",
      "Content-Type": "application/json",
      "cf-turnstile-response": "valid-turnstile-token",
    },
    body: JSON.stringify({ token, purpose }),
  });

  const res = await worker.fetch(req, makeEnv());
  const json = await res.json() as Record<string, unknown>;
  return json["sealed"] as string;
}

// ── Jira Token Exchange (/api/oauth/jira/token) ───────────────────────────────

describe("POST /api/oauth/jira/token — Jira token exchange", () => {
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

  it("returns 404 when JIRA_CLIENT_ID is not configured", async () => {
    globalThis.fetch = vi.fn();
    const req = makeJiraOAuthRequest("/api/oauth/jira/token", { code: "valid-code-123" });
    const res = await worker.fetch(req, makeEnv({ JIRA_CLIENT_ID: undefined }));
    expect(res.status).toBe(404);
    const json = await res.json() as Record<string, unknown>;
    expect(json["error"]).toBe("not_found");
  });

  it("returns 404 when JIRA_CLIENT_SECRET is not configured", async () => {
    globalThis.fetch = vi.fn();
    const req = makeJiraOAuthRequest("/api/oauth/jira/token", { code: "valid-code-123" });
    const res = await worker.fetch(req, makeEnv({ JIRA_CLIENT_SECRET: undefined }));
    expect(res.status).toBe(404);
  });

  it("returns 400 when code is missing from body", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, action: "jira-token" }), { status: 200 })
    );
    const req = makeJiraOAuthRequest("/api/oauth/jira/token", {});
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);
    const json = await res.json() as Record<string, unknown>;
    expect(json["error"]).toBe("invalid_request");
  });

  it("returns 400 when code is empty string", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, action: "jira-token" }), { status: 200 })
    );
    const req = makeJiraOAuthRequest("/api/oauth/jira/token", { code: "" });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);
    const json = await res.json() as Record<string, unknown>;
    expect(json["error"]).toBe("invalid_request");
  });

  it("returns 400 when code is not a string", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, action: "jira-token" }), { status: 200 })
    );
    const req = makeJiraOAuthRequest("/api/oauth/jira/token", { code: 12345 });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);
  });

  it("returns 400 when Content-Type is not application/json", async () => {
    // Content-Type is checked after Turnstile verification — must mock Turnstile success
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, action: "jira-token" }), { status: 200 })
    );
    const req = makeJiraOAuthRequest("/api/oauth/jira/token", { code: "abc" }, { contentType: "text/plain" });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);
  });

  it("returns access_token, sealed_refresh_token, expires_in on success", async () => {
    // fetch called twice: once for Turnstile verification, once for Atlassian token exchange
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(
        // Turnstile verification
        new Response(JSON.stringify({ success: true, action: "jira-token" }), { status: 200 })
      )
      .mockResolvedValueOnce(
        // Atlassian token exchange
        new Response(JSON.stringify({
          access_token: "atlassian-access-token",
          refresh_token: "atlassian-refresh-token",
          expires_in: 3600,
        }), { status: 200 })
      );

    const req = makeJiraOAuthRequest("/api/oauth/jira/token", { code: "valid-jira-code" });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(200);

    const json = await res.json() as Record<string, unknown>;
    expect(json["access_token"]).toBe("atlassian-access-token");
    expect(typeof json["sealed_refresh_token"]).toBe("string");
    expect((json["sealed_refresh_token"] as string).length).toBeGreaterThan(0);
    expect(json["expires_in"]).toBe(3600);
    // Must not include plaintext refresh token
    expect(json["refresh_token"]).toBeUndefined();
  });

  it("sealed_refresh_token is not the plaintext refresh token", async () => {
    const plainRefreshToken = "plaintext-refresh-token-secret";
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, action: "jira-token" }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          access_token: "atl-access-tok",
          refresh_token: plainRefreshToken,
          expires_in: 3600,
        }), { status: 200 })
      );

    const req = makeJiraOAuthRequest("/api/oauth/jira/token", { code: "some-code" });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json["sealed_refresh_token"]).not.toBe(plainRefreshToken);
  });

  it("returns jira_token_exchange_failed when Atlassian response lacks access_token", async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, action: "jira-token" }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
      );

    const req = makeJiraOAuthRequest("/api/oauth/jira/token", { code: "bad-code" });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);
    const json = await res.json() as Record<string, unknown>;
    expect(json["error"]).toBe("jira_token_exchange_failed");
  });

  it("returns jira_token_exchange_failed when Atlassian fetch throws", async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, action: "jira-token" }), { status: 200 })
      )
      .mockRejectedValueOnce(new Error("network timeout"));

    const req = makeJiraOAuthRequest("/api/oauth/jira/token", { code: "any-code" });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);
    const json = await res.json() as Record<string, unknown>;
    expect(json["error"]).toBe("jira_token_exchange_failed");
  });

  it("returns 429 after exceeding rate limit from same IP", async () => {
    // First mock: Turnstile success for all requests; second mock: Atlassian success for non-rate-limited
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, access_token: "tok", refresh_token: "ref", expires_in: 3600 }), { status: 200 })
    );

    const fixedIp = "10.2.99.5";
    function makeFixedIpRequest() {
      return new Request("https://gh.gordoncode.dev/api/oauth/jira/token", {
        method: "POST",
        headers: {
          "CF-Connecting-IP": fixedIp,
          "Origin": ALLOWED_ORIGIN,
          "Content-Type": "application/json",
          "cf-turnstile-response": "valid-turnstile-token",
        },
        body: JSON.stringify({ code: "test-code" }),
      });
    }

    const env = makeEnv();
    // Exhaust 10-request limit
    for (let i = 0; i < 10; i++) {
      await worker.fetch(makeFixedIpRequest(), env);
    }
    const limited = await worker.fetch(makeFixedIpRequest(), env);
    expect(limited.status).toBe(429);
    const json = await limited.json() as Record<string, unknown>;
    expect(json["error"]).toBe("rate_limited");
  });

  it("CORS headers are set correctly on success", async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, action: "jira-token" }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          access_token: "tok",
          refresh_token: "ref",
          expires_in: 3600,
        }), { status: 200 })
      );

    const req = makeJiraOAuthRequest("/api/oauth/jira/token", { code: "valid-code" });
    const res = await worker.fetch(req, makeEnv());
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
    expect(res.headers.get("Access-Control-Allow-Methods")).toBe("POST");
  });

  it("CORS headers absent for wrong origin", async () => {
    globalThis.fetch = vi.fn();
    const req = makeJiraOAuthRequest("/api/oauth/jira/token", { code: "x" }, { origin: "https://evil.com" });
    const res = await worker.fetch(req, makeEnv());
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("OPTIONS /api/oauth/jira/token returns 204 with CORS headers", async () => {
    const req = new Request("https://gh.gordoncode.dev/api/oauth/jira/token", {
      method: "OPTIONS",
      headers: { "Origin": ALLOWED_ORIGIN, "CF-Connecting-IP": `10.2.0.${++_requestCounter}` },
    });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
  });

  it("logs do not contain plaintext codes or secrets", async () => {
    const sensitiveCode = "super-secret-jira-code-12345";
    const sensitiveSecret = "jira-test-client-secret";

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, action: "jira-token" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "atl-tok",
        refresh_token: "atl-ref-tok-secret",
        expires_in: 3600,
      }), { status: 200 }));

    const req = makeJiraOAuthRequest("/api/oauth/jira/token", { code: sensitiveCode });
    await worker.fetch(req, makeEnv());

    const logs = collectLogs(consoleSpy);
    const allLogText = logs.map((l) => JSON.stringify(l.entry)).join("\n");
    expect(allLogText).not.toContain(sensitiveCode);
    expect(allLogText).not.toContain(sensitiveSecret);
    expect(allLogText).not.toContain("atl-ref-tok-secret");
  });
});

// ── Jira Token Refresh (/api/oauth/jira/refresh) ──────────────────────────────

describe("POST /api/oauth/jira/refresh — Jira token refresh", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns 404 when JIRA_CLIENT_ID is not configured", async () => {
    const req = makeJiraOAuthRequest("/api/oauth/jira/refresh", { sealed_refresh_token: "any" });
    const res = await worker.fetch(req, makeEnv({ JIRA_CLIENT_ID: undefined }));
    expect(res.status).toBe(404);
    const json = await res.json() as Record<string, unknown>;
    expect(json["error"]).toBe("not_found");
  });

  it("returns 400 when sealed_refresh_token is missing", async () => {
    const req = makeJiraOAuthRequest("/api/oauth/jira/refresh", {});
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);
    const json = await res.json() as Record<string, unknown>;
    expect(json["error"]).toBe("invalid_request");
  });

  it("returns 400 when sealed_refresh_token is empty string", async () => {
    const req = makeJiraOAuthRequest("/api/oauth/jira/refresh", { sealed_refresh_token: "" });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);
  });

  it("returns 401 when sealed_refresh_token cannot be unsealed (corrupted blob)", async () => {
    const req = makeJiraOAuthRequest("/api/oauth/jira/refresh", { sealed_refresh_token: "not-a-real-sealed-blob" });
    const res = await worker.fetch(req, makeEnv());
    // Unseal returns null → 401
    expect(res.status).toBe(401);
    const json = await res.json() as Record<string, unknown>;
    expect(json["error"]).toBe("jira_refresh_failed");
  });

  it("returns new access_token and sealed_refresh_token on valid refresh", async () => {
    // First seal a real refresh token
    const sealed = await sealTestToken("real-refresh-token-value", "jira-refresh-token");

    // Now call the refresh endpoint with the sealed token
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        expires_in: 3600,
      }), { status: 200 })
    );

    const req = makeJiraOAuthRequest("/api/oauth/jira/refresh", { sealed_refresh_token: sealed });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(200);

    const json = await res.json() as Record<string, unknown>;
    expect(json["access_token"]).toBe("new-access-token");
    expect(typeof json["sealed_refresh_token"]).toBe("string");
    expect((json["sealed_refresh_token"] as string).length).toBeGreaterThan(0);
    expect(json["expires_in"]).toBe(3600);
    // Plaintext refresh token must not be returned
    expect(json["refresh_token"]).toBeUndefined();
  });

  it("returns jira_refresh_failed when Atlassian refresh call fails", async () => {
    const sealed = await sealTestToken("refresh-token", "jira-refresh-token");

    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
    );

    const req = makeJiraOAuthRequest("/api/oauth/jira/refresh", { sealed_refresh_token: sealed });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);
    const json = await res.json() as Record<string, unknown>;
    expect(json["error"]).toBe("jira_refresh_failed");
  });

  it("returns 429 after exceeding rate limit from same IP", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 })
    );

    const fixedIp = "10.2.99.6";
    function makeFixedIpRefreshRequest() {
      return new Request("https://gh.gordoncode.dev/api/oauth/jira/refresh", {
        method: "POST",
        headers: {
          "CF-Connecting-IP": fixedIp,
          "Origin": ALLOWED_ORIGIN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sealed_refresh_token: "dummy" }),
      });
    }

    const env = makeEnv();
    for (let i = 0; i < 30; i++) {
      await worker.fetch(makeFixedIpRefreshRequest(), env);
    }
    const limited = await worker.fetch(makeFixedIpRefreshRequest(), env);
    expect(limited.status).toBe(429);
    expect((await limited.json() as Record<string, unknown>)["error"]).toBe("rate_limited");
  });

  it("OPTIONS /api/oauth/jira/refresh returns 204 with CORS headers", async () => {
    const req = new Request("https://gh.gordoncode.dev/api/oauth/jira/refresh", {
      method: "OPTIONS",
      headers: { "Origin": ALLOWED_ORIGIN, "CF-Connecting-IP": `10.2.0.${++_requestCounter}` },
    });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
  });
});

// ── Jira Proxy (/api/jira/proxy) ──────────────────────────────────────────────

describe("POST /api/jira/proxy — Jira API proxy", () => {
  let originalFetch: typeof globalThis.fetch;
  let consoleSpy: {
    info: ReturnType<typeof vi.spyOn>;
    warn: ReturnType<typeof vi.spyOn>;
    error: ReturnType<typeof vi.spyOn>;
  };
  let sealedToken: string;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    consoleSpy = {
      info: vi.spyOn(console, "info").mockImplementation(() => {}),
      warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
      error: vi.spyOn(console, "error").mockImplementation(() => {}),
    };
    sealedToken = await sealTestToken(TEST_API_TOKEN, "jira-api-token");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ── 404 when unconfigured ─────────────────────────────────────────────────

  it("returns 404 when JIRA_CLIENT_ID is not configured", async () => {
    const req = makeJiraProxyRequest({
      endpoint: "search",
      cloudId: VALID_CLOUD_ID,
      email: TEST_EMAIL,
      sealed: sealedToken,
      params: { jql: "assignee = currentUser()", maxResults: 10 },
    });
    const res = await worker.fetch(req, makeEnv({ JIRA_CLIENT_ID: undefined }));
    expect(res.status).toBe(404);
    const json = await res.json() as Record<string, unknown>;
    expect(json["error"]).toBe("not_found");
  });

  // ── Endpoint allowlist ────────────────────────────────────────────────────

  it("allows endpoint=search", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ issues: [], total: 0, maxResults: 10, startAt: 0 }), { status: 200 })
    );

    const req = makeJiraProxyRequest({
      endpoint: "search",
      cloudId: VALID_CLOUD_ID,
      email: TEST_EMAIL,
      sealed: sealedToken,
      params: { jql: "assignee = currentUser()", maxResults: 10 },
    });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(200);
  });

  it("allows endpoint=issue", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ issues: [{ id: "1", key: "PROJ-1", self: "", fields: {} }] }), { status: 200 })
    );

    const req = makeJiraProxyRequest({
      endpoint: "issue",
      cloudId: VALID_CLOUD_ID,
      email: TEST_EMAIL,
      sealed: sealedToken,
      params: { issueIdsOrKeys: ["PROJ-1"], fields: ["summary"] },
    });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(200);
  });

  it("rejects endpoint=projects (not in allowlist)", async () => {
    globalThis.fetch = vi.fn();
    const req = makeJiraProxyRequest({
      endpoint: "projects",
      cloudId: VALID_CLOUD_ID,
      email: TEST_EMAIL,
      sealed: sealedToken,
      params: {},
    });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);
    const json = await res.json() as Record<string, unknown>;
    expect(json["error"]).toBe("invalid_request");
  });

  it("rejects endpoint=../../admin (path traversal attempt)", async () => {
    globalThis.fetch = vi.fn();
    const req = makeJiraProxyRequest({
      endpoint: "../../admin",
      cloudId: VALID_CLOUD_ID,
      email: TEST_EMAIL,
      sealed: sealedToken,
      params: {},
    });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);
  });

  // ── cloudId validation ────────────────────────────────────────────────────

  it("rejects non-UUID cloudId (plain string)", async () => {
    globalThis.fetch = vi.fn();
    const req = makeJiraProxyRequest({
      endpoint: "search",
      cloudId: "my-cloud-id",
      email: TEST_EMAIL,
      sealed: sealedToken,
      params: { jql: "assignee = me", maxResults: 10 },
    });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);
  });

  it("rejects cloudId with path traversal characters", async () => {
    globalThis.fetch = vi.fn();
    const req = makeJiraProxyRequest({
      endpoint: "search",
      cloudId: "../../admin",
      email: TEST_EMAIL,
      sealed: sealedToken,
      params: { jql: "assignee = me", maxResults: 10 },
    });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);
  });

  it("rejects all-dashes cloudId (permissive but incorrect format)", async () => {
    globalThis.fetch = vi.fn();
    const req = makeJiraProxyRequest({
      endpoint: "search",
      cloudId: "------------------------------------",
      email: TEST_EMAIL,
      sealed: sealedToken,
      params: { jql: "assignee = me", maxResults: 10 },
    });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);
  });

  it("accepts a valid UUID v4 cloudId", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ issues: [], total: 0, maxResults: 10, startAt: 0 }), { status: 200 })
    );

    const req = makeJiraProxyRequest({
      endpoint: "search",
      cloudId: VALID_CLOUD_ID,
      email: TEST_EMAIL,
      sealed: sealedToken,
      params: { jql: "assignee = currentUser()", maxResults: 10 },
    });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(200);
  });

  // ── Target URL construction ───────────────────────────────────────────────

  it("constructs correct target URL for search endpoint", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ issues: [], total: 0, maxResults: 10, startAt: 0 }), { status: 200 })
    );
    globalThis.fetch = mockFetch;

    const req = makeJiraProxyRequest({
      endpoint: "search",
      cloudId: VALID_CLOUD_ID,
      email: TEST_EMAIL,
      sealed: sealedToken,
      params: { jql: "project = TEST", maxResults: 10 },
    });
    await worker.fetch(req, makeEnv());

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`https://api.atlassian.com/ex/jira/${VALID_CLOUD_ID}/rest/api/3/search/jql`);
    expect(url).toContain("jql=project+%3D+TEST");
    expect((init.headers as Record<string, string>)["Authorization"]).toMatch(/^Basic /);
    expect(init.method).toBe("GET");
  });

  it("constructs correct target URL for issue endpoint", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ issues: [] }), { status: 200 })
    );
    globalThis.fetch = mockFetch;

    const req = makeJiraProxyRequest({
      endpoint: "issue",
      cloudId: VALID_CLOUD_ID,
      email: TEST_EMAIL,
      sealed: sealedToken,
      params: { issueIdsOrKeys: ["PROJ-1"], fields: ["summary"] },
    });
    await worker.fetch(req, makeEnv());

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.atlassian.com/ex/jira/${VALID_CLOUD_ID}/rest/api/3/issue/bulkfetch`);
    expect(init.method).toBe("POST");
  });

  // ── maxResults cap ────────────────────────────────────────────────────────

  it("rejects search request when maxResults exceeds 100", async () => {
    globalThis.fetch = vi.fn();
    const req = makeJiraProxyRequest({
      endpoint: "search",
      cloudId: VALID_CLOUD_ID,
      email: TEST_EMAIL,
      sealed: sealedToken,
      params: { jql: "assignee = me", maxResults: 200 },
    });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);
    const json = await res.json() as Record<string, unknown>;
    expect(json["error"]).toBe("invalid_request");
  });

  it("rejects search request when maxResults is absent", async () => {
    globalThis.fetch = vi.fn();
    const req = makeJiraProxyRequest({
      endpoint: "search",
      cloudId: VALID_CLOUD_ID,
      email: TEST_EMAIL,
      sealed: sealedToken,
      params: { jql: "assignee = me" },
    });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);
  });

  it("allows search request with maxResults=100", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ issues: [], total: 0, maxResults: 100, startAt: 0 }), { status: 200 })
    );
    const req = makeJiraProxyRequest({
      endpoint: "search",
      cloudId: VALID_CLOUD_ID,
      email: TEST_EMAIL,
      sealed: sealedToken,
      params: { jql: "assignee = currentUser()", maxResults: 100 },
    });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(200);
  });

  // ── Validation gates ──────────────────────────────────────────────────────

  it("returns 403 when X-Requested-With header is missing", async () => {
    globalThis.fetch = vi.fn();
    const req = makeJiraProxyRequest({
      endpoint: "search",
      cloudId: VALID_CLOUD_ID,
      email: TEST_EMAIL,
      sealed: sealedToken,
      params: { jql: "assignee = me", maxResults: 10 },
    }, { addXRequestedWith: false });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(403);
    const json = await res.json() as Record<string, unknown>;
    expect(json["error"]).toBe("missing_csrf_header");
  });

  it("returns 403 when Origin header is wrong", async () => {
    globalThis.fetch = vi.fn();
    const req = makeJiraProxyRequest({
      endpoint: "search",
      cloudId: VALID_CLOUD_ID,
      email: TEST_EMAIL,
      sealed: sealedToken,
      params: { jql: "assignee = me", maxResults: 10 },
    }, { origin: "https://evil.com" });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(403);
  });

  it("returns 401 when sealed token cannot be unsealed (wrong key or corrupted)", async () => {
    globalThis.fetch = vi.fn();
    const req = makeJiraProxyRequest({
      endpoint: "search",
      cloudId: VALID_CLOUD_ID,
      email: TEST_EMAIL,
      sealed: "corrupted-blob-cannot-unseal",
      params: { jql: "assignee = me", maxResults: 10 },
    });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(401);
    const json = await res.json() as Record<string, unknown>;
    expect(json["error"]).toBe("jira_proxy_error");
  });

  it("returns 429 when durable rate limiter denies", async () => {
    globalThis.fetch = vi.fn();
    const req = makeJiraProxyRequest({
      endpoint: "search",
      cloudId: VALID_CLOUD_ID,
      email: TEST_EMAIL,
      sealed: sealedToken,
      params: { jql: "assignee = me", maxResults: 10 },
    });
    const env = makeEnv({ PROXY_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: false }) } });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(429);
    const json = await res.json() as Record<string, unknown>;
    expect(json["error"]).toBe("rate_limited");
  });

  // ── SECURITY: console spy — no email or apiToken in logs ─────────────────

  it("does not log email or API token in any console output", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ issues: [], total: 0, maxResults: 10, startAt: 0 }), { status: 200 })
    );

    const req = makeJiraProxyRequest({
      endpoint: "search",
      cloudId: VALID_CLOUD_ID,
      email: TEST_EMAIL,
      sealed: sealedToken,
      params: { jql: "assignee = currentUser()", maxResults: 10 },
    });
    await worker.fetch(req, makeEnv());

    // Collect all console calls across all levels
    const allArgs: string[] = [];
    for (const spy of [consoleSpy.info, consoleSpy.warn, consoleSpy.error]) {
      for (const call of spy.mock.calls) {
        allArgs.push(...call.map((arg: unknown) => String(arg)));
      }
    }
    const allOutput = allArgs.join("\n");

    expect(allOutput).not.toContain(TEST_EMAIL);
    expect(allOutput).not.toContain(TEST_API_TOKEN);
  });

  it("does not log email or apiToken even on validation error paths", async () => {
    globalThis.fetch = vi.fn();

    // Trigger a validation error by using an invalid endpoint
    const req = makeJiraProxyRequest({
      endpoint: "evil-endpoint",
      cloudId: VALID_CLOUD_ID,
      email: TEST_EMAIL,
      sealed: sealedToken,
      params: {},
    });
    await worker.fetch(req, makeEnv());

    const allArgs: string[] = [];
    for (const spy of [consoleSpy.info, consoleSpy.warn, consoleSpy.error]) {
      for (const call of spy.mock.calls) {
        allArgs.push(...call.map((arg: unknown) => String(arg)));
      }
    }
    const allOutput = allArgs.join("\n");

    expect(allOutput).not.toContain(TEST_EMAIL);
    expect(allOutput).not.toContain(TEST_API_TOKEN);
  });

  // ── OPTIONS preflight ─────────────────────────────────────────────────────

  it("OPTIONS /api/jira/proxy with correct origin returns 204", async () => {
    const req = new Request("https://gh.gordoncode.dev/api/jira/proxy", {
      method: "OPTIONS",
      headers: {
        "Origin": ALLOWED_ORIGIN,
        "CF-Connecting-IP": `10.3.0.${++_requestCounter}`,
      },
    });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
  });
});

// ── Jira Accessible Resources (/api/oauth/jira/resources) ─────────────────────

describe("POST /api/oauth/jira/resources — accessible resources proxy", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns 404 when JIRA_CLIENT_ID is not configured", async () => {
    const resourceReq = new Request("https://gh.gordoncode.dev/api/oauth/jira/resources", {
      method: "POST",
      headers: {
        "CF-Connecting-IP": `10.3.0.${++_requestCounter}`,
        "Origin": ALLOWED_ORIGIN,
        "X-Requested-With": "fetch",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ accessToken: "tok" }),
    });
    const res = await worker.fetch(resourceReq, makeEnv({ JIRA_CLIENT_ID: undefined }));
    expect(res.status).toBe(404);
    expect((await res.json() as Record<string, unknown>)["error"]).toBe("not_found");
  });

  it("forwards Bearer token to accessible-resources endpoint and returns sites", async () => {
    const sites = [
      { id: "cloud-abc", name: "My Site", url: "https://mysite.atlassian.net", scopes: ["read:jira-work"] },
    ];
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify(sites), { status: 200 })
    );

    const resourceReq = new Request("https://gh.gordoncode.dev/api/oauth/jira/resources", {
      method: "POST",
      headers: {
        "CF-Connecting-IP": `10.3.0.${++_requestCounter}`,
        "Origin": ALLOWED_ORIGIN,
        "X-Requested-With": "fetch",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ accessToken: "my-bearer-token" }),
    });

    const res = await worker.fetch(resourceReq, makeEnv());
    expect(res.status).toBe(200);

    // Verify the outbound fetch used Bearer auth
    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>;
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.atlassian.com/oauth/token/accessible-resources");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer my-bearer-token");

    const json = await res.json();
    expect(json).toEqual(sites);
  });

  it("returns 400 when accessToken is missing", async () => {
    const resourceReq = new Request("https://gh.gordoncode.dev/api/oauth/jira/resources", {
      method: "POST",
      headers: {
        "CF-Connecting-IP": `10.3.0.${++_requestCounter}`,
        "Origin": ALLOWED_ORIGIN,
        "X-Requested-With": "fetch",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    const res = await worker.fetch(resourceReq, makeEnv());
    expect(res.status).toBe(400);
  });

  it("OPTIONS /api/oauth/jira/resources returns 204 with CORS headers", async () => {
    const req = new Request("https://gh.gordoncode.dev/api/oauth/jira/resources", {
      method: "OPTIONS",
      headers: { "Origin": ALLOWED_ORIGIN, "CF-Connecting-IP": `10.3.0.${++_requestCounter}` },
    });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
  });
});
