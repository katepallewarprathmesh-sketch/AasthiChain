# Removing the second API

**Status:** proposal, not started. Nothing in this document has been implemented.

## 1. The problem, stated as evidence

AasthiChain ships the same HTTP API twice:

| file | lines | runs where |
|---|---|---|
| `mock-api-server.js` | 3,073 | local dev, `regression.sh`, CI, `dev-stack.sh` |
| `frontend/api/index.js` | 4,252 | Vercel — **what the public hits** |

82 routes are declared in the Express server. Every automated check in the repo
points at it. Vercel runs the other file. The two are maintained by hand.

Four defects in one session came from that split, and none was caught by the
suite:

| defect | symptom | who was wrong |
|---|---|---|
| `/api/admin/ops` missing | Ops page: spinner, then "Not found" | serverless |
| `POST /api/properties/:id/verify-document` missing | deed checker 404s in production | serverless |
| `/api/umi/metrics` | Prometheus text rewritten into an error object, returned as HTTP 200 | serverless (Express had a bypass route) |
| `/api/npci/reconcile` | UTR dashboard shows zeros in dev, real numbers in production | **Express** |

The last one is the important one. The drift runs in *both* directions, so
"test the deployed one instead" is not a fix either. The only durable answer is
to stop having two.

Two guards now exist and should be kept whichever option is chosen:

- `tests/apiparity.test.mjs` — every Express route must be reachable on the
  serverless handler. Catches a missing route; **cannot** catch a wrong answer.
- `scripts/api-shape-audit.mjs` — diffs the actual responses. Catches a wrong
  answer, but is data-dependent, so it is a human-run diagnostic, not CI.

Both are workarounds for the duplication. Deleting the duplication retires them.

## 2. What must not break

- The 73-check regression suite, the 29-route render smoke, and CI (5 job
  definitions in `ci.yml`, 8 check runs — the Go job is a 4-module matrix).
- `UMI_GATEWAY_URL` proxying to the Go rail. **All UMI logic stays in Go.** The
  Node layer remains a pure proxy with zero UMI state — unchanged by this work.
- `GET /api/umi/events` (SSE). It exists **only** in Express. Vercel functions
  cannot hold a connection open, so the deployed site has never had it;
  `useLedgerStream.js` opens an `EventSource`, waits, and falls back to polling
  on its own. That fallback is deliberate and must survive.
- The in-memory/`/tmp`/GitHub-backed persistence layers in `frontend/api/lib/`.

## 3. Options

### A. Serverless handler becomes the only implementation *(recommended)*

`frontend/api/index.js` already covers all 82 routes — the parity suite proves
it. Replace `mock-api-server.js` with a thin Node `http` server that adapts
`IncomingMessage`/`ServerResponse` to the `(req, res)` shape the handler
expects, plus the one SSE route the handler cannot serve.

- **Deletes** ~3,000 lines.
- Every existing test keeps pointing at `localhost:8080` and keeps passing —
  but now exercises **production code**. That is the entire point: the suite
  stops testing a server nobody runs.
- The adapter must supply what Express gave for free: URL parsing, a parsed
  JSON `body`, `res.status().json()`, `res.setHeader`, CORS, and static serving
  of `frontend/dist`.
- SSE stays as a special case ahead of the handler, exactly where it is today,
  and stays dev-only — matching production rather than hiding the difference.

### B. Express becomes the only implementation, wrapped for Vercel

Run `mock-api-server.js` on Vercel via `serverless-http`.

- Rejected. It inverts which code is proven in production, imports an Express
  cold-start cost into every lambda, and `frontend/api/index.js` already
  contains the GitHub/`/tmp` persistence that exists *because* lambdas are
  stateless. Porting that back into Express is a rewrite, not a merge.

### C. Extract a shared core, keep two thin hosts

Cleanest on paper, largest diff. Both files would have to be refactored at once
with no intermediate state where the app works. Option A reaches the same end
state — one implementation, two entry points — with the adapter as the only new
code.

## 4. Plan for option A

Each step ends green on the full gate; none is a point of no return.

1. **Adapter, no deletions.** Add `server.js`: a Node `http` server that serves
   `frontend/dist`, handles the SSE route, and delegates everything else to the
   serverless handler. `mock-api-server.js` untouched. Verify by running the
   whole suite against `server.js` on a spare port.
2. **Switch the suite over.** Point `regression.sh`, `dev-stack.sh`,
   `devup.sh`, CI, and `package.json#main` at `server.js`. Expect failures
   here: they are real bugs in the serverless handler that the Express server
   was masking. Fix each in the handler. **This step is the whole value of the
   exercise** — it is where production code finally gets tested.
3. **Delete `mock-api-server.js`.** Only once step 2 is green twice in a row.
   Retire `tests/apiparity.test.mjs` in the same commit, since it compares a
   file that no longer exists, and note in `scripts/api-shape-audit.mjs` that
   it is now historical.
4. **Docs.** `README.md`, `docs/DOCUMENT-TOUCHPOINTS.md` and the devup banner
   all name `mock-api-server.js`.

## 5. Risk

The honest risk is step 2. The serverless handler has never been run against
3,000 lines of assertions, and some of those 73 checks will fail — not because
the adapter is wrong, but because the handler genuinely differs. The shape
audit says the differences are unconsumed metadata keys (`fabricMode`,
`indexUsed`, `documentHashVerified` and friends, none read by the frontend),
which suggests the damage is small. "Suggests" is not "proves", and step 2 is
where that gets settled.

The mitigation is the step order: the adapter lands first and changes nothing,
and the old server stays on disk until the new path has been green twice.
Reverting at any point before step 3 is a one-line change to `package.json`.

## 6. Estimate

Step 1 is a few hours. Step 2 is unbounded until step 1 reveals the failure
list — that is the measurement, and it is cheap to take. Step 3 and 4 are
minutes. Recommend doing step 1, reporting the failure count, and deciding
about step 2 with that number in hand.
