# Throughput, and the thing that limits it

A settlement system that quotes a throughput figure without saying what
serialises is not telling you anything. So this document gives the number, the
constraint behind it, and the things the number is not.

## The constraint

Every settlement takes one lock. `SettleDvP` holds `r.mu` across the whole
critical section: check the cash, check the securities, move both legs, append
the block. Settlements cannot overlap.

That is deliberate. The invariants this rail exists to guarantee are:

- no central bank money is created or destroyed,
- no token is created or destroyed,
- both legs settle or neither does.

A single writer is the simplest arrangement in which those cannot be violated.
Optimistic concurrency, or striping the lock per wallet, would both be faster
and would each open a window in which a reader can observe one leg without the
other. The rail is correct first and fast second, and the figures below are the
ceiling that choice buys.

## Measured

Two sources, both real, measuring different things.

### The engine, from the Go benchmark

Run it yourself:

    cd drunix-gateway && go test -bench BenchmarkSettleDvP -run XXX -benchtime 3000x

On the 2 vCPU container used during development:

| Benchmark | ns/op | Derived | p50 | p99 |
|---|---|---|---|---|
| `BenchmarkSettleDvP` | 37,911 | about 26,000 settlements/sec | 0.027 ms | 0.131 ms |
| `BenchmarkSettleDvPContended` | 40,418 | about 24,700 settlements/sec | mean lock wait under 1 us | max 2 queued |

The contended run barely differs from the serial one, for an unexciting reason
worth stating rather than hiding: the box has 2 vCPUs, so at most two
goroutines were ever really running. This is not evidence that the lock scales.
It is evidence that we did not have enough parallelism available to prove
anything either way.

### The live endpoint

`GET /umi/throughput` reports what this process has actually served. After 25
settlements over HTTP on the same container:

    settlements 25, settled 25, failed 0
    latency ms  p50 0.17, p95 0.243, p99 0.252, max 0.297
    lockWait ms mean 0, max 0
    serial ceiling 5,711/sec at that mean latency

Lock wait is zero because the requests arrived one at a time, so nothing ever
queued. That is the honest reading: under this load the lock is not the
constraint, and the figure is bounded by the work itself.

Note the two numbers disagree: about 26,000/sec from the benchmark against
about 5,700/sec live. The difference is the rest of the handler, the JSON, and
a container under other load. The lower number is the more useful one, and
neither is a production figure.

## The other money paths

The figures above describe DvP settlement and nothing else. A CBDC transfer,
a programmable-money spend and a corridor send do different work, take
different locks and cost different amounts, so quoting the DvP number for
them would be quoting a measurement of something else. That gap was listed as
an open item and this closes it.

`GET /umi/pathspeed` reports the same shape per path: calls, completed,
refused, latency percentiles, lock wait, and a line saying what work the path
actually does. Refusals are counted and timed apart from completions, because
a refusal returns before the work it refused and folding the two together
would flatter the average. A path with no traffic is omitted rather than
reported as zero.

The synthetic companion, on the same 2 vCPU container, median of three runs at
`-benchtime 3000x`:

| Benchmark | ns/op | Derived | What it does |
|---|---|---|---|
| `BenchmarkCorridorCheck` | 377 | about 2,650,000/sec | Licences, caps, Travel Rule and monthly usage. Moves nothing. |
| `BenchmarkCBDCIssue` | 20,866 | about 47,900/sec | Cap check, balance, supply counter, one block. |
| `BenchmarkSettleDvP` | 33,024 | about 30,200/sec | Both legs plus the block, under one lock. |
| `BenchmarkCBDCTransfer` | 46,238 | about 21,600/sec | AML screen, caps, both balances, one block. |

Two things in that table are worth reading rather than skimming.

A CBDC transfer costs more than a DvP settlement. That looks wrong until you
look at the work: the transfer runs an AML screen, and the screen is the
expensive part, not the money movement. Screening is not optional and the cost
belongs in the figure.

A corridor check is roughly a hundred times cheaper than anything that moves
money, because it deliberately moves nothing. It is the pricing and
eligibility pass. Quoting it as "corridor speed" would be the dishonest
version of this table.

The transfer benchmark rotates payers. The AML velocity rule blocks a payer
after eight payments in ten minutes, which is correct behaviour, and a
benchmark that tripped it would be timing the refusal path while claiming to
time the transfer path.

Run them:

    cd drunix-gateway && go test -run XXX -bench "BenchmarkCBDC|BenchmarkCorridor" -benchtime 3000x -count=3

## What these numbers are not

- **Not end to end.** They measure the settlement engine. They exclude the HTTP
  layer, the JSON, the proxy hop through the web app, and the network. A real
  client's experience is dominated by those.
- **Not with a database.** The measurements above ran with no `DATABASE_URL`.
  With the Postgres mirror attached, every settlement also does a write, and
  that write will dominate. Expect a figure lower by an order of magnitude or
  more.
- **Not a competitor to a published chain benchmark.** Numbers produced by a
  harness against a configured network, on known hardware, are a different
  measurement from an in-process loop. An in-process loop will always look
  better and always mean less.
- **Not a capacity plan.** One container, one process, no replication.

## What would raise the ceiling

Partitioning by asset.

Every invariant here is per-asset or per-wallet. There is no rule that spans
two unrelated properties, so two settlements touching disjoint assets have no
reason to serialise against each other. A shard per asset, with the cash leg
partitioned by wallet, would let them proceed in parallel without weakening any
guarantee. Cross-asset operations (baskets) would take the shards in a fixed
order to avoid deadlock.

That is a design, not an implementation. It is not built, it is not claimed as
a capability, and the panel in the UI says so.

## Where to look

- `drunix-gateway/throughput.go`: the DvP instrumentation and report.
- `drunix-gateway/pathspeed.go`: the per-path instrumentation and report.
- `drunix-gateway/pathspeed_test.go`: the per-path tests and benchmarks.
- `GET /umi/pathspeed`: the live per-path figures.
- `drunix-gateway/throughput_test.go`: the tests and both benchmarks.
- `GET /umi/throughput`: the live figures.
- Card 10 on `/umi`: the engine figures with the caveats attached.
- Card 11 on `/umi`: the per-path table, one row per money path, completions
  and refusals in separate columns, and what each path does behind a tap. A
  path nobody has exercised is absent rather than zero.
