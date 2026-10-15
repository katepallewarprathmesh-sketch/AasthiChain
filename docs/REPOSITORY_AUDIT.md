# Repository audit

Carried out 14 October 2026 against commit `4e6da94`, by inspection and by running every command
listed below. Findings are only recorded here if they were reproduced. Items marked **fixed** were
fixed in the same pass and have a regression test or a verification command next to them.

The audit deliberately does not list stylistic preferences. Everything here is either wrong,
misleading, missing, or unsafe.

## Baseline, before any change

| Check | Command | Result |
|---|---|---|
| Integration sweep | `bash regression.sh` | 120 passed, 0 failed |
| Go modules | `gofmt -l`, `go vet`, `go test -race` in each of 4 modules | all pass; `api-gateway` has no test files |
| Frontend build | `npm run build` | ok, 35 prerendered pages |
| Shell scripts | `shellcheck -S warning scripts/*.sh` | clean |
| Secret scan | `bash scripts/secret-scan.sh` | clean |
| CI | last 5 runs on `main` | success |

So the starting point was a working, green repository. Nothing in this audit is "the project is
broken". The findings are about safety margins, honesty of documentation, and how hard it is for a
stranger to run and contribute.

---

## P0, correctness and security

### A1. The request body was unbounded. **Fixed**

**Severity:** high for any self-hosted instance. **File:** `server.js`, `readBody`.

The local server collected request chunks until the client stopped sending, with no ceiling. A
single large POST could grow the process until it died, and no route in this repository has a use
for a body that large. Production on Vercel has a platform limit in front of it, which is why this
never showed up there, but `node server.js` is the documented way to run the project.

**Reproduction, before the fix:** POST a 2 MB JSON body to `/api/properties` and watch it be
buffered and parsed in full.

**Fix:** a `MAX_BODY_BYTES` ceiling, default 1 MB, configurable from the environment. Over the
limit the chunks are discarded as they arrive and the request is refused with
`413 ERR_BODY_TOO_LARGE`.

**Regression test:** `tests/transporthardening.test.mjs`, which also asserts the server is still
answering afterwards, since surviving the request is the actual point.

### A2. CORS was an unconditional wildcard with no way to close it. **Fixed**

**Severity:** medium. **File:** `frontend/api/index.js`.

`Access-Control-Allow-Origin: *` was set on every response with no configuration path. The read
surface is public by design, so the wildcard is a reasonable default, but a deployment that wants
to lock the API down had to edit code to do it.

**Fix:** `CORS_ALLOW_ORIGIN` accepts a comma-separated allowlist. The default remains `*`, so
nothing changes for existing deployments. With an allowlist set, an origin outside it receives no
CORS header at all rather than a quiet wildcard, and allowlisted responses carry `Vary: Origin`.

**Regression test:** `tests/transporthardening.test.mjs`.

### A3. The declared licence contradicted the licence file. **Fixed**

**Severity:** medium, and legal rather than technical. **Files:** `LICENSE`, `package.json`,
`README.md`.

`LICENSE` is the **Apache License 2.0**. `package.json` declared `"license": "MIT"` and the README
badge said MIT. Three sources, two answers, and the two wrong ones are the two a machine reads
first.

**Fix:** `package.json` and the README badge now say Apache-2.0, matching the file. The `LICENSE`
file itself was not touched, because changing a project's licence is the owner's decision and the
file is the authoritative statement of intent.

### A4. Path traversal in static serving. **Not a defect, verified**

`serveStatic` normalises the decoded path, strips leading `../` sequences and then refuses anything
that does not resolve inside `dist`. Checked by inspection and by request. No change made. Recorded
here so the next reader does not have to re-derive it.

---

## P1, reproducibility

### B1. `make test` reported success while running a quarter of the tests. **Fixed**

**Severity:** high, because it is the kind of thing that makes everything else untrustworthy.
**File:** `Makefile`.

```make
test: chaincode-test umi-test
	@echo "All tests passed"
```

