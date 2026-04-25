import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@solidjs/testing-library";
import { MemoryRouter, Route } from "@solidjs/router";

// ── localStorage mock ─────────────────────────────────────────────────────────

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

// ── Module mocks ──────────────────────────────────────────────────────────────
// All mocks defined before any imports from the module under test.

vi.mock("../../../src/app/stores/cache", () => ({
  clearCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/app/lib/errors", () => ({
  pushNotification: vi.fn(),
  pushError: vi.fn(),
  getErrors: vi.fn(() => []),
  getNotifications: vi.fn(() => []),
  getUnreadCount: vi.fn(() => 0),
  markAllAsRead: vi.fn(),
  dismissError: vi.fn(),
}));

const mockClearJiraAuth = vi.fn();
const mockSetJiraAuth = vi.fn();
const mockIsJiraAuthenticated = vi.fn(() => false);
const mockJiraAuth = vi.fn(() => null as Record<string, unknown> | null);

vi.mock("../../../src/app/stores/auth", () => ({
  clearAuth: vi.fn(),
  clearJiraAuth: (...args: unknown[]) => mockClearJiraAuth(...args),
  setJiraAuth: (...args: unknown[]) => mockSetJiraAuth(...args),
  jiraAuth: () => mockJiraAuth(),
  isJiraAuthenticated: () => mockIsJiraAuthenticated(),
  token: () => "fake-token",
  user: () => ({ login: "testuser", name: "Test User", avatar_url: "" }),
  onAuthCleared: vi.fn(),
}));

const mockUpdateJiraConfig = vi.fn();
const mockUpdateConfig = vi.fn();
let mockConfig = {
  selectedOrgs: [],
  selectedRepos: [],
  upstreamRepos: [],
  monitoredRepos: [],
  trackedUsers: [],
  refreshInterval: 300,
  hotPollInterval: 30,
  maxWorkflowsPerRepo: 5,
  maxRunsPerWorkflow: 3,
  notifications: { enabled: false, issues: true, pullRequests: true, workflowRuns: true },
  theme: "auto" as const,
  viewDensity: "comfortable" as const,
  itemsPerPage: 25,
  defaultTab: "issues",
  rememberLastTab: true,
  enableTracking: false,
  customTabs: [],
  mcpRelayEnabled: false,
  mcpRelayPort: 9876,
  authMethod: "oauth" as const,
  onboardingComplete: true,
  jira: { enabled: false, authMethod: "oauth" as const, issueKeyDetection: true } as { enabled: boolean; authMethod: "oauth" | "token"; issueKeyDetection: boolean; cloudId?: string; siteUrl?: string; siteName?: string; email?: string },
};

vi.mock("../../../src/app/stores/config", () => ({
  config: new Proxy({} as typeof mockConfig, {
    get(_t, key: string) { return mockConfig[key as keyof typeof mockConfig]; },
  }),
  updateConfig: (...args: unknown[]) => mockUpdateConfig(...args),
  updateJiraConfig: (...args: unknown[]) => mockUpdateJiraConfig(...args),
  setMonitoredRepo: vi.fn(),
  CONFIG_STORAGE_KEY: "github-tracker:config",
  ConfigSchema: { parse: vi.fn((x: unknown) => x) },
  THEME_OPTIONS: ["auto", "corporate"],
  BUILTIN_TAB_IDS: ["issues", "pullRequests", "actions", "tracked"],
  isBuiltinTab: (id: string) => ["issues", "pullRequests", "actions", "tracked"].includes(id),
  CustomTabSchema: { parse: vi.fn((x: unknown) => x) },
  DARK_THEMES: new Set(["dim", "dracula", "dark", "forest"]),
  resetConfig: vi.fn(),
  loadConfig: vi.fn(),
  getCustomTab: vi.fn(),
}));

vi.mock("../../../src/app/stores/view", () => ({
  viewState: { lastActiveTab: "issues", tabFilters: {}, expandedRepos: {}, lockedRepos: {}, trackedItems: [], activeScopeTab: "involved" },
  updateViewState: vi.fn(),
  resetViewState: vi.fn(),
  ViewStateSchema: { parse: vi.fn((x: unknown) => x) },
}));

vi.mock("../../../src/app/services/api", () => ({
  fetchOrgs: vi.fn(() => Promise.resolve([])),
  getClient: vi.fn(() => null),
}));

