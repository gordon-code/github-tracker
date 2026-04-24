import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  generateOAuthState,
  buildAuthorizeUrl,
  buildOrgAccessUrl,
  sanitizeReturnTo,
  OAUTH_STATE_KEY,
  OAUTH_RETURN_TO_KEY,
} from "../../src/app/lib/oauth";

describe("oauth helpers", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.stubEnv("VITE_GITHUB_CLIENT_ID", "test-client-id");
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { href: "", origin: "http://localhost" },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("generateOAuthState", () => {
    it("returns a non-empty string", () => {
      const state = generateOAuthState();
      expect(state).toBeTruthy();
      expect(state.length).toBeGreaterThan(0);
    });

    it("returns a base64url string — no +, /, or = characters", () => {
      const state = generateOAuthState();
      expect(state).not.toMatch(/[+/=]/);
    });

    it("generates unique values each call", () => {
      const s1 = generateOAuthState();
      const s2 = generateOAuthState();
      expect(s1).not.toBe(s2);
    });
  });

  describe("buildAuthorizeUrl", () => {
    it("stores state in sessionStorage under OAUTH_STATE_KEY", () => {
      buildAuthorizeUrl();
      expect(sessionStorage.getItem(OAUTH_STATE_KEY)).toBeTruthy();
    });

    it("stores returnTo in sessionStorage when provided", () => {
      buildAuthorizeUrl({ returnTo: "/settings" });
      expect(sessionStorage.getItem(OAUTH_RETURN_TO_KEY)).toBe("/settings");
    });

    it("does not set OAUTH_RETURN_TO_KEY when returnTo not provided", () => {
      buildAuthorizeUrl();
      expect(sessionStorage.getItem(OAUTH_RETURN_TO_KEY)).toBeNull();
    });

    it("clears a pre-existing OAUTH_RETURN_TO_KEY when returnTo not provided", () => {
      sessionStorage.setItem(OAUTH_RETURN_TO_KEY, "/settings");
      buildAuthorizeUrl();
      expect(sessionStorage.getItem(OAUTH_RETURN_TO_KEY)).toBeNull();
    });

    it("URL contains client_id param", () => {
      const url = new URL(buildAuthorizeUrl());
      expect(url.searchParams.get("client_id")).toBe("test-client-id");
    });

    it("URL contains redirect_uri param with /oauth/callback", () => {
      const url = new URL(buildAuthorizeUrl());
      expect(url.searchParams.get("redirect_uri")).toContain("/oauth/callback");
    });

    it("URL contains scope param", () => {
      const url = new URL(buildAuthorizeUrl());
      expect(url.searchParams.get("scope")).toBeTruthy();
    });

    it("scope value is 'repo read:org'", () => {
      const url = new URL(buildAuthorizeUrl());
      expect(url.searchParams.get("scope")).toBe("repo read:org");
    });

    it("URL contains state param matching sessionStorage", () => {
      const url = new URL(buildAuthorizeUrl());
      const urlState = url.searchParams.get("state");
      const storedState = sessionStorage.getItem(OAUTH_STATE_KEY);
      expect(urlState).toBeTruthy();
      expect(urlState).toBe(storedState);
    });

    it("URL points to GitHub authorize endpoint", () => {
      const url = buildAuthorizeUrl();
      expect(url).toContain("https://github.com/login/oauth/authorize");
    });
  });

  describe("buildOrgAccessUrl", () => {
    it("returns GitHub connections URL with client ID", () => {
      const url = buildOrgAccessUrl();
      expect(url).toBe(
        "https://github.com/settings/connections/applications/test-client-id"
      );
    });

    it("throws for undefined client ID", () => {
      vi.stubEnv("VITE_GITHUB_CLIENT_ID", "");
      expect(() => buildOrgAccessUrl()).toThrow("Invalid VITE_GITHUB_CLIENT_ID");
      vi.unstubAllEnvs();
      vi.stubEnv("VITE_GITHUB_CLIENT_ID", "test-client-id");
    });

    it("throws for client ID with path traversal characters", () => {
      vi.stubEnv("VITE_GITHUB_CLIENT_ID", "../../../evil");
      expect(() => buildOrgAccessUrl()).toThrow("Invalid VITE_GITHUB_CLIENT_ID");
      vi.unstubAllEnvs();
      vi.stubEnv("VITE_GITHUB_CLIENT_ID", "test-client-id");
    });
  });

  describe("sanitizeReturnTo", () => {
    it("accepts internal paths", () => {
      expect(sanitizeReturnTo("/settings")).toBe("/settings");
      expect(sanitizeReturnTo("/dashboard")).toBe("/dashboard");
      expect(sanitizeReturnTo("/")).toBe("/");
    });

    it("rejects absolute URLs", () => {
      expect(sanitizeReturnTo("https://evil.com")).toBe("/");
    });

    it("rejects protocol-relative URLs", () => {
      expect(sanitizeReturnTo("//evil.com")).toBe("/");
    });

    it("rejects javascript: URIs", () => {
      expect(sanitizeReturnTo("javascript:alert(1)")).toBe("/");
    });

    it("returns / for null", () => {
      expect(sanitizeReturnTo(null)).toBe("/");
    });

    it("returns / for empty string", () => {
      expect(sanitizeReturnTo("")).toBe("/");
    });
  });
});
