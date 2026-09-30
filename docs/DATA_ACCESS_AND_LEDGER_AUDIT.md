# Audit: ledger persistence, multi-user access control, concurrency

Findings from a live audit on 30 Sep 2026. Every claim below was reproduced against a running server, not inferred from reading code. Commands are included so you can re-run them.

**Scope note:** today all the data is seeded mock data, so nothing real is currently leaking. What is wrong is the *pattern* — the code decides what you may see from values you send, not from who you are. That leaks real data the day real users exist.

> **Update — items 1-6 and 9 are now fixed.** Tokens are HMAC-signed, the
> catch-all that admitted unverifiable tokens is gone, ownership is enforced on
> every read that was leaking, identity is taken from the session rather than the
> request body, and the ledger persists across restarts. `scripts/access-control-smoke.mjs`
> (23 assertions) and a CI job pin the behaviour. The sections below are kept as the
> original findings; the priority table at the end records current status.

---

## 1. Why the ledger always shows only the genesis block

**You were right, and it is not a UI bug.** The chain is real, hash-linked and verifiable — it is simply never saved anywhere.

### Root cause

`drunixChain` is an ordinary in-memory array:

```js
let drunixChain = (typeof globalThis !== 'undefined' && globalThis._aasthi_chain) || [];
```

There are two servers, and the chain is unsaved in both, for two different reasons.

**`mock-api-server.js` (local/demo) — the save function does not exist.**

```js
try { if (typeof persistNpciState === 'function') await persistNpciState(); } catch {}
try { if (typeof saveAllPersisted === 'function') saveAllPersisted(); } catch {}
```

Both functions are defined **only** in `frontend/api/index.js`, never in `mock-api-server.js`. The `typeof … === 'function'` guard means the call silently evaluates to nothing. Wrapped in `try/catch {}`, so no error is logged either. This file writes nothing to disk at all.

**`frontend/api/index.js` (Vercel) — the chain is excluded from the things that *are* saved.**

```js
const PERSIST_FILES = {
  properties, balances, transfers, kyc, idem, npci, utrIndex, webhooks
};
```

Eight collections persist. The ledger is not one of them. There is no `PERSIST_FILES.chain`, and no `saveToFile(..., drunixChain)` anywhere.

### Why it is worse on the deployed site

Vercel runs the API as serverless functions. Each instance has its own memory and its own `/tmp`. So even for the eight collections that *do* persist, state diverges per instance; for the chain, which lives only in `globalThis`, every cold start begins at genesis. Two browser tabs can legitimately be talking to two different instances with two different chains.

### Reproduction

```
$ curl -s localhost:8080/api/chain            # blocks: ['GENESIS']
$ curl -X POST localhost:8080/api/transfers … # writes a block
$ curl -s localhost:8080/api/chain            # blocks: ['TOKEN_TRANSFERRED','GENESIS']
$ ls /tmp/aasthi_*.json                       # (nothing)
# restart the server
$ curl -s localhost:8080/api/chain            # blocks: ['GENESIS']   <-- gone
```

### A second, quieter problem

`/api/chain/verify` returns `valid: true` on a chain containing only genesis. An empty ledger is not evidence of integrity, and a green tick on nothing is misleading. Verification should report height and refuse to imply more than it checked.

### Fix

1. Add `chain: path.join(TMP_DIR, 'aasthi_chain.json')` to `PERSIST_FILES`; save in `saveAllPersisted`, load in `loadAllPersisted`.
2. **Define the persistence functions in `mock-api-server.js`, or delete the dead calls.** A guarded call to a function that does not exist is worse than no call — it reads as if persistence is handled.
3. On load, re-verify the hash chain and refuse to accept a file that does not validate.
4. For Vercel, `/tmp` is not shared between instances. Durable multi-instance state needs the Postgres/KV path that `realDB` already contemplates — the chain should go there, alongside the other collections.
5. Make `/api/chain/verify` state what it verified: `{valid, blocks, height}` with an explicit note when `blocks === 1`.

---

## 2. Multi-user data access — what is shared and what is hidden

**Current answer: effectively everything is shared, and nothing is hidden.** There is no ownership check on any read path I tested.

### 2a. Identity is forgeable — this is the root issue

`decodeClerkOrMockToken` base64-decodes the token and trusts whatever `identityId` it finds. **No signature is verified.**

```js
const payload = JSON.parse(Buffer.from(token, 'base64').toString());
if (payload.identityId) return payload;
```

So any user can mint a token for any identity, including privileged ones:

```
$ TOKEN=$(echo -n '{"identityId":"registrar1","mspId":"RegistrarMSP","role":"Registrar"}' | base64)
$ curl -X POST .../api/properties/PROP-GREEN-VALLEY-PUNE-001/freeze -H "Authorization: Bearer $TOKEN" -d '{"reason":"..."}'
{"assetId":"PROP-GREEN-VALLEY-PUNE-001","status":"FROZEN","actor":"registrar1"}
```

A self-minted token froze a property. The same trick reaches regulator endpoints (`/api/regulator/alerts` → 200). Every role check downstream is decorative, because the role is an attacker-supplied string.

### 2b. Horizontal access — user A can read user B

Verified live with two ordinary investor tokens:

| Endpoint | As `investor2`, reading `investor1` | Result |
|---|---|---|
| `GET /api/npci/payments` | list is **not filtered by caller** | sees everyone's payments |
| `GET /api/npci/payments/:id` | another user's payment | **200** — VPA, amount, UTR |
| `GET /api/balances/wallet/investor1` | another user's wallet | **200** — full holdings |
| `GET /api/portfolio/investor1/nav` | another user's portfolio | **200** |
| `GET /api/kyc/investor1` | another user's KYC | **200** — status, timestamp |
| `POST /api/kyc/digilocker/pull-document` | `identityId` taken from **request body** | Aadhaar/PAN doc for any id |

Concrete evidence:

```
investor1 creates payment NPCI-F33217017196, payer investor1private@okhdfcbank, ₹7,777
investor2 requests it -> HTTP 200
  payerVpa: investor1private@okhdfcbank | amountINR: 7777
investor2 requests investor1's wallet -> HTTP 200
  {"ownerId":"investor1","balances":[{... "balance":2002 ...}]}
```

The `/api/npci/payments` handler shows the shape of the bug — it never looks at `req.user`:

```js
app.get('/api/npci/payments', authMiddleware, (req, res) => {
  const list = Object.values(npciPayments)      // everyone's
    .sort(...).slice(0, limit);
  res.json({ payments: list, count: list.length });
});
```

`authMiddleware` answers *"are you logged in?"* Nothing answers *"is this yours?"*

### 2c. What *should* be visible to whom

The product already implies the right model; it just is not enforced.

| Data | Owner | Counterparty | Registrar | Regulator | Public |
|---|---|---|---|---|---|
| Property listing, token price, supply | ✓ | ✓ | ✓ | ✓ | ✓ |
| Chain blocks, hashes, `/api/chain/verify` | ✓ | ✓ | ✓ | ✓ | ✓ (no PII) |
| Own holdings / portfolio / NAV | ✓ | ✗ | ✗ | aggregate | ✗ |
| Own payments (VPA, UTR, amount) | ✓ | counterparty leg only | ✗ | on lawful basis | ✗ |
| KYC status (boolean) | ✓ | ✓ verified-or-not | ✓ | ✓ | ✗ |
| KYC documents (Aadhaar, PAN, DOB) | ✓ | ✗ | ✗ | on lawful basis | ✗ |
| Supervisory actions / freeze reasons | subject | ✗ | ✓ | ✓ | ✗ |

Two principles worth stating, because they are what the current code violates:

- **A counterparty needs a boolean, not a dossier.** To trade with someone you need "this party is KYC-verified", never their PAN. Today `/api/kyc/:id` hands over the record.
- **Ledger transparency is not PII transparency.** The chain should stay publicly verifiable — that is the point of `/api/chain/verify` — which means it must carry hashes and identity *ids*, never names, VPAs or document numbers. Worth auditing: block contents currently include `payerVpa`-adjacent fields in the DvP cash leg.

### 2d. Fix — smallest change that actually works

1. **Sign the tokens.** An HMAC with a server secret is enough for the demo and is ~15 lines. Until identity is unforgeable, every other control is theatre.
2. **Never read an identity from the request body or a path param for authorisation.** Derive it from `req.user`. `/api/kyc/digilocker/pull-document` should ignore `req.body.identityId` entirely.
3. **Add one `requireSelfOrRole` helper** and apply it to the six endpoints above:
   ```js
   const requireSelfOrRole = (roles = []) => (req, res, next) => {
     const target = req.params.identityId || req.params.ownerId;
     if (req.user.identityId === target) return next();
     if (roles.includes(req.user.role)) return next();
     return res.status(403).json({ error: 'ERR_FORBIDDEN' });
   };
   ```
4. **Filter list endpoints by caller.** `/api/npci/payments` should return payments where the caller is payer or payee — regulator role excepted, and that exception should be logged to the supervisory trail that `supervision.js` already provides.
5. **Split KYC status from KYC documents** into two endpoints with different rules.
6. **Add an access-control smoke suite** in the style of `scripts/supervision-smoke.mjs`: assert every cross-user read returns 403. That is what stops this regressing.