vi.mock("../../../src/app/services/github", () => ({
  getClient: vi.fn(() => null),
  getGraphqlRateLimit: vi.fn(() => null),
  fetchRateLimitDetails: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("../../../src/app/services/api-usage", () => ({
  getUsageSnapshot: vi.fn(() => []),
  getUsageResetAt: vi.fn(() => null),
  resetUsageData: vi.fn(),
  checkAndResetIfExpired: vi.fn(),
  trackApiCall: vi.fn(),
  updateResetAt: vi.fn(),
  SOURCE_LABELS: {},
}));

vi.mock("../../../src/app/lib/mcp-relay", () => ({
  getRelayStatus: vi.fn(() => "disconnected"),
}));

vi.mock("../../../src/app/lib/url", () => ({
  isSafeGitHubUrl: vi.fn(() => true),
  openGitHubUrl: vi.fn(),
}));

const mockBuildJiraAuthorizeUrl = vi.fn(() => "https://auth.atlassian.com/authorize?mock=1");

vi.mock("../../../src/app/lib/oauth", () => ({
  buildJiraAuthorizeUrl: () => mockBuildJiraAuthorizeUrl(),
  buildOrgAccessUrl: vi.fn(() => "https://github.com/settings/connections/applications/test"),
  buildAuthorizeUrl: vi.fn(() => "https://github.com/login/oauth/authorize?mock"),
  generateOAuthState: vi.fn(() => "mock-state"),
  JIRA_OAUTH_STATE_KEY: "github-tracker:jira-oauth-state",
  OAUTH_STATE_KEY: "github-tracker:oauth-state",
  OAUTH_RETURN_TO_KEY: "github-tracker:oauth-return-to",
}));

const mockSealApiToken = vi.fn();

vi.mock("../../../src/app/lib/proxy", () => ({
  sealApiToken: (...args: unknown[]) => mockSealApiToken(...args),
  proxyFetch: vi.fn(),
}));

vi.mock("../../../src/app/services/jira-keys", () => ({
  clearJiraKeyCache: vi.fn(),
}));

// Component imports after all mocks
import SettingsPage from "../../../src/app/components/settings/SettingsPage";

// ── Helpers ───────────────────────────────────────────────────────────────────

function renderSettings() {
  return render(() => (
    <MemoryRouter>
      <Route path="*" component={SettingsPage} />
    </MemoryRouter>
  ));
}

function setEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    vi.stubEnv(key, undefined as unknown as string);
  } else {
    vi.stubEnv(key, value);
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────
// TODO: Fix SettingsPage mock setup — too many unmocked dependencies cause render timeouts

describe("SettingsPage Jira section — section visibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsJiraAuthenticated.mockReturnValue(false);
    mockJiraAuth.mockReturnValue(null);
    mockConfig = { ...mockConfig, jira: { enabled: false, authMethod: "oauth", issueKeyDetection: true } };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("Jira section is visible even when VITE_JIRA_CLIENT_ID is absent", async () => {
    setEnv("VITE_JIRA_CLIENT_ID", undefined);
    renderSettings();
    await waitFor(() => {
      expect(screen.getByText("Jira Cloud Integration")).toBeTruthy();
    });
  });

  it("OAuth button is hidden when VITE_JIRA_CLIENT_ID is absent", async () => {
    setEnv("VITE_JIRA_CLIENT_ID", undefined);
    renderSettings();
    await waitFor(() => {
      expect(screen.queryByText(/Connect with Jira OAuth/i)).toBeNull();
      expect(screen.getByText(/Use API token/i)).toBeTruthy();
    });
  });

  it("OAuth button is hidden when VITE_JIRA_CLIENT_ID is empty string", async () => {
    setEnv("VITE_JIRA_CLIENT_ID", "");
    renderSettings();
    await waitFor(() => {
      expect(screen.queryByText(/Connect with Jira OAuth/i)).toBeNull();
      expect(screen.getByText(/Use API token/i)).toBeTruthy();
    });
  });

  it("both OAuth and API token buttons visible when VITE_JIRA_CLIENT_ID is valid", async () => {
    setEnv("VITE_JIRA_CLIENT_ID", "valid-client-id-123");
    renderSettings();
    await waitFor(() => {
      expect(screen.getByText("Jira Cloud Integration")).toBeTruthy();
      expect(screen.getByText(/Connect with Jira OAuth/i)).toBeTruthy();
      expect(screen.getByText(/Use API token/i)).toBeTruthy();
    });
  });
});

describe("SettingsPage Jira section — disconnected state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnv("VITE_JIRA_CLIENT_ID", "valid-client-id");
    mockIsJiraAuthenticated.mockReturnValue(false);
    mockJiraAuth.mockReturnValue(null);
    mockConfig = { ...mockConfig, jira: { enabled: false, authMethod: "oauth", issueKeyDetection: true } };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("shows Connect with Jira OAuth button when disconnected", async () => {
    renderSettings();
    await waitFor(() => {
      expect(screen.getByText(/Connect with Jira OAuth/i)).toBeTruthy();
    });
  });

  it("shows Use API token button when disconnected", async () => {
    renderSettings();
    await waitFor(() => {
      expect(screen.getByText(/Use API token/i)).toBeTruthy();
    });
  });

  it("OAuth connect button sets window.location.href to authorize URL", async () => {
    const assignMock = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, assign: assignMock },
    });

    // Track href assignment via defineProperty
    let capturedHref = "";
    const locationStub = {
      replace: vi.fn(),
      assign: vi.fn(),
      get href() { return capturedHref; },
      set href(val: string) { capturedHref = val; },
    };
    vi.stubGlobal("location", locationStub);

    mockBuildJiraAuthorizeUrl.mockReturnValue("https://auth.atlassian.com/authorize?client_id=test");

    renderSettings();
    await waitFor(() => {
      expect(screen.getByText(/Connect with Jira OAuth/i)).toBeTruthy();
    });

    fireEvent.click(screen.getByText(/Connect with Jira OAuth/i));

    expect(mockBuildJiraAuthorizeUrl).toHaveBeenCalled();
    expect(capturedHref).toBe("https://auth.atlassian.com/authorize?client_id=test");
  });

  it("API token form appears when Use API token is clicked", async () => {
    renderSettings();
    await waitFor(() => {
      expect(screen.getByText(/Use API token/i)).toBeTruthy();
    });

    fireEvent.click(screen.getByText(/Use API token/i));

    await waitFor(() => {
      expect(screen.getByLabelText(/Atlassian account email/i)).toBeTruthy();
      expect(screen.getByLabelText(/Atlassian API token/i)).toBeTruthy();
      expect(screen.getByLabelText(/Jira site name/i)).toBeTruthy();
    });
  });

  it("API token connect auto-discovers Cloud ID and sets Jira auth on success", async () => {
    mockSealApiToken.mockResolvedValue("sealed-blob-xyz");
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ cloudId: "a1b2c3d4-1234-4abc-89ef-a1b2c3d4e5f6" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ issues: [], total: 0, maxResults: 1, startAt: 0 }),
      });
    vi.stubGlobal("fetch", mockFetch);

    renderSettings();
    await waitFor(() => expect(screen.getByText(/Use API token/i)).toBeTruthy());

    fireEvent.click(screen.getByText(/Use API token/i));
    await waitFor(() => expect(screen.getByLabelText(/Atlassian account email/i)).toBeTruthy());

    fireEvent.input(screen.getByLabelText(/Atlassian account email/i), {
      target: { value: "user@example.com" },
    });
    fireEvent.input(screen.getByLabelText(/Atlassian API token/i), {
      target: { value: "my-api-token-123" },
    });
    fireEvent.input(screen.getByLabelText(/Jira site name/i), {
      target: { value: "https://mysite.atlassian.net" },
    });

    fireEvent.click(screen.getByRole("button", { name: /^Connect$/i }));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith("/api/jira/tenant-info", expect.objectContaining({
        method: "POST",
      }));
      expect(mockSealApiToken).toHaveBeenCalledWith("my-api-token-123", "jira-api-token");
      expect(mockSetJiraAuth).toHaveBeenCalledWith(
        expect.objectContaining({
          accessToken: "sealed-blob-xyz",
          sealedRefreshToken: "",
          expiresAt: Number.MAX_SAFE_INTEGER,
          cloudId: "a1b2c3d4-1234-4abc-89ef-a1b2c3d4e5f6",
          email: "user@example.com",
        })
      );
      expect(mockUpdateJiraConfig).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: true, authMethod: "token" })
      );
    });
  });

  it("API token connect shows error when fields are empty", async () => {
    renderSettings();
    await waitFor(() => expect(screen.getByText(/Use API token/i)).toBeTruthy());

    fireEvent.click(screen.getByText(/Use API token/i));
    await waitFor(() => expect(screen.getByRole("button", { name: /^Connect$/i })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /^Connect$/i }));

    await waitFor(() => {
      expect(screen.getByText(/Email, API token, and site name are all required/i)).toBeTruthy();
    });
    expect(mockSealApiToken).not.toHaveBeenCalled();
  });

  it("API token connect shows error when tenant-info lookup fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({ error: "jira_tenant_info_failed" }),
    }));

    renderSettings();
    await waitFor(() => expect(screen.getByText(/Use API token/i)).toBeTruthy());

    fireEvent.click(screen.getByText(/Use API token/i));
    await waitFor(() => expect(screen.getByLabelText(/Atlassian account email/i)).toBeTruthy());

    fireEvent.input(screen.getByLabelText(/Atlassian account email/i), { target: { value: "u@e.com" } });
    fireEvent.input(screen.getByLabelText(/Atlassian API token/i), { target: { value: "tok" } });
    fireEvent.input(screen.getByLabelText(/Jira site name/i), { target: { value: "mysite" } });
    fireEvent.click(screen.getByRole("button", { name: /^Connect$/i }));

    await waitFor(() => {
      expect(screen.getByText(/Could not look up your Jira site/i)).toBeTruthy();
    });
    expect(mockSealApiToken).not.toHaveBeenCalled();
  });

  it("API token connect shows error when proxy returns non-ok response", async () => {
    mockSealApiToken.mockResolvedValue("sealed-blob");
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ cloudId: "a1b2c3d4-1234-4abc-89ef-a1b2c3d4e5f6" }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: "unauthorized" }),
      });
    vi.stubGlobal("fetch", mockFetch);

    renderSettings();
    await waitFor(() => expect(screen.getByText(/Use API token/i)).toBeTruthy());

    fireEvent.click(screen.getByText(/Use API token/i));
    await waitFor(() => expect(screen.getByLabelText(/Atlassian account email/i)).toBeTruthy());

    fireEvent.input(screen.getByLabelText(/Atlassian account email/i), { target: { value: "u@e.com" } });
    fireEvent.input(screen.getByLabelText(/Atlassian API token/i), { target: { value: "tok" } });
    fireEvent.input(screen.getByLabelText(/Jira site name/i), { target: { value: "mysite" } });
    fireEvent.click(screen.getByRole("button", { name: /^Connect$/i }));

    await waitFor(() => {
      expect(screen.getByText(/Could not connect/i)).toBeTruthy();
    });
    expect(mockSetJiraAuth).not.toHaveBeenCalled();
  });
});

