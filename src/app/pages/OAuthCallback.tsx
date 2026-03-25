import { createSignal, onMount } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { setAuth, validateToken, clearAuth } from "../stores/auth";
import { OAUTH_STATE_KEY, OAUTH_RETURN_TO_KEY } from "../lib/oauth";

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

    // Read and clear returnTo before CSRF check — always consumed, even on failure
    const returnTo = sessionStorage.getItem(OAUTH_RETURN_TO_KEY);
    sessionStorage.removeItem(OAUTH_RETURN_TO_KEY);

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

      // Only allow internal paths (prevent open redirect)
      const target =
        returnTo && returnTo.startsWith("/") && !returnTo.startsWith("//")
          ? returnTo
          : "/";
      navigate(target, { replace: true });
    } catch {
      setError("A network error occurred. Please try again.");
    }
  });

  return (
    <div class="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
      <div class="max-w-sm w-full mx-4 text-center">
        {error() ? (
          <div class="bg-white dark:bg-gray-800 rounded-xl shadow-md p-8 flex flex-col items-center gap-4">
            <p class="text-red-600 dark:text-red-400 font-medium">{error()}</p>
            <a
              href="/login"
              class="text-sm text-blue-600 dark:text-blue-400 hover:underline"
            >
              Return to sign in
            </a>
          </div>
        ) : (
          <div class="bg-white dark:bg-gray-800 rounded-xl shadow-md p-8 flex flex-col items-center gap-4">
            <svg
              class="animate-spin h-8 w-8 text-gray-500"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              aria-label="Loading"
            >
              <circle
                class="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                stroke-width="4"
              />
              <path
                class="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
            <p class="text-gray-600 dark:text-gray-400">
              Completing sign in...
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
