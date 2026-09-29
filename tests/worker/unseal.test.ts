import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker, { type Env } from "../../src/worker/index";
import {
  deriveKey,
  sealToken,
  toBase64Url,
  fromBase64Url,
  SEAL_SALT,
  CREDENTIAL_BUNDLE_EXPIRY_MS,
} from "../../src/worker/crypto";
import { ALLOWED_ORIGIN } from "./helpers";

// "test-seal-key" base64-encoded — same value makeEnv wires into SEAL_KEY, so
// hand-crafted blobs (expired / near-expiry fixtures) match the endpoint's key.
const TEST_SEAL_KEY = "dGVzdC1zZWFsLWtleQ==";
const TEST_SESSION_KEY = "dGVzdC1zZXNzaW9uLWtleQ==";
const BUNDLE_INFO = "aes-gcm-key:credential-export-bundle";

let _ipCounter = 0;
// Unique IP per request avoids the module-level in-memory rate limiters
// (unsealRateLimiter 5/min, proxyPreGateLimiter 60/min) leaking across requests.
// Distinct 10.6.x range from seal.test.ts's 10.4.x to avoid cross-file collision.
function nextIp(): string {
  return `10.6.0.${++_ipCounter}`;
}

// ── Map-backed in-memory KV fake ────────────────────────────────────────────
// Persists a put so a later get in the SAME test observes it (a plain vi.fn()
// would not persist and would silently pass-but-not-test the single-use and
// reseal-renewal scenarios). Mirrors Cloudflare KV's rejection of sub-60s TTLs
// so the Math.max(60, …) floor is genuinely exercised. Optionally throws to
// exercise the fail-closed path.
function makeNonceKv(opts: { throwOnGet?: boolean; throwOnPut?: boolean } = {}) {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (key: string): Promise<string | null> => {
      if (opts.throwOnGet) throw new Error("kv get failed");
      return store.has(key) ? (store.get(key) as string) : null;
    }),
    put: vi.fn(async (key: string, value: string, options?: { expirationTtl?: number }): Promise<void> => {
      if (opts.throwOnPut) throw new Error("kv put failed");
      if (options?.expirationTtl !== undefined && options.expirationTtl < 60) {
        throw new Error(`Invalid expiration_ttl of ${options.expirationTtl}. Expiration TTL must be at least 60.`);
      }
      store.set(key, value);
    }),
  };
}

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
    CREDENTIAL_NONCE_KV: makeNonceKv(),
    ...overrides,
  };
}

function makeUnsealRequest(options: {
  sealed?: unknown;
  purpose?: unknown;
  origin?: string;
  ip?: string;
  addXRequestedWith?: boolean;
  addContentType?: boolean;
  turnstileToken?: string;
  method?: string;
  rawBody?: string;
} = {}): Request {
  const {
    origin = ALLOWED_ORIGIN,
    ip = nextIp(),
    addXRequestedWith = true,
    addContentType = true,
    turnstileToken = "valid-turnstile-token",
    method = "POST",
  } = options;

  const headers: Record<string, string> = { "CF-Connecting-IP": ip };
  if (origin) headers["Origin"] = origin;
  if (addXRequestedWith) headers["X-Requested-With"] = "fetch";
  if (addContentType) headers["Content-Type"] = "application/json";
  if (turnstileToken) headers["cf-turnstile-response"] = turnstileToken;

  let body: string | undefined;
  if (options.rawBody !== undefined) {
    body = options.rawBody;
  } else if (method !== "GET") {
    const b: Record<string, unknown> = {
      sealed: "sealed" in options ? options.sealed : "placeholder-sealed-blob",
      purpose: "purpose" in options ? options.purpose : "credential-export-bundle",
    };
    body = JSON.stringify(b);
  }

  return new Request("https://gh.gordoncode.dev/api/proxy/unseal", { method, headers, body });
}

/** Seal a payload through the real /api/proxy/seal endpoint and return the sealed blob. */
async function sealViaEndpoint(env: Env, token: string, purpose = "credential-export-bundle"): Promise<string> {
  const req = new Request("https://gh.gordoncode.dev/api/proxy/seal", {
    method: "POST",
    headers: {
      "CF-Connecting-IP": nextIp(),
      "Origin": ALLOWED_ORIGIN,
      "X-Requested-With": "fetch",
      "Content-Type": "application/json",
      "cf-turnstile-response": "valid-turnstile-token",
    },
    body: JSON.stringify({ token, purpose }),
  });
  const res = await worker.fetch(req, env);
  const json = (await res.json()) as Record<string, unknown>;
  if (typeof json["sealed"] !== "string") {
    throw new Error(`seal failed (status ${res.status}): ${JSON.stringify(json)}`);
  }
  return json["sealed"] as string;
}

