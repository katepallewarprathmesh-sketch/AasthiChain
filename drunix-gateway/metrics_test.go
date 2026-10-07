package drunix

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// The failure mode that matters for a metrics endpoint is cardinality: one
// unbounded label value turns a handful of series into millions. Every
// dynamic path segment must collapse onto a fixed template.
func TestRouteTemplatesHaveNoIdentifiers(t *testing.T) {
	cases := map[string]string{
		"/umi/notifications/investor1":          "/umi/notifications/{id}",
		"/umi/notifications/investor1/read":     "/umi/notifications/{id}/read",
		"/umi/notifications/investor1/read-all": "/umi/notifications/{id}/read-all",
		"/umi/offers/OFR-00001":                 "/umi/offers/{id}",
		"/umi/offers/OFR-00001/take":            "/umi/offers/{id}/take",
		"/umi/offers/OFR-00001/cancel":          "/umi/offers/{id}/cancel",
		"/umi/offers":                           "/umi/offers",
		"/umi/wallets/investor1/fund":           "/umi/wallets/{id}/fund",
		"/umi/ownership/PROP-GREEN-VALLEY":      "/umi/ownership/{id}",
		"/umi/holdings/investor1":               "/umi/holdings/{id}",
		"/umi/income/investor1":                 "/umi/income/{id}",
		"/umi/market/PROP-A":                    "/umi/market/{id}",
		"/umi/baskets/BKT-1":                    "/umi/baskets/{id}",
		"/drunix/tx/abc123":                     "/drunix/tx/{id}",
		"/umi/dvp":                              "/umi/dvp",
		"/metrics":                              "/metrics",
		"/wat/ever/unknown":                     "other",
	}
	for in, want := range cases {
		if got := routeFor(in); got != want {
			t.Errorf("routeFor(%q) = %q, want %q", in, got, want)
		}
	}
}

// A path nobody anticipated must be bucketed, never passed through: that is
// what keeps an unknown or hostile URL from minting a new time series.
func TestUnknownPathsAreBucketed(t *testing.T) {
	for _, p := range []string{
		"/umi/offers/a/b/c/d", "/random/" + strings.Repeat("x", 300), "/../../etc/passwd",
	} {
		got := routeFor(p)
		if strings.Contains(got, "xxxx") || len(got) > 40 {
			t.Errorf("routeFor(%q) leaked the raw path: %q", p, got)
		}
	}
}

func TestMetricsCountsAndClassifies(t *testing.T) {
	m := newMetrics()
	m.observe("GET", "/umi/notifications/alice", 200, 3*time.Millisecond)
	m.observe("GET", "/umi/notifications/bob", 200, 7*time.Millisecond)
	m.observe("GET", "/umi/notifications/carol", 404, time.Millisecond)
	m.observe("POST", "/umi/dvp", 500, 12*time.Millisecond)

	st := m.routes["GET /umi/notifications/{id}"]
	if st == nil {
		t.Fatal("three different participants should share one series")
	}
	if st.count != 3 {
		t.Fatalf("count = %d, want 3", st.count)
	}
	if st.rejects != 1 {
		t.Fatalf("rejects = %d, want 1 (the 404)", st.rejects)
	}
	if st.errors != 0 {
		t.Fatalf("a 4xx is a rule firing, not an error: errors = %d", st.errors)
	}
	if post := m.routes["POST /umi/dvp"]; post == nil || post.errors != 1 {
		t.Fatal("a 5xx should count as an error")
	}
	// 3ms and 7ms fall in the <=10ms bucket; 1ms also does.
	if st.buckets[2] != 3 { // latencyBucketsMs[2] == 10
		t.Fatalf("le=10ms bucket = %d, want 3", st.buckets[2])
	}
	if st.buckets[0] != 1 { // le=1ms
		t.Fatalf("le=1ms bucket = %d, want 1", st.buckets[0])
	}
}

func TestMetricsEndpointRenders(t *testing.T) {
	s := NewServer(nil)
	s.Pipeline = NewPipeline(NewStateDB(), NewTransientStore(), NewChain())
	rec := httptest.NewRecorder()
	s.handleMetrics(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	body := rec.Body.String()
	for _, want := range []string{
		"# HELP aasthi_uptime_seconds", "# TYPE aasthi_uptime_seconds gauge",
		"aasthi_ledger_blocks", "aasthi_ledger_valid 1",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("metrics body missing %q", want)
		}
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/plain") {
		t.Errorf("content type = %q, want text/plain", ct)
	}
}

// The metrics wrapper must not swallow the Flusher, or server-sent events
// buffer forever behind it.
func TestMetricsWrapperKeepsStreamingAlive(t *testing.T) {
	s := NewServer(nil)
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, ok := w.(http.Flusher); !ok {
			t.Error("handler lost access to http.Flusher through the metrics wrapper")
		}
		w.WriteHeader(http.StatusOK)
	})
	rec := httptest.NewRecorder()
	s.withMetrics(inner).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/umi/config", nil))
}
