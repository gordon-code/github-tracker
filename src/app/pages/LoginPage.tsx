export default function LoginPage() {
  function handleLogin() {
    const clientId = import.meta.env.VITE_GITHUB_CLIENT_ID as string;

    // Generate cryptographically random state for CSRF protection (SDR-002)
    const stateBytes = crypto.getRandomValues(new Uint8Array(16));
    const state = btoa(String.fromCharCode(...stateBytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");

    sessionStorage.setItem("github-tracker:oauth-state", state);

    const redirectUri = `${window.location.origin}/oauth/callback`;
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      // repo: read issues/PRs; read:org: list orgs; notifications: gate
      scope: "repo read:org notifications",
    });

    window.location.href = `https://github.com/login/oauth/authorize?${params.toString()}`;
  }

  return (
    <div class="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
      <div class="max-w-sm w-full mx-4">
        <div class="bg-white dark:bg-gray-800 rounded-xl shadow-md p-8 flex flex-col items-center gap-6">
          <div class="flex flex-col items-center gap-2">
            <h1 class="text-2xl font-bold text-gray-900 dark:text-gray-100">
              GitHub Tracker
            </h1>
            <p class="text-sm text-gray-500 dark:text-gray-400 text-center">
              Track issues, pull requests, and workflow runs across your GitHub
              repositories.
            </p>
          </div>

          <button
            onClick={handleLogin}
            class="w-full flex items-center justify-center gap-3 px-4 py-2.5 bg-gray-900 dark:bg-gray-700 text-white rounded-lg font-medium hover:bg-gray-700 dark:hover:bg-gray-600 transition-colors focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2"
          >
            <svg
              viewBox="0 0 16 16"
              class="w-5 h-5"
              aria-hidden="true"
              fill="currentColor"
            >
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
            Sign in with GitHub
          </button>
        </div>
      </div>
    </div>
  );
}
