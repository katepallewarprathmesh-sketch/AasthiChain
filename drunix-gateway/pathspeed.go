package drunix

// Per-path speed, measured rather than claimed.
//
// WHY THIS EXISTS SEPARATELY FROM throughput.go
//
// throughput.go measures one thing very well: the DvP settlement critical
// section. That is the engine, and it is the number a reviewer asks for
// first. But it is not the number anybody actually experiences on the other
// paths this rail has grown since: a CBDC transfer, a programmable-money
// spend against a condition, a corridor send that runs an AML screen and
// opens an HTLC. Those do different amounts of work, take different locks,
// and quoting the DvP figure for them would be quoting a measurement of
// something else.
//
// So the published position was honest but incomplete: "the settlement
// engine is measured; the CBDC and corridor paths are not". This closes
// that. Each named path is timed where the work actually happens, inside
// the Go layer, below HTTP.
//
// WHAT IS MEASURED
//
//   wait   time spent blocked acquiring the path's lock
//   total  entry to return, including the wait
//
// Both are recorded for successes and for refusals, and the two are counted
// separately. A refusal is usually much faster than the work it refused (a
// blocked corridor returns before anything moves), so folding them together
// would flatter the average. They are reported side by side instead.
//
// WHAT IT IS NOT
//
// Not a benchmark. These are the requests this process has really served.
// With no traffic a path reports measured:false and no figures at all,
// rather than a zero that reads like a result. The Go benchmarks in
// pathspeed_test.go are the synthetic companion, and they are labelled as
// such wherever their numbers are published.

import (
	"net/http"
	"sort"
	"sync"
	"time"
)

// pathReservoir caps the per-path sample list. Percentiles then describe
// recent behaviour instead of all history, and a long-lived process cannot
// grow this without bound.
const pathReservoir = 1000

// pathSample is the accumulated picture of one named path.
type pathSample struct {
	ok      int64
	refused int64

	sumMs   float64
	maxMs   float64
	samples []float64

	waitSumMs float64
	waitMaxMs float64
}

// speedBook holds every named path. One lock for the book itself, held only
// while recording, so measuring a path can never serialise the path.
type speedBook struct {
	mu    sync.Mutex
	paths map[string]*pathSample
}

func newSpeedBook() *speedBook {
	return &speedBook{paths: map[string]*pathSample{}}
}

// pathTimer is one in-flight measurement. The zero value is inert, so a call
// on a rail with no book attached costs nothing and records nothing.
type pathTimer struct {
	book    *speedBook
	name    string
	started time.Time
	waited  time.Duration
}

// begin starts timing. Call it as the first statement of the path, before
// any lock is taken, or the wait it reports will not include the wait.
func (b *speedBook) begin(name string) *pathTimer {
	if b == nil {
		return &pathTimer{}
	}
	return &pathTimer{book: b, name: name, started: time.Now()}
}

// locked marks the moment the path's lock was acquired. Everything before it
// is lock wait. Optional: a path with no lock simply never calls it.
func (t *pathTimer) locked() {
	if t == nil || t.book == nil || t.waited != 0 {
		return
	}
	t.waited = time.Since(t.started)
}

// done records the completed attempt. `ok` false means the path refused:
// counted, timed, kept apart from the successes.
func (t *pathTimer) done(ok bool) {
	if t == nil || t.book == nil {
		return
	}
	total := time.Since(t.started)
	b := t.book
	b.mu.Lock()
	defer b.mu.Unlock()
	p := b.paths[t.name]
	if p == nil {
		p = &pathSample{}
		b.paths[t.name] = p
	}
	if ok {
		p.ok++
	} else {
		p.refused++
	}
	ms := float64(total.Microseconds()) / 1000
	p.sumMs += ms
	if ms > p.maxMs {
		p.maxMs = ms
	}
	if len(p.samples) >= pathReservoir {
		p.samples = p.samples[1:]
	}
	p.samples = append(p.samples, ms)

	waitMs := float64(t.waited.Microseconds()) / 1000
	p.waitSumMs += waitMs
	if waitMs > p.waitMaxMs {
		p.waitMaxMs = waitMs
	}
}

