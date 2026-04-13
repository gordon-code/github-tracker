import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker, { type Env } from "../../src/worker/index";
import { collectLogs, findLog } from "./helpers";

const ALLOWED_ORIGIN = "https://gh.gordoncode.dev";

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

function makeCspRequest(
  body: string,
  contentType = "application/csp-report",
  method = "POST",
  options: { origin?: string | null } = {},
): Request {
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    // Unique IP per request to avoid hitting the in-memory rate limiter across tests
    "CF-Connecting-IP": `10.3.0.${++_requestCounter}`,
  };
  if (options.origin !== undefined && options.origin !== null) {
    headers["Origin"] = options.origin;
  }
  return new Request("https://gh.gordoncode.dev/api/csp-report", {
    method,
    headers,
    body: method !== "GET" ? body : undefined,
  });
}

describe("Worker CSP report endpoint", () => {
  let originalFetch: typeof globalThis.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;
  let consoleSpy: {
    info: ReturnType<typeof vi.spyOn>;
    warn: ReturnType<typeof vi.spyOn>;
    error: ReturnType<typeof vi.spyOn>;
  };

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    globalThis.fetch = mockFetch as typeof globalThis.fetch;
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

  it("rejects non-POST requests", async () => {
    const req = new Request("https://gh.gordoncode.dev/api/csp-report", {
      method: "GET",
      headers: { "CF-Connecting-IP": `10.3.0.${++_requestCounter}` },
    });
    const resp = await worker.fetch(req, makeEnv());
    expect(resp.status).toBe(405);
  });

  it("scrubs OAuth params from document-uri in legacy format", async () => {
    const body = JSON.stringify({
      "csp-report": {
        "document-uri": "https://gh.gordoncode.dev/oauth/callback?code=abc123&state=xyz789",
        "blocked-uri": "https://evil.com/script.js",
        "violated-directive": "script-src",
      },
    });
    const req = makeCspRequest(body);
    const resp = await worker.fetch(req, makeEnv());

    expect(resp.status).toBe(204);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const sentryBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(sentryBody["csp-report"]["document-uri"]).toBe(
      "https://gh.gordoncode.dev/oauth/callback?code=[REDACTED]&state=[REDACTED]",
    );
    expect(sentryBody["csp-report"]["blocked-uri"]).toBe("https://evil.com/script.js");
  });

  it("scrubs access_token from source-file", async () => {
    const body = JSON.stringify({
      "csp-report": {
        "document-uri": "https://gh.gordoncode.dev/dashboard",
        "source-file": "https://gh.gordoncode.dev/app.js?access_token=ghu_secret",
        "violated-directive": "script-src",
      },
    });
    const req = makeCspRequest(body);
    await worker.fetch(req, makeEnv());

    const sentryBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(sentryBody["csp-report"]["source-file"]).toBe(
      "https://gh.gordoncode.dev/app.js?access_token=[REDACTED]",
    );
  });

  it("handles report-to format (application/reports+json)", async () => {
    const body = JSON.stringify([
      {
        type: "csp-violation",
        body: {
          documentURL: "https://gh.gordoncode.dev/oauth/callback?code=secret&state=val",
          blockedURL: "inline",
          disposition: "enforce",
        },
      },
    ]);
    const req = makeCspRequest(body, "application/reports+json");
    const resp = await worker.fetch(req, makeEnv());

    expect(resp.status).toBe(204);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const sentryBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    // report-to body is normalized to legacy csp-report format for Sentry
    expect(sentryBody["csp-report"]["documentURL"]).toBe(
      "https://gh.gordoncode.dev/oauth/callback?code=[REDACTED]&state=[REDACTED]",
    );
  });

  it("scrubs blockedURL and sourceFile in report-to format", async () => {
    const body = JSON.stringify([
      {
        type: "csp-violation",
        body: {
          documentURL: "https://gh.gordoncode.dev/dashboard",
          blockedURL: "https://cdn.example.com/script.js?state=leaked",
          sourceFile: "https://gh.gordoncode.dev/app.js?code=abc123&other=safe",
        },
      },
    ]);
    const req = makeCspRequest(body, "application/reports+json");
    await worker.fetch(req, makeEnv());

    const sentryBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(sentryBody["csp-report"]["blockedURL"]).toBe(
      "https://cdn.example.com/script.js?state=[REDACTED]",
    );
    expect(sentryBody["csp-report"]["sourceFile"]).toBe(
      "https://gh.gordoncode.dev/app.js?code=[REDACTED]&other=safe",
    );
  });

  it("forwards multiple CSP violations from one report-to batch", async () => {
    const body = JSON.stringify([
      {
        type: "csp-violation",
        body: { documentURL: "https://gh.gordoncode.dev/a", blockedURL: "inline" },
      },
      {
        type: "csp-violation",
        body: { documentURL: "https://gh.gordoncode.dev/b", blockedURL: "eval" },
      },
    ]);
    const req = makeCspRequest(body, "application/reports+json");
    await worker.fetch(req, makeEnv());

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const body1 = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    const body2 = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    expect(body1["csp-report"]["documentURL"]).toBe("https://gh.gordoncode.dev/a");
    expect(body2["csp-report"]["documentURL"]).toBe("https://gh.gordoncode.dev/b");
  });

  it("drops non-CSP report types from report-to batch", async () => {
    const body = JSON.stringify([
      { type: "deprecation", body: { message: "old API" } },
      {
        type: "csp-violation",
        body: {
          documentURL: "https://gh.gordoncode.dev/dashboard",
          blockedURL: "inline",
        },
      },
    ]);
    const req = makeCspRequest(body, "application/reports+json");
    const resp = await worker.fetch(req, makeEnv());

    expect(resp.status).toBe(204);
    // Only the CSP violation should be forwarded
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("forwards to correct Sentry security endpoint with sentry_key", async () => {
    const body = JSON.stringify({
      "csp-report": {
        "document-uri": "https://gh.gordoncode.dev/dashboard",
        "violated-directive": "script-src",
      },
    });
    const req = makeCspRequest(body);
    await worker.fetch(req, makeEnv());

    const sentryUrl = mockFetch.mock.calls[0][0] as string;
    expect(sentryUrl).toBe(
      "https://o123456.ingest.sentry.io/api/7890123/security/?sentry_key=abc123",
    );
    expect(mockFetch.mock.calls[0][1].headers["Content-Type"]).toBe("application/csp-report");
  });

  it("returns 400 for invalid JSON", async () => {
    const req = makeCspRequest("not json {{{");
    const resp = await worker.fetch(req, makeEnv());
    expect(resp.status).toBe(400);
  });

  it("returns 413 for oversized payload", async () => {
    const body = "x".repeat(65 * 1024);
    const req = makeCspRequest(body);
    const resp = await worker.fetch(req, makeEnv());
    expect(resp.status).toBe(413);
  });

  it("returns 204 for empty csp-report body", async () => {
    const body = JSON.stringify({ "not-csp": {} });
    const req = makeCspRequest(body);
    const resp = await worker.fetch(req, makeEnv());
    expect(resp.status).toBe(204);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns 404 when SENTRY_DSN is empty", async () => {
    const body = JSON.stringify({
      "csp-report": {
        "document-uri": "https://gh.gordoncode.dev/dashboard",
        "violated-directive": "script-src",
      },
    });
    const req = makeCspRequest(body);
    const resp = await worker.fetch(req, makeEnv({ SENTRY_DSN: "" }));
    expect(resp.status).toBe(404);
  });

  it("handles Sentry fetch failure gracefully", async () => {
    mockFetch.mockRejectedValue(new Error("network error"));
    const body = JSON.stringify({
      "csp-report": {
        "document-uri": "https://gh.gordoncode.dev/dashboard",
        "violated-directive": "script-src",
      },
    });
    const req = makeCspRequest(body);
    const resp = await worker.fetch(req, makeEnv());
    // Should still return 204, not crash
    expect(resp.status).toBe(204);
  });

  it("scrubs referrer field containing OAuth params", async () => {
    const body = JSON.stringify({
      "csp-report": {
        "document-uri": "https://gh.gordoncode.dev/dashboard",
        "referrer": "https://gh.gordoncode.dev/oauth/callback?code=secret123&state=xyz",
        "violated-directive": "script-src",
      },
    });
    const req = makeCspRequest(body);
    await worker.fetch(req, makeEnv());

    const sentryBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(sentryBody["csp-report"]["referrer"]).toBe(
      "https://gh.gordoncode.dev/oauth/callback?code=[REDACTED]&state=[REDACTED]",
    );
  });

  it("scrubs referrer in report-to format", async () => {
    const body = JSON.stringify([
      {
        type: "csp-violation",
        body: {
          documentURL: "https://gh.gordoncode.dev/dashboard",
          referrer: "https://gh.gordoncode.dev/oauth/callback?code=secret&state=xyz",
          blockedURL: "inline",
        },
      },
    ]);
    const req = makeCspRequest(body, "application/reports+json");
    await worker.fetch(req, makeEnv());

    const sentryBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(sentryBody["csp-report"]["referrer"]).toBe(
      "https://gh.gordoncode.dev/oauth/callback?code=[REDACTED]&state=[REDACTED]",
    );
  });

  it("caps batch fan-out to 20 reports", async () => {
    const violations = Array.from({ length: 25 }, (_, i) => ({
      type: "csp-violation",
      body: { documentURL: `https://gh.gordoncode.dev/page${i}`, blockedURL: "inline" },
    }));
    const req = makeCspRequest(JSON.stringify(violations), "application/reports+json");
    await worker.fetch(req, makeEnv());

    expect(mockFetch).toHaveBeenCalledTimes(20);
  });

  it("preserves non-sensitive fields unchanged", async () => {
    const body = JSON.stringify({
      "csp-report": {
        "document-uri": "https://gh.gordoncode.dev/dashboard?tab=issues",
        "blocked-uri": "https://cdn.example.com/font.woff2",
        "violated-directive": "font-src 'self'",
        "original-policy": "font-src 'self'",
        "referrer": "",
        "status-code": 200,
      },
    });
    const req = makeCspRequest(body);
    await worker.fetch(req, makeEnv());

    const sentryBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    const report = sentryBody["csp-report"];
    expect(report["document-uri"]).toBe("https://gh.gordoncode.dev/dashboard?tab=issues");
    expect(report["violated-directive"]).toBe("font-src 'self'");
    expect(report["original-policy"]).toBe("font-src 'self'");
    expect(report["status-code"]).toBe(200);
  });

  // ── Soft origin check ─────────────────────────────────────────────────────

  it("rejects requests with wrong Origin with 403", async () => {
    const body = JSON.stringify({ "csp-report": { "document-uri": "https://gh.gordoncode.dev/", "violated-directive": "script-src" } });
    const req = makeCspRequest(body, "application/csp-report", "POST", { origin: "https://evil.example.com" });
    const resp = await worker.fetch(req, makeEnv());
    expect(resp.status).toBe(403);
  });

  it("allows requests with missing Origin (soft check — browser CSP reports may lack it)", async () => {
    const body = JSON.stringify({ "csp-report": { "document-uri": "https://gh.gordoncode.dev/", "violated-directive": "script-src" } });
    // No origin option means no Origin header in makeCspRequest
    const req = makeCspRequest(body, "application/csp-report", "POST");
    const resp = await worker.fetch(req, makeEnv());
    expect(resp.status).toBe(204);
  });

  it("rejects requests with Origin: null (string literal from sandboxed iframes) with 403", async () => {
    const body = JSON.stringify({ "csp-report": { "document-uri": "https://gh.gordoncode.dev/", "violated-directive": "script-src" } });
    const req = makeCspRequest(body, "application/csp-report", "POST", { origin: "null" });
    const resp = await worker.fetch(req, makeEnv());
    expect(resp.status).toBe(403);
  });

  it("allows requests with correct Origin", async () => {
    const body = JSON.stringify({ "csp-report": { "document-uri": "https://gh.gordoncode.dev/", "violated-directive": "script-src" } });
    const req = makeCspRequest(body, "application/csp-report", "POST", { origin: ALLOWED_ORIGIN });
    const resp = await worker.fetch(req, makeEnv());
    expect(resp.status).toBe(204);
  });

  // ── Rate limiting ─────────────────────────────────────────────────────────

  it("rate limits after 15 requests from same IP", async () => {
    const env = makeEnv();
    const fixedIp = "10.3.99.1";
    const body = JSON.stringify({ "csp-report": { "document-uri": "https://gh.gordoncode.dev/", "violated-directive": "script-src" } });
    for (let i = 0; i < 15; i++) {
      const req = new Request("https://gh.gordoncode.dev/api/csp-report", {
        method: "POST",
        headers: { "Content-Type": "application/csp-report", "CF-Connecting-IP": fixedIp },
        body,
      });
      const resp = await worker.fetch(req, env);
      expect(resp.status).not.toBe(429);
    }
    const req = new Request("https://gh.gordoncode.dev/api/csp-report", {
      method: "POST",
      headers: { "Content-Type": "application/csp-report", "CF-Connecting-IP": fixedIp },
      body,
    });
    const resp = await worker.fetch(req, env);
    expect(resp.status).toBe(429);
    expect(resp.headers.get("Retry-After")).toBe("60");
  });

  it("rate limits are per-IP — different IPs have independent counters", async () => {
    const env = makeEnv();
    const fixedIp = "10.3.99.2";
    const body = JSON.stringify({ "csp-report": { "document-uri": "https://gh.gordoncode.dev/", "violated-directive": "script-src" } });
    // Exhaust limit for fixedIp
    for (let i = 0; i < 15; i++) {
      await worker.fetch(new Request("https://gh.gordoncode.dev/api/csp-report", {
        method: "POST",
        headers: { "Content-Type": "application/csp-report", "CF-Connecting-IP": fixedIp },
        body,
      }), env);
    }
    const limited = await worker.fetch(new Request("https://gh.gordoncode.dev/api/csp-report", {
      method: "POST",
      headers: { "Content-Type": "application/csp-report", "CF-Connecting-IP": fixedIp },
      body,
    }), env);
    expect(limited.status).toBe(429);

    // Different IP should still succeed
    const otherResp = await worker.fetch(new Request("https://gh.gordoncode.dev/api/csp-report", {
      method: "POST",
      headers: { "Content-Type": "application/csp-report", "CF-Connecting-IP": "10.3.99.3" },
      body,
    }), env);
    expect(otherResp.status).toBe(204);
  });

  // ── Content-Length pre-check ──────────────────────────────────────────────

  it("rejects Content-Length exceeding 64KB with 413 and logs csp_report_content_length_exceeded", async () => {
    const req = new Request("https://gh.gordoncode.dev/api/csp-report", {
      method: "POST",
      headers: {
        "Content-Type": "application/csp-report",
        "CF-Connecting-IP": `10.3.0.${++_requestCounter}`,
        "Content-Length": String(64 * 1024 + 1),
      },
      body: "x",
    });
    const resp = await worker.fetch(req, makeEnv());
    expect(resp.status).toBe(413);

    // TCG-002: verify the structured log event fires
    const logs = collectLogs(consoleSpy);
    const sizeLog = findLog(logs, "csp_report_content_length_exceeded");
    expect(sizeLog).toBeDefined();
  });

  it("allows requests without Content-Length header", async () => {
    const body = JSON.stringify({ "csp-report": { "document-uri": "https://gh.gordoncode.dev/", "violated-directive": "script-src" } });
    const req = makeCspRequest(body);
    expect(req.headers.get("Content-Length")).toBeNull();
    const resp = await worker.fetch(req, makeEnv());
    expect(resp.status).toBe(204);
  });
});