describe("SettingsPage Jira section — connected state", () => {
  const connectedAuth = {
    accessToken: "atl-access-tok",
    sealedRefreshToken: "sealed-blob",
    expiresAt: Date.now() + 3600_000,
    cloudId: "cloud-abc",
    siteUrl: "https://mysite.atlassian.net",
    siteName: "My Jira Site",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    setEnv("VITE_JIRA_CLIENT_ID", "valid-client-id");
    mockIsJiraAuthenticated.mockReturnValue(true);
    mockJiraAuth.mockReturnValue(connectedAuth);
    mockConfig = {
      ...mockConfig,
      jira: { enabled: true, authMethod: "oauth" as const, issueKeyDetection: true, siteUrl: "https://mysite.atlassian.net", siteName: "My Jira Site" },
    };
    setEnv("VITE_JIRA_CLIENT_ID", "valid-client-id");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("shows site name when connected", async () => {
    renderSettings();
    await waitFor(() => {
      expect(screen.getByText("My Jira Site")).toBeTruthy();
    });
  });

  it("shows auth method label as OAuth when authMethod=oauth", async () => {
    renderSettings();
    await waitFor(() => {
      // Multiple "OAuth" text nodes exist (button label + auth method label)
      // Verify the auth method setting row shows "OAuth" as the value
      const oauthSpans = screen.getAllByText("OAuth");
      expect(oauthSpans.length).toBeGreaterThan(0);
    });
  });

  it("shows auth method label as API Token when authMethod=token", async () => {
    mockConfig = { ...mockConfig, jira: { ...mockConfig.jira!, authMethod: "token" as const } };
    renderSettings();
    await waitFor(() => {
      expect(screen.getByText("API Token")).toBeTruthy();
    });
  });

  it("shows issue key detection toggle when connected", async () => {
    renderSettings();
    await waitFor(() => {
      expect(screen.getByLabelText(/Issue key detection/i)).toBeTruthy();
    });
  });

  it("issue key detection toggle calls updateJiraConfig on change", async () => {
    renderSettings();
    await waitFor(() => {
      expect(screen.getByLabelText(/Issue key detection/i)).toBeTruthy();
    });

    fireEvent.change(screen.getByLabelText(/Issue key detection/i), {
      target: { checked: false },
    });

    await waitFor(() => {
      expect(mockUpdateJiraConfig).toHaveBeenCalledWith({ issueKeyDetection: false });
    });
  });

  it("shows Disconnect button when connected", async () => {
    renderSettings();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Disconnect/i })).toBeTruthy();
    });
  });

  it("Disconnect button calls clearJiraAuth", async () => {
    renderSettings();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Disconnect/i })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /Disconnect/i }));

    expect(mockClearJiraAuth).toHaveBeenCalled();
  });

  it("Disconnect does not show OAuth connect buttons (only when disconnected)", async () => {
    renderSettings();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Disconnect/i })).toBeTruthy();
    });

    expect(screen.queryByText(/Connect with Jira OAuth/i)).toBeNull();
    expect(screen.queryByText(/Use API token/i)).toBeNull();
  });
});
