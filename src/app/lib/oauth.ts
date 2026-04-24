export const OAUTH_STATE_KEY = "github-tracker:oauth-state";
export const OAUTH_RETURN_TO_KEY = "github-tracker:oauth-return-to";
export const JIRA_OAUTH_STATE_KEY = "github-tracker:jira-oauth-state";

export function generateOAuthState(): string {
  const stateBytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...stateBytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

export function sanitizeReturnTo(returnTo: string | null): string {
  return returnTo && returnTo.startsWith("/") && !returnTo.startsWith("//")
    ? returnTo
    : "/";
}

export function buildAuthorizeUrl(options?: { returnTo?: string }): string {
  const clientId = import.meta.env.VITE_GITHUB_CLIENT_ID as string;
  const state = generateOAuthState();
  sessionStorage.setItem(OAUTH_STATE_KEY, state);
  if (options?.returnTo) {
    sessionStorage.setItem(OAUTH_RETURN_TO_KEY, options.returnTo);
  } else {
    // Clear any stale returnTo from a previous re-auth attempt
    sessionStorage.removeItem(OAUTH_RETURN_TO_KEY);
  }
  const redirectUri = `${window.location.origin}/oauth/callback`;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    // repo: read issues/PRs; read:org: list orgs; notifications: gate
    scope: "repo read:org notifications",
    state,
    prompt: "select_account",
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

const VALID_CLIENT_ID_RE = /^[A-Za-z0-9_-]+$/;

export function buildJiraAuthorizeUrl(): string {
  const clientId = import.meta.env.VITE_JIRA_CLIENT_ID as string | undefined;
  if (!clientId || !VALID_CLIENT_ID_RE.test(clientId)) {
    throw new Error("Invalid or missing VITE_JIRA_CLIENT_ID");
  }
  const state = generateOAuthState();
  sessionStorage.setItem(JIRA_OAUTH_STATE_KEY, state);
  const params = new URLSearchParams({
    audience: "api.atlassian.com",
    client_id: clientId,
    scope: "read:jira-work read:jira-user offline_access",
    redirect_uri: `${window.location.origin}/jira/callback`,
    state,
    response_type: "code",
    prompt: "consent",
  });
  return `https://auth.atlassian.com/authorize?${params.toString()}`;
}

/**
 * Links to the per-app authorization page where users can see org access
 * status and request access for orgs with OAuth restrictions enabled.
 */
export function buildOrgAccessUrl(): string {
  const clientId = import.meta.env.VITE_GITHUB_CLIENT_ID as string;
  if (!clientId || !VALID_CLIENT_ID_RE.test(clientId)) {
    throw new Error("Invalid VITE_GITHUB_CLIENT_ID");
  }
  return `https://github.com/settings/connections/applications/${clientId}`;
}
