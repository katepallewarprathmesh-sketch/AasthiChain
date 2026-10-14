# Running AasthiChain on Drunix

Drunix is NPCI's enterprise fork of Hyperledger Fabric. This page says exactly what in this
repository is Drunix, what runs on it today, and what is needed to point it at a real network.

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

## Running against the local Fabric network

`network/` brings up a Fabric test network with docker-compose, creates the channel and deploys the
chaincode. It needs Docker and the Fabric binaries, and it is not part of the demo path or of CI.

```bash
make network      # compose up, create channel, deploy chaincode
```

The enrolment it generates lands under `network/crypto-config/...`, which is what the
`DRUNIX_CERT_FILE` and `DRUNIX_KEY_FILE` paths above should point at. For a plaintext local
network, set `DRUNIX_TLS_INSECURE=true` rather than leaving the TLS variable empty and hoping.
