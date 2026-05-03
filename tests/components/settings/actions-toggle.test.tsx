import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent } from "@solidjs/testing-library";

// ── localStorage mock ────────────────────────────────────────────────────────

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
  jiraAuth: () => null,
  isJiraAuthenticated: () => false,
  ensureJiraTokenValid: vi.fn(),
  token: () => "fake-token",
  user: () => ({ login: "testuser", name: "Test User" }),
  onAuthCleared: vi.fn(),
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

// ── Imports after mocks ──────────────────────────────────────────────────────

import { render } from "@solidjs/testing-library";
import { MemoryRouter, Route } from "@solidjs/router";
import SettingsPage from "../../../src/app/components/settings/SettingsPage";
import { updateConfig, config } from "../../../src/app/stores/config";
import { viewState, updateViewState } from "../../../src/app/stores/view";
import * as urlModule from "../../../src/app/lib/url";

// ── Helpers ──────────────────────────────────────────────────────────────────

function renderSettings() {
  return render(() => (
    <MemoryRouter>
      <Route path="*" component={SettingsPage} />
    </MemoryRouter>
  ));
}

function setupMatchMedia() {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
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

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  setupMatchMedia();
  vi.clearAllMocks();
  vi.mocked(urlModule.isSafeGitHubUrl).mockReturnValue(true);

  updateConfig({
    refreshInterval: 300,
    maxWorkflowsPerRepo: 5,
    maxRunsPerWorkflow: 3,
    theme: "light",
    viewDensity: "comfortable",
    itemsPerPage: 25,
    defaultTab: "issues",
    rememberLastTab: true,
    enableActions: true,
    notifications: { enabled: true, issues: true, pullRequests: true, workflowRuns: true },
    selectedOrgs: [],
    selectedRepos: [],
    authMethod: "oauth" as const,
  });

  updateViewState({ lastActiveTab: "issues" });
  sessionStorage.clear();
  localStorageMock.clear();

  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { reload: vi.fn(), href: "", origin: "http://localhost" },
  });

  Object.defineProperty(window, "Notification", {
    writable: true,
    value: { permission: "default", requestPermission: vi.fn().mockResolvedValue("granted") },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Actions enable toggle", () => {
  it("renders checked by default (enableActions defaults to true)", () => {
    renderSettings();
    const toggle = screen.getByRole("switch", { name: /show actions tab/i }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
  });

  it("toggling off sets enableActions to false", () => {
    renderSettings();
    const toggle = screen.getByRole("switch", { name: /show actions tab/i });
    fireEvent.click(toggle);
    expect(config.enableActions).toBe(false);
  });

  it("toggling off resets defaultTab to 'issues' when it was 'actions'", () => {
    updateConfig({ defaultTab: "actions" });
    renderSettings();
    const toggle = screen.getByRole("switch", { name: /show actions tab/i });
    fireEvent.click(toggle);
    expect(config.defaultTab).toBe("issues");
  });

  it("toggling off resets lastActiveTab to 'issues' when it was 'actions'", () => {
    updateViewState({ lastActiveTab: "actions" });
    renderSettings();
    const toggle = screen.getByRole("switch", { name: /show actions tab/i });
    fireEvent.click(toggle);
    expect(viewState.lastActiveTab).toBe("issues");
  });

  it("toggling off suppresses workflowRuns notification", () => {
    renderSettings();
    const toggle = screen.getByRole("switch", { name: /show actions tab/i });
    fireEvent.click(toggle);
    expect(config.notifications.workflowRuns).toBe(false);
  });

  it("re-enable does NOT auto-restore workflowRuns notification", () => {
    renderSettings();
    const toggle = screen.getByRole("switch", { name: /show actions tab/i });
    // Disable
    fireEvent.click(toggle);
    expect(config.notifications.workflowRuns).toBe(false);
    // Re-enable
    fireEvent.click(toggle);
    expect(config.notifications.workflowRuns).toBe(false);
  });
});

describe("Actions settings controls disabled state", () => {
  it("max workflows and max runs inputs are disabled when enableActions is false", () => {
    updateConfig({ enableActions: false });
    renderSettings();
    const spinbuttons = screen.getAllByRole("spinbutton") as HTMLInputElement[];
    const actionsInputs = spinbuttons.filter((el) => el.classList.contains("opacity-50"));
    expect(actionsInputs.length).toBeGreaterThanOrEqual(2);
    actionsInputs.forEach((input) => expect(input.disabled).toBe(true));
  });

  it("max workflows and max runs inputs are enabled when enableActions is true", () => {
    renderSettings();
    const spinbuttons = screen.getAllByRole("spinbutton") as HTMLInputElement[];
    const enabledInputs = spinbuttons.filter((el) => !el.disabled);
    expect(enabledInputs.length).toBeGreaterThanOrEqual(2);
  });

  it("workflow runs notification toggle is disabled when Actions is off", () => {
    updateConfig({ enableActions: false });
    renderSettings();
    const toggle = screen.getByRole("switch", { name: /workflow runs notifications/i }) as HTMLInputElement;
    expect(toggle.disabled).toBe(true);
  });

  it("shows explanatory text for workflow runs when Actions is off", () => {
    updateConfig({ enableActions: false });
    renderSettings();
    expect(screen.getByText(/disabled — github actions is off/i)).toBeTruthy();
  });
});

describe("Actions toggle — negative cases", () => {
  it("toggling off does NOT reset defaultTab when it was not 'actions'", () => {
    updateConfig({ defaultTab: "pullRequests" });
    renderSettings();
    const toggle = screen.getByRole("switch", { name: /show actions tab/i });
    fireEvent.click(toggle);
    expect(config.defaultTab).toBe("pullRequests");
  });

  it("toggling off does NOT reset lastActiveTab when it was not 'actions'", () => {
    updateViewState({ lastActiveTab: "pullRequests" });
    renderSettings();
    const toggle = screen.getByRole("switch", { name: /show actions tab/i });
    fireEvent.click(toggle);
    expect(viewState.lastActiveTab).toBe("pullRequests");
  });

  it("toggling off does NOT change issues or pullRequests notification settings", () => {
    updateConfig({
      notifications: { enabled: true, issues: true, pullRequests: true, workflowRuns: true },
    });
    renderSettings();
    const toggle = screen.getByRole("switch", { name: /show actions tab/i });
    fireEvent.click(toggle);
    expect(config.notifications.issues).toBe(true);
    expect(config.notifications.pullRequests).toBe(true);
  });
});

describe("Actions toggle — default tab dropdown filtering", () => {
  it("excludes GitHub Actions option from default tab select when enableActions is false", () => {
    updateConfig({ enableActions: false });
    renderSettings();
    const selects = document.querySelectorAll("select");
    let actionsOptionFound = false;
    for (const sel of selects) {
      for (const opt of sel.options) {
        if (opt.value === "actions") {
          actionsOptionFound = true;
          break;
        }
      }
    }
    expect(actionsOptionFound).toBe(false);
  });

  it("includes GitHub Actions option in default tab select when enableActions is true", () => {
    renderSettings();
    const selects = document.querySelectorAll("select");
    let actionsOptionFound = false;
    for (const sel of selects) {
      for (const opt of sel.options) {
        if (opt.value === "actions") {
          actionsOptionFound = true;
          break;
        }
      }
    }
    expect(actionsOptionFound).toBe(true);
  });
});
