package drunix

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// Live updates. The ledger is already the single place every state change
// lands, so it is also the only honest event source: if a client is told
// something happened, a block exists to prove it.
//
// Server-sent events rather than WebSockets. The traffic is strictly
// one-directional (the server tells the browser a block was committed; the
// browser never pushes back over the same pipe), SSE reconnects on its own,
// and it survives ordinary HTTP proxies that would need an upgrade dance for
// a socket. Nothing here blocks a settlement: a slow or dead subscriber is
// dropped, never waited on.

// LedgerEvent is what a subscriber receives. It is deliberately small — the
// height and hash are enough to decide whether to refetch, and no client
// should be trusting a pushed payload as the source of truth anyway.
type LedgerEvent struct {
	Height    int64  `json:"height"`
	Type      string `json:"type"`
	Hash      string `json:"hash"`
	Timestamp string `json:"timestamp"`
}

type eventHub struct {
	mu   sync.Mutex
	subs map[int]chan LedgerEvent
	next int
}

func newEventHub() *eventHub {
	return &eventHub{subs: map[int]chan LedgerEvent{}}
}

func (h *eventHub) subscribe() (int, chan LedgerEvent) {
	h.mu.Lock()
	defer h.mu.Unlock()
	id := h.next
	h.next++
	// Buffered: a subscriber that stalls briefly still catches up. If it
	// fills, publish drops rather than blocking the committing goroutine.
	ch := make(chan LedgerEvent, 32)
	h.subs[id] = ch
	return id, ch
}

func (h *eventHub) unsubscribe(id int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if ch, ok := h.subs[id]; ok {
		delete(h.subs, id)
		close(ch)
	}
}

// publish never blocks. Committing a block must not be slowed down, let alone
// stalled, by anyone who happens to be watching.
func (h *eventHub) publish(e LedgerEvent) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, ch := range h.subs {
		select {
		case ch <- e:
		default: // subscriber is too slow; it will resync on its next poll
		}
	}
}

func (h *eventHub) count() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.subs)
}

// handleEvents streams ledger commits as server-sent events.
func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSON(w, http.StatusInternalServerError,
			map[string]string{"error": "ERR_STREAMING_UNSUPPORTED"})
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	// Buffering proxies will happily hold an event stream hostage.
	w.Header().Set("X-Accel-Buffering", "no")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(http.StatusOK)

	id, ch := s.events.subscribe()
	defer s.events.unsubscribe(id)

	send := func(event string, v interface{}) bool {
		b, err := json.Marshal(v)
		if err != nil {
			return true
		}
		if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, b); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}

	// Tell a new subscriber where the chain already is, so it can decide
	// whether it is behind without waiting for the next commit.
	var height int64
	if s.Pipeline != nil && s.Pipeline.CP != nil && s.Pipeline.CP.Ledger != nil {
		height = int64(len(s.Pipeline.CP.Ledger.Snapshot()))
	}
	send("hello", map[string]interface{}{
		"height":      height,
		"subscribers": s.events.count(),
		"note":        "every event corresponds to a committed block",
	})

	// Comment lines keep idle connections alive through proxies that cut
	// quiet sockets.
	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case e, open := <-ch:
			if !open {
				return
			}
			if !send("block", e) {
				return
			}
		case <-ping.C:
			if _, err := fmt.Fprint(w, ": keep-alive\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}
