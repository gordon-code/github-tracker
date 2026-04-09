// Session cookie infrastructure for proxy request binding.
//
// SDR-001: The __Host-session cookie is for rate-limiting binding ONLY,
// NOT authentication. It proves a browser initiated the request; it does
// not prove who the user is. API tokens are managed separately via sealed
// blobs in localStorage.
//
// Local dev note: The __Host- prefix requires HTTPS. Use
// `wrangler dev --local-protocol https` to test session cookies locally.
// See DEPLOY.md "## Local Development" for details.

import {
  deriveKey,
  signSession,
  verifySession,
} from "./crypto";

export interface SessionEnv {
  SESSION_KEY: string;
  SESSION_KEY_PREV?: string;
}

export interface SessionPayload {
  sid: string; // random session ID (crypto.randomUUID())
  iat: number; // issued-at (epoch seconds)
  exp: number; // expiry (epoch seconds)
}

const SESSION_COOKIE_NAME = "__Host-session";
const SESSION_HMAC_SALT = "github-tracker-session-v1";
const SESSION_HMAC_INFO = "session-hmac";
const SESSION_MAX_AGE = 28800; // 8 hours in seconds

// Module-level cache for derived session HMAC keys.
// SESSION_KEY is a deployment constant — safe to cache per-isolate (follows _dsnCache pattern).
let _sessionKeyCache: { raw: string; key: CryptoKey } | undefined;
let _sessionKeyPrevCache: { raw: string; key: CryptoKey } | undefined;

async function getSessionHmacKey(raw: string): Promise<CryptoKey> {
  if (_sessionKeyCache?.raw === raw) return _sessionKeyCache.key;
  const key = await deriveKey(raw, SESSION_HMAC_SALT, SESSION_HMAC_INFO, "sign");
  _sessionKeyCache = { raw, key };
  return key;
}

async function getSessionHmacPrevKey(raw: string): Promise<CryptoKey> {
  if (_sessionKeyPrevCache?.raw === raw) return _sessionKeyPrevCache.key;
  const key = await deriveKey(raw, SESSION_HMAC_SALT, SESSION_HMAC_INFO, "sign");
  _sessionKeyPrevCache = { raw, key };
  return key;
}

/**
 * Issues a new signed session cookie.
 * Returns the Set-Cookie header value and the sessionId for rate-limiting.
 */
export async function issueSession(
  env: SessionEnv
): Promise<{ cookie: string; sessionId: string }> {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    sid: crypto.randomUUID(),
    iat: now,
    exp: now + SESSION_MAX_AGE,
  };

  const json = JSON.stringify(payload);
  const hmacKey = await getSessionHmacKey(env.SESSION_KEY);
  const signature = await signSession(json, hmacKey);

  // base64url(JSON(payload)).base64url(HMAC-SHA256(JSON(payload)))
  const encodedPayload = btoa(json)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  const cookieValue = `${encodedPayload}.${signature}`;
  const cookie = `${SESSION_COOKIE_NAME}=${cookieValue}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_AGE}`;

  return { cookie, sessionId: payload.sid };
}

/**
 * Parses and verifies a session from the Cookie header string.
 * Returns null if missing, invalid, tampered, or expired. Never throws.
 */
export async function parseSession(
  cookieHeader: string | null,
  env: SessionEnv
): Promise<SessionPayload | null> {
  if (!cookieHeader) return null;

  try {
    // Extract the __Host-session cookie value from the Cookie header
    const cookies = cookieHeader.split(";").map((c) => c.trim());
    const entry = cookies.find((c) =>
      c.startsWith(`${SESSION_COOKIE_NAME}=`)
    );
    if (!entry) return null;

    const cookieValue = entry.slice(`${SESSION_COOKIE_NAME}=`.length);
    const dotIndex = cookieValue.lastIndexOf(".");
    if (dotIndex === -1) return null;

    const encodedPayload = cookieValue.slice(0, dotIndex);
    const signature = cookieValue.slice(dotIndex + 1);

    // Decode and parse the payload
    const paddedPayload =
      encodedPayload.replace(/-/g, "+").replace(/_/g, "/");
    const padding = (4 - (paddedPayload.length % 4)) % 4;
    const json = atob(paddedPayload + "=".repeat(padding));
    const payload = JSON.parse(json) as SessionPayload;

    // Verify HMAC signature (rotation-aware, using cached derived keys)
    const currentKey = await getSessionHmacKey(env.SESSION_KEY);
    let valid = await verifySession(json, signature, currentKey);
    if (!valid && env.SESSION_KEY_PREV !== undefined) {
      const prevKey = await getSessionHmacPrevKey(env.SESSION_KEY_PREV);
      valid = await verifySession(json, signature, prevKey);
    }
    if (!valid) return null;

    // Check expiry
    if (payload.exp <= Math.floor(Date.now() / 1000)) return null;

    return payload;
  } catch {
    return null;
  }
}

/**
 * Returns the existing session ID if valid, or issues a new session.
 * Never throws — all error paths return a value.
 * Callers must attach setCookie to their response if present.
 */
export async function ensureSession(
  request: Request,
  env: SessionEnv
): Promise<{ sessionId: string; setCookie?: string }> {
  const cookieHeader = request.headers.get("Cookie");
  const existing = await parseSession(cookieHeader, env);

  if (existing) {
    return { sessionId: existing.sid };
  }

  try {
    const { cookie, sessionId } = await issueSession(env);
    return { sessionId, setCookie: cookie };
  } catch (error) {
    console.error("session_issue_failed", error);
    return { sessionId: crypto.randomUUID() };
  }
}
