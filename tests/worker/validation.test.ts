import { describe, it, expect } from "vitest";
import {
  validateOrigin,
  validateFetchMetadata,
  validateCustomHeader,
  validateContentType,
  validateProxyRequest,
} from "../../src/worker/validation";

const ALLOWED_ORIGIN = "https://gh.gordoncode.dev";

function makeRequest(
  options: {
    method?: string;
    headers?: Record<string, string>;
  } = {}
): Request {
  return new Request("https://gh.gordoncode.dev/api/proxy/seal", {
    method: options.method ?? "POST",
    headers: options.headers ?? {},
  });
}

// ── validateOrigin ──────────────────────────────────────────────────────────

describe("validateOrigin", () => {
  it("returns ok when Origin matches exactly", () => {
    const req = makeRequest({ headers: { Origin: ALLOWED_ORIGIN } });
    expect(validateOrigin(req, ALLOWED_ORIGIN)).toEqual({ ok: true });
  });

  it("returns origin_mismatch for a different origin", () => {
    const req = makeRequest({ headers: { Origin: "https://evil.com" } });
    const result = validateOrigin(req, ALLOWED_ORIGIN);
    expect(result).toEqual({ ok: false, code: "origin_mismatch", status: 403 });
  });

  it("returns origin_mismatch when no Origin header", () => {
    const req = makeRequest({});
    const result = validateOrigin(req, ALLOWED_ORIGIN);
    expect(result).toEqual({ ok: false, code: "origin_mismatch", status: 403 });
  });

  it("rejects substring attack — evil.com subdomain of allowed origin", () => {
    const req = makeRequest({ headers: { Origin: "https://gh.gordoncode.dev.evil.com" } });
    const result = validateOrigin(req, ALLOWED_ORIGIN);
    expect(result).toEqual({ ok: false, code: "origin_mismatch", status: 403 });
  });

  it("rejects prefix spoofing — allowed origin as prefix of evil domain", () => {
    const req = makeRequest({ headers: { Origin: "https://gh.gordoncode.dev.com" } });
    const result = validateOrigin(req, ALLOWED_ORIGIN);
    expect(result).toEqual({ ok: false, code: "origin_mismatch", status: 403 });
  });
});

// ── validateFetchMetadata ───────────────────────────────────────────────────

describe("validateFetchMetadata", () => {
  it("returns ok for same-origin", () => {
    const req = makeRequest({ headers: { "Sec-Fetch-Site": "same-origin" } });
    expect(validateFetchMetadata(req)).toEqual({ ok: true });
  });

  it("returns ok when Sec-Fetch-Site header is absent (legacy browser)", () => {
    const req = makeRequest({});
    expect(validateFetchMetadata(req)).toEqual({ ok: true });
  });

  it("rejects cross-site", () => {
    const req = makeRequest({ headers: { "Sec-Fetch-Site": "cross-site" } });
    const result = validateFetchMetadata(req);
    expect(result).toEqual({ ok: false, code: "cross_site_request", status: 403 });
  });

  it("rejects same-site", () => {
    const req = makeRequest({ headers: { "Sec-Fetch-Site": "same-site" } });
    const result = validateFetchMetadata(req);
    expect(result).toEqual({ ok: false, code: "cross_site_request", status: 403 });
  });

  it("rejects none (direct navigation not allowed on API routes)", () => {
    const req = makeRequest({ headers: { "Sec-Fetch-Site": "none" } });
    const result = validateFetchMetadata(req);
    expect(result).toEqual({ ok: false, code: "cross_site_request", status: 403 });
  });
});

// ── validateCustomHeader ────────────────────────────────────────────────────

describe("validateCustomHeader", () => {
  it("returns ok for X-Requested-With: fetch", () => {
    const req = makeRequest({ headers: { "X-Requested-With": "fetch" } });
    expect(validateCustomHeader(req)).toEqual({ ok: true });
  });

  it("rejects XMLHttpRequest value", () => {
    const req = makeRequest({ headers: { "X-Requested-With": "XMLHttpRequest" } });
    const result = validateCustomHeader(req);
    expect(result).toEqual({ ok: false, code: "missing_csrf_header", status: 403 });
  });

  it("rejects missing header", () => {
    const req = makeRequest({});
    const result = validateCustomHeader(req);
    expect(result).toEqual({ ok: false, code: "missing_csrf_header", status: 403 });
  });

  it("rejects empty string value", () => {
    const req = makeRequest({ headers: { "X-Requested-With": "" } });
    const result = validateCustomHeader(req);
    expect(result).toEqual({ ok: false, code: "missing_csrf_header", status: 403 });
  });
});

// ── validateContentType ─────────────────────────────────────────────────────

describe("validateContentType", () => {
  it("returns ok for exact match", () => {
    const req = makeRequest({ headers: { "Content-Type": "application/json" } });
    expect(validateContentType(req, "application/json")).toEqual({ ok: true });
  });

  it("returns ok when Content-Type includes charset suffix", () => {
    const req = makeRequest({ headers: { "Content-Type": "application/json; charset=utf-8" } });
    expect(validateContentType(req, "application/json")).toEqual({ ok: true });
  });

  it("is case-insensitive", () => {
    const req = makeRequest({ headers: { "Content-Type": "Application/JSON" } });
    expect(validateContentType(req, "application/json")).toEqual({ ok: true });
  });

  it("rejects text/plain", () => {
    const req = makeRequest({ headers: { "Content-Type": "text/plain" } });
    const result = validateContentType(req, "application/json");
    expect(result).toEqual({ ok: false, code: "invalid_content_type", status: 415 });
  });

  it("rejects missing Content-Type", () => {
    const req = makeRequest({});
    const result = validateContentType(req, "application/json");
    expect(result).toEqual({ ok: false, code: "invalid_content_type", status: 415 });
  });
});

