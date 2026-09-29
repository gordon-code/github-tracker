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
  clearJiraAuth: vi.fn(),
  setJiraAuth: vi.fn(),
  setAuthFromPat: vi.fn(),
  setAuthFromCredential: vi.fn(),
  clearIdentityData: vi.fn().mockResolvedValue(undefined),
  jiraAuth: () => null,
  isJiraAuthenticated: () => false,
  ensureJiraTokenValid: vi.fn(),
  token: vi.fn(() => "fake-token"),
  user: () => ({ login: "testuser", avatar_url: "https://avatars/test", name: "Test User" }),
  onAuthCleared: vi.fn(),
}));

// Partial mock: keep the real buildExportPayload/parseImportFile/CredentialsSectionSchema
// (used by the plaintext export/import paths), stub the credential-flow functions.
vi.mock("../../../src/app/lib/settings-transfer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/app/lib/settings-transfer")>();
  return {
    ...actual,
    buildEncryptedCredentialsSection: vi.fn(),
    resolveImportedCredentials: vi.fn(),
    commitImportedSettings: vi.fn(),
  };
});

vi.mock("../../../src/app/lib/proxy", () => ({
  sealApiToken: vi.fn(),
  unsealCredentialBundle: vi.fn(),
}));

vi.mock("@sentry/solid", () => ({
  captureException: vi.fn(),
  withSentryErrorBoundary: vi.fn((c: unknown) => c),
}));

vi.mock("../../../src/app/stores/cache", () => ({
  clearCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/app/services/github", () => ({
  getClient: vi.fn(() => ({})),
  onApiRequest: vi.fn(),
}));

vi.mock("../../../src/app/services/api", () => ({
  fetchOrgs: vi.fn().mockResolvedValue([]),
  fetchRepos: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../../src/app/lib/url", () => ({
  isSafeGitHubUrl: vi.fn(() => true),
  openGitHubUrl: vi.fn(),
}));

vi.mock("../../../src/app/lib/errors", () => ({
  pushNotification: vi.fn(),
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import { render } from "@solidjs/testing-library";
import { MemoryRouter, Route } from "@solidjs/router";
import SettingsPage from "../../../src/app/components/settings/SettingsPage";
import * as authStore from "../../../src/app/stores/auth";
import * as cacheStore from "../../../src/app/stores/cache";
import * as apiModule from "../../../src/app/services/api";
import { updateConfig, config } from "../../../src/app/stores/config";
import { viewState, updateViewState } from "../../../src/app/stores/view";
import { buildOrgAccessUrl } from "../../../src/app/lib/oauth";
import * as urlModule from "../../../src/app/lib/url";
import * as settingsTransfer from "../../../src/app/lib/settings-transfer";
import * as proxyLib from "../../../src/app/lib/proxy";

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
    theme: "light",
    viewDensity: "comfortable",
    itemsPerPage: 25,
    defaultTab: "issues",
    rememberLastTab: true,
    notifications: { enabled: false, issues: true, pullRequests: true, workflowRuns: true },
    selectedOrgs: [],
    selectedRepos: [],
    authMethod: "oauth" as const,
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
    screen.getByRole("heading", { name: "Refresh" });
  });

  it("renders GitHub Actions section", () => {
    renderSettings();
    // "GitHub Actions" appears in section heading and tab option — use heading query
    screen.getByRole("heading", { name: "GitHub Actions" });
  });

  it("renders Notifications section", () => {
    renderSettings();
    screen.getByRole("heading", { name: "Notifications" });
  });

  it("renders Appearance section", () => {
    renderSettings();
    screen.getByRole("heading", { name: "Appearance" });
  });

  it("renders Tabs section", () => {
    renderSettings();
    screen.getByRole("heading", { name: "Tabs" });
  });

  it("renders Data section", () => {
    renderSettings();
    screen.getByRole("heading", { name: "Data" });
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
    screen.getByRole("button", { name: "5 minutes (default)" });
  });

  it("changing refresh interval calls updateConfig", async () => {
    const user = userEvent.setup();
    renderSettings();
    const trigger = screen.getByRole("button", { name: "5 minutes (default)" });
    await user.click(trigger);
    await user.click(screen.getByRole("option", { name: "1 minute" }));
    expect(config.refreshInterval).toBe(60);
  });
});

describe("SettingsPage — Appearance", () => {
  it("renders ThemePicker with theme buttons", () => {
    renderSettings();
    // ThemePicker renders a button for each theme — at minimum "light" should be present
    screen.getByRole("button", { name: /Theme: light/i });
  });

  it("clicking a theme button updates config", async () => {
    const user = userEvent.setup();
    renderSettings();
    const darkThemeBtn = screen.getByRole("button", { name: /Theme: dark/i });
    await user.click(darkThemeBtn);
    expect(config.theme).toBe("dark");
  });

  it("shows current view density value", () => {
    renderSettings();
    screen.getByRole("button", { name: /View density: Comfortable/i });
  });

  it("changing view density updates config", async () => {
    const user = userEvent.setup();
    renderSettings();
    const compactBtn = screen.getByRole("button", { name: /View density: Compact/i });
    await user.click(compactBtn);
    expect(config.viewDensity).toBe("compact");
  });

  it("shows current items per page value", () => {
    renderSettings();
    screen.getByRole("button", { name: "25" });
  });

  it("changing items per page updates config", async () => {
    const user = userEvent.setup();
    renderSettings();
    const trigger = screen.getByRole("button", { name: "25" });
    await user.click(trigger);
    await user.click(screen.getByRole("option", { name: "50" }));
    expect(config.itemsPerPage).toBe(50);
  });
});

describe("SettingsPage — Tabs", () => {
  it("shows current default tab value", () => {
    renderSettings();
    screen.getByRole("button", { name: "Issues" });
  });

  it("changing default tab updates config", async () => {
    const user = userEvent.setup();
    renderSettings();
    const trigger = screen.getByRole("button", { name: "Issues" });
    await user.click(trigger);
    await user.click(screen.getByRole("option", { name: "Pull Requests" }));
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
  it("clicking Export opens the choice dialog", async () => {
    renderSettings();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Export" }));

    screen.getByText("Choose what to include in the exported file.");
    screen.getByRole("button", { name: "Export config only" });
    screen.getByRole("button", { name: "Export with encrypted credentials" });
  });

  it("choosing 'Export config only' downloads immediately with no _credentials section", async () => {
    let capturedBlob: Blob | undefined;
    const createObjectURLSpy = vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      capturedBlob = blob as Blob;
      return "blob:fake-url";
    });
    const revokeObjectURLSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

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
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Export" }));
    await user.click(screen.getByRole("button", { name: "Export config only" }));

    expect(createObjectURLSpy).toHaveBeenCalledOnce();
    expect(clickSpy).toHaveBeenCalledOnce();
    expect(revokeObjectURLSpy).toHaveBeenCalledOnce();

    expect(capturedBlob).toBeDefined();
    const parsed = JSON.parse(await capturedBlob!.text()) as Record<string, unknown>;
    expect("_credentials" in parsed).toBe(false);
    // The view-prefs migration (buildViewPreferencesSection) runs regardless of
    // whether credentials are included — locks that in at the UI entry point.
    expect("_viewPreferences" in parsed).toBe(true);
  });

  it("Cancel in the choice dialog downloads nothing", async () => {
    const createObjectURLSpy = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fake-url");

    renderSettings();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Export" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(createObjectURLSpy).not.toHaveBeenCalled();
  });
});

