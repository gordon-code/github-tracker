// ── Shared validation constants ───────────────────────────────────────────────
// Browser-agnostic regex and constants used by both SPA and MCP server.

export const VALID_REPO_NAME = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;

// Allows alphanumeric/hyphen base (1-39 chars) with optional literal [bot] suffix for GitHub
// App bot accounts. Case-sensitive [bot] is intentional — GitHub always uses lowercase.
export const VALID_TRACKED_LOGIN = /^[A-Za-z0-9-]{1,39}(\[bot\])?$/;

export const SEARCH_RESULT_CAP = 1000;

export const APPROVE_PR_MUTATION = `
  mutation ApprovePullRequest($pullRequestId: ID!, $commitOID: GitObjectID!) {
    addPullRequestReview(input: { pullRequestId: $pullRequestId, commitOID: $commitOID, event: APPROVE }) {
      pullRequestReview {
        state
        pullRequest {
          reviewDecision
        }
      }
    }
  }
`.trim();

export const MARK_PR_READY_MUTATION = `
  mutation MarkPullRequestReadyForReview($pullRequestId: ID!) {
    markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
      pullRequest {
        isDraft
        reviewDecision
      }
    }
  }
`.trim();

export const GITHUB_NODE_ID_RE = /^(?:PR_[A-Za-z0-9_-]{4,120}|[A-Za-z0-9+/=_-]{8,128})$/;
export const GIT_SHA_RE = /^[0-9a-f]{40}$/i;

export function isReadOnlyGraphqlQuery(query: unknown): boolean {
  if (typeof query !== "string") return false;
  // Strip block strings, single-line strings, and # comments in a single left-to-right pass
  const sanitized = query
    .replace(/"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|#[^\r\n]*/g, (m) => (m.startsWith("#") ? "" : '""'))
    .trim();
  if (!sanitized) return false;
  if (!/^(?:query\b|\{)/i.test(sanitized)) return false;
  return !/\b(?:mutation|subscription)\b/i.test(sanitized);
}

// ── Jira key detection ────────────────────────────────────────────────────────

const JIRA_KEY_REGEX = /\b([A-Z]{2,10}-\d+)\b/g;

export function extractJiraKeys(text: string): string[] {
  JIRA_KEY_REGEX.lastIndex = 0;
  return [...new Set(Array.from(text.matchAll(JIRA_KEY_REGEX), (m) => m[1]))];
}
