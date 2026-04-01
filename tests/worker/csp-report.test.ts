import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker, { type Env } from "../../src/worker/index";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ASSETS: { fetch: async () => new Response("asset") },
    GITHUB_CLIENT_ID: "test_client_id",
    GITHUB_CLIENT_SECRET: "test_client_secret",
    ALLOWED_ORIGIN: "https://gh.gordoncode.dev",
    SENTRY_DSN: "https://abc123@o123456.ingest.sentry.io/7890123",
    ...overrides,
  };
}

function makeCspRequest(
  body: string,
  contentType = "application/csp-report",
  method = "POST",
): Request {
  return new Request("https://gh.gordoncode.dev/api/csp-report", {
    method,
    headers: { "Content-Type": contentType },
    body: method !== "GET" ? body : undefined,
  });
}

describe("Worker CSP report endpoint", () => {
  let originalFetch: typeof globalThis.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    globalThis.fetch = mockFetch as typeof globalThis.fetch;
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("rejects non-POST requests", async () => {
    const req = new Request("https://gh.gordoncode.dev/api/csp-report", { method: "GET" });
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
});
