import { createSignal, createEffect, on, onMount, onCleanup, getOwner, runWithOwner, Show, ErrorBoundary, Suspense, type JSX } from "solid-js";
import { reportBoundaryError } from "./lib/sentry-facade";
import { lazyWithReload } from "./lib/chunk-reload";
import { startVersionWatch } from "./lib/version";
import { Router, Route, Navigate, useNavigate } from "@solidjs/router";
import { isAuthenticated, validateToken, AUTH_STORAGE_KEY } from "./stores/auth";
import { config, initConfigPersistence, resolveTheme } from "./stores/config";
import { initViewPersistence, pruneStaleIgnoredItems } from "./stores/view";
import { evictStaleEntries, evictKeysWithPrefix } from "./stores/cache";
import UpdateBanner from "./components/shared/UpdateBanner";
import UpdateNavigator from "./components/shared/UpdateNavigator";
import LoginPage from "./pages/LoginPage";
import OAuthCallback from "./pages/OAuthCallback";
import JiraCallback from "./pages/JiraCallback";
import PrivacyPage from "./pages/PrivacyPage";

let authInitStarted = false;
let authInitGen = 0;

/** @internal Test-only reset helper for authInitStarted across App renders */
export function _resetAuthInitStartedForTests(): void {
  authInitStarted = false;
  authInitGen++;
}

const DashboardPage = lazyWithReload(() => import("./components/dashboard/DashboardPage"));
const OnboardingWizard = lazyWithReload(() => import("./components/onboarding/OnboardingWizard"));
const SettingsPage = lazyWithReload(() => import("./components/settings/SettingsPage"));

function handleRouteError(err: unknown) {
  console.error("[app] Route render failed:", err);
  return <ChunkErrorFallback />;
}

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
  const appOwner = getOwner();
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });

  createEffect(
    on(isAuthenticated, (authed) => {
      if (!authed || authInitStarted) return;
      authInitStarted = true;
      const capturedGen = authInitGen;
      void Promise.all([import("./services/github"), import("./lib/mcp-relay")])
        .then(([gh, relay]) => {
          if (disposed || capturedGen !== authInitGen) return undefined;
          return runWithOwner(appOwner, () => {
            gh.initClientWatcher();
            relay.initMcpRelay();
          });
        })
        .catch(() => {
          // Non-fatal — dynamic import failure or test environment teardown
          if (!disposed && capturedGen === authInitGen) {
            authInitStarted = false;
          }
        });
    }),
  );

  createEffect(() => {
    document.documentElement.setAttribute("data-theme", resolveTheme(config.theme));
  });

  createEffect(() => {
    document.documentElement.dataset.density = config.viewDensity;
  });

  createEffect(
    on(
      () => config.selectedRepos.map((r) => r.fullName).join(","),
      (currentCsv, prevCsv) => {
        if (!prevCsv) return;
        const currentSet = new Set(currentCsv.split(",").filter(Boolean));
        const removed = prevCsv
          .split(",")
          .filter((r) => r.length > 0 && !currentSet.has(r));
        if (removed.length > 0) {
          evictKeysWithPrefix(removed.flatMap((r) => [`runs2:${r}:`, `run:${r}:`])).catch(() => {
            // Non-fatal — cache eviction failure is acceptable
          });
        }
      },
    ),
  );

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
    pruneStaleIgnoredItems();
    const stopVersionWatch = startVersionWatch();
    onCleanup(stopVersionWatch);

    const staleCacheMaxAgeMs = 24 * 60 * 60 * 1000;
    const staleEvictionIntervalMs = 60 * 60 * 1000;
    evictStaleEntries(staleCacheMaxAgeMs).catch(() => {
      // Non-fatal — stale eviction failure is acceptable
    });
    const evictionInterval = setInterval(() => {
      evictStaleEntries(staleCacheMaxAgeMs).catch(() => {
        // Non-fatal — stale eviction failure is acceptable
      });
    }, staleEvictionIntervalMs);
    onCleanup(() => {
      clearInterval(evictionInterval);
    });

    // Preload dashboard chunk in parallel with token validation to avoid
    // a sequential waterfall (validateToken → chunk fetch)
    if (localStorage.getItem?.(AUTH_STORAGE_KEY)) {
      import("./components/dashboard/DashboardPage").catch(() => {
        console.warn("[app] Dashboard chunk preload failed");
      });
    }
  });

  return (
    <ErrorBoundary
      fallback={(err) => {
        reportBoundaryError(err);
        return handleRouteError(err);
      }}
    >
      <UpdateBanner />
      <Suspense fallback={
        <div class="min-h-screen flex items-center justify-center bg-base-200">
          <span class="loading loading-spinner loading-lg" aria-label="Loading" />
        </div>
      }>
        <Router root={(props) => <><UpdateNavigator />{props.children}</>}>
          <Route path="/" component={RootRedirect} />
          <Route path="/login" component={LoginPage} />
          <Route path="/oauth/callback" component={OAuthCallback} />
          <Route path="/jira/callback" component={JiraCallback} />
          <Route path="/onboarding" component={() => <AuthGuard><OnboardingWizard /></AuthGuard>} />
          <Route path="/dashboard" component={() => <AuthGuard><DashboardPage /></AuthGuard>} />
          <Route path="/settings" component={() => <AuthGuard><SettingsPage /></AuthGuard>} />
          <Route path="/privacy" component={PrivacyPage} />
          <Route path="/*" component={() => <Navigate href="/" />} />
        </Router>
      </Suspense>
    </ErrorBoundary>
  );
}
