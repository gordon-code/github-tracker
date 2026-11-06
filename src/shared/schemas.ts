// ── Shared Zod schemas ────────────────────────────────────────────────────────
// Browser-agnostic schemas shared between the SPA and MCP server.
// Note: DARK_THEMES, resolveTheme, AUTO_LIGHT_THEME, AUTO_DARK_THEME are
// intentionally kept in src/app/stores/config.ts (they use window.matchMedia).

import * as z from "zod/mini";
import { VALID_TRACKED_LOGIN } from "./validation.js";

export const THEME_OPTIONS = ["auto", "corporate", "cupcake", "light", "nord", "dim", "dracula", "dark", "forest"] as const;
export type ThemeId = (typeof THEME_OPTIONS)[number];

const REPO_SEGMENT = /^[A-Za-z0-9._-]{1,100}$/;

export const RepoRefSchema = z.object({
  owner: z.string().check(z.regex(REPO_SEGMENT)),
  name: z.string().check(z.regex(REPO_SEGMENT)),
  fullName: z.string().check(z.regex(/^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/)),
});

export const TrackedUserSchema = z.object({
  login: z.string().check(z.regex(VALID_TRACKED_LOGIN)),
  avatarUrl: z.url().check(
    z.refine(
      (u) => u.startsWith("https://avatars.githubusercontent.com/"),
      "Avatar URL must be from GitHub CDN"
    )
  ),
  name: z.nullable(z.string()),
  type: z._default(z.enum(["user", "bot"]), "user"),
});

export type TrackedUser = z.infer<typeof TrackedUserSchema>;

export const BUILTIN_TAB_IDS = ["issues", "pullRequests", "dependencies", "actions", "tracked", "jiraAssigned"] as const;
export type BuiltinTabId = (typeof BUILTIN_TAB_IDS)[number];

export const CustomTabBaseType = z.enum(["issues", "pullRequests", "actions"]);

export const CustomTabSchema = z.object({
  id: z.string().check(z.minLength(1), z.maxLength(50), z.regex(/^[a-zA-Z0-9_-]+$/)),
  name: z.string().check(z.minLength(1), z.maxLength(30)),
  baseType: CustomTabBaseType,
  orgScope: z._default(z.array(z.string().check(z.regex(REPO_SEGMENT))).check(z.maxLength(100)), []),
  repoScope: z._default(z.array(RepoRefSchema).check(z.maxLength(100)), []),
  filterPreset: z._default(z.record(z.string(), z.string()), {}),
  exclusive: z._default(z.boolean(), false),
});

export type CustomTab = z.infer<typeof CustomTabSchema>;

export function isBuiltinTab(id: string): id is BuiltinTabId {
  return (BUILTIN_TAB_IDS as readonly string[]).includes(id);
}

export function isActionsBasedTab(id: string, customTabs: readonly CustomTab[]): boolean {
  return id === "actions" || (!isBuiltinTab(id) && customTabs.some((t) => t.id === id && t.baseType === "actions"));
}

/** A tab with no orgScope and no repoScope matches no repos — see buildTabScopeMatcher in DashboardPage.tsx. */
export function isTabUnscoped(tab: Pick<CustomTab, "orgScope" | "repoScope">): boolean {
  return tab.orgScope.length === 0 && tab.repoScope.length === 0;
}

export const JiraAuthMethodSchema = z._default(z.enum(["oauth", "token"]), "oauth");

export const JiraCustomFieldSchema = z.object({
  id: z.string().check(z.regex(/^[a-zA-Z0-9_-]+$/), z.maxLength(100)),
  name: z.string().check(z.maxLength(200)),
});

export type JiraCustomField = z.infer<typeof JiraCustomFieldSchema>;

export const JiraConfigSchema = z.object({
  enabled: z._default(z.boolean(), false),
  authMethod: JiraAuthMethodSchema,
  cloudId: z.optional(z.string()),
  siteUrl: z.optional(z.string()),
  siteName: z.optional(z.string()),
  email: z.optional(z.string()),
  issueKeyDetection: z._default(z.boolean(), true),
  expandIssueDetails: z._default(z.boolean(), false),
  customFields: z._default(z.array(JiraCustomFieldSchema).check(z.maxLength(10)), []),
  customScopes: z._default(z.array(JiraCustomFieldSchema).check(z.maxLength(20)), []),
});

export type JiraConfig = z.infer<typeof JiraConfigSchema>;

export const DependencyConfigSchema = z.object({
  enabled: z._default(z.boolean(), true),
  rebaseLabel: z._default(z.string().check(z.minLength(1), z.maxLength(50)), "rebase"),
  excludedOrgs: z._default(z.array(z.string().check(z.regex(REPO_SEGMENT))).check(z.maxLength(100)), []),
  excludedRepos: z._default(z.array(RepoRefSchema).check(z.maxLength(100)), []),
});
export type DependencyConfig = z.infer<typeof DependencyConfigSchema>;

export const ConfigSchema = z.object({
  selectedOrgs: z._default(z.array(z.string()), []),
  selectedRepos: z._default(z.array(RepoRefSchema), []),
  upstreamRepos: z._default(z.array(RepoRefSchema), []),
  monitoredRepos: z._default(z.array(RepoRefSchema).check(z.maxLength(10)), []),
  trackedUsers: z._default(z.array(TrackedUserSchema).check(z.maxLength(10)), []),
  refreshInterval: z._default(z.number().check(z.minimum(0), z.maximum(3600)), 300),
  hotPollInterval: z._default(z.number().check(z.minimum(10), z.maximum(120)), 30),
  maxWorkflowsPerRepo: z._default(z.number().check(z.minimum(1), z.maximum(20)), 5),
  maxRunsPerWorkflow: z._default(z.number().check(z.minimum(1), z.maximum(10)), 3),
  notifications: z._default(
    z.object({
      enabled: z._default(z.boolean(), false),
      issues: z._default(z.boolean(), true),
      pullRequests: z._default(z.boolean(), true),
      workflowRuns: z._default(z.boolean(), true),
    }),
    { enabled: false, issues: true, pullRequests: true, workflowRuns: true }
  ),
  theme: z._default(z.enum(THEME_OPTIONS), "auto"),
  viewDensity: z._default(z.enum(["compact", "comfortable"]), "comfortable"),
  itemsPerPage: z._default(z.number().check(z.minimum(10), z.maximum(100)), 25),
  defaultTab: z._default(z.string().check(z.minLength(1), z.maxLength(50)), "issues"),
  rememberLastTab: z._default(z.boolean(), true),
  onboardingComplete: z._default(z.boolean(), false),
  authMethod: z._default(z.enum(["oauth", "pat"]), "oauth"),
  enableTracking: z._default(z.boolean(), false),
  enableActions: z._default(z.boolean(), true),
  customTabs: z._default(z.array(CustomTabSchema).check(z.maxLength(10)), []),
  mcpRelayEnabled: z._default(z.boolean(), false),
  mcpRelayPort: z._default(z.int().check(z.minimum(1024), z.maximum(65535)), 9876),
  lastSeenVersion: z._default(z.nullable(z.string().check(z.maxLength(32))), null),
  // Explicit defaults (NOT .default({})) — inner field defaults don't apply with .default({}) per BUG-001
  jira: z._default(JiraConfigSchema, { enabled: false, authMethod: "oauth", issueKeyDetection: true, expandIssueDetails: false, customFields: [], customScopes: [] }),
  dependencies: z._default(DependencyConfigSchema, { enabled: true, rebaseLabel: "rebase", excludedOrgs: [], excludedRepos: [] }),
});

export type Config = z.infer<typeof ConfigSchema>;
