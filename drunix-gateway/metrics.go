package drunix

import (
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

// Observability, in Prometheus text format and with no dependencies.
//
// The one thing that will quietly ruin a metrics endpoint is cardinality: a
// label whose values are unbounded (an instruction id, a wallet name, an
// asset id) turns one time series into millions and takes the scraper down
// with it. Every path here is normalised to a fixed template before it ever
// becomes a label, and routeFor is the only place that decides what a path
// is called. If a future route adds a dynamic segment, it must be added
// there too — the default is to bucket it as "other", never to pass it
// through raw.

// latency buckets in milliseconds, cumulative (Prometheus histogram style)
var latencyBucketsMs = []float64{1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500}

type routeStat struct {
	count   int64
	errors  int64 // 5xx
	rejects int64 // 4xx
	sumMs   float64
	buckets []int64 // same length as latencyBucketsMs
	maxMs   float64
}

type metrics struct {
	mu      sync.Mutex
	routes  map[string]*routeStat // "METHOD route" -> stats
	started time.Time
}

func newMetrics() *metrics {
	return &metrics{routes: map[string]*routeStat{}, started: time.Now()}
}

// routeFor collapses a concrete request path onto a bounded template. Ids,
// participant names and asset ids are stripped out: they are high-cardinality
// and belong in the ledger, not in a metric label.
func routeFor(path string) string {
	p := strings.TrimSuffix(path, "/")
	switch {
	case p == "" || p == "/":
		return "/"
	case p == "/health", p == "/metrics", p == "/drunix/chain", p == "/drunix/events",
		p == "/drunix/submit", p == "/drunix/evaluate", p == "/drunix/recent",
		p == "/drunix/pipeline", p == "/drunix/pipeline/stats", p == "/drunix/ledger/status",
		p == "/fraud/score", p == "/fraud/config":
		return p
	case strings.HasPrefix(p, "/drunix/tx/"):
		return "/drunix/tx/{id}"
	case p == "/umi/offers":
		return "/umi/offers"
	case strings.HasPrefix(p, "/umi/offers/"):
		// .../{id}, .../{id}/take, .../{id}/cancel
		if strings.HasSuffix(p, "/take") {
			return "/umi/offers/{id}/take"
		}
		if strings.HasSuffix(p, "/cancel") {
			return "/umi/offers/{id}/cancel"
		}
		return "/umi/offers/{id}"
	case strings.HasPrefix(p, "/umi/notifications/"):
		if strings.HasSuffix(p, "/read-all") {
			return "/umi/notifications/{id}/read-all"
		}
		if strings.HasSuffix(p, "/read") {
			return "/umi/notifications/{id}/read"
		}
		return "/umi/notifications/{id}"
	case strings.HasPrefix(p, "/umi/wallets/"):
		if strings.HasSuffix(p, "/fund") {
			return "/umi/wallets/{id}/fund"
		}
		return "/umi/wallets/{id}"
	case strings.HasPrefix(p, "/umi/baskets/"):
		return "/umi/baskets/{id}"
	case strings.HasPrefix(p, "/umi/ownership/"):
		return "/umi/ownership/{id}"
	case strings.HasPrefix(p, "/umi/holdings/"):
		return "/umi/holdings/{id}"
	case p == "/umi/documents":
		return "/umi/documents"
	case strings.HasPrefix(p, "/umi/documents/"):
		// A CID is content-derived and unbounded, so it can never be a label.
		switch {
		case strings.HasSuffix(p, "/verify"):
			return "/umi/documents/verify"
		case strings.HasSuffix(p, "/revoke"):
			return "/umi/documents/{cid}/revoke"
		case strings.HasSuffix(p, "/supersede"):
			return "/umi/documents/{cid}/supersede"
		case strings.HasPrefix(p, "/umi/documents/fetch/"):
			return "/umi/documents/fetch/{cid}"
		case strings.HasPrefix(p, "/umi/documents/cid/"):
			return "/umi/documents/cid/{cid}"
		case strings.HasPrefix(p, "/umi/documents/subject/"):
			return "/umi/documents/subject/{id}"
		}
		return "/umi/documents/{id}"
	case strings.HasPrefix(p, "/umi/analytics/"):
		return "/umi/analytics/{id}"
	case strings.HasPrefix(p, "/umi/income/"):
		return "/umi/income/{id}"
	case strings.HasPrefix(p, "/umi/market/"):
		return "/umi/market/{id}"
	case strings.HasPrefix(p, "/umi/"):
		// Fixed /umi routes (config, dvp, seed, servicing, wallets,
		// instructions, reconciliation, baskets) have no dynamic segment.
		if strings.Count(p, "/") == 2 {
			return p
		}
		return "/umi/other"
	}
	return "other"
}

func (m *metrics) observe(method, path string, status int, took time.Duration) {
	key := method + " " + routeFor(path)
	ms := float64(took.Nanoseconds()) / 1e6

	m.mu.Lock()
	defer m.mu.Unlock()
	st := m.routes[key]
	if st == nil {
		st = &routeStat{buckets: make([]int64, len(latencyBucketsMs))}
		m.routes[key] = st
	}
	st.count++
	st.sumMs += ms
	if ms > st.maxMs {
		st.maxMs = ms
	}
	switch {
	case status >= 500:
		st.errors++
	case status >= 400:
		st.rejects++
	}
	for i, b := range latencyBucketsMs {
		if ms <= b {
			st.buckets[i]++
		}
	}
}

// statusRecorder captures the status code, which ResponseWriter does not
// expose. Defaults to 200 because a handler that writes a body without
// calling WriteHeader has implicitly sent one.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (w *statusRecorder) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusRecorder) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.ResponseWriter.Write(b)
}

