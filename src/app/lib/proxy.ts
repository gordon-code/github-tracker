// SPA-side proxy utilities: Turnstile script loader, token acquisition,
// sealed-token helper, and proxyFetch wrapper.

const TURNSTILE_SCRIPT_URL =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

let turnstilePromise: Promise<void> | null = null;

function loadTurnstileScript(): Promise<void> {
  if (turnstilePromise !== null) {
    return turnstilePromise;
  }
  turnstilePromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = TURNSTILE_SCRIPT_URL;
    script.onload = () => resolve();
    script.onerror = () => {
      script.remove();
      turnstilePromise = null;
      reject(new Error("Failed to load Turnstile script"));
    };
    document.head.appendChild(script);
  });
  return turnstilePromise;
}

export async function acquireTurnstileToken(siteKey: string, action: string): Promise<string> {
  if (!siteKey) {
    throw new Error("VITE_TURNSTILE_SITE_KEY not configured");
  }

  await loadTurnstileScript();

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let currentWidgetId: string | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const container = document.createElement("div");
    container.style.cssText =
      "position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 9999; min-width: 300px; min-height: 65px;";
    document.body.appendChild(container);

    const cleanup = () => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
      if (currentWidgetId !== null) {
        try { window.turnstile.remove(currentWidgetId); } catch { /* widget already gone */ }
      }
      container.remove();
    };

    timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Turnstile challenge timed out after 30 seconds"));
    }, 30_000);

    try {
      const widgetId = window.turnstile.render(container, {
        sitekey: siteKey,
        action,
        size: "compact",
        execution: "execute",
        retry: "never",
        callback: (token: string) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(token);
        },
        "error-callback": (errorCode: string) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error(`Turnstile error: ${errorCode}`));
        },
        "expired-callback": () => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error("Turnstile token expired before submission"));
        },
        "timeout-callback": () => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error("Turnstile challenge timed out"));
        },
      });
      currentWidgetId = widgetId;
      window.turnstile.execute(widgetId);
    } catch (err) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err instanceof Error ? err : new Error("Turnstile render failed"));
    }
  });
}

export async function proxyFetch(
  path: string,
  options?: RequestInit,
): Promise<Response> {
  const defaultHeaders: Record<string, string> = {
    "Content-Type": "application/json",
  };

  const callerHeaders =
    options?.headers instanceof Headers
      ? Object.fromEntries(options.headers.entries())
      : (options?.headers as Record<string, string> | undefined) ?? {};

  const mergedHeaders = {
    ...defaultHeaders,
    ...callerHeaders,
    // Always override — callers must not be able to spoof this header.
    "X-Requested-With": "fetch",
  };

  return fetch(path, {
    ...options,
    headers: mergedHeaders,
  });
}

export class SealError extends Error {
  readonly status: number;

  constructor(status: number, code: string) {
    super(code);
    this.name = "SealError";
    this.status = status;
  }
}

export async function sealApiToken(token: string, purpose: string): Promise<string> {
  const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;
  const turnstileToken = await acquireTurnstileToken(siteKey ?? "", "seal");

  const res = await proxyFetch("/api/proxy/seal", {
    method: "POST",
    headers: {
      "cf-turnstile-response": turnstileToken,
    },
    body: JSON.stringify({ token, purpose }),
  });

  if (!res.ok) {
    let code = "unknown_error";
    try {
      const body = (await res.json()) as { error?: string };
      code = body.error ?? code;
    } catch {
      // ignore parse errors — keep default code
    }
    throw new SealError(res.status, code);
  }

  const data = (await res.json()) as { sealed: string };
  return data.sealed;
}

// The purpose-specific inner-ciphertext cap the Worker enforces for
// "credential-export-bundle" seals (src/worker/index.ts). Checked client-side
// so an oversized bundle fails fast with a clear error instead of a generic 400.
export const CREDENTIAL_BUNDLE_MAX_CIPHERTEXT = 4096;

