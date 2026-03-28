#!/usr/bin/env bash
# WAF Smoke Tests — validates Cloudflare WAF rules for gh.gordoncode.dev
#
# Usage: pnpm test:waf
#
# Rules validated:
#   1. Path Allowlist — blocks all paths except known SPA routes, /assets/*, /api/*
#   2. Scanner User-Agents — challenges empty/malicious User-Agent strings
#   Rate limit rule exists but is not tested here (triggers a 10-minute IP block).

set -euo pipefail

BASE="https://gh.gordoncode.dev"
PASS=0
FAIL=0

# When WAF_BYPASS_TOKEN is set (CI), send a header that a Cloudflare WAF rule
# uses to skip Bot Fight Mode for this request. Without it (local dev), requests
# pass through normally since residential IPs aren't challenged.
BYPASS=()
if [[ -n "${WAF_BYPASS_TOKEN:-}" ]]; then
  BYPASS=(-H "X-CI-Bypass: ${WAF_BYPASS_TOKEN}")
fi

assert_status() {
  local expected="$1" actual="$2" label="$3"
  if [[ "$actual" == "$expected" ]]; then
    echo "  PASS  [${actual}] ${label}"
    PASS=$((PASS + 1))
  else
    echo "  FAIL  [${actual}] ${label} (expected ${expected})"
    FAIL=$((FAIL + 1))
  fi
}

fetch() {
  curl -s -o /dev/null -w "%{http_code}" "${BYPASS[@]}" "$@"
}

# ============================================================
# Rule 1: Path Allowlist
# ============================================================
echo "=== Rule 1: Path Allowlist ==="
echo "--- Allowed paths (should pass) ---"

for path in "/" "/login" "/oauth/callback" "/onboarding" "/dashboard" "/settings" "/privacy"; do
  status=$(fetch "${BASE}${path}")
  assert_status "200" "$status" "GET ${path}"
done

status=$(fetch "${BASE}/index.html")
assert_status "307" "$status" "GET /index.html (html_handling redirect)"

status=$(fetch "${BASE}/assets/nonexistent.js")
assert_status "200" "$status" "GET /assets/nonexistent.js"

status=$(fetch "${BASE}/api/health")
assert_status "200" "$status" "GET /api/health"

status=$(fetch -X POST "${BASE}/api/oauth/token")
assert_status "400" "$status" "POST /api/oauth/token (no body)"

status=$(fetch "${BASE}/api/nonexistent")
assert_status "404" "$status" "GET /api/nonexistent"

echo "--- Blocked paths (should be 403) ---"

for path in "/wp-admin" "/wp-login.php" "/.env" "/.env.production" \
            "/.git/config" "/.git/HEAD" "/xmlrpc.php" \
            "/phpmyadmin/" "/phpMyAdmin/" "/.htaccess" "/.htpasswd" \
            "/cgi-bin/" "/admin/" "/wp-content/debug.log" \
            "/config.php" "/backup.zip" "/actuator/health" \
            "/manager/html" "/wp-config.php" "/eval-stdin.php" \
            "/.aws/credentials" "/.ssh/id_rsa" "/robots.txt" \
            "/sitemap.xml" "/favicon.ico" "/random/garbage/path"; do
  status=$(fetch "${BASE}${path}")
  assert_status "403" "$status" "GET ${path}"
done

# ============================================================
# Rule 2: Scanner User-Agents
# ============================================================
echo ""
echo "=== Rule 2: Scanner User-Agents ==="
echo "--- Normal UAs (should pass) ---"

status=$(fetch -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" "${BASE}/")
assert_status "200" "$status" "Normal browser UA"

status=$(fetch "${BASE}/")
assert_status "200" "$status" "Default curl UA"

echo "--- Malicious UAs (should be 403 — managed challenge, no JS) ---"

status=$(fetch -H "User-Agent:" "${BASE}/")
assert_status "403" "$status" "Empty User-Agent"

for ua in "sqlmap/1.7" "Nikto/2.1.6" "Nmap Scripting Engine" "masscan/1.3" "Mozilla/5.0 zgrab/0.x"; do
  status=$(fetch -H "User-Agent: ${ua}" "${BASE}/")
  assert_status "403" "$status" "UA: ${ua}"
done

# ============================================================
# Summary
# ============================================================
echo ""
TOTAL=$((PASS + FAIL))
echo "=== Results: ${PASS}/${TOTAL} passed, ${FAIL} failed ==="
if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
