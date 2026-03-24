import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@solidjs/testing-library";
import { MemoryRouter, Route } from "@solidjs/router";

// Mock auth store before importing the component
vi.mock("../../src/app/stores/auth", () => ({
  setAuth: vi.fn(),
  validateToken: vi.fn(),
}));

import * as authStore from "../../src/app/stores/auth";
import OAuthCallback from "../../src/app/pages/OAuthCallback";

/** Render OAuthCallback inside a proper router context (useNavigate requires a Route). */
function renderCallback() {
  return render(() => (
    <MemoryRouter>
      <Route path="*" component={OAuthCallback} />
    </MemoryRouter>
  ));
}

describe("OAuthCallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function setWindowSearch(params: Record<string, string>) {
    const search = "?" + new URLSearchParams(params).toString();
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: {
        href: `http://localhost/oauth/callback${search}`,
        search,
        origin: "http://localhost",
        pathname: "/oauth/callback",
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

  function setupValidState() {
    sessionStorage.setItem("github-tracker:oauth-state", "teststate");
  }

  it("shows loading state while exchanging code", async () => {
    setupValidState();
    setWindowSearch({ code: "fakecode", state: "teststate" });

    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));

    renderCallback();
    screen.getByText(/Completing sign in/i);
  });

  it("calls Worker OAuth endpoint with code on success", async () => {
    setupValidState();
    setWindowSearch({ code: "fakecode", state: "teststate" });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "tok123" }),
    });
    vi.stubGlobal("fetch", mockFetch);
    vi.mocked(authStore.validateToken).mockResolvedValue(true);

    renderCallback();

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/oauth/token",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ code: "fakecode" }),
        })
      );
    });
  });

  it("on success calls setAuth and validateToken", async () => {
    setupValidState();
    setWindowSearch({ code: "fakecode", state: "teststate" });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ access_token: "tok123" }),
      })
    );
    vi.mocked(authStore.validateToken).mockResolvedValue(true);

    renderCallback();

    await waitFor(() => {
      expect(authStore.setAuth).toHaveBeenCalledWith({ access_token: "tok123" });
      expect(authStore.validateToken).toHaveBeenCalled();
    });
  });

  it("passes token response (access_token, token_type) to setAuth", async () => {
    setupValidState();
    setWindowSearch({ code: "fakecode", state: "teststate" });

    const fullResponse = {
      access_token: "tok123",
      token_type: "bearer",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => fullResponse })
    );
    vi.mocked(authStore.validateToken).mockResolvedValue(true);

    renderCallback();

    await waitFor(() => {
      expect(authStore.setAuth).toHaveBeenCalledWith(fullResponse);
    });
  });

  it("shows error when OAuth endpoint returns non-ok response", async () => {
    setupValidState();
    setWindowSearch({ code: "fakecode", state: "teststate" });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ error: "bad_verification_code" }),
      })
    );

    renderCallback();

    await waitFor(() => {
      screen.getByText(/Failed to complete sign in/i);
    });
  });

  it("shows retry link on error", async () => {
    setupValidState();
    setWindowSearch({ code: "fakecode", state: "teststate" });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ error: "bad_code" }),
      })
    );

    renderCallback();

    await waitFor(() => {
      screen.getByText(/Return to sign in/i);
    });
  });

  it("handles network error with error message", async () => {
    setupValidState();
    setWindowSearch({ code: "fakecode", state: "teststate" });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

    renderCallback();

    await waitFor(() => {
      screen.getByText(/network error/i);
    });
  });

  it("shows CSRF error when state param is missing from URL", async () => {
    sessionStorage.setItem("github-tracker:oauth-state", "teststate");
    setWindowSearch({ code: "fakecode" }); // no state param

    renderCallback();

    await waitFor(() => {
      screen.getByText(/Invalid OAuth state/i);
    });
  });

  it("shows CSRF error when state param does not match sessionStorage", async () => {
    sessionStorage.setItem("github-tracker:oauth-state", "expected-state");
    setWindowSearch({ code: "fakecode", state: "wrong-state" });

    renderCallback();

    await waitFor(() => {
      screen.getByText(/Invalid OAuth state/i);
    });
  });

  it("shows CSRF error when sessionStorage has no stored state", async () => {
    setWindowSearch({ code: "fakecode", state: "teststate" });

    renderCallback();

    await waitFor(() => {
      screen.getByText(/Invalid OAuth state/i);
    });
  });

  it("sessionStorage state key is removed after mount (single-use)", async () => {
    setupValidState();
    setWindowSearch({ code: "fakecode", state: "teststate" });

    // Keep fetch pending so component stays mounted
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));

    renderCallback();

    // onMount runs asynchronously — wait for the key to be cleared
    await waitFor(() => {
      expect(sessionStorage.getItem("github-tracker:oauth-state")).toBeNull();
    });
  });

  it("clears CSRF state BEFORE calling the token exchange fetch", async () => {
    setupValidState();
    setWindowSearch({ code: "fakecode", state: "teststate" });

    // The fetch mock checks that sessionStorage was already cleared when it's called.
    // If the code clears state AFTER fetch, this assertion fails.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        expect(sessionStorage.getItem("github-tracker:oauth-state")).toBeNull();
        return new Promise(() => {}); // keep pending
      })
    );

    renderCallback();

    await waitFor(() => {
      expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledOnce();
    });
  });

  it("handles missing code param", async () => {
    sessionStorage.setItem("github-tracker:oauth-state", "teststate");
    setWindowSearch({ state: "teststate" });

    renderCallback();

    await waitFor(() => {
      screen.getByText(/No authorization code/i);
    });
  });

});
