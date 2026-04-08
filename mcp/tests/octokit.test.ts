// ── octokit.ts unit tests ──────────────────────────────────────────────────────
// Tests createOctokitClient (write guard), getOptionalOctokitClient (singleton),
// getOctokitClient (throws without token), and validateTokenScopes.

import { describe, it, expect, vi, afterEach } from "vitest";

// ── Write guard tests ─────────────────────────────────────────────────────────

describe("createOctokitClient — write guard hook", () => {
  it("allows GET requests through", async () => {
    const { createOctokitClient } = await import("../src/octokit.js");
    const client = createOctokitClient("fake-token");

    let capturedMethod: string | undefined;
    client.hook.wrap("request", async (_request, options) => {
      capturedMethod = (options.method ?? "GET").toUpperCase();
      return { data: {}, headers: {}, status: 200, url: String(options.url) };
    });

    await client.request("GET /user");
    expect(capturedMethod).toBe("GET");
  });

  it("allows POST /graphql through", async () => {
    const { createOctokitClient } = await import("../src/octokit.js");
    const client = createOctokitClient("fake-token");

    let capturedUrl: string | undefined;
    client.hook.wrap("request", async (_request, options) => {
      capturedUrl = String(options.url);
      return { data: {}, headers: {}, status: 200, url: String(options.url) };
    });

    await client.request("POST /graphql", { query: "{ viewer { login } }" });
    expect(capturedUrl).toBe("/graphql");
  });

  it("blocks PUT requests", async () => {
    const { createOctokitClient } = await import("../src/octokit.js");
    const client = createOctokitClient("fake-token");
    // No hook.wrap — before hook fires and throws before any network call
    await expect(
      client.request("PUT /repos/{owner}/{repo}/contents/{path}" as Parameters<typeof client.request>[0], {
        owner: "o", repo: "r", path: "f.txt", message: "u", content: "dA==", sha: "abc",
      })
    ).rejects.toThrow("Write operation blocked");
  });

  it("blocks DELETE requests", async () => {
    const { createOctokitClient } = await import("../src/octokit.js");
    const client = createOctokitClient("fake-token");
    await expect(
      client.request("DELETE /repos/{owner}/{repo}" as Parameters<typeof client.request>[0], {
        owner: "o", repo: "r",
      })
    ).rejects.toThrow("Write operation blocked");
  });
});

// ── Singleton tests ───────────────────────────────────────────────────────────

describe("getOptionalOctokitClient", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("returns null when GITHUB_TOKEN is not set", async () => {
    delete process.env.GITHUB_TOKEN;
    vi.resetModules();
    const { getOptionalOctokitClient } = await import("../src/octokit.js");
    expect(getOptionalOctokitClient()).toBeNull();
  });

  it("returns an Octokit instance when GITHUB_TOKEN is set", async () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp_testtoken");
    vi.resetModules();
    const { getOptionalOctokitClient } = await import("../src/octokit.js");
    const client = getOptionalOctokitClient();
    expect(client).not.toBeNull();
    expect(typeof client?.request).toBe("function");
  });

  it("returns the same singleton on repeated calls", async () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp_testtoken");
    vi.resetModules();
    const { getOptionalOctokitClient } = await import("../src/octokit.js");
    expect(getOptionalOctokitClient()).toBe(getOptionalOctokitClient());
  });
});

describe("getOctokitClient", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("throws when GITHUB_TOKEN is not set", async () => {
    delete process.env.GITHUB_TOKEN;
    vi.resetModules();
    const { getOctokitClient } = await import("../src/octokit.js");
    expect(() => getOctokitClient()).toThrow("GITHUB_TOKEN");
  });
});

// ── validateTokenScopes ───────────────────────────────────────────────────────

describe("validateTokenScopes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("returns false when GITHUB_TOKEN is not set", async () => {
    delete process.env.GITHUB_TOKEN;
    vi.resetModules();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { validateTokenScopes } = await import("../src/octokit.js");
    expect(await validateTokenScopes()).toBe(false);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("No GITHUB_TOKEN set"));
  });

  it("detects fine-grained PAT (no x-oauth-scopes header)", async () => {
    vi.stubEnv("GITHUB_TOKEN", "github_pat_fake");
    vi.resetModules();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { getOptionalOctokitClient, validateTokenScopes } = await import("../src/octokit.js");
    const client = getOptionalOctokitClient()!;
    vi.spyOn(client, "request").mockResolvedValue({
      data: { login: "testuser" },
      headers: {},
      status: 200,
      url: "",
    } as never);

    expect(await validateTokenScopes()).toBe(true);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("fine-grained PAT"));
  });

  it("validates classic PAT with all required scopes", async () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp_classic");
    vi.resetModules();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { getOptionalOctokitClient, validateTokenScopes } = await import("../src/octokit.js");
    const client = getOptionalOctokitClient()!;
    vi.spyOn(client, "request").mockResolvedValue({
      data: { login: "octocat" },
      headers: { "x-oauth-scopes": "repo, read:org" },
      status: 200,
      url: "",
    } as never);

    expect(await validateTokenScopes()).toBe(true);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("Token validated"));
  });

  it("warns when required scopes are missing", async () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp_limited");
    vi.resetModules();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { getOptionalOctokitClient, validateTokenScopes } = await import("../src/octokit.js");
    const client = getOptionalOctokitClient()!;
    vi.spyOn(client, "request").mockResolvedValue({
      data: { login: "partial" },
      headers: { "x-oauth-scopes": "read:user" },
      status: 200,
      url: "",
    } as never);

    expect(await validateTokenScopes()).toBe(true);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("missing required scopes"));
  });

  it("returns false when request throws", async () => {
    vi.stubEnv("GITHUB_TOKEN", "ghp_bad");
    vi.resetModules();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { getOptionalOctokitClient, validateTokenScopes } = await import("../src/octokit.js");
    const client = getOptionalOctokitClient()!;
    vi.spyOn(client, "request").mockRejectedValue(new Error("401 Unauthorized"));

    expect(await validateTokenScopes()).toBe(false);
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("Token validation failed"),
      expect.stringContaining("401 Unauthorized")
    );
  });
});
