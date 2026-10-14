#!/usr/bin/env bash
# Bring up the real Drunix test network and deploy this repository's chaincode.
#
#   bash scripts/drunix-testnet.sh
#
# Needs Docker, Go, git and jq, and about 8 GB of RAM. The steps are the ones
# in docs/DRUNIX.md, with the six corrections that were found by running them:
# binaries come out of the published images rather than a source build, Compose
# has to be reachable under both names, and the peers have to wait for
# YugabyteDB instead of racing it.
#
# Everything lands in a work directory you can delete. Nothing here touches the
# application, and no part of it runs automatically.

set -euo pipefail

WORKDIR="${DRUNIX_WORKDIR:-$HOME/drunix-lab}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHANNEL="${DRUNIX_CHANNEL:-mychannel}"
CC_NAME="${DRUNIX_CHAINCODE:-aasthichain}"
IMG_TAG="${DRUNIX_IMAGE_TAG:-1.0.0}"

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mSTOP: %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 0. the box
say "Checking prerequisites"
for bin in docker go git jq curl; do
  command -v "$bin" >/dev/null || die "$bin is not on PATH"
done
docker info >/dev/null 2>&1 || die "the Docker daemon is not reachable"

# network.sh calls BOTH "docker compose" and "docker-compose". Missing either
# one makes it start nothing and print Docker's help text instead of an error.
docker compose version >/dev/null 2>&1 || die "the Docker Compose plugin is missing"
command -v docker-compose >/dev/null 2>&1 || die \
  "docker-compose is not on PATH. Symlink the plugin:
   sudo ln -sf /usr/libexec/docker/cli-plugins/docker-compose /usr/local/bin/docker-compose"

