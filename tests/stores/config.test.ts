import { describe, it, expect, beforeEach } from "vitest";
import {
  ConfigSchema, TrackedUserSchema, loadConfig, config, updateConfig, resetConfig, setMonitoredRepo,
  addCustomTab, updateCustomTab, removeCustomTab, reorderCustomTab, getCustomTab, isBuiltinTab,
  CustomTabSchema,
} from "../../src/app/stores/config";
import type { CustomTab } from "../../src/app/stores/config";
import { createRoot } from "solid-js";
import { createStore, produce } from "solid-js/store";

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
  };
})();

Object.defineProperty(globalThis, "localStorage", {
  value: localStorageMock,
  writable: true,
});

const STORAGE_KEY = "github-tracker:config";

describe("ConfigSchema", () => {
  it("returns full defaults when given empty object", () => {
    const result = ConfigSchema.parse({});
    expect(result.selectedOrgs).toEqual([]);
    expect(result.selectedRepos).toEqual([]);
    expect(result.refreshInterval).toBe(300);
    expect(result.maxWorkflowsPerRepo).toBe(5);
    expect(result.maxRunsPerWorkflow).toBe(3);
    expect(result.notifications.enabled).toBe(false);
    expect(result.notifications.issues).toBe(true);
    expect(result.notifications.pullRequests).toBe(true);
    expect(result.notifications.workflowRuns).toBe(true);
    expect(result.theme).toBe("auto");
    expect(result.viewDensity).toBe("comfortable");
    expect(result.itemsPerPage).toBe(25);
    expect(result.defaultTab).toBe("issues");
    expect(result.rememberLastTab).toBe(true);
    expect(result.onboardingComplete).toBe(false);
    expect(result.authMethod).toBe("oauth");
  });

  it("fills missing fields from defaults when partial input given", () => {
    const result = ConfigSchema.parse({ refreshInterval: 600 });
    expect(result.refreshInterval).toBe(600);
    expect(result.maxWorkflowsPerRepo).toBe(5);
    expect(result.theme).toBe("auto");
  });

  it("throws on invalid refreshInterval (below min)", () => {
    expect(() => ConfigSchema.parse({ refreshInterval: -1 })).toThrow();
  });

  it("throws on invalid refreshInterval (above max)", () => {
    expect(() => ConfigSchema.parse({ refreshInterval: 9999 })).toThrow();
  });

  it("throws on invalid theme value", () => {
    expect(() => ConfigSchema.parse({ theme: "invalid" })).toThrow();
  });

  it("throws on invalid itemsPerPage (below min)", () => {
    expect(() => ConfigSchema.parse({ itemsPerPage: 5 })).toThrow();
  });

  it("throws on invalid itemsPerPage (above max)", () => {
    expect(() => ConfigSchema.parse({ itemsPerPage: 999 })).toThrow();
  });

  it("allows refreshInterval of 0 (disabled)", () => {
    const result = ConfigSchema.parse({ refreshInterval: 0 });
    expect(result.refreshInterval).toBe(0);
  });

  describe("hotPollInterval", () => {
    it("defaults to 30", () => {
      expect(ConfigSchema.parse({}).hotPollInterval).toBe(30);
    });

    it("accepts valid values (10, 60, 120)", () => {
      expect(ConfigSchema.parse({ hotPollInterval: 10 }).hotPollInterval).toBe(10);
      expect(ConfigSchema.parse({ hotPollInterval: 60 }).hotPollInterval).toBe(60);
      expect(ConfigSchema.parse({ hotPollInterval: 120 }).hotPollInterval).toBe(120);
    });

    it("rejects values below min (9)", () => {
      expect(() => ConfigSchema.parse({ hotPollInterval: 9 })).toThrow();
    });

    it("rejects values above max (121)", () => {
      expect(() => ConfigSchema.parse({ hotPollInterval: 121 })).toThrow();
    });

    it("persists through config round-trip", () => {
      const stored = ConfigSchema.parse({ hotPollInterval: 45 });
      const roundTripped = ConfigSchema.parse(JSON.parse(JSON.stringify(stored)));
      expect(roundTripped.hotPollInterval).toBe(45);
    });
  });
});

