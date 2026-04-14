import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker, { type Env } from "../../src/worker/index";
import { collectLogs, findLog } from "./helpers";

const ALLOWED_ORIGIN = "https://gh.gordoncode.dev";
const SENTRY_HOST = "o123456.ingest.sentry.io";
const SENTRY_PROJECT_ID = "7890123";
const VALID_DSN = `https://abc123@${SENTRY_HOST}/${SENTRY_PROJECT_ID}`;

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

function makeEnvelope(dsn: string, eventPayload = "{}"): string {
  return `${JSON.stringify({ dsn })}\n${JSON.stringify({ type: "event" })}\n${eventPayload}`;
}

function makeTunnelRequest(body: string, options: { origin?: string | null; ip?: string } = {}): Request {
  const ip = options.ip ?? `10.2.0.${++_requestCounter}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/x-sentry-envelope",
    "CF-Connecting-IP": ip,
  };
  if (options.origin !== null) {
    headers["Origin"] = options.origin ?? ALLOWED_ORIGIN;
  }
  return new Request("https://gh.gordoncode.dev/api/error-reporting", {
    method: "POST",
    headers,
    body,
  });
}

describe("Sentry tunnel (/api/error-reporting)", () => {
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

  // ── Missing CF-Connecting-IP ───────────────────────────────────────────────

  it("rejects requests without CF-Connecting-IP with 400", async () => {
    const req = new Request("https://gh.gordoncode.dev/api/error-reporting", {
      method: "POST",
      headers: { "Content-Type": "application/x-sentry-envelope", "Origin": ALLOWED_ORIGIN },
      body: makeEnvelope(VALID_DSN),
    });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);
  });

  // ── Migrated tests from oauth.test.ts ─────────────────────────────────────

  it("forwards valid envelope to Sentry and returns Sentry's status code", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    globalThis.fetch = mockFetch;

    const req = makeTunnelRequest(makeEnvelope(VALID_DSN));
    const res = await worker.fetch(req, makeEnv());

    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledOnce();

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://${SENTRY_HOST}/api/${SENTRY_PROJECT_ID}/envelope/`);
    expect(init.method).toBe("POST");
  });

  it("rejects GET requests with 405", async () => {
    const req = new Request("https://gh.gordoncode.dev/api/error-reporting", {
      method: "GET",
      headers: { "CF-Connecting-IP": `10.2.0.${++_requestCounter}` },
    });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(405);
  });

  it("rejects envelopes with mismatched DSN host", async () => {
    const badDsn = `https://abc@evil.ingest.sentry.io/${SENTRY_PROJECT_ID}`;
    const req = makeTunnelRequest(makeEnvelope(badDsn));
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(403);

    const logs = collectLogs(consoleSpy);
    const mismatchLog = findLog(logs, "sentry_tunnel_dsn_mismatch");
    expect(mismatchLog).toBeDefined();
    expect(mismatchLog!.entry.dsn_host).toBe("evil.ingest.sentry.io");
  });

  it("rejects envelopes with mismatched DSN project ID", async () => {
    const badDsn = `https://abc@${SENTRY_HOST}/9999999`;
    const req = makeTunnelRequest(makeEnvelope(badDsn));
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(403);

    const logs = collectLogs(consoleSpy);
    const mismatchLog = findLog(logs, "sentry_tunnel_dsn_mismatch");
    expect(mismatchLog).toBeDefined();
    expect(mismatchLog!.entry.dsn_project).toBe("9999999");
  });

  it("returns 400 for invalid envelope format (no newline)", async () => {
    const req = makeTunnelRequest("not an envelope");
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);

    const logs = collectLogs(consoleSpy);
    const log = findLog(logs, "sentry_tunnel_invalid_envelope");
    expect(log).toBeDefined();
    expect(log!.level).toBe("warn");
  });

  it("returns 400 for invalid JSON in envelope header", async () => {
    const req = makeTunnelRequest("{invalid json\n{}");
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);

    const logs = collectLogs(consoleSpy);
    const log = findLog(logs, "sentry_tunnel_header_parse_failed");
    expect(log).toBeDefined();
    expect(log!.level).toBe("warn");
  });

  it("returns 200 for client_report envelopes without DSN", async () => {
    const envelope = `${JSON.stringify({ type: "client_report" })}\n{}`;
    const req = makeTunnelRequest(envelope);
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(200);

    const logs = collectLogs(consoleSpy);
    const log = findLog(logs, "sentry_tunnel_no_dsn");
    expect(log).toBeDefined();
    expect(log!.level).toBe("info");
  });

  it("returns 400 for invalid DSN URL", async () => {
    const envelope = `${JSON.stringify({ dsn: "not-a-url" })}\n{}`;
    const req = makeTunnelRequest(envelope);
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(400);

    const logs = collectLogs(consoleSpy);
    const log = findLog(logs, "sentry_tunnel_invalid_dsn");
    expect(log).toBeDefined();
    expect(log!.level).toBe("warn");
  });

  it("returns 404 when SENTRY_DSN is empty string", async () => {
    const req = makeTunnelRequest(makeEnvelope(VALID_DSN));
    const res = await worker.fetch(req, makeEnv({ SENTRY_DSN: "" }));
    expect(res.status).toBe(404);
  });

  it("returns 404 when SENTRY_DSN is undefined", async () => {
    const req = makeTunnelRequest(makeEnvelope(VALID_DSN));
    const res = await worker.fetch(req, makeEnv({ SENTRY_DSN: undefined as unknown as string }));
    expect(res.status).toBe(404);
  });

  it("returns 502 when Sentry is unreachable", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("connection refused"));

    const req = makeTunnelRequest(makeEnvelope(VALID_DSN));
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(502);

    const logs = collectLogs(consoleSpy);
    const fetchLog = findLog(logs, "sentry_tunnel_fetch_failed");
    expect(fetchLog).toBeDefined();
    expect(fetchLog!.level).toBe("error");
  });

  it("logs sentry_tunnel_forwarded on successful proxy", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    const req = makeTunnelRequest(makeEnvelope(VALID_DSN));
    await worker.fetch(req, makeEnv());

    const logs = collectLogs(consoleSpy);
    const fwdLog = findLog(logs, "sentry_tunnel_forwarded");
    expect(fwdLog).toBeDefined();
    expect(fwdLog!.level).toBe("info");
    expect(fwdLog!.entry.sentry_status).toBe(200);
  });

  it("includes security headers on all tunnel responses", async () => {
    const req = new Request("https://gh.gordoncode.dev/api/error-reporting", {
      method: "GET",
      headers: { "CF-Connecting-IP": `10.2.0.${++_requestCounter}` },
    });
    const res = await worker.fetch(req, makeEnv());
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("never logs the envelope body contents", async () => {
    const sensitivePayload = '{"user":{"email":"user@example.com"}}';
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    const req = makeTunnelRequest(makeEnvelope(VALID_DSN, sensitivePayload));
    await worker.fetch(req, makeEnv());

    const logs = collectLogs(consoleSpy);
    const allLogText = logs.map((l) => JSON.stringify(l.entry)).join("\n");
    expect(allLogText).not.toContain("user@example.com");
    expect(allLogText).not.toContain(sensitivePayload);
  });

  it("rejects OPTIONS with 405", async () => {
    const req = new Request("https://gh.gordoncode.dev/api/error-reporting", {
      method: "OPTIONS",
      headers: { "CF-Connecting-IP": `10.2.0.${++_requestCounter}` },
    });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(405);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("returns 413 when body exceeds size limit", async () => {
    const oversizedBody = "x".repeat(256 * 1024 + 1);
    const req = makeTunnelRequest(oversizedBody);
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(413);

    const logs = collectLogs(consoleSpy);
    const sizeLog = findLog(logs, "sentry_tunnel_payload_too_large");
    expect(sizeLog).toBeDefined();
    expect(sizeLog!.level).toBe("warn");
    expect(sizeLog!.entry.body_length).toBe(256 * 1024 + 1);
  });

  it("allows body at exactly the size limit", async () => {
    // Build a valid envelope that is exactly at the limit
    const header = JSON.stringify({ dsn: VALID_DSN });
    const padding = "x".repeat(256 * 1024 - header.length - 1); // -1 for newline
    const body = `${header}\n${padding}`;
    expect(body.length).toBe(256 * 1024);

    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const req = makeTunnelRequest(body);
    const res = await worker.fetch(req, makeEnv());
    // Should not be 413 — the body is within limits
    expect(res.status).not.toBe(413);
  });

  // ── New guard tests ───────────────────────────────────────────────────────

  it("rejects requests with wrong Origin with 403 and logs both warnings", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

    const req = makeTunnelRequest(makeEnvelope(VALID_DSN), { origin: "https://evil.example.com" });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(403);

    const logs = collectLogs(consoleSpy);
    // cors_origin_mismatch fires at top-level routing (before handler dispatch)
    const corsLog = findLog(logs, "cors_origin_mismatch");
    expect(corsLog).toBeDefined();
    expect(corsLog!.level).toBe("warn");
    expect(corsLog!.entry.request_origin).toBe("https://evil.example.com");
    // sentry_tunnel_origin_rejected fires at handler level
    const originLog = findLog(logs, "sentry_tunnel_origin_rejected");
    expect(originLog).toBeDefined();
    expect(originLog!.level).toBe("warn");
    expect(originLog!.entry.origin).toBe("https://evil.example.com");
  });

  it("rejects requests with missing Origin with 403 (strict — SPA always sends it)", async () => {
    const req = makeTunnelRequest(makeEnvelope(VALID_DSN), { origin: null });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(403);

    const logs = collectLogs(consoleSpy);
    const originLog = findLog(logs, "sentry_tunnel_origin_rejected");
    expect(originLog).toBeDefined();
  });

  it("rejects requests with Origin: null (string literal from sandboxed iframes) with 403", async () => {
    const req = makeTunnelRequest(makeEnvelope(VALID_DSN), { origin: "null" });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(403);
  });

  it("allows requests with correct Origin", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const req = makeTunnelRequest(makeEnvelope(VALID_DSN), { origin: ALLOWED_ORIGIN });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(200);
  });

  it("rate limits after 15 requests from same IP", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const fixedIp = "10.2.99.1";
    const env = makeEnv();
    for (let i = 0; i < 15; i++) {
      const req = makeTunnelRequest(makeEnvelope(VALID_DSN), { ip: fixedIp });
      const res = await worker.fetch(req, env);
      expect(res.status).not.toBe(429);
    }
    const req = makeTunnelRequest(makeEnvelope(VALID_DSN), { ip: fixedIp });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
  });

  it("rate limits are per-IP — different IPs have independent counters", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const env = makeEnv();
    const fixedIp = "10.2.99.2";
    // Exhaust the limit for fixedIp
    for (let i = 0; i < 15; i++) {
      await worker.fetch(makeTunnelRequest(makeEnvelope(VALID_DSN), { ip: fixedIp }), env);
    }
    const limited = await worker.fetch(makeTunnelRequest(makeEnvelope(VALID_DSN), { ip: fixedIp }), env);
    expect(limited.status).toBe(429);

    // Different IP should still succeed
    const otherIp = "10.2.99.3";
    const otherRes = await worker.fetch(makeTunnelRequest(makeEnvelope(VALID_DSN), { ip: otherIp }), env);
    expect(otherRes.status).toBe(200);
  });

  it("Sentry rate limiter is independent of CSP rate limiter", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const env = makeEnv();
    const sharedIp = "10.99.0.1";
    // Exhaust Sentry rate limiter for sharedIp
    for (let i = 0; i < 15; i++) {
      await worker.fetch(makeTunnelRequest(makeEnvelope(VALID_DSN), { ip: sharedIp }), env);
    }
    const sentryLimited = await worker.fetch(makeTunnelRequest(makeEnvelope(VALID_DSN), { ip: sharedIp }), env);
    expect(sentryLimited.status).toBe(429);

    // CSP request from same IP should NOT be rate limited by Sentry's limiter
    const cspReq = new Request("https://gh.gordoncode.dev/api/csp-report", {
      method: "POST",
      headers: {
        "Content-Type": "application/csp-report",
        "CF-Connecting-IP": sharedIp,
      },
      body: JSON.stringify({ "csp-report": { "document-uri": "https://gh.gordoncode.dev/", "violated-directive": "script-src" } }),
    });
    const cspRes = await worker.fetch(cspReq, env);
    // Should not be 429 due to Sentry rate limit (may be other status, just not sentry-rate-limited)
    expect(cspRes.status).not.toBe(429);
  });

  it("rejects Content-Length exceeding 256KB with 413 before reading body", async () => {
    const req = new Request("https://gh.gordoncode.dev/api/error-reporting", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-sentry-envelope",
        "CF-Connecting-IP": `10.2.0.${++_requestCounter}`,
        "Origin": ALLOWED_ORIGIN,
        "Content-Length": String(256 * 1024 + 1),
      },
      body: "x",
    });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(413);

    const logs = collectLogs(consoleSpy);
    const log = findLog(logs, "sentry_tunnel_content_length_exceeded");
    expect(log).toBeDefined();
    expect(log!.level).toBe("warn");
  });

  it("allows requests without Content-Length header (chunked transfer)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const req = makeTunnelRequest(makeEnvelope(VALID_DSN));
    // makeTunnelRequest does not set Content-Length
    expect(req.headers.get("Content-Length")).toBeNull();
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(200);
  });

  // TCG-001: Content-Length edge cases — non-numeric and negative values pass through
  it("allows requests with non-numeric Content-Length (passes through to post-read check)", async () => {
    // "100abc" → Number("100abc") = NaN, !Number.isInteger(NaN) is true → checkContentLength returns true
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const req = new Request("https://gh.gordoncode.dev/api/error-reporting", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-sentry-envelope",
        "CF-Connecting-IP": `10.2.0.${++_requestCounter}`,
        "Origin": ALLOWED_ORIGIN,
        "Content-Length": "100abc",
      },
      body: makeEnvelope(VALID_DSN),
    });
    const res = await worker.fetch(req, makeEnv());
    // Must not be rejected by the Content-Length pre-check (413) — post-read check is authoritative
    expect(res.status).not.toBe(413);
  });

  it("allows requests with negative Content-Length (passes through to post-read check)", async () => {
    // "-1" → Number("-1") = -1, parsed < 0 is true → checkContentLength returns true
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const req = new Request("https://gh.gordoncode.dev/api/error-reporting", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-sentry-envelope",
        "CF-Connecting-IP": `10.2.0.${++_requestCounter}`,
        "Origin": ALLOWED_ORIGIN,
        "Content-Length": "-1",
      },
      body: makeEnvelope(VALID_DSN),
    });
    const res = await worker.fetch(req, makeEnv());
    // Must not be rejected by the Content-Length pre-check (413) — post-read check is authoritative
    expect(res.status).not.toBe(413);
  });

  // CR-006: Missing-Origin takes a different code path — cors_origin_mismatch should NOT fire
  it("rejects requests with missing Origin: logs sentry_tunnel_origin_rejected but NOT cors_origin_mismatch", async () => {
    const req = makeTunnelRequest(makeEnvelope(VALID_DSN), { origin: null });
    const res = await worker.fetch(req, makeEnv());
    expect(res.status).toBe(403);

    const logs = collectLogs(consoleSpy);
    // Handler-level rejection must be logged
    const originLog = findLog(logs, "sentry_tunnel_origin_rejected");
    expect(originLog).toBeDefined();
    // Top-level CORS check only fires when origin is non-null and doesn't match —
    // absent Origin skips it, so cors_origin_mismatch must NOT appear here
    const corsLog = findLog(logs, "cors_origin_mismatch");
    expect(corsLog).toBeUndefined();
  });
});
