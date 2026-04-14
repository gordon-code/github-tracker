# Deployment Guide

## Fork Deployment Checklist

If you're deploying your own instance of GitHub Tracker, update these values:

### Required (deployment won't work without these)

1. **Create a GitHub OAuth App** — [Settings → Developer settings → OAuth Apps](https://github.com/settings/developers)
   - Set the callback URL to `https://YOUR-DOMAIN/oauth/callback`
2. **Update `wrangler.toml`** — Change `pattern = "gh.gordoncode.dev"` to your domain
3. **Set GitHub Actions secrets and variables** — See sections below
4. **Set Cloudflare Worker secrets** — See "Cloudflare Worker Secrets" section below. **Critical:** `ALLOWED_ORIGIN` must exactly match your deployment URL (e.g., `https://your-domain.example.com`). An incorrect value causes all API requests to fail with CORS errors.

### Verify configuration

Run `pnpm validate:deploy` locally to check that all required Cloudflare Worker secrets
are set. In CI, the deploy workflow runs `pnpm validate:deploy --ci` automatically before
building.

### Optional

5. **Cloudflare Turnstile** — Create a widget and set `VITE_TURNSTILE_SITE_KEY` in `.env`. Only needed for the planned Jira/GitLab token sealing feature.
6. **Sentry error reporting** — Set `VITE_SENTRY_DSN` (build-time, via GitHub Actions variable) and `SENTRY_DSN` (Worker secret, via `wrangler secret put`) to the **same** DSN value. The Worker tunnel (`/api/error-reporting`) validates the incoming envelope DSN against `env.SENTRY_DSN` — different values cause all Sentry events to silently return 403. Leave both empty to disable.
7. **MCP relay** — Set `MCP_RELAY_ALLOWED_ORIGINS=https://YOUR-DOMAIN` when running the MCP server
8. **WAF smoke tests** — Set `DEPLOY_DOMAIN` as a GitHub Actions variable (e.g., `your-domain.example.com`). CI runs `pnpm test:waf https://$DEPLOY_DOMAIN` automatically. If `DEPLOY_DOMAIN` is not set, the WAF test is skipped. Run locally with: `pnpm test:waf https://YOUR-DOMAIN`.
9. **Social metadata** — Update `og:image` and `og:url` in `index.html` to your domain
10. **Security contact** — Update the email and scope domain in `SECURITY.md`
11. **README** — Update the "Live demo" URL in `README.md`
12. **User Guide** — Update the domain reference in `docs/USER_GUIDE.md`
13. **App footer links** — Update "Source" and "Guide" URLs in `src/app/components/dashboard/DashboardPage.tsx` and `src/app/components/settings/SettingsPage.tsx` if you want them to point to your fork
14. **Contributing guide** — Update the clone URL and PR target in `CONTRIBUTING.md`

### Static-only deployment (no Cloudflare Worker)

GitHub Tracker can run as a pure static site without the Cloudflare Worker backend.
Use a Personal Access Token (PAT) instead of OAuth — the PAT flow validates directly
against `api.github.com` with no server-side component.

**Host the `dist/` build output on any static platform:** GitHub Pages, Netlify, Vercel,
S3 + CloudFront, or any CDN that serves SPAs with `index.html` fallback for client-side
routing.

**What works without a backend:**
- All dashboard features (Issues, PRs, Actions tabs)
- PAT authentication (classic `ghp_` or fine-grained `github_pat_`)
- All GitHub API calls (GraphQL + REST, direct to `api.github.com`)
- Full poll + hot poll refresh cycles
- Desktop notifications
- Multi-user tracking, upstream repo discovery, monitor-all mode
- Repo pinning/reordering, themes, ignore system
- IndexedDB caching + ETag optimization
- MCP server (separate Node.js process, independent of Worker)

**What does NOT work without a backend:**
- **OAuth login** — requires server-side `client_secret` exchange. Use a PAT instead.
  The "Sign in with GitHub" button will still appear on the login page but will fail
  if no `VITE_GITHUB_CLIENT_ID` is configured.
- **Sentry error reporting** — do NOT set `VITE_SENTRY_DSN` on static-only deploys.
  The Sentry SDK is configured with `tunnel: "/api/error-reporting"`, which doesn't
  exist on a static host. Setting a DSN causes the SDK to silently lose all error
  reports via 404s. Leave `VITE_SENTRY_DSN` empty to cleanly disable Sentry.
- **CSP violation reporting** — reports silently dropped (no user impact). The
  `report-uri /api/csp-report` directive in `public/_headers` will produce harmless
  404 console errors on static hosts. Optionally remove the `report-uri` and
  `report-to` directives if the noise is unwanted.
- **Jira/GitLab token sealing** (planned) — requires server-side encryption

**Security note:** The `public/_headers` file sets Content-Security-Policy and other
security headers. Ensure your static host serves these headers — Cloudflare Pages,
Netlify, and Vercel support `_headers` files natively. Other hosts may need manual
header configuration.

**Build for static deployment:**
```sh
pnpm install
pnpm run build     # Output in dist/
# Upload dist/ to your static host
```
No `VITE_GITHUB_CLIENT_ID` or `VITE_TURNSTILE_SITE_KEY` is needed for PAT-only
deployments — leave them empty. OAuth login won't work without a client ID (use
PAT instead), and Turnstile is only used by the planned Jira/GitLab integration.