describe("ConfigSchema — upstream repos and tracked users", () => {
  it("defaults upstreamRepos to empty array", () => {
    const result = ConfigSchema.parse({});
    expect(result.upstreamRepos).toEqual([]);
  });

  it("defaults trackedUsers to empty array", () => {
    const result = ConfigSchema.parse({});
    expect(result.trackedUsers).toEqual([]);
  });

  it("accepts valid tracked users", () => {
    const result = ConfigSchema.parse({
      trackedUsers: [
        { login: "octocat", avatarUrl: "https://avatars.githubusercontent.com/u/583231", name: "The Octocat" },
      ],
    });
    expect(result.trackedUsers).toHaveLength(1);
    expect(result.trackedUsers[0].login).toBe("octocat");
  });

  it("rejects trackedUsers array exceeding max of 10", () => {
    const users = Array.from({ length: 11 }, (_, i) => ({
      login: `user${i}`,
      avatarUrl: `https://avatars.githubusercontent.com/u/${i}`,
      name: null,
    }));
    expect(() => ConfigSchema.parse({ trackedUsers: users })).toThrow();
  });

  it("rejects trackedUser with non-GitHub-CDN avatar URL", () => {
    expect(() => ConfigSchema.parse({
      trackedUsers: [
        { login: "evil", avatarUrl: "https://evil.com/avatar.png", name: null },
      ],
    })).toThrow();
  });

  it("accepts trackedUser with null name", () => {
    const result = ConfigSchema.parse({
      trackedUsers: [
        { login: "noname", avatarUrl: "https://avatars.githubusercontent.com/u/1", name: null },
      ],
    });
    expect(result.trackedUsers[0].name).toBeNull();
  });

  it("accepts valid upstream repos", () => {
    const result = ConfigSchema.parse({
      upstreamRepos: [{ owner: "org", name: "repo", fullName: "org/repo" }],
    });
    expect(result.upstreamRepos).toHaveLength(1);
  });

  it("TrackedUserSchema defaults type to 'user' when omitted", () => {
    const result = TrackedUserSchema.parse({
      login: "octocat",
      avatarUrl: "https://avatars.githubusercontent.com/u/583231",
      name: null,
    });
    expect(result.type).toBe("user");
  });

  it("TrackedUserSchema accepts type:'bot'", () => {
    const result = TrackedUserSchema.parse({
      login: "dependabot[bot]",
      avatarUrl: "https://avatars.githubusercontent.com/u/27347476",
      name: null,
      type: "bot",
    });
    expect(result.type).toBe("bot");
  });

  it("TrackedUserSchema accepts type:'user'", () => {
    const result = TrackedUserSchema.parse({
      login: "octocat",
      avatarUrl: "https://avatars.githubusercontent.com/u/583231",
      name: null,
      type: "user",
    });
    expect(result.type).toBe("user");
  });

  it("TrackedUserSchema rejects invalid type value", () => {
    expect(() => TrackedUserSchema.parse({
      login: "octocat",
      avatarUrl: "https://avatars.githubusercontent.com/u/583231",
      name: null,
      type: "organization",
    })).toThrow();
  });

  it("ConfigSchema preserves tracked user type through round-trip", () => {
    const result = ConfigSchema.parse({
      trackedUsers: [
        {
          login: "dependabot[bot]",
          avatarUrl: "https://avatars.githubusercontent.com/u/27347476",
          name: null,
          type: "bot",
        },
      ],
    });
    expect(result.trackedUsers[0].type).toBe("bot");
  });
});

describe("loadConfig", () => {
  beforeEach(() => {
    localStorageMock.clear();
  });

  it("returns defaults when localStorage is empty", () => {
    const cfg = loadConfig();
    expect(cfg.refreshInterval).toBe(300);
    expect(cfg.theme).toBe("auto");
  });

  it("returns stored config when valid data exists", () => {
    const stored = ConfigSchema.parse({ refreshInterval: 120, theme: "dark" });
    localStorageMock.setItem(STORAGE_KEY, JSON.stringify(stored));
    const cfg = loadConfig();
    expect(cfg.refreshInterval).toBe(120);
    expect(cfg.theme).toBe("dark");
  });

  it("falls back to defaults when localStorage contains corrupted JSON", () => {
    localStorageMock.setItem(STORAGE_KEY, "not valid json {{{{");
    const cfg = loadConfig();
    expect(cfg.refreshInterval).toBe(300);
  });

  it("falls back to defaults when localStorage contains invalid schema values", () => {
    localStorageMock.setItem(
      STORAGE_KEY,
      JSON.stringify({ refreshInterval: -999, theme: "ultraviolet" })
    );
    const cfg = loadConfig();
    expect(cfg.refreshInterval).toBe(300);
    expect(cfg.theme).toBe("auto");
  });

  it("resets stale defaultTab to 'issues' when the custom tab no longer exists", () => {
    localStorageMock.setItem(
      STORAGE_KEY,
      JSON.stringify({
        defaultTab: "deleted-tab-id",
        customTabs: [{ id: "other-tab", name: "Other", baseType: "issues", orgScope: [], repoScope: [], filterPreset: {}, exclusive: false }],
      })
    );
    const cfg = loadConfig();
    expect(cfg.defaultTab).toBe("issues");
  });

  it("preserves defaultTab when the custom tab still exists", () => {
    localStorageMock.setItem(
      STORAGE_KEY,
      JSON.stringify({
        defaultTab: "my-tab",
        customTabs: [{ id: "my-tab", name: "My Tab", baseType: "issues", orgScope: [], repoScope: [], filterPreset: {}, exclusive: false }],
      })
    );
    const cfg = loadConfig();
    expect(cfg.defaultTab).toBe("my-tab");
  });
});