TOTAL_KB=$(awk '/MemTotal/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)
if [ "$TOTAL_KB" -gt 0 ] && [ "$TOTAL_KB" -lt 7000000 ]; then
  printf '\033[1;33mWarning: %s GB of RAM. Chaincode install was killed by the OOM killer at 2 GB. 8 GB is the working figure.\033[0m\n' \
    "$((TOTAL_KB / 1000000))"
fi

mkdir -p "$WORKDIR"
cd "$WORKDIR"

# ------------------------------------------------------------- 1. the source
if [ ! -d drunix ]; then
  say "Cloning Drunix"
  git clone --depth 1 https://github.com/npci/drunix.git drunix
else
  say "Reusing $WORKDIR/drunix"
fi
NET="$WORKDIR/drunix/drunix-network"
BIN="$NET/bin"
mkdir -p "$BIN"

# ----------------------------------------------------------- 2. the binaries
# Correction 1: no source build. network.sh compares the local peer version
# with the image version and refuses to start when they differ, so peer and
# orderer are taken out of the images themselves. They are the only two
# binaries the images carry.
if [ ! -x "$BIN/peer" ] || [ ! -x "$BIN/orderer" ]; then
  say "Taking peer and orderer out of the published Drunix images"
  for pair in "peer:npcioss/drunix-peer" "orderer:npcioss/drunix-orderer"; do
    name="${pair%%:*}"; image="${pair#*:}:$IMG_TAG"
    docker pull -q "$image"
    cid="$(docker create "$image")"
    docker cp "$cid:/usr/local/bin/$name" "$BIN/$name"
    docker rm -f "$cid" >/dev/null
  done
  chmod +x "$BIN/peer" "$BIN/orderer"
fi

# Correction 2: cryptogen, configtxgen, configtxlator and osnadmin are not in
# the images. Stock Fabric builds work, and only peer and orderer are checked.
if [ ! -x "$BIN/cryptogen" ]; then
  say "Fetching the stock Fabric tooling (cryptogen, configtxgen, osnadmin)"
  cd "$NET"
  curl -sSLO https://raw.githubusercontent.com/hyperledger/fabric/main/scripts/install-fabric.sh
  chmod +x install-fabric.sh
  ./install-fabric.sh binary
fi

export PATH="$BIN:$PATH"
say "Versions in use"
peer version | sed -n '1,2p'
orderer version | sed -n '1,2p'

# ------------------------------------------------------------- 3. the network
cd "$NET/test-network"
say "Starting the network (this pulls YugabyteDB and KeyDB on a first run)"
./network.sh up

# Correction 4: the peers connect to YugabyteDB at boot, Yugabyte needs 60 to
# 90 seconds to open YSQL on 5433, and the peers panic and exit with no restart
# policy. network.sh does not wait. Wait here, then start whatever died.
say "Waiting for YugabyteDB to accept connections"
for _ in $(seq 1 60); do
  if docker exec yugabyte-org1 bash -c 'bin/ysqlsh -h $(hostname) -c "select 1"' >/dev/null 2>&1; then
    echo "    YugabyteDB is up"; break
  fi
  sleep 5
done

say "Starting any node that lost the race with the database"
for c in lp1.org1 cp.org1 vs1.org1 lp1.org2 cp.org2 vs1.org2 orderer.example.com; do
  if [ -n "$(docker ps -aq -f name="^${c}$" -f status=exited)" ]; then
    echo "    restarting $c"
    docker start "$c" >/dev/null
    sleep 4
  fi
done
sleep 10
docker ps --format '    {{.Names}}  {{.Status}}'

# ------------------------------------------------------------- 4. the channel
say "Creating channel $CHANNEL"
./network.sh createChannel -c "$CHANNEL"

# ----------------------------------------------------------- 5. the chaincode
# Correction 5: go must be on the PATH of whoever runs this, including under
# sudo, or packaging fails with "failed to determine module root".
# Correction 6: vendor first, so the build does not need the network.
say "Vendoring the chaincode dependencies"
( cd "$REPO/chaincode" && go mod vendor )

say "Deploying $CC_NAME from $REPO/chaincode"
./network.sh deployCC -c "$CHANNEL" -ccn "$CC_NAME" -ccp "$REPO/chaincode" -ccl go

cat <<DONE

Network up, channel $CHANNEL, chaincode $CC_NAME deployed.

Next, in another shell, point the settlement rail at the peer:

  cd $REPO/drunix-gateway
  go build -tags real -o /tmp/umigw ./cmd/gateway

  CRYPTO=$NET/test-network/organizations/peerOrganizations/org1.example.com
  DRUNIX_MODE=real \\
  DRUNIX_PEER_ENDPOINT=dns:///localhost:7051 \\
  DRUNIX_MSP_ID=Org1MSP \\
  DRUNIX_CERT_FILE=\$CRYPTO/users/User1@org1.example.com/msp/signcerts/cert.pem \\
  DRUNIX_KEY_FILE=\$CRYPTO/users/User1@org1.example.com/msp/keystore \\
  DRUNIX_TLS_CERT=\$CRYPTO/peers/peer0.org1.example.com/tls/ca.crt \\
  DRUNIX_TLS_SERVER_NAME=peer0.org1.example.com \\
  DRUNIX_CHANNEL=$CHANNEL \\
  DRUNIX_CHAINCODE=$CC_NAME \\
  UMI_ENABLED=true PORT=21100 /tmp/umigw

Then prove it from outside the process:

  curl -s localhost:21100/drunix/ledger/status

  curl -s -X POST localhost:21100/drunix/submit \\
    -H 'Content-Type: application/json' \\
    -H 'X-Fabric-Identity: originator1' -H 'X-Identity-Role: Originator' \\
    -d '{"chaincode":"$CC_NAME","function":"RegisterProperty","args":["PROP-DRUNIX-001","Demo flat","Maharashtra","Pune","411045","5000000","0000000000000000000000000000000000000000000000000000000000000000"],"creatorMsp":"Org1MSP"}'

Keep that last response. The transaction id and block number in it come from
the peer, and nothing in this repository can produce them.

Tear the whole thing down with:

  cd $NET/test-network && ./network.sh down

DONE
