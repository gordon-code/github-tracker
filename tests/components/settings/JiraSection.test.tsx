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
  dismissNotificationBySource: vi.fn(),
}));

const mockClearJiraAuth = vi.fn();
const mockSetJiraAuth = vi.fn();
const mockIsJiraAuthenticated = vi.fn(() => false);
const mockJiraAuth = vi.fn(() => null as Record<string, unknown> | null);

const mockClearJiraConfigFull = vi.fn();

vi.mock("../../../src/app/stores/auth", () => ({
  clearAuth: vi.fn(),
  clearJiraAuth: (...args: unknown[]) => mockClearJiraAuth(...args),
  clearJiraConfigFull: (...args: unknown[]) => mockClearJiraConfigFull(...args),
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
  jira: { enabled: false, authMethod: "oauth" as const, issueKeyDetection: true } as {
    enabled: boolean;
    authMethod: "oauth" | "token";
    issueKeyDetection: boolean;
    expandIssueDetails?: boolean;
    cloudId?: string;
    siteUrl?: string;
    siteName?: string;
    email?: string;
    customFields?: Array<{ id: string; name: string }>;
    customScopes?: Array<{ id: string; name: string }>;
  },
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
  viewState: { lastActiveTab: "issues", tabFilters: { jiraAssigned: { scope: "assigned" } }, expandedRepos: {}, lockedRepos: {}, trackedItems: [], activeScopeTab: "involved" },
  updateViewState: vi.fn(),
  resetViewState: vi.fn(),
  setTabFilter: vi.fn(),
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

vi.mock("@sentry/solid", () => ({
  captureException: vi.fn(),
  withSentryErrorBoundary: vi.fn((c: unknown) => c),
}));

// Component imports after all mocks
import * as Sentry from "@sentry/solid";
import SettingsPage, { staleJiraScopeReset } from "../../../src/app/components/settings/SettingsPage";
import { viewState, setTabFilter } from "../../../src/app/stores/view";
import { pushNotification, dismissNotificationBySource } from "../../../src/app/lib/errors";
import { clearJiraKeyCache } from "../../../src/app/services/jira-keys";

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

  it("Disconnect button calls clearJiraConfigFull", async () => {
    renderSettings();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Disconnect/i })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /Disconnect/i }));

    expect(mockClearJiraConfigFull).toHaveBeenCalled();
  });

  it("Disconnect resets a stale custom jiraAssigned scope to 'assigned' (BUG-008)", async () => {
    viewState.tabFilters.jiraAssigned.scope = "customfield_10001";
    renderSettings();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Disconnect/i })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /Disconnect/i }));

    expect(setTabFilter).toHaveBeenCalledWith("jiraAssigned", "scope", "assigned");
  });

  it("Disconnect does not touch jiraAssigned scope when it's already 'assigned'", async () => {
    viewState.tabFilters.jiraAssigned.scope = "assigned";
    renderSettings();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Disconnect/i })).toBeTruthy();
    });

    vi.mocked(setTabFilter).mockClear();
    fireEvent.click(screen.getByRole("button", { name: /Disconnect/i }));

    expect(setTabFilter).not.toHaveBeenCalled();
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

describe("staleJiraScopeReset (BUG-008)", () => {
  it("returns null when the active scope is a built-in value", () => {
    expect(staleJiraScopeReset("assigned", [])).toBeNull();
    expect(staleJiraScopeReset("reported", [{ id: "customfield_1", name: "Foo" }])).toBeNull();
    expect(staleJiraScopeReset("watching", [])).toBeNull();
  });

  it("returns null when the active scope matches a surviving custom scope id", () => {
    expect(
      staleJiraScopeReset("customfield_10001", [{ id: "customfield_10001", name: "Epic Filter" }])
    ).toBeNull();
  });

  it("returns 'assigned' when the active scope is a custom id no longer present", () => {
    expect(staleJiraScopeReset("customfield_10001", [])).toBe("assigned");
    expect(
      staleJiraScopeReset("customfield_10001", [{ id: "customfield_9999", name: "Other" }])
    ).toBe("assigned");
  });
});