describe("SettingsPage — Data: Import settings", () => {
  function selectImportFile(content: string, name = "settings.json") {
    const input = screen.getByLabelText(/import settings file/i);
    const file = new File([content], name, { type: "application/json" });
    fireEvent.change(input, { target: { files: [file] } });
    return file;
  }

  it("selecting a valid file shows the confirmation step without mutating the config store", async () => {
    updateConfig({ theme: "light", itemsPerPage: 25 });
    renderSettings();
    selectImportFile(JSON.stringify({ theme: "dark", itemsPerPage: 50 }));
    await waitFor(() => screen.getByText(/replace your current settings/i));
    // Confirmation shown, but nothing applied yet
    screen.getByRole("button", { name: "Yes, import" });
    expect(config.theme).toBe("light");
    expect(config.itemsPerPage).toBe(25);
  });

  it("confirming the import replaces config store fields", async () => {
    const user = userEvent.setup();
    updateConfig({ theme: "light", itemsPerPage: 25 });
    renderSettings();
    selectImportFile(JSON.stringify({ theme: "dark", itemsPerPage: 50 }));
    await waitFor(() => screen.getByRole("button", { name: "Yes, import" }));
    await user.click(screen.getByRole("button", { name: "Yes, import" }));
    expect(config.theme).toBe("dark");
    expect(config.itemsPerPage).toBe(50);
    // Confirmation dismissed, Import button restored
    expect(screen.queryByRole("button", { name: "Yes, import" })).toBeNull();
    screen.getByRole("button", { name: "Import" });
  });

  it("canceling the confirmation resets the confirm-state and leaves the config store untouched", async () => {
    const user = userEvent.setup();
    updateConfig({ theme: "light" });
    renderSettings();
    selectImportFile(JSON.stringify({ theme: "dark" }));
    await waitFor(() => screen.getByRole("button", { name: "Yes, import" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: "Yes, import" })).toBeNull();
    screen.getByRole("button", { name: "Import" });
    expect(config.theme).toBe("light");
  });

  it("selecting a malformed file pushes a warning, shows no confirmation, leaves config unchanged", async () => {
    const { pushNotification } = await import("../../../src/app/lib/errors");
    updateConfig({ theme: "light" });
    renderSettings();
    selectImportFile("this is not json {{{");
    await waitFor(() => {
      expect(pushNotification).toHaveBeenCalledWith(
        "settings-import",
        expect.stringMatching(/import failed/i),
        "warning"
      );
    });
    expect(screen.queryByRole("button", { name: "Yes, import" })).toBeNull();
    expect(config.theme).toBe("light");
  });

  it("an unreadable file (File.text rejects) is treated identically to a parse failure", async () => {
    const { pushNotification } = await import("../../../src/app/lib/errors");
    updateConfig({ theme: "light" });
    renderSettings();
    // A read rejection never reaches parseImportFile — distinct code path.
    vi.spyOn(File.prototype, "text").mockRejectedValueOnce(new Error("unreadable"));
    selectImportFile("irrelevant");
    await waitFor(() => {
      expect(pushNotification).toHaveBeenCalledWith(
        "settings-import",
        expect.stringMatching(/could not read/i),
        "warning"
      );
    });
    expect(screen.queryByRole("button", { name: "Yes, import" })).toBeNull();
    expect(config.theme).toBe("light");
  });

  it("wholesale-replaces config: a pre-set selectedRepos clears when absent from the imported file", async () => {
    const user = userEvent.setup();
    updateConfig({ selectedRepos: [{ owner: "o", name: "r", fullName: "o/r" }] });
    renderSettings();
    selectImportFile(JSON.stringify({ theme: "dark" })); // no selectedRepos in the imported file
    await waitFor(() => screen.getByRole("button", { name: "Yes, import" }));
    await user.click(screen.getByRole("button", { name: "Yes, import" }));
    // Proves setConfig (wholesale) not updateConfig (partial merge): the prior field is gone.
    expect(config.selectedRepos).toEqual([]);
    expect(config.theme).toBe("dark");
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

// Theme application tests removed — theme is now handled by createEffect in App.tsx, not SettingsPage

describe("SettingsPage — replace token", () => {
  beforeEach(() => {
    // Ensure authMethod is "pat" for most tests; individual tests override as needed
    updateConfig({ authMethod: "pat" });
    // Reset token mock to return "fake-token" (default)
    vi.mocked(authStore.token).mockReturnValue("fake-token");
  });

  afterEach(() => {
    vi.mocked(authStore.token).mockReturnValue("fake-token");
  });

  it("Replace button is visible when authMethod is pat", () => {
    renderSettings();
    screen.getByRole("button", { name: "Replace" });
  });

  it("Replace button is NOT in DOM when authMethod is oauth", () => {
    updateConfig({ authMethod: "oauth" });
    renderSettings();
    expect(screen.queryByRole("button", { name: "Replace" })).toBeNull();
  });

  it("clicking Replace opens the form; clicking Cancel hides it and clears input", async () => {
    const user = userEvent.setup();
    renderSettings();

    const replaceBtn = screen.getByRole("button", { name: "Replace" });
    await user.click(replaceBtn);

    // Form is now visible
    screen.getByRole("button", { name: "Replace token" });
    const input = screen.getByLabelText(/new personal access token/i);
    await user.type(input, "ghp_someinput");

    const cancelBtn = screen.getByRole("button", { name: "Cancel" });
    await user.click(cancelBtn);

    // Form is gone
    expect(screen.queryByRole("button", { name: "Replace token" })).toBeNull();

    // Reopen and verify input was cleared
    await user.click(screen.getByRole("button", { name: "Replace" }));
    const reopenedInput = screen.getByLabelText(/new personal access token/i) as HTMLInputElement;
    expect(reopenedInput.value).toBe("");
  });

  it("shows format error and does not fetch when token has wrong format", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    renderSettings();

    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    const input = screen.getByLabelText(/new personal access token/i);
    fireEvent.input(input, { target: { value: "bad-token" } });

    fireEvent.click(screen.getByRole("button", { name: "Replace token" }));

    await waitFor(() => {
      screen.getByText(/token should start with ghp_/i);
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("shows same-token error and does not fetch when entering current token", async () => {
    const currentToken = "ghp_existingtoken123456789012345678901234";
    vi.mocked(authStore.token).mockReturnValue(currentToken);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    renderSettings();
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));

    const input = screen.getByLabelText(/new personal access token/i);
    fireEvent.input(input, { target: { value: currentToken } });
    fireEvent.click(screen.getByRole("button", { name: "Replace token" }));

    await waitFor(() => {
      screen.getByText(/this is already your current token/i);
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("calls setAuthFromPat and closes form on successful replacement", async () => {
    const newToken = "ghp_newtoken9876543210abcdefghijklmnopqrst";
    const userData = { login: "newuser", avatar_url: "https://avatars.githubusercontent.com/u/1", name: "New User" };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(userData),
    } as Response);

    renderSettings();
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));

    const input = screen.getByLabelText(/new personal access token/i);
    fireEvent.input(input, { target: { value: newToken } });
    fireEvent.click(screen.getByRole("button", { name: "Replace token" }));

    await waitFor(() => {
      expect(authStore.setAuthFromPat).toHaveBeenCalledWith(newToken, userData);
    });
    // Form closed
    expect(screen.queryByRole("button", { name: "Replace token" })).toBeNull();
  });

  it("shows invalid-token error on 401 response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: () => Promise.resolve({}),
    } as Response);

    renderSettings();
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));

    const input = screen.getByLabelText(/new personal access token/i);
    fireEvent.input(input, { target: { value: "ghp_newtoken9876543210abcdefghijklmnopqrst" } });
    fireEvent.click(screen.getByRole("button", { name: "Replace token" }));

    await waitFor(() => {
      screen.getByText(/token is invalid — check that you entered it correctly/i);
    });
    expect(authStore.setAuthFromPat).not.toHaveBeenCalled();
  });

  it("shows network error message when fetch throws", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("Failed to fetch"));

    renderSettings();
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));

    const input = screen.getByLabelText(/new personal access token/i);
    fireEvent.input(input, { target: { value: "ghp_newtoken9876543210abcdefghijklmnopqrst" } });
    fireEvent.click(screen.getByRole("button", { name: "Replace token" }));

    await waitFor(() => {
      screen.getByText(/network error — please try again/i);
    });
    expect(authStore.setAuthFromPat).not.toHaveBeenCalled();
  });

  it("shows 'GitHub returned 500' error and does not call setAuthFromPat on 500 response", async () => {
    const { pushNotification } = await import("../../../src/app/lib/errors");
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({}),
    } as Response);

    renderSettings();
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));

    const input = screen.getByLabelText(/new personal access token/i);
    fireEvent.input(input, { target: { value: "ghp_newtoken9876543210abcdefghijklmnopqrst" } });
    fireEvent.click(screen.getByRole("button", { name: "Replace token" }));

    await waitFor(() => {
      screen.getByText(/GitHub returned 500/i);
    });
    expect(authStore.setAuthFromPat).not.toHaveBeenCalled();
    expect(pushNotification).not.toHaveBeenCalled();
  });

  it("calls pushNotification with pat-replace on successful replacement", async () => {
    const { pushNotification } = await import("../../../src/app/lib/errors");
    const newToken = "ghp_newtoken9876543210abcdefghijklmnopqrst";
    const userData = { login: "newuser", avatar_url: "https://avatars.githubusercontent.com/u/1", name: "New User" };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(userData),
    } as Response);

    renderSettings();
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));

    const input = screen.getByLabelText(/new personal access token/i);
    fireEvent.input(input, { target: { value: newToken } });
    fireEvent.click(screen.getByRole("button", { name: "Replace token" }));

    await waitFor(() => {
      expect(pushNotification).toHaveBeenCalledWith("pat-replace", "Token replaced successfully", "info");
    });
  });

  it("stale-form guard: setAuthFromPat not called when Cancel clicked before fetch resolves", async () => {
    let resolveFetch!: (v: Response) => void;
    vi.spyOn(globalThis, "fetch").mockReturnValueOnce(
      new Promise<Response>((r) => { resolveFetch = r; })
    );

    const user = userEvent.setup();
    renderSettings();
    await user.click(screen.getByRole("button", { name: "Replace" }));

    const input = screen.getByLabelText(/new personal access token/i);
    fireEvent.input(input, { target: { value: "ghp_newtoken9876543210abcdefghijklmnopqrst" } });
    fireEvent.click(screen.getByRole("button", { name: "Replace token" }));

    // Cancel while fetch is in-flight
    const cancelBtn = screen.getByRole("button", { name: "Cancel" });
    await user.click(cancelBtn);

    // Form is closed immediately on Cancel
    expect(screen.queryByRole("button", { name: "Replace token" })).toBeNull();
    expect(screen.queryByLabelText(/new personal access token/i)).toBeNull();

    // Now resolve the fetch
    resolveFetch({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ login: "newuser", avatar_url: "https://avatars.githubusercontent.com/u/1", name: "New User" }),
    } as Response);

    // Wait for microtasks to flush
    await new Promise((r) => setTimeout(r, 50));

    expect(authStore.setAuthFromPat).not.toHaveBeenCalled();
    // Form remains closed — no error or success state leaked through
    expect(screen.queryByRole("button", { name: "Replace token" })).toBeNull();
  });

  it("stale-form guard: no error shown when Cancel clicked before error response resolves", async () => {
    let resolveFetch!: (v: Response) => void;
    vi.spyOn(globalThis, "fetch").mockReturnValueOnce(
      new Promise<Response>((r) => { resolveFetch = r; })
    );

    const user = userEvent.setup();
    renderSettings();
    await user.click(screen.getByRole("button", { name: "Replace" }));

    const input = screen.getByLabelText(/new personal access token/i);
    fireEvent.input(input, { target: { value: "ghp_newtoken9876543210abcdefghijklmnopqrst" } });
    fireEvent.click(screen.getByRole("button", { name: "Replace token" }));

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    resolveFetch({ ok: false, status: 401 } as Response);
    await new Promise((r) => setTimeout(r, 50));

    expect(authStore.setAuthFromPat).not.toHaveBeenCalled();
    expect(screen.queryByText(/token is invalid/i)).toBeNull();
  });
});

