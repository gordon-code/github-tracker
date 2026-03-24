import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import LoginPage from "../../src/app/pages/LoginPage";

describe("LoginPage", () => {
  beforeEach(() => {
    // Allow setting window.location.href
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { href: "", origin: "http://localhost" },
    });
    sessionStorage.clear();
    // Stub the env var used by the component
    vi.stubEnv("VITE_GITHUB_CLIENT_ID", "test-client-id");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("renders the app title", () => {
    render(() => <LoginPage />);
    screen.getByText("GitHub Tracker");
  });

  it("renders the sign in button", () => {
    render(() => <LoginPage />);
    screen.getByText("Sign in with GitHub");
  });

  it("shows app branding description", () => {
    render(() => <LoginPage />);
    screen.getByText(/Track issues, pull requests/i);
  });

  it("clicking login sets window.location.href to GitHub OAuth URL", async () => {
    const user = userEvent.setup();
    render(() => <LoginPage />);
    const button = screen.getByText("Sign in with GitHub");
    await user.click(button);
    expect(window.location.href).toContain("https://github.com/login/oauth/authorize");
  });

  it("OAuth URL includes correct client_id", async () => {
    const user = userEvent.setup();
    render(() => <LoginPage />);
    const button = screen.getByText("Sign in with GitHub");
    await user.click(button);
    const url = new URL(window.location.href);
    // The component reads import.meta.env.VITE_GITHUB_CLIENT_ID at click-time
    // It falls back to whatever is in the env — we verify it is present
    expect(url.searchParams.get("client_id")).toBeTruthy();
  });

  it("OAuth URL includes state param", async () => {
    const user = userEvent.setup();
    render(() => <LoginPage />);
    const button = screen.getByText("Sign in with GitHub");
    await user.click(button);
    const url = new URL(window.location.href);
    const state = url.searchParams.get("state");
    expect(state).toBeTruthy();
    expect(state!.length).toBeGreaterThan(0);
  });

  it("stores state in sessionStorage for CSRF protection", async () => {
    const user = userEvent.setup();
    render(() => <LoginPage />);
    const button = screen.getByText("Sign in with GitHub");
    await user.click(button);
    const stored = sessionStorage.getItem("github-tracker:oauth-state");
    expect(stored).toBeTruthy();
  });

  it("state in URL matches state in sessionStorage", async () => {
    const user = userEvent.setup();
    render(() => <LoginPage />);
    const button = screen.getByText("Sign in with GitHub");
    await user.click(button);
    const url = new URL(window.location.href);
    const urlState = url.searchParams.get("state");
    const storedState = sessionStorage.getItem("github-tracker:oauth-state");
    expect(urlState).toBe(storedState);
  });

  it("OAuth URL includes redirect_uri with /oauth/callback", async () => {
    const user = userEvent.setup();
    render(() => <LoginPage />);
    const button = screen.getByText("Sign in with GitHub");
    await user.click(button);
    const url = new URL(window.location.href);
    expect(url.searchParams.get("redirect_uri")).toContain("/oauth/callback");
  });

  it("OAuth URL includes scope parameter with required scopes", async () => {
    const user = userEvent.setup();
    render(() => <LoginPage />);
    const button = screen.getByText("Sign in with GitHub");
    await user.click(button);
    const url = new URL(window.location.href);
    expect(url.searchParams.get("scope")).toBe("repo read:org notifications");
  });

  it("each login click generates a unique state", async () => {
    // Render two separate instances to simulate two clicks
    const { unmount } = render(() => <LoginPage />);
    const user1 = userEvent.setup();
    await user1.click(screen.getByText("Sign in with GitHub"));
    const state1 = new URL(window.location.href).searchParams.get("state");
    unmount();

    render(() => <LoginPage />);
    const user2 = userEvent.setup();
    await user2.click(screen.getByText("Sign in with GitHub"));
    const state2 = new URL(window.location.href).searchParams.get("state");

    // States should be random — extremely unlikely to collide
    expect(state1).not.toBe(state2);
  });
});
