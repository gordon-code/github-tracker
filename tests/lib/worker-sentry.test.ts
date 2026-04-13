import { describe, it, expect, vi } from "vitest";

// Mock @sentry/cloudflare to prevent resolution failure in happy-dom pool.
// workerBeforeSendHandler is a pure function with no Cloudflare API deps.
vi.mock("@sentry/cloudflare", () => ({
  requestDataIntegration: vi.fn(() => ({})),
}));

import {
  workerBeforeSendHandler,
  getWorkerSentryOptions,
} from "../../src/worker/sentry";

describe("workerBeforeSendHandler", () => {
  it("scrubs OAuth params from request URL", () => {
    const event = {
      request: { url: "https://example.com/cb?code=abc123&state=xyz" },
    };
    const result = workerBeforeSendHandler(event);
    expect(result!.request!.url).toBe(
      "https://example.com/cb?code=[REDACTED]&state=[REDACTED]"
    );
  });

  it("scrubs access_token from request URL", () => {
    const event = {
      request: { url: "https://example.com?access_token=ghu_secret" },
    };
    const result = workerBeforeSendHandler(event);
    expect(result!.request!.url).toBe(
      "https://example.com?access_token=[REDACTED]"
    );
  });

  it("scrubs query_string when it is a string", () => {
    const event = {
      request: {
        url: "https://example.com/cb",
        query_string: "code=abc123&tab=issues",
      },
    };
    const result = workerBeforeSendHandler(event);
    expect(result!.request!.query_string).toBe("code=[REDACTED]&tab=issues");
  });

  it("redacts query_string entirely when not a string", () => {
    const event = {
      request: {
        url: "https://example.com/cb",
        query_string: [["code", "abc"]],
      },
    };
    const result = workerBeforeSendHandler(event);
    expect(result!.request!.query_string).toBe("[REDACTED]");
  });

  it("deletes request headers from event", () => {
    const event = {
      request: {
        url: "https://example.com",
        headers: { Authorization: "Bearer ghu_token", Cookie: "session=abc" },
      },
    };
    const result = workerBeforeSendHandler(event);
    expect(result!.request!.headers).toBeUndefined();
  });

  it("deletes request cookies from event", () => {
    const event = {
      request: {
        url: "https://example.com",
        cookies: { "__Host-session": "abc123" },
      },
    };
    const result = workerBeforeSendHandler(event);
    expect(result!.request!.cookies).toBeUndefined();
  });

  it("deletes request data (body) from event", () => {
    const event = {
      request: {
        url: "https://example.com/api/proxy/seal",
        data: '{"token":"ghu_secret123","purpose":"jira-api-token"}',
      },
    };
    const result = workerBeforeSendHandler(event);
    expect((result!.request as Record<string, unknown>).data).toBeUndefined();
  });

  it("deletes user identity from event", () => {
    const event = {
      request: { url: "https://example.com" },
      user: { id: "123", email: "user@example.com" },
    };
    const result = workerBeforeSendHandler(event);
    expect((result as Record<string, unknown>).user).toBeUndefined();
  });

  it("scrubs stack trace abs_path values", () => {
    const event = {
      request: { url: "https://example.com" },
      exception: {
        values: [
          {
            stacktrace: {
              frames: [
                { abs_path: "https://example.com/worker.js?code=secret" },
                { abs_path: "https://example.com/lib.js" },
              ],
            },
          },
        ],
      },
    };
    const result = workerBeforeSendHandler(event);
    const frames = result!.exception!.values![0].stacktrace!.frames!;
    expect(frames[0].abs_path).toBe(
      "https://example.com/worker.js?code=[REDACTED]"
    );
    expect(frames[1].abs_path).toBe("https://example.com/lib.js");
  });

  it("scrubs client_secret from request URL query parameter", () => {
    const event = {
      request: {
        url: "https://github.com/login/oauth/access_token?client_id=abc&client_secret=secret123&code=xyz",
      },
    };
    const result = workerBeforeSendHandler(event);
    expect(result!.request!.url).not.toContain("secret123");
    expect(result!.request!.url).toContain("client_secret=[REDACTED]");
    expect(result!.request!.url).toContain("code=[REDACTED]");
  });

  it("scrubs client_secret pattern from exception message", () => {
    const event = {
      request: { url: "https://example.com" },
      exception: {
        values: [
          {
            value:
              'Fetch failed: client_secret=supersecret123 "client_secret":"anothersecret"',
          },
        ],
      },
    };
    const result = workerBeforeSendHandler(event);
    expect(result!.exception!.values![0].value).toBe(
      'Fetch failed: client_secret=[REDACTED] "client_secret":"[REDACTED]"'
    );
  });

  it("scrubs GitHub token prefixes (ghu_, ghp_, gho_, github_pat_) from exception message", () => {
    const event = {
      request: { url: "https://example.com" },
      exception: {
        values: [
          {
            value:
              "Token ghu_abc123 or ghp_xyz789 or gho_def456 or github_pat_11ABCDEF exposed",
          },
        ],
      },
    };
    const result = workerBeforeSendHandler(event);
    expect(result!.exception!.values![0].value).toBe(
      "Token ghu_[REDACTED] or ghp_[REDACTED] or gho_[REDACTED] or github_pat_[REDACTED] exposed"
    );
  });

  it("passes through events without request field", () => {
    const event = {};
    const result = workerBeforeSendHandler(event);
    expect(result).toBeDefined();
    expect(result).toEqual({});
  });
});

describe("getWorkerSentryOptions", () => {
  it("returns correct requestDataIntegration config", async () => {
    const { requestDataIntegration } = await import("@sentry/cloudflare");
    const env = { SENTRY_DSN: "https://key@sentry.io/123" };
    getWorkerSentryOptions(env);
    expect(requestDataIntegration).toHaveBeenCalledWith({
      include: { headers: false, cookies: false, data: false },
    });
  });

  it("uses SENTRY_DSN from env", () => {
    const env = { SENTRY_DSN: "https://key@sentry.io/456" };
    const opts = getWorkerSentryOptions(env);
    expect(opts.dsn).toBe("https://key@sentry.io/456");
  });

  it("disables PII and tracing", () => {
    const opts = getWorkerSentryOptions({});
    expect(opts.sendDefaultPii).toBe(false);
    // tracesSampleRate is omitted so hasSpansEnabled() returns false (0 != null is true, undefined != null is false)
    expect(opts.tracesSampleRate).toBeUndefined();
  });

  it("sets environment to production", () => {
    const opts = getWorkerSentryOptions({});
    expect(opts.environment).toBe("production");
  });

  it("disables default integrations to suppress console breadcrumb capture", () => {
    const opts = getWorkerSentryOptions({});
    expect(opts.defaultIntegrations).toBe(false);
  });
});
