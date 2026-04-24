import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@solidjs/testing-library";
import { MemoryRouter, Route } from "@solidjs/router";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("../../src/app/stores/auth", () => ({
  setJiraAuth: vi.fn(),
}));

vi.mock("../../src/app/stores/config", () => ({
  updateJiraConfig: vi.fn(),
  config: { jira: { enabled: false, authMethod: "oauth", issueKeyDetection: true } },
}));

vi.mock("../../src/app/lib/proxy", () => ({
  acquireTurnstileToken: vi.fn().mockResolvedValue("mock-turnstile-token"),
}));

vi.mock("../../src/app/services/jira-client", () => ({
  JiraClient: {
    getAccessibleResources: vi.fn(),
  },
}));

import * as authStore from "../../src/app/stores/auth";
import * as configStore from "../../src/app/stores/config";
import * as proxyLib from "../../src/app/lib/proxy";
import { JiraClient } from "../../src/app/services/jira-client";
import { JIRA_OAUTH_STATE_KEY } from "../../src/app/lib/oauth";
import JiraCallback from "../../src/app/pages/JiraCallback";

// ── Helpers ───────────────────────────────────────────────────────────────────

function renderCallback() {
  return render(() => (
    <MemoryRouter>
      <Route path="*" component={JiraCallback} />
    </MemoryRouter>
  ));
}

function setWindowSearch(params: Record<string, string>) {
  const search = "?" + new URLSearchParams(params).toString();
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: {
      href: `http://localhost/jira/callback${search}`,
      search,
      origin: "http://localhost",
      pathname: "/jira/callback",
      hash: "",
      hostname: "localhost",
      port: "",
      protocol: "http:",
      host: "localhost",
      assign: vi.fn(),
      replace: vi.fn(),
      reload: vi.fn(),
    },
  });
}

function setupValidState(state = "valid-jira-state") {
  sessionStorage.setItem(JIRA_OAUTH_STATE_KEY, state);
}

function makeResource(id = "cloud-abc", name = "My Site", url = "https://mysite.atlassian.net") {
  return { id, name, url, scopes: ["read:jira-work"] };
}

