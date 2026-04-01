import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("../../src/app/stores/auth", () => ({
  setAuthFromPat: vi.fn(),
}));

vi.mock("../../src/app/lib/pat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/app/lib/pat")>();
  return {
    ...actual,
    isValidPatFormat: vi.fn(actual.isValidPatFormat),
  };
});

// Mock lazy-loaded component to prevent real imports during prefetch
vi.mock("../../src/app/components/dashboard/DashboardPage", () => ({
  default: () => null,
}));

// Full router mock — per project convention (SolidJS useNavigate requires Route context;
// partial mocks of @solidjs/router render empty divs)
const mockNavigate = vi.fn();
vi.mock("@solidjs/router", () => ({
  useNavigate: () => mockNavigate,
  MemoryRouter: (props: { children: unknown }) => props.children,
  Route: (props: { component: () => unknown }) => props.component(),
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import LoginPage from "../../src/app/pages/LoginPage";
import * as authStore from "../../src/app/stores/auth";
import * as patLib from "../../src/app/lib/pat";

// ── Helpers ───────────────────────────────────────────────────────────────────

const githubUser = { login: "testuser", avatar_url: "https://avatars.githubusercontent.com/u/1", name: "Test User" };

function mockFetchOk() {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(githubUser),
  }));
}

function mockFetch401() {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: false,
    status: 401,
  }));
}

function mockFetch503() {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: false,
    status: 503,
  }));
}

function mockFetchNetworkError() {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchOk();
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { href: "", origin: "http://localhost" },
  });
  sessionStorage.clear();
  vi.stubEnv("VITE_GITHUB_CLIENT_ID", "test-client-id");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("LoginPage — OAuth view (default)", () => {
  it("shows 'Sign in with GitHub' button", () => {
    render(() => <LoginPage />);
    screen.getByText("Sign in with GitHub");
  });

  it("shows 'Use a Personal Access Token' link", () => {
    render(() => <LoginPage />);
    screen.getByText("Use a Personal Access Token");
  });

  it("shows app title and description", () => {
    render(() => <LoginPage />);
    screen.getByText("GitHub Tracker");
    screen.getByText(/Track issues, pull requests/i);
  });

  it("clicking 'Sign in with GitHub' navigates to OAuth URL", async () => {
    const user = userEvent.setup();
    render(() => <LoginPage />);
    await user.click(screen.getByText("Sign in with GitHub"));
    expect(window.location.href).toContain("https://github.com/login/oauth/authorize");
  });

  it("schedules dashboard chunk prefetch on mount", () => {
    // happy-dom lacks requestIdleCallback, so the setTimeout(prefetch, 2000) fallback fires
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    render(() => <LoginPage />);

    // The prefetch is scheduled via setTimeout with 2s delay
    const timeoutCalls = vi.getTimerCount();
    expect(timeoutCalls).toBeGreaterThan(0);

    // Advancing the timer triggers the import — resolves to mock, no error
    vi.advanceTimersByTime(2000);

    // No console.warn means the .catch() didn't fire (import succeeded via mock)
    expect(warnSpy).not.toHaveBeenCalledWith("[app] Dashboard chunk prefetch failed");

    vi.useRealTimers();
    warnSpy.mockRestore();
  });
});

describe("LoginPage — PAT form navigation", () => {
  it("clicking 'Use a Personal Access Token' shows PAT form", async () => {
    const user = userEvent.setup();
    render(() => <LoginPage />);
    await user.click(screen.getByText("Use a Personal Access Token"));
    screen.getByText("Sign in with Token");
    screen.getByLabelText("Personal access token");
  });

  it("PAT form shows submit button and token creation links", async () => {
    const user = userEvent.setup();
    render(() => <LoginPage />);
    await user.click(screen.getByText("Use a Personal Access Token"));
    screen.getByRole("button", { name: "Sign in" });
    screen.getByRole("link", { name: /Classic token/i });
    screen.getByRole("link", { name: /Fine-grained tokens/i });
  });

  it("shows classic token as recommended", async () => {
    const user = userEvent.setup();
    render(() => <LoginPage />);
    await user.click(screen.getByText("Use a Personal Access Token"));
    screen.getByText(/recommended/i);
  });

  it("shows fine-grained limitations inline", async () => {
    const user = userEvent.setup();
    render(() => <LoginPage />);
    await user.click(screen.getByText("Use a Personal Access Token"));
    screen.getByText(/only access one org at a time/i);
  });

  it("clicking 'Use OAuth instead' returns to OAuth view and clears state", async () => {
    const user = userEvent.setup();
    render(() => <LoginPage />);
    await user.click(screen.getByText("Use a Personal Access Token"));
    screen.getByText("Sign in with Token");
    await user.type(screen.getByLabelText("Personal access token"), "ghp_test");
    await user.click(screen.getByText("Use OAuth instead"));
    screen.getByText("Sign in with GitHub");
    expect(screen.queryByText("Sign in with Token")).toBeNull();
  });
});