// Tests SolidJS store merge mechanics in isolation (does NOT exercise the real
// updateConfig export — see "updateConfig (real export)" block below for that).
describe("store merge behavior (produce + Object.assign)", () => {
  function makeStore() {
    const [cfg, setCfg] = createStore(ConfigSchema.parse({}));
    const update = (partial: Partial<ReturnType<typeof ConfigSchema.parse>>) => {
      setCfg(produce((draft) => {
        Object.assign(draft, partial);
      }));
    };
    return { cfg, update };
  }

  it("merges top-level fields correctly", () => {
    createRoot((dispose) => {
      const { cfg, update } = makeStore();
      update({ refreshInterval: 600 });
      expect(cfg.refreshInterval).toBe(600);
      expect(cfg.theme).toBe("auto");
      expect(cfg.maxWorkflowsPerRepo).toBe(5);
      dispose();
    });
  });

  it("merges nested notifications object correctly when spread", () => {
    createRoot((dispose) => {
      const { cfg, update } = makeStore();
      update({
        notifications: {
          ...cfg.notifications,
          enabled: true,
        },
      });
      expect(cfg.notifications.enabled).toBe(true);
      expect(cfg.notifications.issues).toBe(true);
      expect(cfg.notifications.pullRequests).toBe(true);
      dispose();
    });
  });

  it("preserves existing fields when updating a single field", () => {
    createRoot((dispose) => {
      const { cfg, update } = makeStore();
      update({ theme: "dark" });
      expect(cfg.theme).toBe("dark");
      expect(cfg.refreshInterval).toBe(300);
      expect(cfg.onboardingComplete).toBe(false);
      dispose();
    });
  });

  it("can update selectedOrgs", () => {
    createRoot((dispose) => {
      const { cfg, update } = makeStore();
      update({ selectedOrgs: ["myorg", "anotherorg"] });
      expect(cfg.selectedOrgs).toEqual(["myorg", "anotherorg"]);
      dispose();
    });
  });

  it("can update onboardingComplete", () => {
    createRoot((dispose) => {
      const { cfg, update } = makeStore();
      update({ onboardingComplete: true });
      expect(cfg.onboardingComplete).toBe(true);
      dispose();
    });
  });
});