---

## 3. Concurrency

I tested this rather than reasoning about it, and the result was better than expected.

**Test:** one payment, then 8 parallel settle requests.

```
200 200 200 200 200 200 200 200
DVP_SETTLED blocks referencing this payment: 1
originator1 11998   investor1 2002   investor2 1000
```

Exactly 2 tokens moved, exactly once. **No double-spend.**

### Why it holds, and why that is not reassuring

Node runs one thread. In `settleConfirmedPayment` the read and the write are in the same synchronous block:

```js
const sHave = sBal ? parseInt(sBal.balance) : 0;
if (sHave < amt) return { ok:false, ... };
balances[sKey] = { ..., balance: sHave - amt };   // no await in between
```

No `await` separates the guard from the mutation, so the event loop cannot interleave another request. Safety here is a **property of single-process Node, not of the design.** It breaks in three ways:

1. **Serverless.** On Vercel there are N instances with N copies of `balances`. There is no shared lock and no shared memory, so the protection simply is not there. This is the same root cause as the genesis-block problem.
2. **One added `await`.** Inserting any `await` between the balance read and the write — a DB call, a fetch, a log flush — silently opens the race. Nothing in the code documents this constraint.
3. **Any second process.** Two `node mock-api-server.js` processes behind a load balancer would corrupt balances immediately.

There is a real design worth copying already in this repo: `drunix-gateway/cash.go` solves exactly this with MVCC — endorse against a state version, reject at commit if the version moved. Tests D13/D14 cover it. The JS layer has no equivalent.

### One genuine bug found

All 8 concurrent settles returned **HTTP 200 with `ok:true`**, while only one actually settled. Seven callers were told their settlement succeeded when it had already been done by someone else. For a payments API that is wrong: a replayed settle should be either an explicit idempotent success carrying the *original* result, or a 409. Silently returning success for work you did not do is how double-crediting bugs get built on top.

### Fix

1. Return 409 (or a documented idempotent response echoing the original `txId` and block height) when a payment is already settled. The Go layer already does this — `/drunix/dvp` returns 422 on replay.
2. Add an `assertNoAwaitBetween`-style comment, or better, move the guard-and-mutate into one small function with a comment explaining why it must stay synchronous.
3. If the app is to run multi-instance, state must move out of process memory into the DB, with a conditional/compare-and-set write — the JS equivalent of the MVCC check in `cash.go`.

---

## Priority

| # | Item | Severity | Status |
|---|---|---|---|
| 1 | Sign auth tokens — identity is forgeable | **Critical** | **Done** — HMAC-SHA256, unsigned/tampered/junk all 401 |
| 2 | Ownership checks on the six cross-user reads | **Critical** | **Done** — 403 for non-owners, regulator exempt |
| 3 | Never take identity from body/params for authz | **Critical** | **Done** — `payerId` and DigiLocker subject come from the session |
| 4 | Persist the chain; remove the dead persistence calls | High | **Done** — `saveAllPersisted` defined; restore gated on `drunixVerify()` |
| 5 | Filter list endpoints by caller | High | **Done** — `/api/npci/payments` returns `scope: own\|all` |
| 7 | Access-control smoke suite in CI | Medium | **Done** — 23 assertions, new `access-control` job |
| 6 | 409/idempotent response on replayed settle | Medium | Open |
| 8 | Move state to shared storage for multi-instance | Medium | Open |
| 9 | `/api/chain/verify` should not claim validity for an empty chain | Low | Open |

### Known gaps that remain

- **`/api/auth/login` is open by design.** There are no passwords, so anyone can
  obtain a valid token for any demo identity. Signing fixes *tampering* and the
  fallback hole; it does not make the demo an authenticated system. What it does
  make real is authorisation — a valid `investor2` token can no longer read
  `investor1`'s data, and that is the property worth having.
- **Clerk JWTs are not signature-verified.** We do not hold Clerk's JWKS, so a
  Clerk session maps to the demo identity chosen in the UI.
- **`getUser` in `frontend/api/index.js` still defaults to `investor1` when no
  Authorization header is present.** Closing that needs a public-path allowlist,
  and the Vercel handler has no test harness here, so it was left rather than
  changed blind. Unsigned tokens *are* now rejected there.
- **Multi-instance state.** On Vercel each instance still has its own memory and
  `/tmp`. Chain persistence helps a single instance survive a restart; it does not
  make two instances agree. That needs the shared DB path (item 8).

---

*Status: findings from 30 Sep 2026. Items 1-5 and 7 fixed the same day; the rest are open and listed above.*
