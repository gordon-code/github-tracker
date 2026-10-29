import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker, { SECURITY_HEADERS, type Env } from "../../src/worker/index";
import { collectLogs, findLog, ALLOWED_ORIGIN } from "./helpers";

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

describe("Worker static asset handling for /_app/*", () => {
  let consoleSpy: {
    info: ReturnType<typeof vi.spyOn>;
    warn: ReturnType<typeof vi.spyOn>;
    error: ReturnType<typeof vi.spyOn>;
  };

  beforeEach(() => {
    consoleSpy = {
      info: vi.spyOn(console, "info").mockImplementation(() => {}),
      warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
      error: vi.spyOn(console, "error").mockImplementation(() => {}),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 404 with no-store, SECURITY_HEADERS, and logs stale_asset_404 on GET /_app/* when ASSETS returns 200 text/html", async () => {
    const env = makeEnv({
      ASSETS: {
        fetch: async () =>
          new Response("<!doctype html><html><body>SPA</body></html>", {
            status: 200,
            headers: { "Content-Type": "text/html" },
          }),
      },
    });
    const req = new Request("https://gh.gordoncode.dev/_app/missing-abc123.js", {
      method: "GET",
    });

    const resp = await worker.fetch(req, env);

    expect(resp.status).toBe(404);
    expect(await resp.text()).toBe("Not Found");
    expect(resp.headers.get("Cache-Control")).toBe("no-store");
    expect(resp.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
      expect(resp.headers.get(key)).toBe(value);
    }

    const logs = collectLogs(consoleSpy);
    const staleLog = findLog(logs, "stale_asset_404");
    expect(staleLog).toBeDefined();
    expect(staleLog?.level).toBe("warn");
    expect(staleLog?.entry.pathname).toBe("/_app/missing-abc123.js");
  });

  it("returns 404 on GET /_app/* when ASSETS returns 200 text/html; charset=utf-8", async () => {
    const env = makeEnv({
      ASSETS: {
        fetch: async () =>
          new Response("<!doctype html><html><body>SPA</body></html>", {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          }),
      },
    });
    const req = new Request("https://gh.gordoncode.dev/_app/missing-abc123.js", {
      method: "GET",
    });

    const resp = await worker.fetch(req, env);

    expect(resp.status).toBe(404);
    expect(await resp.text()).toBe("Not Found");
    expect(resp.headers.get("Cache-Control")).toBe("no-store");
    expect(resp.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
      expect(resp.headers.get(key)).toBe(value);
    }
  });

  it("returns 404 with empty body on HEAD /_app/* when ASSETS returns 200 text/html", async () => {
    const env = makeEnv({
      ASSETS: {
        fetch: async () =>
          new Response("<!doctype html><html><body>SPA</body></html>", {
            status: 200,
            headers: { "Content-Type": "text/html" },
          }),
      },
    });
    const req = new Request("https://gh.gordoncode.dev/_app/missing-abc123.js", {
      method: "HEAD",
    });

    const resp = await worker.fetch(req, env);

    expect(resp.status).toBe(404);
    expect(resp.body).toBeNull();
    expect(await resp.text()).toBe("");
    expect(resp.headers.get("Cache-Control")).toBe("no-store");
    expect(resp.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
      expect(resp.headers.get(key)).toBe(value);
    }
  });

  it("passes through 200 application/javascript response for /_app/index-abc.js", async () => {
    const env = makeEnv({
      ASSETS: {
        fetch: async () =>
          new Response("console.log('ok');", {
            status: 200,
            headers: {
              "Content-Type": "application/javascript",
              "Cache-Control": "public, max-age=31536000, immutable",
            },
          }),
      },
    });
    const req = new Request("https://gh.gordoncode.dev/_app/index-abc.js", {
      method: "GET",
    });

    const resp = await worker.fetch(req, env);

    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("console.log('ok');");
    expect(resp.headers.get("Content-Type")).toBe("application/javascript");
    expect(resp.headers.get("Cache-Control")).toBe(
      "public, max-age=31536000, immutable"
    );
    expect(findLog(collectLogs(consoleSpy), "stale_asset_404")).toBeUndefined();
  });

  it("passes through 200 text/html SPA fallback for non-/_app/ routes like /dashboard", async () => {
    const html = "<!doctype html><html><body><div id='root'></div></body></html>";
    const env = makeEnv({
      ASSETS: {
        fetch: async () =>
          new Response(html, {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          }),
      },
    });
    const req = new Request("https://gh.gordoncode.dev/dashboard", {
      method: "GET",
    });

    const resp = await worker.fetch(req, env);

    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe(html);
    expect(resp.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(findLog(collectLogs(consoleSpy), "stale_asset_404")).toBeUndefined();
  });

  it("passes through 304 Not Modified response from ASSETS for /_app/x.js", async () => {
    const env = makeEnv({
      ASSETS: {
        fetch: async () =>
          new Response(null, {
            status: 304,
            headers: { ETag: '"abc123"' },
          }),
      },
    });
    const req = new Request("https://gh.gordoncode.dev/_app/x.js", {
      method: "GET",
    });

    const resp = await worker.fetch(req, env);

    expect(resp.status).toBe(304);
    expect(resp.headers.get("ETag")).toBe('"abc123"');
    expect(findLog(collectLogs(consoleSpy), "stale_asset_404")).toBeUndefined();
  });
});
