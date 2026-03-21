import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@solidjs/testing-library";

// Module-level variables to control mock return values
let mockToken: string | null = null;
let mockIsAuthenticated = false;
// validateToken mock fn — replaced per-test
let mockValidateToken: () => Promise<boolean> = async () => false;

vi.mock("../../src/app/stores/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/app/stores/auth")>();
  return {
    ...actual,
    token: () => mockToken,
    isAuthenticated: () => mockIsAuthenticated,
    validateToken: vi.fn(async () => mockValidateToken()),
  };
});

vi.mock("../../src/app/stores/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/app/stores/config")>();
  return {
    ...actual,
    initConfigPersistence: vi.fn(),
  };
});

vi.mock("../../src/app/stores/view", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/app/stores/view")>();
  return {
    ...actual,
    initViewPersistence: vi.fn(),
  };
});

vi.mock("../../src/app/services/github", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/app/services/github")>();
  return {
    ...actual,
    initClientWatcher: vi.fn(),
    getClient: vi.fn().mockReturnValue(null),
  };
});

vi.mock("../../src/app/stores/cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/app/stores/cache")>();
  return {
    ...actual,
    evictStaleEntries: vi.fn().mockResolvedValue(undefined),
  };
});

// Mock heavy page/component dependencies
vi.mock("../../src/app/components/dashboard/DashboardPage", () => ({
  default: () => <div data-testid="dashboard-page">Dashboard</div>,
}));
vi.mock("../../src/app/components/onboarding/OnboardingWizard", () => ({
  default: () => <div data-testid="onboarding-wizard">Onboarding</div>,
}));
vi.mock("../../src/app/components/settings/SettingsPage", () => ({
  default: () => <div data-testid="settings-page">Settings</div>,
}));

import * as configStore from "../../src/app/stores/config";
import * as authStore from "../../src/app/stores/auth";
import * as githubService from "../../src/app/services/github";
import * as cacheStore from "../../src/app/stores/cache";
import * as viewStore from "../../src/app/stores/view";
import App from "../../src/app/App";

describe("App", () => {
  beforeEach(() => {
    // Reset all mock state (implementations, calls, return values)
    vi.resetAllMocks();
    mockToken = null;
    mockIsAuthenticated = false;
    mockValidateToken = async () => false;
    // Re-apply default mock implementations that are needed across tests
    vi.mocked(cacheStore.evictStaleEntries).mockResolvedValue(0);
    // Reset config to defaults
    configStore.updateConfig({ onboardingComplete: false });
    // Reset browser URL to / — SolidJS Router reads window.location, and navigate()
    // mutates it. Without resetting, subsequent test renders start at the wrong path.
    if (window.location.pathname !== "/") {
      window.history.pushState({}, "", "/");
    }
  });

  it("shows loading spinner initially (RootRedirect validating)", async () => {
    mockToken = "tok";
    mockIsAuthenticated = true;
    vi.mocked(authStore.validateToken).mockReturnValue(new Promise(() => {}));

    render(() => <App />);
    screen.getByLabelText("Loading");
  });

  it("redirects to /login when not authenticated", async () => {
    mockToken = null;
    mockIsAuthenticated = false;
    mockValidateToken = async () => false;

    render(() => <App />);

    await waitFor(() => {
      screen.getByText("Sign in with GitHub");
    });
  });

  it("redirects to /onboarding when authenticated but onboarding incomplete", async () => {
    // token=null → validateToken NOT called → setValidating(false) is synchronous
    // Then isAuthenticated() = true → checks onboardingComplete = false → /onboarding
    mockToken = null;
    mockIsAuthenticated = true;
    configStore.updateConfig({ onboardingComplete: false });

    render(() => <App />);

    await waitFor(() => {
      screen.getByTestId("onboarding-wizard");
    });
  });

  it("redirects to /dashboard when authenticated and onboarding complete", async () => {
    // token=null → validateToken NOT called → setValidating(false) is synchronous
    // Then isAuthenticated() = true → checks onboardingComplete = true → /dashboard
    mockToken = null;
    mockIsAuthenticated = true;
    configStore.updateConfig({ onboardingComplete: true });

    render(() => <App />);

    await waitFor(() => {
      screen.getByTestId("dashboard-page");
    });
  });

  it("App calls init functions on mount", async () => {
    render(() => <App />);

    await waitFor(() => {
      expect(vi.mocked(configStore.initConfigPersistence)).toHaveBeenCalled();
      expect(vi.mocked(viewStore.initViewPersistence)).toHaveBeenCalled();
      expect(vi.mocked(githubService.initClientWatcher)).toHaveBeenCalled();
      expect(vi.mocked(cacheStore.evictStaleEntries)).toHaveBeenCalled();
    });
  });

  it("all routes are registered: /, /login, /oauth/callback, /onboarding, /dashboard, /settings", () => {
    expect(() => render(() => <App />)).not.toThrow();
  });
});