describe("updateConfig (real export)", () => {
  // resetConfig() only calls setConfig(defaults) — no reactive effects, safe outside a root
  beforeEach(() => {
    resetConfig();
  });

  it("applies valid partial updates", () => {
    createRoot((dispose) => {
      updateConfig({ hotPollInterval: 60 });
      expect(config.hotPollInterval).toBe(60);
      dispose();
    });
  });

  it("rejects out-of-bounds values without modifying store", () => {
    createRoot((dispose) => {
      updateConfig({ hotPollInterval: 5 }); // below min of 10
      expect(config.hotPollInterval).toBe(30); // unchanged from default
      dispose();
    });
  });

  it("rejects values above max without modifying store", () => {
    createRoot((dispose) => {
      updateConfig({ hotPollInterval: 999 }); // above max of 120
      expect(config.hotPollInterval).toBe(30); // unchanged from default
      dispose();
    });
  });

  it("does nothing when called with empty object", () => {
    createRoot((dispose) => {
      updateConfig({ theme: "dark" });
      updateConfig({});
      expect(config.theme).toBe("dark");
      dispose();
    });
  });

  it("rejects entire update when any field is invalid", () => {
    createRoot((dispose) => {
      updateConfig({ theme: "dark" });
      updateConfig({ theme: "forest", hotPollInterval: 5 }); // hotPollInterval below min
      expect(config.theme).toBe("dark");
      expect(config.hotPollInterval).toBe(30);
      dispose();
    });
  });

  // Structural guard: updating ANY single field must never wipe other fields.
  // Catches Zod v4 .partial().safeParse() default inflation (BUG-001 class).
  it.each([
    ["selectedOrgs", { selectedOrgs: ["new-org"] }],
    ["selectedRepos", { selectedRepos: [{ owner: "x", name: "y", fullName: "x/y" }] }],
    ["upstreamRepos", { upstreamRepos: [{ owner: "u", name: "v", fullName: "u/v" }] }],
    ["trackedUsers", { trackedUsers: [{ login: "bob", avatarUrl: "https://avatars.githubusercontent.com/u/1", name: null, type: "user" as const }] }],
    ["refreshInterval", { refreshInterval: 120 }],
    ["hotPollInterval", { hotPollInterval: 60 }],
    ["maxWorkflowsPerRepo", { maxWorkflowsPerRepo: 10 }],
    ["maxRunsPerWorkflow", { maxRunsPerWorkflow: 5 }],
    ["notifications", { notifications: { enabled: true, issues: false, pullRequests: true, workflowRuns: false } }],
    ["theme", { theme: "dark" as const }],
    ["viewDensity", { viewDensity: "compact" as const }],
    ["itemsPerPage", { itemsPerPage: 50 }],
    ["defaultTab", { defaultTab: "actions" as const }],
    ["rememberLastTab", { rememberLastTab: false }],
    ["onboardingComplete", { onboardingComplete: true }],
    ["authMethod", { authMethod: "pat" as const }],
  ])("updating only %s preserves all other fields", (fieldName, patch) => {
    createRoot((dispose) => {
      // Seed config with non-default values for every field
      const seed = {
        selectedOrgs: ["seed-org"],
        selectedRepos: [{ owner: "s", name: "r", fullName: "s/r" }],
        upstreamRepos: [{ owner: "a", name: "b", fullName: "a/b" }],
        trackedUsers: [{ login: "alice", avatarUrl: "https://avatars.githubusercontent.com/u/2", name: "Alice", type: "user" as const }],
        refreshInterval: 600,
        hotPollInterval: 45,
        maxWorkflowsPerRepo: 8,
        maxRunsPerWorkflow: 2,
        notifications: { enabled: true, issues: false, pullRequests: false, workflowRuns: true },
        theme: "dracula" as const,
        viewDensity: "compact" as const,
        itemsPerPage: 50,
        defaultTab: "pullRequests" as const,
        rememberLastTab: false,
        onboardingComplete: true,
        authMethod: "pat" as const,
      };
      updateConfig(seed);

      // Snapshot before the single-field update
      const before = JSON.parse(JSON.stringify(config));

      // Apply the single-field patch
      updateConfig(patch);

      // The patched field should have changed
      expect((config as Record<string, unknown>)[fieldName]).toEqual(
        (patch as Record<string, unknown>)[fieldName]
      );

      // Every OTHER field must be identical to the snapshot
      for (const key of Object.keys(before)) {
        if (key === fieldName) continue;
        // monitoredRepos is pruned when selectedRepos changes — skip the cross-check for that case
        if (fieldName === "selectedRepos" && key === "monitoredRepos") continue;
        expect(
          (config as Record<string, unknown>)[key],
          `updateConfig({ ${fieldName} }) must not change ${key}`
        ).toEqual((before as Record<string, unknown>)[key]);
      }
      dispose();
    });
  });
});

// ── monitoredRepos config schema + setMonitoredRepo (C3) ─────────────────────

describe("ConfigSchema — monitoredRepos", () => {
  it("defaults monitoredRepos to empty array", () => {
    const result = ConfigSchema.parse({});
    expect(result.monitoredRepos).toEqual([]);
  });

  it("accepts valid monitoredRepos", () => {
    const result = ConfigSchema.parse({
      monitoredRepos: [{ owner: "org", name: "repo", fullName: "org/repo" }],
    });
    expect(result.monitoredRepos).toHaveLength(1);
    expect(result.monitoredRepos[0].fullName).toBe("org/repo");
  });
});

