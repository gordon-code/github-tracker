import { describe, it, expect, vi } from "vitest";
import {
  issueSession,
  parseSession,
  clearSession,
  ensureSession,
  type SessionEnv,
} from "../../src/worker/session";

// Stable base64url-encoded test keys (not real secrets)
const KEY_A =
  "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=".replace(/=/g, "");
const KEY_B =
  "QUJBQUJBQUJBQUJBQUJBQUJBQUJBQUJBQUJBQUJBQUE=".replace(/=/g, "");

function makeEnv(overrides: Partial<SessionEnv> = {}): SessionEnv {
  return {
    SESSION_KEY: KEY_A,
    ...overrides,
  };
}

describe("issueSession", () => {
  it("returns a cookie string starting with __Host-session=", async () => {
    const { cookie } = await issueSession(makeEnv());
    expect(cookie).toContain("__Host-session=");
  });

  it("cookie contains two dot-separated base64url segments", async () => {
    const { cookie } = await issueSession(makeEnv());
    const value = cookie.split(";")[0].split("=").slice(1).join("=");
    const parts = value.split(".");
    // payload.signature (signature itself contains no dots)
    expect(parts.length).toBeGreaterThanOrEqual(2);
    // payload and signature are non-empty
    expect(parts[0].length).toBeGreaterThan(0);
    expect(parts[parts.length - 1].length).toBeGreaterThan(0);
  });

  it("cookie contains required attributes", async () => {
    const { cookie } = await issueSession(makeEnv());
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Max-Age=28800");
  });

  it("returns a sessionId (UUID format)", async () => {
    const { sessionId } = await issueSession(makeEnv());
    expect(sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it("each call produces a unique sessionId", async () => {
    const env = makeEnv();
    const { sessionId: s1 } = await issueSession(env);
    const { sessionId: s2 } = await issueSession(env);
    expect(s1).not.toBe(s2);
  });
});

describe("parseSession", () => {
  it("round-trips: issue then parse returns matching payload", async () => {
    const env = makeEnv();
    const { cookie, sessionId } = await issueSession(env);
    const cookieValue = cookie.split(";")[0].split("=").slice(1).join("=");
    const parsed = await parseSession(
      `__Host-session=${cookieValue}`,
      env
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.sid).toBe(sessionId);
  });

  it("returns null for null cookie header", async () => {
    expect(await parseSession(null, makeEnv())).toBeNull();
  });

  it("returns null for empty cookie header", async () => {
    expect(await parseSession("", makeEnv())).toBeNull();
  });

  it("returns null when cookie name does not match (__Host- prefix required)", async () => {
    const env = makeEnv();
    const { cookie } = await issueSession(env);
    // Strip __Host- prefix from cookie name
    const cookieValue = cookie.split(";")[0].split("=").slice(1).join("=");
    const result = await parseSession(`session=${cookieValue}`, env);
    expect(result).toBeNull();
  });

  it("returns null for tampered payload (signature mismatch)", async () => {
    const env = makeEnv();
    const { cookie } = await issueSession(env);
    const cookieValue = cookie.split(";")[0].split("=").slice(1).join("=");
    const dotIndex = cookieValue.lastIndexOf(".");
    const encodedPayload = cookieValue.slice(0, dotIndex);
    const signature = cookieValue.slice(dotIndex + 1);

    // Tamper: modify last char of encoded payload
    const tampered =
      encodedPayload.slice(0, -1) +
      (encodedPayload.endsWith("a") ? "b" : "a");
    const result = await parseSession(
      `__Host-session=${tampered}.${signature}`,
      env
    );
    expect(result).toBeNull();
  });

  it("returns null for tampered signature", async () => {
    const env = makeEnv();
    const { cookie } = await issueSession(env);
    const cookieValue = cookie.split(";")[0].split("=").slice(1).join("=");
    const dotIndex = cookieValue.lastIndexOf(".");
    const encodedPayload = cookieValue.slice(0, dotIndex);

    const result = await parseSession(
      `__Host-session=${encodedPayload}.invalidsignature`,
      env
    );
    expect(result).toBeNull();
  });

  it("returns null for expired session", async () => {
    const env = makeEnv();
    // Mock Date.now to issue a session in the past
    const realNow = Date.now;
    const pastTime = Date.now() - 9 * 3600 * 1000; // 9 hours ago (> 8h SESSION_MAX_AGE)
    vi.spyOn(Date, "now").mockReturnValue(pastTime);
    const { cookie } = await issueSession(env);
    vi.spyOn(Date, "now").mockRestore();

    const cookieValue = cookie.split(";")[0].split("=").slice(1).join("=");
    const result = await parseSession(
      `__Host-session=${cookieValue}`,
      env
    );
    expect(result).toBeNull();
    void realNow; // suppress unused warning
  });

  it("accepts a session issued 1 second ago (clock skew)", async () => {
    const env = makeEnv();
    const oneSecondAgo = Date.now() - 1000;
    vi.spyOn(Date, "now").mockReturnValue(oneSecondAgo);
    const { cookie } = await issueSession(env);
    vi.spyOn(Date, "now").mockRestore();

    const cookieValue = cookie.split(";")[0].split("=").slice(1).join("=");
    const result = await parseSession(
      `__Host-session=${cookieValue}`,
      env
    );
    expect(result).not.toBeNull();
  });

  it("extracts correct cookie from multi-cookie header", async () => {
    const env = makeEnv();
    const { cookie, sessionId } = await issueSession(env);
    const cookieValue = cookie.split(";")[0].split("=").slice(1).join("=");
    const multiCookie = `other-cookie=abc; __Host-session=${cookieValue}; another=xyz`;
    const parsed = await parseSession(multiCookie, env);
    expect(parsed).not.toBeNull();
    expect(parsed!.sid).toBe(sessionId);
  });

  it("signature rotation: signed with old key, verified with new+old", async () => {
    const envOld = makeEnv({ SESSION_KEY: KEY_A });
    const { cookie } = await issueSession(envOld);
    const cookieValue = cookie.split(";")[0].split("=").slice(1).join("=");

    // Now verify with KEY_B as current, KEY_A as prev
    const envNew = makeEnv({
      SESSION_KEY: KEY_B,
      SESSION_KEY_PREV: KEY_A,
    });
    const result = await parseSession(
      `__Host-session=${cookieValue}`,
      envNew
    );
    expect(result).not.toBeNull();
  });

  it("returns null when old key is not in rotation", async () => {
    const envOld = makeEnv({ SESSION_KEY: KEY_A });
    const { cookie } = await issueSession(envOld);
    const cookieValue = cookie.split(";")[0].split("=").slice(1).join("=");

    // KEY_B only, no KEY_A in rotation
    const envNew = makeEnv({ SESSION_KEY: KEY_B });
    const result = await parseSession(
      `__Host-session=${cookieValue}`,
      envNew
    );
    expect(result).toBeNull();
  });

  it("returns null for malformed cookie value (no dot separator)", async () => {
    const result = await parseSession(
      "__Host-session=nodothere",
      makeEnv()
    );
    expect(result).toBeNull();
  });

  it("returns null for garbage cookie value", async () => {
    const result = await parseSession(
      "__Host-session=!!!garbage!!!",
      makeEnv()
    );
    expect(result).toBeNull();
  });
});

describe("clearSession", () => {
  it("returns Max-Age=0", () => {
    expect(clearSession()).toContain("Max-Age=0");
  });

  it("returns __Host-session= with empty value", () => {
    const result = clearSession();
    expect(result).toMatch(/^__Host-session=;/);
  });

  it("includes required security attributes", () => {
    const result = clearSession();
    expect(result).toContain("Path=/");
    expect(result).toContain("Secure");
    expect(result).toContain("HttpOnly");
    expect(result).toContain("SameSite=Strict");
  });
});

describe("ensureSession", () => {
  function makeRequest(cookieHeader?: string): Request {
    const headers: Record<string, string> = {};
    if (cookieHeader) headers["Cookie"] = cookieHeader;
    return new Request("https://gh.gordoncode.dev/api/proxy/seal", {
      headers,
    });
  }

  it("issues new session when no cookie present", async () => {
    const env = makeEnv();
    const req = makeRequest();
    const result = await ensureSession(req, env);
    expect(result.sessionId).toBeTruthy();
    expect(result.setCookie).toBeDefined();
    expect(result.setCookie).toContain("__Host-session=");
  });

  it("reuses existing valid session, no setCookie", async () => {
    const env = makeEnv();
    const { cookie, sessionId } = await issueSession(env);
    const cookieValue = cookie.split(";")[0].split("=").slice(1).join("=");
    const req = makeRequest(`__Host-session=${cookieValue}`);
    const result = await ensureSession(req, env);
    expect(result.sessionId).toBe(sessionId);
    expect(result.setCookie).toBeUndefined();
  });

  it("issues new session when existing session is expired", async () => {
    const env = makeEnv();
    const pastTime = Date.now() - 9 * 3600 * 1000;
    vi.spyOn(Date, "now").mockReturnValue(pastTime);
    const { cookie } = await issueSession(env);
    vi.spyOn(Date, "now").mockRestore();

    const cookieValue = cookie.split(";")[0].split("=").slice(1).join("=");
    const req = makeRequest(`__Host-session=${cookieValue}`);
    const result = await ensureSession(req, env);
    expect(result.setCookie).toBeDefined();
  });

  it("issues new session when cookie signature is invalid", async () => {
    const req = makeRequest(
      "__Host-session=fakepayload.fakesignature"
    );
    const result = await ensureSession(req, makeEnv());
    expect(result.setCookie).toBeDefined();
  });
});