describe("SettingsPage — Auth method display", () => {
  it("shows 'OAuth' when authMethod is 'oauth'", () => {
    renderSettings();
    screen.getByText("OAuth");
  });

  it("shows 'Personal Access Token' when authMethod is 'pat'", () => {
    updateConfig({ authMethod: "pat" });
    renderSettings();
    screen.getByText("Personal Access Token");
  });

  it("shows 'Manage org access' when authMethod is 'oauth'", () => {
    renderSettings();
    screen.getByRole("button", { name: "Manage org access" });
  });

  it("hides 'Manage org access' when authMethod is 'pat'", () => {
    updateConfig({ authMethod: "pat" });
    renderSettings();
    expect(screen.queryByRole("button", { name: "Manage org access" })).toBeNull();
  });
});

describe("SettingsPage — Manage org access button", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_GITHUB_CLIENT_ID", "test-client-id");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("renders 'Manage org access' button in Organizations & Repositories section", () => {
    renderSettings();
    screen.getByRole("button", { name: "Manage org access" });
  });

  it("clicking 'Manage org access' opens GitHub app settings via openGitHubUrl", async () => {
    const user = userEvent.setup();
    renderSettings();
    const btn = screen.getByRole("button", { name: "Manage org access" });
    await user.click(btn);
    expect(urlModule.openGitHubUrl).toHaveBeenCalledWith(buildOrgAccessUrl());
  });

  it("clicking 'Manage org access' registers a focus listener for auto-merge", async () => {
    const user = userEvent.setup();
    const addSpy = vi.spyOn(window, "addEventListener");
    renderSettings();
    const btn = screen.getByRole("button", { name: "Manage org access" });
    await user.click(btn);
    expect(addSpy).toHaveBeenCalledWith("focus", expect.any(Function));
  });

  it("shows disabled 'Syncing...' button during merge, reverts after", async () => {
    const user = userEvent.setup();
    updateConfig({ selectedOrgs: [] });
    let resolveFetch!: (v: never[]) => void;
    vi.mocked(apiModule.fetchOrgs).mockReturnValue(
      new Promise((r) => { resolveFetch = r as (v: never[]) => void; })
    );
    renderSettings();
    const btn = screen.getByRole("button", { name: "Manage org access" });
    await user.click(btn);
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => {
      const syncBtn = screen.getByRole("button", { name: "Syncing..." });
      expect(syncBtn.hasAttribute("disabled")).toBe(true);
    });
    resolveFetch([]);
    await waitFor(() => {
      const restored = screen.getByRole("button", { name: "Manage org access" });
      expect(restored.hasAttribute("disabled")).toBe(false);
    });
  });

  it("auto-merges new orgs when window regains focus after granting", async () => {
    const user = userEvent.setup();
    updateConfig({ selectedOrgs: ["existing-org"] });
    vi.mocked(apiModule.fetchOrgs).mockResolvedValue([
      { login: "existing-org", avatarUrl: "", type: "org" },
      { login: "new-org", avatarUrl: "", type: "org" },
    ]);
    renderSettings();
    const btn = screen.getByRole("button", { name: "Manage org access" });
    await user.click(btn);
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => {
      expect(apiModule.fetchOrgs).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(config.selectedOrgs).toContain("new-org");
      expect(config.selectedOrgs).toContain("existing-org");
    });
  });

  it("pushes warning notification on fetchOrgs failure", async () => {
    const { pushNotification } = await import("../../../src/app/lib/errors");
    const user = userEvent.setup();
    updateConfig({ selectedOrgs: ["existing-org"] });
    vi.mocked(apiModule.fetchOrgs).mockRejectedValue(new Error("Network error"));
    renderSettings();
    const btn = screen.getByRole("button", { name: "Manage org access" });
    await user.click(btn);
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => {
      expect(apiModule.fetchOrgs).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(pushNotification).toHaveBeenCalledWith(
        "org-sync",
        expect.stringContaining("Failed to sync"),
        "warning",
      );
    });
    expect(config.selectedOrgs).toEqual(["existing-org"]);
  });

  it("skips merge on focus when getClient returns null", async () => {
    const user = userEvent.setup();
    const github = await import("../../../src/app/services/github");
    vi.mocked(github.getClient).mockReturnValueOnce(null);
    renderSettings();
    const btn = screen.getByRole("button", { name: "Manage org access" });
    await user.click(btn);
    window.dispatchEvent(new Event("focus"));
    await new Promise((r) => setTimeout(r, 50));
    expect(apiModule.fetchOrgs).not.toHaveBeenCalled();
  });

  it("rapid double-click deduplicates focus listeners", async () => {
    const user = userEvent.setup();
    const removeSpy = vi.spyOn(window, "removeEventListener");
    renderSettings();
    const btn = screen.getByRole("button", { name: "Manage org access" });
    await user.click(btn);
    await user.click(btn);
    const focusRemoves = removeSpy.mock.calls.filter(([evt]) => evt === "focus");
    expect(focusRemoves.length).toBeGreaterThanOrEqual(1);
  });

  it("cleans up pending focus listener on component unmount", async () => {
    const user = userEvent.setup();
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const { unmount } = renderSettings();
    const btn = screen.getByRole("button", { name: "Manage org access" });
    await user.click(btn);
    unmount();
    const focusRemoves = removeSpy.mock.calls.filter(([evt]) => evt === "focus");
    expect(focusRemoves.length).toBeGreaterThanOrEqual(1);
  });

  it("focus listener self-removes — second focus does not re-trigger merge", async () => {
    const user = userEvent.setup();
    updateConfig({ selectedOrgs: [] });
    vi.mocked(apiModule.fetchOrgs).mockResolvedValue([]);
    renderSettings();
    const btn = screen.getByRole("button", { name: "Manage org access" });
    await user.click(btn);
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => {
      expect(apiModule.fetchOrgs).toHaveBeenCalledTimes(1);
    });
    window.dispatchEvent(new Event("focus"));
    await new Promise((r) => setTimeout(r, 50));
    expect(apiModule.fetchOrgs).toHaveBeenCalledTimes(1);
  });
});

