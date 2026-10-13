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
| `UMI_PROXY_SECRET` | **both** | shared secret proving a request came from the web app. The settlement core is on a public URL, so without this it believes `X-Identity-Role: regulator` from anyone. Set the SAME value on the core and the web app — on the core alone, the app locks itself out; on the app alone, nothing changes. `GET /umi/config` reports `identityTrust.mode` as `open` or `shared-secret` |
| `WORK_ENABLED` | settlement core | `false` removes the work-order desk (`/umi/work/*`) and changes nothing else |
| `WORK_PROVIDER_URL` | settlement core | Rezoomex endpoint for publishing work orders; unset means the adapter runs in simulation and says so on every payload |
| `WORK_PROVIDER_KEY` | settlement core | bearer token for the above; both must be set before the adapter reports `live` |
| `ADMIN_DASHBOARD_KEY` | web app | operator key: private analytics, ops queue, deployment diagnostics |
| `SUPERVISOR_EMAILS` | web app | comma-separated emails allowed to act as registrar/regulator |
| `IDENTITY_ALIASES` | web app | pin named people to an existing ledger identity, e.g. `you@example.com=investor1` |
| `GROQ_API_KEY` | web app | enables Aasthi AI. Without it the assistant is off and the launcher does not render |
| `GROQ_MODELS` | web app | optional, comma-separated models tried in order. Defaults to `openai/gpt-oss-120b, qwen/qwen3.6-27b, openai/gpt-oss-20b`. Groq retires models on a schedule, so when the first one is gone the next answers and the fix is this variable, not a deploy |
| `GROQ_MODEL` | web app | optional, pins a single model and overrides the default list |
| `GROQ_BASE_URL` | web app | optional, point the client at a proxy instead of api.groq.com |
| `AI_REQUIRE_SIGNIN` | web app | optional, `true` restricts the assistant to signed-in people |
| `SUPERVISOR_CLERK_IDS` | web app | same, by Clerk user id (`user_…`) |

### Getting into the operator panels

Supervisory roles cannot be claimed by the browser — saying `X-Fabric-Identity: regulator1` has not
been enough since the authorisation audit. On a deployment where the identity provider carries no
role information, that left nobody able to open the ops queue, the deployment diagnostics or the
insights dashboard. There are two supported ways in, both checked on the server:

1. **The operator key.** Send `ADMIN_DASHBOARD_KEY` as the `x-admin-key` header. The insights page
   has a box for it, and once entered it is reused for the other operator panels in that tab.
   **The key reads; it does not act.** Anything that changes state needs a signed-in person, so
   the action has a name against it — the two exceptions are the idempotent maintenance routes
   `/api/npci/rail/backfill` and `/api/db/migrate`.
### Aasthi AI

A Groq-backed assistant that answers questions about the properties listed on the deployment.
Set `GROQ_API_KEY` to switch it on; with no key the endpoint answers 503 saying so and the
floating launcher never renders, so a deployment without a key simply does not have the
feature rather than having a broken one.

What it can and cannot do, by construction:

- It is given the **public listing view** — the same figures the marketplace renders, derived
  from live balances. It never sees holdings, payments, KYC records or identities, because
  nothing owner-scoped is in that view.
- It **cannot act**. There are no tool calls. It cannot mint, transfer, approve, release or
  reclassify anything; the ledger and the settlement core remain the only things that decide
  what is true.
- Every figure it quotes is computed by `publicPropertyView`, the same function behind
  `GET /api/properties`, so the assistant and the page cannot disagree.
- A caller cannot inject a `system` message, so the rules above cannot be argued away.
- Rate limited per signed-in identity, or per address for anonymous visitors, defaulting to
  12 requests a minute. This is in-memory and therefore per instance: a courtesy brake, not a
  security control.

`GET /api/ai/status` reports whether it is enabled. `POST /api/ai/chat` takes
`{ messages: [{ role: 'user' | 'assistant', content: string }] }`.

### Who a signed-in person is

Each signed-in person resolves to their own ledger identity, derived from their Clerk
subject (`person_user_2ab…`). Before, every signed-in person became `investor1`, which meant
ownership checks could not tell two investors apart.

Positions created under the old behaviour still belong to `investor1`. To hand them to a real
person, name them in `IDENTITY_ALIASES`:

```
IDENTITY_ALIASES=you@example.com=investor1,colleague@example.com=investor2
```

Matched on the verified email or the Clerk subject. Anyone not named there gets their own
identity, and a first-time person inherits the mock `VERIFIED` KYC standing they previously
had as `investor1`, so the buying flow is unchanged — replace that with a real provider before
this handles real money.

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
