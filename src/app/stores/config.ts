import { z } from "zod";
import { createStore, produce } from "solid-js/store";
import { createEffect } from "solid-js";
import { pushNotification } from "../lib/errors";

export const CONFIG_STORAGE_KEY = "github-tracker:config";

// Light themes first, then dark themes. "auto" uses system preference (corporate/dim).
export const THEME_OPTIONS = ["auto", "corporate", "cupcake", "light", "nord", "dim", "dracula", "dark", "forest"] as const;
export type ThemeId = (typeof THEME_OPTIONS)[number];
export const DARK_THEMES: ReadonlySet<string> = new Set(["dim", "dracula", "dark", "forest"]);
export const AUTO_LIGHT_THEME = "corporate" as const;
export const AUTO_DARK_THEME = "dim" as const;

export function resolveTheme(theme: ThemeId): string {
  if (theme !== "auto") return theme;
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  return prefersDark ? AUTO_DARK_THEME : AUTO_LIGHT_THEME;
}

const REPO_SEGMENT = /^[A-Za-z0-9._-]{1,100}$/;

export const RepoRefSchema = z.object({
  owner: z.string().regex(REPO_SEGMENT),
  name: z.string().regex(REPO_SEGMENT),
  fullName: z.string().regex(/^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/),
});

export const TrackedUserSchema = z.object({
  login: z.string(),
  avatarUrl: z.string().url().refine(
    (u) => u.startsWith("https://avatars.githubusercontent.com/"),
    "Avatar URL must be from GitHub CDN"
  ),
  name: z.string().nullable(),
  type: z.enum(["user", "bot"]).default("user"),
});

export type TrackedUser = z.infer<typeof TrackedUserSchema>;

export const ConfigSchema = z.object({
  selectedOrgs: z.array(z.string()).default([]),
  selectedRepos: z.array(RepoRefSchema).default([]),
  upstreamRepos: z.array(RepoRefSchema).default([]),
  monitoredRepos: z.array(RepoRefSchema).max(10).default([]),
  trackedUsers: z.array(TrackedUserSchema).max(10).default([]),
  refreshInterval: z.number().min(0).max(3600).default(300),
  hotPollInterval: z.number().min(10).max(120).default(30),
  maxWorkflowsPerRepo: z.number().min(1).max(20).default(5),
  maxRunsPerWorkflow: z.number().min(1).max(10).default(3),
  notifications: z
    .object({
      enabled: z.boolean().default(false),
      issues: z.boolean().default(true),
      pullRequests: z.boolean().default(true),
      workflowRuns: z.boolean().default(true),
    })
    .default({ enabled: false, issues: true, pullRequests: true, workflowRuns: true }),
  theme: z.enum(THEME_OPTIONS).default("auto"),
  viewDensity: z.enum(["compact", "comfortable"]).default("comfortable"),
  itemsPerPage: z.number().min(10).max(100).default(25),
  defaultTab: z.enum(["issues", "pullRequests", "actions"]).default("issues"),
  rememberLastTab: z.boolean().default(true),
  onboardingComplete: z.boolean().default(false),
  authMethod: z.enum(["oauth", "pat"]).default("oauth"),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  try {
    const raw = localStorage.getItem(CONFIG_STORAGE_KEY);
    if (raw === null) return ConfigSchema.parse({});
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && "theme" in parsed) {
      if (!THEME_OPTIONS.includes((parsed as Record<string, unknown>).theme as typeof THEME_OPTIONS[number])) {
        (parsed as Record<string, unknown>).theme = "auto";
      }
    }
    const result = ConfigSchema.safeParse(parsed);
    if (result.success) return result.data;
    return ConfigSchema.parse({});
  } catch {
    return ConfigSchema.parse({});
  }
}

export const [config, setConfig] = createStore<Config>(loadConfig());

export function updateConfig(partial: Partial<Config>): void {
  const validated = ConfigSchema.partial().safeParse(partial);
  if (!validated.success) return;
  // Only merge keys the caller actually provided: Zod .partial().safeParse()
  // still applies per-field .default() values for absent keys, inflating
  // validated.data with defaults that would overwrite live state.
  const filtered = Object.fromEntries(
    (Object.keys(partial) as (keyof Config)[]).map((k) => [k, validated.data[k]])
  );
  setConfig(
    produce((draft) => {
      Object.assign(draft, filtered);
      if ("selectedRepos" in partial) {
        const selectedSet = new Set(draft.selectedRepos.map((r) => r.fullName));
        draft.monitoredRepos = draft.monitoredRepos.filter((r) => selectedSet.has(r.fullName));
      }
    })
  );
}

export function setMonitoredRepo(repo: z.infer<typeof RepoRefSchema>, monitored: boolean): void {
  setConfig(
    produce((draft) => {
      if (monitored) {
        const inSelected = draft.selectedRepos.some((r) => r.fullName === repo.fullName);
        if (!inSelected) return;
        if (draft.monitoredRepos.length >= 10) return;
        const alreadyMonitored = draft.monitoredRepos.some((r) => r.fullName === repo.fullName);
        if (!alreadyMonitored) {
          draft.monitoredRepos.push(repo);
        }
      } else {
        draft.monitoredRepos = draft.monitoredRepos.filter((r) => r.fullName !== repo.fullName);
      }
    })
  );
}

export function resetConfig(): void {
  const defaults = ConfigSchema.parse({});
  setConfig(defaults);
}

export function initConfigPersistence(): void {
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    const snapshot = JSON.parse(JSON.stringify(config)) as Config;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      try {
        localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(snapshot));
      } catch {
        pushNotification("localStorage:config", "Config write failed — storage may be full", "warning");
      }
    }, 200);
  });
}
