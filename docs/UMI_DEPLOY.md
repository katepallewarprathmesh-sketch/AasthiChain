# Deploying the UMI rail (fixing "Rail offline" on the hosted site)

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

## Known limits of a free-tier deployment

- **State is in-memory.** A restart or a free-instance sleep resets wallets, instructions and
  the chain. Fine for a labelled simulation; wire a StateDB (the `SecuritiesLedger` interface
  and `DrunixChain` are the seams) if you need continuity.
- **Cold start** on Render free is ~30–50 s; the first `/umi` load after idle will spin.
- **The rail is unauthenticated** — it is a sandbox demo surface. Do not put anything real
  behind it; put it behind the existing auth middleware first if you ever do.
