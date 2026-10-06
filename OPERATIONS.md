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

## Rotating the PayU salt

The salt is the only thing standing between a stranger and a forged
payment-success callback. The response hash is
`sha512(salt|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key)`
— anyone holding the salt can compute a hash the gateway will accept and mark
an unpaid order as settled. Treat any salt that has been pasted into a chat,
an issue, a screenshot or a log as burned.

The salt is not, and must never be, in this repository. It lives only in the
environment. `scripts/secret-scan.sh` runs in the regression sweep and fails
the build if a credential is ever committed.

Rotation is a four-step job and the middle two must happen close together,
because callbacks signed with the old salt stop verifying the moment PayU
starts signing with the new one.

1. **Generate** a new salt in the PayU dashboard
   (Settings → Security / Salt & Key). Keep the old one visible — PayU shows
   both during the overlap.
2. **Update the environment** everywhere the gateway runs. Production is
   Vercel: Project → Settings → Environment Variables → `PAYU_SALT`. Also
   update any local `.env.payu`. Do not edit `.env.payu.example`; it holds
   placeholders on purpose.
3. **Redeploy.** Vercel does not apply an env-var change to the running
   deployment — trigger a fresh deploy or the old salt stays live.
4. **Verify** with a ₹1 test purchase end to end, and confirm the callback is
   accepted rather than rejected for a hash mismatch. Then revoke the old salt
   in the PayU dashboard.

Checks that the rotation worked:

    # the deployment is serving the build you expect
    curl -s https://<host>/api/admin/insights/status

    # a callback with a hash computed from the WRONG salt must be refused
    node tests/payusettle.test.mjs    # covers the forged-hash rejection path

If a callback starts failing after rotation, the usual cause is step 3: the
env var changed but the deployment did not.
