#!/usr/bin/env bash
# Bring up the whole AasthiChain stack, including the parts that are normally
# off: a local EVM chain with DocumentRegistry.sol deployed, so the
# public-chain mirror is live rather than theoretical.
#
#   bash scripts/dev-stack.sh          start everything
#   bash scripts/dev-stack.sh --no-evm skip the chain (lighter, default build)
#   bash scripts/dev-stack.sh --stop   stop what this script started
#
# Everything it starts is logged to /tmp/aasthi-*.log and its PID recorded in
# /tmp/aasthi-*.pid, so --stop never touches a process you started yourself.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO" || exit 1

RAIL_PORT=${RAIL_PORT:-21100}
APP_PORT=${APP_PORT:-8080}
EVM_PORT=${EVM_PORT:-8545}
ADMIN_KEY=${ADMIN_DASHBOARD_KEY:-devkey}

# ---------------------------------------------------------------------------
# Ports, and the trap they used to set
#
# wait_for_port only asks "is something listening". If an older rail or app
# is still holding the port, the new process fails to bind, dies quietly, and
# the script reports a healthy stack while every request is served by the old
# binary. That looks exactly like a route that was added and does not work:
# the handler is in the source, in the built binary, and still 404s.
#
# So a port is claimed before it is used: whatever is holding it is stopped
# first, and if the port is still busy afterwards the script says so and
# stops rather than lying about what is running.
# ---------------------------------------------------------------------------

port_busy() { # port
  (echo >"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

# The two things this script starts, by the command line they run under.
pattern_for() { # name
  case "$1" in
    rail) echo "^/tmp/umigw$" ;;
    app)  echo "node server\.js" ;;
    *)    echo "" ;;
  esac
}

stop_strays() { # name, port
  local name=$1 port=$2 pattern pids
  pattern=$(pattern_for "$name")
  [[ -z "$pattern" ]] && return 0
  port_busy "$port" || return 0
  pids=$(pgrep -f "$pattern" 2>/dev/null | grep -v "^$$\$" || true)
  [[ -z "$pids" ]] && return 0
  echo "  stopping an earlier $name still on :$port (pid $(echo "$pids" | tr '\n' ' '))"
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    port_busy "$port" || return 0
    sleep 0.5
  done
  # shellcheck disable=SC2086
  kill -9 $pids 2>/dev/null
  sleep 1
  return 0
}

claim_port() { # name, port
  stop_strays "$1" "$2"
  if port_busy "$2"; then
    echo "port $2 is still held by something this script did not start." >&2
    echo "The $1 would fail to bind and the stack would serve whatever is already there." >&2
    echo "Find it with: pgrep -af 'umigw|node server.js'" >&2
    exit 1
  fi
}

WANT_EVM=1
case "${1:-}" in
  --no-evm) WANT_EVM=0 ;;
  --stop)
    for name in app rail evm; do
      pidfile="/tmp/aasthi-$name.pid"
      if [[ -f "$pidfile" ]]; then
        pid=$(cat "$pidfile")
        # Only kill it if it is still the process we started.
        if kill -0 "$pid" 2>/dev/null; then
          kill "$pid" 2>/dev/null && echo "stopped $name (pid $pid)"
        fi
        rm -f "$pidfile"
      fi
    done
    # A pidfile is not the whole truth. A rail or app started by hand, or by
    # an earlier sandbox session whose pidfile is gone, still holds the port
    # and is the reason a "restarted" stack can serve a stale binary. Clear
    # those too, or --stop has not stopped the stack.
    stop_strays rail "$RAIL_PORT"
    stop_strays app "$APP_PORT"
    exit 0
    ;;
esac

# Go is not always on PATH even when the toolchain is installed.
export PATH=/tmp/go/bin:$PATH
export GOFLAGS=${GOFLAGS:--mod=mod}
export GOMODCACHE=${GOMODCACHE:-$HOME/.cache/gomod}
export GOCACHE=${GOCACHE:-$HOME/.cache/go-build}
export GOTOOLCHAIN=${GOTOOLCHAIN:-local}

if ! command -v go >/dev/null 2>&1; then
  echo "go is not on PATH. Install it, or run devup.sh if you have one." >&2
  exit 1
fi

