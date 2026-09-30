# `data/` — shared state for the serverless deployment

On Vercel the API runs as serverless functions. Instances do not share memory or
`/tmp`, so a payment written by one instance is invisible to the next. These
files are the shared store: the functions read them over
`raw.githubusercontent.com` and, when a `GITHUB_PAT` is configured, write them
back through the GitHub Contents API.

## Regenerating

Do not hand-edit these files. They are produced by driving the real API, so the
records are exactly the shapes the application reads back — hand-written
fixtures drift the moment a field is added.

```bash
node mock-api-server.js &
node scripts/seed-data.mjs
```

## What is in them

| File | Contents |
|---|---|
| `properties.json` | The demo property, tokenised and registrar-validated |
| `balances.json` | Token holdings, keyed `<assetId>~<ownerId>` |
| `transfers.json` | Completed token transfers, keyed by `transferId` |
| `kyc.json` | KYC status per demo identity |
| `npci_payments.json` | Two completed UPI collect payments, with real UTRs and model risk scores |
| `utr_index.json` | UTR → paymentId lookup |
| `webhooks.json` | `[]` — see below |

Every payment carries `isSimulation: true` and `provider: "mock"`. No real money
is involved anywhere in this repository.

## Why `webhooks.json` is empty

It is an append-only record of webhook deliveries that actually happened.
Empty is the correct initial state, not a missing value — seeding it would imply
deliveries that never occurred. The same is true of any file here after a reset:
an empty ledger means no activity, and that is a fact worth preserving rather
than papering over.

## Caveat

This is a pragmatic workaround for serverless state, not a database. It commits
application state into source control, and every write costs a commit. A real
deployment should point `DATABASE_URL` or the Vercel KV variables at actual
storage, at which point `realDB` uses those instead and these files become
read-only seed data.