## GitHub Actions Secrets and Variables

### Secrets (GitHub repo → Settings → Secrets and variables → Actions → Secrets)

**`CLOUDFLARE_API_TOKEN`**
1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com) → My Profile → API Tokens
2. Click "Create Token"
3. Use the "Edit Cloudflare Workers" template
4. Scope to your account and zone as needed
5. Copy the token and add it as a secret

**`CLOUDFLARE_ACCOUNT_ID`**
1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com)
2. Select your account (Account Home)
3. Copy the Account ID from the right sidebar
4. Add it as a secret

### Variables (GitHub repo → Settings → Secrets and variables → Actions → Variables)

**`VITE_GITHUB_CLIENT_ID`**
- This is the GitHub OAuth App Client ID (not a secret — it is embedded in the built JS bundle)
- Add it as an Actions **variable** (not a secret)
- See OAuth App setup below for how to obtain it

## GitHub OAuth App Setup

1. Go to GitHub → Settings → Developer settings → OAuth Apps → **New OAuth App**
2. Fill in the details:
   - **Application name**: your app name (e.g. `gh-tracker-yourname`)
   - **Homepage URL**: `https://YOUR-DOMAIN` (e.g. `https://gh.gordoncode.dev`)
   - **Authorization callback URL**: `https://YOUR-DOMAIN/oauth/callback`
3. Click **Register application**
4. Note the **Client ID** — this is your `VITE_GITHUB_CLIENT_ID`
5. Click **Generate a new client secret** and save it for the Worker secrets below

### Scopes

The login flow requests `scope=repo read:org notifications`:

| Scope | Used for |
|-------|----------|
| `repo` | Read issues, PRs, check runs, workflow runs (includes private repos) |
| `read:org` | `GET /user/orgs` — list user's organizations for the org selector |
| `notifications` | `GET /notifications` — polling optimization gate (304 = skip full fetch) |

**Note:** The `repo` scope grants write access to repositories, but this app never performs write operations (POST/PUT/PATCH/DELETE on repo endpoints). It is read-only by design.

### Local development OAuth App

Create a second OAuth App for local development:
- **Authorization callback URL**: `http://localhost:5173/oauth/callback`
- Set its Client ID and Secret in `.dev.vars` (see Local Development below)

## Cloudflare Worker Secrets

These are set via wrangler CLI and are stored in the Cloudflare Worker runtime (not in GitHub).

### Production environment

```sh
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET
wrangler secret put ALLOWED_ORIGIN
```

- `GITHUB_CLIENT_ID`: same value as `VITE_GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`: the Client Secret from your GitHub OAuth App
- `ALLOWED_ORIGIN`: `https://YOUR-DOMAIN` (e.g. `https://gh.gordoncode.dev`)

