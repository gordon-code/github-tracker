import * as z from "zod/mini";

export const IGNORED_ITEMS_CAP = 500;
export const TRACKED_ITEMS_CAP = 200;
export const LOCKED_REPOS_CAP = 50;
export const JIRA_CUSTOM_ORDER_CAP = 500;
/**
 * Limits enforced by `.refine()` checks below. customTabFilters/expandedRepos are Records, not
 * arrays — Zod v4's z.record() has no built-in .max() — and a refine's predicate is invisible
 * to JSON Schema, so the limits live here as data. The build fingerprints this object (see
 * `computeSchemaFingerprint` in vite-plugins/build-meta.ts) so that changing a limit marks open
 * tabs on the older build read-only. Any new `.refine()` limit must be added here.
 */
export const PERSISTED_LIMITS = {
  // Outer keys are tab IDs (built-ins + customTabs, itself capped at 10 in
  // shared/schemas.ts), generously capped well above any realistic tab count.
  customTabFiltersTabs: 50,
  // Inner keys are filter field names for a single tab's baseType — every
  // *FiltersSchema below has well under 10 fields.
  customTabFiltersFields: 50,
  expandedReposTabs: 50,
  // Inner keys are repoFullName — unlike lockedRepos (a deliberately small
  // pinned subset), this tracks expand/collapse state for every repo in a tab,
  // so it needs headroom well above LOCKED_REPOS_CAP.
  expandedReposRepos: 1000,
} as const;
export const JIRA_CUSTOM_ORDER_KEY_MAX_LENGTH = 50;
export const JIRA_CUSTOM_ORDER_SCOPE = "assigned" as const;
export const JIRA_CUSTOM_SORT_FIELD = "custom" as const;

export const TrackedItemSchema = z.object({
  id: z.number(),
  number: z.optional(z.number()),
  type: z.enum(["issue", "pullRequest", "jiraIssue"]),
  source: z._default(z.enum(["github", "jira"]), "github"),
  repoFullName: z.string(),
  title: z.string(),
  addedAt: z.number(),
  jiraKey: z.optional(z.string()),
  jiraProjectKey: z.optional(z.string()),
  jiraStatus: z.optional(z.string()),
  htmlUrl: z.optional(z.string()),
});

export type TrackedItem = z.infer<typeof TrackedItemSchema>;

export const IgnoredItemSchema = z.object({
  id: z.coerce.number(),
  type: z.enum(["issue", "pullRequest", "workflowRun"]),
  repo: z.string(),
  title: z.string(),
  ignoredAt: z.number(),
});

export const IssueFiltersSchema = z.object({
  scope: z._default(z.enum(["involves_me", "all"]), "involves_me"),
  role: z._default(z.enum(["all", "author", "assignee"]), "all"),
  comments: z._default(z.enum(["all", "has", "none"]), "all"),
  user: z._default(z.union([z.enum(["all"]), z.string()]), "all"),
});

export const PullRequestFiltersSchema = z.object({
  scope: z._default(z.enum(["involves_me", "all"]), "involves_me"),
  role: z._default(z.enum(["all", "author", "reviewer", "assignee"]), "all"),
  reviewDecision: z._default(z.enum(["all", "APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED", "mergeable"]), "all"),
  draft: z._default(z.enum(["all", "draft", "ready"]), "all"),
  checkStatus: z._default(z.enum(["all", "success", "failure", "running", "waiting", "pending", "conflict", "blocked", "none"]), "all"),
  sizeCategory: z._default(z.enum(["all", "XS", "S", "M", "L", "XL", "XXL"]), "all"),
  user: z._default(z.union([z.enum(["all"]), z.string()]), "all"),
});

export const ActionsFiltersSchema = z.object({
  conclusion: z._default(z.enum(["all", "success", "failure", "cancelled", "running", "waiting", "pending", "other"]), "all"),
  event: z._default(z.enum(["all", "push", "pull_request", "schedule", "workflow_dispatch", "other"]), "all"),
});

export const DependencyFiltersSchema = z.object({
  updateType: z._default(z.enum(["all", "major", "minor", "patch", "pin", "digest", "maintenance", "other"]), "all"),
  bot: z._default(z.string(), "all"),
});

export type DependencyFilters = z.infer<typeof DependencyFiltersSchema>;
export type DependencyFilterField = keyof DependencyFilters;

// "done" intentionally excluded — JQL `statusCategory != Done` never returns Done items
export const JiraFiltersSchema = z.object({
  scope: z._default(
    z.union([
      z.enum(["assigned", "reported", "watching"]),
      z.string().check(z.regex(/^[a-zA-Z0-9_-]+$/), z.maxLength(100)),
    ]),
    "assigned"
  ),
  statusCategory: z._default(z.enum(["all", "new", "indeterminate"]), "all"),
  priority: z._default(z.enum(["all", "Highest", "High", "Medium", "Low", "Lowest"]), "all"),
  sortField: z._default(z.string(), JIRA_CUSTOM_SORT_FIELD),
  sortDirection: z._default(z.enum(["asc", "desc"]), "asc"),
});

