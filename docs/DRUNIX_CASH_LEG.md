# The Drunix cash leg: making DvP one transaction

**Status: simulated.** This runs on the in-repo Drunix pipeline, not on a live NPCI network. No bank account is debited and no real value moves.

## The problem this fixes

Drunix is NPCI's Hyperledger Fabric fork, and `drunix-gateway/` models its transaction pipeline properly: a Lite Peer that endorses, an Orderer that batches, a Validation Service that checks endorsement policy and signatures, and a Committing Peer that runs MVCC validation before touching the state database.

But the chaincode only knew about tokens:

```
MintPropertyTokens   TransferTokens   DistributeYield   FreezeProperty
```

Money was not ledger state. It lived in the payment gateway, outside the chain entirely. So "atomic DvP" was implemented above the blockchain as two sequential ledger appends:

```js
drunixAppend('TOKEN_TRANSFERRED', [{ ..., atomic: 'DvP-leg-1' }]);
drunixAppend('ESCROW_RELEASED',   [{ ..., atomic: 'DvP-leg-2' }]);
```

Two appends are two transactions. If the process died between them, the securities leg was committed and the cash leg was not — the ledger recorded a delivery that was never paid for, with no way to unwind it. Labelling those two blocks `DvP-leg-1` and `DvP-leg-2` did not make them atomic; it just named the gap.

The MVCC protection the committing peer already provided covered token balances only, because those were the only keys in the read-write set. Cash could not conflict with anything, because cash was not there.

## What changed

`drunix-gateway/cash.go` puts money on the ledger and adds four chaincode functions:

| Function | Endorsement policy | Effect |
|---|---|---|
| `CreditCash` | `NPCIMSP` | Funds a party's cash position |
| `LockEscrow` | `NPCIMSP` | Moves payer cash into escrow for one payment |
| `SettleDvP` | `NPCIMSP` **AND** `AasthiChainMSP` | **Atomic**: escrow → seller, tokens → buyer |
| `RefundCash` | `NPCIMSP` | Releases a locked escrow back to the payer |

`SettleDvP` writes both legs into **one read-write set**:

```
cash~<seller>            += escrow amount
balance~<asset>~<seller> -= tokens
balance~<asset>~<buyer>  += tokens
escrow~<paymentId>        = SETTLED
```

One proposal, one endorsement round, one MVCC validation, one block. Either every write applies or none does — enforced by the pipeline that already existed, not by a mutex in an application server.

The JS servers were corrected to match: settlement now emits a single `DVP_SETTLED` block containing both legs, tagged `atomic: true` and `chaincodeFn: SettleDvP`.

## Design decisions worth defending

### Money is integer paise, never a float

Every amount is a `uint64` count of paise, stored as a decimal string. There is not one floating-point value in `cash.go`. Binary floating point cannot represent 0.1 exactly, and a rounding error inside a settlement system is not a rounding error — it is a reconciliation break that someone has to find by hand.

### Escrow is one ledger key on purpose

The escrow record is encoded into a single pipe-delimited value under `escrow~<paymentId>`. That is deliberate: two concurrent settlements of the same payment both read that one key at the same version, so the second to reach the committing peer fails MVCC validation. Splitting escrow across several keys would open exactly the double-release window this design closes.

### DvP needs two organisations to endorse

Cash-only movements need the payment operator. `SettleDvP` requires the payment operator **and** the platform, because it moves both a cash asset and a securities asset. Neither organisation can move the other's asset alone — the on-ledger expression of "neither leg without the other".

### The seller's tokens are checked before the buyer's money moves

If the seller cannot deliver, `SettleDvP` fails at endorsement and nothing is written. The buyer's cash stays in escrow and is recoverable with `RefundCash`. It was never handed over against a promise that could not be kept.

## Tests

`drunix-gateway/cash_test.go`, 15 cases, all passing under `go test -race`:

| Test | What it proves |
|---|---|
| D1 | Cash is ledger state; zero, negative, decimal and non-numeric amounts are refused |
| D2 | Locking debits the payer and pays nobody yet |
| D3 | **Both legs commit in one txId and one block**, and lock/settle are distinct transactions |
| D4 | A failing securities leg moves no cash, and the buyer can be refunded |
| D5 | Settling twice is refused; a settled escrow cannot be refunded |
| D6 | 8 concurrent settlements → seller paid exactly once |
| D7 | Cash is conserved across fund, lock, settle, lock, refund |
| D8 | No overdraft, no double-lock, no settling unknown payments |
| D9 | DvP requires both MSPs; a one-sided endorsement is rejected |
| D10 | A forged endorsement signature is rejected |
| D11 | Escrow encoding round-trips, including `max uint64`; malformed records refuse to decode |
| D12 | The settlement reaches the ledger with all five pipeline phases |
| **D13** | **MVCC catches a stale settlement** |
| **D14** | **MVCC catches a stale double-spend of cash** |
| D15 | The HTTP surface enforces the same guarantees, and replay returns 422 |

### D13 and D14 are the ones that matter

D6 looks like the concurrency test, but it is not the hard case. `Pipeline.Submit` serialises callers, so the losers there are stopped by the escrow status guard at endorsement. I verified this rather than assuming it — the failures come back as `escrow is not in LOCKED state`, not as a conflict.

D13 constructs the case the status guard cannot see. Two settlements are **endorsed while the escrow is still LOCKED**, so both pass simulation and both carry a read of `escrow~PAY-1` at the same version. They then reach the committing peer together. The first applies; the second is rejected at stage `committing-peer-mvcc` because the version it read is no longer current.

D14 does the same for a cash balance: two escrow locks endorsed against the same cash version, where the payer can only afford one. Without MVCC the second would drive an unsigned balance below zero and wrap around to an astronomically large number.

That is the difference between a system that serialises its own callers and one that is actually safe when endorsement happens in parallel.

## HTTP surface

```
GET  /drunix/cash?party=<id>              committed cash position in paise
GET  /drunix/escrow?paymentId=<id>        escrow record, 404 if unknown
POST /drunix/dvp                          {"action":"credit|lock|settle|refund", ...}
```

A successful `settle` returns an `atomicity` block naming both legs, the single `txId` and the single `blockHeight` that carried them, so the guarantee is checkable from the response alone.

## Running it

```bash
cd drunix-gateway
go test -race ./...           # all 15 cash cases plus the existing suite
go test -run TestD13 -v ./    # the MVCC case on its own
```

## What is still not modelled

- No connection to any real NPCI, RBI or bank system. The cash ledger is simulated.
- No wholesale CBDC. See `docs/UMI_ALIGNMENT_PLAN.md` for how a real e₹ leg would differ.
- `payment-gateway/gateway.go` still accepts any string as a `drunixTransferId` in `ReleasePayment`. It should verify the transaction committed on the ledger before releasing. That is the next obvious piece of work.
- Net settlement, multilateral netting and partial fills are not modelled — every DvP here is gross and bilateral.