## Worker API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/oauth/token` | POST | Exchange OAuth authorization code for permanent access token. |
| `/api/health` | GET | Health check. Returns `OK`. |
| `/api/proxy/seal` | POST | Encrypt an API token for client-side storage. Requires Turnstile + session. |

### Token Storage Security

The OAuth App access token is a permanent credential (no expiry). It is stored in `localStorage` under the key `github-tracker:auth-token`:

- **CSP protects against XSS token theft**: `script-src 'self'` prevents injection of unauthorized scripts that could read `localStorage`
- On page load, `validateToken()` calls `GET /user` to verify the token is still valid
- On 401, the app immediately clears auth and redirects to login (token is revoked, not expired)
- On logout, the token is removed from `localStorage` and all local state is cleared
- Transient network errors do NOT clear the token (permanent tokens survive connectivity issues)

### CORS

- `Access-Control-Allow-Origin`: exact match against `ALLOWED_ORIGIN` (no wildcards)
- No `Access-Control-Allow-Credentials` header (the `__Host-session` cookie is SameSite=Strict and is not relevant to cross-origin requests)

### Tunnel Endpoint Security

The two tunnel endpoints (`/api/error-reporting` and `/api/csp-report`) receive untrusted browser data and forward it to Sentry. They are hardened with layered fail-fast guards:

**Layered defense model (applied in order):**
1. **IP rate limit** (catches all abuse including curl — headers are irrelevant)
2. **Origin check** (catches cross-origin browser abuse and lazy curl scripts)
3. **DSN/project validation** (catches misdirected requests)

Content-Length pre-check fires between origin check and DSN validation but is an optimization gate, not a security layer (see Content-Length section below).

**Per-endpoint IP rate limits (in-memory, per-isolate):**
- Token exchange (`/api/oauth/token`): 10 requests/min per IP
- Sentry tunnel (`/api/error-reporting`): 15 requests/min per IP
- CSP report tunnel (`/api/csp-report`): 15 requests/min per IP
- Proxy pre-gate (`/api/proxy/*`, `/api/jira/*`): 60 requests/min per IP (complements CF rate limiter binding)

Note: these counters are in-memory and do not survive isolate restarts. A fresh isolate gets a clean slate. CF isolates are short-lived, so this gates burst abuse within a single isolate lifetime — the intended use case.

Token exchange also uses the durable CF rate limiter binding (`PROXY_RATE_LIMITER`) with key `token:{ip}`, enforcing the limit globally across isolates.

**`CF-Connecting-IP` requirement:**
All rate-limited endpoints require the `CF-Connecting-IP` header and return 400 if absent. Cloudflare's proxy layer sets this header on all production requests. Miniflare sets it to the connecting client's address in `wrangler dev`. There is no fallback — requests without this header are rejected outright.

**`PROXY_RATE_LIMITER` binding validation:**
The Worker validates that the `PROXY_RATE_LIMITER` binding exists (via `typeof env.PROXY_RATE_LIMITER?.limit === "function"`) before calling it. A missing binding indicates a deployment misconfiguration (missing `[[ratelimits]]` in `wrangler.toml`) and returns 503. Transient `.limit()` errors on an existing binding fail open — the in-memory IP pre-gate still protects.

**Origin check behavior:**
- Sentry tunnel (`/api/error-reporting`): **strict** — rejects if Origin is absent or does not match `ALLOWED_ORIGIN`. The Sentry SDK always includes `Origin` in its `fetch()` calls from our SPA.
- CSP report tunnel (`/api/csp-report`): **strict** — rejects if Origin is absent or does not match `ALLOWED_ORIGIN`. Same-origin CSP reports (via `report-uri`) always include Origin; the WAF exempts this endpoint so the Worker can enforce its own policy independently.

Note: Origin and Sec-Fetch-Site headers can be spoofed by programmatic clients (curl, scripts). IP rate limiting is the primary defense; origin checks are defense-in-depth.