describe("updateConfig — monitoredRepos pruning on selectedRepos change", () => {
  beforeEach(() => {
    resetConfig();
  });

  it("prunes monitoredRepos when selectedRepos removes a repo", () => {
    createRoot((dispose) => {
      updateConfig({
        selectedRepos: [
          { owner: "org", name: "a", fullName: "org/a" },
          { owner: "org", name: "b", fullName: "org/b" },
        ],
        monitoredRepos: [
          { owner: "org", name: "a", fullName: "org/a" },
          { owner: "org", name: "b", fullName: "org/b" },
        ],
      });
      // Remove org/b from selectedRepos
      updateConfig({
        selectedRepos: [{ owner: "org", name: "a", fullName: "org/a" }],
      });
      expect(config.monitoredRepos).toHaveLength(1);
      expect(config.monitoredRepos[0].fullName).toBe("org/a");
      dispose();
    });
  });

  it("does not prune monitoredRepos when selectedRepos is not in the update", () => {
    createRoot((dispose) => {
      updateConfig({
        selectedRepos: [{ owner: "org", name: "a", fullName: "org/a" }],
        monitoredRepos: [{ owner: "org", name: "a", fullName: "org/a" }],
      });
      // Update theme only
      updateConfig({ theme: "dark" });
      expect(config.monitoredRepos).toHaveLength(1);
      dispose();
    });
  });
});

describe("setMonitoredRepo (C3)", () => {
  beforeEach(() => {
    resetConfig();
  });

  it("adds a repo to monitoredRepos when monitored=true and repo is in selectedRepos", () => {
    createRoot((dispose) => {
      updateConfig({
        selectedRepos: [{ owner: "org", name: "a", fullName: "org/a" }],
      });
      setMonitoredRepo({ owner: "org", name: "a", fullName: "org/a" }, true);
      expect(config.monitoredRepos).toHaveLength(1);
      expect(config.monitoredRepos[0].fullName).toBe("org/a");
      dispose();
    });
  });

  it("is idempotent — adding same repo twice results in one entry", () => {
    createRoot((dispose) => {
      updateConfig({
        selectedRepos: [{ owner: "org", name: "a", fullName: "org/a" }],
      });
      setMonitoredRepo({ owner: "org", name: "a", fullName: "org/a" }, true);
      setMonitoredRepo({ owner: "org", name: "a", fullName: "org/a" }, true);
      expect(config.monitoredRepos).toHaveLength(1);
      dispose();
    });
  });

  it("removes a repo from monitoredRepos when monitored=false", () => {
    createRoot((dispose) => {
      updateConfig({
        selectedRepos: [
          { owner: "org", name: "a", fullName: "org/a" },
          { owner: "org", name: "b", fullName: "org/b" },
        ],
        monitoredRepos: [
          { owner: "org", name: "a", fullName: "org/a" },
          { owner: "org", name: "b", fullName: "org/b" },
        ],
      });
      setMonitoredRepo({ owner: "org", name: "a", fullName: "org/a" }, false);
      expect(config.monitoredRepos).toHaveLength(1);
      expect(config.monitoredRepos[0].fullName).toBe("org/b");
      dispose();
    });
  });

  it("is idempotent — removing non-monitored repo is a no-op", () => {
    createRoot((dispose) => {
      updateConfig({
        selectedRepos: [{ owner: "org", name: "a", fullName: "org/a" }],
        monitoredRepos: [],
      });
      setMonitoredRepo({ owner: "org", name: "a", fullName: "org/a" }, false);
      expect(config.monitoredRepos).toHaveLength(0);
      dispose();
    });
  });

  it("rejects repo not in selectedRepos — does not add to monitoredRepos", () => {
    createRoot((dispose) => {
      updateConfig({
        selectedRepos: [{ owner: "org", name: "a", fullName: "org/a" }],
      });
      setMonitoredRepo({ owner: "org", name: "notselected", fullName: "org/notselected" }, true);
      expect(config.monitoredRepos).toHaveLength(0);
      dispose();
    });
  });

  it("enforces max 10 monitored repos", () => {
    createRoot((dispose) => {
      const repos = Array.from({ length: 11 }, (_, i) => ({
        owner: "org",
        name: `repo-${i}`,
        fullName: `org/repo-${i}`,
      }));
      updateConfig({ selectedRepos: repos, monitoredRepos: repos.slice(0, 10) });
      // 10 is the max — adding an 11th should be rejected
      setMonitoredRepo(repos[10], true);
      expect(config.monitoredRepos).toHaveLength(10);
      dispose();
    });
  });
});