wait_for_port() { # port, seconds
  local port=$1 secs=${2:-30}
  for ((i = 0; i < secs * 2; i++)); do
    if (echo >"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then return 0; fi
    sleep 0.5
  done
  return 1
}

# Dependencies and build output are the first things a fresh clone — or a
# recycled sandbox — is missing, and the failure is confusing: the server
# cheerfully announces it is serving a dist directory that is not there, and
# the browser quietly runs whatever stale bundle it cached. Check, do not
# assume.
if [[ ! -d node_modules ]]; then
  echo "installing server dependencies…"
  npm install --silent || exit 1
fi

if [[ ! -d frontend/node_modules ]]; then
  echo "installing frontend dependencies…"
  (cd frontend && npm install --silent) || exit 1
fi

# Rebuild when dist is missing, or when any source file is newer than the
# bundle. Serving a stale bundle looks exactly like a backend bug.
needs_build=0
if [[ ! -f frontend/dist/index.html ]]; then
  needs_build=1
elif [[ -n "$(find frontend/src frontend/index.html -newer frontend/dist/index.html 2>/dev/null | head -1)" ]]; then
  echo "frontend sources are newer than the last build"
  needs_build=1
fi
if [[ $needs_build -eq 1 ]]; then
  echo "building the frontend…"
  (cd frontend && npm run build) >/tmp/aasthi-build.log 2>&1 || {
    echo "frontend build failed; see /tmp/aasthi-build.log" >&2
    tail -20 /tmp/aasthi-build.log >&2
    exit 1
  }
fi

echo "building the gateway…"
(cd drunix-gateway && go build -o /tmp/umigw ./cmd/gateway) || exit 1

EVM_ENV=()
if [[ $WANT_EVM -eq 1 ]]; then
  if command -v npx >/dev/null 2>&1; then
    echo "starting a local EVM chain on :$EVM_PORT…"
    npx --yes ganache@7.9.2 --wallet.deterministic --chain.chainId 1337 \
      --server.host 0.0.0.0 --server.port "$EVM_PORT" >/tmp/aasthi-evm.log 2>&1 &
    echo $! >/tmp/aasthi-evm.pid
    if wait_for_port "$EVM_PORT" 60; then
      echo "deploying DocumentRegistry.sol…"
      # The deploy script needs solc and ethers; skip the mirror rather than
      # failing the whole stack if they are missing.
      if node -e "require.resolve('solc');require.resolve('ethers')" 2>/dev/null; then
        ADDR=$(EVM_RPC_URL="http://127.0.0.1:$EVM_PORT" node contracts/deploy-local.mjs \
               | awk '/EVM_REGISTRY_ADDRESS/{print $NF}' | cut -d= -f2)
        if [[ -n "${ADDR:-}" ]]; then
          echo "  contract at $ADDR"
          EVM_ENV=(
            "EVM_RPC_URL=http://127.0.0.1:$EVM_PORT"
            "EVM_REGISTRY_ADDRESS=$ADDR"
            "EVM_SENDER_ADDRESS=0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1"
          )
        else
          echo "  deploy failed — continuing without the mirror" >&2
        fi
      else
        echo "  solc/ethers not installed: npm i --no-save solc@0.8.26 ethers@6" >&2
        echo "  continuing without the mirror" >&2
      fi
    else
      echo "  the chain did not come up — continuing without the mirror" >&2
    fi
  else
    echo "npx not found — continuing without the mirror" >&2
  fi
fi

echo "starting the UMI rail on :$RAIL_PORT…"
claim_port rail "$RAIL_PORT"
env UMI_ENABLED=true UMI_SEED_DEMO=true DRUNIX_MODE=mock PORT="$RAIL_PORT" \
    "${EVM_ENV[@]}" /tmp/umigw >/tmp/aasthi-rail.log 2>&1 &
RAIL_PID=$!
echo $RAIL_PID >/tmp/aasthi-rail.pid
wait_for_port "$RAIL_PORT" 30 || { echo "rail failed; see /tmp/aasthi-rail.log" >&2; exit 1; }
# The port being open is not proof our process opened it.
kill -0 "$RAIL_PID" 2>/dev/null || {
  echo "the rail died during startup; see /tmp/aasthi-rail.log" >&2
  tail -20 /tmp/aasthi-rail.log >&2
  exit 1
}

echo "starting the app on :$APP_PORT…"
claim_port app "$APP_PORT"
env DEMO_AUTH=true ADMIN_DASHBOARD_KEY="$ADMIN_KEY" UMI_GATEWAY_URL="http://localhost:$RAIL_PORT" \
    PORT="$APP_PORT" node server.js >/tmp/aasthi-app.log 2>&1 &
APP_PID=$!
echo $APP_PID >/tmp/aasthi-app.pid
wait_for_port "$APP_PORT" 30 || { echo "app failed; see /tmp/aasthi-app.log" >&2; exit 1; }
kill -0 "$APP_PID" 2>/dev/null || {
  echo "the app died during startup; see /tmp/aasthi-app.log" >&2
  tail -20 /tmp/aasthi-app.log >&2
  exit 1
}

echo
echo "  app        http://localhost:$APP_PORT"
echo "  verify     http://localhost:$APP_PORT/verify"
echo "  rail       http://localhost:$RAIL_PORT"
if [[ ${#EVM_ENV[@]} -gt 0 ]]; then
  echo "  evm chain  http://127.0.0.1:$EVM_PORT  (mirror live)"
  echo
  echo "  audit us from the chain, not our API:"
  echo "    ${EVM_ENV[0]} ${EVM_ENV[1]} node tests/evmmirror.test.mjs"
else
  echo "  evm chain  not running (public-chain mirror off)"
fi
echo
BUNDLE=$(grep -o 'index-[A-Za-z0-9_-]*\.js' frontend/dist/index.html 2>/dev/null | head -1)
if [[ -n "$BUNDLE" ]]; then
  echo "  bundle     $BUNDLE"
  echo "             if the page misbehaves, hard-reload (Ctrl/Cmd-Shift-R):"
  echo "             a cached older bundle looks identical to a backend fault"
fi
echo
echo "  stop with  bash scripts/dev-stack.sh --stop"