// pathDescriptions say what each path actually does, because a latency
// figure without the work behind it is not comparable to anything.
var pathDescriptions = map[string]string{
	"cbdc.issue":         "Create central bank money into a wallet: KYC cap check, balance, supply counter, one block.",
	"cbdc.redeem":        "Destroy money back to the issuer: availability check, balance, supply counter, one block.",
	"cbdc.transfer":      "Wallet to wallet: AML screen, cap and availability checks, both balances, one block.",
	"cbdc.grant":         "Open a programmable grant: lock the sponsor's money against a condition, one block.",
	"cbdc.spend":         "Spend against a grant: evaluate the purpose, merchant and expiry conditions, move money, one block.",
	"cbdc.offlineIssue":  "Mint an offline voucher: reserve the balance, sign the voucher, one block.",
	"cbdc.offlineRedeem": "Redeem an offline voucher: signature check, double-spend index, move money, one block.",
	"cbdc.openCondition": "Open a conditional payment: lock the payer's money against a named future event.",
	"cbdc.submitEvent":   "Attest an event: match every waiting condition, release each one, a block per release.",
	"corridor.check":     "Price and test a corridor without moving anything: licences, limits, Travel Rule, monthly usage.",
	"corridor.send":      "Send over a corridor: AML screen both parties, the corridor checks, then the settlement model (atomic, HTLC lock, deferred leg or scheme window).",
	"corridor.claim":     "Claim an HTLC leg: sha256 preimage check against the hash lock, then release.",
	"corridor.confirm":   "Confirm a deferred or scheme leg: attestor check, then release or expire.",
	"interop.convert":    "Convert between instruments: matrix lookup, suspense account, both legs in one operation.",
}

// snapshotPaths renders the book. Paths with no traffic are omitted rather
// than reported as zero.
func (b *speedBook) snapshotPaths() map[string]interface{} {
	out := map[string]interface{}{}
	if b == nil {
		return out
	}
	b.mu.Lock()
	names := make([]string, 0, len(b.paths))
	for n := range b.paths {
		names = append(names, n)
	}
	sort.Strings(names)
	type copySample struct {
		name string
		s    pathSample
	}
	copies := make([]copySample, 0, len(names))
	for _, n := range names {
		p := b.paths[n]
		c := *p
		c.samples = append([]float64(nil), p.samples...)
		copies = append(copies, copySample{n, c})
	}
	b.mu.Unlock()

	for _, c := range copies {
		total := c.s.ok + c.s.refused
		if total == 0 {
			continue
		}
		sort.Float64s(c.s.samples)
		entry := map[string]interface{}{
			"calls":     total,
			"completed": c.s.ok,
			"refused":   c.s.refused,
			"latencyMs": map[string]interface{}{
				"mean": round3(c.s.sumMs / float64(total)),
				"p50":  round3(percentile(c.s.samples, 0.50)),
				"p95":  round3(percentile(c.s.samples, 0.95)),
				"p99":  round3(percentile(c.s.samples, 0.99)),
				"max":  round3(c.s.maxMs),
			},
			"lockWaitMs": map[string]interface{}{
				"mean": round3(c.s.waitSumMs / float64(total)),
				"max":  round3(c.s.waitMaxMs),
			},
		}
		if mean := c.s.sumMs / float64(total); mean > 0 {
			entry["serialCeilingPerSecond"] = int64(1000 / mean)
		}
		if d := pathDescriptions[c.name]; d != "" {
			entry["work"] = d
		}
		out[c.name] = entry
	}
	return out
}

// Snapshot is the published report for every path other than DvP.
func (b *speedBook) Snapshot() map[string]interface{} {
	paths := b.snapshotPaths()
	out := map[string]interface{}{
		"measured": len(paths) > 0,
		"paths":    paths,
	}
	if len(paths) == 0 {
		out["note"] = "No traffic on these paths in this process yet. Nothing is reported rather than reporting zero, " +
			"because a zero here would read as a result and it is an absence."
	}
	out["scope"] = "Measured inside the Go layer, from entry to return, below HTTP. The DvP settlement engine is measured " +
		"separately at /umi/throughput: it is one lock around one critical section, and these paths are not."
	out["refusalsCountedApart"] = "A refusal returns before the work it refused, so folding refusals into the average would " +
		"flatter it. Completed and refused calls are counted and timed, and reported side by side."
	out["notABenchmark"] = "These are requests this process actually served, not a synthetic loop. The Go benchmarks in " +
		"pathspeed_test.go are the synthetic companion and are labelled as such wherever published."
	out["caveat"] = "Measured on a two-core sandbox container. Absolute numbers are not a claim about production hardware; " +
		"the relative cost between paths is the useful part."
	out["disclaimer"] = UMIDisclaimer
	return out
}

func (s *Server) handleUMIPathSpeed(w http.ResponseWriter, r *http.Request) {
	if s.UMI == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "ERR_UMI_DISABLED"})
		return
	}
	if r.Method != http.MethodGet {
		umiErr(w, http.StatusMethodNotAllowed, "ERR_METHOD", "GET required")
		return
	}
	writeJSON(w, http.StatusOK, s.UMI.speed.Snapshot())
}
