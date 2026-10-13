# Work Orders: escrowed property work, settled on completion

**Status:** design + implementation (this document ships with the code).
**Partner context:** Rezoomex, a Pune tech gig-work platform whose defining idea is that
*smart contracts link pay to task completion*. This module is where that idea lands inside
AasthiChain.

---

## 1. The problem this solves

AasthiChain tokenises a property and settles trades atomically on the Aasthi Settlement
Interface (ASI). What it has never modelled is the **cost of keeping the asset real**.

A tokenised building still needs inspecting, repairing, revaluing, photographing, and its
title re-verified. Today all of that happens off-ledger, on trust, paid by somebody on an
invoice nobody can audit. For an investor holding 400 tokens of a Pune apartment, the
maintenance spend is the single largest unexplained hole in the model.

That gap has the same shape as the one ASI already closed for trading: two things that
must happen together, **work delivered** and **money paid**, with no honest way to make
them simultaneous. ASI's answer was atomic DvP. This module applies the identical
discipline to labour.

## 2. The guarantee

> The fee leaves the funder's wallet at the same instant the deliverable is accepted and
> anchored to the ledger. Before acceptance the money is **reserved and unspendable**;
> after acceptance the deliverable's hash is **on the chain**. There is no state in which
> the worker has been paid and no evidence exists, or evidence exists and the escrow is
> still sitting unreleased.

This is delivery-versus-payment with a deliverable in place of a security.

## 3. Lifecycle

```
CREATED ──fund──► FUNDED ──assign──► ASSIGNED ──submit──► SUBMITTED
   │                 │                                        │
   │                 │                              ┌─────────┴─────────┐
   └──cancel──┐      └──cancel/refund──┐         accept              dispute
              ▼                        ▼            │                  │
          CANCELLED                REFUNDED     ACCEPTED           DISPUTED
                                                 (paid)        │          │
                                                            refund     accept
                                                               ▼          ▼
                                                           REFUNDED   ACCEPTED
```

Terminal: `ACCEPTED`, `REFUNDED`, `CANCELLED`. Every transition is rejected unless it is
legal from the current state. The engine never infers intent from a bare status write.

## 4. Where the money sits

Escrow reuses the e₹-W wallet already on the rail. No new money primitive, no second
ledger, no chance of the two disagreeing.

| Transition | Effect on wallets |
|---|---|
| `fund`   | funder `ReservedPaise += fee` (requires `available >= fee`) |
| `accept` | funder `Balance -= fee`, `Reserved -= fee`; worker `Balance += fee` |
| `refund` / `cancel` | funder `Reserved -= fee` |

Two consequences worth stating plainly:

1. **Conservation is untouched.** Σ wallet balances still equals lifetime funding at every
   point, because escrow only ever reserves, and acceptance is a transfer between two
   wallets. `GET /umi/reconciliation` keeps proving it.
2. **Reserved money cannot be double-spent.** The DvP engine computes a buyer's capacity
   from `available()`, which already subtracts `Reserved`. Escrowing a repair fee therefore
   reduces what that participant can spend on a settlement, automatically. Nothing in the
   settlement path had to change.

All arithmetic is integer paise. Fees never touch a float.

## 5. Evidence on the chain

Each transition appends a block to the existing hash-chained Drunix ledger, so
`/api/chain/verify` proves the work history exactly as it proves settlement history:

`WORK_CREATED` · `WORK_FUNDED` · `WORK_ASSIGNED` · `WORK_SUBMITTED` · `WORK_ACCEPTED` ·
`WORK_DISPUTED` · `WORK_REFUNDED` · `WORK_CANCELLED`

`WORK_SUBMITTED` carries the deliverable's SHA-256 and its URI. That hash is the whole
point: the inspection report handed over in month three can be re-hashed in year five and
checked against a block nobody can rewrite.

Because every transition is on the chain, the work desk **restores itself from the ledger
at boot** (`RestoreWorkFromChain`). It needs no new database table and no change to
`UMIStore`, and it cannot drift from the audit trail, because the audit trail *is* the
source.

## 6. Who may do what

Enforced in Go, next to the state it protects. The JS layer stays a pure proxy.

| Action | Permitted caller |
|---|---|
| create, fund, assign | the funder, or a supervisor |
| submit | the assigned worker, or a supervisor |
| accept, dispute, refund, cancel | the funder, or a supervisor |
| read one order | either party, or a supervisor |
| list orders | your own (as funder or worker); supervisors see the desk |

Supervisor = role `regulator` or `admin`, the same definition the rail already uses.
A worker cannot accept their own work, and a funder cannot submit on the worker's behalf:
that separation is the reason the escrow means anything.

## 7. The Rezoomex boundary

Rezoomex publishes no public API documentation, so the integration is written as an
adapter with an honest fallback, the same pattern the repo already uses for NPCI:

```
WORK_PROVIDER_URL + WORK_PROVIDER_KEY set  ->  live calls to the partner
neither set                                ->  mode "simulation", local roster
```

`GET /umi/work/provider` reports which mode is active, and every work-order payload carries
`providerMode`, so a screenshot can never imply a partnership that is not wired up. When a
sandbox key arrives, one environment variable turns the same code live; no logic moves.

What crosses the boundary is deliberately small: publish an order's spec and acceptance
criteria, receive a worker reference back, record it as `providerRef`. Escrow, state and
evidence stay on our ledger. We are not asking the partner to hold money, and they are not
asking us to host their talent graph.

## 8. API

All additive, under the existing proxied prefix, so the serverless layer needed no change.

```
GET  /umi/work                                list (scoped to the caller)
GET  /umi/work/provider                       adapter mode + roster
GET  /umi/work/{orderId}                      one order with its full event trail
POST /umi/work        {assetId,title,spec,category,feeINR,funder,acceptanceCriteria[]}
POST /umi/work/{id}/fund                      reserve the fee
POST /umi/work/{id}/assign    {worker,providerRef?}
POST /umi/work/{id}/submit    {deliverableHash,deliverableUri?,note?}
POST /umi/work/{id}/accept    {note?}         releases escrow to the worker
POST /umi/work/{id}/dispute   {reason}
POST /umi/work/{id}/refund    {reason}        returns escrow to the funder
POST /umi/work/{id}/cancel    {reason}
```

Reachable from the app as `/api/umi/work/...`.

## 9. What this is not

- Not a connection to the live Rezoomex platform unless the two environment variables are
  set; until then every response says `simulation`.
- Not an employment or payroll system. It escrows a fee against one defined deliverable.
- Not a dispute court. `DISPUTED` parks the escrow and names a reason; resolving it is a
  supervisor decision, recorded, not an algorithm pretending to judge.
