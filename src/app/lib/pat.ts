export type PatValidationResult =
  | { valid: true }
  | { valid: false; error: string };

export function isValidPatFormat(token: string): PatValidationResult {
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

  // Classic PATs are exactly 40 chars. Fine-grained PATs are ~93 chars;
  // use 80 as a safe lower bound to catch clearly truncated tokens.
  const minLength = isClassic ? 40 : 80;
  if (trimmed.length < minLength) {
    return { valid: false, error: "Token appears truncated — check that you copied the full value" };
  }

  return { valid: true };
}

export const GITHUB_PAT_URL = "https://github.com/settings/tokens/new";
export const GITHUB_FINE_GRAINED_PAT_URL = "https://github.com/settings/personal-access-tokens/new";