// Flush keeps server-sent events working through the wrapper: without it the
// recorder hides the underlying Flusher and the live stream buffers forever.
func (w *statusRecorder) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (s *Server) withMetrics(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.metrics == nil {
			next.ServeHTTP(w, r)
			return
		}
		// The event stream is long-lived by design; timing it would record a
		// multi-minute "request" and skew every latency figure on the page.
		if routeFor(r.URL.Path) == "/drunix/events" {
			next.ServeHTTP(w, r)
			return
		}
		rec := &statusRecorder{ResponseWriter: w}
		start := time.Now()
		next.ServeHTTP(rec, r)
		if rec.status == 0 {
			rec.status = http.StatusOK
		}
		s.metrics.observe(r.Method, r.URL.Path, rec.status, time.Since(start))
	})
}

func escapeLabel(v string) string {
	return strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", "").Replace(v)
}

// handleMetrics renders Prometheus text format.
func (s *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		umiErr(w, http.StatusMethodNotAllowed, "ERR_UMI_METHOD", "Use GET to read metrics.")
		return
	}
	var b strings.Builder

	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")

	if s.metrics != nil {
		// Build identity. The commit is a label on a constant 1 so a dashboard
		// can show which revision is live and alert when it goes stale; the
		// value set is bounded by the number of deploys, not by traffic.
		bi := currentBuild()
		b.WriteString("# HELP aasthi_build_info Deployed build, as labels on a constant 1.\n")
		b.WriteString("# TYPE aasthi_build_info gauge\n")
		fmt.Fprintf(&b, "aasthi_build_info{commit=\"%s\",go=\"%s\",features=\"%d\"} 1\n",
			escapeLabel(bi.Commit), escapeLabel(bi.Go), len(bi.Features))
		b.WriteString("# HELP aasthi_uptime_seconds Time since this process started.\n")
		b.WriteString("# TYPE aasthi_uptime_seconds gauge\n")
		fmt.Fprintf(&b, "aasthi_uptime_seconds %.0f\n", time.Since(s.metrics.started).Seconds())

		s.metrics.mu.Lock()
		keys := make([]string, 0, len(s.metrics.routes))
		for k := range s.metrics.routes {
			keys = append(keys, k)
		}
		sort.Strings(keys)

		b.WriteString("# HELP aasthi_http_requests_total Requests by method and route template.\n")
		b.WriteString("# TYPE aasthi_http_requests_total counter\n")
		for _, k := range keys {
			parts := strings.SplitN(k, " ", 2)
			st := s.metrics.routes[k]
			fmt.Fprintf(&b, "aasthi_http_requests_total{method=\"%s\",route=\"%s\"} %d\n",
				escapeLabel(parts[0]), escapeLabel(parts[1]), st.count)
		}

		b.WriteString("# HELP aasthi_http_rejected_total Requests refused with a 4xx (a rule firing, not a fault).\n")
		b.WriteString("# TYPE aasthi_http_rejected_total counter\n")
		for _, k := range keys {
			parts := strings.SplitN(k, " ", 2)
			fmt.Fprintf(&b, "aasthi_http_rejected_total{method=\"%s\",route=\"%s\"} %d\n",
				escapeLabel(parts[0]), escapeLabel(parts[1]), s.metrics.routes[k].rejects)
		}

		b.WriteString("# HELP aasthi_http_errors_total Requests that failed with a 5xx.\n")
		b.WriteString("# TYPE aasthi_http_errors_total counter\n")
		for _, k := range keys {
			parts := strings.SplitN(k, " ", 2)
			fmt.Fprintf(&b, "aasthi_http_errors_total{method=\"%s\",route=\"%s\"} %d\n",
				escapeLabel(parts[0]), escapeLabel(parts[1]), s.metrics.routes[k].errors)
		}

		b.WriteString("# HELP aasthi_http_request_duration_ms Request latency by route.\n")
		b.WriteString("# TYPE aasthi_http_request_duration_ms histogram\n")
		for _, k := range keys {
			parts := strings.SplitN(k, " ", 2)
			st := s.metrics.routes[k]
			lbl := fmt.Sprintf("method=\"%s\",route=\"%s\"", escapeLabel(parts[0]), escapeLabel(parts[1]))
			for i, bk := range latencyBucketsMs {
				fmt.Fprintf(&b, "aasthi_http_request_duration_ms_bucket{%s,le=\"%g\"} %d\n", lbl, bk, st.buckets[i])
			}
			fmt.Fprintf(&b, "aasthi_http_request_duration_ms_bucket{%s,le=\"+Inf\"} %d\n", lbl, st.count)
			fmt.Fprintf(&b, "aasthi_http_request_duration_ms_sum{%s} %.3f\n", lbl, st.sumMs)
			fmt.Fprintf(&b, "aasthi_http_request_duration_ms_count{%s} %d\n", lbl, st.count)
		}
		s.metrics.mu.Unlock()
	}

	// Business metrics. These are the numbers worth alerting on — a rising
	// failure count or a chain that stops verifying matters far more than
	// request rate.
	if s.Pipeline != nil && s.Pipeline.CP != nil && s.Pipeline.CP.Ledger != nil {
		c := s.Pipeline.CP.Ledger
		blocks := len(c.Snapshot())
		v := c.Verify()
		b.WriteString("# HELP aasthi_ledger_blocks Blocks committed to the hash chain.\n")
		b.WriteString("# TYPE aasthi_ledger_blocks gauge\n")
		fmt.Fprintf(&b, "aasthi_ledger_blocks %d\n", blocks)
		b.WriteString("# HELP aasthi_ledger_valid 1 when the chain verifies from genesis, 0 when it does not.\n")
		b.WriteString("# TYPE aasthi_ledger_valid gauge\n")
		valid := 0
		if v.Valid {
			valid = 1
		}
		fmt.Fprintf(&b, "aasthi_ledger_valid %d\n", valid)
	}

	if s.events != nil {
		b.WriteString("# HELP aasthi_stream_subscribers Browsers currently watching the live ledger stream.\n")
		b.WriteString("# TYPE aasthi_stream_subscribers gauge\n")
		fmt.Fprintf(&b, "aasthi_stream_subscribers %d\n", s.events.count())
	}

	if s.UMI != nil {
		settled, failed, byReason := s.UMI.SettlementCounts()
		b.WriteString("# HELP aasthi_settlements_total Settlement instructions by outcome.\n")
		b.WriteString("# TYPE aasthi_settlements_total counter\n")
		fmt.Fprintf(&b, "aasthi_settlements_total{outcome=\"settled\"} %d\n", settled)
		fmt.Fprintf(&b, "aasthi_settlements_total{outcome=\"failed\"} %d\n", failed)

		b.WriteString("# HELP aasthi_settlement_failures_total Failed settlements by reason.\n")
		b.WriteString("# TYPE aasthi_settlement_failures_total counter\n")
		reasons := make([]string, 0, len(byReason))
		for k := range byReason {
			reasons = append(reasons, k)
		}
		sort.Strings(reasons)
		for _, k := range reasons {
			fmt.Fprintf(&b, "aasthi_settlement_failures_total{reason=\"%s\"} %d\n", escapeLabel(k), byReason[k])
		}

		b.WriteString("# HELP aasthi_open_offers Offers currently open on the secondary market.\n")
		b.WriteString("# TYPE aasthi_open_offers gauge\n")
		fmt.Fprintf(&b, "aasthi_open_offers %d\n", len(s.UMI.Offers("", true)))

		b.WriteString("# HELP aasthi_wallets Wholesale CBDC wallets on the rail.\n")
		b.WriteString("# TYPE aasthi_wallets gauge\n")
		fmt.Fprintf(&b, "aasthi_wallets %d\n", s.UMI.WalletCount())
	}

	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(b.String()))
}
