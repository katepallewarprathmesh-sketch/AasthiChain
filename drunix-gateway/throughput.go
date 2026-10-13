package drunix

// What this rail can actually do, measured rather than claimed.
//
// WHY A SEPARATE LAYER FROM metrics.go
//
// metrics.go measures HTTP: how long a request took end to end, per route.
// That is the right number for an operator watching a service, and the wrong
// number for the question a reviewer asks about a settlement engine, which is
// "how many settlements per second, and what is stopping it going faster".
// HTTP latency buries the answer under JSON encoding, proxy hops and the
// network. This measures the engine.
//
// THE LIMITATION THIS EXISTS TO STATE
//
// Every settlement takes one lock. SettleDvP holds r.mu across the whole
// critical section: check the cash, check the securities, move both, append
// the block. That is a single-writer design and it is deliberate. The
// invariants this rail exists to guarantee (no money created, no token
// created, both legs or neither) are enforced in memory by one writer, which
// is the simplest arrangement in which they cannot be violated. Optimistic
// concurrency or per-asset striping would be faster and would each introduce
// a window where a reader can see one leg without the other.
//
// So the rail is correct first and fast second, and the number below is the
// ceiling that choice buys. Publishing it with the reason attached is the
// point: a settlement system that quotes a throughput figure without saying
// what serialises is not telling you anything.
//
// lockWait is the evidence. If it stays near zero the lock is not the
// constraint and the figure is bounded by the work itself. If it grows with
// load, the single writer is the bottleneck, which is exactly what we expect
// and would rather show than hide.
//
// WHAT WOULD RAISE THE CEILING
//
// Partitioning by asset. Every invariant here is per-asset or per-wallet, so
// a shard per asset would let disjoint assets settle in parallel without
// weakening anything. That is a real design, not hand-waving, but it is not
// built, so it is described as future work and not as a capability.

import (
	"net/http"
	"sort"
	"sync"
	"time"
)

// engineBucketsMs are cumulative latency buckets for the settlement critical
// section. Finer at the low end than the HTTP buckets because an in-memory
// settlement should land in microseconds, and a histogram that starts at 1ms
// would report "everything is fast" and nothing else.
var engineBucketsMs = []float64{0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 25, 100}

type engineStats struct {
	mu sync.Mutex

	settled int64
	failed  int64

	// Full duration of the settlement call.
	totalMs   []float64 // reservoir, capped
	sumMs     float64
	maxMs     float64
	buckets   []int64
	lockSumMs float64
	lockMaxMs float64

	// Peak throughput actually observed, as a rolling one-second count. Not
	// a benchmark: this is whatever real traffic has managed so far, which
	// is a smaller and more honest number than a synthetic loop.
	windowStart time.Time
	windowCount int64
	peakPerSec  int64

	// Concurrency pressure. waiters is the number of callers currently
	// blocked on the settlement lock; maxWaiters is the high-water mark.
	// This is the direct evidence for the single-writer claim.
	waiters    int64
	maxWaiters int64
}

const engineReservoir = 2000

func newEngineStats() *engineStats {
	return &engineStats{buckets: make([]int64, len(engineBucketsMs))}
}

// enterQueue is called before the settlement lock is taken.
func (e *engineStats) enterQueue() {
	if e == nil {
		return
	}
	e.mu.Lock()
	e.waiters++
	if e.waiters > e.maxWaiters {
		e.maxWaiters = e.waiters
	}
	e.mu.Unlock()
}

func (e *engineStats) leaveQueue() {
	if e == nil {
		return
	}
	e.mu.Lock()
	if e.waiters > 0 {
		e.waiters--
	}
	e.mu.Unlock()
}

