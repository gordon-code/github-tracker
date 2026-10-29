import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  scrubUrl,
  beforeSendHandler,
  beforeBreadcrumbHandler,
  initSentry,
} from "../../src/app/lib/sentry";

vi.mock("@sentry/solid", () => ({
  init: vi.fn(),
}));

describe("scrubUrl", () => {
  it("strips code= parameter", () => {
    expect(scrubUrl("https://example.com/cb?code=abc123&state=xyz")).toBe(
      "https://example.com/cb?code=[REDACTED]&state=[REDACTED]",
    );
  });

  it("strips access_token= parameter", () => {
    expect(scrubUrl("https://example.com?access_token=ghu_secret")).toBe(
      "https://example.com?access_token=[REDACTED]",
    );
  });

  it("strips state= parameter", () => {
    expect(scrubUrl("https://example.com?state=random_state_value")).toBe(
      "https://example.com?state=[REDACTED]",
    );
  });

  it("strips multiple sensitive params at once", () => {
    const url =
      "https://example.com/cb?code=abc&state=xyz&access_token=ghu_tok&other=safe";
    const result = scrubUrl(url);
    expect(result).toContain("code=[REDACTED]");
    expect(result).toContain("state=[REDACTED]");
    expect(result).toContain("access_token=[REDACTED]");
    expect(result).toContain("other=safe");
  });

  it("returns URL unchanged when no sensitive params present", () => {
    const url = "https://example.com/page?tab=issues&sort=updated";
    expect(scrubUrl(url)).toBe(url);
  });

  it("handles empty string", () => {
    expect(scrubUrl("")).toBe("");
  });

  it("handles params at end of string (no trailing &)", () => {
    expect(scrubUrl("https://example.com?code=abc")).toBe(
      "https://example.com?code=[REDACTED]",
    );
  });

  it("strips client_secret= parameter", () => {
    expect(scrubUrl("https://example.com?client_secret=supersecret")).toBe(
      "https://example.com?client_secret=[REDACTED]",
    );
  });

  it("strips GitHub token prefixes (ghu_, ghp_, gho_, github_pat_)", () => {
    expect(scrubUrl("Error: token ghu_abc123 exposed")).toBe(
      "Error: token ghu_[REDACTED] exposed",
    );
    expect(scrubUrl("token ghp_xyz789")).toBe("token ghp_[REDACTED]");
    expect(scrubUrl("token gho_def456")).toBe("token gho_[REDACTED]");
    expect(scrubUrl("token github_pat_abc123")).toBe("token github_pat_[REDACTED]");
  });

  it("strips Atlassian API token prefix (ATATT...)", () => {
    expect(scrubUrl("Error: token ATATT3xFfGF0abc123_def-456= exposed")).toBe(
      "Error: token ATATT[REDACTED] exposed",
    );
  });
});

