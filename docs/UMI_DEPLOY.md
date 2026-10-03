# Deploying the UMI rail (fixing "Rail offline" on the hosted site)

> **Looking for exact clicks for Render + Vercel?** See **[UMI_VERCEL_SETUP.md](./UMI_VERCEL_SETUP.md)**.

## Why you see "Rail offline"

All UMI settlement logic is **Go** (`drunix-gateway/umi.go`). Vercel runs only the Node
serverless function, which is a **pure reverse proxy** — it has no UMI logic to fall back on,
by design. With no Go service to proxy to, `/api/umi/*` answers:

```json
{ "error": "ERR_UMI_RAIL_UNAVAILABLE", "message": "...Set UMI_GATEWAY_URL..." }
```

Everything else on the site keeps working — the rail is strictly additive.

Two ways to fix it: run it locally (30 seconds) or host it (5 minutes).

---

## A. Local — for development and for a laptop demo

```bash
cd drunix-gateway && go run ./cmd/gateway       # :21100, demo state auto-seeded
# in another shell
node mock-api-server.js                          # proxies /api/umi/* → :21100
```

Open http://localhost:8080/umi. Nothing else needed: `UMI_GATEWAY_URL` defaults to
`http://127.0.0.1:21100`.

> Judging on a laptop? This is the mode to use — it's the full rail with no hosting bill.

---

## B. Hosted — so `aasthi-chain.vercel.app/umi` works for anyone

### Step 1 — deploy the Go service

**Render (recommended, free tier, blueprint included)**

1. Push this branch and merge to `main` (the blueprint tracks `main`).
2. Render dashboard → **New → Blueprint** → select the `AasthiChain` repo.
3. It reads `render.yaml` and builds `drunix-gateway/Dockerfile`.
4. Copy the service URL, e.g. `https://aasthichain-umi-gateway.onrender.com`.
5. Sanity check: `curl https://<your-url>/umi/config` → JSON with `"mode":"simulation"`.

**Fly.io alternative**

```bash
cd drunix-gateway
fly launch --no-deploy --copy-config --name aasthichain-umi-gateway
fly deploy && fly status
```

**Any container host** (Cloud Run, Railway, Koyeb, a VPS) works too — the image is a
~12 MB distroless static binary and honours `$PORT`:

```bash
docker build -t aasthi-umi ./drunix-gateway
docker run -p 21100:21100 aasthi-umi
```

### Step 2 — point Vercel at it

Vercel project → **Settings → Environment Variables**:

| Key | Value | Environments |
|---|---|---|
| `UMI_GATEWAY_URL` | `https://aasthichain-umi-gateway.onrender.com` | Production, Preview |

Then **redeploy** (env vars only apply to new deployments).

### Step 3 — verify

```bash
curl https://aasthi-chain.vercel.app/api/umi/config | head -c 120
curl https://aasthi-chain.vercel.app/api/umi/reconciliation
```

Then open `/umi` — wallets and the pilot register should be populated.

---

## Persistence (Neon Postgres) — state survives restarts