describe("SettingsPage — enableTracking toggle", () => {
  it("renders enableTracking toggle with aria-label 'Enable tracked items'", () => {
    renderSettings();
    const toggle = screen.getByRole("switch", { name: /enable tracked items/i });
    expect(toggle).toBeDefined();
  });

  it("toggles enableTracking setting", async () => {
    const user = userEvent.setup();
    updateConfig({ enableTracking: false });
    renderSettings();
    const toggle = screen.getByRole("switch", { name: /enable tracked items/i });
    await user.click(toggle);
    expect(config.enableTracking).toBe(true);
  });

  it("disabling tracking resets defaultTab to 'issues' when it was 'tracked'", async () => {
    const user = userEvent.setup();
    updateConfig({ enableTracking: true, defaultTab: "tracked" });
    renderSettings();
    const toggle = screen.getByRole("switch", { name: /enable tracked items/i });
    await user.click(toggle);
    expect(config.enableTracking).toBe(false);
    expect(config.defaultTab).toBe("issues");
  });

  it("disabling tracking preserves defaultTab when it was not 'tracked'", async () => {
    const user = userEvent.setup();
    updateConfig({ enableTracking: true, defaultTab: "pullRequests" });
    renderSettings();
    const toggle = screen.getByRole("switch", { name: /enable tracked items/i });
    await user.click(toggle);
    expect(config.enableTracking).toBe(false);
    expect(config.defaultTab).toBe("pullRequests");
  });

  it("shows 'Tracked Items' option in defaultTab select when enableTracking is true", async () => {
    const user = userEvent.setup();
    updateConfig({ enableTracking: true });
    renderSettings();
    await user.click(screen.getByRole("button", { name: "Issues" }));
    screen.getByRole("option", { name: "Tracked Items" });
  });

  it("hides 'Tracked Items' option in defaultTab select when enableTracking is false", async () => {
    const user = userEvent.setup();
    updateConfig({ enableTracking: false });
    renderSettings();
    // Open the trigger first — Kobalte doesn't mount role="option" elements until the
    // listbox opens, so querying for absence without opening would pass vacuously.
    await user.click(screen.getByRole("button", { name: "Issues" }));
    expect(screen.queryByRole("option", { name: "Tracked Items" })).toBeNull();
  });

  it("includes enableTracking in exported settings JSON", async () => {
    updateConfig({ enableTracking: true });
    renderSettings();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Export" }));
    const blobParts: BlobPart[] = [];
    const originalBlob = globalThis.Blob;
    globalThis.Blob = class MockBlob extends originalBlob {
      constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
        super(parts, options);
        if (parts) blobParts.push(...parts);
      }
    } as typeof Blob;
    await user.click(screen.getByRole("button", { name: "Export config only" }));
    globalThis.Blob = originalBlob;
    const json = JSON.parse(blobParts[0] as string);
    expect(json.enableTracking).toBe(true);
  });

  it("disabling tracking resets lastActiveTab to 'issues' when it was 'tracked'", async () => {
    const user = userEvent.setup();
    updateConfig({ enableTracking: true });
    updateViewState({ lastActiveTab: "tracked" });
    renderSettings();
    const toggle = screen.getByRole("switch", { name: /enable tracked items/i });
    await user.click(toggle);
    expect(config.enableTracking).toBe(false);
    expect(viewState.lastActiveTab).toBe("issues");
  });
});

describe("SettingsPage — custom tabs in default tab dropdown", () => {
  beforeEach(() => {
    // Ensure custom tabs are cleared before each test in this block
    updateConfig({ customTabs: [] });
  });

  it("custom tab name appears as an option in the default tab select", async () => {
    const user = userEvent.setup();
    updateConfig({
      customTabs: [{
        id: "custom-tab-1",
        name: "My Custom Tab",
        baseType: "issues" as const,
        orgScope: [],
        repoScope: [],
        filterPreset: {},
        exclusive: false,
      }],
    });
    renderSettings();
    await user.click(screen.getByRole("button", { name: "Issues" }));
    screen.getByRole("option", { name: "My Custom Tab" });
  });

  it("multiple custom tabs all appear in the default tab select", async () => {
    const user = userEvent.setup();
    updateConfig({
      customTabs: [
        {
          id: "tab-a",
          name: "Alpha Tab",
          baseType: "issues" as const,
          orgScope: [],
          repoScope: [],
          filterPreset: {},
          exclusive: false,
        },
        {
          id: "tab-b",
          name: "Beta Tab",
          baseType: "pullRequests" as const,
          orgScope: [],
          repoScope: [],
          filterPreset: {},
          exclusive: false,
        },
      ],
    });
    renderSettings();
    await user.click(screen.getByRole("button", { name: "Issues" }));
    screen.getByRole("option", { name: "Alpha Tab" });
    screen.getByRole("option", { name: "Beta Tab" });
  });

  it("selecting a custom tab as default updates config.defaultTab to its id", async () => {
    const user = userEvent.setup();
    updateConfig({
      customTabs: [{
        id: "my-tab",
        name: "My Tab",
        baseType: "issues" as const,
        orgScope: [],
        repoScope: [],
        filterPreset: {},
        exclusive: false,
      }],
    });
    renderSettings();
    const trigger = screen.getByRole("button", { name: "Issues" });
    await user.click(trigger);
    await user.click(screen.getByRole("option", { name: "My Tab" }));
    expect(config.defaultTab).toBe("my-tab");
  });
});

describe("SettingsPage — monitor toggle wiring", () => {
  it("shows monitored repos indicator when repos are monitored", () => {
    updateConfig({
      selectedRepos: [
        { owner: "org", name: "repo1", fullName: "org/repo1" },
        { owner: "org", name: "repo2", fullName: "org/repo2" },
      ],
      monitoredRepos: [
        { owner: "org", name: "repo1", fullName: "org/repo1" },
        { owner: "org", name: "repo2", fullName: "org/repo2" },
      ],
    });
    renderSettings();

    const indicator = screen.getByText(/Monitoring all:/);
    expect(indicator.textContent).toContain("org/repo1");
    expect(indicator.textContent).toContain("org/repo2");
  });

  it("hides monitored repos indicator when no repos are monitored", () => {
    updateConfig({ monitoredRepos: [] });
    renderSettings();

    expect(screen.queryByText(/Monitoring all:/)).toBeNull();
  });

  it("includes monitoredRepos in exported settings JSON", async () => {
    updateConfig({
      selectedRepos: [{ owner: "org", name: "repo1", fullName: "org/repo1" }],
      monitoredRepos: [{ owner: "org", name: "repo1", fullName: "org/repo1" }],
    });
    renderSettings();

    // Trigger export
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Export" }));
    const blobParts: BlobPart[] = [];
    const originalBlob = globalThis.Blob;
    globalThis.Blob = class MockBlob extends originalBlob {
      constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
        super(parts, options);
        if (parts) blobParts.push(...parts);
      }
    } as typeof Blob;

    await user.click(screen.getByRole("button", { name: "Export config only" }));

    globalThis.Blob = originalBlob;
    const json = JSON.parse(blobParts[0] as string);
    expect(json.monitoredRepos).toEqual([{ owner: "org", name: "repo1", fullName: "org/repo1" }]);
  });
});

// ── Dependencies section ──────────────────────────────────────────────────────

