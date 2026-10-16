# Testing

Every number on this page came from running the command next to it on 14 October 2026, on a clean
checkout at commit `4e6da94`. If a figure here disagrees with what you get, the page is stale:
please open an issue rather than assuming your machine is wrong.

## The short version

```bash
make dev        # start the stack first: most suites talk to a running server
make test       # integration sweep:  126 checks, 0 failed
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
| Suite files | **81** in `tests/` |
| Reported result | **126 passed, 0 failed** |

`tests/credentials.test.mjs` is worth running on its own when touching the rail proxy. It
verifies a credential's Ed25519 signature inside the test process, using only the issuer's
published key, so it fails if anything between the rail and the client alters a single byte
of a signed document.

```bash
node tests/credentials.test.mjs     # 18 checks, needs make dev
node tests/mandates.test.mjs        # 22 checks, needs make dev
```

`tests/mandates.test.mjs` covers delegated authority: an agent settling on a principal's
behalf. It drives the Go rail directly rather than the web proxy, because the proxy only
recognises the five named demo identities and files anything else as `investor1`, which
would hide the very thing under test. The rail is where every bound is enforced.
| Runtime | about 50 seconds |

**Read the number carefully.** The 126 is the count of top-level checks the sweep reports: each
direct HTTP assertion counts once, and each suite file counts once however many assertions it
contains. Individual suites print their own totals, which are finer grained. For example
`verifyproperty` reports 29 assertions and `pincodecheck` reports 26, but each contributes 1 to the
126. There is no single meaningful "total assertions" figure, and this project does not publish
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
