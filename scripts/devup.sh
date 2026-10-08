#!/usr/bin/env bash
# Rebuild everything the sandbox wipes between turns: Go toolchain (/tmp),
# the gateway binary, node_modules, and the frontend bundle.
#
# Usage: bash scripts/devup.sh   (from anywhere; it finds the repo itself)
#
# Design note: the Go binary and the frontend bundle are rebuilt EVERY run,
# never "only if missing". An earlier version skipped them when the artefact
# already existed, which silently served a stale /tmp/umigw and cost a long
# debugging session chasing a phantom ERR_NOT_FOUND. Both builds are a couple
# of seconds with warm caches; staleness is far more expensive than that.
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# --- Go toolchain (lives in /tmp, a tmpfs that gets cleared between sessions) ---
# The modules require go >= 1.25 since the security upgrade, so this has to
# track go.mod — an older toolchain fails with GOTOOLCHAIN=local.
GOVER=1.25.0
if [ "$(/tmp/go/bin/go version 2>/dev/null | awk '{print $3}')" != "go$GOVER" ]; then
  echo "[devup] installing Go $GOVER ..."
  rm -rf /tmp/go
  cd /tmp && curl -sL -o go.tgz "https://go.dev/dl/go${GOVER}.linux-amd64.tar.gz" && tar -xzf go.tgz
fi
# shellcheck disable=SC1091
if [ -f /home/user/.goenv ]; then
  source /home/user/.goenv
else
  export PATH=/tmp/go/bin:$PATH GOTOOLCHAIN=local \
         GOMODCACHE="$HOME/.cache/gomod" GOCACHE="$HOME/.cache/go-build" GOFLAGS=-mod=mod
fi

# --- git identity -----------------------------------------------------------
# .git/config is excluded from workspace snapshots, so the repo loses its
# author identity between sessions and commits fall back to a placeholder.
# Re-apply it from the durable copy on every run.
if [ -f /home/user/.gitidentity ]; then
  # shellcheck disable=SC1091
  . /home/user/.gitidentity
  git -C "$REPO" config user.name  "$GIT_AUTHOR_NAME"
  git -C "$REPO" config user.email "$GIT_AUTHOR_EMAIL"
fi
# Same reason: the remote URL lives in .git/config and disappears with it.
git -C "$REPO" remote get-url origin >/dev/null 2>&1 || \
  git -C "$REPO" remote add origin https://github.com/katepallewarprathmesh-sketch/AasthiChain.git

# --- node deps (slow; only when genuinely absent) ---
[ -d "$REPO/node_modules" ]          || (echo "[devup] npm install (root) ..."     && cd "$REPO" && npm install --silent)
[ -d "$REPO/frontend/node_modules" ] || (echo "[devup] npm install (frontend) ..." && cd "$REPO/frontend" && npm install --silent)

# --- always rebuild: cheap, and staleness here is a known foot-gun ---
echo "[devup] building drunix-gateway ..."
(cd "$REPO/drunix-gateway" && go build -o /tmp/umigw ./cmd/gateway) || { echo "[devup] GO BUILD FAILED"; exit 1; }

echo "[devup] vite build ..."
(cd "$REPO/frontend" && npx vite build >/dev/null 2>&1) || { echo "[devup] VITE BUILD FAILED"; exit 1; }

echo "[devup] ready: /tmp/umigw + node_modules + frontend/dist"
echo
echo "  Start the rail:  UMI_ENABLED=true UMI_SEED_DEMO=true DRUNIX_MODE=mock PORT=21100 /tmp/umigw"
echo "  Start the app :  DEMO_AUTH=true ADMIN_DASHBOARD_KEY=<key> UMI_GATEWAY_URL=http://localhost:21100 node server.js"
echo "  Verify        :  bash $REPO/regression.sh   (expects 73 passed)"