describe("ConfigSchema — enableTracking", () => {
  it("defaults enableTracking to false", () => {
    const result = ConfigSchema.parse({});
    expect(result.enableTracking).toBe(false);
  });

  it("accepts enableTracking: true", () => {
    const result = ConfigSchema.parse({ enableTracking: true });
    expect(result.enableTracking).toBe(true);
  });

  it("defaultTab accepts 'tracked'", () => {
    const result = ConfigSchema.parse({ defaultTab: "tracked" });
    expect(result.defaultTab).toBe("tracked");
  });

  it("defaultTab rejects empty string", () => {
    expect(() => ConfigSchema.parse({ defaultTab: "" })).toThrow();
  });

  it("defaultTab rejects string longer than 50 chars", () => {
    expect(() => ConfigSchema.parse({ defaultTab: "a".repeat(51) })).toThrow();
  });

  it("defaultTab accepts custom tab ID strings", () => {
    const result = ConfigSchema.parse({ defaultTab: "abc12345" });
    expect(result.defaultTab).toBe("abc12345");
  });
});

describe("ConfigSchema — monitoredRepos max constraint", () => {
  it("rejects more than 10 monitored repos at schema level", () => {
    const repos = Array.from({ length: 11 }, (_, i) => ({
      owner: "org",
      name: `repo-${i}`,
      fullName: `org/repo-${i}`,
    }));
    const result = ConfigSchema.safeParse({ monitoredRepos: repos });
    expect(result.success).toBe(false);
  });

  it("accepts exactly 10 monitored repos", () => {
    const repos = Array.from({ length: 10 }, (_, i) => ({
      owner: "org",
      name: `repo-${i}`,
      fullName: `org/repo-${i}`,
    }));
    const result = ConfigSchema.safeParse({ monitoredRepos: repos });
    expect(result.success).toBe(true);
  });
});

// ── Custom Tab helpers (addCustomTab, updateCustomTab, removeCustomTab, reorderCustomTab, getCustomTab, isBuiltinTab) ─────

function makeTab(overrides: Partial<CustomTab> = {}): CustomTab {
  return {
    id: "tab-abc123",
    name: "My Tab",
    baseType: "issues",
    orgScope: [],
    repoScope: [],
    filterPreset: {},
    exclusive: false,
    ...overrides,
  };
}

describe("isBuiltinTab", () => {
  it("returns true for 'issues'", () => {
    expect(isBuiltinTab("issues")).toBe(true);
  });

  it("returns true for 'pullRequests'", () => {
    expect(isBuiltinTab("pullRequests")).toBe(true);
  });

  it("returns true for 'actions'", () => {
    expect(isBuiltinTab("actions")).toBe(true);
  });

  it("returns true for 'tracked'", () => {
    expect(isBuiltinTab("tracked")).toBe(true);
  });

  it("returns false for arbitrary string", () => {
    expect(isBuiltinTab("my-custom-tab")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isBuiltinTab("")).toBe(false);
  });
});

describe("addCustomTab", () => {
  beforeEach(() => {
    resetConfig();
  });

  it("adds a tab in the happy path", () => {
    createRoot((dispose) => {
      addCustomTab(makeTab());
      expect(config.customTabs).toHaveLength(1);
      expect(config.customTabs[0].id).toBe("tab-abc123");
      expect(config.customTabs[0].name).toBe("My Tab");
      dispose();
    });
  });

  it("rejects adding when at cap of 10 tabs", () => {
    createRoot((dispose) => {
      for (let i = 0; i < 10; i++) {
        addCustomTab(makeTab({ id: `tab-${i}`, name: `Tab ${i}` }));
      }
      expect(config.customTabs).toHaveLength(10);
      addCustomTab(makeTab({ id: "tab-overflow", name: "Overflow" }));
      expect(config.customTabs).toHaveLength(10);
      dispose();
    });
  });

  it("rejects adding a tab with a duplicate ID", () => {
    createRoot((dispose) => {
      addCustomTab(makeTab({ id: "tab-dup" }));
      addCustomTab(makeTab({ id: "tab-dup", name: "Duplicate" }));
      expect(config.customTabs).toHaveLength(1);
      dispose();
    });
  });

  it("rejects adding a tab with built-in ID 'issues'", () => {
    createRoot((dispose) => {
      addCustomTab(makeTab({ id: "issues" }));
      expect(config.customTabs).toHaveLength(0);
      dispose();
    });
  });

  it("rejects adding a tab with built-in ID 'tracked'", () => {
    createRoot((dispose) => {
      addCustomTab(makeTab({ id: "tracked" }));
      expect(config.customTabs).toHaveLength(0);
      dispose();
    });
  });

  it("rejects adding a tab with built-in ID 'pullRequests'", () => {
    createRoot((dispose) => {
      addCustomTab(makeTab({ id: "pullRequests" }));
      expect(config.customTabs).toHaveLength(0);
      dispose();
    });
  });

  it("rejects adding a tab with built-in ID 'actions'", () => {
    createRoot((dispose) => {
      addCustomTab(makeTab({ id: "actions" }));
      expect(config.customTabs).toHaveLength(0);
      dispose();
    });
  });
});

