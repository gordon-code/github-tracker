// Tests for SPA-side proxy utilities (src/app/lib/proxy.ts).
// Turnstile widget rendering requires a real browser — mock window.turnstile.
// Full widget lifecycle is covered by E2E tests.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Module reset helpers ──────────────────────────────────────────────────────

async function loadModule() {
  vi.resetModules();
  return import("../../../src/app/lib/proxy");
}

// ── Mock Turnstile factory ────────────────────────────────────────────────────

interface MockTurnstile {
  render: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
  /** Trigger the success callback for the most-recently rendered widget. */
  _resolveToken(token: string): void;
  /** Trigger the error callback for the most-recently rendered widget. */
  _rejectWithError(code: string): void;
}

function makeMockTurnstile(): MockTurnstile {
  let _successCb: ((token: string) => void) | undefined;
  let _errorCb: ((code: string) => void) | undefined;

  const mock: MockTurnstile = {
    render: vi.fn((_container: HTMLElement, options: { callback?: (token: string) => void; "error-callback"?: (code: string) => void }) => {
      _successCb = options.callback;
      _errorCb = options["error-callback"];
      return "widget-id-1";
    }),
    execute: vi.fn(),
    remove: vi.fn(),
    reset: vi.fn(),
    _resolveToken(token: string) {
      _successCb?.(token);
    },
    _rejectWithError(code: string) {
      _errorCb?.(code);
    },
  };

  return mock;
}

// ── proxyFetch tests ──────────────────────────────────────────────────────────

describe("proxyFetch", () => {
  let mod: typeof import("../../../src/app/lib/proxy");

  beforeEach(async () => {
    mod = await loadModule();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("sets X-Requested-With: fetch automatically", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", mockFetch);

    await mod.proxyFetch("/api/proxy/seal");

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Requested-With"]).toBe("fetch");
  });

  it("sets Content-Type: application/json automatically", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", mockFetch);

    await mod.proxyFetch("/api/proxy/seal");

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("caller-provided headers override defaults", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", mockFetch);

    await mod.proxyFetch("/api/proxy/seal", {
      headers: { "Content-Type": "text/plain" },
    });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    // Caller value takes precedence
    expect(headers["Content-Type"]).toBe("text/plain");
    // Default still set
    expect(headers["X-Requested-With"]).toBe("fetch");
  });

  it("merges extra caller headers without dropping defaults", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", mockFetch);

    await mod.proxyFetch("/api/proxy/seal", {
      headers: { "cf-turnstile-response": "tok123" },
    });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Requested-With"]).toBe("fetch");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["cf-turnstile-response"]).toBe("tok123");
  });

  it("passes the path to fetch unchanged", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", mockFetch);

    await mod.proxyFetch("/api/proxy/seal");

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/proxy/seal");
  });
});

// ── acquireTurnstileToken tests ───────────────────────────────────────────────

describe("acquireTurnstileToken", () => {
  let mod: typeof import("../../../src/app/lib/proxy");

  beforeEach(async () => {
    mod = await loadModule();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("throws immediately when siteKey is empty", async () => {
    await expect(mod.acquireTurnstileToken("")).rejects.toThrow(
      "VITE_TURNSTILE_SITE_KEY not configured",
    );
  });

  it("throws immediately when siteKey is undefined-like empty", async () => {
    await expect(
      mod.acquireTurnstileToken("" as string),
    ).rejects.toThrow("VITE_TURNSTILE_SITE_KEY not configured");
  });

  it("resolves with token when Turnstile callback fires", async () => {
    const mockTurnstile = makeMockTurnstile();
    vi.stubGlobal("window", {
      ...window,
      turnstile: mockTurnstile,
    });

    // Mock script loading: stub createElement so the script tag triggers onload
    const realCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = realCreateElement(tag);
      if (tag === "script") {
        // Trigger onload synchronously after assignment
        const originalSet = Object.getOwnPropertyDescriptor(el, "onload")?.set;
        Object.defineProperty(el, "onload", {
          set(fn: () => void) {
            if (originalSet) originalSet.call(this, fn);
            // Schedule onload after current microtask
            Promise.resolve().then(() => fn?.());
          },
          get() { return null; },
          configurable: true,
        });
        // Prevent actual DOM insertion by stubbing appendChild on head
      }
      return el;
    });

    const realHeadAppend = document.head.appendChild.bind(document.head);
    vi.spyOn(document.head, "appendChild").mockImplementation((node) => {
      const el = node as HTMLScriptElement;
      if (el.tagName === "SCRIPT") {
        // Trigger onload immediately
        (el as unknown as { onload: (() => void) | null }).onload?.();
        return node;
      }
      return realHeadAppend(node);
    });

    const tokenPromise = mod.acquireTurnstileToken("test-site-key");

    // Allow the loadTurnstileScript + render to complete
    await Promise.resolve();
    await Promise.resolve();

    // Fire the success callback
    mockTurnstile._resolveToken("test-token-abc");

    const token = await tokenPromise;
    expect(token).toBe("test-token-abc");
  });

  it("rejects when Turnstile fires error-callback", async () => {
    const mockTurnstile = makeMockTurnstile();
    vi.stubGlobal("window", {
      ...window,
      turnstile: mockTurnstile,
    });

    vi.spyOn(document.head, "appendChild").mockImplementation((node) => {
      const el = node as HTMLScriptElement;
      if (el.tagName === "SCRIPT") {
        (el as unknown as { onload: (() => void) | null }).onload?.();
        return node;
      }
      return node;
    });

    const tokenPromise = mod.acquireTurnstileToken("test-site-key");

    await Promise.resolve();
    await Promise.resolve();

    mockTurnstile._rejectWithError("invalid-input-response");

    await expect(tokenPromise).rejects.toThrow("Turnstile error: invalid-input-response");
  });
});