describe("SettingsPage Jira section — preserved settings when expired", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnv("VITE_JIRA_CLIENT_ID", "valid-client-id");
    mockIsJiraAuthenticated.mockReturnValue(false);
    mockJiraAuth.mockReturnValue(null);
    mockConfig = {
      ...mockConfig,
      jira: {
        enabled: true,
        authMethod: "token",
        issueKeyDetection: true,
        expandIssueDetails: true,
        cloudId: "cloud-123",
        siteUrl: "https://preserved.atlassian.net",
        siteName: "Preserved Site",
        email: "stored@example.com",
        customFields: [{ id: "customfield_10001", name: "Story Points" }],
        customScopes: [{ id: "customfield_10002", name: "Squad" }],
      },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("shows expired banner, preserved site/fields/scopes/toggles, and disables Configure fields and Configure filter scopes buttons", async () => {
    renderSettings();

    await waitFor(() => {
      expect(screen.getByTestId("jira-settings-expired-banner")).toBeTruthy();
    });

    expect(screen.getByText("Preserved Site")).toBeTruthy();
    expect(screen.getByText("https://preserved.atlassian.net")).toBeTruthy();
    expect(screen.getByText("Story Points")).toBeTruthy();
    expect(screen.getByText("Squad")).toBeTruthy();
    expect(screen.getByLabelText(/Issue key detection/i)).toBeTruthy();
    expect(screen.getByText("Expand issue details")).toBeTruthy();

    const configureFieldsBtn = screen.getByRole("button", { name: /Configure fields/i }) as HTMLButtonElement;
    const configureScopesBtn = screen.getByRole("button", { name: /Configure filter scopes/i }) as HTMLButtonElement;
    expect(configureFieldsBtn.disabled).toBe(true);
    expect(configureScopesBtn.disabled).toBe(true);

    // Replace button on Auth method row uses warning highlight style when expired
    const replaceBtn = screen.getByRole("button", { name: /^Replace$/i });
    expect(replaceBtn.className).toContain("btn-warning");

    // Expired banner also renders a direct "Replace token" CTA button while the panel is closed
    const banner = screen.getByTestId("jira-settings-expired-banner");
    const bannerReplaceBtn = banner.querySelector("button");
    expect(bannerReplaceBtn?.textContent).toBe("Replace token");
    fireEvent.click(bannerReplaceBtn!);

    const panel = document.getElementById("replace-jira-token-panel");
    expect(panel).not.toBeNull();
    expect(panel?.className).toContain("ring-warning");
  });

  it("shows Reconnect button in expired banner when authMethod is oauth", async () => {
    mockConfig = {
      ...mockConfig,
      jira: {
        ...mockConfig.jira,
        enabled: true,
        authMethod: "oauth",
      },
    };

    renderSettings();

    await waitFor(() => {
      expect(screen.getByTestId("jira-settings-expired-banner")).toBeTruthy();
    });

    const reconnectBtn = screen.getByRole("button", { name: /^Reconnect$/i });
    expect(reconnectBtn).toBeTruthy();
  });
});