/**
 * Seals a client-side envelope ciphertext (already encrypted with the one-time
 * code — encrypt-THEN-seal) under the `credential-export-bundle` purpose.
 * Mirrors `sealApiToken()` but with a distinct purpose and a client-side size
 * pre-check. Uses `proxyFetch()` so the `X-Requested-With` CSRF header is set.
 */
export async function sealCredentialBundle(ciphertext: string): Promise<string> {
  if (ciphertext.length > CREDENTIAL_BUNDLE_MAX_CIPHERTEXT) {
    throw new Error(
      "Credentials are too large to export securely. Please report this — it should not happen for a normal account."
    );
  }
  const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;
  const turnstileToken = await acquireTurnstileToken(siteKey ?? "", "seal");

  const res = await proxyFetch("/api/proxy/seal", {
    method: "POST",
    headers: {
      "cf-turnstile-response": turnstileToken,
    },
    body: JSON.stringify({ token: ciphertext, purpose: "credential-export-bundle" }),
  });

  if (!res.ok) {
    let code = "unknown_error";
    try {
      const body = (await res.json()) as { error?: string };
      code = body.error ?? code;
    } catch {
      // ignore parse errors — keep default code
    }
    throw new SealError(res.status, code);
  }

  const data = (await res.json()) as { sealed: string };
  return data.sealed;
}

/**
 * Unseals a credential-export-bundle blob via the pre-auth-reachable
 * `/api/proxy/unseal` endpoint. Returns the still-code-encrypted inner
 * ciphertext (never plaintext credentials — encrypt-then-seal design).
 *
 * SINGLE-USE: the endpoint consumes the bundle's nonce server-side on the first
 * successful unseal, so callers MUST call this exactly once per bundle, cache the
 * returned `ciphertext`, and run any wrong-code retries against the cache via
 * `resolveImportedCredentials()` — re-calling this on a retry burns the bundle.
 *
 * MUST use `proxyFetch()` (sets `X-Requested-With`); a raw fetch would be
 * rejected with `403 missing_csrf_header`. Only `expired` is distinguished from
 * the uniform `invalid` failure among SERVER responses (per the endpoint's
 * contract). A `turnstile` reason is distinct from both: it signals a CLIENT-side
 * Turnstile-acquisition failure that happened BEFORE any request reached the
 * server, so the bundle's single-use nonce was NOT consumed and the whole unseal
 * is safely retryable (R-101) — callers must treat it as non-terminal.
 */
export async function unsealCredentialBundle(
  sealed: string
): Promise<
  | { ok: true; ciphertext: string }
  | { ok: false; reason: "expired" | "invalid" | "turnstile" }
> {
  const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;
  let turnstileToken: string;
  try {
    turnstileToken = await acquireTurnstileToken(siteKey ?? "", "unseal");
  } catch {
    // Acquisition threw (widget hiccup/timeout/missing key) BEFORE any network
    // request — the server nonce is untouched and the bundle is still valid.
    // Return a DISTINCT retryable result, NOT the terminal `invalid` (R-101).
    return { ok: false, reason: "turnstile" };
  }

  let res: Response;
  try {
    res = await proxyFetch("/api/proxy/unseal", {
      method: "POST",
      headers: {
        "cf-turnstile-response": turnstileToken,
      },
      body: JSON.stringify({ sealed, purpose: "credential-export-bundle" }),
    });
  } catch {
    return { ok: false, reason: "invalid" };
  }

  if (res.ok) {
    try {
      const data = (await res.json()) as { payload?: unknown };
      if (typeof data.payload === "string") {
        return { ok: true, ciphertext: data.payload };
      }
    } catch {
      // fall through to invalid
    }
    return { ok: false, reason: "invalid" };
  }

  try {
    const body = (await res.json()) as { error?: string };
    if (body.error === "expired") return { ok: false, reason: "expired" };
  } catch {
    // fall through to invalid
  }
  return { ok: false, reason: "invalid" };
}
