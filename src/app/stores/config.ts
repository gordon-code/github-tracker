import { z } from "zod";
import { createStore } from "solid-js/store";
import { createEffect } from "solid-js";
import { produce } from "solid-js/store";

const STORAGE_KEY = "github-tracker:config";

export const ConfigSchema = z.object({
  selectedOrgs: z.array(z.string()).default([]),
  selectedRepos: z
    .array(
      z.object({
        owner: z.string(),
        name: z.string(),
        fullName: z.string(),
      })
    )
    .default([]),
  refreshInterval: z.number().min(0).max(3600).default(300),
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
  theme: z.enum(["light", "dark", "system"]).default("system"),
  viewDensity: z.enum(["compact", "comfortable"]).default("comfortable"),
  itemsPerPage: z.number().min(10).max(100).default(25),
  defaultTab: z.enum(["issues", "pullRequests", "actions"]).default("issues"),
  rememberLastTab: z.boolean().default(true),
  onboardingComplete: z.boolean().default(false),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return ConfigSchema.parse({});
    const parsed = JSON.parse(raw) as unknown;
    const result = ConfigSchema.safeParse(parsed);
    if (result.success) return result.data;
    return ConfigSchema.parse({});
  } catch {
    return ConfigSchema.parse({});
  }
}

export const [config, setConfig] = createStore<Config>(loadConfig());

export function updateConfig(partial: Partial<Config>): void {
  setConfig(
    produce((draft) => {
      Object.assign(draft, partial);
    })
  );
}

export function initConfigPersistence(): void {
  createEffect(() => {
    const snapshot = JSON.parse(JSON.stringify(config)) as Config;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  });
}
