import { createSignal, onMount, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { setAuth, validateToken, clearAuth } from "../stores/auth";
import { OAUTH_STATE_KEY, OAUTH_RETURN_TO_KEY, sanitizeReturnTo } from "../lib/oauth";
import LoadingSpinner from "../components/shared/LoadingSpinner";

interface TokenResponse {
  access_token: string;
  token_type?: string;
  scope?: string;
  error?: string;
}

export default function OAuthCallback() {
  const navigate = useNavigate();
  const [error, setError] = createSignal<string | null>(null);

  onMount(async () => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const stateFromUrl = params.get("state");

    // Retrieve and immediately clear stored state (single-use, SDR-002)
    const storedState = sessionStorage.getItem(OAUTH_STATE_KEY);
    sessionStorage.removeItem(OAUTH_STATE_KEY);

    // Validate state before anything else (CSRF protection)
    if (!stateFromUrl || !storedState || stateFromUrl !== storedState) {
      setError("Invalid OAuth state. Please try signing in again.");
      console.info("[auth] OAuth state mismatch — possible CSRF attempt");
      return;
    }

    if (!code) {
      setError("No authorization code received from GitHub.");
      return;
    }

    try {
      const resp = await fetch("/api/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });

      const data = (await resp.json()) as TokenResponse;

      if (!resp.ok || data.error || typeof data.access_token !== "string") {
        setError("Failed to complete sign in. Please try again.");
        console.info("[auth] token exchange failed");
        return;
      }

      // Persist token and populate user signal via validateToken
      setAuth(data);
      console.info("[auth] token exchange succeeded");
      if (!(await validateToken())) {
        clearAuth();
        setError("Could not verify token. Please try again.");
        return;
      }

      // Read and clear returnTo only after successful auth (preserves it for retry on failure)
      const returnTo = sessionStorage.getItem(OAUTH_RETURN_TO_KEY);
      sessionStorage.removeItem(OAUTH_RETURN_TO_KEY);
      navigate(sanitizeReturnTo(returnTo), { replace: true });
    } catch {
      setError("A network error occurred. Please try again.");
    }
  });

  return (
    <div class="bg-base-200 min-h-screen flex items-center justify-center">
      <div class="max-w-sm w-full mx-4 text-center">
        <Show
          when={error()}
          fallback={
            <div class="card bg-base-100 shadow-md p-8 flex flex-col items-center gap-4">
              <LoadingSpinner size="md" label="Completing sign in..." />
            </div>
          }
        >
          <div class="card bg-base-100 shadow-md p-8 flex flex-col items-center gap-4">
            <p class="text-error font-medium">{error()}</p>
            <a
              href="/login"
              class="link link-primary text-sm"
            >
              Return to sign in
            </a>
          </div>
        </Show>
      </div>
    </div>
  );
}
