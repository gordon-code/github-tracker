export const OAUTH_STATE_KEY = "github-tracker:oauth-state";
export const OAUTH_RETURN_TO_KEY = "github-tracker:oauth-return-to";

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
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

/**
 * Links to the user's Authorized OAuth Apps page where they can see per-org
 * access status and request access for orgs with OAuth restrictions enabled.
 *
 * OAuth Apps don't have per-org installation like GitHub Apps — access depends
 * on org restriction policies. Users can request access from this page.
 */
export function buildOrgAccessUrl(): string {
  return "https://github.com/settings/applications";
}
