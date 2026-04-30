import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { verifyTurnstile, extractTurnstileToken } from "../../src/worker/turnstile";

const TEST_ENV = { TURNSTILE_SECRET_KEY: "test-turnstile-secret" };
const TEST_TOKEN = "test-turnstile-token";
const TEST_IP = "1.2.3.4";

// Mock global fetch for each test
const mockFetch = vi.fn();
const originalFetch = globalThis.fetch;

// Mock crypto.randomUUID for idempotency key tests
const mockRandomUUID = vi.fn().mockReturnValue("test-uuid-1234-5678-abcd-ef0123456789");

beforeEach(() => {
  globalThis.fetch = mockFetch;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (crypto as any).randomUUID = mockRandomUUID;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
});

// ── verifyTurnstile ─────────────────────────────────────────────────────────

describe("verifyTurnstile", () => {
  it("returns success: true on successful verification (no action binding)", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const result = await verifyTurnstile(TEST_TOKEN, TEST_IP, TEST_ENV);
    expect(result).toEqual({ success: true });
  });

  it("returns success: true when expectedAction matches response action", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, action: "seal" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const result = await verifyTurnstile(TEST_TOKEN, TEST_IP, TEST_ENV, "seal");
    expect(result).toEqual({ success: true });
  });

  it("returns action-mismatch when expectedAction does not match response action", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, action: "other-action" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const result = await verifyTurnstile(TEST_TOKEN, TEST_IP, TEST_ENV, "seal");
    expect(result).toEqual({ success: false, errorCodes: ["action-mismatch"] });
  });

  it("succeeds when expectedAction is provided but response action is missing (test keys)", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const result = await verifyTurnstile(TEST_TOKEN, TEST_IP, TEST_ENV, "seal");
    expect(result).toEqual({ success: true });
  });

  it("returns action-mismatch when expectedAction differs from response action", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, action: "wrong-action" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const result = await verifyTurnstile(TEST_TOKEN, TEST_IP, TEST_ENV, "seal");
    expect(result).toEqual({ success: false, errorCodes: ["action-mismatch"] });
  });

  it("does not validate action when expectedAction is omitted", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, action: "anything" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const result = await verifyTurnstile(TEST_TOKEN, TEST_IP, TEST_ENV);
    expect(result).toEqual({ success: true });
  });

  it("returns success: false with errorCodes on failed verification", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: false,
          "error-codes": ["timeout-or-duplicate"],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await verifyTurnstile(TEST_TOKEN, TEST_IP, TEST_ENV);
    expect(result).toEqual({
      success: false,
      errorCodes: ["timeout-or-duplicate"],
    });
  });

  it("returns network-error when fetch throws", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network connection refused"));

    const result = await verifyTurnstile(TEST_TOKEN, TEST_IP, TEST_ENV);
    expect(result).toEqual({ success: false, errorCodes: ["network-error"] });
  });

  it("returns timeout errorCode when fetch is aborted (AbortError)", async () => {
    const abortError = Object.assign(new Error("Aborted"), { name: "AbortError" });
    mockFetch.mockRejectedValueOnce(abortError);

    const result = await verifyTurnstile(TEST_TOKEN, TEST_IP, TEST_ENV);
    expect(result).toEqual({ success: false, errorCodes: ["timeout"] });
  });

  it("returns network-error when response body is not valid JSON", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response("not-json", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      })
    );

    const result = await verifyTurnstile(TEST_TOKEN, TEST_IP, TEST_ENV);
    expect(result).toEqual({ success: false, errorCodes: ["network-error"] });
  });

  it("omits remoteip from form data when ip is null", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await verifyTurnstile(TEST_TOKEN, null, TEST_ENV);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = options.body as FormData;
    expect(body.has("remoteip")).toBe(false);
    expect(body.get("secret")).toBe(TEST_ENV.TURNSTILE_SECRET_KEY);
    expect(body.get("response")).toBe(TEST_TOKEN);
  });

  it("includes remoteip when ip is provided", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await verifyTurnstile(TEST_TOKEN, TEST_IP, TEST_ENV);

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = options.body as FormData;
    expect(body.get("remoteip")).toBe(TEST_IP);
  });

  it("includes idempotency_key in request body", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await verifyTurnstile(TEST_TOKEN, TEST_IP, TEST_ENV);

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = options.body as FormData;
    expect(body.has("idempotency_key")).toBe(true);
    expect(body.get("idempotency_key")).toBe("test-uuid-1234-5678-abcd-ef0123456789");
  });

  it("uses redirect: manual for SSRF hardening", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await verifyTurnstile(TEST_TOKEN, TEST_IP, TEST_ENV);

    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    expect(options.redirect).toBe("manual");
    expect(options.method).toBe("POST");
  });

  it("sends to the correct Cloudflare siteverify URL", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await verifyTurnstile(TEST_TOKEN, TEST_IP, TEST_ENV);

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
  });

  it("returns empty errorCodes array when response has no error-codes field", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const result = await verifyTurnstile(TEST_TOKEN, TEST_IP, TEST_ENV);
    expect(result).toEqual({ success: false, errorCodes: [] });
  });
});

// ── extractTurnstileToken ───────────────────────────────────────────────────

describe("extractTurnstileToken", () => {
  it("extracts cf-turnstile-response header value", () => {
    const request = new Request("https://gh.gordoncode.dev/api/proxy/seal", {
      headers: { "cf-turnstile-response": "my-token-value" },
    });
    expect(extractTurnstileToken(request)).toBe("my-token-value");
  });

  it("returns null when cf-turnstile-response header is absent", () => {
    const request = new Request("https://gh.gordoncode.dev/api/proxy/seal");
    expect(extractTurnstileToken(request)).toBeNull();
  });

  it("returns the raw header value without modification", () => {
    const token = "a.b.c.VERY_LONG_TOKEN_VALUE_123456789";
    const request = new Request("https://gh.gordoncode.dev/api/proxy/seal", {
      headers: { "cf-turnstile-response": token },
    });
    expect(extractTurnstileToken(request)).toBe(token);
  });
});
