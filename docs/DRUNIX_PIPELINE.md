# Drunix LP/CP Pipeline (Go) — slide-to-code map

Implementation: `drunix-gateway/peer.go` (+ `peer_test.go`, HTTP in `server.go`,
wired in `cmd/gateway/main.go`). All Go, as Drunix is.

| Slide concept | Code | Proof (go test) |
|---|---|---|
| Lite Peer (LP): stateless endorser, executes chaincode, generates RW Sets, manages private data in KeyDB, no local ledger | `LitePeer.Endorse()` | TestPipelineMintCommits, TestTransientPrivateDataLifecycle |
| Read-Write Set: keys read (with versions) during simulation + keys written | `RWSet{Reads, Writes}` + `simulateChaincode()` | TestPipelineTransfer |
| Transient Store (KeyDB): in-memory private data, LP to CP within an org, never persisted | `TransientStore` (Put/Take); block records only SHA-512 hash; entries consumed on apply | TestTransientPrivateDataLifecycle (asserts values never reach the ledger, store empty after commit) |
| Endorsement Policy: required endorsers, verified by the Validation Service | `EndorsementPolicy.SatisfiedBy()` (AND semantics, per-function policies: mint = AND(OriginatorMSP, RegistrarMSP), freeze = RegulatorMSP) | TestEndorsementPolicyRejected |
| Validation Service (VSCC): stateless, policy acceptance + cryptographic signature verification | `ValidationService.Validate()` with HMAC-SHA512 org keys (simulated PKI) | TestTamperedProposalRejected |
| MVCC Validation: read-write conflicts of concurrent txs detected before commit | `CommittingPeer.mvccValidate()` (read versions vs current state versions) | TestMVCCReadConflict (double spend: first commits, second rejected, victim receives nothing) |
| Committing Peer (CP): MVCC, private data application, apply write set to state DB | `CommittingPeer.Commit()` stages 2 to 4 | TestMVCCReadConflict, TestPipelineMintCommits |
| Orderer (Raft consensus) | `Orderer` (deterministic leader election + sequence; labeled RAFT simulated) | TestOrdererRotation |
| State DB (Yugabyte in production) | `StateDB` versioned KV, versions bump on apply | all tests |
| Client → DLT-Gateway → pipeline | `Pipeline.Submit()` + `POST /drunix/pipeline` | live curl below |

## Run it

```bash
cd drunix-gateway && go test ./...          # 19 tests green
go run ./cmd/gateway                         # :21100

# Full pipeline round-trip:
curl -X POST localhost:21100/drunix/pipeline -H 'Content-Type: application/json' \
  -d '{"fn":"MintPropertyTokens","args":["PROP-1","originator1","1000"]}'
curl -X POST localhost:21100/drunix/pipeline -H 'Content-Type: application/json' \
  -d '{"fn":"TransferTokens","args":["PROP-1","originator1","investor1","250"],
       "private":{"InvestorMSP":{"pan":"ABCPX1234F"}}}'
curl localhost:21100/drunix/pipeline/stats
```

## What the stages prove (judge narrative)

1. LP simulation rejects double spends BEFORE ordering (insufficient balance).
2. RAFT orderer stamps leader + sequence (leader rotates 1, 2, 3).
3. VSCC rejects missing endorsers (policy AND not satisfied) and any
   post-endorsement tampering (signature mismatch).
4. CP rejects concurrent conflicting writes with a precise MVCC READ_CONFLICT
   (key, simulated version vs current version), so the same token can never be
   spent twice even when two transactions race.
5. Private data crosses LP to CP through the transient store, integrity-checked
   against the signed proposal hash, and only the hash is committed.
6. Every committed transaction is a block on the same hash-chained Drunix
   ledger that backs the product UI (Ledger Explorer), so the architecture
   slides and the running product are the same system.