That ran two Go modules and printed "All tests passed". The 121-check integration sweep, the
frontend build, the render smoke, the secret scan and two of the four Go modules were not in it.

**Fix:** the Makefile now has `test` (integration sweep), `test-go` (all four modules with gofmt
and vet), `test-all`, `smoke` and `secret-scan`, each documented by `make help`, and nothing claims
more than it ran.

### B2. There was no single command to start the project. **Fixed**

**Severity:** high for a first-time contributor. **Files:** `Makefile`, `package.json`.

`scripts/devup.sh` and `scripts/dev-stack.sh` already did the work, but neither the README quick
start, the Makefile nor `package.json` pointed at them: the documented path was four manual steps
across two terminals with an environment variable that is required but reads as optional.

**Fix:** `make dev` installs, builds and starts both halves; `make stop` stops exactly what it
started. `npm run dev` does the same. Verified from the repository root with both ports free.

### B3. No root `.env.example`, and `.gitignore` would have eaten one. **Fixed**

**Severity:** medium. **Files:** `.gitignore`, `.env.example`.

Only `.env.payu.example` existed, covering payments and nothing else. Worse, `.gitignore` contained
`.env*` with a negation for the PayU example only, so adding `.env.example` would have silently
failed to track it: the classic version of this mistake.

**Fix:** `!.env.example` added to the negations, and a root `.env.example` written covering the
core, demo auth, rail, limits, persistence, payments and every optional integration, with no real
credential and a note on each that nothing in it is needed for the demo. Verified with
`git check-ignore` and `git add -n`.

### B4. Test counts in the documentation were wrong. **Fixed**

**Severity:** medium, since a wrong number in the README is the first thing a reader can check.

The README contributing section said `npm test` runs 104 checks, and `docs/DEMO.md` claimed 58
suites and 23 Go test files. Actual, from command output: 121 checks across 76 suite files, and 36
Go test files. Fixed in both places, and `docs/TESTING.md` now explains what the number counts,
because "checks", "suites" and "assertions" are three different things in this repository and were
being used interchangeably.

### B5. `package.json` metadata was thin. **Fixed**

No `repository`, `bugs`, `homepage`, `engines` or keywords, and the wrong licence. All added; the
Node floor is declared as `>=20`, which is what CI uses and what the code requires.

---

## P2, first impression

### C1. No `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, issue templates or PR template. **Fixed**

All four added. The contributing guide leads with the one design rule that actually gets pull
requests rejected here (money rules belong in the Go core) and the two-implementation trap
(`frontend/api/index.js` and `mock-api-server.js` must change together), because those are what a
newcomer would get wrong.

### C2. No `docs/TESTING.md`. **Fixed**

Added, with the exact command for each category, what it needs, what it proves, what it does not
cover, and the known gaps stated plainly rather than omitted.

---

## P0, found by running on the real two-org network (15 October 2026)

Both of these were invisible to the test suite and to every single-peer run.
They were found only by deploying to a live Drunix network with two
endorsing organisations and a SQL state database.

### A5. The chaincode was not deterministic, so no write could ever commit. **Fixed**

**Severity:** critical. The write path did not work at all on a real network.
**Files:** `chaincode/property.go`, `chaincode/token.go`, `chaincode/kyc.go`.

`RegisterProperty` built its asset id with `uuid.New()` and every contract
stamped records with `time.Now()`. Fabric and Drunix execute a transaction on
one peer per endorsing organisation and compare the write sets. Random ids and
local clocks differ per peer, so the two proposals never matched.

**Repro:** submit `PropertyContract:RegisterProperty` through the gateway
against a network with an endorsement policy spanning two organisations.

```
Address: peer0.org2.example.com:9051  MspId: RegistrarMSP
Message: ProposalResponsePayloads do not match
```

**Fix:** `chaincode/determinism.go`. `txTime(ctx)` reads the transaction
timestamp from the proposal and `txID(ctx, prefix)` derives identifiers from
the transaction id, so every endorser computes the same bytes. Fourteen call
sites converted; the chaincode no longer imports `uuid`. `txTime` returns an
error rather than falling back to the local clock, because a conditional
guarantee is not a guarantee.

