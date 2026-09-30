# Deploy AasthiChain to Vercel — Production-Ready

This frontend is now Vercel-ready with serverless API.

## 1-Click Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/your-org/aasthichain)

## Manual Deploy via Vercel CLI

```bash
# Install Vercel CLI
npm i -g vercel

# From frontend folder
cd frontend
vercel --prod

# First time: Vercel will ask:
# - Set up and deploy? Y
# - Which scope? Your account
# - Link to existing project? N
# - Project name: aasthichain
# - In which directory is your code located? ./
# - Override settings? N (uses vercel.json)

# Subsequent deploys:
vercel --prod
```

## Manual Deploy via Vercel Dashboard

1. Push this repo to GitHub
2. Go to https://vercel.com/new
3. Import your GitHub repo
4. Configure:
   - Framework Preset: Vite
   - Root Directory: `frontend`
   - Build Command: `npm run build` (auto from vercel.json)
   - Output Directory: `dist`
   - Install Command: `npm install`
5. Click Deploy
6. Your live URL: `https://aasthi-chain.vercel.app` (or similar)

## What Gets Deployed

- **Frontend:** Static build from `dist/` — Fintech UI per spec (paper #F7F5F0, registry-navy #1E3A5F, Fraunces+Inter)
- **API:** Serverless functions at `/api/*` — same mock Fabric client logic as local demo
  - `GET /health` — health check
  - `POST /api/auth/login` — mock JWT
  - `GET /api/properties` — list with idx_property_status
  - `POST /api/properties` — register with auto SHA-256 hash per §5.1
  - `POST /api/properties/:id/validate` — registrar validation
  - `POST /api/properties/:id/mint` — dual endorsement AND(Originator,Registrar) + persistent idempotency
  - `POST /api/transfers` — peer transfer with all §6.2 edge cases
  - `POST /api/transfers/failure-demo` — A7 live failure demo
  - `GET /api/transfers/history?pageSize=10&bookmark=...` — A3 pagination via bookmark cursor
  - `GET /api/balances/wallet/:ownerId` — idx_balance_owner

## Environment Variables (Optional)

No env vars required for mock mode. For live Fabric mode (future):

```
FABRIC_MODE=live
FABRIC_PEER_ENDPOINT=...
FABRIC_CERT_PATH=...
```

But for Vercel mock demo, leave empty — uses in-memory mock with 25 seeded transfers.

## After Deploy

Your Vercel URL will be live with:

- Marketplace with % sold progress bars per §4.1
- Wallet with tabular nums, both units (tokens ↔ ₹) per §5.2, Max/25%/50%/75% chips
- Admin with file upload auto SHA-256 per §5.1, dual-endorsement notice per §3.3
- Regulator audit with pagination bookmark cursor per A3, cap table % desc per §3.5
- Failure-mode demo per A7 — live rejection of invalid transactions
- Demo role switcher visible per §5.4

Login presets: originator1, registrar1, investor1, investor2, regulator1

## Local Test of Vercel Build

```bash
cd frontend
npm run build
npx vercel dev  # Runs vercel.json routes locally
# Open http://localhost:3000
```

## Notes

- Vercel serverless functions are stateless — state resets on cold start. For production Vercel, replace in-memory maps with Vercel KV or Postgres.
- For demo, global variables persist across warm invocations, so transfers work within same session.
- Frontend dist is 237KB bundle (Fraunces+Inter) — verified build.
