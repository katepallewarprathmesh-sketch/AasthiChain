# Performance

Every number on this page was measured on this repository with the command
printed next to it. Nothing here is projected, extrapolated or rounded in the
project's favour, and a result that went the wrong way is reported as such.

Measurements come from a shared cloud machine (2 vCPU). Absolute figures will
differ on other hardware; the comparisons between two versions of the same
code were taken in the same session on the same machine, which is the part
that carries meaning.

## Read paths

```bash
cd drunix-gateway
go test -run XXX -bench 'InstructionsPage|SettledForAsset|AmongMany' -benchtime=100x .
```

**Bounded page reads.** A request for the latest 50 settlements used to
allocate room for the entire book before filling it, so the cost of one page
grew with the age of the deployment. Sizing the copy by the page instead:

| Book size | Page | Time | Allocated |
| --- | --- | --- | --- |
| 100 instructions | 50 | 13.7 us | 18 KB |
| 2,000 instructions | 50 | 7.7 us | 18 KB |

The allocation is now the same for both, which is the point: a page costs
what a page costs.

**Asking about one asset.** The attestation view asks what settled against a
single asset. It used to take the whole instruction book, including every
ISO 20022 message trace, and discard almost all of it. With 40 assets and
2,000 settlements on the rail, filtering inside the rail instead:

| Approach | Time | Allocated |
| --- | --- | --- |
| Filter under the rail's lock | 88 us | 18 KB |
| Copy everything, then filter | 797 us | 705 KB |

That is about nine times faster and thirty-eight times less memory per call.

**Where it does not help.** When nearly every row matches, for example a rail
carrying one asset and 2,000 trades against it, the filtered path is slightly
slower than copying the book, because it walks the index twice to size the
result exactly: 882 us against 643 us, with the same allocation. The
realistic shape for this call is many assets and a question about one, so the
trade is worth taking, but it is a trade and not a free win.

## Bounds on every list route

A list endpoint without a ceiling is a way to make the server allocate. Every
route that reads `?limit=` now goes through one helper with a default and a
maximum, and a test pins the behaviour, including that a nonsense value falls
back to the default rather than to everything.

| Route | Default | Ceiling |
| --- | --- | --- |
| settlement instructions | 50 | 500 |
| servicing history | 100 | 500 |
| ledger blocks | 50 | 500 |
| credentials | 50 | 200 |
| mandates | 50 | 200 |
| interop transfers | 50 | 200 |
| notifications | 50 | 200 |

## Front end

```bash
cd frontend && npm run build
```

The settlement page loads five panels that sit below the forms people
actually came for. Splitting them out of the page chunk:

| Chunk | Before | After |
| --- | --- | --- |
| settlement page | 69.4 KB | 35.9 KB |

The panels now arrive as five separate chunks between 3 KB and 11 KB, fetched
when the page renders them. Total bytes for someone who scrolls the whole
page are slightly higher; bytes before first paint are roughly halved.

## Settlement throughput

The throughput figure shown in the application is measured by a Go benchmark
and labelled as a benchmark rather than as a live rate, because it is one.
The application states both the measured figure and the much lower ceiling
observed through the full HTTP path, and marks the live number as not
measured. That labelling is deliberate and should not be quietly improved.

## What has not been optimised

- The serverless API handler is one large file. It is a cold-start cost and a
  maintenance cost, and splitting it is not yet done.
- The rail keeps its working set in memory and replays it from the ledger on
  boot. There is no eviction, so a very long-lived deployment grows. For the
  demo's lifetime this is fine; for a real one it is not.
- No load test exists. Throughput under concurrency is unmeasured, and this
  page does not claim a figure for it.