**Regression test:** `chaincode/determinism_test.go` reads the package source
and rejects `uuid.New()`, `time.Now()`, `rand.*` and `time.Since` outside the
helper, and asserts `txTime` has no local-clock fallback. Running the
chaincode once cannot detect non-determinism, so the test does not try.
Verified against a sabotage that compiles.

### A6. Bare-string index values crashed the committing peers. **Fixed**

**Severity:** critical. It took the network down permanently, not just the
transaction. **Files:** `chaincode/property.go`, `chaincode/token.go`.

Drunix keeps world state in YugabyteDB in a JSON column. This chaincode wrote
four index entries whose value was a bare identifier string, which is normal
Fabric practice on LevelDB and is not valid JSON.

**Repro:** register a property on Drunix. The transaction is endorsed and
ordered, then the committing peers die:

```
ERRO [sqldb] Error in batch sql write. err:ERROR: invalid input syntax for
type json (SQLSTATE 22P02)
panic: error during commit to txmgr
```

The peer panics instead of rejecting, and the block is already ordered, so it
panics again on every restart while replaying it. Endorsement keeps working
from the lite peers, which makes it look like a client problem: the gateway
only sees its commit status stream close with `EOF`.

**Fix:** `chaincode/statevalue.go`. `indexValue()` writes index targets as JSON
strings and `indexRef()` reads them back, still accepting bare strings so
pre-existing entries resolve.

**Regression test:** `chaincode/statevalue_test.go` checks the encoding round
trip and scans the source for `PutState(key, []byte(...))`. Verified against a
sabotage that compiles.

**Portability note for anyone reusing this chaincode:** on Drunix every value
written to world state must be valid JSON, index entries included. That is a
real difference from stock Fabric with LevelDB.

## Open findings, not fixed in this pass

### D1. `api-gateway` has no tests

Four Go modules, 293 test functions between three of them, and zero in the fourth. It is not on the
demo path, which is why it has survived untested, but it is in CI's build matrix and in the
repository layout. Listed as a good first issue.

### D2. There is no ESLint configuration

ESLint 10 will not run without one, so the frontend has no lint or type gate; `npm run build` is
the proxy. Adding a flat config that passes on the existing code is contained work. Listed as a
good first issue.

### D3. List endpoints are unbounded

`/api/properties` and the ledger routes return every row. At demo scale this is nothing, and adding
pagination changes a public response shape, so it was not done quietly in an audit pass. Listed as
a good first issue with the compatibility constraint stated.

### D4. No Docker Compose for the application stack

A compose file for the app plus the rail is feasible: the rail already has a Dockerfile that CI
builds and runs. It was **not** added here, because Docker is not available in the environment this
audit ran in, and shipping an unverified compose file that a new contributor runs first would make
the project less reliable, not more. `make dev` is the verified one-command path. This remains
worth doing by someone who can test it.

### D5. Two API implementations are still maintained by hand

`frontend/api/index.js` and `mock-api-server.js` implement the same surface and must be edited
together. Four defects have been traced to drift between them. `server.js` exists to narrow this by
serving the production handler locally, and the suites increasingly assert against both files, but
the duplication itself remains.

### D6. The demo marketplace contains junk data

On the hosted instance: a listing titled "Mint Scope Probe" with no address, and three listings
whose city and pincode do not agree (Lonavala and Panvel at 411045, which is Pune). The address
check flags the mismatched ones the moment they are opened. This is deployment data, not code, and
needs one removal press by the owner.

### D7. Unrotated credentials on the hosted deployment

Tracked outside this repository in the owner's handover notes: an exposed third-party RPC key and
an admin dashboard key both need rotating. Neither is in the source tree, and `make secret-scan`
confirms nothing credential-shaped is tracked.

---

## How to re-run this audit

```bash
make dev
make test            # 121 checks
make test-go         # 4 modules
make smoke
make secret-scan
shellcheck -S warning scripts/*.sh
git check-ignore -v .env.example    # must report the negation, not an ignore
```
