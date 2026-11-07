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

vi.mock("../../src/app/services/github", () => ({
  initClientWatcher: vi.fn(),
  getClient: vi.fn().mockReturnValue(null),
}));

vi.mock("../../src/app/lib/mcp-relay", () => ({
  initMcpRelay: vi.fn(),
}));

vi.mock("../../src/app/lib/sentry-facade", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/app/lib/sentry-facade")>();
  return {
    ...actual,
    reportBoundaryError: vi.fn(),
  };
});

vi.mock("../../src/app/stores/cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/app/stores/cache")>();
  return {
    ...actual,
    evictStaleEntries: vi.fn().mockResolvedValue(undefined),
    evictKeysWithPrefix: vi.fn().mockResolvedValue(undefined),
  };
});

// Mock heavy page/component dependencies
let dashboardShouldThrow = false;
let onboardingShouldThrow = false;
let settingsShouldThrow = false;
vi.mock("../../src/app/components/dashboard/DashboardPage", () => ({
  default: () => {
    if (dashboardShouldThrow) throw new Error("chunk load failed");
    return <div data-testid="dashboard-page">Dashboard</div>;
  },
}));
vi.mock("../../src/app/components/onboarding/OnboardingWizard", () => ({
  default: () => {
    if (onboardingShouldThrow) throw new Error("chunk load failed");
    return <div data-testid="onboarding-wizard">Onboarding</div>;
  },
}));
vi.mock("../../src/app/components/settings/SettingsPage", () => ({
  default: () => {
    if (settingsShouldThrow) throw new Error("chunk load failed");
    return <div data-testid="settings-page">Settings</div>;
  },
}));

import * as configStore from "../../src/app/stores/config";
import * as githubService from "../../src/app/services/github";
import * as cacheStore from "../../src/app/stores/cache";
import * as viewStore from "../../src/app/stores/view";
import * as sentryFacade from "../../src/app/lib/sentry-facade";
import * as versionModule from "../../src/app/lib/version";
import App, { _resetAuthInitStartedForTests } from "../../src/app/App";

