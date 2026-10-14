# Running AasthiChain on Drunix

Drunix is NPCI's re-engineered Hyperledger Fabric, published at
[github.com/npci/drunix](https://github.com/npci/drunix) (v1.0.0, Apache licensed). Its stated
difference from stock Fabric is horizontal scaling: the peer is split, and the test network runs
YugabyteDB as the state database.

This page says exactly what in this repository is Drunix, what runs on it today, and what is needed
to point it at a real network. Every version and interface below was checked against the upstream
repository rather than assumed.

Nothing on this page is aspirational. Where something is not connected, it says so.

## What this repository contains

| Piece | Where | What it is |
|---|---|---|
| Chaincode | `chaincode/` | The contracts themselves: `PropertyContract` (register, validate, mint, freeze, read), `TokenContract` (transfer, balance, history, wallet, settlement), `KYCContract`. Written against the Fabric contract API, so this is the part that would be installed on a Drunix channel. |
| Transaction pipeline | `drunix-gateway/peer.go` | Our Go implementation of the Drunix architecture: Lite Peer endorsement with read-write set generation, a RAFT orderer, a stateless Validation Service doing policy and signature checks, and a Committing Peer doing MVCC validation before commit. This is what runs in the demo. |
| Real-network adapter | `drunix-gateway/fabric_real.go` | A Fabric Gateway client. Built only with `-tags real`. Opens a gRPC connection with an X.509 enrolment and submits to a channel and chaincode. |
| Client abstraction | `drunix-gateway/client.go` | `DrunixClient`, the interface both of the above satisfy. The rest of the application depends on this and on nothing else, which is what makes the swap a configuration change. |
| Fabric network | `network/` | A docker-compose Fabric test network with channel and chaincode deployment scripts. |

## What actually runs in the demo

The simulator, `MockLedger`, driving the pipeline in `peer.go`. Blocks are real blocks with real
hash linking and real MVCC conflict detection; the network underneath them is in-process.

`/api/trust` reports this as `simulated`, and the startup log says
`Drunix mode: mock, deterministic Fabric-fork simulator`.

## What was checked against upstream

| Question | Answer, from the npci/drunix tree |
|---|---|
| How does an application talk to Drunix? | It ships `internal/pkg/gateway`, the Fabric Gateway service. So the Fabric Gateway client is the right client, which is what `fabric_real.go` uses. |
| Which client library version? | Their `application-gateway-go` samples pin **`fabric-gateway v1.10.0`**. This repository is pinned to the same v1.10.x line, and `TestGatewaySDKMatchesDrunixSamples` fails if that drifts. |
| Which chaincode API? | Their samples use **`fabric-contract-api-go/v2 v2.2.0`** and **`fabric-chaincode-go/v2 v2.0.0`**. `chaincode/` was on the v1 line and has been migrated to v2. |
| What does an endpoint look like? | Their sample uses `dns:///localhost:7051` with a separate gateway-peer name for the TLS server name. Both forms work here: pass either `host:port` or `dns:///host:port` in `DRUNIX_PEER_ENDPOINT`, and set `DRUNIX_TLS_SERVER_NAME` to the peer's certificate name. |
| Is there a network to test against? | Yes: `drunix-network/test-network` with `createChannel.sh` and `deployCC.sh`, plus cryptogen and fabric-ca material, a YugabyteDB state store and a Prometheus and Grafana stack. |

One consequence worth stating: because Drunix keeps the Fabric Gateway interface, a correct Fabric
client is a correct Drunix client. That is why the adapter is thin and why the compatibility risk
sits in versions rather than in protocol.

### The v2 chaincode migration

`fabric-chaincode-go/v2` dropped `shimtest`, which the chaincode tests used for a mock stub. Rather
than stay on an API Drunix does not use, the tests now carry a small stand-in that implements the
composite-key functions to Fabric's wire format (`U+0000` namespace and separators) along with the
creator and transaction boundaries. `contractapi.NewChaincode` is still constructed in the tests,
because that is what rejects a contract whose method signatures a peer could not serve.

## Switching to a real Drunix network

```bash
cd drunix-gateway
go build -tags real -o /tmp/umigw ./cmd/gateway

DRUNIX_MODE=real \
DRUNIX_PEER_ENDPOINT=peer0.example.org:7051 \
DRUNIX_MSP_ID=OriginatorMSP \
DRUNIX_CERT_FILE=/path/to/signcerts/cert.pem \
DRUNIX_KEY_FILE=/path/to/keystore \
DRUNIX_TLS_CERT=/path/to/tls/ca.crt \
DRUNIX_CHANNEL=property-channel \
DRUNIX_CHAINCODE=aasthichain \
/tmp/umigw
```

| Variable | Required | Notes |
|---|---|---|
| `DRUNIX_MODE=real` | yes | Without it the node runs the simulator |
| `DRUNIX_PEER_ENDPOINT` | yes | `host:port` of the peer gateway. `DRUNIX_API_HOST` plus `DRUNIX_API_PORT` also works |
| `DRUNIX_MSP_ID` | yes | The MSP the signing identity belongs to |
| `DRUNIX_CERT_FILE` | yes | PEM X.509 certificate of the enrolment |
| `DRUNIX_KEY_FILE` | yes | PEM private key, or an MSP keystore directory holding exactly one |
| `DRUNIX_TLS_CERT` | yes | TLS CA of the peer. Omit only with `DRUNIX_TLS_INSECURE=true` |
| `DRUNIX_TLS_SERVER_NAME` | no | Server-name override when the endpoint differs from the certificate |
| `DRUNIX_CHANNEL` | no | Default `property-channel` |
| `DRUNIX_CHAINCODE` | no | Default `aasthichain` |
| `DRUNIX_FALLBACK_MOCK` | no | `true` lets the node continue on the simulator when the connection fails. Off by default, deliberately |

### Two behaviours worth knowing

**The adapter refuses rather than degrades.** If the endpoint, the enrolment or the TLS trust root
is missing, `NewFabricGateway` returns an error and the process exits with a message naming the
setting that is missing. A node told to be real and unable to be real is a configuration problem,
not something to paper over.

This replaced the opposite behaviour. The previous adapter reported mode `real` and then served
every call from the in-process simulator. `TestRealAdapterHasNoSimulatorFallback` exists so that
cannot come back.

**Reads are never submitted.** `GetPropertyDetails`, `GetAllProperties`, `GetBalance`,
`GetTransferHistory`, `GetWallet` and `GetKYCStatus` are evaluated against an endorsing peer. The
rest are endorsed, ordered and committed. Submitting a query would consume a block and make a read
look like a state change in the ledger history.

## What is verified, and what is not

**Verified in CI**, by the `drunix-real` job on every push:

- the tagged build compiles and vets clean,
- the adapter refuses to start without an endpoint, an enrolment or a TLS decision,
- an unusable TLS file is rejected rather than trusted,
- a keystore with one key works, an empty or ambiguous one is an error,
- reads are evaluate-only and writes are submit-only,
- the adapter contains no path back to the simulator.

**Not verified, and it cannot be from this repository alone:** that the adapter successfully
transacts against a real Drunix peer. That needs an endpoint, a channel and an enrolment issued by
the network's operator. Until this has been run against one, the honest statement is "the client
is implemented and tested up to the connection boundary", and `/api/trust` continues to report
Drunix as simulated.

## Running against a network

### Against the Drunix test network (the one that proves the mandate)

Needs **Docker, Go, git and jq** on a machine you control. Every value below was read from
`drunix-network/test-network/compose/compose-test-net.yaml` and that network's README, not guessed:
Org1's lite peer `lp1.org1` is `peer0.org1.example.com:7051` and is published on host port 7051,
and the default channel is `mychannel`.

Steps 1 to 3 are scripted, with every correction from the run below already
applied:

```bash
bash scripts/drunix-testnet.sh
```

It checks the prerequisites first and stops with the reason rather than
half-starting. The same thing by hand:

```bash
# 1. Get Drunix. The binaries come out of the published images, not a source
#    build: network.sh refuses to run when the local peer version and the
#    image version differ, and the images are the ones that are 1.0.0.
git clone https://github.com/npci/drunix.git
cd drunix/drunix-network
mkdir -p bin
cid=$(docker create npcioss/drunix-peer:1.0.0)    && docker cp $cid:/usr/local/bin/peer bin/peer       && docker rm $cid
cid=$(docker create npcioss/drunix-orderer:1.0.0) && docker cp $cid:/usr/local/bin/orderer bin/orderer && docker rm $cid
# cryptogen, configtxgen, configtxlator and osnadmin are not in the images:
curl -sSLO https://raw.githubusercontent.com/hyperledger/fabric/main/scripts/install-fabric.sh
chmod +x install-fabric.sh && ./install-fabric.sh binary
export PATH=$PWD/bin:$PATH

# 2. Bring the network up, then create the channel. YugabyteDB is the default
#    state store and takes 60 to 90 seconds to open YSQL. The peers connect at
#    boot, panic when it is not ready and have no restart policy, so wait and
#    start whatever exited before creating the channel.
cd test-network
./network.sh up
docker ps -a            # any exited peer: docker start <name>
./network.sh createChannel -c mychannel

# 3. Deploy this repository's chaincode onto that channel. go must be on the
#    PATH of whoever runs this, sudo included.
(cd /path/to/AasthiChain/chaincode && go mod vendor)
./network.sh deployCC -c mychannel -ccn aasthichain -ccp /path/to/AasthiChain/chaincode -ccl go

# 4. Point the settlement rail at the peer
cd /path/to/AasthiChain/drunix-gateway
go build -tags real -o /tmp/umigw ./cmd/gateway

CRYPTO=/path/to/drunix/drunix-network/test-network/organizations/peerOrganizations/org1.example.com
DRUNIX_MODE=real \
DRUNIX_PEER_ENDPOINT=dns:///localhost:7051 \
DRUNIX_MSP_ID=Org1MSP \
DRUNIX_CERT_FILE=$CRYPTO/users/User1@org1.example.com/msp/signcerts/cert.pem \
DRUNIX_KEY_FILE=$CRYPTO/users/User1@org1.example.com/msp/keystore \
DRUNIX_TLS_CERT=$CRYPTO/peers/peer0.org1.example.com/tls/ca.crt \
DRUNIX_TLS_SERVER_NAME=peer0.org1.example.com \
DRUNIX_CHANNEL=mychannel \
DRUNIX_CHAINCODE=aasthichain \
UMI_ENABLED=true PORT=21100 /tmp/umigw
```

A successful start logs `Drunix mode: REAL, connected to dns:///localhost:7051 as MSP Org1MSP`. A
failure names the setting that is wrong and exits, which is the intended behaviour.

Then prove it from outside the process:

```bash
curl -s localhost:21100/drunix/ledger/status      # mode should read "real", with the channel name
curl -s -X POST localhost:21100/drunix/submit -H 'Content-Type: application/json' \
  -H 'X-Fabric-Identity: originator1' -H 'X-Identity-Role: Originator' \
  -d '{"chaincode":"aasthichain","function":"RegisterProperty","args":["PROP-DRUNIX-001","Demo flat","Maharashtra","Pune","411045","5000000","0000000000000000000000000000000000000000000000000000000000000000"],"creatorMsp":"Org1MSP"}'
```

A committed response carries a real Fabric transaction id and block number from the peer, which is
the artefact worth keeping: it is evidence this ran, and nothing in this repository can fabricate
it.

**Likely snag:** the chaincode builder may have no network access when it compiles the package. If
`deployCC` fails while fetching modules, run `go mod vendor` inside `chaincode/` first and deploy
again.

### What happened when this was attempted (14 October 2026)

Most of the sequence above has now been run, in a 2 GB development sandbox. It got as far as a
live Drunix network with a channel, and stopped on memory rather than on anything to do with this
repository. Recorded here because the corrections below save the next person an afternoon.

**Reached:**

- Drunix v1.0.0 images pull straight from Docker Hub: `npcioss/drunix-peer`, `npcioss/drunix-orderer`,
  `npcioss/drunix-vscc`. Nothing has to be built from source to run the network.
- The network came up: 11 containers, the orderer, two lite peers, two committing peers, two
  validation services, two YugabyteDB nodes and two KeyDB nodes.
- `./network.sh createChannel -c mychannel` succeeded. Both organisations joined and both anchor
  peers were set, against the real Drunix orderer.
- This repository's chaincode packaged cleanly against their tooling:
  `aasthichain_1.0:3e2783506deb8b489466ec0db5a339d6c51d3592f838ed7f6d9c24a61fc52a82`.

**Stopped at:** `peer lifecycle chaincode install` was killed with exit 137, which is the kernel
out-of-memory killer, and the Docker daemon was killed shortly after. Installing a chaincode
compiles it inside the peer, and 2 GB with eleven containers already running is not enough.
**Budget about 8 GB of RAM and 4 cores.** Nothing here suggests a problem with the chaincode: it
packaged, and the package id above is the peer's own hash of it.

**Corrections to the steps above, all learned the hard way:**

1. `make peer orderer ...` is not needed. Copy the binaries out of the published images instead,
   which also guarantees the version check in `network.sh` passes:
   `docker create npcioss/drunix-peer:1.0.0` then `docker cp <id>:/usr/local/bin/peer bin/peer`,
   and the same for the orderer. The images carry only those two.
2. `cryptogen`, `configtxgen`, `configtxlator` and `osnadmin` are not in the images. Stock Fabric
   v2.5 binaries work: `curl -sSLO https://raw.githubusercontent.com/hyperledger/fabric/main/scripts/install-fabric.sh && ./install-fabric.sh binary`.
   Only `peer` and `orderer` have to be the Drunix builds, because only those are version-checked.
3. `network.sh` calls both `docker-compose` and the compose plugin. Install Compose v2 and symlink
   it to `/usr/local/bin/docker-compose`, or the network silently starts nothing.
4. **The peers race YugabyteDB and lose.** Yugabyte takes 60 to 90 seconds to open YSQL on 5433,
   the peers connect at start and panic with `connection refused` when it is not ready, and they
   have no restart policy. Nothing in `network.sh` waits. If the peer containers are missing after
   `./network.sh up`, this is why: `docker start` them once Yugabyte is listening.
5. `go` has to be on the PATH of the user running the script, including under `sudo`, or packaging
   fails with `failed to determine module root`.
6. Run `go mod vendor` in `chaincode/` before deploying. Their `deployCC` vendors too, but doing it
   first keeps the build off the network.

**Still not done:** no transaction has been committed to a Drunix peer by this repository's rail.
Until that happens and the output is kept, `/api/trust` continues to report Drunix as simulated.

### Against the bundled Fabric network

`network/` brings up a stock Fabric test network with docker-compose, creates the channel and
deploys the chaincode. Also Docker, also outside CI.

```bash
make network      # compose up, create channel, deploy chaincode
```

The enrolment it generates lands under `network/crypto-config/...`, which is what the
`DRUNIX_CERT_FILE` and `DRUNIX_KEY_FILE` paths above should point at. For a plaintext local
network, set `DRUNIX_TLS_INSECURE=true` rather than leaving the TLS variable empty and hoping.
