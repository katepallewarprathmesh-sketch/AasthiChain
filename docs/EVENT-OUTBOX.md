# Roadmap #9 — event-driven backend via a transactional outbox

Design doc. No code yet.

Scope: make every side effect of a committed block survive a crash, without
putting a message broker in front of a settlement rail that already has a
durable append-only log.

---

## 1. What exists today

`DrunixChain.Append` (chain.go:128) is the single choke point. Every state
change in the rail — DvP, seeding, servicing, document anchoring, offers —
ends there, holding `c.mu`:

```
1. assign height, link prevHash, hash the block
2. append to c.Blocks            (in memory)
3. c.hub.publish(LedgerEvent{})  (SSE subscribers)
4. c.store.AppendBlock(b)        (Postgres, best-effort)
```

Consumers of that event today:

| consumer | where | durable? |
|---|---|---|
| SSE subscribers | `eventHub.publish` | no — buffered chan, dropped if full |
| Notifications | `UMIRail.notifySettled` etc. | no — `notifyStore` is a map |
| EVM anchoring | `MirrorInBackground` | no — goroutine, fire and forget |

### 1.1 Two defects this design has to fix

**The event is published before the block is durable.** Step 3 runs before
step 4. If the process dies between them — or if `AppendBlock` returns an
error, which is explicitly tolerated — a browser has already been told that
block *N* exists. On restart `LoadBlocks` replays a chain that never contained
it. The comment at the top of events.go says *"if a client is told something
happened, a block exists to prove it."* Right now that is aspirational.

**Durability failure is logged, not retried.** `persistErr` is surfaced on
`/drunix/ledger/status`, which is honest, but nothing ever tries again. A
thirty-second Neon blip permanently loses blocks from the durable chain while
the in-memory chain sails on. The heights then disagree, and the next restart
silently rolls the rail back to the last block that happened to land.

So #9 is not only "add events". It is "make the commit and its consequences
one atomic fact".

---

## 2. Why an outbox and not Kafka

Already settled earlier in this project, restated so the reasoning survives:

- The rail **already has** an ordered, append-only, durable log — `umi_block`.
  Kafka would be a second one, and two logs disagree eventually.
- A broker introduces a dependency that can be *down* while settlement is
  *up*. For a DvP rail, "the money moved but the broker was unreachable" is a
  worse failure than anything a broker solves here.
- Volume is settlement-shaped, not telemetry-shaped. Postgres handles it.

The outbox pattern keeps the guarantee where it belongs: a side effect is
recorded **in the same transaction as the fact that caused it**, so either
both exist or neither does.

---

## 3. Schema

```sql
CREATE TABLE IF NOT EXISTS umi_outbox (
  seq          BIGSERIAL PRIMARY KEY,   -- delivery order, never reused
  block_height BIGINT      NOT NULL REFERENCES umi_block(height),
  topic        TEXT        NOT NULL,    -- 'ledger.block', 'umi.settled', ...
  dedupe_key   TEXT        NOT NULL,    -- stable, derived; see 5.2
  payload      JSONB       NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ,             -- NULL = pending
  attempts     INT         NOT NULL DEFAULT 0,
  last_error   TEXT,
  UNIQUE (topic, dedupe_key)
);
CREATE INDEX IF NOT EXISTS umi_outbox_pending_idx
  ON umi_outbox (seq) WHERE delivered_at IS NULL;
```

Notes:

- `seq` not `block_height` as the delivery cursor: one block can produce
  several events (a settlement emits `umi.settled` *and* `ledger.block`), and
  they need a total order.
- The partial index keeps the hot query cheap as the table grows. Pending rows
  are the only ones ever scanned.
- `REFERENCES umi_block(height)` is what makes the atomicity claim checkable:
  an outbox row cannot exist for a block that does not.
- No `DELETE`. Rows are marked delivered, matching the no-delete discipline of
  `BlockStore`. Section 8 covers growth.

---

## 4. Write path

`AppendBlock` becomes `AppendBlockWithEvents(b *DrunixBlock, evs []OutboxEvent)`,
one transaction:

```
BEGIN
  INSERT INTO umi_block  (...) VALUES (...) ON CONFLICT (height) DO NOTHING
  INSERT INTO umi_outbox (...) VALUES (...) ON CONFLICT (topic, dedupe_key) DO NOTHING
COMMIT
```

Both `ON CONFLICT DO NOTHING` clauses are retained, so the whole call stays
idempotent — a retried append of an identical block is a no-op rather than an
error, exactly as today.

### 4.1 Ordering fix

`Append` is reordered so the in-memory publish happens **after** the commit
returns:

```
1. assign height, link prevHash, hash the block     (under c.mu)
2. persist block + outbox rows atomically           (under c.mu)
3. append to c.Blocks                               (under c.mu)
4. release c.mu
5. hub.publish(...)                                 -- unlocked, as now
```

This inverts the current best-effort stance, and that is the point: **if the
durable write fails, the block is not committed in memory either, and the
caller gets an error.** A DvP that cannot be recorded has not happened. That
is a behaviour change and the riskiest part of this work — see §9.

