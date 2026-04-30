import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Parses Cloudflare _headers file and returns headers for a given path pattern.
 * The file format is:
 *   /path-pattern
 *     Header-Name: value
 *     Header-Name2: value2
 */
function parseHeadersFile(content: string): Map<string, Map<string, string>> {
  const result = new Map<string, Map<string, string>>();
  let currentPath: string | null = null;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith("#")) continue;

    // Lines starting with / or * are path patterns
    if (/^[/*]/.test(line) && !line.startsWith("  ") && !line.startsWith("\t")) {
      currentPath = line.trim();
      result.set(currentPath, new Map());
    } else if (currentPath !== null && (line.startsWith("  ") || line.startsWith("\t"))) {
      const colonIdx = line.indexOf(":");
      if (colonIdx !== -1) {
        const name = line.slice(0, colonIdx).trim();
        const value = line.slice(colonIdx + 1).trim();
        result.get(currentPath)!.set(name, value);
      }
    }
  }

  return result;
}

/** Parse a CSP header value into a directive map. */
function parseCsp(cspValue: string): Map<string, string> {
  const directives = new Map<string, string>();
  for (const part of cspValue.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const spaceIdx = trimmed.indexOf(" ");
    if (spaceIdx === -1) {
      directives.set(trimmed, "");
    } else {
      directives.set(trimmed.slice(0, spaceIdx), trimmed.slice(spaceIdx + 1));
    }
  }
  return directives;
}

// ── _headers file tests ───────────────────────────────────────────────────────

describe("public/_headers CSP validation", () => {
  const headersPath = resolve(__dirname, "../../public/_headers");
  const headersContent = readFileSync(headersPath, "utf-8");
  const headersMap = parseHeadersFile(headersContent);

  // The wildcard path /* covers all pages
  // If not found, look for the root path
  function getCspForPath(path: string): string | undefined {
    const headers = headersMap.get(path);
    return headers?.get("Content-Security-Policy");
  }

  // Find the CSP from the wildcard entry (/*) since that's how Cloudflare Pages applies it
  const rawCsp = getCspForPath("/*") ?? getCspForPath("/");
  const csp = rawCsp ? parseCsp(rawCsp) : null;

  it("_headers file can be read and parsed", () => {
    expect(headersContent.length).toBeGreaterThan(0);
    expect(csp).not.toBeNull();
  });

  it("connect-src includes https://api.atlassian.com", () => {
    expect(csp).not.toBeNull();
    const connectSrc = csp!.get("connect-src") ?? "";
    expect(connectSrc).toContain("https://api.atlassian.com");
  });

  it("connect-src does NOT include https://auth.atlassian.com", () => {
    // auth.atlassian.com is only used for server-side OAuth — browser never fetch()es it
    // (OAuth consent is a page navigation; token exchange goes through Worker server-side)
    expect(csp).not.toBeNull();
    const connectSrc = csp!.get("connect-src") ?? "";
    expect(connectSrc).not.toContain("https://auth.atlassian.com");
  });

  it("connect-src still includes https://api.github.com (not accidentally removed)", () => {
    expect(csp).not.toBeNull();
    const connectSrc = csp!.get("connect-src") ?? "";
    expect(connectSrc).toContain("https://api.github.com");
  });

  it("connect-src includes 'self' (same-origin Worker calls)", () => {
    expect(csp).not.toBeNull();
    const connectSrc = csp!.get("connect-src") ?? "";
    expect(connectSrc).toContain("'self'");
  });

  it("default-src is 'none' (deny-by-default)", () => {
    expect(csp).not.toBeNull();
    const defaultSrc = csp!.get("default-src") ?? "";
    expect(defaultSrc).toContain("'none'");
  });

  it("frame-ancestors is 'none' (no embedding allowed)", () => {
    expect(csp).not.toBeNull();
    const frameAncestors = csp!.get("frame-ancestors") ?? "";
    expect(frameAncestors).toContain("'none'");
  });

  it("X-Content-Type-Options is nosniff", () => {
    const headers = headersMap.get("/*");
    expect(headers?.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("X-Frame-Options is DENY", () => {
    const headers = headersMap.get("/*");
    expect(headers?.get("X-Frame-Options")).toBe("DENY");
  });

  it("Strict-Transport-Security header is present", () => {
    const headers = headersMap.get("/*");
    const hsts = headers?.get("Strict-Transport-Security") ?? "";
    expect(hsts).toContain("max-age=");
    expect(hsts).toContain("includeSubDomains");
  });
});
