package drunix

import (
	"fmt"
	"sync"
	"testing"
	"time"
)

func benchRail(t testing.TB, credits int64) *UMIRail {
	t.Helper()
	r := NewUMIRail(NewMemorySecurities(), NewChain())
	_, _ = r.SeedPosition("PROP-BENCH", "originator1", credits, credits)
	_, _, _ = r.AssignISIN("PROP-BENCH", "originator1", "")
	_, _, _ = r.FundWallet("investor1", 100000000)
	return r
}

func TestThroughputIsMeasuredNotClaimed(t *testing.T) {
	r := benchRail(t, 10000)
	before := r.engine.Snapshot()
	if before["measured"] != false {
		t.Fatal("with no traffic the rail must not report a throughput figure")
	}

	for i := 0; i < 50; i++ {
		if _, err := r.SettleDvP(DvPRequest{
			AssetID: "PROP-BENCH", Seller: "originator1", Buyer: "investor1",
			Tokens: 1, PricePerTokenINR: 1,
		}); err != nil {
			t.Fatalf("settle %d: %v", i, err)
		}
	}

	snap := r.engine.Snapshot()
	if snap["measured"] != true {
		t.Fatal("after real settlements the figures must be reported")
	}
	if snap["settlements"].(int64) != 50 {
		t.Fatalf("want 50 settlements counted, got %v", snap["settlements"])
	}
	if snap["settled"].(int64) != 50 {
		t.Fatalf("want 50 settled, got %v", snap["settled"])
	}
	lat, ok := snap["latencyMs"].(map[string]interface{})
	if !ok {
		t.Fatal("latency percentiles must be reported")
	}
	for _, k := range []string{"mean", "p50", "p95", "p99", "max"} {
		if _, ok := lat[k]; !ok {
			t.Fatalf("latency is missing %s", k)
		}
	}
	if lat["p99"].(float64) < lat["p50"].(float64) {
		t.Fatalf("p99 (%v) cannot be below p50 (%v)", lat["p99"], lat["p50"])
	}
}

// A refused settlement still costs time, so it must still be counted. A
// latency figure that quietly ignores rejections flatters itself.
func TestFailedSettlementsAreCountedToo(t *testing.T) {
	r := benchRail(t, 10)
	_, err := r.SettleDvP(DvPRequest{
		AssetID: "PROP-BENCH", Seller: "originator1", Buyer: "investor1",
		Tokens: 99999, PricePerTokenINR: 1,
	})
	if err == nil {
		t.Fatal("setup: that settlement should have been refused")
	}
	snap := r.engine.Snapshot()
	if snap["settlements"].(int64) != 1 {
		t.Fatalf("a refused settlement must still be counted, got %v", snap["settlements"])
	}
	if snap["failed"].(int64) != 1 {
		t.Fatalf("want 1 failed, got %v", snap["failed"])
	}
	if snap["settled"].(int64) != 0 {
		t.Fatalf("nothing settled, got %v", snap["settled"])
	}
}

// The claim the panel makes is that settlements serialise. This proves it
// rather than asserting it: fire many settlements concurrently and show that
// callers queued behind the single writer.
func TestSettlementsSeriallyQueueUnderConcurrency(t *testing.T) {
	r := benchRail(t, 100000)

	const workers = 24
	const each = 20
	var wg sync.WaitGroup
	start := make(chan struct{})
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			for i := 0; i < each; i++ {
				_, _ = r.SettleDvP(DvPRequest{
					AssetID: "PROP-BENCH", Seller: "originator1", Buyer: "investor1",
					Tokens: 1, PricePerTokenINR: 1,
				})
			}
		}()
	}
	close(start)
	wg.Wait()

	snap := r.engine.Snapshot()
	if got := snap["settlements"].(int64); got != workers*each {
		t.Fatalf("every attempt must be counted exactly once, want %d got %d", workers*each, got)
	}
	// With 24 goroutines hammering one lock, at least one must have had to
	// wait. If this is ever 0 the instrumentation is not wired up, because
	// the design guarantees contention under this load.
	if snap["maxConcurrentWaiters"].(int64) < 1 {
		t.Fatal("concurrent settlements must queue on the single writer; no waiters were ever observed")
	}
	// And the ledger must still be exactly right, which is what the single
	// writer is bought with.
	authorised, outstanding := r.AuthorisedSupply("PROP-BENCH")
	if outstanding != authorised {
		t.Fatalf("tokens were created or destroyed under concurrency: %d outstanding of %d authorised",
			outstanding, authorised)
	}
	if got := r.securities.Position("PROP-BENCH", "investor1"); got != workers*each {
		t.Fatalf("buyer should hold exactly %d tokens, holds %d", workers*each, got)
	}
}

// The limitation has to be stated wherever the number is, or the number is
// misleading on its own.
func TestThroughputReportStatesItsOwnLimit(t *testing.T) {
	r := benchRail(t, 10)
	snap := r.engine.Snapshot()
	if snap["concurrencyModel"] != "single writer" {
		t.Fatalf("the report must name its concurrency model, got %v", snap["concurrencyModel"])
	}
	for _, k := range []string{"whySingleWriter", "cost", "howToReadLockWait", "whatWouldRaiseIt", "notABenchmark"} {
		v, ok := snap[k].(string)
		if !ok || v == "" {
			t.Fatalf("the report must explain %q alongside the figure", k)
		}
	}
}

// A real number to quote, produced by the machine running it rather than by
// a slide. Run with: go test -bench BenchmarkSettleDvP -run x
func BenchmarkSettleDvP(b *testing.B) {
	r := benchRail(b, int64(b.N)+10)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, _ = r.SettleDvP(DvPRequest{
			AssetID: "PROP-BENCH", Seller: "originator1", Buyer: "investor1",
			Tokens: 1, PricePerTokenINR: 1,
		})
	}
	b.StopTimer()
	snap := r.engine.Snapshot()
	if lat, ok := snap["latencyMs"].(map[string]interface{}); ok {
		b.ReportMetric(lat["p50"].(float64), "p50-ms")
		b.ReportMetric(lat["p99"].(float64), "p99-ms")
	}
}

// Contention is the interesting case, since the whole point is that these
// cannot overlap.
func BenchmarkSettleDvPContended(b *testing.B) {
	r := benchRail(b, int64(b.N)*2+1000)
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			_, _ = r.SettleDvP(DvPRequest{
				AssetID: "PROP-BENCH", Seller: "originator1", Buyer: "investor1",
				Tokens: 1, PricePerTokenINR: 1,
			})
		}
	})
	b.StopTimer()
	snap := r.engine.Snapshot()
	if lw, ok := snap["lockWaitMs"].(map[string]interface{}); ok {
		b.ReportMetric(lw["mean"].(float64), "lockwait-ms")
	}
	b.ReportMetric(float64(snap["maxConcurrentWaiters"].(int64)), "max-waiters")
}

var _ = fmt.Sprintf
var _ = time.Now