export type IssueFilters = z.infer<typeof IssueFiltersSchema>;
export type IssueFilterField = keyof IssueFilters;
export type PullRequestFilters = z.infer<typeof PullRequestFiltersSchema>;
export type PullRequestFilterField = keyof PullRequestFilters;
export type ActionsFilters = z.infer<typeof ActionsFiltersSchema>;
export type ActionsFilterField = keyof ActionsFilters;
export type JiraFilters = z.infer<typeof JiraFiltersSchema>;
export type JiraFilterField = keyof JiraFilters;

export const ViewStateSchema = z.object({
  lastActiveTab: z._default(z.string(), "issues"),
  globalSort: z._default(
    z.object({
      field: z.string(),
      direction: z.enum(["asc", "desc"]),
    }),
    { field: "updatedAt", direction: "desc" }
  ),
  ignoredItems: z._default(
    z.array(IgnoredItemSchema).check(z.maxLength(IGNORED_ITEMS_CAP)),
    []
  ),
  globalFilter: z._default(
    z.object({
      org: z._default(z.nullable(z.string()), null),
      repo: z._default(z.nullable(z.string()), null),
    }),
    { org: null, repo: null }
  ),
  tabFilters: z._default(
    z.object({
      issues: z._default(IssueFiltersSchema, { scope: "involves_me", role: "all", comments: "all", user: "all" }),
      pullRequests: z._default(PullRequestFiltersSchema, { scope: "involves_me", role: "all", reviewDecision: "all", draft: "all", checkStatus: "all", sizeCategory: "all", user: "all" }),
      actions: z._default(ActionsFiltersSchema, { conclusion: "all", event: "all" }),
      jiraAssigned: z._default(JiraFiltersSchema, { scope: "assigned", statusCategory: "all", priority: "all", sortField: JIRA_CUSTOM_SORT_FIELD, sortDirection: "asc" }),
      dependencies: z._default(DependencyFiltersSchema, { updateType: "all", bot: "all" }),
    }),
    {
      issues: { scope: "involves_me", role: "all", comments: "all", user: "all" },
      pullRequests: { scope: "involves_me", role: "all", reviewDecision: "all", draft: "all", checkStatus: "all", sizeCategory: "all", user: "all" },
      actions: { conclusion: "all", event: "all" },
      jiraAssigned: { scope: "assigned", statusCategory: "all", priority: "all", sortField: JIRA_CUSTOM_SORT_FIELD, sortDirection: "asc" },
      dependencies: { updateType: "all", bot: "all" },
    }
  ),
  showPrRuns: z._default(z.boolean(), false),
  hideDepDashboard: z._default(z.boolean(), true),
  customTabFilters: z._default(
    z.record(
      z.string(),
      z.record(z.string(), z.string()).check(
        z.refine((v) => Object.keys(v).length <= PERSISTED_LIMITS.customTabFiltersFields, {
          message: `Too many filter fields for a single tab (max ${PERSISTED_LIMITS.customTabFiltersFields})`,
        })
      )
    ).check(
      z.refine((v) => Object.keys(v).length <= PERSISTED_LIMITS.customTabFiltersTabs, {
        message: `Too many tabs with saved filters (max ${PERSISTED_LIMITS.customTabFiltersTabs})`,
      })
    ),
    {}
  ),
  expandedRepos: z._default(
    z.record(
      z.string(),
      z._default(
        z.record(z.string(), z.boolean()).check(
          z.refine((v) => Object.keys(v).length <= PERSISTED_LIMITS.expandedReposRepos, {
            message: `Too many expanded repos for a single tab (max ${PERSISTED_LIMITS.expandedReposRepos})`,
          })
        ),
        {}
      )
    ).check(
      z.refine((v) => Object.keys(v).length <= PERSISTED_LIMITS.expandedReposTabs, {
        message: `Too many tabs with expanded-repo state (max ${PERSISTED_LIMITS.expandedReposTabs})`,
      })
    ),
    {
      issues: {},
      pullRequests: {},
      actions: {},
      jiraAssigned: {},
    }
  ),
  // Per-tab default expand state. A repo with no entry in `expandedRepos[tab]` follows
  // this default (a tab with no entry here defaults to collapsed). Expand All / Collapse
  // All set this default so repos that appear later inherit it; a manual per-repo toggle
  // records an exception in `expandedRepos[tab]`. Jira project groups default to expanded.
  expandDefault: z._default(z.record(z.string(), z.boolean()), { jiraAssigned: true }),
  lockedRepos: z._default(
    z.record(
      z.string(),
      z.array(z.string().check(z.maxLength(200))).check(z.maxLength(LOCKED_REPOS_CAP))
    ),
    { issues: [], pullRequests: [], actions: [], jiraAssigned: [] }
  ),
  trackedItems: z._default(z.array(TrackedItemSchema).check(z.maxLength(TRACKED_ITEMS_CAP)), []),
  dependencyExpandedGroups: z._default(z.array(z.string()), ["mergeable"]),
  jiraCustomOrder: z.pipe(
    z._default(
      z.array(z.string().check(z.maxLength(JIRA_CUSTOM_ORDER_KEY_MAX_LENGTH))).check(z.maxLength(JIRA_CUSTOM_ORDER_CAP)),
      []
    ),
    z.transform((arr) => [...new Set(arr)])
  ),
});

export type ViewState = z.infer<typeof ViewStateSchema>;
export type IgnoredItem = ViewState["ignoredItems"][number];
