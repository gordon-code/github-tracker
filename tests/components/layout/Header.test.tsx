import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";


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
  getCoreRateLimit: () => null,
  getSearchRateLimit: () => null,
  getRateLimit: () => null,
}));

// Mock errors module so Header's notification imports work
vi.mock("../../../src/app/lib/errors", () => ({
  getUnreadCount: vi.fn(() => 0),
  markAllAsRead: vi.fn(),
  getNotifications: vi.fn(() => []),
  clearNotifications: vi.fn(),
  pushNotification: vi.fn(),
  pushError: vi.fn(),
  dismissError: vi.fn(),
  dismissNotificationBySource: vi.fn(),
  getErrors: vi.fn(() => []),
  clearErrors: vi.fn(),
  addMutedSource: vi.fn(),
  isMuted: vi.fn(() => false),
  clearMutedSources: vi.fn(),
}));

import Header from "../../../src/app/components/layout/Header";
import * as authStore from "../../../src/app/stores/auth";
import * as githubService from "../../../src/app/services/github";
import * as errorsModule from "../../../src/app/lib/errors";
import { render } from "@solidjs/testing-library";

beforeEach(() => {
  mockNavigate.mockClear();
  vi.mocked(authStore.clearAuth).mockClear();
  vi.mocked(errorsModule.getUnreadCount).mockReturnValue(0);
  vi.mocked(errorsModule.markAllAsRead).mockClear();
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
    vi.spyOn(githubService, "getCoreRateLimit").mockReturnValue({
      remaining: 4567,
      resetAt: new Date("2024-01-10T09:00:00Z"),
    });
    render(() => <Header />);
    screen.getByText("4567/5k/hr");
    vi.mocked(githubService.getCoreRateLimit).mockRestore();
  });

  it("does not show rate limit when not available", () => {
    render(() => <Header />);
    expect(screen.queryByText(/\/5k\/hr/)).toBeNull();
  });

  it("logout button calls clearAuth", async () => {
    const user = userEvent.setup();
    render(() => <Header />);
    const logoutButton = screen.getByLabelText("Sign out");
    await user.click(logoutButton);
    expect(authStore.clearAuth).toHaveBeenCalledOnce();
  });

  it("renders logout button with correct aria-label", () => {
    render(() => <Header />);
    screen.getByLabelText("Sign out");
  });

  it("bell button renders with aria-label Notifications", () => {
    render(() => <Header />);
    expect(screen.getByLabelText("Notifications")).toBeDefined();
  });

  it("unread badge hidden when unread count is 0", () => {
    vi.mocked(errorsModule.getUnreadCount).mockReturnValue(0);
    render(() => <Header />);
    expect(screen.queryByText("1")).toBeNull();
  });

  it("unread badge shows count when getUnreadCount > 0", () => {
    vi.mocked(errorsModule.getUnreadCount).mockReturnValue(3);
    render(() => <Header />);
    expect(screen.getByText("3")).toBeDefined();
  });

  it("badge shows 9+ when unread count exceeds 9", () => {
    vi.mocked(errorsModule.getUnreadCount).mockReturnValue(10);
    render(() => <Header />);
    expect(screen.getByText("9+")).toBeDefined();
  });

  it("clicking bell button calls markAllAsRead", async () => {
    const user = userEvent.setup();
    render(() => <Header />);
    const bellBtn = screen.getByLabelText("Notifications");
    await user.click(bellBtn);
    expect(errorsModule.markAllAsRead).toHaveBeenCalled();
  });

  it("bell button aria-expanded toggles on click", async () => {
    const user = userEvent.setup();
    render(() => <Header />);
    const bellBtn = screen.getByLabelText("Notifications");
    expect(bellBtn.getAttribute("aria-expanded")).toBe("false");
    await user.click(bellBtn);
    expect(bellBtn.getAttribute("aria-expanded")).toBe("true");
  });

  it("clicking bell twice closes the drawer", async () => {
    const user = userEvent.setup();
    render(() => <Header />);
    const bellBtn = screen.getByLabelText("Notifications");
    await user.click(bellBtn);
    expect(bellBtn.getAttribute("aria-expanded")).toBe("true");
    await user.click(bellBtn);
    expect(bellBtn.getAttribute("aria-expanded")).toBe("false");
    // markAllAsRead called only once (on open, not on close)
    expect(errorsModule.markAllAsRead).toHaveBeenCalledTimes(1);
  });
});
