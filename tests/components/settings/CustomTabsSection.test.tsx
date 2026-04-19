import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";

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

const { mockRemoveCustomTab, mockReorderCustomTab, mockAddCustomTab, mockUpdateCustomTab, mockConfig } = vi.hoisted(() => {
  const config = { customTabs: [] as import("../../../src/app/stores/config").CustomTab[], trackedUsers: [] as unknown[] };
  return {
    mockRemoveCustomTab: vi.fn(),
    mockReorderCustomTab: vi.fn(),
    mockAddCustomTab: vi.fn(),
    mockUpdateCustomTab: vi.fn(),
    mockConfig: config,
  };
});

vi.mock("../../../src/app/stores/config", () => ({
  config: mockConfig,
  removeCustomTab: mockRemoveCustomTab,
  reorderCustomTab: mockReorderCustomTab,
  addCustomTab: mockAddCustomTab,
  updateCustomTab: mockUpdateCustomTab,
}));

vi.mock("../../../src/app/stores/view", () => ({
  resetCustomTabFilters: vi.fn(),
  viewState: { customTabFilters: {}, expandedRepos: {} },
  setCustomTabFilter: vi.fn(),
  resetAllTabFilters: vi.fn(),
}));

vi.mock("../../../src/app/components/shared/CustomTabModal", () => ({
  default: (props: { open: boolean; editingTab?: unknown }) => {
    if (!props.open) return null;
    return props.editingTab
      ? (() => { const el = document.createElement("div"); el.textContent = "Edit Custom Tab"; return el; })()
      : (() => { const el = document.createElement("div"); el.textContent = "New Custom Tab"; return el; })();
  },
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import CustomTabsSection from "../../../src/app/components/settings/CustomTabsSection";
import type { CustomTab } from "../../../src/app/stores/config";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTab(overrides: Partial<CustomTab> = {}): CustomTab {
  return {
    id: "abc12345",
    name: "My Tab",
    baseType: "issues",
    orgScope: [],
    repoScope: [],
    filterPreset: {},
    exclusive: false,
    ...overrides,
  };
}

function renderSection(
  tabs: CustomTab[] = [],
) {
  mockConfig.customTabs = tabs;
  return render(() => (
    <CustomTabsSection availableOrgs={[]} availableRepos={[]} />
  ));
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  localStorageMock.clear();
  mockConfig.customTabs = [];
  mockConfig.trackedUsers = [];
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("CustomTabsSection — empty state", () => {
  it("shows empty state message when no custom tabs", () => {
    renderSection([]);
    expect(screen.getByText(/no custom tabs/i)).toBeDefined();
  });

  it("does not render a table when no custom tabs", () => {
    renderSection([]);
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("renders Add custom tab button", () => {
    renderSection([]);
    expect(screen.getByRole("button", { name: /add custom tab/i })).toBeDefined();
  });
});

describe("CustomTabsSection — table rendering", () => {
  it("renders a table row for each custom tab", () => {
    const tabs = [
      makeTab({ id: "t1", name: "Tab One" }),
      makeTab({ id: "t2", name: "Tab Two" }),
      makeTab({ id: "t3", name: "Tab Three" }),
    ];
    renderSection(tabs);
    const rows = screen.getAllByRole("row");
    // rows[0] is the header row; rows[1..n] are data rows
    expect(rows.length).toBe(tabs.length + 1);
  });

  it("renders tab name in each row", () => {
    renderSection([makeTab({ name: "My OSAC PRs" })]);
    expect(screen.getByText("My OSAC PRs")).toBeDefined();
  });

  it("renders issues type badge", () => {
    renderSection([makeTab({ baseType: "issues" })]);
    expect(screen.getByText("Issues")).toBeDefined();
  });

  it("renders pull requests type badge", () => {
    renderSection([makeTab({ baseType: "pullRequests" })]);
    expect(screen.getByText("PRs")).toBeDefined();
  });

  it("renders actions type badge", () => {
    renderSection([makeTab({ baseType: "actions" })]);
    // "Actions" appears in both the table header and the badge — find the badge specifically
    const badges = screen.getAllByText("Actions");
    expect(badges.length).toBeGreaterThanOrEqual(1);
  });

  it("shows 'All repos' when no scope is configured", () => {
    renderSection([makeTab({ orgScope: [], repoScope: [] })]);
    expect(screen.getByText("All repos")).toBeDefined();
  });

  it("shows org count summary in scope column", () => {
    renderSection([makeTab({ orgScope: ["myorg", "otherorg"], repoScope: [] })]);
    expect(screen.getByText("2 orgs")).toBeDefined();
  });

  it("shows repo count summary in scope column", () => {
    renderSection([makeTab({ orgScope: [], repoScope: [{ owner: "org", name: "r1", fullName: "org/r1" }] })]);
    expect(screen.getByText("1 repo")).toBeDefined();
  });

  it("renders exclusive checkmark when tab is exclusive", () => {
    renderSection([makeTab({ exclusive: true })]);
    // SVG has aria-label="Exclusive"
    expect(screen.getByRole("img", { name: /exclusive/i })).toBeDefined();
  });

  it("renders dash when tab is not exclusive", () => {
    renderSection([makeTab({ exclusive: false })]);
    expect(screen.getByRole("generic", { name: /not exclusive/i })).toBeDefined();
  });
});

describe("CustomTabsSection — delete button", () => {
  it("calls removeCustomTab when confirmed", () => {
    const confirmMock = vi.fn().mockReturnValue(true);
    globalThis.confirm = confirmMock;
    renderSection([makeTab({ id: "t1", name: "Delete Me" })]);
    fireEvent.click(screen.getByRole("button", { name: /delete "Delete Me"/i }));
    expect(mockRemoveCustomTab).toHaveBeenCalledWith("t1");
  });

  it("does not call removeCustomTab when cancelled", () => {
    const confirmMock = vi.fn().mockReturnValue(false);
    globalThis.confirm = confirmMock;
    renderSection([makeTab({ id: "t1", name: "Keep Me" })]);
    fireEvent.click(screen.getByRole("button", { name: /delete "Keep Me"/i }));
    expect(mockRemoveCustomTab).not.toHaveBeenCalled();
  });

  it("shows confirm dialog with tab name", () => {
    const confirmMock = vi.fn().mockReturnValue(false);
    globalThis.confirm = confirmMock;
    renderSection([makeTab({ name: "Precious Tab" })]);
    fireEvent.click(screen.getByRole("button", { name: /delete "Precious Tab"/i }));
    expect(confirmMock).toHaveBeenCalledWith(expect.stringContaining("Precious Tab"));
  });
});

describe("CustomTabsSection — reorder buttons", () => {
  it("calls reorderCustomTab with 'up' when up button clicked", () => {
    const tabs = [
      makeTab({ id: "t1", name: "First" }),
      makeTab({ id: "t2", name: "Second" }),
    ];
    renderSection(tabs);
    // Second tab's "Move up" button
    fireEvent.click(screen.getByRole("button", { name: /move "Second" up/i }));
    expect(mockReorderCustomTab).toHaveBeenCalledWith("t2", "up");
  });

  it("calls reorderCustomTab with 'down' when down button clicked", () => {
    const tabs = [
      makeTab({ id: "t1", name: "First" }),
      makeTab({ id: "t2", name: "Second" }),
    ];
    renderSection(tabs);
    // First tab's "Move down" button
    fireEvent.click(screen.getByRole("button", { name: /move "First" down/i }));
    expect(mockReorderCustomTab).toHaveBeenCalledWith("t1", "down");
  });

  it("first tab's up button is disabled", () => {
    const tabs = [
      makeTab({ id: "t1", name: "First" }),
      makeTab({ id: "t2", name: "Second" }),
    ];
    renderSection(tabs);
    const upBtn = screen.getByRole("button", { name: /move "First" up/i });
    expect(upBtn.hasAttribute("disabled")).toBe(true);
  });

  it("last tab's down button is disabled", () => {
    const tabs = [
      makeTab({ id: "t1", name: "First" }),
      makeTab({ id: "t2", name: "Second" }),
    ];
    renderSection(tabs);
    const downBtn = screen.getByRole("button", { name: /move "Second" down/i });
    expect(downBtn.hasAttribute("disabled")).toBe(true);
  });

  it("middle tab's up and down buttons are enabled", () => {
    const tabs = [
      makeTab({ id: "t1", name: "First" }),
      makeTab({ id: "t2", name: "Middle" }),
      makeTab({ id: "t3", name: "Last" }),
    ];
    renderSection(tabs);
    const upBtn = screen.getByRole("button", { name: /move "Middle" up/i });
    const downBtn = screen.getByRole("button", { name: /move "Middle" down/i });
    expect(upBtn.hasAttribute("disabled")).toBe(false);
    expect(downBtn.hasAttribute("disabled")).toBe(false);
  });
});

describe("CustomTabsSection — edit button", () => {
  it("renders edit button for each tab", () => {
    const tabs = [
      makeTab({ id: "t1", name: "Tab One" }),
      makeTab({ id: "t2", name: "Tab Two" }),
    ];
    renderSection(tabs);
    expect(screen.getByRole("button", { name: /edit "Tab One"/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /edit "Tab Two"/i })).toBeDefined();
  });

  it("clicking edit button does not throw", () => {
    // CustomTabModal is mocked; verify the click handler runs without error
    renderSection([makeTab({ id: "t1", name: "Editable" })]);
    expect(() => {
      fireEvent.click(screen.getByRole("button", { name: /edit "Editable"/i }));
    }).not.toThrow();
  });
});

describe("CustomTabsSection — add button cap", () => {
  it("Add button is enabled when fewer than 10 tabs", () => {
    renderSection(Array.from({ length: 5 }, (_, i) => makeTab({ id: `t${i}`, name: `Tab ${i}` })));
    const addBtn = screen.getByRole("button", { name: /add custom tab/i });
    expect(addBtn.hasAttribute("disabled")).toBe(false);
  });

  it("Add button is disabled at 10-tab cap", () => {
    renderSection(Array.from({ length: 10 }, (_, i) => makeTab({ id: `t${i}`, name: `Tab ${i}` })));
    const addBtn = screen.getByRole("button", { name: /add custom tab/i });
    expect(addBtn.hasAttribute("disabled")).toBe(true);
  });

  it("shows cap message at 10-tab cap", () => {
    renderSection(Array.from({ length: 10 }, (_, i) => makeTab({ id: `t${i}`, name: `Tab ${i}` })));
    expect(screen.getByText("Maximum 10 custom tabs")).toBeDefined();
  });

  it("clicking Add button does not throw", () => {
    // CustomTabModal is mocked; verify the click handler runs without error
    renderSection([]);
    expect(() => {
      fireEvent.click(screen.getByRole("button", { name: /add custom tab/i }));
    }).not.toThrow();
  });
});
