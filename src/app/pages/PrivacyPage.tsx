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
            Cookies
          </h2>
          <p>
            A single session cookie (<code>__Host-session</code>) is set when
            you use the proxy features of this app (such as sealing an API
            token). This cookie exists solely to bind API rate limits to a
            browser session — it is not used for tracking or authentication.
          </p>
          <ul class="list-disc pl-5 space-y-1">
            <li>
              <strong>Attributes:</strong> HttpOnly, Secure, SameSite=Strict,
              with the <code>__Host-</code> prefix enforced by the browser
            </li>
            <li>
              <strong>Lifetime:</strong> expires automatically after 8 hours
            </li>
            <li>
              <strong>Content:</strong> a random session ID only — no personal
              data, no access tokens, no identifiers linked to your account
            </li>
          </ul>
          <p>
            This cookie does not track you across sites or sessions. It is a
            strictly necessary security measure and does not require consent
            under GDPR.
          </p>

          <h2 class="text-base font-semibold text-base-content pt-2">
            Bot protection
          </h2>
          <p>
            We use{" "}
            <a
              href="https://www.cloudflare.com/products/turnstile/"
              target="_blank"
              rel="noopener noreferrer"
              class="link link-primary"
            >
              Cloudflare Turnstile
            </a>{" "}
            (Cloudflare, Inc.) to distinguish human users from bots during
            token-sealing operations. When Turnstile is invoked, Cloudflare
            collects the following signals client-side: your IP address, TLS
            fingerprint, user-agent header, and browser characteristics.
          </p>
          <p>
            Our server also forwards your IP address to Cloudflare's{" "}
            <code>siteverify</code> API via the <code>remoteip</code> field to
            improve bot-detection accuracy. Your IP is{" "}
            <strong>not stored or logged</strong> by our server — it is only
            forwarded to Cloudflare for this single verification request.
          </p>
          <p>
            Turnstile does <strong>not</strong> use tracking cookies, build user
            profiles, or perform cross-site tracking. Cloudflare acts as a data
            processor for service delivery and as a data controller for improving
            bot detection. See the{" "}
            <a
              href="https://www.cloudflare.com/turnstile-privacy-policy/"
              target="_blank"
              rel="noopener noreferrer"
              class="link link-primary"
            >
              Cloudflare Turnstile Privacy Addendum
            </a>{" "}
            for details.
          </p>

          <h2 class="text-base font-semibold text-base-content pt-2">
            Server-side logging
          </h2>
          <p>
            Our Cloudflare Worker logs metadata about API requests for security
            monitoring and abuse detection. The following fields are logged per
            request:
          </p>
          <ul class="list-disc pl-5 space-y-1">
            <li>Request origin and user-agent header</li>
            <li>
              Cloudflare datacenter location (country, city, and datacenter
              code)
            </li>
          </ul>
          <p>
            <strong>What is not logged:</strong> IP addresses, request or
            response bodies, API tokens, OAuth authorization codes, and cookie
            values are never stored.
          </p>
          <p>
            Logs are automatically deleted after 7 days (Cloudflare Workers Logs
            retention). They are used only for security monitoring and abuse
            detection — never for analytics, profiling, or tracking.
          </p>

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
            Server-side errors (from the Cloudflare Worker) are also reported to
            Sentry directly, applying the same data minimization practices: no
            PII, no request bodies, and no headers are included in worker error
            events.
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
            <li>
              No tracking cookies — one security-only session cookie (described
              above) is used solely for rate-limit binding
            </li>
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
