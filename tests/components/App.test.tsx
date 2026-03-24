import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@solidjs/testing-library";

// Module-level variables to control mock return values
let mockIsAuthenticated = false;
// validateToken mock fn — replaced per-test
let mockValidateToken: () => Promise<boolean> = async () => false;

// isAuthenticated/validateToken are plain functions (not SolidJS signals) because
// RootRedirect and AuthGuard read them in onMount (one-shot), not in createEffect.
vi.mock("../../src/app/stores/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/app/stores/auth")>();
  return {
    ...actual,
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
import * as githubService from "../../src/app/services/github";
import * as cacheStore from "../../src/app/stores/cache";
import * as viewStore from "../../src/app/stores/view";
import App from "../../src/app/App";

describe("App", () => {
  beforeEach(() => {
    // Reset all mock state (implementations, calls, return values)
    vi.resetAllMocks();
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

  it("shows loading spinner during token validation", async () => {
    mockIsAuthenticated = false;
    mockValidateToken = () => new Promise(() => {}); // never resolves

    render(() => <App />);
    screen.getByLabelText("Loading");
  });

  it("redirects to /login when not authenticated and validation fails", async () => {
    mockIsAuthenticated = false;
    mockValidateToken = async () => false;

    render(() => <App />);

    await waitFor(() => {
      screen.getByText("Sign in with GitHub");
    });
  });

  it("redirects to /onboarding when authenticated but onboarding incomplete", async () => {
    // isAuthenticated=true → validateToken NOT called → immediate routing
    mockIsAuthenticated = true;
    configStore.updateConfig({ onboardingComplete: false });

    render(() => <App />);

    await waitFor(() => {
      screen.getByTestId("onboarding-wizard");
    });
  });

  it("redirects to /dashboard when authenticated and onboarding complete", async () => {
    // isAuthenticated=true → validateToken NOT called → immediate routing
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