// ── validateProxyRequest ────────────────────────────────────────────────────

describe("validateProxyRequest", () => {
  function makeValidPostRequest(extra: Record<string, string> = {}): Request {
    return makeRequest({
      method: "POST",
      headers: {
        Origin: ALLOWED_ORIGIN,
        "Sec-Fetch-Site": "same-origin",
        "X-Requested-With": "fetch",
        "Content-Type": "application/json",
        ...extra,
      },
    });
  }

  it("returns ok for POST request with all valid headers", () => {
    const req = makeValidPostRequest();
    expect(validateProxyRequest(req, ALLOWED_ORIGIN)).toEqual({ ok: true });
  });

  it("returns ok for GET request without Content-Type (skipped)", () => {
    const req = new Request("https://gh.gordoncode.dev/api/proxy/data", {
      method: "GET",
      headers: {
        Origin: ALLOWED_ORIGIN,
        "Sec-Fetch-Site": "same-origin",
        "X-Requested-With": "fetch",
        // No Content-Type
      },
    });
    expect(validateProxyRequest(req, ALLOWED_ORIGIN)).toEqual({ ok: true });
  });

  it("returns ok for HEAD request without Content-Type (skipped)", () => {
    const req = new Request("https://gh.gordoncode.dev/api/proxy/data", {
      method: "HEAD",
      headers: {
        Origin: ALLOWED_ORIGIN,
        "Sec-Fetch-Site": "same-origin",
        "X-Requested-With": "fetch",
      },
    });
    expect(validateProxyRequest(req, ALLOWED_ORIGIN)).toEqual({ ok: true });
  });

  it("returns ok for DELETE request without Content-Type (skipped)", () => {
    const req = new Request("https://gh.gordoncode.dev/api/proxy/data", {
      method: "DELETE",
      headers: {
        Origin: ALLOWED_ORIGIN,
        "Sec-Fetch-Site": "same-origin",
        "X-Requested-With": "fetch",
      },
    });
    expect(validateProxyRequest(req, ALLOWED_ORIGIN)).toEqual({ ok: true });
  });

  it("fails with origin_mismatch when Origin missing (short-circuits)", () => {
    const req = makeRequest({
      method: "POST",
      headers: {
        "Sec-Fetch-Site": "same-origin",
        "X-Requested-With": "fetch",
        "Content-Type": "application/json",
      },
    });
    const result = validateProxyRequest(req, ALLOWED_ORIGIN);
    expect(result).toEqual({ ok: false, code: "origin_mismatch", status: 403 });
  });

  it("fails with cross_site_request when Sec-Fetch-Site is cross-site", () => {
    const req = makeRequest({
      method: "POST",
      headers: {
        Origin: ALLOWED_ORIGIN,
        "Sec-Fetch-Site": "cross-site",
        "X-Requested-With": "fetch",
        "Content-Type": "application/json",
      },
    });
    const result = validateProxyRequest(req, ALLOWED_ORIGIN);
    expect(result).toEqual({ ok: false, code: "cross_site_request", status: 403 });
  });

  it("fails with missing_csrf_header when X-Requested-With is absent", () => {
    const req = makeRequest({
      method: "POST",
      headers: {
        Origin: ALLOWED_ORIGIN,
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json",
      },
    });
    const result = validateProxyRequest(req, ALLOWED_ORIGIN);
    expect(result).toEqual({ ok: false, code: "missing_csrf_header", status: 403 });
  });

  it("fails with invalid_content_type for PUT with wrong Content-Type", () => {
    const req = new Request("https://gh.gordoncode.dev/api/proxy/data", {
      method: "PUT",
      headers: {
        Origin: ALLOWED_ORIGIN,
        "Sec-Fetch-Site": "same-origin",
        "X-Requested-With": "fetch",
        "Content-Type": "text/plain",
      },
    });
    const result = validateProxyRequest(req, ALLOWED_ORIGIN);
    expect(result).toEqual({ ok: false, code: "invalid_content_type", status: 415 });
  });

  it("fails with invalid_content_type for PATCH with wrong Content-Type", () => {
    const req = new Request("https://gh.gordoncode.dev/api/proxy/data", {
      method: "PATCH",
      headers: {
        Origin: ALLOWED_ORIGIN,
        "Sec-Fetch-Site": "same-origin",
        "X-Requested-With": "fetch",
        "Content-Type": "text/plain",
      },
    });
    const result = validateProxyRequest(req, ALLOWED_ORIGIN);
    expect(result).toEqual({ ok: false, code: "invalid_content_type", status: 415 });
  });

  it("short-circuits on first failure (origin checked before fetch metadata)", () => {
    // Both Origin and Sec-Fetch-Site are wrong — should fail on origin_mismatch
    const req = makeRequest({
      method: "POST",
      headers: {
        Origin: "https://evil.com",
        "Sec-Fetch-Site": "cross-site",
        "X-Requested-With": "fetch",
        "Content-Type": "application/json",
      },
    });
    const result = validateProxyRequest(req, ALLOWED_ORIGIN);
    expect(result).toEqual({ ok: false, code: "origin_mismatch", status: 403 });
  });

  it("rejects origin substring attack through proxy validation", () => {
    const req = makeRequest({
      method: "POST",
      headers: {
        Origin: "https://gh.gordoncode.dev.evil.com",
        "Sec-Fetch-Site": "same-origin",
        "X-Requested-With": "fetch",
        "Content-Type": "application/json",
      },
    });
    const result = validateProxyRequest(req, ALLOWED_ORIGIN);
    expect(result).toEqual({ ok: false, code: "origin_mismatch", status: 403 });
  });
});