describe("beforeSendHandler", () => {
  it("scrubs OAuth params from request URL", () => {
    const event = {
      request: {
        url: "https://gh.gordoncode.dev/cb?code=abc123&state=xyz",
      },
    };
    const result = beforeSendHandler(event as never);
    expect(result!.request!.url).toBe(
      "https://gh.gordoncode.dev/cb?code=[REDACTED]&state=[REDACTED]",
    );
  });

  it("scrubs query_string selectively when it is a string", () => {
    const event = {
      request: {
        url: "https://gh.gordoncode.dev/cb",
        query_string: "code=abc123&tab=issues",
      },
    };
    const result = beforeSendHandler(event as never);
    expect(result!.request!.query_string).toBe("code=[REDACTED]&tab=issues");
  });

  it("redacts query_string entirely when it is not a string", () => {
    const event = {
      request: {
        url: "https://gh.gordoncode.dev/cb",
        query_string: [["code", "abc123"]],
      },
    };
    const result = beforeSendHandler(event as never);
    expect(result!.request!.query_string).toBe("[REDACTED]");
  });

  it("deletes request headers, cookies, and data", () => {
    const event = {
      request: {
        url: "https://gh.gordoncode.dev",
        headers: { Authorization: "Bearer ghu_token" },
        cookies: "session=abc",
        data: '{"token":"ghu_secret"}',
      },
    };
    const result = beforeSendHandler(event as never);
    expect(result!.request!.headers).toBeUndefined();
    expect(result!.request!.cookies).toBeUndefined();
    expect((result!.request as Record<string, unknown>).data).toBeUndefined();
  });

  it("deletes user identity", () => {
    const event = {
      request: { url: "https://gh.gordoncode.dev" },
      user: { id: "123", email: "test@example.com" },
    };
    const result = beforeSendHandler(event as never);
    expect((result as unknown as Record<string, unknown>).user).toBeUndefined();
  });

  it("scrubs URLs in stack trace frames", () => {
    const event = {
      request: { url: "https://gh.gordoncode.dev" },
      exception: {
        values: [
          {
            stacktrace: {
              frames: [
                { abs_path: "https://gh.gordoncode.dev/app.js?code=secret" },
                { abs_path: "https://gh.gordoncode.dev/lib.js" },
              ],
            },
          },
        ],
      },
    };
    const result = beforeSendHandler(event as never);
    const frames = result!.exception!.values![0].stacktrace!.frames!;
    expect(frames[0].abs_path).toBe(
      "https://gh.gordoncode.dev/app.js?code=[REDACTED]",
    );
    expect(frames[1].abs_path).toBe("https://gh.gordoncode.dev/lib.js");
  });

  it("handles events with no request", () => {
    const event = {};
    const result = beforeSendHandler(event as never);
    expect(result).toBeDefined();
  });

  it("scrubs OAuth params from exception message values", () => {
    const event = {
      request: { url: "https://gh.gordoncode.dev" },
      exception: {
        values: [
          {
            value: "Request failed with code=abc123&state=xyz in URL",
          },
        ],
      },
    };
    const result = beforeSendHandler(event as never);
    expect(result!.exception!.values![0].value).not.toContain("abc123");
    expect(result!.exception!.values![0].value).toContain("code=[REDACTED]");
    expect(result!.exception!.values![0].value).toContain("state=[REDACTED]");
  });

  it("scrubs GitHub token prefixes from exception message values", () => {
    const event = {
      request: { url: "https://gh.gordoncode.dev" },
      exception: {
        values: [
          {
            value: "Token ghp_secrettoken123 was used in request",
          },
        ],
      },
    };
    const result = beforeSendHandler(event as never);
    expect(result!.exception!.values![0].value).not.toContain("secrettoken123");
    expect(result!.exception!.values![0].value).toContain("ghp_[REDACTED]");
  });

  it("scrubs client_secret and tokens from exception message values", () => {
    const event = {
      request: { url: "https://gh.gordoncode.dev" },
      exception: {
        values: [
          {
            value: "Fetch failed: client_secret=supersecret ghu_abc123",
          },
        ],
      },
    };
    const result = beforeSendHandler(event as never);
    expect(result!.exception!.values![0].value).not.toContain("supersecret");
    expect(result!.exception!.values![0].value).not.toContain("ghu_abc123");
    expect(result!.exception!.values![0].value).toContain("client_secret=[REDACTED]");
    expect(result!.exception!.values![0].value).toContain("ghu_[REDACTED]");
  });

  it("drops transient browser fetch disconnect errors when event.tags.source is a background poll source", () => {
    const backgroundSources = [
      "prEnrichment",
      "dashboardBodies",
      "depPRBodies",
      "pr-pagination",
      "poll-cycle",
      "hot-poll-pr-batch",
      "hot-poll-pr-fetch",
      "hot-poll-run-fetch",
    ];

    for (const source of backgroundSources) {
      expect(
        beforeSendHandler({
          tags: { source },
          exception: { values: [{ type: "TypeError", value: "Failed to fetch" }] },
        } as never)
      ).toBeNull();

      expect(
        beforeSendHandler({
          tags: { source },
          exception: {
            values: [
              { type: "TypeError", value: "Failed to fetch (api.github.com)" },
              { type: "HttpError", value: "Failed to fetch" },
            ],
          },
        } as never)
      ).toBeNull();

      expect(
        beforeSendHandler({
          tags: { source },
          exception: {
            values: [{ type: "TypeError", value: "NetworkError when attempting to fetch resource." }],
          },
        } as never)
      ).toBeNull();

      expect(
        beforeSendHandler({
          tags: { source },
          exception: {
            values: [
              { type: "TypeError", value: "Load failed" },
              { type: "TypeError", value: "Load failed (api.github.com)" },
            ],
          },
        } as never)
      ).toBeNull();
    }
  });

  it("preserves transient browser fetch disconnect errors when event.tags.source is interactive or absent", () => {
    const interactiveSources = [
      "oauth-callback",
      "pat-validation",
      "pat-replace",
      "jira-api-token-connect",
    ];

    for (const source of interactiveSources) {
      const event = {
        tags: { source },
        exception: { values: [{ type: "TypeError", value: "Failed to fetch" }] },
      };
      expect(beforeSendHandler(event as never)).not.toBeNull();
    }

    const untaggedEvent = {
      exception: { values: [{ type: "TypeError", value: "Failed to fetch" }] },
    };
    expect(beforeSendHandler(untaggedEvent as never)).not.toBeNull();
  });

  it("preserves GraphqlFetchTimeoutError, HTTP status errors, code TypeErrors, and prefix lookalikes on background poll sources", () => {
    const preservedValues = [
      { type: "GraphqlFetchTimeoutError", value: "GraphQL request exceeded 20000ms" },
      { type: "HttpError", value: "Bad Gateway (502)" },
      { type: "HttpError", value: "Resource not accessible by integration (403)" },
      { type: "TypeError", value: "Cannot read properties of undefined (reading 'nodes')" },
      { type: "Error", value: "Failed to fetch user profile: 500" },
      { type: "Error", value: "Load failed for module /assets/index.js" },
    ];

    for (const ex of preservedValues) {
      const event = {
        tags: { source: "prEnrichment" },
        exception: { values: [ex] },
      };
      expect(beforeSendHandler(event as never)).not.toBeNull();
    }

    // Mixed chain where one entry is a non-disconnect error must also be preserved
    const mixedEvent = {
      tags: { source: "poll-cycle" },
      exception: {
        values: [
          { type: "TypeError", value: "Failed to fetch" },
          { type: "HttpError", value: "HttpError: 500 Internal Server Error" },
        ],
      },
    };
    expect(beforeSendHandler(mixedEvent as never)).not.toBeNull();
  });
});

