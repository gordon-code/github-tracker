export default function PrivacyPage() {
  return (
    <div class="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div class="mx-auto max-w-2xl px-4 py-12">
        <a
          href="/dashboard"
          class="text-sm text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
        >
          &larr; Back to dashboard
        </a>

        <h1 class="mt-6 text-2xl font-bold text-gray-900 dark:text-gray-100">
          Privacy Policy
        </h1>

        <div class="mt-6 space-y-4 text-sm text-gray-600 dark:text-gray-400 leading-relaxed">
          <p>
            GitHub Tracker does not collect, store, or transmit any personal
            data. All data stays in your browser.
          </p>

          <h2 class="text-base font-semibold text-gray-900 dark:text-gray-100 pt-2">
            What we store
          </h2>
          <ul class="list-disc pl-5 space-y-1">
            <li>
              <strong>localStorage</strong> — your settings (selected orgs,
              repos, theme, etc.) and view state (tab filters, sort order).
            </li>
            <li>
              <strong>IndexedDB</strong> — cached API responses with ETags to
              reduce GitHub API usage. Cleared on logout.
            </li>
            <li>
              <strong>localStorage</strong> — your OAuth access token, used to
              authenticate GitHub API requests. Cleared on logout.
            </li>
          </ul>

          <h2 class="text-base font-semibold text-gray-900 dark:text-gray-100 pt-2">
            What we don't do
          </h2>
          <ul class="list-disc pl-5 space-y-1">
            <li>No analytics or tracking scripts</li>
            <li>No server-side data storage</li>
            <li>No third-party data sharing</li>
            <li>No cookies</li>
          </ul>

          <h2 class="text-base font-semibold text-gray-900 dark:text-gray-100 pt-2">
            GitHub API access
          </h2>
          <p>
            The app accesses the GitHub API on your behalf using an OAuth token.
            It reads your issues, pull requests, and workflow runs — nothing is
            written. You can revoke access at any time from{" "}
            <a
              href="https://github.com/settings/applications"
              target="_blank"
              rel="noopener noreferrer"
              class="text-blue-600 hover:underline dark:text-blue-400"
            >
              GitHub Settings &rarr; Applications
            </a>.
          </p>
        </div>
      </div>
    </div>
  );
}