**CSP field sanitization:**
All string fields in CSP report bodies are sanitized before forwarding to Sentry: control characters (`\x00`–`\x08`, `\x0B`, `\x0C`, `\x0E`–`\x1F`, `\x7F`) are stripped and fields are capped at 2048 characters. This prevents log/SIEM injection via attacker-crafted CSP report values. URL fields are additionally scrubbed of OAuth parameters (`code`, `state`, `access_token`).

**Content-Length pre-check (Sentry: 256 KB, CSP: 64 KB):**
Both tunnel endpoints check the `Content-Length` header before reading the request body as an optimization. If the declared size exceeds the per-endpoint maximum, the request is rejected with 413 without buffering the body. The post-read size check remains the authoritative guard — Content-Length can be absent (chunked transfer, passes through) or spoofed (attacker declares small size but sends large body, caught by the post-read check).

**CSP report fan-out amplification:**
A single POST to `/api/csp-report` can contain up to 20 individual violation reports (via the Reporting API batch format), each triggering a separate outbound subrequest to Sentry's security endpoint. With the 15/min rate limit, worst case is 15 × 20 = **300 outbound subrequests per minute per IP**. This is bounded by the rate limiter on inbound requests and the 20-report cap enforced in code (`scrubbedPayloads.slice(0, 20)`).

## Local Development

Copy `.dev.vars.example` to `.dev.vars` and fill in your values. Wrangler picks up `.dev.vars` automatically for local `wrangler dev` runs.

### HTTPS requirement for session cookies

The `__Host-session` cookie uses the `__Host-` prefix, which browsers **silently reject over HTTP**. To test session cookies locally, use:

```bash
wrangler dev --local-protocol https
```

The self-signed certificate from `--local-protocol https` must be accepted in the browser on first use (click through the "Not Secure" warning or add a security exception).

### Compatibility flags in local dev

The `global_fetch_strictly_public` compatibility flag (which blocks Worker subrequests to private/internal IPs) has **no effect** in local `wrangler dev` — workerd ignores it. No local dev workaround is needed for this flag.

The `nodejs_als` compatibility flag is required by `@sentry/cloudflare` for `AsyncLocalStorage` (request context propagation). It is declared in `wrangler.toml` and is active in both production and local dev.

## Deploy Manually

```sh
pnpm run build
wrangler deploy
```

## Migration from GitHub App

If you previously deployed with the GitHub App model (HttpOnly cookie refresh tokens), follow these steps:

1. **Update GitHub Actions variable**: change `VITE_GITHUB_CLIENT_ID` to your OAuth App's Client ID
2. **Update Cloudflare secrets**: re-run `wrangler secret put GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` with OAuth App values
3. **Update `ALLOWED_ORIGIN`** if it changed (usually unchanged)
4. **Redeploy** the Worker: `pnpm run build && wrangler deploy`
5. **Existing users** will be logged out on next page load (their refresh cookie is no longer valid; they will be prompted to log in again via the new OAuth App flow)
6. **Delete the old GitHub App** (optional): GitHub → Settings → Developer settings → GitHub Apps → your app → Advanced → Delete

The old `POST /api/oauth/refresh` and `POST /api/oauth/logout` endpoints no longer exist and return 404.

---

## WAF Security Rules

Configure these rules in the Cloudflare dashboard under **Security → WAF**.

### Custom Rules

**Rule name:** Block API requests without valid Origin
**Where:** Security → WAF → Custom Rules
**Expression:**
```
(http.request.uri.path starts_with "/api/") and
not (any(http.request.headers["origin"][*] in {"https://YOUR-DOMAIN"})) and
not (http.request.uri.path eq "/api/csp-report") and
not (http.request.uri.path eq "/api/error-reporting")
```
**Action:** Block

**Exemptions:**
- `/api/csp-report` is exempted because the Worker enforces its own strict origin check (rejects missing or mismatched Origin), making the WAF exemption safe.
- `/api/error-reporting` is exempted for the same reason — the Worker enforces its own strict origin check independently. Both endpoints are exempted so the Worker handles origin policies at the application layer, where per-endpoint logic is possible — the WAF expression is too coarse to distinguish per-endpoint behavior.

