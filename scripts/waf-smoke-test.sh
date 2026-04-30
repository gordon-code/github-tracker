#!/usr/bin/env bash
# WAF Smoke Tests — validates Cloudflare WAF rules for a deployment domain
# Requires: GNU parallel (brew install parallel / apt install parallel)
#
# Usage: pnpm test:waf [base_url]
#   e.g. pnpm test:waf https://my-tracker.example.com
#
# Rules validated:
#   1. Path Allowlist — blocks all paths except known SPA routes, /assets/*, /api/*
#   2. Scanner User-Agents — challenges empty/malicious User-Agent strings
#   3. Origin Gate — blocks /api/* requests without valid Origin header
#   Rate limit rule exists but is not tested here (triggers a 10-minute IP block).

set -euo pipefail

if ! command -v parallel &>/dev/null; then
  printf 'Error: GNU parallel is required (brew install parallel / apt install parallel)\n' >&2
  exit 1
fi

BASE="${1:-https://gh.gordoncode.dev}"

# --- Test runner (exported for GNU parallel) ---
run_test() {
  local expected="$1" label="$2"
  shift 2
  local actual attempt
  for attempt in 1 2 3; do
    actual=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 --max-time 10 "$@")
    [[ "$actual" != "000" && "$actual" != "502" && "$actual" != "503" ]] && break
    sleep "$attempt"
  done
  if [[ "$actual" == "$expected" ]]; then
    printf '  PASS  [%s] %s\n' "$actual" "$label"
  else
    printf '  FAIL  [%s] %s (expected %s)\n' "$actual" "$label" "$expected"
    return 1
  fi
}
export -f run_test

# --- Test spec parser (exported for GNU parallel) ---
# Splits pipe-delimited spec into: expected_status | label | curl_args...
run_spec() {
  local expected label
  IFS='|' read -ra parts <<< "$1"
  expected="${parts[0]}"
  label="${parts[1]}"
  run_test "$expected" "$label" "${parts[@]:2}"
}
export -f run_spec

# --- Test specs: expected_status | label | curl args ... ---
# Pipe-delimited. Fields after label are passed directly to curl.
TESTS=(
  # Rule 1: Path Allowlist — allowed paths
  "200|GET /|${BASE}/"
  "200|GET /login|${BASE}/login"
  "200|GET /oauth/callback|${BASE}/oauth/callback"
  "200|GET /onboarding|${BASE}/onboarding"
  "200|GET /dashboard|${BASE}/dashboard"
  "200|GET /settings|${BASE}/settings"
  "200|GET /privacy|${BASE}/privacy"
  "307|GET /index.html (html_handling redirect)|${BASE}/index.html"
  "200|GET /assets/nonexistent.js|${BASE}/assets/nonexistent.js"
  "200|GET /api/health (with Origin)|-H|Origin: ${BASE}|${BASE}/api/health"
  "400|POST /api/oauth/token (no body)|-X|POST|-H|Origin: ${BASE}|${BASE}/api/oauth/token"
  "404|GET /api/nonexistent|-H|Origin: ${BASE}|${BASE}/api/nonexistent"
  # Rule 3: Origin gate — API requests without valid Origin are blocked at WAF
  "403|GET /api/health (no Origin)|${BASE}/api/health"
  "403|POST /api/oauth/token (wrong Origin)|-X|POST|-H|Origin: https://evil.example.com|${BASE}/api/oauth/token"
  # Rule 1: Path Allowlist — blocked paths
  "403|GET /wp-admin|${BASE}/wp-admin"
  "403|GET /wp-login.php|${BASE}/wp-login.php"
  "403|GET /.env|${BASE}/.env"
  "403|GET /.env.production|${BASE}/.env.production"
  "403|GET /.git/config|${BASE}/.git/config"
  "403|GET /.git/HEAD|${BASE}/.git/HEAD"
  "403|GET /xmlrpc.php|${BASE}/xmlrpc.php"
  "403|GET /phpmyadmin/|${BASE}/phpmyadmin/"
  "403|GET /phpMyAdmin/|${BASE}/phpMyAdmin/"
  "403|GET /.htaccess|${BASE}/.htaccess"
  "403|GET /.htpasswd|${BASE}/.htpasswd"
  "403|GET /cgi-bin/|${BASE}/cgi-bin/"
  "403|GET /admin/|${BASE}/admin/"
  "403|GET /wp-content/debug.log|${BASE}/wp-content/debug.log"
  "403|GET /config.php|${BASE}/config.php"
  "403|GET /backup.zip|${BASE}/backup.zip"
  "403|GET /actuator/health|${BASE}/actuator/health"
  "403|GET /manager/html|${BASE}/manager/html"
  "403|GET /wp-config.php|${BASE}/wp-config.php"
  "403|GET /eval-stdin.php|${BASE}/eval-stdin.php"
  "403|GET /.aws/credentials|${BASE}/.aws/credentials"
  "403|GET /.ssh/id_rsa|${BASE}/.ssh/id_rsa"
  "403|GET /robots.txt|${BASE}/robots.txt"
  "403|GET /sitemap.xml|${BASE}/sitemap.xml"
  "403|GET /favicon.ico|${BASE}/favicon.ico"
  "403|GET /random/garbage/path|${BASE}/random/garbage/path"
  # Rule 2: Scanner User-Agents — normal UAs
  "200|Normal browser UA|-H|User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36|${BASE}/"
  "200|Default curl UA|${BASE}/"
  # Rule 2: Scanner User-Agents — malicious UAs
  "403|Empty User-Agent|-H|User-Agent:|${BASE}/"
  "403|UA: sqlmap/1.7|-H|User-Agent: sqlmap/1.7|${BASE}/"
  "403|UA: Nikto/2.1.6|-H|User-Agent: Nikto/2.1.6|${BASE}/"
  "403|UA: Nmap Scripting Engine|-H|User-Agent: Nmap Scripting Engine|${BASE}/"
  "403|UA: masscan/1.3|-H|User-Agent: masscan/1.3|${BASE}/"
  "403|UA: Mozilla/5.0 zgrab/0.x|-H|User-Agent: Mozilla/5.0 zgrab/0.x|${BASE}/"
)

# --- Run in parallel (:::  passes array elements directly, avoiding stdin quoting issues) ---
TOTAL=${#TESTS[@]}

OUTPUT=$(parallel --will-cite -k -j1 --delay 0.2 --timeout 30 run_spec ::: "${TESTS[@]}") || true

# Detect infrastructure failure (parallel crashed, no tests ran)
if [[ -z "$OUTPUT" ]]; then
  printf 'Error: test harness produced no output — parallel may have failed\n' >&2
  exit 2
fi

# Count results from output
PASS=$(grep -c "^  PASS" <<< "$OUTPUT" || true)
FAIL=$((TOTAL - PASS))

# Print results (preserving order from parallel -k)
printf '%s\n' "$OUTPUT"
printf '\n=== Results: %d/%d passed, %d failed ===\n' "$PASS" "$TOTAL" "$FAIL"
if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
