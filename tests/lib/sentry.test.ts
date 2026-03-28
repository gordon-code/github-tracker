import { describe, it, expect } from "vitest";
import {
  scrubUrl,
  beforeSendHandler,
  beforeBreadcrumbHandler,
} from "../../src/app/lib/sentry";

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

  it("deletes request headers and cookies", () => {
    const event = {
      request: {
        url: "https://gh.gordoncode.dev",
        headers: { Authorization: "Bearer ghu_token" },
        cookies: "session=abc",
      },
    };
    const result = beforeSendHandler(event as never);
    expect(result!.request!.headers).toBeUndefined();
    expect(result!.request!.cookies).toBeUndefined();
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
    const prefixes = ["[auth]", "[api]", "[poll]", "[dashboard]", "[settings]"];
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