describe("beforeBreadcrumbHandler", () => {
  it("scrubs navigation breadcrumb URLs", () => {
    const breadcrumb = {
      category: "navigation",
      data: {
        from: "https://gh.gordoncode.dev/cb?code=abc",
        to: "https://gh.gordoncode.dev/dashboard?state=xyz",
      },
    };
    const result = beforeBreadcrumbHandler(breadcrumb);
    expect(result!.data!.from).toBe(
      "https://gh.gordoncode.dev/cb?code=[REDACTED]",
    );
    expect(result!.data!.to).toBe(
      "https://gh.gordoncode.dev/dashboard?state=[REDACTED]",
    );
  });

  it("scrubs fetch breadcrumb URLs", () => {
    const breadcrumb = {
      category: "fetch",
      data: { url: "https://api.github.com?access_token=ghu_tok" },
    };
    const result = beforeBreadcrumbHandler(breadcrumb);
    expect(result!.data!.url).toBe(
      "https://api.github.com?access_token=[REDACTED]",
    );
  });

  it("scrubs xhr breadcrumb URLs", () => {
    const breadcrumb = {
      category: "xhr",
      data: { url: "https://api.github.com?code=abc" },
    };
    const result = beforeBreadcrumbHandler(breadcrumb);
    expect(result!.data!.url).toBe(
      "https://api.github.com?code=[REDACTED]",
    );
  });

  it("keeps allowed console breadcrumbs", () => {
    const prefixes = [
      "[app]", "[auth]", "[api]", "[poll]", "[dashboard]", "[settings]",
      "[hot-poll]", "[cache]", "[github]", "[mcp-relay]", "[notifications]",
    ];
    for (const prefix of prefixes) {
      const breadcrumb = {
        category: "console",
        message: `${prefix} some message`,
      };
      expect(beforeBreadcrumbHandler(breadcrumb as never)).not.toBeNull();
    }
  });

  it("drops untagged console breadcrumbs", () => {
    const breadcrumb = {
      category: "console",
      message: "random third-party log",
    };
    expect(beforeBreadcrumbHandler(breadcrumb as never)).toBeNull();
  });

  it("drops console breadcrumbs with empty message", () => {
    const breadcrumb = { category: "console", message: "" };
    expect(beforeBreadcrumbHandler(breadcrumb as never)).toBeNull();
  });

  it("drops console breadcrumbs with no message", () => {
    const breadcrumb = { category: "console" };
    expect(beforeBreadcrumbHandler(breadcrumb as never)).toBeNull();
  });

  it("passes through non-console, non-navigation breadcrumbs unchanged", () => {
    const breadcrumb = { category: "ui.click", message: "button" };
    expect(beforeBreadcrumbHandler(breadcrumb as never)).toBe(breadcrumb);
  });
});

describe("initSentry", () => {
  // Import the mock so we can inspect calls
  let mockInit: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const sentry = await import("@sentry/solid");
    mockInit = sentry.init as ReturnType<typeof vi.fn>;
    mockInit.mockClear();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("is a no-op when VITE_SENTRY_DSN is undefined", () => {
    vi.stubEnv("DEV", false);
    // Do not stub VITE_SENTRY_DSN — beforeEach calls vi.unstubAllEnvs() so it is truly undefined
    initSentry();
    expect(mockInit).not.toHaveBeenCalled();
  });

  it("is a no-op when VITE_SENTRY_DSN is empty string", () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_SENTRY_DSN", "");
    initSentry();
    expect(mockInit).not.toHaveBeenCalled();
  });

  it("calls Sentry.init with correct DSN when VITE_SENTRY_DSN is set", () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_SENTRY_DSN", "https://test-key@o1.ingest.us.sentry.io/1");
    initSentry();
    expect(mockInit).toHaveBeenCalledOnce();
    expect(mockInit).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: "https://test-key@o1.ingest.us.sentry.io/1",
      }),
    );
  });

  it("sets allowUrls to a RegExp anchored to window.location.origin", () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_SENTRY_DSN", "https://test-key@o1.ingest.us.sentry.io/1");
    vi.stubGlobal("location", { origin: "https://test.example.com" });
    initSentry();
    const [config] = mockInit.mock.calls[0] as [{ allowUrls: RegExp[] }];
    expect(config.allowUrls).toHaveLength(1);
    expect(config.allowUrls[0]).toBeInstanceOf(RegExp);
    expect(config.allowUrls[0].test("https://test.example.com/path")).toBe(true);
    expect(config.allowUrls[0].test("https://test.example.com.evil.com/path")).toBe(false);
  });
});