// observe records one completed settlement attempt.
func (e *engineStats) observe(lockWait, total time.Duration, settled bool) {
	if e == nil {
		return
	}
	lockMs := float64(lockWait.Microseconds()) / 1000
	totalMs := float64(total.Microseconds()) / 1000

	e.mu.Lock()
	defer e.mu.Unlock()

	if settled {
		e.settled++
	} else {
		e.failed++
	}
	e.sumMs += totalMs
	if totalMs > e.maxMs {
		e.maxMs = totalMs
	}
	e.lockSumMs += lockMs
	if lockMs > e.lockMaxMs {
		e.lockMaxMs = lockMs
	}
	for i, b := range engineBucketsMs {
		if totalMs <= b {
			e.buckets[i]++
		}
	}
	// Reservoir for percentiles. Capped so a long-running process cannot
	// grow this without bound; once full the oldest sample is dropped, so
	// the percentiles describe recent behaviour rather than all of history.
	if len(e.totalMs) >= engineReservoir {
		e.totalMs = e.totalMs[1:]
	}
	e.totalMs = append(e.totalMs, totalMs)

	now := time.Now()
	if e.windowStart.IsZero() || now.Sub(e.windowStart) >= time.Second {
		if e.windowCount > e.peakPerSec {
			e.peakPerSec = e.windowCount
		}
		e.windowStart = now
		e.windowCount = 0
	}
	e.windowCount++
	if e.windowCount > e.peakPerSec {
		e.peakPerSec = e.windowCount
	}
}

func percentile(sorted []float64, p float64) float64 {
	if len(sorted) == 0 {
		return 0
	}
	idx := int(p * float64(len(sorted)-1))
	if idx < 0 {
		idx = 0
	}
	if idx >= len(sorted) {
		idx = len(sorted) - 1
	}
	return sorted[idx]
}

// Snapshot returns the measured picture plus the reasons behind it.
func (e *engineStats) Snapshot() map[string]interface{} {
	if e == nil {
		return map[string]interface{}{"measured": false}
	}
	e.mu.Lock()
	settled, failed := e.settled, e.failed
	sum, max0 := e.sumMs, e.maxMs
	lockSum, lockMax := e.lockSumMs, e.lockMaxMs
	peak, maxWaiters := e.peakPerSec, e.maxWaiters
	samples := append([]float64(nil), e.totalMs...)
	e.mu.Unlock()

	total := settled + failed
	out := map[string]interface{}{
		"measured":                         total > 0,
		"settlements":                      total,
		"settled":                          settled,
		"failed":                           failed,
		"peakSettlementsPerSecondObserved": peak,
		"maxConcurrentWaiters":             maxWaiters,
	}
	if total > 0 {
		sort.Float64s(samples)
		out["latencyMs"] = map[string]interface{}{
			"mean": round3(sum / float64(total)),
			"p50":  round3(percentile(samples, 0.50)),
			"p95":  round3(percentile(samples, 0.95)),
			"p99":  round3(percentile(samples, 0.99)),
			"max":  round3(max0),
		}
		out["lockWaitMs"] = map[string]interface{}{
			"mean": round3(lockSum / float64(total)),
			"max":  round3(lockMax),
		}
		// The honest derived figure: if one settlement costs the mean
		// latency and they cannot overlap, this is the ceiling.
		if mean := sum / float64(total); mean > 0 {
			out["serialCeilingPerSecond"] = int64(1000 / mean)
		}
	}

	out["concurrencyModel"] = "single writer"
	out["whySingleWriter"] = "SettleDvP holds one lock across the whole critical section: check cash, check securities, move both, append the block. " +
		"The invariants this rail exists to guarantee (no money created, no token created, both legs or neither) are enforced in memory by one writer, " +
		"which is the simplest arrangement in which they cannot be violated."
	out["cost"] = "Settlements cannot overlap. Throughput is bounded by one settlement at a time, not by CPU count."
	out["howToReadLockWait"] = "Near zero means the lock is not the constraint and the figure is bounded by the work itself. " +
		"Growing with load means the single writer is the bottleneck, which is the expected behaviour of this design."
	out["whatWouldRaiseIt"] = "Partitioning by asset. Every invariant here is per-asset or per-wallet, so a shard per asset would let disjoint assets " +
		"settle in parallel without weakening any guarantee. That is designed, not built, and is not claimed as a capability."
	out["notABenchmark"] = "These are measurements of traffic this process has actually served, not a synthetic loop. " +
		"A number from a tight local loop would be larger and would mean less."
	out["disclaimer"] = UMIDisclaimer
	return out
}

func round3(f float64) float64 {
	return float64(int64(f*1000+0.5)) / 1000
}

func (s *Server) handleUMIThroughput(w http.ResponseWriter, r *http.Request) {
	if s.UMI == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "ERR_UMI_DISABLED"})
		return
	}
	if r.Method != http.MethodGet {
		umiErr(w, http.StatusMethodNotAllowed, "ERR_METHOD", "GET required")
		return
	}
	writeJSON(w, http.StatusOK, s.UMI.engine.Snapshot())
}
