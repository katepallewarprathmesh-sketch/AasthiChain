package drunix

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

// A list endpoint without a ceiling is not a list endpoint. ?limit=1000000
// used to walk and copy the whole collection into one response.
func TestQueryLimitKeepsItsCeiling(t *testing.T) {
	cases := []struct {
		query string
		def   int
		max   int
		want  int
	}{
		{"", 50, 500, 50},
		{"?limit=10", 50, 500, 10},
		{"?limit=500", 50, 500, 500},
		{"?limit=1000000", 50, 500, 500},
		{"?limit=-5", 50, 500, 50},
		{"?limit=0", 50, 500, 50},
		{"?limit=banana", 50, 500, 50},
	}
	for _, c := range cases {
		r := httptest.NewRequest(http.MethodGet, "/umi/instructions"+c.query, nil)
		if got := queryLimit(r, c.def, c.max); got != c.want {
			t.Errorf("%q: got %d, want %d", c.query, got, c.want)
		}
	}
}

// And the rail must honour it rather than quietly returning everything.
func TestInstructionListIsBounded(t *testing.T) {
	chain := NewChain()
	rail := NewUMIRail(NewMemorySecurities(), chain)
	const asset = "PROP-BOUND"
	if _, err := rail.SeedPosition(asset, "originator1", 10000, 10000); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if _, _, err := rail.FundWallet("investor1", 1000000); err != nil {
		t.Fatalf("fund: %v", err)
	}
	for i := 0; i < 40; i++ {
		if _, err := rail.SettleDvP(DvPRequest{
			AssetID: asset, Seller: "originator1", Buyer: "investor1",
			Tokens: 1, PricePerTokenINR: 10, AutoAssignISIN: true,
		}); err != nil {
			t.Fatalf("settle %d: %v", i, err)
		}
	}
	if n := len(rail.Instructions(5)); n != 5 {
		t.Errorf("asked for 5, got %d", n)
	}
	if n := len(rail.Instructions(0)); n != 40 {
		t.Errorf("an unlimited read should still see everything, got %d", n)
	}
	// Filtering under the rail's own lock must agree with filtering outside it.
	if n := len(rail.SettledForAsset(asset)); n != 40 {
		t.Errorf("SettledForAsset saw %d of 40", n)
	}
	if n := len(rail.SettledForAsset("PROP-SOMETHING-ELSE")); n != 0 {
		t.Errorf("SettledForAsset leaked another asset's rows: %d", n)
	}
}

func listBenchRail(b *testing.B, trades int) (*UMIRail, string) {
	b.Helper()
	chain := NewChain()
	rail := NewUMIRail(NewMemorySecurities(), chain)
	const asset = "PROP-BENCH"
	if _, err := rail.SeedPosition(asset, "originator1", int64(trades)*2, int64(trades)*2); err != nil {
		b.Fatalf("seed: %v", err)
	}
	if _, _, err := rail.FundWallet("investor1", float64(trades)*100); err != nil {
		b.Fatalf("fund: %v", err)
	}
	for i := 0; i < trades; i++ {
		if _, err := rail.SettleDvP(DvPRequest{
			AssetID: asset, Seller: "originator1", Buyer: "investor1",
			Tokens: 1, PricePerTokenINR: 10, AutoAssignISIN: true,
		}); err != nil {
			b.Fatalf("settle: %v", err)
		}
	}
	return rail, asset
}

// The read path on a rail that has been up for a while. The page size is
// what a client actually asks for; the book behind it is not.
func BenchmarkInstructionsPage(b *testing.B) {
	for _, trades := range []int{100, 2000} {
		rail, _ := listBenchRail(b, trades)
		b.Run(fmt.Sprintf("book=%d/page=50", trades), func(b *testing.B) {
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				_ = rail.Instructions(50)
			}
		})
	}
}

// The realistic shape: many assets on the rail, a question about one of
// them. This is what the attestation view asks on every page load.
func BenchmarkSettledForAssetAmongMany(b *testing.B) {
	chain := NewChain()
	rail := NewUMIRail(NewMemorySecurities(), chain)
	if _, _, err := rail.FundWallet("investor1", 1000000); err != nil {
		b.Fatalf("fund: %v", err)
	}
	var target string
	for a := 0; a < 40; a++ {
		asset := fmt.Sprintf("PROP-MANY-%d", a)
		if a == 7 {
			target = asset
		}
		if _, err := rail.SeedPosition(asset, "originator1", 200, 200); err != nil {
			b.Fatalf("seed: %v", err)
		}
		for i := 0; i < 50; i++ {
			if _, err := rail.SettleDvP(DvPRequest{
				AssetID: asset, Seller: "originator1", Buyer: "investor1",
				Tokens: 1, PricePerTokenINR: 10, AutoAssignISIN: true,
			}); err != nil {
				b.Fatalf("settle: %v", err)
			}
		}
	}
	b.Run("filtered", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			_ = rail.SettledForAsset(target)
		}
	})
	b.Run("copy-everything-then-filter", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			for _, si := range rail.Instructions(0) {
				if si.AssetID != target {
					continue
				}
			}
		}
	})
}

// Asking "what settled against this asset" used to copy the whole book.
func BenchmarkSettledForAsset(b *testing.B) {
	rail, asset := listBenchRail(b, 2000)
	b.Run("filtered", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			_ = rail.SettledForAsset(asset)
		}
	})
	b.Run("copy-everything-then-filter", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			for _, si := range rail.Instructions(0) {
				if si.AssetID != asset {
					continue
				}
			}
		}
	})
}
