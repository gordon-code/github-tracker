export default function PrivacyPage() {
  return (
    <div class="bg-base-200 min-h-screen">
      <div class="mx-auto max-w-2xl px-4 py-12">
        <a
          href="/dashboard"
          class="link link-hover text-sm text-base-content/40"
        >
          &larr; Back to dashboard
        </a>

        <h1 class="mt-6 text-2xl font-bold text-base-content">
          Privacy Policy
        </h1>

        <div class="mt-6 space-y-4 text-sm text-base-content/70 leading-relaxed">
          <p>
            GitHub Tracker stores your data in your browser. We use a
            privacy-hardened error monitoring service to diagnose issues, as
            described below.
          </p>

          <h2 class="text-base font-semibold text-base-content pt-2">
            What we store in your browser
          </h2>
          <ul class="list-disc pl-5 space-y-1">
            <li>
              <strong>localStorage</strong> — your settings (selected orgs,
              repos, theme, etc.), view state (tab filters, sort order), and
              OAuth access token for GitHub API authentication. Cleared on logout.
            </li>
            <li>
              <strong>IndexedDB</strong> — cached API responses with ETags to
              reduce GitHub API usage. Cleared on logout.
            </li>
          </ul>

          <h2 class="text-base font-semibold text-base-content pt-2">
            Error monitoring
          </h2>
          <p>
            We use{" "}
            <a
              href="https://sentry.io"
              target="_blank"
              rel="noopener noreferrer"
              class="link link-primary"
            >
              Sentry
            </a>{" "}
            (Functional Software, Inc.) to capture JavaScript errors so we can
            fix bugs. When an error occurs, the following is sent:
          </p>
          <ul class="list-disc pl-5 space-y-1">
            <li>Error type, message, and stack trace (file and line number)</li>
            <li>Browser and operating system version</li>
            <li>Page URL with authentication parameters redacted</li>
            <li>Application log messages related to the error</li>
          </ul>
          <p class="pt-1">
            <strong>What is never sent:</strong> IP addresses, cookies, request
            headers, user identity, access tokens, OAuth codes, DOM content,
            screen recordings, keystrokes, or performance traces. All sensitive
            URL parameters are stripped before data leaves your browser.
          </p>
          <p>
            Error data is stored on Sentry's US-based infrastructure and
            retained per Sentry's{" "}
            <a
              href="https://sentry.io/privacy/"
              target="_blank"
              rel="noopener noreferrer"
              class="link link-primary"
            >
              privacy policy
            </a>. Error monitoring is disabled during local development.
          </p>

          <h2 class="text-base font-semibold text-base-content pt-2">
            What we don't do
          </h2>
          <ul class="list-disc pl-5 space-y-1">
            <li>No analytics or behavioral tracking</li>
            <li>No cookies</li>
            <li>No session recordings or screen capture</li>
            <li>No user identification or profiling</li>
          </ul>

          <h2 class="text-base font-semibold text-base-content pt-2">
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
              class="link link-primary"
            >
              GitHub Settings &rarr; Applications
            </a>.
          </p>
        </div>
      </div>
    </div>
  );
}