describe("Dependencies settings section", () => {
  it("renders Dependencies section heading", () => {
    renderSettings();
    screen.getByRole("heading", { name: "Dependencies" });
  });

  it("renders Dependencies tab toggle checked when enabled", () => {
    updateConfig({ dependencies: { enabled: true, rebaseLabel: "rebase", excludedOrgs: [], excludedRepos: [] } });
    renderSettings();
    const toggle = screen.getByRole<HTMLInputElement>("checkbox", { name: /Enable dependencies tab/i });
    expect(toggle.checked).toBe(true);
  });

  it("renders Dependencies tab toggle unchecked when disabled", () => {
    updateConfig({ dependencies: { enabled: false, rebaseLabel: "rebase", excludedOrgs: [], excludedRepos: [] } });
    renderSettings();
    const toggle = screen.getByRole<HTMLInputElement>("checkbox", { name: /Enable dependencies tab/i });
    expect(toggle.checked).toBe(false);
  });

  it("toggles dependencies.enabled when checkbox is clicked", () => {
    updateConfig({ dependencies: { enabled: true, rebaseLabel: "rebase", excludedOrgs: [], excludedRepos: [] } });
    renderSettings();
    const toggle = screen.getByRole("checkbox", { name: /Enable dependencies tab/i });
    fireEvent.click(toggle);
    expect(config.dependencies.enabled).toBe(false);
  });

  it("disabling dependencies resets defaultTab to 'issues' when it was 'dependencies'", () => {
    updateConfig({ dependencies: { enabled: true, rebaseLabel: "rebase", excludedOrgs: [], excludedRepos: [] }, defaultTab: "dependencies" });
    renderSettings();
    const toggle = screen.getByRole("checkbox", { name: /Enable dependencies tab/i });
    fireEvent.click(toggle);
    expect(config.dependencies.enabled).toBe(false);
    expect(config.defaultTab).toBe("issues");
  });

  it("disabling dependencies preserves defaultTab when it was not 'dependencies'", () => {
    updateConfig({ dependencies: { enabled: true, rebaseLabel: "rebase", excludedOrgs: [], excludedRepos: [] }, defaultTab: "pullRequests" });
    renderSettings();
    const toggle = screen.getByRole("checkbox", { name: /Enable dependencies tab/i });
    fireEvent.click(toggle);
    expect(config.dependencies.enabled).toBe(false);
    expect(config.defaultTab).toBe("pullRequests");
  });

  it("disabling dependencies resets lastActiveTab to 'issues' when it was 'dependencies'", () => {
    updateConfig({ dependencies: { enabled: true, rebaseLabel: "rebase", excludedOrgs: [], excludedRepos: [] } });
    updateViewState({ lastActiveTab: "dependencies" });
    renderSettings();
    const toggle = screen.getByRole("checkbox", { name: /Enable dependencies tab/i });
    fireEvent.click(toggle);
    expect(config.dependencies.enabled).toBe(false);
    expect(viewState.lastActiveTab).toBe("issues");
  });

  it("renders rebase label input with current value", () => {
    updateConfig({ dependencies: { enabled: true, rebaseLabel: "rebase-please", excludedOrgs: [], excludedRepos: [] } });
    renderSettings();
    const input = screen.getByRole<HTMLInputElement>("textbox", { name: /Rebase label/i });
    expect(input.value).toBe("rebase-please");
  });

  it("updates dependencies.rebaseLabel on input change", () => {
    updateConfig({ dependencies: { enabled: true, rebaseLabel: "rebase", excludedOrgs: [], excludedRepos: [] } });
    renderSettings();
    const input = screen.getByRole("textbox", { name: /Rebase label/i });
    fireEvent.input(input, { target: { value: "rebase-please" } });
    expect(config.dependencies.rebaseLabel).toBe("rebase-please");
  });

  it("rebase label input falls back to 'rebase' when cleared", () => {
    updateConfig({ dependencies: { enabled: true, rebaseLabel: "rebase", excludedOrgs: [], excludedRepos: [] } });
    renderSettings();
    const input = screen.getByRole("textbox", { name: /Rebase label/i });
    fireEvent.input(input, { target: { value: "" } });
    expect(config.dependencies.rebaseLabel).toBe("rebase");
  });

  it("renders 'None excluded' when excludedOrgs/excludedRepos are both empty", () => {
    updateConfig({ dependencies: { enabled: true, rebaseLabel: "rebase", excludedOrgs: [], excludedRepos: [] } });
    renderSettings();
    screen.getByText("None excluded");
  });

  it("renders the count summary when both excluded lists are non-empty", () => {
    updateConfig({
      dependencies: {
        enabled: true,
        rebaseLabel: "rebase",
        excludedOrgs: ["excluded-org"],
        excludedRepos: [
          { owner: "org1", name: "repo1", fullName: "org1/repo1" },
          { owner: "org1", name: "repo2", fullName: "org1/repo2" },
        ],
      },
    });
    renderSettings();
    screen.getByText("1 org, 2 repos");
  });

  it("renders '2 repos' (elideZero) when only excludedRepos is non-empty", () => {
    updateConfig({
      dependencies: {
        enabled: true,
        rebaseLabel: "rebase",
        excludedOrgs: [],
        excludedRepos: [
          { owner: "org1", name: "repo1", fullName: "org1/repo1" },
          { owner: "org1", name: "repo2", fullName: "org1/repo2" },
        ],
      },
    });
    renderSettings();
    screen.getByText("2 repos");
    expect(screen.queryByText("0 orgs, 2 repos")).toBeNull();
  });

  it("clicking Manage opens the exclusion modal", () => {
    updateConfig({ dependencies: { enabled: true, rebaseLabel: "rebase", excludedOrgs: [], excludedRepos: [] } });
    renderSettings();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    screen.getByText("Exclude from Dependencies");
  });

  it("saving an exclusion updates config and the Section 12 summary re-renders", () => {
    updateConfig({
      selectedRepos: [{ owner: "org1", name: "repo1", fullName: "org1/repo1" }],
      dependencies: { enabled: true, rebaseLabel: "rebase", excludedOrgs: [], excludedRepos: [] },
    });
    renderSettings();

    fireEvent.click(screen.getByRole("button", { name: "Manage" }));

    const repoCheckbox = screen
      .getAllByRole("checkbox")
      .find((cb) => cb.closest("label")?.textContent?.includes("repo1")) as HTMLInputElement;
    fireEvent.click(repoCheckbox);

    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    expect(config.dependencies.excludedRepos).toEqual([
      { owner: "org1", name: "repo1", fullName: "org1/repo1" },
    ]);
    expect(config.dependencies.excludedOrgs).toEqual([]);
    screen.getByText("1 repo");
  });

  it("de-dupes a repo present in both selectedRepos and monitoredRepos to a single checkbox and exclusion entry", () => {
    updateConfig({
      selectedRepos: [{ owner: "org1", name: "repo1", fullName: "org1/repo1" }],
      monitoredRepos: [{ owner: "org1", name: "repo1", fullName: "org1/repo1" }],
      dependencies: { enabled: true, rebaseLabel: "rebase", excludedOrgs: [], excludedRepos: [] },
    });
    renderSettings();

    fireEvent.click(screen.getByRole("button", { name: "Manage" }));

    const repoCheckboxes = screen
      .getAllByRole("checkbox")
      .filter((cb) => cb.closest("label")?.textContent?.includes("repo1"));
    expect(repoCheckboxes).toHaveLength(1);

    fireEvent.click(repoCheckboxes[0]);
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    expect(config.dependencies.excludedRepos).toEqual([
      { owner: "org1", name: "repo1", fullName: "org1/repo1" },
    ]);
  });
});

// ── Export with encrypted credentials ─────────────────────────────────────────

