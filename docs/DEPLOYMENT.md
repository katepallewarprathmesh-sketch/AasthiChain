# Running and deploying AasthiChain

The README describes the product and [`ARCHITECTURE.md`](ARCHITECTURE.md) describes the shape of the
code. This file is the operator's copy: exact commands, exact variables.

## Processes

| Process | What it is | Default port |
|---|---|---|
| Web app + edge | `node server.js` — serves the built frontend and the API handler | 8080 |
| Settlement core | `drunix-gateway` — the Go rail that owns the ledger | 21100 |
| Fabric network | optional, only for the chaincode path | — |

## Local

```bash
# 1 — frontend only, no Go and no Docker
cd frontend && npm install && npm run dev        # :5173

# 2 — with the settlement core
cd drunix-gateway && go run ./cmd/gateway                            # :21100
DEMO_AUTH=true UMI_GATEWAY_URL=http://localhost:21100 node server.js  # :8080

# 3 — everything, including the Fabric network
cd network && docker-compose up -d && ./scripts/create-channel.sh
```

Verification:

```bash
bash regression.sh                      # end-to-end checks against whichever server is on :8080
cd drunix-gateway && go test ./...      # settlement core unit and authorisation tests
```

`regression.sh` expects the web app on `:8080` and the settlement core on `:21100`.

## Environment

| Variable | Where | Purpose |
|---|---|---|
| `VITE_CLERK_PUBLISHABLE_KEY` | web app | Clerk auth. Use a `pk_live_` production key. |
| `CLERK_ISSUER` | web app | Clerk Frontend API URL. **Set it** — without it, session signatures are not verified. |
| `UMI_GATEWAY_URL` | web app | address of the settlement core; unset means the rail reports unreachable |
| `ADMIN_DASHBOARD_KEY` | web app | operator key: private analytics, ops queue, deployment diagnostics |
| `SUPERVISOR_EMAILS` | web app | comma-separated emails allowed to act as registrar/regulator |
| `SUPERVISOR_CLERK_IDS` | web app | same, by Clerk user id (`user_…`) |

### Getting into the operator panels

Supervisory roles cannot be claimed by the browser — saying `X-Fabric-Identity: regulator1` has not
been enough since the authorisation audit. On a deployment where the identity provider carries no
role information, that left nobody able to open the ops queue, the deployment diagnostics or the
insights dashboard. There are two supported ways in, both checked on the server:

1. **The operator key.** Send `ADMIN_DASHBOARD_KEY` as the `x-admin-key` header. The insights page
   has a box for it, and once entered it is reused for the other operator panels in that tab.
2. **A named operator.** Put your sign-in email in `SUPERVISOR_EMAILS` (or your Clerk user id in
   `SUPERVISOR_CLERK_IDS`). That person may then act as `registrar1` or `regulator1`. A role set in
   the Clerk user's public metadata (`role` or `fabricIdentity`) works too.

Everyone else keeps the same access they had: investors see their own things, and the panels answer
403 with a line saying how access is granted.
| `DATABASE_URL` | settlement core | Postgres, for durable blocks. Without it the ledger is in-memory and a restart erases it. |
| `UMI_ENABLED` | settlement core | mounts the settlement routes |
| `UMI_SEED_DEMO` | settlement core | demo fixtures. Set to `false` anywhere holding real positions. |
| `DRUNIX_MODE` | settlement core | `mock` simulator, or `real` against a Fabric network |
| `NPCI_WEBHOOK_SECRET` | web app | HMAC secret for payment callbacks; callbacks are refused when unset |
| `NPCI_MODE`, `PAYU_MERCHANT_KEY`, `PAYU_SALT` | web app | `mock` · `payu` · `real` |
| `DEMO_AUTH` | — | development only. **Never set it in production** — it lets a request name its own identity. |

Credentials are never committed; `.env.payu` is gitignored.

## Production

- The web app deploys to Vercel; the settlement core runs as a container (`render.yaml`,
  `drunix-gateway/Dockerfile` and `drunix-gateway/fly.toml` are all included).
- Deploy the core first, then set `UMI_GATEWAY_URL` on the web app and redeploy it.
- Health: `GET /health` on the core reports the running commit; `GET /` lists its routes.
- Give the core a `DATABASE_URL` before anything real happens on it. A free instance that sleeps
  loses an in-memory ledger, and the append-only guarantee does not survive that.

## Diagram

`docs/architecture.svg` is the editable source; `docs/architecture.png` is the export
[`ARCHITECTURE.md`](ARCHITECTURE.md) shows. Re-export after editing:

```bash
pip install cairosvg
python3 -c "import cairosvg; cairosvg.svg2png(url='docs/architecture.svg', \
  write_to='docs/architecture.png', scale=2, background_color='#F7F5F0')"
```
