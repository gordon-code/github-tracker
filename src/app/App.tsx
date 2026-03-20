import { createSignal, onMount, Show } from "solid-js";
import { Router, Route } from "@solidjs/router";
import { token, isAuthenticated, validateToken } from "./stores/auth";
import { config, initConfigPersistence } from "./stores/config";
import { initViewPersistence } from "./stores/view";
import { evictStaleEntries } from "./stores/cache";
import { initClientWatcher } from "./services/github";
import LoginPage from "./pages/LoginPage";
import OAuthCallback from "./pages/OAuthCallback";
import DashboardPage from "./components/dashboard/DashboardPage";
import OnboardingWizard from "./components/onboarding/OnboardingWizard";

function SettingsPlaceholder() {
  return (
    <div class="p-8 text-gray-900 dark:text-gray-100">
      <h1 class="text-2xl font-bold">Settings</h1>
      <p class="mt-2 text-gray-500">Settings page coming soon (Task 17).</p>
    </div>
  );
}

// Root route: redirect based on auth + onboarding state
function RootRedirect() {
  const [validating, setValidating] = createSignal(true);

  onMount(async () => {
    if (token()) {
      await validateToken();
    }
    setValidating(false);
  });

  return (
    <Show
      when={!validating()}
      fallback={
        <div class="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
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
      {(() => {
        if (!isAuthenticated()) {
          window.location.replace("/login");
          return null;
        }
        if (!config.onboardingComplete) {
          window.location.replace("/onboarding");
          return null;
        }
        window.location.replace("/dashboard");
        return null;
      })()}
    </Show>
  );
}

export default function App() {
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
      <Route path="/onboarding" component={OnboardingWizard} />
      <Route path="/dashboard" component={DashboardPage} />
      <Route path="/settings" component={SettingsPlaceholder} />
    </Router>
  );
}
