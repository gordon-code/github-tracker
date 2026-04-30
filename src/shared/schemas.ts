// ── Shared Zod schemas ────────────────────────────────────────────────────────
// Browser-agnostic schemas shared between the SPA and MCP server.
// Note: DARK_THEMES, resolveTheme, AUTO_LIGHT_THEME, AUTO_DARK_THEME are
// intentionally kept in src/app/stores/config.ts (they use window.matchMedia).

import { z } from "zod";
import { VALID_TRACKED_LOGIN } from "./validation.js";

export const THEME_OPTIONS = ["auto", "corporate", "cupcake", "light", "nord", "dim", "dracula", "dark", "forest"] as const;
export type ThemeId = (typeof THEME_OPTIONS)[number];

const REPO_SEGMENT = /^[A-Za-z0-9._-]{1,100}$/;

export const RepoRefSchema = z.object({
  owner: z.string().regex(REPO_SEGMENT),
  name: z.string().regex(REPO_SEGMENT),
  fullName: z.string().regex(/^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/),
});

export const TrackedUserSchema = z.object({
  login: z.string().regex(VALID_TRACKED_LOGIN),
  avatarUrl: z.string().url().refine(
    (u) => u.startsWith("https://avatars.githubusercontent.com/"),
    "Avatar URL must be from GitHub CDN"
  ),
  name: z.string().nullable(),
  type: z.enum(["user", "bot"]).default("user"),
});

export type TrackedUser = z.infer<typeof TrackedUserSchema>;

export const BUILTIN_TAB_IDS = ["issues", "pullRequests", "actions", "tracked", "jiraAssigned"] as const;
export type BuiltinTabId = (typeof BUILTIN_TAB_IDS)[number];

export const CustomTabBaseType = z.enum(["issues", "pullRequests", "actions"]);

export const CustomTabSchema = z.object({
  id: z.string().min(1).max(50).regex(/^[a-zA-Z0-9_-]+$/),
  name: z.string().min(1).max(30),
  baseType: CustomTabBaseType,
  orgScope: z.array(z.string().regex(REPO_SEGMENT)).max(100).default([]),
  repoScope: z.array(RepoRefSchema).max(100).default([]),
  filterPreset: z.record(z.string(), z.string()).default({}),
  exclusive: z.boolean().default(false),
});

export type CustomTab = z.infer<typeof CustomTabSchema>;

export function isBuiltinTab(id: string): id is BuiltinTabId {
  return (BUILTIN_TAB_IDS as readonly string[]).includes(id);
}

export const JiraAuthMethodSchema = z.enum(["oauth", "token"]).default("oauth");

export const JiraConfigSchema = z.object({
  enabled: z.boolean().default(false),
  authMethod: JiraAuthMethodSchema,
  cloudId: z.string().optional(),
  siteUrl: z.string().optional(),
  siteName: z.string().optional(),
  email: z.string().optional(),
  issueKeyDetection: z.boolean().default(true),
});

export type JiraConfig = z.infer<typeof JiraConfigSchema>;

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
  defaultTab: z.string().min(1).max(50).default("issues"),
  rememberLastTab: z.boolean().default(true),
  onboardingComplete: z.boolean().default(false),
  authMethod: z.enum(["oauth", "pat"]).default("oauth"),
  enableTracking: z.boolean().default(false),
  customTabs: z.array(CustomTabSchema).max(10).default([]),
  mcpRelayEnabled: z.boolean().default(false),
  mcpRelayPort: z.number().int().min(1024).max(65535).default(9876),
  // Explicit defaults (NOT .default({})) — inner field defaults don't apply with .default({}) per BUG-001
  jira: JiraConfigSchema.default({ enabled: false, authMethod: "oauth", issueKeyDetection: true }),
});

export type Config = z.infer<typeof ConfigSchema>;
