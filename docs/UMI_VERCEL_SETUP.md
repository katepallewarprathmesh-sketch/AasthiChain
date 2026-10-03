# Getting `/umi` working on Vercel — exact click-by-click guide

**The one sentence version:** Vercel cannot run the Go rail. You must host the Go service
somewhere (Render, free), then tell Vercel where it lives via one environment variable
`UMI_GATEWAY_URL`, then redeploy.

Your error message — *"not configured for this deployment"* — is the Vercel function telling you
that variable is missing. (The "opens for a second then shows the card" behaviour is just the page
rendering, then its first `/api/umi/config` call returning 503.)

---

## Part 1 — Host the Go rail on Render (free, ~5 min)

> Needs the branch merged to `main`, or change `branch:` in `render.yaml` to
> `feat/umi-settlement-rail`.

1. Go to **https://dashboard.render.com** → sign in with GitHub.
2. **New +** → **Web Service**.
3. **Connect a repository** → authorise Render for `katepallewarprathmesh-sketch/AasthiChain`
   → **Connect**.
4. Fill the form exactly:

   | Field | Value |
   |---|---|
   | **Name** | `aasthichain-umi-gateway` |
   | **Region** | Singapore (closest to India on free) |
   | **Branch** | `main` (or `feat/umi-settlement-rail`) |
   | **Root Directory** | `drunix-gateway` |
   | **Runtime / Language** | **Docker** |
   | **Dockerfile Path** | `./Dockerfile` (relative to root dir) |
   | **Instance Type** | **Free** |

5. Open **Advanced** → **Add Environment Variable**, add these three:

   | Key | Value |
   |---|---|
   | `UMI_ENABLED` | `true` |
   | `UMI_SEED_DEMO` | `true` |
   | `DRUNIX_MODE` | `mock` |
   | `DATABASE_URL` | your Neon connection string (`postgresql://…?sslmode=require`) |

   `DATABASE_URL` is what stops the demo resetting every time the free instance sleeps — the rail
   persists wallets, positions, pilot ISINs and instructions into `umi_*` tables in your existing
   Neon database. Leave it out and the rail still works, just in-memory.

   Do **not** set `PORT` — Render injects it and the binary reads it.

6. **Health Check Path**: `/health`
7. **Create Web Service**. First build takes ~3–4 min (Go compile + distroless image).
8. When it says **Live**, copy the URL at the top, e.g.
   `https://aasthichain-umi-gateway.onrender.com`.

**Verify before moving on** (paste in a browser):

```
https://aasthichain-umi-gateway.onrender.com/health
https://aasthichain-umi-gateway.onrender.com/umi/config
```

`/umi/config` must return JSON containing `"mode":"simulation"`. If it 404s, the service is
running but `UMI_ENABLED` was set to `false`. If nothing loads, check the Render build logs.

> Shortcut: the repo also has a **`render.yaml` blueprint** — *New + → Blueprint → select the
> repo* does steps 4–6 automatically.

---

## Part 2 — Add the variable on Vercel

1. **https://vercel.com/dashboard** → open the **aasthi-chain** project.
2. **Settings** (top tab) → **Environment Variables** (left sidebar).
3. Add:

   | Field | Value |
   |---|---|
   | **Key** | `UMI_GATEWAY_URL` |
   | **Value** | `https://aasthichain-umi-gateway.onrender.com` |

   ⚠️ No trailing slash. ⚠️ Do **not** append `/umi` — the code adds that.

4. **Environments**: tick **Production**, **Preview**, and **Development**.
   (Tick *Preview* too — if you're testing the branch URL rather than
   `aasthi-chain.vercel.app`, that's a Preview deployment and it needs the variable.)
5. **Save**.

---

## Part 3 — Redeploy (required — env vars only apply to new builds)

1. **Deployments** tab → the most recent deployment → **⋯** menu → **Redeploy**.
2. **Untick "Use existing Build Cache"** → **Redeploy**.
3. Wait for **Ready**.

---

## Part 4 — Verify

```bash
curl https://aasthi-chain.vercel.app/api/umi/config
curl https://aasthi-chain.vercel.app/api/umi/wallets
```

You should get JSON with `"mode":"simulation"` and two seeded wallets
(`investor1` ₹1,00,000, `investor2` ₹50,000). Now open **https://aasthi-chain.vercel.app/umi**.

> First hit after idle takes **30–50 s** — Render's free instance sleeps. If the page shows the
> offline card, hit Refresh once the `/health` URL responds.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Still "not configured for this deployment" | Variable missing **on that environment**, or no redeploy | Confirm it's ticked for Preview *and* Production, then redeploy without cache |
| "UMI rail not reachable at …" | Variable is set but the Go service is down/asleep | Open `<render-url>/health` directly; check Render logs |
| Works, then empty after a while | Free instance slept and `DATABASE_URL` is not set | Add `DATABASE_URL` on Render (see above) — state then survives sleeps |
| `/umi/config` shows `persistence.lastError` | DB reachable at boot but failing writes | Check Neon quota / connection limits; settlement keeps working meanwhile |
| 404 on `/umi/config` | `UMI_ENABLED=false` on Render | Set it to `true`, redeploy the service |
| Page loads but wallets list is empty | `UMI_SEED_DEMO=false` | Set to `true`, or fund a wallet from the UI |

---

## If you'd rather not host a second service

Three honest options:

1. **Local demo only** (what I'd recommend for judging): `make umi` + `node mock-api-server.js`.
   Full rail, zero hosting, no cold starts.
2. **Port the rail to a Vercel Go serverless function** (`frontend/api/umi.go`, `@vercel/go`
   runtime). Keeps the backend in Go and needs no second host — but each invocation is a fresh,
   isolated instance, so wallet balances and instructions would not survive between clicks
   unless the state is moved into your existing Neon Postgres. That's a real piece of work
   (~a day) and changes the rail from in-memory to DB-backed.
3. **Rewrite the rail in JS** inside `frontend/api/index.js` — fastest to deploy, but it breaks
   your "keep the backend in Go" requirement and duplicates the settlement engine in two
   languages. I don't recommend it.

Tell me which and I'll build it.
