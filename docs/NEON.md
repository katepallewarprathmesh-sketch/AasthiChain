# Putting AasthiChain's data in your Neon database

Both halves of the system read one environment variable, `DATABASE_URL`. Point
them at your Neon connection string and they create their own tables on first
start. There is no migration tool to run and no schema file to apply.

What ends up there, and what does not, is listed at the bottom. Read that part
before you assume the database holds everything.

## 1. Get the connection string

In the Neon console: your project, then **Connect**. Copy the **pooled**
connection string. It looks like this:

```
postgresql://USER:PASSWORD@ep-something-pooler.REGION.aws.neon.tech/DBNAME?sslmode=require
```

Two things matter:

- Use the **pooled** string (the host contains `-pooler`). Render and Vercel
  both open and drop connections freely, and the direct string runs out of
  connections.
- Keep `?sslmode=require`. Neon refuses plaintext, and the Go rail checks for
  it before it tries to connect.

## 2. Set it on the settlement rail (Render)

The rail is the Go service in `drunix-gateway/`, and it owns the ledger.

1. Render dashboard, your service, **Environment**.
2. Add or edit `DATABASE_URL`, paste the string, save.
3. Let it redeploy, then read the logs. You are looking for:

```
Drunix chain: N blocks replayed from postgres (Neon), chain verified to height N
UMI rail restored from postgres (Neon): N wallets, N positions, N ISINs, N instructions
```

An empty database logs `new durable ledger started, genesis block committed`
instead, which is the correct message for a fresh start.

If the string is wrong the rail does **not** crash. It logs the reason and
falls back to memory, and `/umi/config` then reports
`persistence.mode: "in-memory"`. Treat that as a failure even though the
service is up.

## 3. Set it on the app (Vercel)

1. Vercel project, **Settings**, **Environment Variables**.
2. Add `DATABASE_URL` with the same string, for Production.
3. Redeploy. Environment changes do not reach the running deployment on their
   own.
4. Check `GET /api/health`. It must report `"dbMode": "postgres"`.

If `dbMode` comes back as `github` or `file-backed`, the app could not reach
Postgres and silently fell back. The row counts in the same response tell you
which store answered.

## 4. Verify, rather than assume

```bash
DATABASE_URL='postgresql://...sslmode=require' node scripts/neon-check.mjs
```

It is read-only. It lists every table the project writes, says whether it
exists, counts the rows, checks the chain for gaps in block height, and shows
any outbox rows the relay keeps failing to deliver, with the last error. Run it
once with the rail's string and once with the app's: if both report tables,
both services are writing to the same database, which is the thing people
usually get wrong.

## 5. Moving data you already have

Only needed if a different database holds data you want to keep. Dump and
restore with `pg_dump`, which Neon supports directly:

```bash
pg_dump --no-owner --no-privileges -d "$OLD_DATABASE_URL" -f aasthichain.sql
psql -d "$NEW_DATABASE_URL" -f aasthichain.sql
```

Do it with both services stopped. The rail replays and re-verifies the chain at
boot, so a dump taken mid-write can land a partial block and the rail will then
refuse to extend the chain, which is the behaviour you want but a confusing way
to discover it.

To copy the ledger alone, restore just `umi_block`. The rail rebuilds asset
classes, private-data proofs, interop records, work orders and baskets from it.

## What is actually in the database

**Written by the rail:** `umi_block` (the ledger, append-only, never updated or
deleted), `umi_wallet`, `umi_position`, `umi_isin`, `umi_instruction`,
`umi_servicing`, `umi_meta`, `umi_idempotency`, `umi_outbox`.

**Written by the app:** `properties`, `balances`, `transfers`, `npci_payments`,
`npci_balances`, `utr_index`, `idempotency`, `webhooks`, `kyc`, the auth tables
(`account`, `session`, `jwt`, `verification`, `member`, `organization`,
`invitation`) and `project_config`.

**Rebuilt from the chain at startup**, so durable without a table of their own:
asset classes and carbon retirements, private-data proofs, interop transfers,
work orders, baskets.

**Not in the database, and lost when the process restarts:**

| What | Why it matters |
| --- | --- |
| Document register | The anchor blocks are on the chain, but the register is not rebuilt from them, so anchored deeds go missing from `/umi/documents`. |
| Marketplace offers | Held in memory and never written to the chain either, so there is nothing to replay. |
| Notifications | Cosmetic. |
| Event stream buffer | Only a buffer; set `EVENT_STREAM_BROKERS` to publish somewhere durable. |
| Private data values | By design. Hashes go on the chain, values live in the collection side store, which is how a Fabric private data collection behaves. |
| Document bytes | In-process unless `IPFS_API_URL` points at a pinning node. |

The first two are gaps rather than decisions, and they are tracked in
`docs/REPOSITORY_AUDIT.md`.

## When it goes wrong

| Symptom | Cause |
| --- | --- |
| `/umi/config` says `in-memory` | The rail could not connect. The log line names the reason. |
| `/api/health` says `dbMode: github` | Same thing on the app side. |
| `too many connections` | The direct connection string was used instead of the pooled one. |
| `SSL is not enabled` | `?sslmode=require` was dropped from the string. |
| Tables exist but stay empty | Two different databases, one per service. Run `scripts/neon-check.mjs` against both strings. |
| Rail serves read-only after a restore | Chain verification failed. The log names the block height. A restored dump missing rows will do this. |
