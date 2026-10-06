package drunix

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

// A chain longer than the requested window must still show the newest blocks.
// Serving blocks[0:limit] meant the ledger explorer showed only genesis-era
// blocks once the chain grew, so a just-settled purchase never appeared.
func TestChainWindowReturnsNewestByDefault(t *testing.T) {
	s := newTestServerWithChain(t, 120)

	rec := httptest.NewRecorder()
	s.handleChain(rec, httptest.NewRequest(http.MethodGet, "/drunix/chain?limit=10", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var got struct {
		TotalBlocks int `json:"totalBlocks"`
		From        int `json:"from"`
		Returned    int `json:"returned"`
		Blocks      []struct {
			Height int `json:"height"`
		} `json:"blocks"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Returned != 10 {
		t.Fatalf("returned = %d, want 10", got.Returned)
	}
	last := got.Blocks[len(got.Blocks)-1].Height
	if last != got.TotalBlocks-1 {
		t.Errorf("newest block in window = %d, want %d (the tip)", last, got.TotalBlocks-1)
	}
	if got.From != got.TotalBlocks-10 {
		t.Errorf("from = %d, want %d", got.From, got.TotalBlocks-10)
	}
}

// An explicit cursor must still page from the head, for callers walking the chain.
func TestChainExplicitFromStillPagesFromHead(t *testing.T) {
	s := newTestServerWithChain(t, 120)
	rec := httptest.NewRecorder()
	s.handleChain(rec, httptest.NewRequest(http.MethodGet, "/drunix/chain?from=0&limit=5", nil))
	var got struct {
		From   int `json:"from"`
		Blocks []struct {
			Height int `json:"height"`
		} `json:"blocks"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.From != 0 || got.Blocks[0].Height != 0 {
		t.Errorf("from=%d firstHeight=%d, want 0 and 0", got.From, got.Blocks[0].Height)
	}
}

// A chain shorter than the window must return everything, not a negative offset.
func TestChainShorterThanWindow(t *testing.T) {
	s := newTestServerWithChain(t, 3)
	rec := httptest.NewRecorder()
	s.handleChain(rec, httptest.NewRequest(http.MethodGet, "/drunix/chain?limit=50", nil))
	var got struct {
		From     int `json:"from"`
		Returned int `json:"returned"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.From != 0 {
		t.Errorf("from = %d, want 0", got.From)
	}
	if got.Returned < 3 {
		t.Errorf("returned = %d, want at least the 3 appended blocks", got.Returned)
	}
}

func newTestServerWithChain(t *testing.T, n int) *Server {
	t.Helper()
	s := NewServer(NewMockLedger())
	s.Pipeline = NewPipeline(NewStateDB(), NewTransientStore(), NewChain())
	for i := 0; i < n; i++ {
		s.Pipeline.CP.Ledger.Append("TEST_BLOCK", []map[string]interface{}{
			{"n": fmt.Sprintf("%d", i)},
		})
	}
	return s
}