describe("LoginPage — PAT form validation", () => {
  async function openPatForm() {
    const user = userEvent.setup();
    render(() => <LoginPage />);
    await user.click(screen.getByText("Use a Personal Access Token"));
    return user;
  }

  it("shows validation error for invalid token format", async () => {
    vi.mocked(patLib.isValidPatFormat).mockReturnValueOnce({
      valid: false,
      error: "Token should start with ghp_ (classic) or github_pat_ (fine-grained)",
    });
    const user = await openPatForm();
    await user.type(screen.getByLabelText("Personal access token"), "bad-token");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    screen.getByRole("alert");
    expect(screen.getByRole("alert").textContent).toContain("should start with ghp_");
  });

  it("shows 'Token is invalid' error on 401 from GitHub", async () => {
    vi.mocked(patLib.isValidPatFormat).mockReturnValueOnce({ valid: true });
    mockFetch401();
    const user = await openPatForm();
    await user.type(screen.getByLabelText("Personal access token"), "ghp_" + "a".repeat(36));
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("Token is invalid");
    });
    // Token was never stored — setAuthFromPat should NOT have been called
    expect(authStore.setAuthFromPat).not.toHaveBeenCalled();
  });

  it("shows status-specific error on non-401 HTTP failure", async () => {
    vi.mocked(patLib.isValidPatFormat).mockReturnValueOnce({ valid: true });
    mockFetch503();
    const user = await openPatForm();
    await user.type(screen.getByLabelText("Personal access token"), "ghp_" + "a".repeat(36));
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("503");
    });
    expect(authStore.setAuthFromPat).not.toHaveBeenCalled();
  });

  it("calls setAuthFromPat with token and user data, then navigates", async () => {
    vi.mocked(patLib.isValidPatFormat).mockReturnValueOnce({ valid: true });
    mockFetchOk();
    const user = await openPatForm();
    await user.type(screen.getByLabelText("Personal access token"), "ghp_" + "a".repeat(36));
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/", { replace: true });
    });
    expect(authStore.setAuthFromPat).toHaveBeenCalledWith(
      "ghp_" + "a".repeat(36),
      githubUser,
    );
  });

  it("shows 'Verifying...' and disables button while submitting", async () => {
    vi.mocked(patLib.isValidPatFormat).mockReturnValueOnce({ valid: true });
    let resolveFetch!: (v: Response) => void;
    vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(
      new Promise<Response>((r) => { resolveFetch = r; })
    ));
    const user = await openPatForm();
    await user.type(screen.getByLabelText("Personal access token"), "ghp_" + "a".repeat(36));
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => {
      const btn = screen.getByRole("button", { name: "Verifying..." });
      expect(btn.hasAttribute("disabled")).toBe(true);
    });
    resolveFetch({ ok: true, status: 200, json: () => Promise.resolve(githubUser) } as Response);
  });

  it("re-enables button after successful submission", async () => {
    vi.mocked(patLib.isValidPatFormat).mockReturnValueOnce({ valid: true });
    mockFetchOk();
    const user = await openPatForm();
    await user.type(screen.getByLabelText("Personal access token"), "ghp_" + "a".repeat(36));
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalled();
    });
    // finally block should have run — button no longer disabled
    const btn = screen.getByRole("button", { name: "Sign in" });
    expect(btn.hasAttribute("disabled")).toBe(false);
  });

  it("shows 'Network error' on fetch failure", async () => {
    vi.mocked(patLib.isValidPatFormat).mockReturnValueOnce({ valid: true });
    mockFetchNetworkError();
    const user = await openPatForm();
    await user.type(screen.getByLabelText("Personal access token"), "ghp_" + "a".repeat(36));
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("Network error");
    });
    expect(authStore.setAuthFromPat).not.toHaveBeenCalled();
  });

  it("re-enables button after network error", async () => {
    vi.mocked(patLib.isValidPatFormat).mockReturnValueOnce({ valid: true });
    mockFetchNetworkError();
    const user = await openPatForm();
    await user.type(screen.getByLabelText("Personal access token"), "ghp_" + "a".repeat(36));
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => {
      screen.getByRole("alert");
    });
    const btn = screen.getByRole("button", { name: "Sign in" });
    expect(btn.hasAttribute("disabled")).toBe(false);
  });

  it("does not navigate when user switches to OAuth during validation", async () => {
    vi.mocked(patLib.isValidPatFormat).mockReturnValueOnce({ valid: true });
    let resolveFetch!: (v: Response) => void;
    vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(
      new Promise<Response>((r) => { resolveFetch = r; })
    ));
    const user = await openPatForm();
    await user.type(screen.getByLabelText("Personal access token"), "ghp_" + "a".repeat(36));
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => {
      screen.getByRole("button", { name: "Verifying..." });
    });
    // User switches back to OAuth view while fetch is in-flight
    await user.click(screen.getByText("Use OAuth instead"));
    // Resolve fetch as successful — but user already left
    resolveFetch({ ok: true, status: 200, json: () => Promise.resolve(githubUser) } as Response);
    // Wait for async handler to settle
    await waitFor(() => {
      expect(authStore.setAuthFromPat).not.toHaveBeenCalled();
    });
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
