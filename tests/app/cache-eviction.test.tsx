import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@solidjs/testing-library";

vi.mock("../../src/app/stores/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/app/stores/auth")>();
  return {
    ...actual,
    isAuthenticated: () => true,
    validateToken: vi.fn().mockResolvedValue(true),
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

vi.mock("../../src/app/stores/cache", () => ({
  evictStaleEntries: vi.fn().mockResolvedValue(0),
  evictKeysWithPrefix: vi.fn().mockResolvedValue(undefined),
}));

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
import * as cacheStore from "../../src/app/stores/cache";
import App from "../../src/app/App";

describe("App — cache eviction scheduling and deselected repo cleanup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.mocked(cacheStore.evictStaleEntries).mockResolvedValue(0);
    vi.mocked(cacheStore.evictKeysWithPrefix).mockResolvedValue(undefined);
    configStore.resetConfig();
    configStore.updateConfig({ onboardingComplete: true });
    if (window.location.pathname !== "/") {
      window.history.pushState({}, "", "/");
    }
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs evictStaleEntries(24h) on mount, again after 1 hour, and stops after unmount", async () => {
    const twentyFourHoursMs = 24 * 60 * 60 * 1000;
    const oneHourMs = 60 * 60 * 1000;

    const { unmount } = render(() => <App />);

    expect(cacheStore.evictStaleEntries).toHaveBeenCalledTimes(1);
    expect(cacheStore.evictStaleEntries).toHaveBeenLastCalledWith(twentyFourHoursMs);

    await vi.advanceTimersByTimeAsync(oneHourMs);
    expect(cacheStore.evictStaleEntries).toHaveBeenCalledTimes(2);
    expect(cacheStore.evictStaleEntries).toHaveBeenLastCalledWith(twentyFourHoursMs);

    unmount();

    await vi.advanceTimersByTimeAsync(oneHourMs);
    expect(cacheStore.evictStaleEntries).toHaveBeenCalledTimes(2);
  });

  it("evicts runs2:<repo>: and run:<repo>: keys when a repo is deselected from config.selectedRepos", () => {
    configStore.updateConfig({
      selectedRepos: [
        { owner: "a", name: "b", fullName: "a/b" },
        { owner: "c", name: "d", fullName: "c/d" },
      ],
    });

    const { unmount } = render(() => <App />);
    expect(cacheStore.evictKeysWithPrefix).not.toHaveBeenCalled();

    // Deselect a/b while keeping c/d
    configStore.updateConfig({
      selectedRepos: [{ owner: "c", name: "d", fullName: "c/d" }],
    });

    expect(cacheStore.evictKeysWithPrefix).toHaveBeenCalledTimes(1);
    expect(cacheStore.evictKeysWithPrefix).toHaveBeenCalledWith(["runs2:a/b:", "run:a/b:"]);

    unmount();
  });
});
