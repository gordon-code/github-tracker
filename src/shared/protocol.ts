// ── MCP protocol constants ────────────────────────────────────────────────────
// Method names and notification types for the GitHub Tracker MCP server.

export const METHODS = {
  GET_DASHBOARD_SUMMARY: "get_dashboard_summary",
  GET_OPEN_PRS: "get_open_prs",
  GET_OPEN_ISSUES: "get_open_issues",
  GET_FAILING_ACTIONS: "get_failing_actions",
  GET_PR_DETAILS: "get_pr_details",
  GET_RATE_LIMIT: "get_rate_limit",
  GET_CONFIG: "get_config",
  GET_REPOS: "get_repos",
} as const;

export const NOTIFICATIONS = {
  CONFIG_UPDATE: "config_update",
} as const;