When no `BlockStore` is configured (`DRUNIX_MODE=mock` with no `DATABASE_URL`,
which is every test and every local run) the path is byte-identical to today:
no transaction, no outbox, publish inline. The guarantee scales with the
deployment, the code does not fork.

---

## 5. Relay

A single goroutine started with the gateway:

```
for {
    rows := SELECT * FROM umi_outbox
            WHERE delivered_at IS NULL
            ORDER BY seq LIMIT 100
            FOR UPDATE SKIP LOCKED        -- multi-instance safe
    if empty { wait on notify-or-tick; continue }
    for r := range rows {
        err := dispatch(r)
        if err == nil { mark delivered }
        else          { attempts++, last_error, backoff }
    }
}
```

- `FOR UPDATE SKIP LOCKED` is what makes a second instance safe to run without
  a leader election. Two relays simply take disjoint rows.
- Wakeup is `LISTEN/NOTIFY` on commit, with a 2 s ticker as a floor so a missed
  notification costs latency, not delivery.
- Backoff: `min(2^attempts, 60) s`. After 20 attempts the row stays pending and
  is reported on `/drunix/ledger/status` rather than being dropped. Nothing in
  this system silently discards a settlement consequence.

### 5.1 Consumers

| topic | consumer | effect |
|---|---|---|
| `ledger.block` | eventHub | SSE fan-out (unchanged payload) |
| `umi.settled` / `umi.failed` | notifications | durable notification row |
| `umi.document.anchored` | EVM mirror | `AnchorDocument` on chain |
| `umi.servicing.paid` | notifications | income notification |

The EVM mirror becomes the clearest win: anchoring is currently a goroutine
that dies with the process. Under the outbox, a missed anchor is retried until
the chain accepts it, which is the difference between "we anchor documents"
and "we anchor documents unless the box restarts".

### 5.2 At-least-once, and why that is fine

The relay guarantees **at-least-once**, never exactly-once — a crash between
`dispatch` succeeding and `mark delivered` committing redelivers. Every
consumer must therefore be idempotent, and each already can be:

- SSE: the payload is `{height, hash}`; a duplicate makes a client refetch
  state it already has.
- Notifications: `dedupe_key = topic + ':' + block_height + ':' + participant`,
  with the existing unique index making a redelivery a no-op insert.
- EVM mirror: `VerifyDigestOnChain` first; an already-anchored digest skips.

This is the same discipline as the `Idempotency-Key` work on `/umi/dvp`, applied
to the internal path instead of the HTTP edge.

---

## 6. Observability

Added to `/drunix/ledger/status`:

```json
"outbox": { "pending": 0, "oldestPendingSeconds": 0, "failed": 0, "lastError": "" }
```

`pending > 0 && oldestPendingSeconds > 60` is the alarm condition: the ledger
is advancing but its consequences are not landing. Today that state is
invisible.

---

## 7. Tests

Go, in `drunix-gateway`:

1. block + outbox rows commit atomically; forced tx failure leaves **neither**
2. duplicate append → no duplicate outbox row (`ON CONFLICT` holds)
3. relay marks delivered; dispatch error leaves row pending with `attempts++`
4. redelivery of the same row is a no-op at the consumer (idempotence)
5. two relays over one table deliver each row exactly once (`SKIP LOCKED`)
6. no `DATABASE_URL` → path identical to today, SSE still fires

Node, end-to-end: a settlement with the relay stopped produces a pending row;
starting the relay delivers the notification. Added to `tests/` so
`regression.sh` picks it up.

---

## 8. Growth

`umi_outbox` grows forever by design. A weekly `DELETE FROM umi_outbox WHERE
delivered_at < now() - interval '90 days'` is acceptable **because outbox rows
are not the ledger** — `umi_block` remains the permanent record and is never
pruned. Worth stating explicitly so nobody later points the same cleanup at
the blocks.

---

## 9. Risk, and the part I want signed off

Everything above is additive except **§4.1**: today a failed durable write
still returns a committed block, and under this design it returns an error.

That is the correct behaviour for a settlement rail — a DvP you cannot prove
later did not happen — but it converts a silent data-loss bug into a visible
failed request, and it means a Postgres outage stops settlement instead of
degrading it. For the live demo on Render free tier, where the instance sleeps
and the database is currently not even wired up, that trade needs saying out
loud.

Two options:

- **Strict (recommended):** durable write failure fails the settlement.
- **Lenient:** keep today's best-effort behaviour, but queue the block for
  retry and refuse to serve `/umi/*` writes while the durable chain is behind.

I would ship strict, with lenient behind `UMI_DURABILITY=best-effort` for the
demo instance until `DATABASE_URL` is set.

---

## 10. Order of work

1. schema + `AppendBlockWithEvents`, no consumers moved yet (tests 1, 2, 6)
2. relay + status reporting (tests 3, 5)
3. move notifications onto the outbox (test 4)
4. move EVM anchoring onto the outbox
5. reorder `Append` per §4.1 behind the env flag, default strict