Set **`DATABASE_URL`** on the Go service (the project's existing Neon connection string) and the
rail becomes durable: wallets, securities positions, pilot ISINs, instructions (with their full
ISO 20022 trace) and the lifetime counters are written through on every mutation and reloaded at
boot. Without it the rail is in-memory exactly as before.

It creates five tables, all prefixed `umi_`, with `CREATE TABLE IF NOT EXISTS` — your existing
schema (`user`, `account`, `session`, `properties`, `balances`, `npci_payments`, …) is untouched:

| Table | Holds |
|---|---|
| `umi_wallet` | e₹-W wallets (participant, wallet id, balance/reserved in **paise**) |
| `umi_position` | securities holdings (asset_id, holder, tokens) |
| `umi_isin` | pilot ISIN register |
| `umi_instruction` | settlement instructions + full JSONB payload (ISO 20022 trace) |
| `umi_meta` | lifetime funded paise, settled/failed counters (conservation baseline) |
| `umi_servicing` | per-holder rent/coupon payouts (what each investor was actually paid) |
| `umi_block` | **the Drunix block chain itself** — append-only, one row per block |

### The ledger is append-only and permanent

`umi_block` is written with `INSERT ... ON CONFLICT (height) DO NOTHING`. There is no `UPDATE` and
no `DELETE` anywhere in the code path — `BlockStore` deliberately exposes only `AppendBlock`. A
committed block cannot be rewritten, by the application or by a bug.

At boot the chain is **replayed and re-verified** from genesis (SHA-512 linkage, merkle roots,
block hashes). Three outcomes:

- **Empty table** → genesis is cut once and persisted.
- **Valid history** → blocks are restored and new blocks continue from the restored tip, with
  heights continuing (…, 3, 4, 5) rather than restarting at 1.
- **Tampered history** → the node logs the exact broken height and reason, marks the chain
  **sealed**, and *refuses to append*. It serves the history read-only rather than silently
  building on forged data.

Inspect it at **`GET /drunix/chain`** (`?from=&limit=`): every block, the verification anyone can
recompute, and a `durability` block showing mode/durable/sealed.

**Ordering under concurrency.** Writes are issued after the rail's mutex is released, so two
concurrent settlements touching one wallet can reach the database out of order. Every wallet,
position and instruction row therefore carries a monotonic `rev` stamped *under* the lock, and
upserts apply only `WHERE stored.rev < incoming.rev`. The last *logical* state wins, not the last
packet to arrive. Counters in `umi_meta` are monotonic and merged with `GREATEST`. On restart the
rail resumes above the highest stored revision.

Behaviour guarantees:

- **Persistence never breaks settlement.** Writes are best-effort; a database outage is logged and
  reported in `/umi/config.persistence.lastError`, while the in-memory engine keeps settling. Proven
  by `TestUMIStoreOutageDoesNotBreakSettlement`.
- **No double-seeding.** Boot seeding is skipped when state was restored, so a restart cannot
  re-credit wallets and break conservation.
- **Reservations are not restored** — an earmark belongs to an in-flight instruction, and a restart
  has none.
- **Single writer.** One gateway instance owns the rail. Running several replicas against one
  database needs row locks or an SQL-side settlement engine; don't scale past 1 instance as-is.

**Running tests against a persisted rail:** the regression suite deliberately creates throwaway
participants and failed settlements. With persistence on, those rows stay in the database forever
and clutter the demo. Run load/regression traffic with `UMI_PERSIST=false`, or point the rail at a
scratch database with `UMI_DATABASE_URL`, and keep the Neon instance for the real demo.

Verified end to end against Neon: boot → settle → servicing → kill → restart → wallets
(₹56,000 / ₹44,000 post-servicing), pilot ISIN, instruction trace and `conserved: true` all came back.

## What the hosted rail seeds at boot

So the page is never empty for a visitor (`UMI_SEED_DEMO=false` to disable):

- 15,000 tokens of `PROP-GREEN-VALLEY-PUNE-001` to `originator1` (`UMI_SEED_ASSET` / `UMI_SEED_OWNER` to change)
- e₹-W wallets: `investor1` ₹1,00,000, `investor2` ₹50,000

## Environment variables

| Var | Where | Default | Meaning |
|---|---|---|---|
| `UMI_GATEWAY_URL` | Vercel + Node server | `http://127.0.0.1:21100` (Node), unset (Vercel) | where the Go rail lives |
| `PORT` / `DRUNIX_PORT` | Go service | `21100` | listen port (PaaS hosts inject `PORT`) |
| `UMI_ENABLED` | Go service | `true` | `false` unmounts `/umi/*` entirely |
| `UMI_SEED_DEMO` | Go service | `true` | seed demo positions/wallets at boot |
| `DRUNIX_MODE` | Go service | `mock` | `real` + `-tags real` for a live Fabric network |
| `DATABASE_URL` | Go service | unset | Neon Postgres DSN — persists rail state (`umi_*` tables) |
| `UMI_DATABASE_URL` | Go service | unset | use a *different* database than the app for the rail |
| `UMI_PERSIST` | Go service | `true` | `false` forces in-memory even when `DATABASE_URL` is set |

## Known limits of a free-tier deployment

- **State is in-memory unless `DATABASE_URL` is set** (see Persistence above). With Neon wired in,
  wallets, positions, ISINs, instructions **and the block chain itself** all survive restarts.
- **Cold start** on Render free is ~30–50 s; the first `/umi` load after idle will spin.
- **The rail is unauthenticated** — it is a sandbox demo surface. Do not put anything real
  behind it; put it behind the existing auth middleware first if you ever do.

## Private operator dashboard (`/insights`)

An operator-only analytics page, derived entirely from this deployment's own
data. No third-party analytics, no tracking script, nothing leaves the box.
Traffic metrics (pageviews, referrers, SEO rank) are deliberately **not**
included — nothing in the stack records a pageview today.

| Item | Value |
|---|---|
| Page | `/insights` — intentionally absent from the nav; reachable only by typing the URL |
| API | `GET /api/admin/insights` (auth required) |
| Status probe | `GET /api/admin/insights/status` → `{ "enabled": bool }` (unauthenticated, boolean only) |
| Auth | `x-admin-key` header (or `?key=`), compared in constant time against `ADMIN_DASHBOARD_KEY` |
| Key unset | Endpoint returns **503 and is disabled** — it never falls open |
| Wrong key | **401**, with no hint about the correct value |

Set the key on **Vercel only**. Render runs just the Go gateway
(`drunix-gateway/Dockerfile` per `render.yaml`), which never reads this
variable - the insights endpoint lives in the JS layer:

```bash
openssl rand -hex 32        # generate
ADMIN_DASHBOARD_KEY=<that value>
```

Vercel bakes env vars in at build time, so after adding it you must redeploy
**without** the build cache. Confirm with
`curl https://<app>/api/admin/insights/status` -> `{"enabled":true}`.

The browser keeps the key in `sessionStorage` and sends it as a header, so it
never lands in a URL, a server log, or the browser history. Aggregation lives
in `lib/insights.js`, shared by `mock-api-server.js` (Express) and
`frontend/api/index.js` (Vercel), so the two deployments cannot drift.
