import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isSafeGitHubUrl, isSafeJiraSiteUrl, openGitHubUrl, sizedAvatarUrl } from "../../src/app/lib/url";

describe("isSafeGitHubUrl", () => {
  it("returns true for a root GitHub URL", () => {
    expect(isSafeGitHubUrl("https://github.com/owner/repo")).toBe(true);
  });

  it("returns true for a GitHub issue URL", () => {
    expect(isSafeGitHubUrl("https://github.com/owner/repo/issues/1")).toBe(true);
  });

  it("returns true for a GitHub PR URL", () => {
    expect(isSafeGitHubUrl("https://github.com/owner/repo/pull/42")).toBe(true);
  });

  it("returns false for a non-GitHub domain", () => {
    expect(isSafeGitHubUrl("https://evil.com")).toBe(false);
  });

  it("returns false for a domain that embeds github.com as a subdomain prefix", () => {
    expect(isSafeGitHubUrl("https://github.com.evil.com/foo")).toBe(false);
  });

  it("returns false for http (non-HTTPS)", () => {
    expect(isSafeGitHubUrl("http://github.com/foo")).toBe(false);
  });

  it("returns false for a subdomain of github.com", () => {
    expect(isSafeGitHubUrl("https://fake.github.com/foo")).toBe(false);
  });

  it("returns false for a malformed string", () => {
    expect(isSafeGitHubUrl("not-a-url")).toBe(false);
  });

  it("returns false for an empty string", () => {
    expect(isSafeGitHubUrl("")).toBe(false);
  });

  it("returns false for api.github.com", () => {
    expect(isSafeGitHubUrl("https://api.github.com/repos/owner/repo")).toBe(false);
  });
});

describe("isSafeJiraSiteUrl", () => {
  it("returns true for a valid atlassian.net site URL", () => {
    expect(isSafeJiraSiteUrl("https://mysite.atlassian.net")).toBe(true);
  });

  it("returns true for a valid atlassian.net URL with a path", () => {
    expect(isSafeJiraSiteUrl("https://mysite.atlassian.net/browse/PROJ-1")).toBe(true);
  });

  it("returns false for http (non-HTTPS)", () => {
    expect(isSafeJiraSiteUrl("http://mysite.atlassian.net")).toBe(false);
  });

  it("returns false for bare atlassian.net (no subdomain)", () => {
    expect(isSafeJiraSiteUrl("https://atlassian.net")).toBe(false);
  });

  it("returns false for a non-atlassian.net domain", () => {
    expect(isSafeJiraSiteUrl("https://evil.com")).toBe(false);
  });

  it("returns false for a multi-level subdomain (evil.foo.atlassian.net)", () => {
    expect(isSafeJiraSiteUrl("https://evil.foo.atlassian.net")).toBe(false);
  });

  it("returns false for a javascript: URL", () => {
    expect(isSafeJiraSiteUrl("javascript:alert(1)")).toBe(false);
  });

  it("returns false for an empty string", () => {
    expect(isSafeJiraSiteUrl("")).toBe(false);
  });
});

describe("openGitHubUrl", () => {
  beforeEach(() => {
    vi.spyOn(window, "open").mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls window.open with correct params for a valid GitHub URL", () => {
    const url = "https://github.com/owner/repo/issues/1";
    openGitHubUrl(url);
    expect(window.open).toHaveBeenCalledWith(url, "_blank", "noopener,noreferrer");
  });

  it("does NOT call window.open for an invalid URL", () => {
    openGitHubUrl("https://evil.com/path");
    expect(window.open).not.toHaveBeenCalled();
  });

  it("does NOT call window.open for an empty string", () => {
    openGitHubUrl("");
    expect(window.open).not.toHaveBeenCalled();
  });

  it("does NOT call window.open for a non-HTTPS GitHub URL", () => {
    openGitHubUrl("http://github.com/owner/repo");
    expect(window.open).not.toHaveBeenCalled();
  });
});

describe("sizedAvatarUrl", () => {
  it("adds the s query param to an avatars.githubusercontent.com URL", () => {
    expect(sizedAvatarUrl("https://avatars.githubusercontent.com/u/583231", 40)).toBe(
      "https://avatars.githubusercontent.com/u/583231?s=40",
    );
  });

  it("replaces an existing s query param while preserving other query params", () => {
    expect(sizedAvatarUrl("https://avatars.githubusercontent.com/u/583231?v=4&s=200", 56)).toBe(
      "https://avatars.githubusercontent.com/u/583231?v=4&s=56",
    );
  });

  it("returns non-GitHub avatar host URLs unchanged", () => {
    const nonGitHub = "https://example.com/avatar.png";
    expect(sizedAvatarUrl(nonGitHub, 40)).toBe(nonGitHub);
    expect(sizedAvatarUrl("https://github.com/images/error/octocat_happy.gif", 56)).toBe(
      "https://github.com/images/error/octocat_happy.gif",
    );
  });

  it("returns non-HTTPS avatars.githubusercontent.com URLs unchanged", () => {
    const httpUrl = "http://avatars.githubusercontent.com/u/583231";
    expect(sizedAvatarUrl(httpUrl, 40)).toBe(httpUrl);
  });

  it("returns bare root path on avatars.githubusercontent.com unchanged", () => {
    const rootUrl = "https://avatars.githubusercontent.com/";
    expect(sizedAvatarUrl(rootUrl, 40)).toBe(rootUrl);
  });

  it("returns invalid URLs and empty strings unchanged", () => {
    expect(sizedAvatarUrl("not-a-url", 40)).toBe("not-a-url");
    expect(sizedAvatarUrl("", 40)).toBe("");
  });
});