**Notes:**
- This uses **1 of the 5 free WAF custom rules** available on all plans.
- Blocks scanners, `curl` without `Origin`, and cross-site browser attacks before the Worker runs (never billed as a Worker request).

### Rate Limiting Rules

> **Conditional:** WAF rate limiting rules may require a **Pro plan** or above. If unavailable on your current Cloudflare plan (Free plan), skip this step. The Workers Rate Limiting Binding provides per-session rate limiting instead, and the WAF custom rule (above) still enforces the Origin check layer.

**Rule name:** Rate limit API proxy endpoints
**Where:** Security → WAF → Rate Limiting Rules
**Matching expression:**
```
(http.request.uri.path starts_with "/api/") and
(http.request.method ne "OPTIONS")
```
**Rate:** 60 requests per 10 seconds per IP
**Action:** Block for 60 seconds

**Notes:**
- `OPTIONS` (CORS preflight) is excluded from counting to avoid blocking legitimate preflight requests.
- Provides globally-consistent rate limiting that runs before the Worker (not per-location like Workers Rate Limiting Binding).

---

## Workers Secrets

All secrets are set via the `wrangler` CLI and stored in the Cloudflare Worker runtime (never committed to source control).

### Generating keys

```bash
# Generate cryptographically strong keys (base64-encoded 32-byte random values):
openssl rand -base64 32  # Run once per key below
```

### Setting secrets

```bash
wrangler secret put SESSION_KEY           # HKDF input key material for session cookies
wrangler secret put SEAL_KEY              # HKDF input key material for sealed tokens
wrangler secret put TURNSTILE_SECRET_KEY  # From Cloudflare Turnstile dashboard
```

- `SESSION_KEY`: HKDF input key material used to derive the HMAC-SHA256 key for signing `__Host-session` cookies. Generate with `openssl rand -base64 32`.
- `SENTRY_DSN` (Worker secret, set via `wrangler secret put SENTRY_DSN`): used by both the Sentry tunnel endpoint for DSN validation and the `@sentry/cloudflare` SDK for direct worker-side error capture. Sentry DSNs are public keys — they authorize sending events, not reading them. Must match the `VITE_SENTRY_DSN` build-time env var; a mismatch causes tunnel requests to return 403.
- `SEAL_KEY`: HKDF input key material used to derive the AES-256-GCM key for encrypting API tokens stored client-side as sealed blobs. Generate with `openssl rand -base64 32`.
- `TURNSTILE_SECRET_KEY`: From the Cloudflare Turnstile dashboard (Security → Turnstile → your widget → Secret key).
- `VITE_TURNSTILE_SITE_KEY`: **Build-time env var (public)** — goes in `.env`, not a Worker secret. From the same Turnstile dashboard (Site key).

### First deployment

On initial deployment, set only `SESSION_KEY`, `SEAL_KEY`, and `TURNSTILE_SECRET_KEY`. Do **not** set `SESSION_KEY_PREV` or `SEAL_KEY_PREV` — these are only needed during key rotation after the initial keys are in use.

### Key rotation

To rotate a key without invalidating existing sessions/tokens:

1. Set the `*_PREV` secret to the **current** key value:
   ```bash
   wrangler secret put SESSION_KEY_PREV  # Copy current SESSION_KEY value here first
   wrangler secret put SEAL_KEY_PREV     # Copy current SEAL_KEY value here first
   ```
2. Generate a new key and update the main secret:
   ```bash
   openssl rand -base64 32  # generate new value
   wrangler secret put SESSION_KEY       # update with new value
   wrangler secret put SEAL_KEY          # update with new value
   ```
3. The Worker will accept tokens signed/sealed with either the current or previous key during the transition window.
4. After all clients have cycled (sessions expire after 8 hours), optionally remove `*_PREV`:
   ```bash
   wrangler secret delete SESSION_KEY_PREV
   wrangler secret delete SEAL_KEY_PREV
   ```