describe("SettingsPage — Data: Export with encrypted credentials", () => {
  const CODE = "1111-2222-3333-4444-5555-6666-77"; // 26-char Crockford base32, dashed

  it("shows the single-use warning in the choice dialog before the credentials action", async () => {
    const user = userEvent.setup();
    renderSettings();
    await user.click(screen.getByRole("button", { name: "Export" }));

    screen.getByText(
      "This is a one-time transfer, not a durable backup — the encrypted credentials can be imported once and expire in 30 days."
    );
  });

  it("choosing 'Export with encrypted credentials' shows the one-time-code modal and defers download until acknowledged", async () => {
    vi.mocked(settingsTransfer.buildEncryptedCredentialsSection).mockResolvedValue({
      sealed: "SEALED",
      salt: "SALT",
      oneTimeCode: CODE,
    });
    const createObjSpy = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:x");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const clickSpy = vi.fn();
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = origCreate(tag);
      if (tag === "a") vi.spyOn(el as HTMLAnchorElement, "click").mockImplementation(clickSpy);
      return el;
    });

    const user = userEvent.setup();
    renderSettings();
    await user.click(screen.getByRole("button", { name: "Export" }));
    await user.click(screen.getByRole("button", { name: "Export with encrypted credentials" }));

    await waitFor(() => screen.getByText(/shown only once/i));
    // Modal shows the generated code; download NOT yet triggered.
    screen.getByText(CODE);
    expect(createObjSpy).not.toHaveBeenCalled();
    expect(clickSpy).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /saved my code/i }));
    expect(createObjSpy).toHaveBeenCalledOnce();
    expect(clickSpy).toHaveBeenCalledOnce();
  });

  it("a seal failure pushes a warning, leaves the choice dialog open, and never downloads", async () => {
    const { pushNotification } = await import("../../../src/app/lib/errors");
    vi.mocked(settingsTransfer.buildEncryptedCredentialsSection).mockRejectedValue(new Error("seal failed"));
    const createObjSpy = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:x");

    const user = userEvent.setup();
    renderSettings();
    await user.click(screen.getByRole("button", { name: "Export" }));
    await user.click(screen.getByRole("button", { name: "Export with encrypted credentials" }));

    await waitFor(() => {
      expect(pushNotification).toHaveBeenCalledWith("settings-export", expect.any(String), "warning");
    });
    expect(createObjSpy).not.toHaveBeenCalled();
    // The choice dialog stays open so the user can retry without reopening it.
    screen.getByRole("button", { name: "Export with encrypted credentials" });
  });

  it("dismissing the code modal (Cancel) downloads nothing and leaves no residual state", async () => {
    vi.mocked(settingsTransfer.buildEncryptedCredentialsSection).mockResolvedValue({
      sealed: "SEALED", salt: "SALT", oneTimeCode: CODE,
    });
    const createObjSpy = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:x");
    const clickSpy = vi.fn();
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = origCreate(tag);
      if (tag === "a") vi.spyOn(el as HTMLAnchorElement, "click").mockImplementation(clickSpy);
      return el;
    });

    const user = userEvent.setup();
    renderSettings();
    await user.click(screen.getByRole("button", { name: "Export" }));
    await user.click(screen.getByRole("button", { name: "Export with encrypted credentials" }));
    await waitFor(() => screen.getByText(/shown only once/i));

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    // No file was downloaded on dismiss. (Kobalte's exit Presence lingers the
    // modal content in happy-dom, so this asserts the download behavior rather
    // than the modal's DOM removal.)
    expect(createObjSpy).not.toHaveBeenCalled();
    expect(clickSpy).not.toHaveBeenCalled();
    // No residual pending download: a fresh export cleanly re-runs the seal flow
    // (proving handleDismissExportCode cleared exportCode + pendingExportJson).
    // fireEvent (not userEvent): the dismissed Kobalte modal lingers its
    // pointer-events:none on <body> in happy-dom, blocking a userEvent click.
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    fireEvent.click(screen.getByRole("button", { name: "Export with encrypted credentials" }));
    await waitFor(() => expect(settingsTransfer.buildEncryptedCredentialsSection).toHaveBeenCalledTimes(2));
  });

  it("a second export while the code modal is open does NOT mint a new code / re-run the seal flow", async () => {
    const buildSpy = vi.mocked(settingsTransfer.buildEncryptedCredentialsSection).mockResolvedValue({
      sealed: "SEALED", salt: "SALT", oneTimeCode: CODE,
    });
    const user = userEvent.setup();
    renderSettings();
    // Captured BEFORE any dialog opens — once the code modal is open, the rest
    // of the page (including this button) is legitimately aria-hidden, so a
    // fresh getByRole query for it would correctly fail to find it. Reusing
    // this reference below dispatches directly on the node, bypassing that
    // (accurate) accessibility-tree filtering, the same way the real Kobalte
    // focus trap bypasses it for an actual re-click.
    const exportBtn = screen.getByRole("button", { name: "Export" });
    await user.click(exportBtn);
    await user.click(screen.getByRole("button", { name: "Export with encrypted credentials" }));
    await waitFor(() => screen.getByText(/shown only once/i));
    expect(buildSpy).toHaveBeenCalledTimes(1);

    // The Kobalte Dialog traps + restores focus so the Export button can't be
    // re-fired behind the modal; the re-entry guard on handleOpenExportChoice
    // closes the gap for any other trigger path. Re-fire the Export button
    // directly and assert the choice dialog doesn't even reopen.
    fireEvent.click(exportBtn);
    await Promise.resolve();
    await Promise.resolve();
    expect(buildSpy).toHaveBeenCalledTimes(1);
    screen.getByText(CODE); // the original code is still the one shown
  });

  it("CR-001/UI-001: the choice dialog cannot be dismissed mid-seal, but the code modal opens normally once the seal resolves", async () => {
    let resolveSeal!: (v: { sealed: string; salt: string; oneTimeCode: string }) => void;
    vi.mocked(settingsTransfer.buildEncryptedCredentialsSection).mockReturnValue(
      new Promise((r) => { resolveSeal = r; })
    );

    const user = userEvent.setup();
    renderSettings();
    await user.click(screen.getByRole("button", { name: "Export" }));
    await user.click(screen.getByRole("button", { name: "Export with encrypted credentials" }));

    // Seal in flight (exporting() === true): every dismissal control is disabled.
    await waitFor(() => screen.getByRole("button", { name: "Preparing..." }));
    const preparingBtn = screen.getByRole("button", { name: "Preparing..." });
    expect(preparingBtn.getAttribute("aria-busy")).toBe("true");
    const cancelBtn = screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
    const configOnlyBtn = screen.getByRole("button", { name: "Export config only" }) as HTMLButtonElement;
    expect(cancelBtn.disabled).toBe(true);
    expect(configOnlyBtn.disabled).toBe(true);

    // Defense-in-depth: forcing a click past the disabled attribute still
    // hits the handler's own `if (!exporting())` guard (the same condition
    // that gates the dialog's onOpenChange for Escape/overlay-click), so the
    // dialog stays open and no code modal appears while the seal is pending.
    cancelBtn.disabled = false;
    fireEvent.click(cancelBtn);
    screen.getByText("Choose what to include in the exported file."); // still open
    expect(screen.queryByText(/shown only once/i)).toBeNull();

    // The guard is scoped to the in-flight window only — once the seal
    // resolves, the one-time-code modal opens exactly as the unblocked flow
    // would.
    resolveSeal({ sealed: "SEALED", salt: "SALT", oneTimeCode: CODE });
    await waitFor(() => screen.getByText(/shown only once/i));
    screen.getByText(CODE);
  });

  it("post-await guard: resolving the seal after the component unmounts does not throw or leave a stray code modal", async () => {
    // Exercises the `if (!showExportChoice()) return` guard in
    // handleExportWithCredentials: the choice dialog can't be dismissed
    // through the UI while a seal is in flight (see the test above), but the
    // whole page can still be torn down out from under the pending await
    // (e.g. navigating away from Settings) — this proves that doesn't throw
    // or pop a stray one-time-code modal into the (now-gone) document.
    let resolveSeal!: (v: { sealed: string; salt: string; oneTimeCode: string }) => void;
    vi.mocked(settingsTransfer.buildEncryptedCredentialsSection).mockReturnValue(
      new Promise((r) => { resolveSeal = r; })
    );

    const user = userEvent.setup();
    const { unmount } = renderSettings();
    await user.click(screen.getByRole("button", { name: "Export" }));
    await user.click(screen.getByRole("button", { name: "Export with encrypted credentials" }));
    await waitFor(() => screen.getByRole("button", { name: "Preparing..." }));

    unmount();

    expect(() => resolveSeal({ sealed: "SEALED", salt: "SALT", oneTimeCode: CODE })).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(document.body.textContent).not.toContain(CODE);
    expect(document.body.textContent ?? "").not.toMatch(/shown only once/i);
  });
});

// ── Import with encrypted credentials ─────────────────────────────────────────

