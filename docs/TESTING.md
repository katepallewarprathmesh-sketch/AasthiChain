# Testing

Every number on this page came from running the command next to it on 14 October 2026, on a clean
checkout at commit `4e6da94`. If a figure here disagrees with what you get, the page is stale:
please open an issue rather than assuming your machine is wrong.

## The short version

```bash
make dev        # start the stack first: most suites talk to a running server
make test       # integration sweep:  145 checks, 0 failed
make test-fresh # the same sweep, on a restarted stack (use for a repeat run)
make test-go    # four Go modules:     gofmt, go vet, go test -race
make smoke      # every frontend route renders real content
make secret-scan
```

`make dev` is not optional for `make test`. A stack that is not running produces a wall of
failures that look like code defects and are not.

---

## What each command actually covers

### `make test` — the integration sweep

Runs `regression.sh`, which does two things: a direct list of HTTP checks against the app and the
rail, and then every file matching `tests/*.test.mjs`.

| | |
|---|---|
| Command | `bash regression.sh` |
| Needs | the app on `:8080` and the rail on `:21100` (`make dev`) |
| Suite files | **100** in `tests/` |
| Reported result | **145 passed, 0 failed** |

`tests/credentials.test.mjs` is worth running on its own when touching the rail proxy. It
verifies a credential's Ed25519 signature inside the test process, using only the issuer's
published key, so it fails if anything between the rail and the client alters a single byte
of a signed document.

```bash
node tests/credentials.test.mjs     # 18 checks, needs make dev
node tests/mandates.test.mjs        # 22 checks, needs make dev
node tests/attestation.test.mjs     # 21 checks, needs make dev
node tests/outcome.test.mjs         # 21 checks, needs make dev
node tests/proofpage.test.mjs       # 13 checks, needs make dev
```

`tests/proofpage.test.mjs` guards the proof page: it reads the page source to prove no bare
`fetch` has crept back in (one did, and it made the agent authority tab unusable for everybody),
then calls each route the page reads as a signed-in participant.

`tests/outcome.test.mjs` covers outcome-based settlement on the work desk: criteria that
cannot be edited after the engagement opens, a verifier who is neither party, verification
that does not move money by itself, a dispute window that only the clock or the funder can
shorten, and a failed check that freezes the escrow instead of paying it out. It uses a one
second window so the timing path is actually exercised rather than asserted.

`tests/mandates.test.mjs` covers delegated authority: an agent settling on a principal's
behalf. It drives the Go rail directly rather than the web proxy, because the proxy only
recognises the five named demo identities and files anything else as `investor1`, which
would hide the very thing under test. The rail is where every bound is enforced.
| Runtime | about 50 seconds |

**Read the number carefully.** The 143 is the count of top-level checks the sweep reports: each
direct HTTP assertion counts once, and each suite file counts once however many assertions it
contains. Individual suites print their own totals, which are finer grained. For example
`verifyproperty` reports 29 assertions and `pincodecheck` reports 26, but each contributes 1 to the
143. There is no single meaningful "total assertions" figure, and this project does not publish
one.

Three suites are skipped by the `api` CI job and run in the `contracts` job instead, because they
need `solc`, a local EVM chain and the reference IPFS hasher: `contracts`, `cidconformance`,
`evmmirror`. Locally they run if you have the toolchain and are reported as failures if you do not,
which is deliberate. A test that silently skips is worse than one that fails loudly.

### `make test-go` — the Go modules

Runs `scripts/go-tests.sh`: `gofmt -l`, `go vet` and `go test -race -count=1` for each module in
turn. There is no single module graph in this repository, so a root-level `go test ./...` cannot
work.

| Module | Test files | Test functions | Result |
|---|---|---|---|
| `chaincode` | 1 | 6 | ok |
| `drunix-gateway` | 29 | 244 | ok |
| `payment-gateway` | 6 | 43 | ok |
| `api-gateway` | 0 | 0 | **no test files** |

`api-gateway` having no tests is a real gap, not an oversight in this document. It is listed as a
good first issue in [`CONTRIBUTING.md`](../CONTRIBUTING.md).

### `make smoke` — the frontend renders

Builds the bundle with `vite.smoke.config.js` and renders every route in Node, failing if any route
produces an error boundary instead of content. This exists because a route can compile perfectly
and still throw on first paint.

| | |
|---|---|
| Command | `cd frontend && npm run smoke` |
| Needs | nothing running |
| Catches | render-time crashes, missing providers, bad imports |
| Does not catch | anything that needs a backend, and anything visual |

### `make secret-scan` — tracked credentials

`scripts/secret-scan.sh` greps every tracked file for things shaped like live credentials: GitHub
tokens, PayU salts and merchant keys, inline admin keys. Known placeholders (`devkey`, `testsalt`,
`example`) are allowed. It runs inside the regression sweep as well, so a secret cannot pass
`make test`.

### `npm run build` — the lint proxy

**There is no ESLint configuration in this repository.** ESLint 10 refuses to run without one, so
the frontend has no lint gate today. Until one exists, `npm run build` and `node --check` are what
catch syntax and import errors. Adding a flat config is a good first issue.

---

## How much of the rail do these checks actually touch?

A pass count is not a coverage figure. Ninety-eight suites passing says nothing about how much of
the rail they reach, and the honest way to find out is to measure it rather than assume.

The approach is borrowed from Scapia's write-up of their Argus test lab (October 2026). Their
second tool is the interesting one: map every action a user can take, replay the suite against that
map on paper, and give each action one of three verdicts. Their own published answer was
uncomfortable (24.6% of commerce actions certainly covered, one vertical under 2%) and publishing
it was the point.

    node scripts/coverage-rail.mjs          the figure, by area
    node scripts/coverage-rail.mjs --gaps   exactly what nothing reaches

