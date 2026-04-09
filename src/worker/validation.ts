export type ValidationResult = { ok: true } | { ok: false; code: string; status: number };

/**
 * Validates that the request Origin header matches the allowed origin exactly.
 * Strict equality only — prevents substring spoofing (e.g. evil.gh.gordoncode.dev).
 */
export function validateOrigin(request: Request, allowedOrigin: string): ValidationResult {
  const origin = request.headers.get("Origin");
  if (origin !== allowedOrigin) {
    return { ok: false, code: "origin_mismatch", status: 403 };
  }
  return { ok: true };
}

/**
 * Validates the Sec-Fetch-Site header for fetch metadata resource isolation policy.
 * - "same-origin" → allowed (from our SPA)
 * - absent → allowed (legacy browsers without Fetch Metadata support)
 * - anything else → rejected (cross-site, same-site, or direct navigation)
 */
export function validateFetchMetadata(request: Request): ValidationResult {
  const secFetchSite = request.headers.get("Sec-Fetch-Site");
  if (secFetchSite === null || secFetchSite === "same-origin") {
    return { ok: true };
  }
  return { ok: false, code: "cross_site_request", status: 403 };
}

/**
 * Validates the X-Requested-With custom header.
 * Requires value "fetch" — triggers CORS preflight for cross-origin requests,
 * blocking cross-origin form submissions and scripted attacks.
 */
export function validateCustomHeader(request: Request): ValidationResult {
  const value = request.headers.get("X-Requested-With");
  if (value !== "fetch") {
    return { ok: false, code: "missing_csrf_header", status: 403 };
  }
  return { ok: true };
}

/**
 * Validates the Content-Type header starts with the expected media type.
 * Case-insensitive comparison.
 */
export function validateContentType(request: Request, expected: string): ValidationResult {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!contentType.toLowerCase().startsWith(expected.toLowerCase())) {
    return { ok: false, code: "invalid_content_type", status: 415 };
  }
  return { ok: true };
}

const METHODS_REQUIRING_CONTENT_TYPE = new Set(["POST", "PUT", "PATCH"]);

/**
 * Composite validator that runs all checks in sequence for proxy routes.
 * Short-circuits on first failure.
 *
 * Checks run in order:
 * 1. Origin validation (always)
 * 2. Sec-Fetch-Site validation (always)
 * 3. Custom X-Requested-With header (always)
 * 4. Content-Type (POST/PUT/PATCH only — skipped for GET/HEAD/DELETE/OPTIONS)
 */
export function validateProxyRequest(
  request: Request,
  allowedOrigin: string
): ValidationResult {
  const originResult = validateOrigin(request, allowedOrigin);
  if (!originResult.ok) return originResult;

  const fetchMetaResult = validateFetchMetadata(request);
  if (!fetchMetaResult.ok) return fetchMetaResult;

  const customHeaderResult = validateCustomHeader(request);
  if (!customHeaderResult.ok) return customHeaderResult;

  if (METHODS_REQUIRING_CONTENT_TYPE.has(request.method)) {
    const contentTypeResult = validateContentType(request, "application/json");
    if (!contentTypeResult.ok) return contentTypeResult;
  }

  return { ok: true };
}
