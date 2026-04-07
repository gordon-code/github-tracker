import { createStore, produce } from "solid-js/store";
import { createEffect, onCleanup } from "solid-js";
import { pushNotification } from "../lib/errors";
import { ConfigSchema, RepoRefSchema, THEME_OPTIONS } from "../../shared/schemas";
import type { Config, ThemeId } from "../../shared/schemas";
import { z } from "zod";

// ── Re-exports from shared/schemas (backward compat for existing importers) ───
export { ConfigSchema, RepoRefSchema, TrackedUserSchema, THEME_OPTIONS, type Config, type TrackedUser, type ThemeId } from "../../shared/schemas";

export const CONFIG_STORAGE_KEY = "github-tracker:config";

// ── Browser-only theme helpers ────────────────────────────────────────────────
// These use window.matchMedia and must stay in the browser layer.
export const DARK_THEMES: ReadonlySet<string> = new Set(["dim", "dracula", "dark", "forest"]);
export const AUTO_LIGHT_THEME = "corporate" as const;
export const AUTO_DARK_THEME = "dim" as const;

export function resolveTheme(theme: ThemeId): string {
  if (theme !== "auto") return theme;
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  return prefersDark ? AUTO_DARK_THEME : AUTO_LIGHT_THEME;
}

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

export function setMcpRelayEnabled(enabled: boolean): void {
  updateConfig({ mcpRelayEnabled: enabled });
}

export function setMcpRelayPort(port: number): void {
  updateConfig({ mcpRelayPort: port });
}

export function resetConfig(): void {
  const defaults = ConfigSchema.parse({});
  setConfig(defaults);
}

export function initConfigPersistence(): void {
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingJson: string | undefined;
  createEffect(() => {
    const snapshot = JSON.parse(JSON.stringify(config)) as Config;
    const json = JSON.stringify(snapshot);
    pendingJson = json;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      pendingJson = undefined;
      try {
        localStorage.setItem(CONFIG_STORAGE_KEY, json);
      } catch {
        pushNotification("localStorage:config", "Config write failed — storage may be full", "warning");
      }
    }, 200);
    onCleanup(() => {
      clearTimeout(debounceTimer);
      if (pendingJson !== undefined) {
        try { localStorage.setItem(CONFIG_STORAGE_KEY, pendingJson); } catch { /* best-effort */ }
        pendingJson = undefined;
      }
    });
  });
}
