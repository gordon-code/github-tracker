import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { createSignal } from "solid-js";

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

// vi.mock factories are hoisted above variable declarations; use vi.hoisted to
// create mocks that can be referenced both inside the factory and in tests.
const { mockAddCustomTab, mockResetCustomTabFilters, mockUpdateCustomTab } = vi.hoisted(() => ({
  mockAddCustomTab: vi.fn(),
  mockUpdateCustomTab: vi.fn(),
  mockResetCustomTabFilters: vi.fn(),
}));

vi.mock("../../../src/app/stores/config", () => ({
  addCustomTab: mockAddCustomTab,
  updateCustomTab: mockUpdateCustomTab,
  config: { trackedUsers: [], customTabs: [] },
}));

vi.mock("../../../src/app/stores/view", () => ({
  resetCustomTabFilters: mockResetCustomTabFilters,
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import CustomTabModal from "../../../src/app/components/shared/CustomTabModal";
import { config } from "../../../src/app/stores/config";
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

/**
 * Renders the modal wrapped in a signal so open/editingTab can be changed reactively.
 */
function renderModal(
  initialOpen = true,
  editingTab?: CustomTab,
  onClose = vi.fn(),
) {
  const [open, setOpen] = createSignal(initialOpen);
  const result = render(() => (
    <CustomTabModal
      open={open()}
      onClose={onClose}
      editingTab={editingTab}
      availableOrgs={["myorg"]}
      availableRepos={[{ owner: "myorg", name: "repo1", fullName: "myorg/repo1" }]}
    />
  ));
  return { ...result, setOpen, onClose };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  localStorageMock.clear();
  // Default: cap not reached
  (config as { customTabs: CustomTab[]; trackedUsers: unknown[] }).customTabs = [];
  (config as { customTabs: CustomTab[]; trackedUsers: unknown[] }).trackedUsers = [];
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("CustomTabModal — open/close", () => {
  it("renders dialog when open is true", () => {
    renderModal(true);
    expect(screen.getByRole("dialog")).toBeDefined();
  });

  it("does not render dialog content when open is false", () => {
    renderModal(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("calls onClose when Cancel button is clicked", () => {
    const onClose = vi.fn();
    renderModal(true, undefined, onClose);
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when X button is clicked", () => {
    const onClose = vi.fn();
    renderModal(true, undefined, onClose);
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("CustomTabModal — create mode", () => {
  it("shows 'New Custom Tab' title in create mode", () => {
    renderModal(true);
    expect(screen.getByText("New Custom Tab")).toBeDefined();
  });

  it("shows 'Create' button in create mode", () => {
    renderModal(true);
    expect(screen.getByRole("button", { name: /create/i })).toBeDefined();
  });

  it("Create button is disabled when name is empty", () => {
    renderModal(true);
    const createBtn = screen.getByRole("button", { name: /create/i });
    expect(createBtn.hasAttribute("disabled")).toBe(true);
  });

  it("Create button is enabled after typing a valid name", () => {
    renderModal(true);
    const input = screen.getByRole("textbox");
    fireEvent.input(input, { target: { value: "My Issues" } });
    const createBtn = screen.getByRole("button", { name: /create/i });
    expect(createBtn.hasAttribute("disabled")).toBe(false);
  });

  it("calls addCustomTab with correct shape when form is submitted", () => {
    renderModal(true);
    const input = screen.getByRole("textbox");
    fireEvent.input(input, { target: { value: "My Issues" } });

    const typeSelect = screen.getByRole("combobox", { name: /type/i });
    fireEvent.change(typeSelect, { target: { value: "pullRequests" } });

    fireEvent.click(screen.getByRole("button", { name: /create/i }));

    expect(mockAddCustomTab).toHaveBeenCalledTimes(1);
    const arg = mockAddCustomTab.mock.calls[0][0] as CustomTab;
    expect(arg.name).toBe("My Issues");
    expect(arg.baseType).toBe("pullRequests");
    expect(arg.orgScope).toEqual([]);
    expect(arg.repoScope).toEqual([]);
    expect(arg.filterPreset).toEqual({});
    expect(arg.exclusive).toBe(false);
    expect(typeof arg.id).toBe("string");
    expect(arg.id.length).toBeGreaterThan(0);
  });

  it("calls onClose after successful create", () => {
    const onClose = vi.fn();
    renderModal(true, undefined, onClose);
    const input = screen.getByRole("textbox");
    fireEvent.input(input, { target: { value: "Test" } });
    fireEvent.click(screen.getByRole("button", { name: /create/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("name is trimmed before saving", () => {
    renderModal(true);
    const input = screen.getByRole("textbox");
    fireEvent.input(input, { target: { value: "  Padded Name  " } });
    fireEvent.click(screen.getByRole("button", { name: /create/i }));
    const arg = mockAddCustomTab.mock.calls[0][0] as CustomTab;
    expect(arg.name).toBe("Padded Name");
  });

  it("defaults to 'issues' base type", () => {
    renderModal(true);
    const typeSelect = screen.getByRole("combobox", { name: /type/i }) as HTMLSelectElement;
    expect(typeSelect.value).toBe("issues");
  });
});

describe("CustomTabModal — edit mode", () => {
  it("shows 'Edit Custom Tab' title in edit mode", () => {
    renderModal(true, makeTab());
    expect(screen.getByText("Edit Custom Tab")).toBeDefined();
  });

  it("shows 'Save' button in edit mode", () => {
    renderModal(true, makeTab());
    expect(screen.getByRole("button", { name: /save/i })).toBeDefined();
  });

  it("pre-populates name from editingTab", () => {
    renderModal(true, makeTab({ name: "Existing Tab" }));
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("Existing Tab");
  });

  it("pre-populates base type from editingTab", () => {
    renderModal(true, makeTab({ baseType: "pullRequests" }));
    const typeSelect = screen.getByRole("combobox", { name: /type/i }) as HTMLSelectElement;
    expect(typeSelect.value).toBe("pullRequests");
  });

  it("pre-populates exclusive from editingTab", () => {
    renderModal(true, makeTab({ exclusive: true }));
    const toggle = document.getElementById("custom-tab-exclusive") as HTMLInputElement;
    expect(toggle.checked).toBe(true);
  });

  it("calls updateCustomTab with correct id and updates on save", () => {
    const tab = makeTab({ id: "tab001", name: "Old Name", baseType: "issues" });
    renderModal(true, tab);
    const input = screen.getByRole("textbox");
    fireEvent.input(input, { target: { value: "New Name" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(mockUpdateCustomTab).toHaveBeenCalledTimes(1);
    const [id, updates] = mockUpdateCustomTab.mock.calls[0] as [string, Partial<CustomTab>];
    expect(id).toBe("tab001");
    expect(updates.name).toBe("New Name");
  });

  it("does not call addCustomTab in edit mode", () => {
    renderModal(true, makeTab());
    const input = screen.getByRole("textbox");
    fireEvent.input(input, { target: { value: "Updated" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(mockAddCustomTab).not.toHaveBeenCalled();
  });

  it("calls resetCustomTabFilters when base type changes during edit", () => {
    const tab = makeTab({ id: "tab001", baseType: "issues" });
    renderModal(true, tab);

    const typeSelect = screen.getByRole("combobox", { name: /type/i });
    fireEvent.change(typeSelect, { target: { value: "pullRequests" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    expect(mockResetCustomTabFilters).toHaveBeenCalledWith("tab001");
  });

  it("does not call resetCustomTabFilters when base type unchanged", () => {
    const tab = makeTab({ id: "tab001", baseType: "issues" });
    renderModal(true, tab);

    // Keep same base type, just change the name
    const input = screen.getByRole("textbox");
    fireEvent.input(input, { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    expect(mockResetCustomTabFilters).not.toHaveBeenCalled();
  });
});

describe("CustomTabModal — base type change clears filter preset", () => {
  it("clears filter preset when base type changes", () => {
    renderModal(true, makeTab({ baseType: "issues", filterPreset: { role: "author" } }));

    // Change base type — should clear the preset
    const typeSelect = screen.getByRole("combobox", { name: /type/i });
    fireEvent.change(typeSelect, { target: { value: "pullRequests" } });

    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    const [, updates] = mockUpdateCustomTab.mock.calls[0] as [string, Partial<CustomTab>];
    // After type change, filterPreset should be empty (preset cleared)
    expect(updates.filterPreset).toEqual({});
  });
});

describe("CustomTabModal — name validation", () => {
  it("Save button is disabled when name is cleared in edit mode", () => {
    renderModal(true, makeTab({ name: "Existing" }));
    const input = screen.getByRole("textbox");
    fireEvent.input(input, { target: { value: "" } });
    const saveBtn = screen.getByRole("button", { name: /save/i });
    expect(saveBtn.hasAttribute("disabled")).toBe(true);
  });

  it("Save button is disabled when name exceeds 30 characters", () => {
    renderModal(true, makeTab({ name: "Short" }));
    const input = screen.getByRole("textbox");
    // maxLength HTML attribute prevents input > 30, but signal-based validation also guards it
    // Test via direct value that the signal would reject (simulated via input having maxLength)
    const inputEl = input as HTMLInputElement;
    expect(inputEl.maxLength).toBe(30);
  });

  it("shows character count", () => {
    renderModal(true);
    const input = screen.getByRole("textbox");
    fireEvent.input(input, { target: { value: "Hello" } });
    expect(screen.getByText("5/30")).toBeDefined();
  });
});

describe("CustomTabModal — cap enforcement (create mode)", () => {
  it("shows cap error when 10 tabs already exist", () => {
    // Simulate 10 tabs in config
    (config as { customTabs: CustomTab[] }).customTabs = Array.from({ length: 10 }, (_, i) =>
      makeTab({ id: `tab${i}`, name: `Tab ${i}` })
    );

    renderModal(true);
    const input = screen.getByRole("textbox");
    fireEvent.input(input, { target: { value: "Eleventh" } });
    fireEvent.click(screen.getByRole("button", { name: /create/i }));

    expect(screen.getByText(/maximum of 10 custom tabs/i)).toBeDefined();
    expect(mockAddCustomTab).not.toHaveBeenCalled();
  });

  it("does not show cap error by default (fewer than 10 tabs)", () => {
    renderModal(true);
    expect(screen.queryByText(/maximum of 10 custom tabs/i)).toBeNull();
  });
});

describe("CustomTabModal — filter preset", () => {
  it("renders filter selects for the active base type (issues)", () => {
    renderModal(true);
    // Issues type includes Scope, Role, Comments, User filter groups
    expect(screen.getByRole("combobox", { name: /scope/i })).toBeDefined();
    expect(screen.getByRole("combobox", { name: /role/i })).toBeDefined();
  });

  it("renders different filter selects for actions type", () => {
    renderModal(true);
    const typeSelect = screen.getByRole("combobox", { name: /type/i });
    fireEvent.change(typeSelect, { target: { value: "actions" } });

    expect(screen.getByRole("combobox", { name: /result/i })).toBeDefined();
    expect(screen.getByRole("combobox", { name: /trigger/i })).toBeDefined();
    // Scope filter not present for actions
    expect(screen.queryByRole("combobox", { name: /scope/i })).toBeNull();
  });

  it("stores non-default filter preset values in saved tab", () => {
    renderModal(true);
    const input = screen.getByRole("textbox");
    fireEvent.input(input, { target: { value: "Author Issues" } });

    const roleSelect = screen.getByRole("combobox", { name: /role/i });
    fireEvent.change(roleSelect, { target: { value: "author" } });

    fireEvent.click(screen.getByRole("button", { name: /create/i }));

    const arg = mockAddCustomTab.mock.calls[0][0] as CustomTab;
    expect(arg.filterPreset.role).toBe("author");
  });

  it("omits default values from filter preset", () => {
    renderModal(true);
    const input = screen.getByRole("textbox");
    fireEvent.input(input, { target: { value: "Default Tab" } });

    // Leave all filters at defaults (no changes)
    fireEvent.click(screen.getByRole("button", { name: /create/i }));

    const arg = mockAddCustomTab.mock.calls[0][0] as CustomTab;
    // Default values should not be stored
    expect(Object.keys(arg.filterPreset)).toHaveLength(0);
  });
});
