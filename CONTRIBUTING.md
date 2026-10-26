# Contributing to AasthiChain

Thanks for looking. This file is the short version of how the project is built and what a
reviewable change looks like here.

## Getting it running

Prerequisites: **Go 1.25+**, **Node 20+**, **python3** (the regression script parses JSON with it).
Docker is needed only for the optional Hyperledger Fabric sandbox.

```bash
git clone https://github.com/katepallewarprathmesh-sketch/AasthiChain.git
cd AasthiChain
cp .env.example .env     # optional: the defaults already work
make dev                 # installs, builds, starts the app on :8080 and the rail on :21100
```

`make dev` is the whole setup. It is also what the maintainer uses, so if it breaks, that is a bug
worth reporting on its own. Stop everything with `make stop`.

Sign in as `investor1`. The other demo identities are `originator1`, `registrar1`, `investor2` and
`regulator1`.

## The one design rule

**Every rule about money lives in the Go settlement core, next to the ledger it protects.** The
JavaScript layers carry requests and identity and decide nothing about balances, positions or the
chain. A money rule added to the JS edge will be asked to move before the pull request is merged.

The practical consequence: if your change decides whether a transfer is allowed, how much something
costs, or what a balance becomes, it probably belongs in `drunix-gateway`.

## Two API implementations

`frontend/api/index.js` is the serverless handler production serves. `mock-api-server.js` is an
Express rig used by local payment testing and by several suites. **They implement the same surface
and must be changed together.** A fix applied to one is live in exactly one environment, and this
has caused real defects. If you touch one, check the other.

## Before you open a pull request

```bash
make dev        # the suites need a running stack
make test       # the integration sweep, currently 120 checks across 75 suites
make test-go    # gofmt, go vet and race tests for all four Go modules
make smoke      # every frontend route renders real content, not an error boundary
```

CI runs the same things plus a Solidity and IPFS job and a container build. `gofmt` is a hard gate.

See the command list above for what each target covers, what it needs, and what is
deliberately not covered.

## What a good change looks like

1. **New behaviour ships with a test that fails without it.** Delete your fix, watch the test fail,
   put it back. If it still passes, the test is not testing your change.
2. **Small and focused.** One concern per pull request.
3. **No new money rule outside the Go core.** See above.
4. **Honest labelling.** This project's main asset is that it does not overclaim. If you add an
   integration that is mocked, label it mocked, declare it on `/api/trust`, and say so in the
   README. A simulated surface described as live will be rejected on principle, however good the
   code is.
5. **No secrets, ever.** `make secret-scan` runs in the regression sweep and refuses tracked files
   that look like live credentials. Use `.env`, which is gitignored.
6. **Commit messages in plain language**, describing why rather than listing the diff. Subject under
   about 70 characters.

## Reporting bugs

Open an issue using the bug template. The single most useful thing you can include is the exact
command or click sequence, what you expected, and what actually happened, plus whether you were
running `make dev` or a deployed instance.

## Reporting a security problem

Please do not open a public issue. See [`SECURITY.md`](SECURITY.md).

## Good first issues

Genuine, self-contained starting points in the current codebase:

- **`api-gateway` has no tests at all.** Four Go modules, three of them tested. Adding table-driven
  tests for its handlers is isolated work with no risk to the demo path.
- **No ESLint configuration exists**, so the frontend has no lint gate; `npm run build` is the
  current proxy. Adding a flat config that passes cleanly on the existing code, and a CI step, is a
  contained change.
- **Pagination on list endpoints.** `/api/properties` and the ledger routes return everything. A
  `limit` and `offset` with a sane maximum, matching the existing response shape, would bound them.
- **Frontend bundle budget.** The build prints chunk sizes; a check that fails the build when a
  chunk crosses an agreed ceiling would stop silent growth.
- **A second asset class walkthrough.** Carbon credits already exist end to end
  ([`docs/CARBON.md`](docs/CARBON.md)); the marketplace UI still speaks only about property.

## Code of conduct

By participating you agree to [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## Licence

Contributions are accepted under the repository licence, **Apache License 2.0** (see
[`LICENSE`](LICENSE)).