describe("updateCustomTab", () => {
  beforeEach(() => {
    resetConfig();
  });

  it("updates the name of an existing tab (partial field update)", () => {
    createRoot((dispose) => {
      addCustomTab(makeTab({ id: "tab-1", name: "Old Name" }));
      updateCustomTab("tab-1", { name: "New Name" });
      expect(config.customTabs[0].name).toBe("New Name");
      expect(config.customTabs[0].baseType).toBe("issues"); // unchanged
      dispose();
    });
  });

  it("updates multiple fields at once", () => {
    createRoot((dispose) => {
      addCustomTab(makeTab({ id: "tab-1", name: "Old", baseType: "issues" }));
      updateCustomTab("tab-1", { name: "New", baseType: "pullRequests" });
      expect(config.customTabs[0].name).toBe("New");
      expect(config.customTabs[0].baseType).toBe("pullRequests");
      dispose();
    });
  });

  it("is a no-op for a nonexistent tab ID", () => {
    createRoot((dispose) => {
      addCustomTab(makeTab({ id: "tab-1", name: "Existing" }));
      updateCustomTab("tab-nonexistent", { name: "Ghost" });
      expect(config.customTabs).toHaveLength(1);
      expect(config.customTabs[0].name).toBe("Existing");
      dispose();
    });
  });

  it("ignores id field in updates — tab id remains unchanged", () => {
    createRoot((dispose) => {
      addCustomTab(makeTab({ id: "tab-orig", name: "Original" }));
      updateCustomTab("tab-orig", { id: "new-id", name: "Renamed" });
      expect(config.customTabs[0].id).toBe("tab-orig");
      expect(config.customTabs[0].name).toBe("Renamed");
      dispose();
    });
  });
});

describe("removeCustomTab", () => {
  beforeEach(() => {
    resetConfig();
  });

  it("removes an existing tab", () => {
    createRoot((dispose) => {
      addCustomTab(makeTab({ id: "tab-1" }));
      addCustomTab(makeTab({ id: "tab-2", name: "Tab 2" }));
      removeCustomTab("tab-1");
      expect(config.customTabs).toHaveLength(1);
      expect(config.customTabs[0].id).toBe("tab-2");
      dispose();
    });
  });

  it("resets defaultTab to 'issues' when the deleted tab was the default", () => {
    createRoot((dispose) => {
      addCustomTab(makeTab({ id: "tab-custom" }));
      updateConfig({ defaultTab: "tab-custom" });
      expect(config.defaultTab).toBe("tab-custom");
      removeCustomTab("tab-custom");
      expect(config.defaultTab).toBe("issues");
      dispose();
    });
  });

  it("does not change defaultTab when a different tab is deleted", () => {
    createRoot((dispose) => {
      addCustomTab(makeTab({ id: "tab-1" }));
      addCustomTab(makeTab({ id: "tab-2", name: "Tab 2" }));
      updateConfig({ defaultTab: "tab-2" });
      removeCustomTab("tab-1");
      expect(config.defaultTab).toBe("tab-2");
      dispose();
    });
  });

  it("is a no-op for a nonexistent tab ID", () => {
    createRoot((dispose) => {
      addCustomTab(makeTab({ id: "tab-1" }));
      removeCustomTab("tab-nonexistent");
      expect(config.customTabs).toHaveLength(1);
      dispose();
    });
  });
});