/** Hand-craft a credential-export-bundle blob with an arbitrary createdAt (for expiry fixtures). */
async function craftBundle(payload: string, createdAt: number): Promise<string> {
  const key = await deriveKey(TEST_SEAL_KEY, SEAL_SALT, BUNDLE_INFO, "encrypt");
  const nonce = toBase64Url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload)))
  );
  return sealToken(JSON.stringify({ createdAt, nonce, payload }), key);
}

describe("Worker /api/proxy/unseal endpoint", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Default Turnstile mock: success WITHOUT an action field, so it passes both
    // the seal endpoint's "seal" check and the unseal endpoint's "unseal" check.
    // Use mockImplementation (fresh Response per call) — a Response body can only
    // be read once, so a shared mockResolvedValue instance would fail the SECOND
    // Turnstile verify (e.g. seal-then-unseal) with a consumed-body read error.
    globalThis.fetch = vi.fn().mockImplementation(
      async () => new Response(JSON.stringify({ success: true }), { status: 200 })
    );
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // (1) Full round-trip ───────────────────────────────────────────────────────
  it("round-trips a credential-export-bundle: seal then unseal returns the original payload", async () => {
    const env = makeEnv();
    const payload = "inner-envelope-ciphertext-abc123";
    const sealed = await sealViaEndpoint(env, payload);

    const res = await worker.fetch(makeUnsealRequest({ sealed }), env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json["payload"]).toBe(payload);
  });

  // (2) Jira blob gains no plaintext-extraction path ────────────────────────────
  it("rejects a sealed Jira blob submitted to unseal with generic invalid (no new extraction path)", async () => {
    const env = makeEnv();
    // Seal as jira-api-token (plain sealToken, different HKDF purpose key).
    const jiraSealed = await sealViaEndpoint(env, "jira-secret-token", "jira-api-token");

    // Even claiming the allowlisted purpose, the wrong key + missing wrapper reject it.
    const res = await worker.fetch(
      makeUnsealRequest({ sealed: jiraSealed, purpose: "credential-export-bundle" }),
      env
    );
    expect(res.status).toBe(401);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toEqual({ error: "invalid" });
    expect(json["payload"]).toBeUndefined();
  });

  it("rejects a Jira purpose value at the single-value allowlist with generic invalid", async () => {
    const env = makeEnv();
    const jiraSealed = await sealViaEndpoint(env, "jira-secret-token", "jira-api-token");
    const res = await worker.fetch(
      makeUnsealRequest({ sealed: jiraSealed, purpose: "jira-api-token" }),
      env
    );
    expect(res.status).toBe(401);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toEqual({ error: "invalid" });
  });

  // (3) Turnstile ───────────────────────────────────────────────────────────────
  it("rejects a missing Turnstile token with 403 turnstile_failed", async () => {
    const env = makeEnv();
    const res = await worker.fetch(makeUnsealRequest({ turnstileToken: "" }), env);
    expect(res.status).toBe(403);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json["error"]).toBe("turnstile_failed");
  });

  it("rejects a failed Turnstile verification with 403 turnstile_failed", async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      async () => new Response(JSON.stringify({ success: false, "error-codes": ["invalid-input-response"] }), { status: 200 })
    );
    const env = makeEnv();
    const res = await worker.fetch(makeUnsealRequest(), env);
    expect(res.status).toBe(403);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json["error"]).toBe("turnstile_failed");
  });

  // (4) Rate limit BEFORE Turnstile ─────────────────────────────────────────────
  it("rate-limits the 6th request from an IP within 60s BEFORE Turnstile is invoked", async () => {
    const env = makeEnv();
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const fixedIp = "10.6.99.4"; // dedicated IP, used nowhere else

    // Requests 1-5 pass the rate limit and reach Turnstile (each calls fetch once).
    for (let i = 0; i < 5; i++) {
      const res = await worker.fetch(makeUnsealRequest({ ip: fixedIp, sealed: "garbage-but-legal-length" }), env);
      expect(res.status).not.toBe(429);
    }
    const callsBefore = fetchMock.mock.calls.length;
    expect(callsBefore).toBe(5); // exactly one Turnstile verify per allowed request

    // 6th request: rejected by the rate limiter before any Turnstile round-trip.
    const res = await worker.fetch(makeUnsealRequest({ ip: fixedIp, sealed: "garbage-but-legal-length" }), env);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    const json = (await res.json()) as Record<string, unknown>;
    expect(json["error"]).toBe("rate_limited");
    // Turnstile (fetch) was NOT invoked on the rate-limited request.
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });

  // (5) Expired bundle ──────────────────────────────────────────────────────────
  it("rejects an expired bundle with distinct expired, and never consumes the nonce", async () => {
    const kv = makeNonceKv();
    const env = makeEnv({ CREDENTIAL_NONCE_KV: kv });
    const sealed = await craftBundle("inner", Date.now() - CREDENTIAL_BUNDLE_EXPIRY_MS - 10_000);

    const res = await worker.fetch(makeUnsealRequest({ sealed }), env);
    expect(res.status).toBe(401);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json["error"]).toBe("expired");
    // Expiry is checked before nonce consumption.
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  // (6) Tampered ciphertext ─────────────────────────────────────────────────────
  it("rejects a tampered ciphertext with generic invalid, indistinguishable from the Jira-rejection case", async () => {
    const env = makeEnv();
    const sealed = await sealViaEndpoint(env, "inner-payload-xyz");
    const bytes = fromBase64Url(sealed);
    bytes[14] ^= 0xff; // corrupt the outer ciphertext → GCM auth tag fails
    const tampered = toBase64Url(bytes);

    const res = await worker.fetch(makeUnsealRequest({ sealed: tampered }), env);
    expect(res.status).toBe(401);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toEqual({ error: "invalid" });
  });

  // (7) Malformed body ──────────────────────────────────────────────────────────
  it("rejects a body missing 'sealed' with 400 invalid_request (no crash)", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      makeUnsealRequest({ rawBody: JSON.stringify({ purpose: "credential-export-bundle" }) }),
      env
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json["error"]).toBe("invalid_request");
  });

  it("rejects a non-string 'purpose' with generic 401 invalid (no crash)", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      makeUnsealRequest({ rawBody: JSON.stringify({ sealed: "some-blob", purpose: 42 }) }),
      env
    );
    expect(res.status).toBe(401);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toEqual({ error: "invalid" });
  });

  // (8) Single-use enforcement ──────────────────────────────────────────────────
  it("rejects a second unseal of the SAME blob as generic invalid (single-use nonce)", async () => {
    const env = makeEnv();
    const sealed = await sealViaEndpoint(env, "single-use-payload");

    const first = await worker.fetch(makeUnsealRequest({ sealed }), env);
    expect(first.status).toBe(200);
    expect(((await first.json()) as Record<string, unknown>)["payload"]).toBe("single-use-payload");

    const second = await worker.fetch(makeUnsealRequest({ sealed }), env);
    expect(second.status).toBe(401);
    expect(await second.json()).toEqual({ error: "invalid" });
  });

  // (9) Reseal-renewal regression (the vulnerability this nonce closes) ──────────
  it("rejects a RESEALED copy of an already-unsealed payload despite its fresh createdAt", async () => {
    const env = makeEnv();
    const payload = "reseal-renewal-payload";

    const blobA = await sealViaEndpoint(env, payload);
    const unsealA = await worker.fetch(makeUnsealRequest({ sealed: blobA }), env);
    expect(unsealA.status).toBe(200);
    expect(((await unsealA.json()) as Record<string, unknown>)["payload"]).toBe(payload);

    // Reseal the exact same payload → new outer blob, fresh createdAt, SAME nonce.
    const blobB = await sealViaEndpoint(env, payload);
    expect(blobB).not.toBe(blobA);

    const unsealB = await worker.fetch(makeUnsealRequest({ sealed: blobB }), env);
    expect(unsealB.status).toBe(401);
    expect(await unsealB.json()).toEqual({ error: "invalid" });
  });

  // (10) Outer length guard fires BEFORE crypto ─────────────────────────────────
  it("rejects a 'sealed' longer than 6144 chars with 400 invalid_request before any crypto", async () => {
    const env = makeEnv();
    const res = await worker.fetch(makeUnsealRequest({ sealed: "x".repeat(6145) }), env);
    // 400 invalid_request comes ONLY from the pre-crypto length guard; the crypto
    // path can yield only 401 invalid/expired or 200 — so this status proves the
    // guard rejected before unsealWithExpiry ran.
    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json["error"]).toBe("invalid_request");
    // The KV nonce store was never touched.
    expect((env.CREDENTIAL_NONCE_KV as ReturnType<typeof makeNonceKv>).get).not.toHaveBeenCalled();
  });

  // (11) Max-size round-trip (caps are correctly sized relative to each other) ───
  it("round-trips a maximum-size (~4096) inner ciphertext through both caps", async () => {
    const env = makeEnv();
    const payload = "c".repeat(4096); // Step 2's inner cap
    const sealed = await sealViaEndpoint(env, payload);

    // Outer blob exceeds the 4096 inner cap but fits within the 6144 unseal guard.
    expect(sealed.length).toBeGreaterThan(4096);
    expect(sealed.length).toBeLessThanOrEqual(6144);

    const res = await worker.fetch(makeUnsealRequest({ sealed }), env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json["payload"]).toBe(payload);
  });

  // (12) Near-expiry bundle: the Math.max(60, …) TTL floor holds ─────────────────
  it("unseals a near-expiry bundle and puts the nonce with a floored (>=60s) TTL", async () => {
    const kv = makeNonceKv();
    const env = makeEnv({ CREDENTIAL_NONCE_KV: kv });
    // ~30s before the expiry cutoff → raw remaining TTL ≈ 30s, below KV's 60s floor.
    const sealed = await craftBundle("near-expiry-inner", Date.now() - CREDENTIAL_BUNDLE_EXPIRY_MS + 30_000);

    const res = await worker.fetch(makeUnsealRequest({ sealed }), env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json["payload"]).toBe("near-expiry-inner");

    // put must have been called with a TTL floored to at least 60 (a raw sub-60
    // TTL would have thrown in the fake, mirroring real Cloudflare KV).
    expect(kv.put).toHaveBeenCalledTimes(1);
    const ttl = kv.put.mock.calls[0][2]?.expirationTtl;
    expect(ttl).toBeGreaterThanOrEqual(60);
  });

  // (13) Fail-closed on KV error ────────────────────────────────────────────────
  it("fails closed (generic invalid, no payload) when the KV get throws", async () => {
    const env = makeEnv({ CREDENTIAL_NONCE_KV: makeNonceKv({ throwOnGet: true }) });
    const sealed = await sealViaEndpoint(env, "kv-get-throws-payload");

    const res = await worker.fetch(makeUnsealRequest({ sealed }), env);
    expect(res.status).toBe(401);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toEqual({ error: "invalid" });
    expect(json["payload"]).toBeUndefined();
  });

  it("fails closed (generic invalid, no payload) when the KV put throws", async () => {
    const env = makeEnv({ CREDENTIAL_NONCE_KV: makeNonceKv({ throwOnPut: true }) });
    const sealed = await sealViaEndpoint(env, "kv-put-throws-payload");

    const res = await worker.fetch(makeUnsealRequest({ sealed }), env);
    expect(res.status).toBe(401);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toEqual({ error: "invalid" });
    expect(json["payload"]).toBeUndefined();
  });

  // (14) Concurrent unseal race — documents the TOCTOU availability-only guarantee ──
  it("allows both requests of a forced-race concurrent unseal to succeed (single-use is best-effort, not atomic)", async () => {
    // Forces the actual TOCTOU window in handleProxyUnseal: get-then-put is not
    // atomic (Cloudflare KV has no compare-and-set). This gate makes the race
    // deterministic instead of relying on incidental Promise.all interleaving —
    // whichever request's get() call arrives first is held open until the SECOND
    // request's get() call has also run, so both observe "not yet consumed"
    // before either puts. Per the code comment above nonceKv.get/put in index.ts,
    // this is accepted: a race only ever yields the same still-code-encrypted
    // (inert) ciphertext, so single-use here is an availability guarantee, not a
    // confidentiality one.
    const store = new Map<string, string>();
    let getCalls = 0;
    let releaseFirstGet!: () => void;
    const secondGetArrived = new Promise<void>((resolve) => {
      releaseFirstGet = resolve;
    });
    const kv = {
      get: vi.fn(async (key: string): Promise<string | null> => {
        getCalls++;
        if (getCalls === 1) {
          await secondGetArrived;
        } else if (getCalls === 2) {
          releaseFirstGet();
        }
        return store.has(key) ? (store.get(key) as string) : null;
      }),
      put: vi.fn(async (key: string, value: string): Promise<void> => {
        store.set(key, value);
      }),
    };
    const env = makeEnv({ CREDENTIAL_NONCE_KV: kv });
    const sealed = await sealViaEndpoint(env, "racing-payload");

    const [first, second] = await Promise.all([
      worker.fetch(makeUnsealRequest({ sealed }), env),
      worker.fetch(makeUnsealRequest({ sealed }), env),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstJson = (await first.json()) as Record<string, unknown>;
    const secondJson = (await second.json()) as Record<string, unknown>;
    expect(firstJson["payload"]).toBe("racing-payload");
    expect(secondJson["payload"]).toBe("racing-payload");
  });

  // ── Bonus: missing binding surfaces as a deploy error, not a silent import fail ──
  it("returns 503 internal_error when the CREDENTIAL_NONCE_KV binding is missing", async () => {
    const env = makeEnv({ CREDENTIAL_NONCE_KV: undefined as unknown as Env["CREDENTIAL_NONCE_KV"] });
    const res = await worker.fetch(makeUnsealRequest({ sealed: "anything" }), env);
    expect(res.status).toBe(503);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json["error"]).toBe("internal_error");
  });
});
