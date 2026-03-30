import { describe, it, expect, beforeEach } from "vitest";
import { ConfigSchema, loadConfig, config, updateConfig, resetConfig } from "../../src/app/stores/config";
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
    ["trackedUsers", { trackedUsers: [{ login: "bob", avatarUrl: "https://avatars.githubusercontent.com/u/1", name: null }] }],
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
        trackedUsers: [{ login: "alice", avatarUrl: "https://avatars.githubusercontent.com/u/2", name: "Alice" }],
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
        expect(
          (config as Record<string, unknown>)[key],
          `updateConfig({ ${fieldName} }) must not change ${key}`
        ).toEqual((before as Record<string, unknown>)[key]);
      }
      dispose();
    });
  });
});
