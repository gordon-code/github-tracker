import { createSignal, createEffect, onMount, Show, type JSX } from "solid-js";
import { Router, Route, Navigate, useNavigate } from "@solidjs/router";
import { isAuthenticated, validateToken } from "./stores/auth";
import { config, initConfigPersistence } from "./stores/config";
import { initViewPersistence } from "./stores/view";
import { evictStaleEntries } from "./stores/cache";
import { initClientWatcher } from "./services/github";
import LoginPage from "./pages/LoginPage";
import OAuthCallback from "./pages/OAuthCallback";
import DashboardPage from "./components/dashboard/DashboardPage";
import OnboardingWizard from "./components/onboarding/OnboardingWizard";
import SettingsPage from "./components/settings/SettingsPage";
import PrivacyPage from "./pages/PrivacyPage";

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
            class="animate-spin h-8 w-8 text-gray-400"
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
            class="animate-spin h-8 w-8 text-gray-400"
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
    document.documentElement.setAttribute("data-theme", config.theme);
  });

  onMount(() => {
    // All reactive init functions must be called inside the component tree
    initConfigPersistence();
    initViewPersistence();
    initClientWatcher();
    evictStaleEntries(24 * 60 * 60 * 1000).catch(() => {
      // Non-fatal — stale eviction failure is acceptable
    });
  });

  return (
    <Router>
      <Route path="/" component={RootRedirect} />
      <Route path="/login" component={LoginPage} />
      <Route path="/oauth/callback" component={OAuthCallback} />
      <Route path="/onboarding" component={() => <AuthGuard><OnboardingWizard /></AuthGuard>} />
      <Route path="/dashboard" component={() => <AuthGuard><DashboardPage /></AuthGuard>} />
      <Route path="/settings" component={() => <AuthGuard><SettingsPage /></AuthGuard>} />
      <Route path="/privacy" component={PrivacyPage} />
    </Router>
  );
}
