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
    script.async = true;
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

export async function acquireTurnstileToken(siteKey: string): Promise<string> {
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

    window.turnstile.ready(() => {
      if (settled) return;

      try {
        const widgetId = window.turnstile.render(container, {
          sitekey: siteKey,
          action: "seal",
          size: "invisible",
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
  const turnstileToken = await acquireTurnstileToken(siteKey ?? "");

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