describe("SettingsPage Jira section — Replace API token flow & deep-linking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = "";
    setEnv("VITE_JIRA_CLIENT_ID", "valid-client-id");
    mockIsJiraAuthenticated.mockReturnValue(true);
    mockJiraAuth.mockReturnValue({
      accessToken: "sealed-old-token",
      sealedRefreshToken: "",
      expiresAt: Number.MAX_SAFE_INTEGER,
      cloudId: "cloud-valid-123",
      siteUrl: "https://mysite.atlassian.net",
      siteName: "My Jira Site",
      email: "initial@example.com",
    });
    mockConfig = {
      ...mockConfig,
      jira: {
        enabled: true,
        authMethod: "token",
        issueKeyDetection: true,
        cloudId: "cloud-valid-123",
        siteUrl: "https://mysite.atlassian.net",
        siteName: "My Jira Site",
        email: "initial@example.com",
      },
    };
  });

  afterEach(() => {
    window.location.hash = "";
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("shows Replace button on Auth method row when connected and when expired, opens #replace-jira-token-panel with pre-filled email, and Cancel closes and clears", async () => {
    const { unmount } = renderSettings();

    const replaceBtn = await waitFor(() => screen.getByRole("button", { name: /^Replace$/i }));
    expect(replaceBtn.getAttribute("aria-controls")).toBe("replace-jira-token-panel");

    fireEvent.click(replaceBtn);

    const panel = document.getElementById("replace-jira-token-panel");
    expect(panel).not.toBeNull();

    const emailInput = screen.getByLabelText("Atlassian account email") as HTMLInputElement;
    const tokenInput = screen.getByLabelText("New Atlassian API token") as HTMLInputElement;
    expect(emailInput.value).toBe("initial@example.com");
    expect(tokenInput.value).toBe("");

    fireEvent.input(tokenInput, { target: { value: "temp-token" } });
    expect(tokenInput.value).toBe("temp-token");

    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));
    expect(document.getElementById("replace-jira-token-panel")).toBeNull();

    // Re-open to verify token input was cleared
    fireEvent.click(replaceBtn);
    expect((screen.getByLabelText("New Atlassian API token") as HTMLInputElement).value).toBe("");
    unmount();

    // Also verify Replace button is present when expired (isJiraAuthenticated() = false)
    mockIsJiraAuthenticated.mockReturnValue(false);
    mockJiraAuth.mockReturnValue(null);
    renderSettings();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^Replace$/i })).toBeTruthy();
    });
  });

  it("submitting edited email and valid new token seals token, validates via /api/jira/proxy without tenant-info, updates auth & config, dismisses notifications, and closes panel", async () => {
    mockSealApiToken.mockResolvedValue("sealed-new-token");
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ issues: [], total: 0, maxResults: 1, startAt: 0 }),
    });
    vi.stubGlobal("fetch", mockFetch);

    renderSettings();

    const replaceBtn = await waitFor(() => screen.getByRole("button", { name: /^Replace$/i }));
    fireEvent.click(replaceBtn);

    const emailInput = screen.getByLabelText("Atlassian account email") as HTMLInputElement;
    const tokenInput = screen.getByLabelText("New Atlassian API token") as HTMLInputElement;

    fireEvent.input(emailInput, { target: { value: "rotated@example.com" } });
    fireEvent.input(tokenInput, { target: { value: "new-atlassian-token-456" } });

    fireEvent.click(screen.getByRole("button", { name: /^Replace token$/i }));

    await waitFor(() => {
      expect(mockSealApiToken).toHaveBeenCalledWith("new-atlassian-token-456", "jira-api-token");
      expect(clearJiraKeyCache).toHaveBeenCalled();
    });

    // Must NOT call /api/jira/tenant-info when cloudId is already valid
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/jira/proxy",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          endpoint: "search",
          cloudId: "cloud-valid-123",
          email: "rotated@example.com",
          sealed: "sealed-new-token",
          params: { jql: "assignee = currentUser() AND statusCategory != Done", maxResults: 1 },
        }),
      })
    );

    expect(mockSetJiraAuth).toHaveBeenCalledWith({
      accessToken: "sealed-new-token",
      sealedRefreshToken: "",
      expiresAt: Number.MAX_SAFE_INTEGER,
      cloudId: "cloud-valid-123",
      siteUrl: "https://mysite.atlassian.net",
      siteName: "My Jira Site",
      email: "rotated@example.com",
    });
    expect(mockUpdateJiraConfig).toHaveBeenCalledWith({
      enabled: true,
      cloudId: "cloud-valid-123",
      email: "rotated@example.com",
      authMethod: "token",
      siteUrl: "https://mysite.atlassian.net",
      siteName: "My Jira Site",
    });
    expect(dismissNotificationBySource).toHaveBeenCalledWith("jira");
    expect(dismissNotificationBySource).toHaveBeenCalledWith("jira:refresh");
    expect(dismissNotificationBySource).toHaveBeenCalledWith("settings-import-jira");
    expect(pushNotification).toHaveBeenCalledWith(
      "jira-replace",
      "Jira API token replaced successfully",
      "info"
    );
    expect(document.getElementById("replace-jira-token-panel")).toBeNull();
  });

  it("shows inline error and does not call setJiraAuth when /api/jira/proxy returns 401 or non-401/403 status", async () => {
    mockSealApiToken.mockResolvedValue("sealed-bad-token");
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: "unauthorized" }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ error: "internal" }),
      });
    vi.stubGlobal("fetch", mockFetch);

    renderSettings();

    const replaceBtn = await waitFor(() => screen.getByRole("button", { name: /^Replace$/i }));
    fireEvent.click(replaceBtn);

    fireEvent.input(screen.getByLabelText("New Atlassian API token"), {
      target: { value: "bad-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Replace token$/i }));

    await waitFor(() => {
      expect(
        screen.getByText("API token or email is invalid — check your credentials and try again.")
      ).toBeTruthy();
      expect(
        (screen.getByRole("button", { name: /^Replace token$/i }) as HTMLButtonElement).disabled
      ).toBe(false);
    });
    expect(mockSetJiraAuth).not.toHaveBeenCalled();
    expect(document.getElementById("replace-jira-token-panel")).not.toBeNull();

    // Non-401/403 status branch (e.g. 500)
    fireEvent.click(screen.getByRole("button", { name: /^Replace token$/i }));
    await waitFor(() => {
      expect(screen.getByText("Jira returned 500 — try again later.")).toBeTruthy();
    });
    expect(mockSetJiraAuth).not.toHaveBeenCalled();
  });

  it("validates empty email/token and invalid stored siteUrl before making network calls", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    renderSettings();
    const replaceBtn = await waitFor(() => screen.getByRole("button", { name: /^Replace$/i }));
    fireEvent.click(replaceBtn);

    // 1. Empty token input (email pre-filled, token blank)
    fireEvent.click(screen.getByRole("button", { name: /^Replace token$/i }));
    await waitFor(() => {
      expect(screen.getByText("Email and API token are both required.")).toBeTruthy();
    });
    expect(mockSealApiToken).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();

    // 2. Empty email input with non-empty token
    fireEvent.input(screen.getByLabelText("Atlassian account email"), { target: { value: "   " } });
    fireEvent.input(screen.getByLabelText("New Atlassian API token"), { target: { value: "some-token" } });
    fireEvent.click(screen.getByRole("button", { name: /^Replace token$/i }));
    await waitFor(() => {
      expect(screen.getByText("Email and API token are both required.")).toBeTruthy();
    });
    expect(mockSealApiToken).not.toHaveBeenCalled();

    // 3. Invalid stored siteUrl
    mockJiraAuth.mockReturnValue(null);
    mockConfig.jira.siteUrl = "https://evil.example.com";
    fireEvent.input(screen.getByLabelText("Atlassian account email"), { target: { value: "valid@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /^Replace token$/i }));
    await waitFor(() => {
      expect(
        screen.getByText("Stored Jira site URL is missing or invalid — please disconnect and reconnect.")
      ).toBeTruthy();
    });
    expect(mockSealApiToken).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("captures non-abort errors with Sentry and shows connection failed error, while ignoring AbortError and post-cancel continuations", async () => {
    // 1. Non-abort rejection (e.g. sealApiToken or network error) reports to Sentry and shows error
    const networkErr = new Error("seal network failure");
    mockSealApiToken.mockRejectedValueOnce(networkErr);

    renderSettings();
    const replaceBtn = await waitFor(() => screen.getByRole("button", { name: /^Replace$/i }));
    fireEvent.click(replaceBtn);

    fireEvent.input(screen.getByLabelText("New Atlassian API token"), {
      target: { value: "token-attempt-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Replace token$/i }));

    await waitFor(() => {
      expect(screen.getByText("Connection failed — please try again.")).toBeTruthy();
    });
    expect(Sentry.captureException).toHaveBeenCalledWith(networkErr, {
      tags: { source: "jira-token-replace" },
    });

    // 2. AbortError is silently ignored without Sentry capture or error display
    vi.mocked(Sentry.captureException).mockClear();
    mockSealApiToken.mockResolvedValueOnce("sealed-tok");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValueOnce(new DOMException("The operation was aborted.", "AbortError"))
    );

    fireEvent.click(screen.getByRole("button", { name: /^Replace token$/i }));
    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: /^Replace token$/i }) as HTMLButtonElement).disabled
      ).toBe(false);
    });
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();

    // 3. Cancel while proxy fetch is in-flight prevents setJiraAuth when fetch later resolves
    let resolveProxy!: (v: unknown) => void;
    mockSealApiToken.mockResolvedValueOnce("sealed-tok-2");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValueOnce(new Promise((r) => { resolveProxy = r; }))
    );

    fireEvent.click(screen.getByRole("button", { name: /^Replace token$/i }));
    await waitFor(() => expect(mockSealApiToken).toHaveBeenCalledTimes(3));

    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));
    expect(document.getElementById("replace-jira-token-panel")).toBeNull();

    resolveProxy({
      ok: true,
      status: 200,
      json: async () => ({ issues: [], total: 0, maxResults: 1, startAt: 0 }),
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(mockSetJiraAuth).not.toHaveBeenCalled();
  });

  it("auto-opens #replace-jira-token-panel, applies highlight pulse, and focuses New Atlassian API token input when window.location.hash is '#jira' on mount (or settles on microtask after mount)", async () => {
    mockIsJiraAuthenticated.mockReturnValue(false);
    mockJiraAuth.mockReturnValue(null);
    // Simulate @solidjs/router committing history.pushState('#jira') in a microtask right after onMount
    window.location.hash = "";

    renderSettings();
    queueMicrotask(() => {
      window.location.hash = "#jira";
    });

    await waitFor(() => {
      const panel = document.getElementById("replace-jira-token-panel");
      expect(panel).not.toBeNull();
      expect(panel?.className).toContain("animate-reorder-highlight");
      expect(panel?.className).toContain("ring-warning");
      const tokenInput = screen.getByLabelText("New Atlassian API token");
      expect(document.activeElement).toBe(tokenInput);
    });
  });

  it("opens #replace-jira-token-panel on window hashchange to '#jira' when already mounted, and removes listener on unmount", async () => {
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const { unmount } = renderSettings();

    expect(document.getElementById("replace-jira-token-panel")).toBeNull();

    window.location.hash = "#jira";
    window.dispatchEvent(new Event("hashchange"));

    await waitFor(() => {
      expect(document.getElementById("replace-jira-token-panel")).not.toBeNull();
      const tokenInput = screen.getByLabelText("New Atlassian API token");
      expect(document.activeElement).toBe(tokenInput);
    });

    unmount();
    expect(removeSpy).toHaveBeenCalledWith("hashchange", expect.any(Function));
  });

  it("does NOT auto-open #replace-jira-token-panel on '#jira' deep-link when authMethod is 'oauth'", async () => {
    mockConfig.jira.authMethod = "oauth";
    window.location.hash = "#jira";

    renderSettings();

    await waitFor(() => {
      expect(screen.getByText("My Jira Site")).toBeTruthy();
    });
    expect(document.getElementById("replace-jira-token-panel")).toBeNull();

    // Also verify hashchange while mounted with OAuth does not open the panel
    window.dispatchEvent(new Event("hashchange"));
    await new Promise((r) => setTimeout(r, 20));
    expect(document.getElementById("replace-jira-token-panel")).toBeNull();
  });

  it("discovers cloudId via /api/jira/tenant-info when stored cloudId is missing during token replacement, and shows error if tenant-info fails", async () => {
    mockIsJiraAuthenticated.mockReturnValue(false);
    mockJiraAuth.mockReturnValue(null);
    mockConfig.jira.cloudId = "";
    mockSealApiToken.mockResolvedValue("sealed-fallback-token");

    // 1. Failure case: /api/jira/tenant-info returns 502
    const mockFetchFail = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => ({ error: "bad gateway" }),
    });
    vi.stubGlobal("fetch", mockFetchFail);

    const { unmount } = renderSettings();
    const replaceBtn = await waitFor(() => screen.getByRole("button", { name: /^Replace$/i }));
    fireEvent.click(replaceBtn);

    fireEvent.input(screen.getByLabelText("New Atlassian API token"), {
      target: { value: "fallback-token-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Replace token$/i }));

    await waitFor(() => {
      expect(screen.getByText("Could not look up your Jira site — try again later.")).toBeTruthy();
    });
    expect(mockSetJiraAuth).not.toHaveBeenCalled();
    unmount();

    // 2. Success case: /api/jira/tenant-info returns valid cloudId, followed by /api/jira/proxy 200
    const mockFetchOk = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ cloudId: "discovered-cloud-999" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ issues: [], total: 0, maxResults: 1, startAt: 0 }),
      });
    vi.stubGlobal("fetch", mockFetchOk);

    renderSettings();
    const replaceBtn2 = await waitFor(() => screen.getByRole("button", { name: /^Replace$/i }));
    fireEvent.click(replaceBtn2);

    fireEvent.input(screen.getByLabelText("New Atlassian API token"), {
      target: { value: "fallback-token-2" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Replace token$/i }));

    await waitFor(() => {
      expect(mockSetJiraAuth).toHaveBeenCalledWith(
        expect.objectContaining({
          cloudId: "discovered-cloud-999",
          accessToken: "sealed-fallback-token",
        })
      );
    });
    expect(mockFetchOk).toHaveBeenCalledTimes(2);
    expect(mockFetchOk).toHaveBeenNthCalledWith(
      1,
      "/api/jira/tenant-info",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ siteUrl: "https://mysite.atlassian.net" }),
      })
    );
  });

  it("calls clearJiraAuth and pushes notification with JIRA_SETTINGS_ACTION when jiraClient.getFields() returns 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: "unauthorized" }),
      })
    );

    renderSettings();

    const configureFieldsBtn = await waitFor(() =>
      screen.getByRole("button", { name: /Configure fields/i })
    );
    fireEvent.click(configureFieldsBtn);

    await waitFor(() => {
      expect(mockClearJiraAuth).toHaveBeenCalledTimes(1);
    });
    expect(pushNotification).toHaveBeenCalledWith(
      "jira",
      "Jira session expired — please reconnect in Settings",
      "warning",
      false,
      { label: "Open Jira settings", href: "/settings#jira" }
    );
  });
});
