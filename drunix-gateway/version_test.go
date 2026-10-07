package drunix

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The feature list is only useful if it cannot quietly lie. Every name must
// correspond to a route the binary actually serves, so a capability that is
// removed (or never wired) fails here instead of misleading an operator.
func TestEveryAdvertisedFeatureIsActuallyServed(t *testing.T) {
	probe := map[string]string{
		"dvp":           "/umi/dvp",
		"wallets":       "/umi/wallets",
		"isin":          "/umi/isin",
		"servicing":     "/umi/servicing",
		"baskets":       "/umi/baskets",
		"ownership":     "/umi/ownership/PROP-PROBE",
		"income":        "/umi/income/probe",
		"idempotency":   "/umi/dvp",
		"events":        "/drunix/events",
		"offers":        "/umi/offers",
		"notifications": "/umi/notifications/probe",
		"metrics":       "/metrics",
		"analytics":     "/umi/analytics",
		"documents":     "/umi/documents",
	}
	srv := newTestServerWithUMI(t)
	h := srv.Router()
	for _, f := range railFeatures() {
		path, ok := probe[f]
		if !ok {
			t.Fatalf("feature %q is advertised but has no route to prove it", f)
		}
		// The event stream is a long-lived response: serving it normally
		// would block this test forever. A cancelled context lets the
		// handler run its routing and return at once, which is all the
		// probe needs — it only asks "is this routed", never "what does it
		// return".
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		req := httptest.NewRequest(http.MethodGet, path, nil).WithContext(ctx)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code == http.StatusNotFound {
			t.Errorf("feature %q advertised but %s is not routed (404)", f, path)
		}
	}
}

// An unstamped build must still answer the question rather than report an
// empty string, which reads like a broken endpoint.
func TestBuildIdentityIsNeverBlank(t *testing.T) {
	bi := currentBuild()
	if strings.TrimSpace(bi.Commit) == "" {
		t.Fatal("commit is blank; it should fall back to \"unknown\"")
	}
	if bi.Source == "" {
		t.Fatal("commit source should say where the value came from")
	}
	if len(bi.Features) == 0 {
		t.Fatal("no features advertised")
	}
}

// A 40-character SHA is unreadable in a label and in a log line.
func TestLongShaIsShortened(t *testing.T) {
	got := shortCommit("0e87f4d1c2b3a4958677889900aabbccddeeff00")
	if len(got) != 12 {
		t.Fatalf("want 12 chars, got %d (%q)", len(got), got)
	}
	if short := shortCommit("v1.2"); short != "v1.2" {
		t.Fatalf("short values must pass through, got %q", short)
	}
}

// /health is what a deploy check curls, so the build must be in it.
func TestHealthReportsBuild(t *testing.T) {
	srv := newTestServerWithUMI(t)
	rec := httptest.NewRecorder()
	srv.Router().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/health", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("health returned %d", rec.Code)
	}
	var body struct {
		Build buildInfo `json:"build"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("health is not JSON: %v", err)
	}
	if body.Build.Commit == "" || len(body.Build.Features) == 0 {
		t.Fatalf("health omits build identity: %s", rec.Body.String())
	}
}

// And on /metrics, so a dashboard can alarm on a stale revision.
func TestMetricsExportsBuildInfo(t *testing.T) {
	srv := newTestServerWithUMI(t)
	rec := httptest.NewRecorder()
	srv.Router().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	out := rec.Body.String()
	if !strings.Contains(out, "aasthi_build_info{") {
		t.Fatalf("build info missing from metrics:\n%s", out)
	}
	if !strings.Contains(out, "# TYPE aasthi_build_info gauge") {
		t.Error("build info is untyped")
	}
}

func newTestServerWithUMI(t *testing.T) *Server {
	t.Helper()
	s := NewServer(NewMockLedger())
	chain := NewChain()
	s.Pipeline = NewPipeline(NewStateDB(), NewTransientStore(), chain)
	s.UMI = NewUMIRail(NewMemorySecurities(), chain)
	s.Idem = NewIdemStore()
	// Mirrors cmd/gateway/main.go: the shipped binary always wires the
	// document register, so a probe of the advertised feature list has to
	// test the same wiring the binary uses.
	s.Docs = NewDocumentRegistry(chain, NewMemoryPinStore())
	return s
}