function mockSuccessfulExchange() {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      access_token: "atl-access-tok",
      sealed_refresh_token: "sealed-refresh-blob",
      expires_in: 3600,
    }),
  }));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("JiraCallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // ── Loading state ─────────────────────────────────────────────────────────

  it("shows loading state while exchange is in flight", async () => {
    setupValidState();
    setWindowSearch({ code: "jira-code", state: "valid-jira-state" });
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    vi.mocked(proxyLib.acquireTurnstileToken).mockResolvedValue("tok");
    vi.mocked(JiraClient.getAccessibleResources).mockResolvedValue([]);

    renderCallback();
    screen.getByText(/Connecting Jira/i);
  });

  // ── State / CSRF errors ───────────────────────────────────────────────────

  it("shows error when state param is missing from URL", async () => {
    setupValidState();
    setWindowSearch({ code: "jira-code" }); // no state

    renderCallback();

    await waitFor(() => {
      expect(screen.getByText(/Invalid OAuth state/i)).toBeTruthy();
    });
  });

  it("shows error when state param does not match sessionStorage", async () => {
    sessionStorage.setItem(JIRA_OAUTH_STATE_KEY, "expected-state");
    setWindowSearch({ code: "jira-code", state: "wrong-state" });

    renderCallback();

    await waitFor(() => {
      expect(screen.getByText(/Invalid OAuth state/i)).toBeTruthy();
    });
  });

  it("shows error when sessionStorage has no stored state", async () => {
    setWindowSearch({ code: "jira-code", state: "valid-jira-state" });
    // No sessionStorage.setItem — state key missing

    renderCallback();

    await waitFor(() => {
      expect(screen.getByText(/Invalid OAuth state/i)).toBeTruthy();
    });
  });

  it("sessionStorage state key is consumed (removed) after mount", async () => {
    setupValidState();
    setWindowSearch({ code: "jira-code", state: "valid-jira-state" });
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {}))); // keep pending

    renderCallback();

    await waitFor(() => {
      expect(sessionStorage.getItem(JIRA_OAUTH_STATE_KEY)).toBeNull();
    });
  });

  // ── Missing code ──────────────────────────────────────────────────────────

  it("shows error when code is missing from URL", async () => {
    setupValidState();
    setWindowSearch({ state: "valid-jira-state" }); // no code

    renderCallback();

    await waitFor(() => {
      expect(screen.getByText(/No authorization code/i)).toBeTruthy();
    });
  });

  // ── Token exchange failures ───────────────────────────────────────────────

  it("shows error when token exchange returns non-ok response", async () => {
    setupValidState();
    setWindowSearch({ code: "jira-code", state: "valid-jira-state" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: "invalid_code" }),
    }));

    renderCallback();

    await waitFor(() => {
      expect(screen.getByText(/Failed to complete Jira sign in/i)).toBeTruthy();
    });
  });

  it("shows error on network error during token exchange", async () => {
    setupValidState();
    setWindowSearch({ code: "jira-code", state: "valid-jira-state" });
    vi.mocked(proxyLib.acquireTurnstileToken).mockResolvedValue("tok");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    renderCallback();

    await waitFor(() => {
      expect(screen.getByText(/network error/i)).toBeTruthy();
    });
  });

  it("shows error when Turnstile fails", async () => {
    setupValidState();
    setWindowSearch({ code: "jira-code", state: "valid-jira-state" });
    vi.mocked(proxyLib.acquireTurnstileToken).mockRejectedValue(new Error("Turnstile failed"));
    vi.stubGlobal("fetch", vi.fn());

    renderCallback();

    await waitFor(() => {
      expect(screen.getByText(/Human verification failed/i)).toBeTruthy();
    });
  });

  // ── Empty sites ───────────────────────────────────────────────────────────

  it.skip("shows error when no Jira sites found", async () => {
    setupValidState();
    setWindowSearch({ code: "jira-code", state: "valid-jira-state" });
    mockSuccessfulExchange();
    vi.mocked(JiraClient.getAccessibleResources).mockResolvedValue([]);

    renderCallback();

    await waitFor(() => {
      expect(screen.getByText(/No Jira Cloud sites found/i)).toBeTruthy();
    });
  });

  // ── Single site auto-select ───────────────────────────────────────────────

  it.skip("auto-selects single site and calls setJiraAuth + updateJiraConfig", async () => {
    setupValidState();
    setWindowSearch({ code: "jira-code", state: "valid-jira-state" });
    mockSuccessfulExchange();
    vi.mocked(JiraClient.getAccessibleResources).mockResolvedValue([
      makeResource("cloud-abc", "My Site", "https://mysite.atlassian.net"),
    ]);

    renderCallback();

    await waitFor(() => {
      expect(vi.mocked(authStore.setJiraAuth)).toHaveBeenCalledWith(
        expect.objectContaining({
          accessToken: "atl-access-tok",
          sealedRefreshToken: "sealed-refresh-blob",
          cloudId: "cloud-abc",
          siteUrl: "https://mysite.atlassian.net",
          siteName: "My Site",
        })
      );
    });

    expect(vi.mocked(configStore.updateJiraConfig)).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        cloudId: "cloud-abc",
        authMethod: "oauth",
      })
    );
  });

  it("exchange POST sends code in body and Turnstile token in header", async () => {
    setupValidState();
    setWindowSearch({ code: "my-jira-code", state: "valid-jira-state" });
    vi.mocked(proxyLib.acquireTurnstileToken).mockResolvedValue("test-turnstile-tok");
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "tok",
        sealed_refresh_token: "s",
        expires_in: 3600,
      }),
    });
    vi.stubGlobal("fetch", mockFetch);
    vi.mocked(JiraClient.getAccessibleResources).mockResolvedValue([
      makeResource(),
    ]);

    renderCallback();

    await waitFor(() => {
      expect(vi.mocked(authStore.setJiraAuth)).toHaveBeenCalled();
    });

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/oauth/jira/token");
    expect(JSON.parse(init.body as string)).toEqual({ code: "my-jira-code" });
    const headers = init.headers as Record<string, string>;
    expect(headers["cf-turnstile-response"]).toBe("test-turnstile-tok");
  });

  // ── Multi-site picker ─────────────────────────────────────────────────────

  it("shows site picker when multiple Jira sites returned", async () => {
    setupValidState();
    setWindowSearch({ code: "jira-code", state: "valid-jira-state" });
    mockSuccessfulExchange();
    vi.mocked(JiraClient.getAccessibleResources).mockResolvedValue([
      makeResource("cloud-a", "Site Alpha", "https://alpha.atlassian.net"),
      makeResource("cloud-b", "Site Beta", "https://beta.atlassian.net"),
    ]);

    renderCallback();

    await waitFor(() => {
      expect(screen.getByText("Site Alpha")).toBeTruthy();
      expect(screen.getByText("Site Beta")).toBeTruthy();
    });
    expect(screen.getByText(/Connect Jira Site/i)).toBeTruthy();
  });

  it("setJiraAuth is NOT called before site picker selection", async () => {
    setupValidState();
    setWindowSearch({ code: "jira-code", state: "valid-jira-state" });
    mockSuccessfulExchange();
    vi.mocked(JiraClient.getAccessibleResources).mockResolvedValue([
      makeResource("cloud-a", "Site Alpha"),
      makeResource("cloud-b", "Site Beta"),
    ]);

    renderCallback();

    await waitFor(() => {
      expect(screen.getByText("Site Alpha")).toBeTruthy();
    });
    expect(vi.mocked(authStore.setJiraAuth)).not.toHaveBeenCalled();
  });

  it("selecting a site in the picker calls setJiraAuth + updateJiraConfig", async () => {
    setupValidState();
    setWindowSearch({ code: "jira-code", state: "valid-jira-state" });
    mockSuccessfulExchange();
    vi.mocked(JiraClient.getAccessibleResources).mockResolvedValue([
      makeResource("cloud-a", "Site Alpha", "https://alpha.atlassian.net"),
      makeResource("cloud-b", "Site Beta", "https://beta.atlassian.net"),
    ]);

    renderCallback();

    await waitFor(() => {
      expect(screen.getByText("Site Beta")).toBeTruthy();
    });

    // Click the "Site Beta" button
    screen.getByText("Site Beta").closest("button")!.click();

    await waitFor(() => {
      expect(vi.mocked(authStore.setJiraAuth)).toHaveBeenCalledWith(
        expect.objectContaining({
          cloudId: "cloud-b",
          siteName: "Site Beta",
          siteUrl: "https://beta.atlassian.net",
        })
      );
    });
    expect(vi.mocked(configStore.updateJiraConfig)).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, cloudId: "cloud-b", authMethod: "oauth" })
    );
  });

  // ── CORS fallback for accessible-resources ────────────────────────────────

  it("falls back to Worker proxy when getAccessibleResources throws", async () => {
    setupValidState();
    setWindowSearch({ code: "jira-code", state: "valid-jira-state" });
    vi.mocked(JiraClient.getAccessibleResources).mockRejectedValue(new Error("CORS error"));

    const sites = [makeResource("cloud-abc", "My Site", "https://mysite.atlassian.net")];
    const exchangeMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: "atl-access-tok",
          sealed_refresh_token: "sealed-refresh-blob",
          expires_in: 3600,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => sites,
      });
    vi.stubGlobal("fetch", exchangeMock);

    renderCallback();

    await waitFor(() => {
      expect(vi.mocked(authStore.setJiraAuth)).toHaveBeenCalled();
    });

    // Second fetch call should be to /api/oauth/jira/resources
    const [fallbackUrl] = exchangeMock.mock.calls[1] as [string];
    expect(fallbackUrl).toBe("/api/oauth/jira/resources");
  });

  it("shows error when fallback accessible-resources call also fails", async () => {
    setupValidState();
    setWindowSearch({ code: "jira-code", state: "valid-jira-state" });
    vi.mocked(JiraClient.getAccessibleResources).mockRejectedValue(new Error("CORS error"));

    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: "atl-tok",
          sealed_refresh_token: "sealed",
          expires_in: 3600,
        }),
      })
      .mockResolvedValueOnce({ ok: false, status: 500 })
    );

    renderCallback();

    await waitFor(() => {
      expect(screen.getByText(/Failed to discover Jira sites/i)).toBeTruthy();
    });
  });

  it("shows return-to-settings link on error", async () => {
    setupValidState("mismatch");
    setWindowSearch({ code: "jira-code", state: "valid-jira-state" });

    renderCallback();

    await waitFor(() => {
      expect(screen.getByText(/Return to Settings/i)).toBeTruthy();
    });
  });
});
