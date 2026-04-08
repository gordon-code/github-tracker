// ── Shared validation constants ───────────────────────────────────────────────
// Browser-agnostic regex and constants used by both SPA and MCP server.

export const VALID_REPO_NAME = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;

// Allows alphanumeric/hyphen base (1-39 chars) with optional literal [bot] suffix for GitHub
// App bot accounts. Case-sensitive [bot] is intentional — GitHub always uses lowercase.
export const VALID_TRACKED_LOGIN = /^[A-Za-z0-9-]{1,39}(\[bot\])?$/;

export const SEARCH_RESULT_CAP = 1000;
