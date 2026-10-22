package drunix

// The per-path speed report must behave the same way the engine report does:
// measure, never claim, and say nothing at all when there is no traffic.
//
// The benchmarks at the bottom are the synthetic companion to the measured
// figures. They are what gets published as "per-path cost" in
// docs/THROUGHPUT.md, and they are labelled synthetic there because a tight
// local loop is not a service under load.

import (
	"fmt"
	"testing"
	"time"
)

func speedLedger(t testing.TB) (*CBDCLedger, *CorridorDesk) {
	chain := NewChain()
	rail := NewUMIRail(NewMemorySecurities(), chain)
	l := NewCBDCLedger(rail, chain)
	if l == nil {
		t.Fatal("cbdc ledger did not wire")
	}
	d := NewCorridorDesk(rail, chain, l)
	if d == nil {
		t.Fatal("corridor desk did not wire")
	}
	return l, d
}

func TestPathSpeedReportsNothingWithoutTraffic(t *testing.T) {
	l, _ := speedLedger(t)
	snap := l.rail.speed.Snapshot()
	if snap["measured"] != false {
		t.Fatal("with no traffic the rail must not report per-path figures")
	}
	paths, _ := snap["paths"].(map[string]interface{})
	if len(paths) != 0 {
		t.Fatalf("no path should be reported before it is used, got %v", paths)
	}
	if snap["note"] == nil {
		t.Fatal("an empty report must say why it is empty rather than look like a zero result")
	}
}

func TestPathSpeedMeasuresTheCBDCPaths(t *testing.T) {
	l, _ := speedLedger(t)

	for i := 0; i < 20; i++ {
		if _, _, err := l.Issue("investor1", CBDCWholesale, KYCFull, 100000, false, "regulator1"); err != nil {
			t.Fatalf("issue %d: %v", i, err)
		}
	}
	// Five, not twenty: the AML velocity rule blocks a payer after eight
	// payments in ten minutes, and tripping it here would be measuring the
	// rule rather than the path.
	for i := 0; i < 5; i++ {
		if _, err := l.Transfer("investor1", "investor2", 1000); err != nil {
			t.Fatalf("transfer %d: %v", i, err)
		}
	}

	snap := l.rail.speed.Snapshot()
	if snap["measured"] != true {
		t.Fatal("after real movements the figures must be reported")
	}
	paths := snap["paths"].(map[string]interface{})

	for name, want := range map[string]int64{"cbdc.issue": 20, "cbdc.transfer": 5} {
		entry, ok := paths[name].(map[string]interface{})
		if !ok {
			t.Fatalf("%s was exercised but is not reported", name)
		}
		if entry["calls"].(int64) != want {
			t.Fatalf("%s: want %d calls, got %v", name, want, entry["calls"])
		}
		if entry["completed"].(int64) != want {
			t.Fatalf("%s: want %d completed, got %v", name, want, entry["completed"])
		}
		if entry["work"] == nil {
			t.Fatalf("%s: a latency figure without the work behind it is not comparable to anything", name)
		}
		lat := entry["latencyMs"].(map[string]interface{})
		if lat["p99"].(float64) < lat["p50"].(float64) {
			t.Fatalf("%s: p99 cannot be below p50", name)
		}
		if lat["max"].(float64) < lat["p99"].(float64) {
			t.Fatalf("%s: max cannot be below p99", name)
		}
	}

	// A path never called must stay absent, not appear as a zero.
	if _, present := paths["cbdc.offlineRedeem"]; present {
		t.Fatal("a path with no traffic must not be reported at all")
	}
}

// A refusal returns before the work it refused, so it must be counted and
// timed separately. Folding refusals into the mean would flatter it.
func TestPathSpeedCountsRefusalsApart(t *testing.T) {
	l, _ := speedLedger(t)
	mustIssue(t, l, "investor1", CBDCWholesale, KYCFull, 500000)

	if _, err := l.Transfer("investor1", "investor2", 1000); err != nil {
		t.Fatalf("the good transfer must succeed: %v", err)
	}
	// Far more than the balance: refused before anything moves.
	for i := 0; i < 3; i++ {
		if _, err := l.Transfer("investor1", "investor2", 99900000000); err == nil {
			t.Fatal("a transfer beyond the balance must be refused")
		}
	}

	entry := l.rail.speed.Snapshot()["paths"].(map[string]interface{})["cbdc.transfer"].(map[string]interface{})
	if entry["calls"].(int64) != 4 {
		t.Fatalf("want 4 calls counted, got %v", entry["calls"])
	}
	if entry["completed"].(int64) != 1 {
		t.Fatalf("want 1 completed, got %v", entry["completed"])
	}
	if entry["refused"].(int64) != 3 {
		t.Fatalf("want 3 refused, got %v", entry["refused"])
	}
}

