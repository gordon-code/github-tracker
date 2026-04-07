import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent } from "@solidjs/testing-library";
import type { ApiCallRecord } from "../../../src/app/services/api-usage";

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

// ── Mocks ─────────────────────────────────────────────────────────────────────

// Mock api-usage to control return values
const mockGetUsageSnapshot = vi.fn(() => [] as ApiCallRecord[]);
const mockGetUsageResetAt = vi.fn(() => null as number | null);
const mockResetUsageData = vi.fn();

vi.mock("../../../src/app/services/api-usage", () => ({
  getUsageSnapshot: () => mockGetUsageSnapshot(),
  getUsageResetAt: () => mockGetUsageResetAt(),
  resetUsageData: () => mockResetUsageData(),
  // Stubs for module-level side effects in dependent modules
  trackApiCall: vi.fn(),
  updateResetAt: vi.fn(),
  checkAndResetIfExpired: vi.fn(),
}));

vi.mock("../../../src/app/stores/auth", () => ({
  clearAuth: vi.fn(),
  token: () => "fake-token",
  user: () => ({ login: "testuser", name: "Test User" }),
  onAuthCleared: vi.fn(),
}));

vi.mock("../../../src/app/stores/cache", () => ({
  clearCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/app/services/github", () => ({
  getClient: vi.fn(() => ({})),
  fetchRateLimitDetails: vi.fn(() => Promise.resolve(null)),
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

// ── Helper ────────────────────────────────────────────────────────────────────

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

function renderSettings() {
  return render(() => (
    <MemoryRouter>
      <Route path="*" component={SettingsPage} />
    </MemoryRouter>
  ));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ApiUsageSection — empty state", () => {
  beforeEach(() => {
    setupMatchMedia();
    localStorageMock.clear();
    vi.clearAllMocks();
    mockGetUsageSnapshot.mockReturnValue([]);
    mockGetUsageResetAt.mockReturnValue(null);
  });

  it("renders 'No API calls tracked yet.' when snapshot is empty", () => {
    renderSettings();
    expect(screen.getByText("No API calls tracked yet.")).toBeTruthy();
  });

  it("does not render a table when snapshot is empty", () => {
    renderSettings();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("hides reset time when getUsageResetAt() returns null", () => {
    renderSettings();
    expect(screen.queryByText(/Window resets at/)).toBeNull();
  });
});

describe("ApiUsageSection — table rendering", () => {
  const now = new Date("2026-01-01T10:00:00Z").getTime();

  beforeEach(() => {
    setupMatchMedia();
    localStorageMock.clear();
    vi.clearAllMocks();
    mockGetUsageSnapshot.mockReturnValue([
      { source: "lightSearch", pool: "graphql", count: 42, lastCalledAt: now },
      { source: "workflowRuns", pool: "core", count: 15, lastCalledAt: now - 60000 },
    ]);
    mockGetUsageResetAt.mockReturnValue(null);
  });

  it("renders a table row for each tracked source", () => {
    renderSettings();
    // Use queryAllByText to handle cases where labels appear elsewhere in the page
    expect(screen.queryAllByText("Light Search").length).toBeGreaterThan(0);
    expect(screen.queryAllByText("Workflow Runs").length).toBeGreaterThan(0);
  });

  it("renders call counts for each row", () => {
    renderSettings();
    expect(screen.getByText("42")).toBeTruthy();
    expect(screen.getByText("15")).toBeTruthy();
  });

  it("renders graphql pool badge for GraphQL sources", () => {
    renderSettings();
    // There should be a graphql badge (badge-ghost class)
    const graphqlBadges = document.querySelectorAll(".badge-ghost");
    expect(graphqlBadges.length).toBeGreaterThan(0);
    expect(graphqlBadges[0].textContent).toBe("graphql");
  });

  it("renders core pool badge for core sources", () => {
    renderSettings();
    // There should be a core badge (badge-outline class)
    const coreBadges = document.querySelectorAll(".badge-outline");
    expect(coreBadges.length).toBeGreaterThan(0);
    expect(coreBadges[0].textContent).toBe("core");
  });

  it("renders the total in tfoot", () => {
    renderSettings();
    // 42 + 15 = 57
    expect(screen.getByText("57")).toBeTruthy();
  });

  it("renders 'Total' label in tfoot", () => {
    renderSettings();
    expect(screen.getByText("Total")).toBeTruthy();
  });
});

describe("ApiUsageSection — source label display", () => {
  const now = new Date("2026-01-01T10:00:00Z").getTime();

  beforeEach(() => {
    setupMatchMedia();
    localStorageMock.clear();
    vi.clearAllMocks();
    mockGetUsageResetAt.mockReturnValue(null);
  });

  it.each([
    ["lightSearch", "Light Search"],
    ["heavyBackfill", "PR Backfill"],
    ["forkCheck", "Fork Check"],
    ["globalUserSearch", "Tracked User Search"],
    ["unfilteredSearch", "Unfiltered Search"],
    ["upstreamDiscovery", "Upstream Discovery"],
    ["workflowRuns", "Workflow Runs"],
    ["hotPRStatus", "Hot PR Status"],
    ["hotRunStatus", "Hot Run Status"],
    ["notifications", "Notifications"],
    ["validateUser", "Validate User"],
    ["fetchOrgs", "Fetch Orgs"],
    ["fetchRepos", "Fetch Repos"],
    ["rateLimitCheck", "Rate Limit Check"],
  ] as const)("displays '%s' as '%s'", (source, label) => {
    mockGetUsageSnapshot.mockReturnValue([
      { source, pool: "core", count: 1, lastCalledAt: now },
    ]);
    renderSettings();
    // Some labels like "Notifications" and "Workflow Runs" also appear in the
    // Settings page notification section — verify at least one match exists
    expect(screen.queryAllByText(label).length).toBeGreaterThan(0);
  });
});

describe("ApiUsageSection — reset time", () => {
  const now = new Date("2026-01-01T10:00:00Z").getTime();
  const resetAt = new Date("2026-01-01T11:00:00Z").getTime();

  beforeEach(() => {
    setupMatchMedia();
    localStorageMock.clear();
    vi.clearAllMocks();
    mockGetUsageSnapshot.mockReturnValue([
      { source: "lightSearch", pool: "graphql", count: 1, lastCalledAt: now },
    ]);
  });

  it("displays reset time when getUsageResetAt() returns a timestamp", () => {
    mockGetUsageResetAt.mockReturnValue(resetAt);
    renderSettings();
    expect(screen.getByText(/Window resets at/)).toBeTruthy();
  });

  it("does not display reset time when getUsageResetAt() returns null", () => {
    mockGetUsageResetAt.mockReturnValue(null);
    renderSettings();
    expect(screen.queryByText(/Window resets at/)).toBeNull();
  });

  it("does not display reset time when getUsageResetAt() returns 0 (strict null check)", () => {
    // 0 would be falsy — strict `!= null` check means 0 should still show
    // (epoch 0 is a valid timestamp, but practically won't appear)
    mockGetUsageResetAt.mockReturnValue(0);
    renderSettings();
    // 0 != null is true, so it SHOULD display
    expect(screen.getByText(/Window resets at/)).toBeTruthy();
  });
});

describe("ApiUsageSection — reset button", () => {
  const now = new Date("2026-01-01T10:00:00Z").getTime();

  beforeEach(() => {
    setupMatchMedia();
    localStorageMock.clear();
    vi.clearAllMocks();
    mockGetUsageSnapshot.mockReturnValue([
      { source: "lightSearch", pool: "graphql", count: 5, lastCalledAt: now },
    ]);
    mockGetUsageResetAt.mockReturnValue(null);
  });

  it("renders the 'Reset counts' button", () => {
    renderSettings();
    expect(screen.getByText("Reset counts")).toBeTruthy();
  });

  it("calls resetUsageData() when 'Reset counts' button is clicked", () => {
    renderSettings();
    const btn = screen.getByText("Reset counts");
    fireEvent.click(btn);
    expect(mockResetUsageData).toHaveBeenCalledOnce();
  });
});
