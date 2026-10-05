# Operations runbook

Things only you can do, with the exact commands. Work top to bottom.

---

## 1 · Deploy the Go rail (blocking everything else)

The supply cap is pushed but **not live**. Until Render builds `drunix-gateway`,
`POST /api/umi/seed` still mints tokens from nothing.

- Render dashboard → the `drunix-gateway` service → **Manual Deploy → Deploy latest commit**
- Confirm it took:

```bash
curl -s https://aasthi-chain.vercel.app/api/umi/reconciliation | grep -o supplyConserved
# prints "supplyConserved" on the new build, nothing on the old one
```

```bash
# should now be refused with 409 ERR_UMI_SUPPLY_EXCEEDED
curl -s -X POST https://aasthi-chain.vercel.app/api/umi/seed \
  -H 'content-type: application/json' \
  -d '{"assetId":"PROP-GREEN-VALLEY-PUNE-001","holder":"attacker","tokens":999999}'
```

---

## 2 · Correct the inflated token books

Only after step 1. Seeding is absolute now, so each call sets the position **and**
fixes the authorised supply. No blocks are erased.

```bash
for a in '"PROP-INDIABULLS-001",10000' \
         '"PROP-GREEN-VALLEY-PUNE-001",15000' \
         '"PROP-GODREJ-001",10000'; do
  id=${a%,*}; n=${a#*,}
  curl -s -X POST https://aasthi-chain.vercel.app/api/umi/seed \
    -H 'content-type: application/json' \
    -d "{\"assetId\":$id,\"holder\":\"originator1\",\"tokens\":$n,\"authorisedTokens\":$n}"
  echo
done
```

Check the asset IDs against `/insights` first — correct them in the loop if they differ.
Then confirm `/insights` shows every property at **100.0% or below**, with no red overflow line.

---

## 3 · Switch demo seeding off

Once the books are correct, seeding has no further use — it issues securities.

- Render → `drunix-gateway` → Environment → `UMI_SEED_DEMO` = `false` → redeploy
- `POST /umi/seed` then returns 404.

---

## 4 · Clerk production key

Clerk is now the only way into the product, and the current key is
`pk_test_…` — a development instance, capped around 100 users, with a dev banner.

1. Clerk dashboard → create a **production** instance
2. Add the domain `aasthi-chain.vercel.app`
3. Vercel → Environment Variables → `VITE_CLERK_PUBLISHABLE_KEY` = the `pk_live_…` key
4. Redeploy, then **sign in yourself before telling anyone** — this is the door; test it.

---

## 5 · Turn on Clerk signature verification

Shipped but dormant. Without it, a forged Clerk-shaped JWT is still accepted.

- Vercel → `CLERK_ISSUER` = your Clerk Frontend API URL
  (`https://<instance>.clerk.accounts.dev`, or your production domain)
- Redeploy, then sign in again to confirm. If sign-in breaks, the issuer value is wrong —
  unset it and the API reverts to the previous behaviour immediately.

---

## Standing rules

- **`DEMO_AUTH` must stay unset.** Setting it to `true` reopens `/api/auth/login`,
  which mints a session for any identity with no credential.
- **`DATABASE_URL` is still not set on Render.** Without it the rail keeps blocks and
  idempotency records in memory and loses them on restart.
- Before any push: `bash regression.sh` must report **44 passed**.

## Post-deploy checks

```bash
# demo login must be gone
curl -s -X POST https://aasthi-chain.vercel.app/api/auth/login \
  -H 'content-type: application/json' -d '{"identityId":"x","role":"Regulator"}'
# expect 404 ERR_NOT_FOUND

# search engines
cd frontend && npm run indexnow
```
