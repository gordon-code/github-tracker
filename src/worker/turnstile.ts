export interface TurnstileEnv {
  TURNSTILE_SECRET_KEY: string;
}

interface TurnstileResponse {
  success: boolean;
  action?: string;
  "error-codes"?: string[];
}

/**
 * Verifies a Turnstile challenge token by calling the Cloudflare siteverify API.
 *
 * - Uses redirect: "error" to prevent SSRF via redirect chaining.
 * - Includes idempotency_key to deduplicate processing on network-timeout retries.
 *   Note: tokens are single-use — once verified, the token is consumed. Do NOT
 *   retry this function on failure; return 403 and require the SPA to get a new token.
 * - Omits remoteip field when ip is null.
 */
export async function verifyTurnstile(
  token: string,
  ip: string | null,
  env: TurnstileEnv,
  expectedAction?: string
): Promise<{ success: boolean; errorCodes?: string[] }> {
  const body = new FormData();
  body.append("secret", env.TURNSTILE_SECRET_KEY);
  body.append("response", token);
  if (ip !== null) {
    body.append("remoteip", ip);
  }
  body.append("idempotency_key", crypto.randomUUID());

  let resp: Response;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  try {
    resp = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body,
      redirect: "error",
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { success: false, errorCodes: ["timeout"] };
    }
    return { success: false, errorCodes: ["network-error"] };
  } finally {
    clearTimeout(timeoutId);
  }

  let data: TurnstileResponse;
  try {
    data = (await resp.json()) as TurnstileResponse;
  } catch {
    return { success: false, errorCodes: ["network-error"] };
  }

  if (data.success) {
    if (expectedAction !== undefined && data.action !== expectedAction) {
      return { success: false, errorCodes: ["action-mismatch"] };
    }
    return { success: true };
  }

  return { success: false, errorCodes: data["error-codes"] ?? [] };
}

/**
 * Extracts the Turnstile response token from the cf-turnstile-response request header.
 * Returns null if the header is absent.
 */
export function extractTurnstileToken(request: Request): string | null {
  return request.headers.get("cf-turnstile-response");
}