describe("reorderCustomTab", () => {
  beforeEach(() => {
    resetConfig();
  });

  it("moves a tab up by swapping with its predecessor", () => {
    createRoot((dispose) => {
      addCustomTab(makeTab({ id: "tab-a", name: "A" }));
      addCustomTab(makeTab({ id: "tab-b", name: "B" }));
      addCustomTab(makeTab({ id: "tab-c", name: "C" }));
      reorderCustomTab("tab-b", "up");
      expect(config.customTabs[0].id).toBe("tab-b");
      expect(config.customTabs[1].id).toBe("tab-a");
      expect(config.customTabs[2].id).toBe("tab-c");
      dispose();
    });
  });

  it("moves a tab down by swapping with its successor", () => {
    createRoot((dispose) => {
      addCustomTab(makeTab({ id: "tab-a", name: "A" }));
      addCustomTab(makeTab({ id: "tab-b", name: "B" }));
      addCustomTab(makeTab({ id: "tab-c", name: "C" }));
      reorderCustomTab("tab-b", "down");
      expect(config.customTabs[0].id).toBe("tab-a");
      expect(config.customTabs[1].id).toBe("tab-c");
      expect(config.customTabs[2].id).toBe("tab-b");
      dispose();
    });
  });

  it("is a no-op when moving the first item up", () => {
    createRoot((dispose) => {
      addCustomTab(makeTab({ id: "tab-a", name: "A" }));
      addCustomTab(makeTab({ id: "tab-b", name: "B" }));
      reorderCustomTab("tab-a", "up");
      expect(config.customTabs[0].id).toBe("tab-a");
      expect(config.customTabs[1].id).toBe("tab-b");
      dispose();
    });
  });

  it("is a no-op when moving the last item down", () => {
    createRoot((dispose) => {
      addCustomTab(makeTab({ id: "tab-a", name: "A" }));
      addCustomTab(makeTab({ id: "tab-b", name: "B" }));
      reorderCustomTab("tab-b", "down");
      expect(config.customTabs[0].id).toBe("tab-a");
      expect(config.customTabs[1].id).toBe("tab-b");
      dispose();
    });
  });
});

describe("getCustomTab", () => {
  beforeEach(() => {
    resetConfig();
  });

  it("returns the tab when found by ID", () => {
    createRoot((dispose) => {
      addCustomTab(makeTab({ id: "tab-found", name: "Found" }));
      const result = getCustomTab("tab-found");
      expect(result).toBeDefined();
      expect(result?.name).toBe("Found");
      dispose();
    });
  });

  it("returns undefined for a missing ID", () => {
    createRoot((dispose) => {
      const result = getCustomTab("tab-missing");
      expect(result).toBeUndefined();
      dispose();
    });
  });
});

describe("CustomTabSchema — field validation", () => {
  it("rejects id with spaces", () => {
    expect(CustomTabSchema.safeParse({ id: "bad id", name: "Tab", baseType: "issues" }).success).toBe(false);
  });

  it("rejects id longer than 50 characters", () => {
    expect(CustomTabSchema.safeParse({ id: "a".repeat(51), name: "Tab", baseType: "issues" }).success).toBe(false);
  });

  it("accepts id at max length (50 chars)", () => {
    expect(CustomTabSchema.safeParse({ id: "a".repeat(50), name: "Tab", baseType: "issues" }).success).toBe(true);
  });

  it("rejects empty name", () => {
    expect(CustomTabSchema.safeParse({ id: "tab-valid", name: "", baseType: "issues" }).success).toBe(false);
  });

  it("rejects name longer than 30 characters", () => {
    expect(CustomTabSchema.safeParse({ id: "tab-valid", name: "a".repeat(31), baseType: "issues" }).success).toBe(false);
  });

  it("accepts name at max length (30 chars)", () => {
    expect(CustomTabSchema.safeParse({ id: "tab-valid", name: "a".repeat(30), baseType: "issues" }).success).toBe(true);
  });

  it("rejects orgScope with more than 100 entries", () => {
    expect(CustomTabSchema.safeParse({
      id: "tab-valid", name: "Tab", baseType: "issues",
      orgScope: Array.from({ length: 101 }, (_, i) => `org${i}`),
    }).success).toBe(false);
  });

  it("rejects invalid baseType", () => {
    expect(CustomTabSchema.safeParse({ id: "tab-valid", name: "Tab", baseType: "tracked" }).success).toBe(false);
  });

  it("applies defaults for optional fields", () => {
    const result = CustomTabSchema.safeParse({ id: "tab-valid", name: "Tab", baseType: "pullRequests" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.orgScope).toEqual([]);
      expect(result.data.repoScope).toEqual([]);
      expect(result.data.filterPreset).toEqual({});
      expect(result.data.exclusive).toBe(false);
    }
  });
});
