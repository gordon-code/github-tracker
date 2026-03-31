import { createSignal, createEffect, onMount, Show, ErrorBoundary, lazy, type JSX } from "solid-js";
import { Router, Route, Navigate, useNavigate } from "@solidjs/router";
import { isAuthenticated, validateToken, AUTH_STORAGE_KEY } from "./stores/auth";
import { config, initConfigPersistence, resolveTheme } from "./stores/config";
import { initViewPersistence } from "./stores/view";
import { evictStaleEntries } from "./stores/cache";
import { initClientWatcher } from "./services/github";
import LoginPage from "./pages/LoginPage";
import OAuthCallback from "./pages/OAuthCallback";
import PrivacyPage from "./pages/PrivacyPage";

const DashboardPage = lazy(() => import("./components/dashboard/DashboardPage"));
const OnboardingWizard = lazy(() => import("./components/onboarding/OnboardingWizard"));
const SettingsPage = lazy(() => import("./components/settings/SettingsPage"));

function ChunkErrorFallback() {
  return (
    <div class="min-h-screen flex items-center justify-center bg-base-200">
      <div class="card bg-base-100 shadow-md p-8 flex flex-col items-center gap-4 max-w-sm">
        <p class="text-error font-medium">Failed to load page</p>
        <p class="text-sm text-base-content/60 text-center">
          A new version may have been deployed. Reloading should fix this.
        </p>
        <button
          type="button"
          class="btn btn-neutral"
          onClick={() => window.location.reload()}
        >
          Reload page
        </button>
      </div>
    </div>
  );
}

// Auth guard: redirects unauthenticated users to /login.
// On page load, validates the localStorage token with GitHub API.
function AuthGuard(props: { children: JSX.Element }) {
  const [validating, setValidating] = createSignal(true);
  const navigate = useNavigate();

  onMount(async () => {
    if (!isAuthenticated()) {
      await validateToken();
    }
    setValidating(false);
  });

  createEffect(() => {
    if (!validating() && !isAuthenticated()) {
      navigate("/login", { replace: true });
    }
  });

  return (
    <Show
      when={!validating()}
      fallback={
        <div class="min-h-screen flex items-center justify-center bg-base-200">
          <svg
            class="animate-spin h-8 w-8 text-base-content/40"
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
        </div>
      }
    >
      <Show when={isAuthenticated()}>{props.children}</Show>
    </Show>
  );
}

// Root route: redirect based on auth + onboarding state
function RootRedirect() {
  const [validating, setValidating] = createSignal(true);

  onMount(async () => {
    if (!isAuthenticated()) {
      await validateToken();
    }
    setValidating(false);
  });

  return (
    <Show
      when={!validating()}
      fallback={
        <div class="min-h-screen flex items-center justify-center bg-base-200">
          <svg
            class="animate-spin h-8 w-8 text-base-content/40"
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
        </div>
      }
    >
      {!isAuthenticated() ? (
        <Navigate href="/login" />
      ) : !config.onboardingComplete ? (
        <Navigate href="/onboarding" />
      ) : (
        <Navigate href="/dashboard" />
      )}
    </Show>
  );
}

export default function App() {
  createEffect(() => {
    document.documentElement.setAttribute("data-theme", resolveTheme(config.theme));
  });

  onMount(() => {
    // Listen for system theme changes so "auto" reacts immediately
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystemThemeChange = () => {
      if (config.theme === "auto") {
        document.documentElement.setAttribute("data-theme", resolveTheme("auto"));
      }
    };
    mq.addEventListener("change", onSystemThemeChange);

    // All reactive init functions must be called inside the component tree
    initConfigPersistence();
    initViewPersistence();
    initClientWatcher();
    evictStaleEntries(24 * 60 * 60 * 1000).catch(() => {
      // Non-fatal — stale eviction failure is acceptable
    });

    // Preload dashboard chunk in parallel with token validation to avoid
    // a sequential waterfall (validateToken → chunk fetch)
    if (localStorage.getItem?.(AUTH_STORAGE_KEY)) {
      void import("./components/dashboard/DashboardPage");
    }
  });

  return (
    <ErrorBoundary fallback={(err) => { console.error("[app] Route render failed:", err); return <ChunkErrorFallback />; }}>
      <Router>
        <Route path="/" component={RootRedirect} />
        <Route path="/login" component={LoginPage} />
        <Route path="/oauth/callback" component={OAuthCallback} />
        <Route path="/onboarding" component={() => <AuthGuard><OnboardingWizard /></AuthGuard>} />
        <Route path="/dashboard" component={() => <AuthGuard><DashboardPage /></AuthGuard>} />
        <Route path="/settings" component={() => <AuthGuard><SettingsPage /></AuthGuard>} />
        <Route path="/privacy" component={PrivacyPage} />
      </Router>
    </ErrorBoundary>
  );
}
