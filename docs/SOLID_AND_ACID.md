# SOLID and ACID in the settlement rail

This is an audit with the fixes it produced, not a style guide. The rail moves
money, so the two questions worth asking are whether the durable record can
ever hold half a trade, and whether the code that moves money is separable
from the code that creates it.

Scope of the audit: `drunix-gateway/` (49,718 lines of Go), the settlement
core. The Node proxy and the React front end are covered only where they
touch the same invariants.

---

## ACID

The rail enforces settlement invariants in memory under one mutex and mirrors
state into Postgres. That split is deliberate and documented at
`/umi/config`. Each ACID property therefore has to be read twice: once for the
in-memory ledger and once for the durable copy.

### Atomicity

**In memory: held.** A delivery-versus-payment settlement debits the buyer,
credits the seller and moves both positions inside a single critical section.
Nothing observes the intermediate state.

**On disk: was broken, now fixed.** A settlement used to issue six independent
autocommit statements after the lock was released: two wallets, two positions,
the counters, then the instruction. Any failure part-way through left the
database holding a buyer who had paid and a seller who had not been credited.
Memory stayed correct, so nothing looked wrong until the next restart, at
which point the rail would rebuild itself from a record that violated the
conservation rule it advertises.

The fix is `UMIStore.Apply(Mutation)` in `umi_store.go`. The rail builds one
`Mutation` holding every row a state change touches and hands it over whole;
the Postgres implementation writes it inside one `BeginTx`/`Commit`. The
single-row `Save*` helpers still exist for changes that genuinely touch one
thing, and are now implemented as one-row `Apply` calls, so there is one set
of SQL statements rather than two that can drift.

Persistence also moved to *after* the block is appended, so the instruction,
its two legs and the counters commit together with the block height that
anchors them.

Proof: `TestSettlementPersistsAsOneMutation` counts store mutations per
settlement and fails at anything other than exactly one.

### Consistency

**Held, with one gap left open.** Conservation of cash and of token supply is
enforced in memory before anything is written, and
`TestDurableCopyConservesCash` now asserts the same property against the
durable copy across repeated settlements.

The gap: the invariants live in Go, not in the schema. `umi_wallet` has no
`CHECK (balance_paise >= 0)`, and `umi_position` has no check that holdings
stay within authorised supply. Nothing but this service writes those tables
today, so the risk is theoretical, but a second writer would not be stopped by
the database. Adding the constraints is cheap and is listed below as
outstanding.

### Isolation

**Held.** One mutex serialises every state change, which is the strongest
isolation level available and the reason the service must run as a single
instance. That constraint is real and shapes hosting: anything that scales to
several processes breaks it.

Database writes happen after the lock is released, so two settlements touching
one wallet can reach Postgres out of order. Each row carries a `rev` stamped
under the mutex and every upsert is guarded `WHERE rev < EXCLUDED.rev`, so the
last *logical* state wins rather than the last packet to arrive.
`TestConcurrentSettlementsLeaveStoreConsistent` runs eight concurrent
settlements and asserts the durable token total still equals issued supply.

### Durability

**Partially held, and now honest about it.** Committed state reaches Postgres,
and `LoadSnapshot` rebuilds the rail from it, resuming above `MaxRev` so new
writes are not discarded as stale.

What is not true is that a settlement is durable at the moment the API returns
success: it is committed in memory and on the hash chain first, and written
afterwards. A database outage therefore cannot unwind a trade, by design. The
previous code discarded the write error entirely (`_ = r.store.SaveWallet(w)`),
which made that window invisible. It is now counted and published:

```
GET /umi/config → persistence.writeFailures, persistence.inSync
```

Non-zero means the ledger is ahead of its durable copy and a restart would
lose the difference. `TestFailedPersistWritesNothing` asserts both halves: the
settlement survives the outage, and the database receives none of it.

---

## SOLID

### Single responsibility

**Mostly held.** The package convention is `x.go` for domain logic and
`x_server.go` for the HTTP handler, which keeps transport out of the rules.
Settlement, AML, cards, CBDC, servicing and conditional payments are separate
files with separate state.

**Violated by `UMIRail`.** It carries 85 methods across wallets, positions,
ISINs, baskets, servicing, conditional legs, notifications and metrics. It is
a god object, and the reason it survives is that the single mutex protecting
all of that state is also what guarantees isolation; splitting the type
without splitting the lock would buy nothing, and splitting the lock would
weaken the property the rail exists to provide. Recorded deliberately as
accepted, not as unnoticed.

### Open/closed

**Held at the seams that matter.** `SecuritiesLedger`, `UMIStore` and the
chain store are interfaces, so a Fabric-backed position book or a different
database is an addition rather than an edit. The Postgres store was extended
with `Apply` without touching any caller of `SaveWallet`.

### Liskov substitution

**Was violated, now fixed.** Six places asked `r.securities.(*MemorySecurities)`,
which is code that claims to depend on an interface but in fact requires one
concrete implementation, so any substitute would silently lose seeding, issuance and
retirement. One of those sites went further and manipulated the
implementation's private map under its private mutex from outside the type.

Both are gone. Those capabilities are now a declared interface, and the
retirement path calls a method instead of reaching into the struct:

```go
type IssuingLedger interface {
	SecuritiesLedger
	Set(assetID, holder string, tokens int64)
	Credit(assetID, holder string, tokens int64)
	Burn(assetID, holder string, tokens int64) error
}
```

### Interface segregation

**Held, and the fix above is the reason.** Settlement code receives a
`SecuritiesLedger`, which can move tokens and cannot create them: a transfer
that is able to mint is not a transfer. Only issuance, seeding and retirement
ask for `IssuingLedger`. The distinction is enforced by the compiler rather
than by review.

`UMIStore` moved the other way on purpose: seven `Save*` methods are now
facades over one `Apply`, because a store implementation should have to get
one write path right, not seven.

### Dependency inversion

**Held.** The rail depends on `SecuritiesLedger`, `UMIStore` and the chain
interface, never on Postgres or on a concrete ledger. `writeMutation` takes an
`execer` satisfied by both `*sql.DB` and `*sql.Tx`, which is how the
transactional and autocommit paths share one set of statements.

---

## Outstanding

| Item | Why it is not done |
|---|---|
| `CHECK (balance_paise >= 0)` and a supply ceiling in the schema | Cheap, worth doing; no second writer exists today so it is not urgent |
| `UMIRail` is 85 methods | Splitting the type means splitting the mutex, which weakens isolation. Accepted |
| Two implementations of the same 82 HTTP routes in JavaScript | Tracked separately as audit item D5; the proposed route is one shared contract both must satisfy |
| Durability is asynchronous to the API response | Deliberate. The alternative is refusing committed trades when a serverless database blinks. Now measured via `persistence.writeFailures` |

## Tests

`drunix-gateway/umi_atomic_test.go` holds one test per property, each written to
fail for the reason it names rather than to cover a line:

- `TestSettlementPersistsAsOneMutation`: atomicity
- `TestFailedPersistWritesNothing`: atomicity under failure, plus the failure counter
- `TestDurableCopyConservesCash`: consistency
- `TestConcurrentSettlementsLeaveStoreConsistent`: isolation
- `TestBurnRefusesOverRetirement`: the one path that destroys supply
- compile-time assertions that `MemorySecurities` satisfies both ledger interfaces

Run: `go test -race -count=1 ./...` from `drunix-gateway/`.
