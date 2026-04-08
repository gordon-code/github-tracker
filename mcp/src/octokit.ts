import { Octokit } from "@octokit/core";
import { throttling } from "@octokit/plugin-throttling";
import { retry } from "@octokit/plugin-retry";
import { paginateRest } from "@octokit/plugin-paginate-rest";

// ── Plugin-extended Octokit class ────────────────────────────────────────────

const GitHubOctokit = Octokit.plugin(throttling, retry, paginateRest);

type GitHubOctokitInstance = InstanceType<typeof GitHubOctokit>;

// ── Client factory ───────────────────────────────────────────────────────────

export function createOctokitClient(token: string): GitHubOctokitInstance {
  const client = new GitHubOctokit({
    auth: token,
    userAgent: "github-tracker-mcp",
    throttle: {
      onRateLimit: (
        retryAfter: number,
        options: { method: string; url: string },
        _octokit: GitHubOctokitInstance,
        retryCount: number
      ) => {
        console.error(
          `[mcp] Rate limit hit for ${options.method} ${options.url}. Retry after ${retryAfter}s.`
        );
        return retryCount < 1;
      },
      onSecondaryRateLimit: (
        retryAfter: number,
        options: { method: string; url: string },
        _octokit: GitHubOctokitInstance,
        retryCount: number
      ) => {
        console.error(
          `[mcp] Secondary rate limit for ${options.method} ${options.url}. Retry after ${retryAfter}s.`
        );
        return retryCount < 1;
      },
    },
    retry: {
      retries: 2,
      // Include 429 to prevent double-handling with plugin-throttling
      doNotRetry: [400, 401, 403, 404, 410, 422, 429, 451],
    },
  });

  // Read-only guard: block any non-GET request except POST /graphql
  // (GraphQL queries are read-only but always use POST).
  client.hook.before("request", (options) => {
    const method = (options.method ?? "GET").toUpperCase();
    if (method === "GET") return;
    if (method === "POST" && options.url === "/graphql") return;
    throw new Error(
      `[mcp] Write operation blocked: ${method} ${options.url}. This server is read-only.`
    );
  });

  return client;
}

// ── Singleton management ─────────────────────────────────────────────────────

let _instance: GitHubOctokitInstance | null = null;

/**
 * Returns an Octokit instance if GITHUB_TOKEN is set, otherwise null.
 */
export function getOptionalOctokitClient(): GitHubOctokitInstance | null {
  if (_instance) return _instance;
  const token = process.env.GITHUB_TOKEN;
  if (!token) return null;
  _instance = createOctokitClient(token);
  return _instance;
}

/**
 * Returns an Octokit instance or throws if GITHUB_TOKEN is not set.
 */
export function getOctokitClient(): GitHubOctokitInstance {
  const client = getOptionalOctokitClient();
  if (!client) {
    throw new Error(
      "[mcp] GITHUB_TOKEN environment variable is required but not set."
    );
  }
  return client;
}

// ── Token scope validation ───────────────────────────────────────────────────

const REQUIRED_SCOPES = ["repo", "read:org"];

/**
 * Validates the token at startup by calling GET /user and inspecting x-oauth-scopes.
 * Logs a warning to stderr if required scopes are missing.
 * Returns true if validation passed, false if token is invalid.
 */
export async function validateTokenScopes(): Promise<boolean> {
  const client = getOptionalOctokitClient();
  if (!client) {
    console.error("[mcp] No GITHUB_TOKEN set — operating in unauthenticated mode.");
    return false;
  }

  try {
    const response = await client.request("GET /user");
    const login = String((response.data as { login?: string }).login ?? "unknown");
    const rawScopeHeader = (response.headers as Record<string, string | undefined>)["x-oauth-scopes"];

    if (rawScopeHeader === undefined) {
      // Fine-grained PAT — x-oauth-scopes header is not returned
      console.error(
        `[mcp] Token validated (fine-grained PAT). User: ${login}. ` +
          `Scope validation skipped — fine-grained PATs use repository/organization permissions instead of OAuth scopes.`
      );
    } else {
      const grantedScopes = rawScopeHeader
        .split(",")
        .map((s: string) => s.trim())
        .filter(Boolean);

      const missingScopes = REQUIRED_SCOPES.filter(
        (required) => !grantedScopes.includes(required)
      );

      if (missingScopes.length > 0) {
        console.error(
          `[mcp] Warning: token is missing required scopes: ${missingScopes.join(", ")}. ` +
            `Granted: ${grantedScopes.join(", ") || "(none)"}`
        );
      } else {
        console.error(
          `[mcp] Token validated. User: ${login}, Scopes: ${grantedScopes.join(", ")}`
        );
      }
    }

    return true;
  } catch (err) {
    console.error("[mcp] Token validation failed:", err instanceof Error ? err.message : String(err));
    return false;
  }
}
