import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock is hoisted — cannot reference outer variables in factory.
// Use vi.hoisted() to create mocks that are safe to reference in the factory.
const { mockSetTabFilter, mockResetAllTabFilters, mockSetCustomTabFilter, mockResetCustomTabFilters } = vi.hoisted(() => ({
  mockSetTabFilter: vi.fn(),
  mockResetAllTabFilters: vi.fn(),
  mockSetCustomTabFilter: vi.fn(),
  mockResetCustomTabFilters: vi.fn(),
}));

const { mockViewState } = vi.hoisted(() => ({
  mockViewState: { customTabFilters: {} as Record<string, Record<string, string>> },
}));

vi.mock("../../src/app/stores/view", () => ({
  viewState: mockViewState,
  setTabFilter: mockSetTabFilter,
  resetAllTabFilters: mockResetAllTabFilters,
  setCustomTabFilter: mockSetCustomTabFilter,
  resetCustomTabFilters: mockResetCustomTabFilters,
}));

import { createTabFilterHandlers, mergeActiveFilters } from "../../src/app/lib/tabFilters";

describe("createTabFilterHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("handleFilterChange", () => {
    it("dispatches to setCustomTabFilter when getCustomTabId returns a value", () => {
      const { handleFilterChange } = createTabFilterHandlers("issues", () => "custom-tab-1");
      handleFilterChange("role", "author");
      expect(mockSetCustomTabFilter).toHaveBeenCalledWith("custom-tab-1", "role", "author");
      expect(mockSetTabFilter).not.toHaveBeenCalled();
    });

    it("dispatches to setTabFilter when getCustomTabId returns undefined", () => {
      const { handleFilterChange } = createTabFilterHandlers("issues", () => undefined);
      handleFilterChange("role", "author");
      expect(mockSetTabFilter).toHaveBeenCalledWith("issues", "role", "author");
      expect(mockSetCustomTabFilter).not.toHaveBeenCalled();
    });

    it("dispatches to setTabFilter for pullRequests builtin tab when no custom tab", () => {
      const { handleFilterChange } = createTabFilterHandlers("pullRequests", () => undefined);
      handleFilterChange("reviewDecision", "approved");
      expect(mockSetTabFilter).toHaveBeenCalledWith("pullRequests", "reviewDecision", "approved");
    });

    it("dispatches to setTabFilter for actions builtin tab when no custom tab", () => {
      const { handleFilterChange } = createTabFilterHandlers("actions", () => undefined);
      handleFilterChange("conclusion", "failure");
      expect(mockSetTabFilter).toHaveBeenCalledWith("actions", "conclusion", "failure");
    });

    it("uses the custom tab ID returned by getCustomTabId at call time", () => {
      let customId: string | undefined = "first-tab";
      const { handleFilterChange } = createTabFilterHandlers("issues", () => customId);

      handleFilterChange("role", "author");
      expect(mockSetCustomTabFilter).toHaveBeenCalledWith("first-tab", "role", "author");

      vi.clearAllMocks();
      customId = undefined;
      handleFilterChange("role", "reviewer");
      expect(mockSetTabFilter).toHaveBeenCalledWith("issues", "role", "reviewer");
      expect(mockSetCustomTabFilter).not.toHaveBeenCalled();
    });
  });

  describe("handleResetFilters", () => {
    it("dispatches to resetCustomTabFilters when getCustomTabId returns a value", () => {
      const { handleResetFilters } = createTabFilterHandlers("issues", () => "custom-tab-2");
      handleResetFilters();
      expect(mockResetCustomTabFilters).toHaveBeenCalledWith("custom-tab-2");
      expect(mockResetAllTabFilters).not.toHaveBeenCalled();
    });

    it("dispatches to resetAllTabFilters when getCustomTabId returns undefined", () => {
      const { handleResetFilters } = createTabFilterHandlers("issues", () => undefined);
      handleResetFilters();
      expect(mockResetAllTabFilters).toHaveBeenCalledWith("issues");
      expect(mockResetCustomTabFilters).not.toHaveBeenCalled();
    });

    it("dispatches to resetAllTabFilters for pullRequests builtin tab", () => {
      const { handleResetFilters } = createTabFilterHandlers("pullRequests", () => undefined);
      handleResetFilters();
      expect(mockResetAllTabFilters).toHaveBeenCalledWith("pullRequests");
    });

    it("dispatches to resetAllTabFilters for actions builtin tab", () => {
      const { handleResetFilters } = createTabFilterHandlers("actions", () => undefined);
      handleResetFilters();
      expect(mockResetAllTabFilters).toHaveBeenCalledWith("actions");
    });
  });
});

describe("mergeActiveFilters", () => {
  const schema = {
    safeParse: (v: unknown) => {
      const obj = v as Record<string, string>;
      return { success: true, data: obj };
    },
  };
  const defaults = { scope: "involves_me", role: "all", user: "all" };
  const builtinFilters = { scope: "involves_me", role: "all", user: "all" };

  beforeEach(() => {
    mockViewState.customTabFilters = {};
  });

  it("returns builtinFilters when customTabId is undefined", () => {
    const result = mergeActiveFilters(schema, defaults, undefined, builtinFilters, {});
    expect(result).toBe(builtinFilters);
  });

  it("merges defaults → preset → stored for custom tab", () => {
    mockViewState.customTabFilters = { tab1: { role: "reviewer" } };
    const result = mergeActiveFilters(schema, defaults, "tab1", builtinFilters, {
      preset: { scope: "all" },
    });
    expect(result).toEqual({ scope: "all", role: "reviewer", user: "all" });
  });

  it("stored overrides preset", () => {
    mockViewState.customTabFilters = { tab1: { scope: "involves_me" } };
    const result = mergeActiveFilters(schema, defaults, "tab1", builtinFilters, {
      preset: { scope: "all" },
    });
    expect(result).toEqual({ scope: "involves_me", role: "all", user: "all" });
  });

  it("resolves _self sentinel when resolveLogin is provided", () => {
    mockViewState.customTabFilters = {};
    const result = mergeActiveFilters(schema, defaults, "tab1", builtinFilters, {
      preset: { user: "_self" },
      resolveLogin: "testuser",
    });
    expect(result).toEqual({ scope: "involves_me", role: "all", user: "testuser" });
  });

  it("does not resolve _self when resolveLogin is not provided", () => {
    mockViewState.customTabFilters = {};
    const result = mergeActiveFilters(schema, defaults, "tab1", builtinFilters, {
      preset: { user: "_self" },
    });
    expect(result).toEqual({ scope: "involves_me", role: "all", user: "_self" });
  });

  it("falls back to defaults when safeParse returns failure", () => {
    const failSchema = {
      safeParse: () => ({ success: false as const, data: undefined }),
    };
    mockViewState.customTabFilters = {};
    const result = mergeActiveFilters(failSchema, defaults, "tab1", builtinFilters, {});
    expect(result).toBe(defaults);
  });

  it("handles empty preset and empty stored", () => {
    mockViewState.customTabFilters = {};
    const result = mergeActiveFilters(schema, defaults, "tab1", builtinFilters, {});
    expect(result).toEqual(defaults);
  });
});