// ── sealApiToken tests ────────────────────────────────────────────────────────

describe("sealApiToken", () => {
  let mod: typeof import("../../../src/app/lib/proxy");

  beforeEach(async () => {
    vi.resetModules();
    // Set VITE_TURNSTILE_SITE_KEY env
    vi.stubEnv("VITE_TURNSTILE_SITE_KEY", "test-site-key");
    mod = await loadModule();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function setupMockedTurnstile(token: string) {
    const mockTurnstile = makeMockTurnstile();
    vi.stubGlobal("window", {
      ...window,
      turnstile: mockTurnstile,
    });

    vi.spyOn(document.head, "appendChild").mockImplementation((node) => {
      const el = node as HTMLScriptElement;
      if (el.tagName === "SCRIPT") {
        (el as unknown as { onload: (() => void) | null }).onload?.();
        return node;
      }
      return node;
    });

    // Immediately resolve turnstile token after render + execute
    mockTurnstile.execute.mockImplementation(() => {
      mockTurnstile._resolveToken(token);
    });

    return mockTurnstile;
  }

  it("resolves with sealed string on success (200 response)", async () => {
    setupMockedTurnstile("turnstile-tok-ok");

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ sealed: "enc:abc123" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const result = await mod.sealApiToken("my-raw-api-token", "jira-api-token");
    expect(result).toBe("enc:abc123");
  });

  it("throws { status, message } on 403 response", async () => {
    setupMockedTurnstile("turnstile-tok");

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "turnstile_failed" }), { status: 403 }),
    );
    vi.stubGlobal("fetch", mockFetch);

    await expect(mod.sealApiToken("my-token", "jira-api-token")).rejects.toMatchObject({
      status: 403,
      message: "turnstile_failed",
    });
  });

  it("throws { status, message } on 429 response", async () => {
    setupMockedTurnstile("turnstile-tok");

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "rate_limited" }), { status: 429 }),
    );
    vi.stubGlobal("fetch", mockFetch);

    await expect(mod.sealApiToken("my-token", "jira-api-token")).rejects.toMatchObject({
      status: 429,
      message: "rate_limited",
    });
  });

  it("throws { status, message } on 500 response", async () => {
    setupMockedTurnstile("turnstile-tok");

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "seal_failed" }), { status: 500 }),
    );
    vi.stubGlobal("fetch", mockFetch);

    await expect(mod.sealApiToken("my-token", "jira-api-token")).rejects.toMatchObject({
      status: 500,
      message: "seal_failed",
    });
  });

  it("rejects when fetch throws a network error", async () => {
    setupMockedTurnstile("turnstile-tok");

    const mockFetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", mockFetch);

    await expect(mod.sealApiToken("my-token", "jira-api-token")).rejects.toThrow("Failed to fetch");
  });

  it("includes cf-turnstile-response header in POST body", async () => {
    setupMockedTurnstile("expected-turnstile-token");

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ sealed: "enc:xyz" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", mockFetch);

    await mod.sealApiToken("raw-token", "jira-api-token");

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["cf-turnstile-response"]).toBe("expected-turnstile-token");
  });

  it("sends POST to /api/proxy/seal", async () => {
    setupMockedTurnstile("tok");

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ sealed: "enc:abc" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", mockFetch);

    await mod.sealApiToken("raw-token", "jira-api-token");

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/proxy/seal");
    expect(init.method).toBe("POST");
  });

  it("sends token and purpose in the request body as JSON", async () => {
    setupMockedTurnstile("tok");

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ sealed: "enc:abc" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", mockFetch);

    await mod.sealApiToken("my-raw-token", "jira-api-token");

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { token: string; purpose: string };
    expect(body.token).toBe("my-raw-token");
    expect(body.purpose).toBe("jira-api-token");
  });

  it("throws immediately when VITE_TURNSTILE_SITE_KEY is not set", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("VITE_TURNSTILE_SITE_KEY", "");

    const freshMod = await loadModule();
    await expect(freshMod.sealApiToken("raw-token", "jira-api-token")).rejects.toThrow(
      "VITE_TURNSTILE_SITE_KEY not configured",
    );
  });
});
