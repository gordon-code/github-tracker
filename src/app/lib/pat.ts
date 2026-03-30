export function isValidPatFormat(token: string): { valid: boolean; error?: string } {
  const trimmed = token.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: "Please enter a token" };
  }

  const isClassic = trimmed.startsWith("ghp_");
  const isFineGrained = trimmed.startsWith("github_pat_");

  if (!isClassic && !isFineGrained) {
    return { valid: false, error: "Token should start with ghp_ (classic) or github_pat_ (fine-grained)" };
  }

  const prefix = isClassic ? "ghp_" : "github_pat_";
  const payload = trimmed.slice(prefix.length);

  if (!/^[A-Za-z0-9_]*$/.test(payload)) {
    return { valid: false, error: "Token contains invalid characters — check that you copied it correctly" };
  }

  const minLength = isClassic ? 40 : 47;
  if (trimmed.length < minLength) {
    return { valid: false, error: "Token appears truncated — check that you copied the full value" };
  }

  return { valid: true };
}

export const PAT_FINE_GRAINED_PERMISSIONS = {
  repository: [
    "Actions: Read-only",
    "Contents: Read-only",
    "Issues: Read-only",
    "Metadata: Read-only",
    "Pull requests: Read-only",
  ],
} as const;

// Fine-grained PATs cannot access the Notifications API (GET /notifications returns 403).
// The app gracefully handles this — the notifications gate auto-disables on 403.
export const PAT_FINE_GRAINED_NOTIFICATIONS_CAVEAT =
  "Fine-grained tokens cannot access notifications — the app will skip notification-based polling optimization and still function correctly.";

export const GITHUB_PAT_URL = "https://github.com/settings/tokens/new";
export const GITHUB_FINE_GRAINED_PAT_URL = "https://github.com/settings/personal-access-tokens/new";
