#!/usr/bin/env bash
# Usage: pnpm validate:deploy
# Checks build-time env vars (VITE_*) and CF Worker secrets via wrangler.
# Wrangler authenticates via CLOUDFLARE_API_TOKEN env var (CI) or interactive login (local).
# SECURITY: This script must NEVER echo, log, or display secret values.
set -euo pipefail

ERRORS=0
warn() { printf '[WARN] %s\n' "$1" >&2; }
fail() { printf '[FAIL] %s\n' "$1" >&2; ERRORS=$((ERRORS+1)); }

# ── Resolve wrangler binary ─────────────────────────────────────────────────
resolve_wrangler() {
  if command -v wrangler &>/dev/null; then
    printf 'wrangler'
  elif [[ -x "./node_modules/.bin/wrangler" ]]; then
    printf './node_modules/.bin/wrangler'
  else
    return 1
  fi
}

# ── Check a VITE_ var: shell env first, then .env / .env.local files ────────
check_vite_var() {
  local var_name="$1" level="$2" msg="$3"
  # Already in shell environment (CI passes them as env:)
  if [[ -n "${!var_name:-}" ]]; then return 0; fi
  # Check .env files (Vite loads these at build time)
  for f in .env .env.local .env.production .env.production.local; do
    if [[ -f "$f" ]] && grep -q "^${var_name}=" "$f"; then return 0; fi
  done
  "$level" "$msg"
}

# ── Build-time env vars (VITE_*) ────────────────────────────────────────────
check_vite_var VITE_GITHUB_CLIENT_ID fail "VITE_GITHUB_CLIENT_ID not set (GitHub Actions variable or .env)"
check_vite_var VITE_SENTRY_DSN warn "VITE_SENTRY_DSN not set — Sentry disabled in this build"
check_vite_var VITE_TURNSTILE_SITE_KEY warn "VITE_TURNSTILE_SITE_KEY not set — Turnstile disabled"

# ── CF Worker secrets via wrangler ──────────────────────────────────────────
if ! WRANGLER=$(resolve_wrangler); then
  fail "wrangler CLI not found — install with: pnpm add -D wrangler"
else
  if ! SECRETS=$($WRANGLER secret list --format json 2>&1); then
    fail "wrangler secret list failed — run: wrangler login (or set CLOUDFLARE_API_TOKEN)"
  else
    has_secret() { echo "$SECRETS" | grep -q "\"name\"[[:space:]]*:[[:space:]]*\"$1\""; }

    for s in ALLOWED_ORIGIN GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET SESSION_KEY SEAL_KEY TURNSTILE_SECRET_KEY; do
      has_secret "$s" || fail "CF Worker secret '$s' not set (run: wrangler secret put $s)"
    done
    has_secret SENTRY_DSN || warn "CF Worker secret 'SENTRY_DSN' not set — Sentry error tunnel returns 404"
    has_secret SENTRY_SECURITY_TOKEN || warn "CF Worker secret 'SENTRY_SECURITY_TOKEN' not set — only needed if Sentry Allowed Domains is configured"
    has_secret SEAL_KEY_NEXT || warn "CF Worker secret 'SEAL_KEY_NEXT' not set — only needed during key rotation"
    has_secret SESSION_KEY_NEXT || warn "CF Worker secret 'SESSION_KEY_NEXT' not set — only needed during key rotation"

    # Detect unexpected secrets not in the known set
    KNOWN="ALLOWED_ORIGIN GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET SESSION_KEY SEAL_KEY TURNSTILE_SECRET_KEY SENTRY_DSN SENTRY_SECURITY_TOKEN SEAL_KEY_NEXT SESSION_KEY_NEXT"
    while IFS= read -r secret_name; do
      found=false
      for k in $KNOWN; do
        [[ "$secret_name" == "$k" ]] && found=true && break
      done
      $found || warn "Unknown CF Worker secret '$secret_name' — not referenced by the app (stale?)"
    done < <(echo "$SECRETS" | grep -oE '"name"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"name"[[:space:]]*:[[:space:]]*"//;s/"//')
  fi
fi

if [[ $ERRORS -eq 0 ]]; then
  printf '[OK] All required deploy configuration is in place.\n'
  exit 0
fi
printf '[ERROR] %d required item(s) missing — see above.\n' "$ERRORS" >&2
exit 1
