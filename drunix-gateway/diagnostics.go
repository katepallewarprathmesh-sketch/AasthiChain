package drunix

// Diagnostics: making a failure in the rail debuggable after the fact.
//
// The rail used to fail the way most small services do. A request returned a
// 4xx or 5xx, the body said something short, and unless someone was watching
// the process output at that moment the evidence was gone. Worse, a panic in
// a handler took the whole process down with it, so the one failure most
// worth investigating was also the one that destroyed its own context.
//
// This adds three things and deliberately nothing more:
//
//  1. Every request gets an id, returned in X-Request-Id. A failing response
//     is recorded under that id, so a screenshot becomes a lookup key.
//  2. A panic is recovered, recorded WITH its stack, and answered as a 500.
//     One bad request can no longer stop settlement for everyone else.
//  3. GET /diagnostics reads the ring back.
//
// The ring is in memory and capped, and it resets with the process. That is
// a real limitation, which is why every entry is also written to the log as
// one greppable line: the platform log is the durable copy, the endpoint is
// the convenient one.

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"runtime/debug"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const diagRingSize = 200

// DiagEntry is one recorded failure.
type DiagEntry struct {
	RequestID string `json:"requestId"`
	At        string `json:"at"`
	Status    int    `json:"status"`
	Method    string `json:"method"`
	Path      string `json:"path"`
	Query     string `json:"query,omitempty"`
	Identity  string `json:"identity,omitempty"`
	Role      string `json:"role,omitempty"`
	Body      string `json:"responseBody,omitempty"`
	Panic     string `json:"panic,omitempty"`
	Stack     string `json:"stack,omitempty"`
	Millis    int64  `json:"ms"`
}

type diagRing struct {
	mu       sync.RWMutex
	entries  []DiagEntry
	counts   map[string]int
	total    int64
	bootedAt time.Time
}

var diag = &diagRing{counts: map[string]int{}, bootedAt: time.Now()}

func (d *diagRing) add(e DiagEntry) {
	d.mu.Lock()
	d.entries = append([]DiagEntry{e}, d.entries...)
	if len(d.entries) > diagRingSize {
		d.entries = d.entries[:diagRingSize]
	}
	key := fmt.Sprintf("HTTP_%d", e.Status)
	if e.Panic != "" {
		key = "PANIC"
	}
	d.counts[key]++
	d.total++
	d.mu.Unlock()

	// One line, one JSON object, fixed prefix: searching a host's logs for
	// "drunix-error" finds every one of these and nothing else.
	if b, err := json.Marshal(e); err == nil {
		log.Printf("[drunix-error] %s", b)
	}
}

func (d *diagRing) snapshot(limit int, reqID, status string) ([]DiagEntry, map[string]int, int64, time.Time) {
	d.mu.RLock()
	defer d.mu.RUnlock()
	out := make([]DiagEntry, 0, limit)
	for _, e := range d.entries {
		if reqID != "" && e.RequestID != reqID {
			continue
		}
		if status != "" && fmt.Sprintf("%d", e.Status) != status {
			continue
		}
		out = append(out, e)
		if len(out) >= limit {
			break
		}
	}
	counts := make(map[string]int, len(d.counts))
	for k, v := range d.counts {
		counts[k] = v
	}
	return out, counts, d.total, d.bootedAt
}

var diagSeq uint64

func newRequestID() string {
	n := atomic.AddUint64(&diagSeq, 1)
	return fmt.Sprintf("rail_%s_%d", time.Now().UTC().Format("150405.000"), n)
}

// diagWriter captures the status and a bounded prefix of the body. Only
// failures keep their body: a successful settlement response can be large and
// is of no diagnostic interest.
type diagWriter struct {
	http.ResponseWriter
	status  int
	buf     strings.Builder
	capture bool
}

func (w *diagWriter) WriteHeader(code int) {
	w.status = code
	w.capture = code >= 400
	w.ResponseWriter.WriteHeader(code)
}

func (w *diagWriter) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	if w.capture && w.buf.Len() < 1000 {
		w.buf.Write(b)
	}
	return w.ResponseWriter.Write(b)
}

// Flush keeps Server-Sent Events working through the wrapper. Without this
// the /umi/events stream buffers and the live demo silently stops updating,
// which is exactly the kind of breakage a diagnostics layer must not cause.
func (w *diagWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// WithDiagnostics wraps the rail's router. It serves GET /diagnostics itself
// and passes everything else through, recording failures on the way out.
func WithDiagnostics(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/diagnostics" && r.Method == http.MethodGet {
			serveDiagnostics(w, r)
			return
		}

		start := time.Now()
		reqID := newRequestID()
		w.Header().Set("X-Request-Id", reqID)
		dw := &diagWriter{ResponseWriter: w, status: 0}

		record := func(panicVal string, stack string) {
			status := dw.status
			if status == 0 {
				status = http.StatusOK
			}
			if status < 400 && panicVal == "" {
				return
			}
			diag.add(DiagEntry{
				RequestID: reqID,
				At:        time.Now().UTC().Format(time.RFC3339Nano),
				Status:    status,
				Method:    r.Method,
				Path:      r.URL.Path,
				Query:     r.URL.RawQuery,
				Identity:  r.Header.Get("X-Fabric-Identity"),
				Role:      r.Header.Get("X-Identity-Role"),
				Body:      strings.TrimSpace(dw.buf.String()),
				Panic:     panicVal,
				Stack:     stack,
				Millis:    time.Since(start).Milliseconds(),
			})
		}

		defer func() {
			if rec := recover(); rec != nil {
				stack := string(debug.Stack())
				// A panic used to kill the process, taking every in-flight
				// settlement with it. Answer this one request badly instead.
				dw.status = http.StatusInternalServerError
				record(fmt.Sprintf("%v", rec), trimStack(stack))
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusInternalServerError)
				_ = json.NewEncoder(w).Encode(map[string]interface{}{
					"error":     "ERR_PANIC",
					"message":   "The rail recovered from an internal error. Nothing was committed by this request.",
					"requestId": reqID,
					"hint":      "GET /diagnostics?requestId=" + reqID + " for the stack.",
				})
				return
			}
			record("", "")
		}()

		next.ServeHTTP(dw, r)
	})
}

// A full goroutine dump is noise. The first frames are where the fault is.
func trimStack(s string) string {
	lines := strings.Split(s, "\n")
	if len(lines) > 24 {
		lines = lines[:24]
	}
	return strings.Join(lines, "\n")
}

func serveDiagnostics(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit := 50
	if v := q.Get("limit"); v != "" {
		if n := atoiSafe(v); n > 0 && n <= diagRingSize {
			limit = n
		}
	}
	entries, counts, total, booted := diag.snapshot(limit, q.Get("requestId"), q.Get("status"))
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"service":        "drunix-gateway",
		"bootedAt":       booted.UTC().Format(time.RFC3339),
		"uptimeSeconds":  int(time.Since(booted).Seconds()),
		"totalFailures":  total,
		"heldInRing":     len(entries),
		"ringCapacity":   diagRingSize,
		"byStatus":       counts,
		"failures":       entries,
		"note":           "In-memory and reset on restart. The durable copy is this process's log: search it for \"drunix-error\".",
		"howToUse": []string{
			"Every response carries X-Request-Id.",
			"GET /diagnostics?requestId=... for one request, including a stack if it panicked.",
			"GET /diagnostics?status=500 for every occurrence of one failure class.",
		},
	})
}

func atoiSafe(s string) int {
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0
		}
		n = n*10 + int(c-'0')
		if n > 100000 {
			return 0
		}
	}
	return n
}