The tool reads source only, starts nothing and executes nothing, so the same commit gives the same
number on any machine. It builds the catalogue from the route table declared at the top of each
server file, cross-checks every declared path against the registered routes so the catalogue cannot
drift into fiction, then replays each suite's requests against it.

| Verdict | Meaning |
| --- | --- |
| covered | a suite certainly issues this method against this path |
| possible | a suite reaches the path, but the method is not provable from the source |
| not covered | nothing in the suite reaches it |

As measured: **61.3%** of 93 rail actions are certainly covered, 17.2% are possible, and the rest
are reached by nothing. `tests/coverage.test.mjs` recomputes this on every run and fails if the
published figure drifts from the measured one, if coverage falls below its floor, or if a declared
route stops being served.

The measurement earned its keep immediately. It showed that `POST /umi/cbdc/transfer` and
`POST /umi/cbdc/redeem` were exercised by nothing at all: the conservation identity was being
asserted without either of the two paths that can break it. The Travel Rule refusal and the
corridor dry run were in the same state. Those now have tests, which is how the figure moved from
51.2% to 58.1%, and the interoperability layer arrived with its own suite.

## Does the suite catch anything? Planted defects

A green suite has two possible meanings and no way to tell them apart: the code is correct, or the
assertions are weak. Argus had the same problem, and settled it by deleting a real feature on a
branch to see whether the suite noticed.

    node scripts/plant-defect.mjs            plant each defect, run the suite that should notice
    node scripts/plant-defect.mjs aml-threshold

Each defect is a mistake somebody could plausibly make in review: a threshold nudged out of reach, a
guard dropped, a refusal softened. The harness edits the file, rebuilds and restarts the rail, runs
the one suite that should fail, then restores the file in a `finally` block. It refuses to start if
the files it touches have uncommitted changes.

| Planted defect | Caught |
| --- | --- |
| Screening stops blocking (block threshold raised out of reach) | yes, 5 checks |
| The Aadhaar refusal is removed, so a twelve digit number is accepted | yes, 2 checks |
| A video session without liveness is treated as face-to-face | yes, 2 checks |
| The Travel Rule check passes with the parties unnamed | yes, 3 checks |
| The proposing agent stops re-reading its evidence before acting | **no, first time; yes, 3 checks, now** |

All five are caught as of the current commit. One was not, and that is the row worth reading.

The last row is why the harness exists. Removing the agent's freshness check broke nothing any test
could see, because the suite accepted either outcome at that point and only the Go unit test
covered staleness. Worse, the hole was real in the code as well: the freshness check handled AML
cases but never conditional payments, so a proposal about a payment that had already been released
would have been approved and acted on. Both are fixed, and the scenario is now tested end to end.

These are five planted defects, not a proof. They say the suite notices these five specific
mistakes, and nothing about the ones nobody thought of.

## Continuous integration

`.github/workflows/ci.yml` runs on pushes and pull requests to `main`, with `permissions:
contents: read` and no secrets exposed to any job.

| Job | What it proves |
|---|---|
| `go` (matrix of 4 modules) | formatting, dependency resolution, build, vet, race tests |
| `frontend` | `npm ci`, production build, render smoke |
| `api` | shellcheck on `scripts/`, boots the real stack plus a PayU test rig, then runs **every** file in `tests/` by discovery |
| `contracts` | compiles the Solidity, runs a local EVM chain, checks our CIDs against the reference IPFS implementation, and reads anchors back from the chain rather than from our own API |
| `image` | builds the container Render deploys and checks the binary answers `/health` |

The `api` job discovers suites rather than listing them. A new file in `tests/` is covered by CI
the moment it exists, which was not true before and is why several suites once ran only locally.

---

## Writing a test here

Suites are plain Node, no framework. The shape is consistent across the directory:

```js
const t = (name, ok, detail) => { /* count and print */ }
t('a real Pune pincode verifies', check.status === 'VERIFIED', check.detail)
console.log(`\nmysuite: ${pass} passed, ${fail} failed`)
assert.equal(fail, 0)
```

Two rules that matter more than style:

1. **Sabotage your own test before trusting it.** Break the code it covers, confirm it fails, and
   confirm it fails for the right reason. A sabotage that does not compile proves nothing. Several
   assertions in this repository were found to be vacuous exactly this way.
2. **Cold-start the stack before believing a single failure.** The sweep is not idempotent across
   runs on one long-lived stack, and `make test-fresh` is that restart in one command. The usual
   cause is the fraud engine rather than drift: the velocity rule counts the demo payer's payments
   over ten minutes, every run uses the same demo identity, so a second run inside that window is
   blocked on purpose and three suites fail with `FAILED_FRAUD_BLOCKED`. The sweep now says so when
   it sees that status, instead of leaving the reader to conclude the repository is broken.

---

## Known limitations

- **No end-to-end browser test.** The render smoke proves routes mount; it does not click through a
  purchase. The closest thing to a full journey check is the integration sweep plus the manual
  walkthrough in [`DEMO.md`](DEMO.md).
- **No coverage measurement is published.** None is collected, so no percentage is claimed.
- **No load or soak testing.** The throughput figures in [`THROUGHPUT.md`](THROUGHPUT.md) come from
  Go benchmarks on one machine and are labelled `measured:false` where they are derived rather than
  observed.
- **The Fabric network under `network/` is not exercised by CI.** It needs Docker and the Fabric
  binaries, and nothing in the demo path depends on it.
- **`api-gateway` is untested**, as noted above.