describe("SettingsPage — Data: Import with encrypted credentials", () => {
  const CODE = "1111-2222-3333-4444-5555-6666-77"; // 26-char Crockford base32, dashed
  const IDENTITY = { login: "octo", avatar_url: "https://avatars/octo", name: "Octo" };
  const BUNDLE = { github: { token: "ghp_x", method: "pat" as const }, jira: null };

  function selectCredFile(extra: Record<string, unknown> = {}) {
    const input = screen.getByLabelText(/import settings file/i);
    const content = JSON.stringify({ theme: "dark", ...extra, _credentials: { sealed: "S", salt: "SA" } });
    const file = new File([content], "settings.json", { type: "application/json" });
    fireEvent.change(input, { target: { files: [file] } });
  }

  it("valid _credentials + correct code: unseals once, shows identity confirm, confirm commits", async () => {
    vi.mocked(proxyLib.unsealCredentialBundle).mockResolvedValue({ ok: true, ciphertext: "CIPHER" });
    vi.mocked(settingsTransfer.resolveImportedCredentials).mockResolvedValue({ ok: true, bundle: BUNDLE, identity: IDENTITY });
    vi.mocked(settingsTransfer.commitImportedSettings).mockResolvedValue({ jiraRestored: true });

    const user = userEvent.setup();
    renderSettings();
    selectCredFile();
    await waitFor(() => screen.getByLabelText(/one-time code/i));
    await user.type(screen.getByLabelText(/one-time code/i), CODE);
    await user.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => screen.getByText(/sign you in as/i));
    expect(proxyLib.unsealCredentialBundle).toHaveBeenCalledTimes(1);
    screen.getByText(/@octo/);

    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => {
      expect(settingsTransfer.commitImportedSettings).toHaveBeenCalledWith(
        { bundle: BUNDLE, identity: IDENTITY },
        expect.objectContaining({ theme: "dark" }),
        undefined // no _viewPreferences section in this test's file content
      );
    });
  });

  it("wrong code then correct code: retries on cached ciphertext, unseals only ONCE total", async () => {
    vi.mocked(proxyLib.unsealCredentialBundle).mockResolvedValue({ ok: true, ciphertext: "CIPHER" });
    vi.mocked(settingsTransfer.resolveImportedCredentials)
      .mockResolvedValueOnce({ ok: false, error: "Couldn't decrypt credentials — check the code and file match." })
      .mockResolvedValueOnce({ ok: true, bundle: BUNDLE, identity: IDENTITY });

    const user = userEvent.setup();
    renderSettings();
    selectCredFile();
    await waitFor(() => screen.getByLabelText(/one-time code/i));

    const codeField = screen.getByLabelText(/one-time code/i);
    await user.type(codeField, "wrong-code");
    await user.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => screen.getByText(/check the code and file match/i));
    expect(screen.queryByText(/sign you in as/i)).toBeNull();

    await user.clear(codeField);
    await user.type(codeField, CODE);
    await user.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => screen.getByText(/sign you in as/i));

    expect(proxyLib.unsealCredentialBundle).toHaveBeenCalledTimes(1);
  });

  it("expired unseal shows the distinct expired message with no code-retry prompt", async () => {
    vi.mocked(proxyLib.unsealCredentialBundle).mockResolvedValue({ ok: false, reason: "expired" });

    const user = userEvent.setup();
    renderSettings();
    selectCredFile();
    await waitFor(() => screen.getByLabelText(/one-time code/i));
    await user.type(screen.getByLabelText(/one-time code/i), CODE);
    await user.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => screen.getByText(/expired/i));
    // The code input is gone — the single-use bundle is spent, only the fallback remains.
    expect(screen.queryByLabelText(/one-time code/i)).toBeNull();
    screen.getByRole("button", { name: /continue without credentials/i });
  });

  it("an invalid (non-expired) unseal shows the single-use terminal message, distinct from 'expired'", async () => {
    vi.mocked(proxyLib.unsealCredentialBundle).mockResolvedValue({ ok: false, reason: "invalid" });

    const user = userEvent.setup();
    renderSettings();
    selectCredFile();
    await waitFor(() => screen.getByLabelText(/one-time code/i));
    await user.type(screen.getByLabelText(/one-time code/i), CODE);
    await user.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() =>
      screen.getByText(
        "Couldn't restore credentials — this file may already have been used (single-use), or the code/file don't match. Re-export to try again."
      )
    );
    expect(screen.queryByText(/expired/i)).toBeNull();
    // The code input is gone — the single-use bundle is spent, only the fallback remains.
    expect(screen.queryByLabelText(/one-time code/i)).toBeNull();
    screen.getByRole("button", { name: /continue without credentials/i });
  });

  it("R-101: a turnstile failure keeps the code input (retryable) and re-unseals on retry", async () => {
    // A client-side Turnstile failure happens BEFORE any request, so the nonce is
    // never consumed — this is retryable, NOT the terminal expired/invalid screen.
    vi.mocked(proxyLib.unsealCredentialBundle)
      .mockResolvedValueOnce({ ok: false, reason: "turnstile" })
      .mockResolvedValueOnce({ ok: true, ciphertext: "CIPHER" });
    vi.mocked(settingsTransfer.resolveImportedCredentials).mockResolvedValue({ ok: true, bundle: BUNDLE, identity: IDENTITY });

    const user = userEvent.setup();
    renderSettings();
    selectCredFile();
    await waitFor(() => screen.getByLabelText(/one-time code/i));
    await user.type(screen.getByLabelText(/one-time code/i), CODE);
    await user.click(screen.getByRole("button", { name: "Submit" }));

    // Retryable inline error; code input + Submit still present (non-terminal).
    await waitFor(() => screen.getByText(/verification failed/i));
    screen.getByLabelText(/one-time code/i);
    screen.getByRole("button", { name: "Submit" });

    // Retry re-attempts the unseal (nonce never consumed) → success → confirm.
    await user.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => screen.getByText(/sign you in as/i));
    expect(proxyLib.unsealCredentialBundle).toHaveBeenCalledTimes(2);
  });

  it("concurrent double-submit calls unsealCredentialBundle EXACTLY once (in-flight guard)", async () => {
    let resolveUnseal!: (v: { ok: true; ciphertext: string }) => void;
    vi.mocked(proxyLib.unsealCredentialBundle).mockReturnValue(
      new Promise((r) => { resolveUnseal = r; })
    );
    vi.mocked(settingsTransfer.resolveImportedCredentials).mockResolvedValue({ ok: true, bundle: BUNDLE, identity: IDENTITY });

    renderSettings();
    selectCredFile();
    await waitFor(() => screen.getByLabelText(/one-time code/i));
    const codeField = screen.getByLabelText(/one-time code/i) as HTMLInputElement;
    fireEvent.input(codeField, { target: { value: CODE } });
    const form = codeField.closest("form")!;
    // Two submits fired before the first unseal resolves — guard must dedupe.
    fireEvent.submit(form);
    fireEvent.submit(form);
    resolveUnseal({ ok: true, ciphertext: "CIPHER" });

    await waitFor(() => {
      expect(proxyLib.unsealCredentialBundle).toHaveBeenCalledTimes(1);
    });
  });

  it("pr-test-2: concurrent double-click on Continue calls commitImportedSettings EXACTLY once (in-flight guard)", async () => {
    vi.mocked(proxyLib.unsealCredentialBundle).mockResolvedValue({ ok: true, ciphertext: "CIPHER" });
    vi.mocked(settingsTransfer.resolveImportedCredentials).mockResolvedValue({ ok: true, bundle: BUNDLE, identity: IDENTITY });
    let resolveCommit!: (v: { jiraRestored: boolean }) => void;
    vi.mocked(settingsTransfer.commitImportedSettings).mockReturnValue(
      new Promise((r) => { resolveCommit = r; })
    );

    const user = userEvent.setup();
    renderSettings();
    selectCredFile();
    await waitFor(() => screen.getByLabelText(/one-time code/i));
    await user.type(screen.getByLabelText(/one-time code/i), CODE);
    await user.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => screen.getByText(/sign you in as/i));

    const continueBtn = screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;
    fireEvent.click(continueBtn);
    // Force a second dispatch past the (already-applied) disabled attribute to
    // exercise the in-function re-entry guard directly.
    continueBtn.disabled = false;
    fireEvent.click(continueBtn);
    resolveCommit({ jiraRestored: true });

    await waitFor(() => {
      expect(settingsTransfer.commitImportedSettings).toHaveBeenCalledTimes(1);
    });
  });

  it("'continue without credentials' routes through the shared two-click confirm, then applies plaintext config (no unseal)", async () => {
    const user = userEvent.setup();
    updateConfig({ theme: "light" });
    renderSettings();
    selectCredFile();
    await waitFor(() => screen.getByLabelText(/one-time code/i));
    await user.click(screen.getByRole("button", { name: /continue without credentials/i }));

    // UI-003: the SAME plaintext two-click confirm the plaintext-import path uses
    // appears (inline in the Import row) — nothing applied until it's confirmed.
    // (The Kobalte dialog's exit Presence doesn't unmount synchronously in
    // happy-dom, so this asserts behavior rather than the code input's removal —
    // matching the CustomTabModal/NotificationDrawer test convention.)
    await waitFor(() => screen.getByRole("button", { name: "Yes, import" }));
    expect(config.theme).toBe("light");

    // fireEvent (not userEvent): the just-closed Kobalte modal lingers its
    // pointer-events:none on <body> in happy-dom, which would block a userEvent
    // pointer interaction with this now-inline confirm button.
    fireEvent.click(screen.getByRole("button", { name: "Yes, import" }));
    expect(config.theme).toBe("dark"); // plaintext config applied on confirm
    expect(proxyLib.unsealCredentialBundle).not.toHaveBeenCalled();
  });

  it("declining (Cancel) leaves the session and config untouched", async () => {
    const user = userEvent.setup();
    updateConfig({ theme: "light" });
    renderSettings();
    selectCredFile();
    await waitFor(() => screen.getByLabelText(/one-time code/i));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    // Config + session untouched, no unseal attempted, and no identity-confirm or
    // plaintext-confirm was triggered. (Kobalte's exit Presence lingers the code
    // input in happy-dom, so this asserts behavior rather than DOM removal.)
    expect(config.theme).toBe("light");
    expect(proxyLib.unsealCredentialBundle).not.toHaveBeenCalled();
    expect(screen.queryByText(/sign you in as/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Yes, import" })).toBeNull();
  });

  it("a null _credentials falls through to the plaintext import path (no code prompt)", async () => {
    const user = userEvent.setup();
    renderSettings();
    const input = screen.getByLabelText(/import settings file/i);
    const file = new File([JSON.stringify({ theme: "dark", _credentials: null })], "s.json", { type: "application/json" });
    fireEvent.change(input, { target: { files: [file] } });
    // No code prompt; the plaintext two-click confirm appears instead.
    await waitFor(() => screen.getByRole("button", { name: "Yes, import" }));
    expect(screen.queryByLabelText(/one-time code/i)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Yes, import" }));
    expect(config.theme).toBe("dark");
  });

  it("Cancel and 'continue without credentials' are disabled while the unseal is in flight", async () => {
    let resolveUnseal!: (v: { ok: true; ciphertext: string }) => void;
    vi.mocked(proxyLib.unsealCredentialBundle).mockReturnValue(new Promise((r) => { resolveUnseal = r; }));
    vi.mocked(settingsTransfer.resolveImportedCredentials).mockResolvedValue({ ok: true, bundle: BUNDLE, identity: IDENTITY });

    const user = userEvent.setup();
    renderSettings();
    selectCredFile();
    await waitFor(() => screen.getByLabelText(/one-time code/i));
    await user.type(screen.getByLabelText(/one-time code/i), CODE);
    await user.click(screen.getByRole("button", { name: "Submit" }));

    // Unseal in flight — the single-use nonce must not be abandonable mid-flight.
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true)
    );
    expect((screen.getByRole("button", { name: /continue without credentials/i }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Checking..." }) as HTMLButtonElement).disabled).toBe(true);

    resolveUnseal({ ok: true, ciphertext: "CIPHER" });
    await waitFor(() => screen.getByText(/sign you in as/i));
  });

  it("a Cancel-then-reselect during resolve discards the stale continuation (no wrong-identity dialog)", async () => {
    // Unseal resolves immediately; resolve is deferred so the test can cancel and
    // reselect a different file while file X's resolve is still pending.
    vi.mocked(proxyLib.unsealCredentialBundle).mockResolvedValue({ ok: true, ciphertext: "CIPHER-X" });
    let finishResolveX!: (v: { ok: true; bundle: typeof BUNDLE; identity: typeof IDENTITY }) => void;
    vi.mocked(settingsTransfer.resolveImportedCredentials).mockReturnValueOnce(
      new Promise((r) => { finishResolveX = r as never; })
    );

    const user = userEvent.setup();
    renderSettings();
    selectCredFile(); // file X
    await waitFor(() => screen.getByLabelText(/one-time code/i));
    await user.type(screen.getByLabelText(/one-time code/i), CODE);
    await user.click(screen.getByRole("button", { name: "Submit" }));

    // X's unseal done (unsealInFlight false), X's resolve in flight — Cancel enabled.
    await waitFor(() => expect(proxyLib.unsealCredentialBundle).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "Cancel" })); // abandons file X (gen++)

    // Reselect a different file Y.
    selectCredFile({ theme: "light" });
    await waitFor(() => screen.getByLabelText(/one-time code/i)); // Y's code form

    // X's stale resolve now completes — the generation guard must discard it.
    finishResolveX({ ok: true, bundle: BUNDLE, identity: IDENTITY });
    await Promise.resolve();
    await Promise.resolve();

    // No identity-confirm dialog appears for the abandoned file's identity, and
    // no commit happens; the freshly-selected file's code form is still shown.
    expect(screen.queryByText(/sign you in as/i)).toBeNull();
    expect(settingsTransfer.commitImportedSettings).not.toHaveBeenCalled();
    screen.getByLabelText(/one-time code/i);
  });

  it("a retryable network unseal keeps the code input available (not terminal)", async () => {
    vi.mocked(proxyLib.unsealCredentialBundle).mockResolvedValue({ ok: false, reason: "network" });
    const user = userEvent.setup();
    renderSettings();
    selectCredFile();
    await waitFor(() => screen.getByLabelText(/one-time code/i));
    await user.type(screen.getByLabelText(/one-time code/i), CODE);
    await user.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/network problem/i));
    // Non-terminal: the code input + Submit stay available (no terminal screen).
    screen.getByLabelText(/one-time code/i);
    screen.getByRole("button", { name: "Submit" });
  });

  it("a rate-limited unseal keeps the code input available with a retryable message", async () => {
    vi.mocked(proxyLib.unsealCredentialBundle).mockResolvedValue({ ok: false, reason: "rate-limited" });
    const user = userEvent.setup();
    renderSettings();
    selectCredFile();
    await waitFor(() => screen.getByLabelText(/one-time code/i));
    await user.type(screen.getByLabelText(/one-time code/i), CODE);
    await user.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/too many attempts/i));
    screen.getByLabelText(/one-time code/i);
  });

  it("a commit failure during cred import pushes a warning (handleConfirmCredImport catch branch)", async () => {
    const { pushNotification } = await import("../../../src/app/lib/errors");
    vi.mocked(proxyLib.unsealCredentialBundle).mockResolvedValue({ ok: true, ciphertext: "CIPHER" });
    vi.mocked(settingsTransfer.resolveImportedCredentials).mockResolvedValue({ ok: true, bundle: BUNDLE, identity: IDENTITY });
    vi.mocked(settingsTransfer.commitImportedSettings).mockRejectedValue(new Error("commit boom"));

    const user = userEvent.setup();
    renderSettings();
    selectCredFile();
    await waitFor(() => screen.getByLabelText(/one-time code/i));
    await user.type(screen.getByLabelText(/one-time code/i), CODE);
    await user.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => screen.getByText(/sign you in as/i));
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(pushNotification).toHaveBeenCalledWith(
        "settings-import",
        expect.stringMatching(/something went wrong/i),
        "warning"
      );
    });
  });

  it("CR-001: after import, the Repositories editor reflects the imported repos (local copies resynced)", async () => {
    const user = userEvent.setup();
    updateConfig({ selectedRepos: [], upstreamRepos: [] });
    renderSettings();
    const input = screen.getByLabelText(/import settings file/i);
    const imported = JSON.stringify({
      selectedRepos: [
        { owner: "acme", name: "api", fullName: "acme/api" },
        { owner: "acme", name: "web", fullName: "acme/web" },
      ],
    });
    fireEvent.change(input, { target: { files: [new File([imported], "s.json", { type: "application/json" })] } });
    await waitFor(() => screen.getByRole("button", { name: "Yes, import" }));
    await user.click(screen.getByRole("button", { name: "Yes, import" }));

    expect(config.selectedRepos).toHaveLength(2);
    // The Repositories summary is driven by the localRepos editor copy; without
    // the post-import resync it would still read the stale (empty) pre-import set.
    await waitFor(() => screen.getByText(/2 selected/i));
  });
});
