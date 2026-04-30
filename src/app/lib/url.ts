/**
 * Validates that a URL points to GitHub before opening it.
 * Uses URL constructor for proper hostname parsing.
 * Defense-in-depth against tampered cache data.
 */
export function isSafeGitHubUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "github.com";
  } catch {
    return false;
  }
}

const ATLASSIAN_HOST_RE = /^[a-z0-9-]+\.atlassian\.net$/i;

export function isSafeJiraSiteUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && ATLASSIAN_HOST_RE.test(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Opens a GitHub URL in a new tab after validation.
 * No-ops for non-GitHub URLs.
 */
export function openGitHubUrl(url: string): void {
  if (!isSafeGitHubUrl(url)) return;
  window.open(url, "_blank", "noopener,noreferrer");
}
