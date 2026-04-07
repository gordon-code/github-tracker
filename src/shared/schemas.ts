// ── Shared Zod schemas ────────────────────────────────────────────────────────
// Browser-agnostic schemas shared between the SPA and MCP server.
// Note: DARK_THEMES, resolveTheme, AUTO_LIGHT_THEME, AUTO_DARK_THEME are
// intentionally kept in src/app/stores/config.ts (they use window.matchMedia).

import { z } from "zod";

export const THEME_OPTIONS = ["auto", "corporate", "cupcake", "light", "nord", "dim", "dracula", "dark", "forest"] as const;
export type ThemeId = (typeof THEME_OPTIONS)[number];

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
  defaultTab: z.enum(["issues", "pullRequests", "actions", "tracked"]).default("issues"),
  rememberLastTab: z.boolean().default(true),
  onboardingComplete: z.boolean().default(false),
  authMethod: z.enum(["oauth", "pat"]).default("oauth"),
  enableTracking: z.boolean().default(false),
});

export type Config = z.infer<typeof ConfigSchema>;
