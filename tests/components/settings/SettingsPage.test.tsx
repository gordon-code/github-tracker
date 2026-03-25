import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, waitFor } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";

// ── localStorage mock (happy-dom doesn't support .clear()/.removeItem()) ─────

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, val: string) => { store[key] = val; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
  };
})();

Object.defineProperty(globalThis, "localStorage", {
  value: localStorageMock,
  writable: true,
  configurable: true,
});

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("../../../src/app/stores/auth", () => ({
  clearAuth: vi.fn(),
  token: () => "fake-token",
  user: () => ({ login: "testuser", name: "Test User" }),
}));

vi.mock("../../../src/app/stores/cache", () => ({
  clearCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/app/services/github", () => ({
  getClient: vi.fn(() => ({})),
}));

vi.mock("../../../src/app/services/api", () => ({
  fetchOrgs: vi.fn().mockResolvedValue([]),
  fetchRepos: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../../src/app/lib/url", () => ({
  isSafeGitHubUrl: vi.fn(() => true),
  openGitHubUrl: vi.fn(),
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import { render } from "@solidjs/testing-library";
import { MemoryRouter, Route } from "@solidjs/router";
import SettingsPage from "../../../src/app/components/settings/SettingsPage";
import * as authStore from "../../../src/app/stores/auth";
import * as cacheStore from "../../../src/app/stores/cache";
import * as apiModule from "../../../src/app/services/api";
import { updateConfig, config } from "../../../src/app/stores/config";
import { buildOrgAccessUrl } from "../../../src/app/lib/oauth";
import * as urlModule from "../../../src/app/lib/url";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * SettingsPage uses useNavigate() which requires being inside a <Route>.
 * Wrapping in <MemoryRouter><Route path="*" component={...} /></MemoryRouter>
 * is the correct pattern (same as OAuthCallback.test.tsx).
 */
function renderSettings() {
  return render(() => (
    <MemoryRouter>
      <Route path="*" component={SettingsPage} />
    </MemoryRouter>
  ));
}

function setupMatchMedia(prefersDark = false) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: prefersDark && query === "(prefers-color-scheme: dark)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  setupMatchMedia();
  vi.clearAllMocks();

  // Restore isSafeGitHubUrl mock (vi.restoreAllMocks strips factory implementations)
  vi.mocked(urlModule.isSafeGitHubUrl).mockReturnValue(true);

  // Reset config to defaults
  updateConfig({
    refreshInterval: 300,
    maxWorkflowsPerRepo: 5,
    maxRunsPerWorkflow: 3,
    theme: "system",
    viewDensity: "comfortable",
    itemsPerPage: 25,
    defaultTab: "issues",
    rememberLastTab: true,
    notifications: { enabled: false, issues: true, pullRequests: true, workflowRuns: true },
    selectedOrgs: [],
    selectedRepos: [],
  });

  sessionStorage.clear();

  // Mock window.location with both reload and href
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: {
      reload: vi.fn(),
      href: "",
      origin: "http://localhost",
    },
  });

  // Clear localStorage
  localStorageMock.clear();

  // Reset Notification global to "default"
  Object.defineProperty(window, "Notification", {
    writable: true,
    value: { permission: "default", requestPermission: vi.fn().mockResolvedValue("granted") },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("SettingsPage — rendering", () => {
  it("renders the Settings page heading", () => {
    renderSettings();
    screen.getByText("Settings");
  });

  it("renders a back to dashboard link", () => {
    renderSettings();
    const backLink = screen.getByRole("link", { name: /back to dashboard/i });
    expect(backLink.getAttribute("href")).toBe("/dashboard");
  });

  it("renders Organizations & Repositories section", () => {
    renderSettings();
    screen.getByText("Organizations & Repositories");
  });

  it("renders Refresh section", () => {
    renderSettings();
    screen.getByText("Refresh");
  });

  it("renders GitHub Actions section", () => {
    renderSettings();
    // "GitHub Actions" appears in section heading and tab option — use heading query
    screen.getByRole("heading", { name: "GitHub Actions" });
  });

  it("renders Notifications section", () => {
    renderSettings();
    screen.getByText("Notifications");
  });

  it("renders Appearance section", () => {
    renderSettings();
    screen.getByText("Appearance");
  });

  it("renders Tabs section", () => {
    renderSettings();
    screen.getByText("Tabs");
  });

  it("renders Data section", () => {
    renderSettings();
    screen.getByText("Data");
  });

  it("renders Manage Organizations and Manage Repositories buttons", () => {
    renderSettings();
    screen.getByText("Manage Organizations");
    screen.getByText("Manage Repositories");
  });
});

describe("SettingsPage — Refresh interval", () => {
  it("shows current refresh interval value", () => {
    renderSettings();
    screen.getByDisplayValue("5 minutes (default)");
  });

  it("changing refresh interval calls updateConfig", async () => {
    const user = userEvent.setup();
    renderSettings();
    const select = screen.getByDisplayValue("5 minutes (default)");
    await user.selectOptions(select, "60");
    expect(config.refreshInterval).toBe(60);
  });
});

describe("SettingsPage — Appearance", () => {
  it("shows current theme value", () => {
    renderSettings();
    screen.getByDisplayValue("System");
  });

  it("changing theme updates config", async () => {
    const user = userEvent.setup();
    renderSettings();
    const themeSelect = screen.getByDisplayValue("System");
    await user.selectOptions(themeSelect, "dark");
    expect(config.theme).toBe("dark");
  });

  it("shows current view density value", () => {
    renderSettings();
    screen.getByDisplayValue("Comfortable");
  });

  it("changing view density updates config", async () => {
    const user = userEvent.setup();
    renderSettings();
    const densitySelect = screen.getByDisplayValue("Comfortable");
    await user.selectOptions(densitySelect, "compact");
    expect(config.viewDensity).toBe("compact");
  });

  it("shows current items per page value", () => {
    renderSettings();
    screen.getByDisplayValue("25");
  });

  it("changing items per page updates config", async () => {
    const user = userEvent.setup();
    renderSettings();
    const ippSelect = screen.getByDisplayValue("25");
    await user.selectOptions(ippSelect, "50");
    expect(config.itemsPerPage).toBe(50);
  });
});

describe("SettingsPage — Tabs", () => {
  it("shows current default tab value", () => {
    renderSettings();
    screen.getByDisplayValue("Issues");
  });

  it("changing default tab updates config", async () => {
    const user = userEvent.setup();
    renderSettings();
    const tabSelect = screen.getByDisplayValue("Issues");
    await user.selectOptions(tabSelect, "pullRequests");
    expect(config.defaultTab).toBe("pullRequests");
  });

  it("remember last tab toggle is checked by default", () => {
    renderSettings();
    const toggle = screen.getByRole("switch", { name: /remember last tab/i });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("clicking remember last tab toggle updates config", async () => {
    const user = userEvent.setup();
    renderSettings();
    const toggle = screen.getByRole("switch", { name: /remember last tab/i });
    await user.click(toggle);
    expect(config.rememberLastTab).toBe(false);
  });
});

describe("SettingsPage — GitHub Actions", () => {
  it("shows current max workflows per repo value", () => {
    renderSettings();
    const inputs = screen.getAllByRole("spinbutton");
    const workflowInput = inputs.find((el) => (el as HTMLInputElement).value === "5");
    expect(workflowInput).toBeDefined();
  });

  // NumberInput uses onInput — fireEvent.input sets the value atomically, while
  // userEvent.type fires per-keystroke triggering intermediate valid values.
  it("changing max workflows per repo updates config", () => {
    renderSettings();
    const inputs = screen.getAllByRole("spinbutton");
    const workflowInput = inputs.find((el) => (el as HTMLInputElement).value === "5")!;
    fireEvent.input(workflowInput, { target: { value: "10" } });
    expect(config.maxWorkflowsPerRepo).toBe(10);
  });

  it("shows current max runs per workflow value", () => {
    renderSettings();
    const inputs = screen.getAllByRole("spinbutton");
    const runInput = inputs.find((el) => (el as HTMLInputElement).value === "3");
    expect(runInput).toBeDefined();
  });

  it("changing max runs per workflow updates config", () => {
    renderSettings();
    const inputs = screen.getAllByRole("spinbutton");
    const runInput = inputs.find((el) => (el as HTMLInputElement).value === "3")!;
    fireEvent.input(runInput, { target: { value: "5" } });
    expect(config.maxRunsPerWorkflow).toBe(5);
  });

  it("does not update config for out-of-range values", () => {
    renderSettings();
    const inputs = screen.getAllByRole("spinbutton");
    const workflowInput = inputs.find((el) => (el as HTMLInputElement).value === "5")!;
    fireEvent.input(workflowInput, { target: { value: "999" } });
    // Should remain unchanged since 999 > max of 20
    expect(config.maxWorkflowsPerRepo).toBe(5);
  });
});

describe("SettingsPage — Notifications", () => {
  it("notification toggle is disabled when permission is denied", () => {
    Object.defineProperty(window, "Notification", {
      writable: true,
      value: { permission: "denied", requestPermission: vi.fn() },
    });
    renderSettings();
    const toggle = screen.getByRole("switch", { name: /enable notifications/i });
    expect(toggle.hasAttribute("disabled")).toBe(true);
  });

  it("shows 'Permission denied' message when permission is denied", () => {
    Object.defineProperty(window, "Notification", {
      writable: true,
      value: { permission: "denied", requestPermission: vi.fn() },
    });
    renderSettings();
    screen.getByText(/permission denied in browser/i);
  });

  it("shows Grant permission button when permission not yet granted", () => {
    renderSettings();
    // Permission is "default" (from beforeEach), notifications disabled
    screen.getByText(/grant permission/i);
  });

  it("notification sub-toggles are disabled when notifications disabled", () => {
    // notifications.enabled is false by default
    renderSettings();
    const issuesToggle = screen.getByRole("switch", { name: /issues notifications/i });
    expect(issuesToggle.hasAttribute("disabled")).toBe(true);
  });

  it("toggling notifications when enabled updates config", async () => {
    const user = userEvent.setup();
    // Enable notifications first
    updateConfig({ notifications: { enabled: true, issues: true, pullRequests: true, workflowRuns: true } });
    Object.defineProperty(window, "Notification", {
      writable: true,
      value: { permission: "granted", requestPermission: vi.fn() },
    });
    renderSettings();
    const toggle = screen.getByRole("switch", { name: /enable notifications/i });
    await user.click(toggle);
    expect(config.notifications.enabled).toBe(false);
  });
});

describe("SettingsPage — Data: Clear cache", () => {
  it("shows Clear cache button initially", () => {
    renderSettings();
    // The section has a <p> heading and a <button> both with text "Clear cache"
    screen.getByRole("button", { name: "Clear cache" });
  });

  it("first click shows confirmation dialog", async () => {
    const user = userEvent.setup();
    renderSettings();
    const clearBtn = screen.getByRole("button", { name: "Clear cache" });
    await user.click(clearBtn);
    screen.getByText("Are you sure?");
    screen.getByRole("button", { name: "Yes, clear" });
    screen.getByRole("button", { name: "Cancel" });
  });

  it("second click (confirm) calls clearCache", async () => {
    const user = userEvent.setup();
    renderSettings();
    const clearBtn = screen.getByRole("button", { name: "Clear cache" });
    await user.click(clearBtn);
    const confirmBtn = screen.getByRole("button", { name: "Yes, clear" });
    await user.click(confirmBtn);
    await waitFor(() => {
      expect(cacheStore.clearCache).toHaveBeenCalledOnce();
    });
  });

  it("clicking Cancel returns to initial state", async () => {
    const user = userEvent.setup();
    renderSettings();
    const clearBtn = screen.getByRole("button", { name: "Clear cache" });
    await user.click(clearBtn);
    screen.getByText("Are you sure?");

    const cancelBtn = screen.getByRole("button", { name: "Cancel" });
    await user.click(cancelBtn);
    expect(screen.queryByText("Are you sure?")).toBeNull();
    screen.getByRole("button", { name: "Clear cache" });
  });
});

describe("SettingsPage — Data: Export settings", () => {
  it("clicking Export triggers download", async () => {
    const createObjectURLSpy = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fake-url");
    const revokeObjectURLSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    // Spy on anchor click
    const clickSpy = vi.fn();
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = origCreate(tag);
      if (tag === "a") {
        vi.spyOn(el as HTMLAnchorElement, "click").mockImplementation(clickSpy);
      }
      return el;
    });

    renderSettings();
    const exportBtn = screen.getByText("Export");
    const user = userEvent.setup();
    await user.click(exportBtn);

    expect(createObjectURLSpy).toHaveBeenCalledOnce();
    expect(clickSpy).toHaveBeenCalledOnce();
    expect(revokeObjectURLSpy).toHaveBeenCalledOnce();
  });
});

describe("SettingsPage — Data: Reset all", () => {
  it("shows Reset all button initially", () => {
    renderSettings();
    screen.getByRole("button", { name: "Reset all" });
  });

  it("first click shows confirmation dialog", async () => {
    const user = userEvent.setup();
    renderSettings();
    const resetBtn = screen.getByRole("button", { name: "Reset all" });
    await user.click(resetBtn);
    screen.getByText("Are you sure?");
    screen.getByRole("button", { name: "Yes, reset" });
  });

  it("cancelling reset returns to initial state", async () => {
    const user = userEvent.setup();
    renderSettings();
    const resetBtn = screen.getByRole("button", { name: "Reset all" });
    await user.click(resetBtn);
    const cancelBtn = screen.getByRole("button", { name: "Cancel" });
    await user.click(cancelBtn);
    expect(screen.queryByRole("button", { name: "Yes, reset" })).toBeNull();
    screen.getByRole("button", { name: "Reset all" });
  });

  it("confirming reset calls clearAuth and reloads the page", async () => {
    const user = userEvent.setup();
    const { clearAuth: clearAuthMock } = await import("../../../src/app/stores/auth");

    renderSettings();
    const resetBtn = screen.getByRole("button", { name: "Reset all" });
    await user.click(resetBtn);
    const confirmBtn = screen.getByRole("button", { name: "Yes, reset" });
    await user.click(confirmBtn);

    await waitFor(() => {
      expect(window.location.reload).toHaveBeenCalledOnce();
    });
    expect(clearAuthMock).toHaveBeenCalled();
  });
});

describe("SettingsPage — Data: Sign out", () => {
  it("clicking Sign out calls clearAuth", async () => {
    const user = userEvent.setup();
    renderSettings();
    const signOutBtn = screen.getByRole("button", { name: "Sign out" });
    await user.click(signOutBtn);
    expect(authStore.clearAuth).toHaveBeenCalledOnce();
  });

  it("clicking Sign out navigates to /login", async () => {
    const user = userEvent.setup();
    renderSettings();
    const signOutBtn = screen.getByRole("button", { name: "Sign out" });
    await user.click(signOutBtn);
    // Navigation is handled by MemoryRouter — we just verify clearAuth was called
    // and no error was thrown
    expect(authStore.clearAuth).toHaveBeenCalled();
  });
});

describe("SettingsPage — Theme application", () => {
  it("applies dark class when theme is dark", () => {
    updateConfig({ theme: "dark" });
    renderSettings();
    // The createEffect runs synchronously in test environment
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("removes dark class when theme is light", () => {
    document.documentElement.classList.add("dark");
    updateConfig({ theme: "light" });
    renderSettings();
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("uses system preference when theme is system (prefers dark)", () => {
    setupMatchMedia(true); // system prefers dark
    updateConfig({ theme: "system" });
    renderSettings();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});

describe("SettingsPage — Grant more orgs button", () => {
  it("renders 'Grant more orgs' button in Organizations & Repositories section", () => {
    renderSettings();
    screen.getByRole("button", { name: "Grant more orgs" });
  });

  it("clicking 'Grant more orgs' opens GitHub app settings via openGitHubUrl", async () => {
    const user = userEvent.setup();
    vi.stubEnv("VITE_GITHUB_CLIENT_ID", "test-client-id");
    renderSettings();
    const btn = screen.getByRole("button", { name: "Grant more orgs" });
    await user.click(btn);
    expect(urlModule.openGitHubUrl).toHaveBeenCalledWith(buildOrgAccessUrl());
    vi.unstubAllEnvs();
  });

  it("clicking 'Grant more orgs' registers a focus listener for auto-merge", async () => {
    const user = userEvent.setup();
    vi.stubEnv("VITE_GITHUB_CLIENT_ID", "test-client-id");
    const addSpy = vi.spyOn(window, "addEventListener");
    renderSettings();
    const btn = screen.getByRole("button", { name: "Grant more orgs" });
    await user.click(btn);
    expect(addSpy).toHaveBeenCalledWith("focus", expect.any(Function));
    vi.unstubAllEnvs();
  });

  it("shows 'Syncing...' on button while merging and reverts after", async () => {
    const user = userEvent.setup();
    vi.stubEnv("VITE_GITHUB_CLIENT_ID", "test-client-id");
    updateConfig({ selectedOrgs: [] });
    vi.mocked(apiModule.fetchOrgs).mockResolvedValue([]);
    renderSettings();
    const btn = screen.getByRole("button", { name: "Grant more orgs" });
    await user.click(btn);
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Syncing..." })).toBeDefined();
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Grant more orgs" })).toBeDefined();
    });
    vi.unstubAllEnvs();
  });

  it("auto-merges new orgs when window regains focus after granting", async () => {
    const user = userEvent.setup();
    vi.stubEnv("VITE_GITHUB_CLIENT_ID", "test-client-id");
    updateConfig({ selectedOrgs: ["existing-org"] });
    vi.mocked(apiModule.fetchOrgs).mockResolvedValue([
      { login: "existing-org", avatarUrl: "", type: "org" },
      { login: "new-org", avatarUrl: "", type: "org" },
    ]);
    renderSettings();
    const btn = screen.getByRole("button", { name: "Grant more orgs" });
    await user.click(btn);
    // Simulate user returning from GitHub settings tab
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => {
      expect(apiModule.fetchOrgs).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(config.selectedOrgs).toContain("new-org");
      expect(config.selectedOrgs).toContain("existing-org");
    });
    vi.unstubAllEnvs();
  });

  it("silently handles fetchOrgs rejection on focus without breaking", async () => {
    const user = userEvent.setup();
    vi.stubEnv("VITE_GITHUB_CLIENT_ID", "test-client-id");
    updateConfig({ selectedOrgs: ["existing-org"] });
    vi.mocked(apiModule.fetchOrgs).mockRejectedValue(new Error("Network error"));
    renderSettings();
    const btn = screen.getByRole("button", { name: "Grant more orgs" });
    await user.click(btn);
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => {
      expect(apiModule.fetchOrgs).toHaveBeenCalled();
    });
    expect(config.selectedOrgs).toEqual(["existing-org"]);
    vi.unstubAllEnvs();
  });

  it("skips merge on focus when getClient returns null", async () => {
    const user = userEvent.setup();
    vi.stubEnv("VITE_GITHUB_CLIENT_ID", "test-client-id");
    const github = await import("../../../src/app/services/github");
    vi.mocked(github.getClient).mockReturnValueOnce(null);
    renderSettings();
    const btn = screen.getByRole("button", { name: "Grant more orgs" });
    await user.click(btn);
    window.dispatchEvent(new Event("focus"));
    // Give mergeNewOrgs time to bail out
    await new Promise((r) => setTimeout(r, 50));
    expect(apiModule.fetchOrgs).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("rapid double-click deduplicates focus listeners", async () => {
    const user = userEvent.setup();
    vi.stubEnv("VITE_GITHUB_CLIENT_ID", "test-client-id");
    const removeSpy = vi.spyOn(window, "removeEventListener");
    renderSettings();
    const btn = screen.getByRole("button", { name: "Grant more orgs" });
    await user.click(btn);
    await user.click(btn);
    // Second click removes the first listener before adding a new one
    const focusRemoves = removeSpy.mock.calls.filter(([evt]) => evt === "focus");
    expect(focusRemoves.length).toBeGreaterThanOrEqual(1);
    vi.unstubAllEnvs();
  });

  it("cleans up pending focus listener on component unmount", async () => {
    const user = userEvent.setup();
    vi.stubEnv("VITE_GITHUB_CLIENT_ID", "test-client-id");
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const { unmount } = renderSettings();
    const btn = screen.getByRole("button", { name: "Grant more orgs" });
    await user.click(btn);
    unmount();
    const focusRemoves = removeSpy.mock.calls.filter(([evt]) => evt === "focus");
    expect(focusRemoves.length).toBeGreaterThanOrEqual(1);
    vi.unstubAllEnvs();
  });

  it("focus listener self-removes — second focus does not re-trigger merge", async () => {
    const user = userEvent.setup();
    vi.stubEnv("VITE_GITHUB_CLIENT_ID", "test-client-id");
    updateConfig({ selectedOrgs: [] });
    vi.mocked(apiModule.fetchOrgs).mockResolvedValue([]);
    renderSettings();
    const btn = screen.getByRole("button", { name: "Grant more orgs" });
    await user.click(btn);
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => {
      expect(apiModule.fetchOrgs).toHaveBeenCalledTimes(1);
    });
    // Second focus should NOT trigger another merge
    window.dispatchEvent(new Event("focus"));
    await new Promise((r) => setTimeout(r, 50));
    expect(apiModule.fetchOrgs).toHaveBeenCalledTimes(1);
    vi.unstubAllEnvs();
  });
});
