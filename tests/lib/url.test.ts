import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isSafeGitHubUrl, openGitHubUrl } from "../../src/app/lib/url";

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
