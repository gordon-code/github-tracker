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
    const result = beforeBreadcrumbHandler(breadcrumb as never);
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
    const result = beforeBreadcrumbHandler(breadcrumb as never);
    expect(result!.data!.url).toBe(
      "https://api.github.com?access_token=[REDACTED]",
    );
  });

  it("scrubs xhr breadcrumb URLs", () => {
    const breadcrumb = {
      category: "xhr",
      data: { url: "https://api.github.com?code=abc" },
    };
    const result = beforeBreadcrumbHandler(breadcrumb as never);
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
    vi.stubGlobal("location", { ...window.location, origin: "https://test.example.com" });
    initSentry();
    const [config] = mockInit.mock.calls[0] as [{ allowUrls: RegExp[] }];
    expect(config.allowUrls).toHaveLength(1);
    expect(config.allowUrls[0]).toBeInstanceOf(RegExp);
    expect(config.allowUrls[0].test("https://test.example.com/path")).toBe(true);
    expect(config.allowUrls[0].test("https://test.example.com.evil.com/path")).toBe(false);
  });
});
