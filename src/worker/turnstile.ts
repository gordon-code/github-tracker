export interface TurnstileEnv {
  TURNSTILE_SECRET_KEY: string;
}

interface TurnstileResponse {
  success: boolean;
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
  env: TurnstileEnv
): Promise<{ success: boolean; errorCodes?: string[] }> {
  const body = new FormData();
  body.append("secret", env.TURNSTILE_SECRET_KEY);
  body.append("response", token);
  if (ip !== null) {
    body.append("remoteip", ip);
  }
  body.append("idempotency_key", crypto.randomUUID());

  let resp: Response;
  try {
    resp = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body,
      redirect: "error",
    });
  } catch {
    return { success: false, errorCodes: ["network-error"] };
  }

  let data: TurnstileResponse;
  try {
    data = (await resp.json()) as TurnstileResponse;
  } catch {
    return { success: false, errorCodes: ["network-error"] };
  }

  if (data.success) {
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
