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

### On Windows: use WSL 2, not Git Bash

The Drunix Makefile builds fine under Git Bash, which makes Git Bash look like
the right place to run the rest. It is not. The test network is a set of shell
scripts that drive Docker with absolute paths, and Git Bash rewrites those
paths on the way through (MSYS path conversion), so volume mounts and
certificate paths arrive mangled. `network.sh` also needs `jq`, which Git Bash
does not ship, and it reads `docker-compose` as well as `docker compose`.

Run the whole thing inside a WSL 2 Ubuntu shell instead. Docker Desktop already
runs its engine there, so this removes the path translation, the missing tools
and the daemon problem in one move.

```powershell
# PowerShell, once
wsl --install -d Ubuntu
```

Then give the VM enough memory, because chaincode install compiles inside the
peer and is killed at anything under about 8 GB. Create `C:\Users\<you>\.wslconfig`:

```ini
[wsl2]
memory=8GB
processors=4
```

and run `wsl --shutdown` for it to take effect.

In **Docker Desktop**: Settings, Resources, WSL Integration, enable your Ubuntu
distribution. Settings, General, confirm "Use the WSL 2 based engine".

Then, in the Ubuntu shell:

```bash
sudo apt update && sudo apt install -y jq make curl git

# Go 1.25 or newer: both go.mod files ask for it, and Ubuntu's packaged Go is
# usually older, so take it from upstream.
curl -sSL https://go.dev/dl/go1.25.1.linux-amd64.tar.gz -o /tmp/go.tgz
sudo rm -rf /usr/local/go && sudo tar -C /usr/local -xzf /tmp/go.tgz
echo 'export PATH=/usr/local/go/bin:$PATH' >> ~/.bashrc && export PATH=/usr/local/go/bin:$PATH
go version

docker info        # must print a Server section, not an error
jq --version

# network.sh calls both "docker compose" and "docker-compose". Docker Desktop
# supplies the plugin; add the hyphenated name if it is missing:
docker compose version
command -v docker-compose || sudo ln -s ~/.docker/cli-plugins/docker-compose /usr/local/bin/docker-compose
```

Clone into the Linux home directory, not `/mnt/c`. Building a Go project
across the Windows file system boundary is slow enough to look like a hang, and
the permission bits the scripts expect do not survive the trip.

```bash
cd ~
git clone https://github.com/katepallewarprathmesh-sketch/AasthiChain.git
cd AasthiChain
bash scripts/drunix-testnet.sh
```

One more Windows detail: if a script dies with `$'\r': command not found`, Git
checked it out with CRLF line endings. Fix it with
`git config --global core.autocrlf input` and clone again inside WSL.

### Correction 7: pull the chaincode builder images first (15 October 2026)

Installing Go chaincode makes the peer shell out to Docker and build an image
from `npcioss/drunix-ccenv`, with `npcioss/drunix-baseos` as the runtime base.
The peer does not pull either one, and `network.sh up` does not bring them
down, so a first run gets all the way through packaging and then stops with:

```
Error: chaincode install failed with status: 500 ... docker build failed:
Error creating container: Error response from daemon:
No such image: npcioss/drunix-ccenv:1.0
```

The tag matters. Everything else in the network runs at `1.0.0`, and the
builder is requested as `1.0`. Both tags exist on Docker Hub and point at the
same thing, but the peer asks for the short one.

```bash
docker pull npcioss/drunix-ccenv:1.0
docker pull npcioss/drunix-baseos:1.0
```

`scripts/drunix-testnet.sh` now does this before `deployCC`. Reported from a
real run on WSL 2 with 8 GB, which got past the memory ceiling that stopped the
14 October attempt.

### The run that worked (15 October 2026, WSL 2, 8 GB)

The full sequence completed on a developer laptop: network up, `mychannel`
created and joined by both orgs with anchor peers, chaincode packaged,
installed on both peers, approved by `Org1MSP` and `Org2MSP`, committed at
sequence 1, and the settlement rail connected with `DRUNIX_MODE=real`.

```
{"channel":"mychannel","height":0,"txCount":0,"mode":"real",
 "network":"NPCI Drunix (Hyperledger Fabric fork), peer dns:///localhost:7051"}
```

Two findings came out of it, and neither is a defect in this repository.

**1. The sample network's org names do not match the chaincode's model.** A
write was refused by the chaincode itself, during endorsement:

```
chaincode response 500, ERR_UNAUTHORIZED:
MSP Org1MSP not authorized, requires one of [OriginatorMSP]
```

That message is `requireMSP` in `chaincode/property.go`, executed inside the
peer against the caller's real certificate. The Drunix test network ships the
Fabric sample orgs, `Org1MSP` and `Org2MSP`, while the chaincode's
authorisation model uses `OriginatorMSP`, `RegistrarMSP` and `InvestorMSP`.
`creatorMsp` in the request body cannot change this and is ignored in real
mode: the MSP comes from the signing identity, which is the point of it.

Writing through the chaincode on a real network therefore needs crypto
material generated for the business org names, which is a `cryptogen` and
`configtx.yaml` change in the test network. Loosening `requireMSP` to accept
`Org1MSP` would make a demo pass by removing the control it demonstrates, so
it has not been done.

**2. Queries work, and the refusal above is itself the proof of integration.**
`GetAllProperties` has no MSP gate and evaluated cleanly against the live
peer. An unauthorised write and an authorised read, both answered by chaincode
running in the peer, is end to end evidence that nothing in this repository
can produce on its own.

### Making a real write possible: business MSP names

The sample network's orgs are `Org1MSP` and `Org2MSP`. The chaincode's
authorisation model is built on `OriginatorMSP`, `RegistrarMSP` and
`InvestorMSP`, so every write from a sample identity is refused during
endorsement, correctly. The fix belongs in the network:

```bash
cd ~/AasthiChain
bash scripts/drunix-business-msps.sh
```

It renames org1 to `OriginatorMSP` and org2 to `RegistrarMSP` across
`configtx.yaml`, the compose file, `envVar.sh`, `setOrgEnv.sh`,
`deployCC.sh`, `deployCCAAS.sh` and the connection profile generator. The MSP
ID is configuration rather than cryptography, so no certificate is reissued
and no hostname, directory or port moves. `deployCC.sh` is in that list
because it greps the commit readiness output for the literal `"Org1MSP":
true`; miss it and a successful deploy reports itself as a failure.

The rename must happen with the network **down**. The MSP IDs are written into
the channel genesis block, so renaming under a live channel strands every
peer. The script refuses to run while `lp1.org1` is up.

```bash
cd ~/drunix-lab/drunix/drunix-network/test-network
./network.sh down
./network.sh up
./network.sh createChannel -c mychannel
./network.sh deployCC -c mychannel -ccn aasthichain -ccp $HOME/AasthiChain/chaincode -ccl go
```

Then start the rail with `DRUNIX_MSP_ID=OriginatorMSP` and everything else
unchanged. The same certificate, the same peer, a different name on the org,
and `RegisterProperty` is endorsed instead of refused.

`bash scripts/drunix-business-msps.sh --revert` restores the sample names from
the `.sample-msp` backups the script takes on its first run. Verified by
applying, re-running and reverting against a clean clone: the restored files
are byte identical to the originals.

Two limits worth stating. The test network has two orgs, so `InvestorMSP` has
no home here; token transfers accept `OriginatorMSP` as well, which covers the
demo path. And `RegisterProperty` takes six arguments: title, state, city,
pincode, valuation and document hash. The asset id is generated by the
chaincode, not supplied.

### Correction 8: the commit readiness poll gives up too early

After the MSP rename the deploy reported:

```
{"approvals": {"OriginatorMSP": true, "RegistrarMSP": false}}
After 5 attempts, Check commit readiness result on peer0.org1 is INVALID!
Deploying chaincode failed
```

The approvals in that output are exactly what the step expects at that point,
which is the tell: the definition was fine and the poll ran out of patience.
`checkCommitReadiness` retries `MAX_RETRY` times with `CLI_DELAY` seconds
between tries, 5 and 3 by default, so it waits about twelve seconds. Drunix
keeps channel state in YugabyteDB rather than LevelDB, and on a laptop an
approval can take longer than that to become visible on the peer being polled.

Ask for more patience rather than a different answer:

```bash
./network.sh deployCC -c mychannel -ccn aasthichain -ccp $HOME/AasthiChain/chaincode -ccl go \
  -ccs 1 -r 15 -d 5
```

`-ccs 1` pins the sequence so a retry does not bump it past the approvals
already recorded. `scripts/drunix-testnet.sh` now passes `-r 15 -d 5` by
default, tunable with `DRUNIX_CC_RETRY` and `DRUNIX_CC_DELAY`.

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
