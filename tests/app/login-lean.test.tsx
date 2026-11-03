import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@solidjs/testing-library";
import { createEffect } from "solid-js";

const { evalCounts, relayState } = vi.hoisted(() => ({
  evalCounts: {
    github: 0,
    mcpRelay: 0,
    initClientWatcherCalls: 0,
    initMcpRelayCalls: 0,
  },
  relayState: {
    observedTokens: [] as Array<string | null>,
    disposed: false,
  },
}));

vi.mock("../../src/app/services/github", async (importOriginal) => {
  evalCounts.github++;
  const actual = await importOriginal<typeof import("../../src/app/services/github")>();
  return {
    ...actual,
    initClientWatcher: vi.fn(() => {
      evalCounts.initClientWatcherCalls++;
      actual.initClientWatcher();
    }),
  };
});

vi.mock("../../src/app/lib/mcp-relay", async () => {
  evalCounts.mcpRelay++;
  const auth = await import("../../src/app/stores/auth");
  return {
    initMcpRelay: vi.fn(() => {
      evalCounts.initMcpRelayCalls++;
      createEffect(() => {
        relayState.observedTokens.push(auth.token());
      });
    }),
    updateRelaySnapshot: vi.fn(),
  };
});

vi.mock("../../src/app/stores/cache", () => ({
  evictStaleEntries: vi.fn().mockResolvedValue(0),
  evictKeysWithPrefix: vi.fn().mockResolvedValue(undefined),
  clearCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/app/lib/dashboard-snapshot", () => ({
  clearSnapshot: vi.fn().mockResolvedValue(undefined),
  loadSnapshot: vi.fn().mockResolvedValue(null),
  writeSnapshot: vi.fn(),
  flushSnapshot: vi.fn().mockResolvedValue(undefined),
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

import * as authStore from "../../src/app/stores/auth";
import * as configStore from "../../src/app/stores/config";
import App, { _resetAuthInitStartedForTests } from "../../src/app/App";

describe("App — lean login path & authenticated-only initializers", () => {
  beforeEach(() => {
    _resetAuthInitStartedForTests();
    authStore.clearAuth();
    configStore.resetConfig();
    configStore.updateConfig({ onboardingComplete: true });
    evalCounts.initClientWatcherCalls = 0;
    evalCounts.initMcpRelayCalls = 0;
    relayState.observedTokens.length = 0;
    window.history.pushState({}, "", "/login");
  });

  afterEach(() => {
    authStore.clearAuth();
    vi.useRealTimers();
  });

  it("rendering /login unauthenticated does not evaluate services/github or lib/mcp-relay even after advancing timers", async () => {
    vi.useFakeTimers();
    const { unmount } = render(() => <App />);

    expect(screen.getByText("Sign in with GitHub")).toBeDefined();
    expect(evalCounts.github).toBe(0);
    expect(evalCounts.mcpRelay).toBe(0);

    // Advance timers well past any idle/timeout fallbacks
    await vi.advanceTimersByTimeAsync(10_000);

    expect(evalCounts.github).toBe(0);
    expect(evalCounts.mcpRelay).toBe(0);
    expect(evalCounts.initClientWatcherCalls).toBe(0);
    expect(evalCounts.initMcpRelayCalls).toBe(0);

    unmount();
  });

  it("authenticating runs initClientWatcher and initMcpRelay once under App owner, and logout -> re-auth updates client and keeps relay effects alive", async () => {
    const { unmount } = render(() => <App />);

    expect(evalCounts.initClientWatcherCalls).toBe(0);
    expect(evalCounts.initMcpRelayCalls).toBe(0);

    const tokenA = "ghp_" + "1".repeat(36);
    const tokenB = "ghp_" + "2".repeat(36);

    // First login
    authStore.setAuthFromPat(tokenA, {
      login: "user-one",
      avatar_url: "https://avatars.githubusercontent.com/u/1",
      name: "User One",
    });

    await waitFor(() => {
      expect(evalCounts.initClientWatcherCalls).toBe(1);
      expect(evalCounts.initMcpRelayCalls).toBe(1);
    });

    const gh = await import("../../src/app/services/github");
    const clientA = gh.getClient();
    expect(clientA).not.toBeNull();
    expect(relayState.observedTokens).toContain(tokenA);

    // Logout
    authStore.clearAuth();
    expect(gh.getClient()).toBeNull();
    expect(relayState.observedTokens[relayState.observedTokens.length - 1]).toBeNull();

    // Second login with a different token
    authStore.setAuthFromPat(tokenB, {
      login: "user-two",
      avatar_url: "https://avatars.githubusercontent.com/u/2",
      name: "User Two",
    });

    // Initializers must NOT re-run (authInitStarted is never reset in production)
    expect(evalCounts.initClientWatcherCalls).toBe(1);
    expect(evalCounts.initMcpRelayCalls).toBe(1);

    // Client updates to a new instance for tokenB, and relay effect under App's owner is still alive
    const clientB = gh.getClient();
    expect(clientB).not.toBeNull();
    expect(clientB).not.toBe(clientA);
    expect(relayState.observedTokens[relayState.observedTokens.length - 1]).toBe(tokenB);

    unmount();
  });
});
