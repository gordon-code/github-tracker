import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent } from "@solidjs/testing-library";


const mockNavigate = vi.fn();

// Mock @solidjs/router to avoid needing a real router context in unit tests.
// useNavigate() requires router context, which the HMR wrapper accesses outside render.
vi.mock("@solidjs/router", () => ({
  useNavigate: () => mockNavigate,
  MemoryRouter: ({ children }: { children: unknown }) => children,
  createMemoryHistory: () => ({ set: vi.fn() }),
  Route: vi.fn(),
  Router: vi.fn(),
}));

// Mock auth store — plain functions match signal accessor signature
vi.mock("../../../src/app/stores/auth", () => ({
  token: () => "test-token",
  user: () => ({
    login: "octocat",
    avatar_url: "https://github.com/images/error/octocat_happy.gif",
    name: "The Octocat",
  }),
  clearAuth: vi.fn(),
}));

// Mock github service
vi.mock("../../../src/app/services/github", () => ({
  getRateLimit: () => null,
}));

import Header from "../../../src/app/components/layout/Header";
import * as authStore from "../../../src/app/stores/auth";
import * as githubService from "../../../src/app/services/github";
import { render } from "@solidjs/testing-library";

beforeEach(() => {
  mockNavigate.mockClear();
  vi.mocked(authStore.clearAuth).mockClear();
});

describe("Header", () => {
  it("renders app title", () => {
    render(() => <Header />);
    screen.getByText("GitHub Tracker");
  });

  it("renders settings link", () => {
    render(() => <Header />);
    const settingsLink = screen.getByLabelText("Settings");
    expect(settingsLink).toBeDefined();
    expect((settingsLink as HTMLAnchorElement).getAttribute("href")).toBe(
      "/settings"
    );
  });

  it("shows user name when authenticated with name", () => {
    render(() => <Header />);
    screen.getByText("The Octocat");
  });

  it("shows user login when name is null", () => {
    vi.spyOn(authStore, "user").mockReturnValue({
      login: "octocat",
      avatar_url: "https://github.com/images/error/octocat_happy.gif",
      name: null,
    });
    render(() => <Header />);
    screen.getByText("octocat");
    vi.mocked(authStore.user).mockRestore();
  });

  it("shows rate limit info when available", () => {
    vi.spyOn(githubService, "getRateLimit").mockReturnValue({
      remaining: 4567,
      resetAt: new Date("2024-01-10T09:00:00Z"),
    });
    render(() => <Header />);
    screen.getByText("4567 req remaining");
    vi.mocked(githubService.getRateLimit).mockRestore();
  });

  it("does not show rate limit when not available", () => {
    render(() => <Header />);
    expect(screen.queryByText(/req remaining/)).toBeNull();
  });

  it("logout button calls clearAuth", () => {
    render(() => <Header />);
    const logoutButton = screen.getByLabelText("Sign out");
    fireEvent.click(logoutButton);
    expect(authStore.clearAuth).toHaveBeenCalledOnce();
  });

  it("renders logout button with correct aria-label", () => {
    render(() => <Header />);
    screen.getByLabelText("Sign out");
  });
});