describe("App", () => {
  beforeEach(() => {
    // Reset all mock state (implementations, calls, return values)
    vi.resetAllMocks();
    _resetAuthInitStartedForTests();
    mockIsAuthenticated = false;
    mockValidateToken = async () => false;
    dashboardShouldThrow = false;
    onboardingShouldThrow = false;
    settingsShouldThrow = false;
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

  it("App calls init functions on mount and defers initClientWatcher until authenticated", async () => {
    const { unmount } = render(() => <App />);

    await waitFor(() => {
      expect(vi.mocked(configStore.initConfigPersistence)).toHaveBeenCalled();
      expect(vi.mocked(viewStore.initViewPersistence)).toHaveBeenCalled();
      expect(vi.mocked(cacheStore.evictStaleEntries)).toHaveBeenCalled();
    });
    expect(vi.mocked(githubService.initClientWatcher)).not.toHaveBeenCalled();
    unmount();

    mockIsAuthenticated = true;
    configStore.updateConfig({ onboardingComplete: true });
    render(() => <App />);

    await waitFor(() => {
      expect(vi.mocked(githubService.initClientWatcher)).toHaveBeenCalledTimes(1);
    });
  });

  it("starts the version watch on mount, stops it on unmount, and renders the update banner when an update is flagged", async () => {
    const stopVersionWatch = vi.fn();
    const startSpy = vi
      .spyOn(versionModule, "startVersionWatch")
      .mockReturnValue(stopVersionWatch);
    try {
      const { unmount } = render(() => <App />);

      await waitFor(() => {
        expect(startSpy).toHaveBeenCalledTimes(1);
      });
      expect(screen.queryByText("A new version is available.")).toBeNull();

      versionModule._setUpdateAvailableForTests({
        version: "0.1.2",
        sha: "fedcba987654",
        builtAt: "2026-01-02T00:00:00.000Z",
      });
      await waitFor(() => {
        screen.getByText("A new version is available.");
      });

      expect(stopVersionWatch).not.toHaveBeenCalled();
      unmount();
      expect(stopVersionWatch).toHaveBeenCalledTimes(1);
    } finally {
      startSpy.mockRestore();
      versionModule._resetVersionStateForTests();
    }
  });

  it("redirects to /dashboard when not initially authenticated but validateToken succeeds", async () => {
    // Simulates cold start: localStorage has a token but user() is null
    // → isAuthenticated() = false → validateToken called → returns true → routes to dashboard
    mockIsAuthenticated = false;
    mockValidateToken = async () => {
      // Simulate validateToken populating user, making isAuthenticated true
      mockIsAuthenticated = true;
      return true;
    };
    configStore.updateConfig({ onboardingComplete: true });

    render(() => <App />);

    await waitFor(() => {
      screen.getByTestId("dashboard-page");
    });
  });

  it("all routes are registered: /, /login, /oauth/callback, /onboarding, /dashboard, /settings, /*", () => {
    expect(() => render(() => <App />)).not.toThrow();
  });

  it("shows error fallback and logs when a lazy route component throws", async () => {
    dashboardShouldThrow = true;
    mockIsAuthenticated = true;
    configStore.updateConfig({ onboardingComplete: true });

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(() => <App />);

    await waitFor(() => {
      screen.getByText("Failed to load page");
      screen.getByText("A new version may have been deployed. Reloading should fix this.");
      screen.getByRole("button", { name: "Reload page" });
    });

    // Verify the error is logged and forwarded to Sentry boundary reporting
    expect(spy).toHaveBeenCalledWith(
      "[app] Route render failed:",
      expect.any(Error),
    );
    expect(vi.mocked(sentryFacade.reportBoundaryError)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sentryFacade.reportBoundaryError)).toHaveBeenCalledWith(
      expect.objectContaining({ message: "chunk load failed" }),
    );

    spy.mockRestore();
  });

  it("shows error fallback when onboarding route throws", async () => {
    onboardingShouldThrow = true;
    mockIsAuthenticated = true;
    configStore.updateConfig({ onboardingComplete: false });
    window.history.pushState({}, "", "/onboarding");

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(() => <App />);

    await waitFor(() => {
      screen.getByText("Failed to load page");
    });

    expect(vi.mocked(sentryFacade.reportBoundaryError)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sentryFacade.reportBoundaryError)).toHaveBeenCalledWith(
      expect.objectContaining({ message: "chunk load failed" }),
    );

    spy.mockRestore();
  });

  it("shows error fallback when settings route throws", async () => {
    settingsShouldThrow = true;
    mockIsAuthenticated = true;
    configStore.updateConfig({ onboardingComplete: true });
    window.history.pushState({}, "", "/settings");

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(() => <App />);

    await waitFor(() => {
      screen.getByText("Failed to load page");
    });

    expect(vi.mocked(sentryFacade.reportBoundaryError)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sentryFacade.reportBoundaryError)).toHaveBeenCalledWith(
      expect.objectContaining({ message: "chunk load failed" }),
    );

    spy.mockRestore();
  });

  it("preloads dashboard chunk when auth token exists in localStorage", async () => {
    // happy-dom's localStorage is a Proxy; use vi.stubGlobal with a mock
    const store: Record<string, string> = { "github-tracker:auth-token": "test-token" };
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, val: string) => { store[key] = val; },
      removeItem: (key: string) => { delete store[key]; },
      clear: () => { for (const k of Object.keys(store)) delete store[k]; },
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    render(() => <App />);

    await waitFor(() => {
      expect(vi.mocked(cacheStore.evictStaleEntries)).toHaveBeenCalled();
    });

    vi.unstubAllGlobals();
    warnSpy.mockRestore();
  });
});
