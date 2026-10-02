# UMI Integration — RBI Unified Market Interface rail for AasthiChain

**Status:** design + reference implementation (Go), additive to v1.8. Nothing existing is modified except
3 route-registration lines in `drunix-gateway/server.go` and one proxy block in `mock-api-server.js`.

---

## 1. What UMI actually is (and what we are modelling)

On 10 September 2026 at the Global Fintech Fest, SEBI and RBI jointly launched **Demat 2.0** — a SEBI
Regulatory-Sandbox pilot in which a corporate bond is issued as a **native token on a permissioned DLT owned
by the depositories**, with the **cash leg settled in RBI wholesale CBDC (e₹-W)** through the RBI's
**Unified Market Interface (UMI)**. REC, L&T and IIFL raised ₹1,025 crore in the first phase.

So, precisely:

| Layer | Owner | What it does |
|---|---|---|
| Securities leg | Depositories' permissioned ledger (DLT) | the asset token itself — issue, hold, transfer |
| **UMI** | **RBI** | **the bridge/interface that lets the cash leg settle in wholesale central bank money** |
| Cash leg | RBI wholesale CBDC (e₹-W wallets at banks) | money movement |
| Result | | **atomic DvP** — asset and money move as one linked transaction, or neither moves |
| Servicing | smart contracts on the shared ledger | coupon/redemption credited straight to holders' CBDC wallets |

UMI is **not** a public chain, not a token standard, and not an SDK you install. It is a settlement
*interface* between a tokenised-asset ledger and central-bank money. The only thing an application like
AasthiChain can implement today is a **UMI-pattern settlement rail**: the message flow, the two-leg lock,
the atomic commit/abort, the CBDC wallet model and the servicing hook — pilot-shaped, sandbox-honest.

AasthiChain already has the two ends of that sandwich:

* securities leg → Drunix (NPCI's Fabric fork) property fraction tokens, hash-chained ledger
* money leg → UPI / PayU / Sepolia escrow

What was missing is exactly the middle: a **central-bank-money settlement interface with atomic DvP and
programmable servicing**. That is what this module adds — as the *third*, clearly-labelled rail, sitting
beside UPI and the testnet escrow, never replacing them.

## 2. Design principles (why it is built this way)

1. **Purely additive.** New Go files (`umi*.go`) in the existing `drunix-gateway` package, new `/umi/*`
   routes, new Node proxy path `/api/umi/*`, new frontend page `/umi`. No existing endpoint, type,
   state container or UI component changes behaviour.
2. **Backend in Go.** All UMI state and settlement logic lives in Go — the same language as Drunix and the
   rest of the chain tier. Node keeps *zero* UMI business logic; `mock-api-server.js` only reverse-proxies
   `/api/umi/*` to the Go rail (and reports `unavailable` if the rail is not running, so the existing demo
   never breaks).
3. **Honest labelling.** Every response carries `"mode": "simulation"` and
   `"disclaimer": "Pattern simulation of RBI's Unified Market Interface..."`. We do not claim RBI
   connectivity. This matches the repo's existing rule (see the v1.7 "no fake hash" fix).
4. **Dependency inversion.** The rail talks to a `SecuritiesLedger` interface for the asset leg, so it works
   against the in-memory demo positions today and against live chaincode (`chaincode/token.go`) later with
   no change to the settlement engine.
5. **Everything commits to the existing Drunix chain.** New block types only — `UMI_WALLET_FUNDED`,
   `UMI_ISIN_ASSIGNED`, `UMI_DVP_SETTLED`, `UMI_DVP_FAILED`, `UMI_SERVICING_PAID` — so the Ledger Explorer
   and `/api/chain/verify` keep working unchanged and now also prove the settlement rail.

## 3. Architecture

```
          Investor (frontend /umi)
                   │
                   ▼
   mock-api-server.js  /api/umi/*     ← thin reverse proxy, no logic
                   │
                   ▼
   drunix-gateway (Go, :21100)
   ┌───────────────────────────────────────────────────────┐
   │  UMIRail                                              │
   │   • e₹-W wallet book (paise, reserved vs available)   │
   │   • pilot ISIN registry (Demat 2.0 style flag)        │
   │   • settlement engine: 2-leg lock → atomic commit     │
   │   • ISO 20022 message trace per instruction           │
   │   • asset servicing (coupon/rent → CBDC wallets)      │
   │   • reconciliation + conservation-of-money invariant  │
   └──────┬─────────────────────────────┬──────────────────┘
          │ SecuritiesLedger iface      │ *DrunixChain
          ▼                             ▼
   Drunix token positions        hash-chained blocks (SHA-512)
```

### Settlement state machine (atomic DvP)

```
RECEIVED ──validate──► MATCHED ──lock both legs──► LOCKED ──commit──► SETTLED
    │                     │                          │
    └─────────────────────┴──────────────────────────┴──► FAILED  (nothing moved)
```

The lock step earmarks securities *and* reserves cash **before** either moves. Commit applies both write
sets in one critical section under a single mutex; if anything fails, both locks are released and the
instruction ends `FAILED` with a machine-readable reason. There is no state in which one leg has moved.
Failure reasons: `ERR_UMI_NO_WALLET`, `ERR_UMI_INSUFFICIENT_CBDC`, `ERR_UMI_INSUFFICIENT_SECURITIES`,
`ERR_UMI_NOT_PILOT_ELIGIBLE`, `ERR_UMI_SELF_SETTLEMENT`, `ERR_UMI_INVALID_AMOUNT`.

### ISO 20022 message trace

Each instruction records the real message family the RBI/depository rail would use, so the demo can show a
regulator-grade audit trail:

| Step | Message | Meaning |
|---|---|---|
| 1 | `sese.023` | securities settlement transaction instruction |
| 2 | `sese.024` | settlement status advice (matched / locked) |
| 3 | `pacs.009` | financial institution credit transfer — the e₹-W cash leg |
| 4 | `sese.025` | settlement confirmation (DvP complete) |
| 5 | `camt.054` | debit/credit notification to both participants |

On failure the trace ends at `sese.024` + `camt.019` (return/reject), which is exactly how a real
unsettled instruction looks.

## 4. API surface (all new, all under `/umi` on Go, `/api/umi` via Node)

| Method | Path | Purpose |
|---|---|---|
| GET | `/umi/config` | rail metadata, disclaimer, block types, message families |
| GET | `/umi/wallets` | all e₹-W wallets (balance, reserved, available) |
| GET | `/umi/wallets/{id}` | one wallet + its settlement history |
| POST | `/umi/wallets/{id}/fund` | sandbox top-up from the settlement bank (`{"amountINR":500000}`) |
| POST | `/umi/isin` | assign a pilot ISIN to a property (`{"assetId":"...","issuer":"..."}`) |
| GET | `/umi/isin` | pilot ISIN register |
| POST | `/umi/dvp` | create + attempt atomic DvP settlement |
| GET | `/umi/instructions` | all instructions (newest first) |
| GET | `/umi/instructions/{id}` | one instruction + full ISO 20022 trace |
| POST | `/umi/servicing` | distribute rent/coupon pro-rata into holders' CBDC wallets |
| GET | `/umi/reconciliation` | money conservation, leg totals, chain verification |

`POST /umi/dvp` body:

```json
{
  "assetId": "PROP-GREEN-VALLEY-PUNE-001",
  "seller": "originator1",
  "buyer": "investor1",
  "tokens": 100,
  "pricePerTokenINR": 500,
  "dryRun": false
}
```

`dryRun: true` validates and returns the would-be result without touching any state — useful for the
pre-trade check in the buy flow.

## 5. Mapping to AasthiChain's existing model

| Demat 2.0 / UMI concept | AasthiChain equivalent |
|---|---|
| Native token on depository DLT | property fraction token on Drunix |
| Pilot ISIN | `AASTHI-<hash>` pilot ISIN assigned per property |
| Permissioned ledger, nodes at MIIs | 5-org Drunix channel (Aasthi/Originator/Registrar/Investor/Regulator MSPs) |
| Wholesale e₹ wallet at a bank | `UMI-W-<participant>` CBDC wallet (paise integer ledger) |
| Atomic DvP via UMI | `POST /umi/dvp` two-leg lock + single-mutex commit |
| Smart-contract asset servicing | `POST /umi/servicing` → `UMI_SERVICING_PAID` block |
| Regulator visibility on shared ledger | existing Regulator role + `/umi/reconciliation` |
| SEBI Regulatory Sandbox scope limit | `"mode": "simulation"` on every response |

## 6. Why integers, in paise

The cash leg is an `int64` count of **paise**, never a float. Central-bank money must conserve exactly;
`/umi/reconciliation` asserts `Σ wallet balances == total funded − total servicing paid out` and returns
`"conserved": true/false`. A float rupee ledger cannot make that promise.

## 7. Test plan

`drunix-gateway/umi_test.go` covers:

* happy-path DvP moves both legs and conserves money
* insufficient CBDC → `FAILED`, **both** legs unchanged (the atomicity proof)
* insufficient securities → `FAILED`, cash untouched
* reserved funds cannot be double-spent by a concurrent instruction
* servicing credits pro-rata and conserves to the last paisa
* every settlement appends exactly one block and the chain still verifies
* `dryRun` mutates nothing

Run: `cd drunix-gateway && go test ./...`

## 8. Rollout

1. `go run ./cmd/gateway` (rail is mounted in the same service, port 21100).
2. Node: set `UMI_GATEWAY_URL=http://127.0.0.1:21100` (default). Without it, `/api/umi/*` returns
   `503 {"error":"ERR_UMI_RAIL_UNAVAILABLE"}` and the rest of AasthiChain is unaffected.
3. Frontend: `/umi` page appears in the nav; no other page changes.

## 9. Not implemented on purpose

* Real RBI/NPCI connectivity (no public UMI API exists; access is via the SEBI sandbox cohort).
* Retail e₹ — UMI settles **wholesale** CBDC between institutions.
* Replacing the UPI rail. UPI stays the default retail money leg; UMI is the institutional one.
