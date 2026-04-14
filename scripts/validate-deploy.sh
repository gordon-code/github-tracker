#!/usr/bin/env bash
# Usage: pnpm validate:deploy [--ci]
#   Local:  checks CF Worker secrets via wrangler secret list
#   CI:     checks build-time env vars and deploy credentials
# SECURITY: This script must NEVER echo, log, or display secret values.
set -euo pipefail
CI_MODE=false
[[ "${1:-}" == "--ci" ]] && CI_MODE=true

ERRORS=0
warn() { printf '[WARN] %s\n' "$1" >&2; }
fail() { printf '[FAIL] %s\n' "$1" >&2; ERRORS=$((ERRORS+1)); }

if $CI_MODE; then
  [[ -z "${VITE_GITHUB_CLIENT_ID:-}" ]] && fail "VITE_GITHUB_CLIENT_ID not set (add as GitHub Actions variable)"
  [[ -z "${VITE_SENTRY_DSN:-}" ]] && warn "VITE_SENTRY_DSN not set — Sentry disabled in this build"
  [[ -z "${VITE_TURNSTILE_SITE_KEY:-}" ]] && warn "VITE_TURNSTILE_SITE_KEY not set — Turnstile disabled"
  [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]] && fail "CLOUDFLARE_API_TOKEN not set (add as GitHub Actions secret)"
  [[ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]] && fail "CLOUDFLARE_ACCOUNT_ID not set (add as GitHub Actions secret)"
else
  if ! command -v wrangler &>/dev/null; then
    fail "wrangler CLI not found — install with: pnpm add -g wrangler"
  else
    if ! SECRETS=$(wrangler secret list --json 2>&1); then
      fail "wrangler secret list failed — run: wrangler login"
    else
      for s in ALLOWED_ORIGIN GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET SESSION_KEY SEAL_KEY TURNSTILE_SECRET_KEY; do
        echo "$SECRETS" | grep -q "\"name\":\"$s\"" || fail "CF Worker secret '$s' not set (run: wrangler secret put $s)"
      done
      echo "$SECRETS" | grep -q '"name":"SENTRY_DSN"' || warn "CF Worker secret 'SENTRY_DSN' not set — Sentry error tunnel returns 404"
      echo "$SECRETS" | grep -q '"name":"SENTRY_SECURITY_TOKEN"' || warn "CF Worker secret 'SENTRY_SECURITY_TOKEN' not set — only needed if Sentry Allowed Domains is configured"
    fi
  fi
fi

if [[ $ERRORS -eq 0 ]]; then
  printf '[OK] All required deploy configuration is in place.\n'
  exit 0
fi
printf '[ERROR] %d required item(s) missing — see above.\n' "$ERRORS" >&2
exit 1
