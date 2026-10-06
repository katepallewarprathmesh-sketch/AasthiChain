#!/usr/bin/env bash
# Refuse to let a live credential into the repository.
#
# The PayU salt was pasted into chat and set in Vercel, and the only reason it
# never reached a commit was luck — nothing in the build would have stopped it.
# A leaked salt lets anyone forge a payment-success callback, so this runs in
# the regression sweep and can be wired to a pre-commit hook.
#
# Exit 0 = clean. Exit 1 = something that looks like a real secret is tracked.

cd "$(dirname "$0")/.." || exit 2

FOUND=0
report() { FOUND=1; echo "  LEAK  $1"; }

# Tracked files only. Anything ignored is not going anywhere.
FILES=$(git ls-files | grep -vE '^(docs-backup/|.*\.example$)' || true)
[ -z "$FILES" ] && { echo "  no tracked files to scan"; exit 0; }

scan() { # scan "<label>" "<regex>"
  local hits
  hits=$(printf '%s\n' "$FILES" | xargs -r grep -nIE "$2" 2>/dev/null \
         | grep -vE 'your-key-here|<your|example|EXAMPLE|placeholder|testsalt|testkey|devkey' || true)
  [ -n "$hits" ] && { report "$1"; printf '%s\n' "$hits" | head -5 | sed 's/^/        /'; }
}

scan "GitHub personal access token"  'github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{30,}'
scan "PayU salt assigned inline"     'PAYU_SALT[[:space:]]*[=:][[:space:]]*["'"'"']?[A-Za-z0-9]{16,}'
scan "PayU merchant key inline"      'PAYU_MERCHANT_KEY[[:space:]]*[=:][[:space:]]*["'"'"']?[A-Za-z0-9]{6,}'
scan "admin dashboard key inline"    'ADMIN_DASHBOARD_KEY[[:space:]]*[=:][[:space:]]*["'"'"']?[A-Za-z0-9]{8,}'
scan "AWS access key id"             'AKIA[0-9A-Z]{16}'
scan "Stripe live key"               'sk_live_[A-Za-z0-9]{10,}'
scan "private key block"             'BEGIN (RSA|EC|OPENSSH|PGP) PRIVATE KEY'

# A tracked .env (as opposed to .env.example) is a mistake every time.
ENVS=$(git ls-files | grep -E '(^|/)\.env' | grep -vE '\.example$' || true)
[ -n "$ENVS" ] && { report "environment file is tracked"; printf '%s\n' "$ENVS" | sed 's/^/        /'; }

if [ "$FOUND" -eq 0 ]; then
  echo "  no credentials found in tracked files"
  exit 0
fi
echo
echo "  Remove the value, replace it with an env var, and rotate it at the"
echo "  provider — a secret that reached a commit must be treated as burned."
exit 1