func TestPathSpeedMeasuresTheCorridorPath(t *testing.T) {
	l, d := speedLedger(t)
	mustIssue(t, l, "investor1", CBDCWholesale, KYCFull, 500000)

	now := time.Now()
	for _, c := range d.Corridors() {
		if _, err := d.Check(c.ID, 100000, "FAMILY_MAINTENANCE", "investor1", now); err != nil {
			continue
		}
	}

	paths := l.rail.speed.Snapshot()["paths"].(map[string]interface{})
	entry, ok := paths["corridor.check"].(map[string]interface{})
	if !ok {
		t.Fatal("the corridor check path was exercised but is not reported")
	}
	if entry["calls"].(int64) == 0 {
		t.Fatal("corridor checks must be counted")
	}
	if entry["work"] == nil {
		t.Fatal("the corridor path must describe the work it does")
	}
}

// The report must carry its own caveats: the scope, the refusal rule and the
// fact that it is not a benchmark. A bare number here would be misread.
func TestPathSpeedPublishesItsOwnCaveats(t *testing.T) {
	l, _ := speedLedger(t)
	mustIssue(t, l, "investor1", CBDCWholesale, KYCFull, 100000)
	snap := l.rail.speed.Snapshot()
	for _, k := range []string{"scope", "refusalsCountedApart", "notABenchmark", "caveat", "disclaimer"} {
		if s, _ := snap[k].(string); s == "" {
			t.Fatalf("the report must state %q", k)
		}
	}
}

// Measuring a path must not serialise it: the book takes its own lock, held
// only while recording. If this deadlocks or races, -race will say so.
func TestPathSpeedIsSafeUnderConcurrency(t *testing.T) {
	l, _ := speedLedger(t)
	mustIssue(t, l, "investor1", CBDCWholesale, KYCFull, 10000000)

	done := make(chan struct{})
	go func() {
		for i := 0; i < 200; i++ {
			_ = l.rail.speed.Snapshot()
		}
		close(done)
	}()
	for i := 0; i < 200; i++ {
		_, _ = l.Transfer("investor1", "investor2", 10)
	}
	<-done
}

/* ------------------------------------------------------------ benchmarks */

// The AML velocity rule blocks a payer after eight payments in ten minutes,
// which is correct behaviour and would otherwise turn this into a benchmark
// of the refusal path. Payers are rotated so every call does the real work.
func BenchmarkCBDCTransfer(b *testing.B) {
	l, _ := speedLedger(b)
	const perPayer = 5
	payers := make([]string, 0, b.N/perPayer+1)
	for i := 0; i <= b.N/perPayer; i++ {
		p := fmt.Sprintf("payer%d", i)
		if _, _, err := l.Issue(p, CBDCWholesale, KYCFull, int64(perPayer)*10+100, false, "regulator1"); err != nil {
			b.Fatal(err)
		}
		payers = append(payers, p)
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := l.Transfer(payers[i/perPayer], "investor2", 1); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkCBDCIssue(b *testing.B) {
	l, _ := speedLedger(b)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, _, err := l.Issue("investor1", CBDCWholesale, KYCFull, 1, false, "regulator1"); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkCorridorCheck(b *testing.B) {
	l, d := speedLedger(b)
	if _, _, err := l.Issue("investor1", CBDCWholesale, KYCFull, 100000000, false, "regulator1"); err != nil {
		b.Fatal(err)
	}
	cs := d.Corridors()
	if len(cs) == 0 {
		b.Skip("no corridors configured")
	}
	id := cs[0].ID
	now := time.Now()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, _ = d.Check(id, 10000, "FAMILY_MAINTENANCE", "investor1", now)
	}
}
