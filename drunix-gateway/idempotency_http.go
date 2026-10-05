package drunix

// HTTP glue for request idempotency, shared by every endpoint that moves
// money. Kept in one place so the three money-moving handlers cannot drift
// apart: a settlement rail where DvP is retry-safe but servicing is not is
// arguably worse than one where neither is, because it invites the caller to
// assume a guarantee that only sometimes holds.

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
)

// idemTx is one in-flight idempotent request.
type idemTx struct {
	srv *Server
	key string
}

// beginIdem reads and buffers the body, then claims the idempotency key if
// one was supplied.
//
// Returns proceed=false when it has already written a response: a replay of
// an earlier result, a 409 for a duplicate still running, a 422 for a key
// reused with a different body, or a 400 for a malformed request. Callers
// must return immediately in that case.
//
// With no Idempotency-Key header the request proceeds exactly as it did
// before this layer existed.
func (s *Server) beginIdem(w http.ResponseWriter, r *http.Request) (tx *idemTx, proceed bool) {
	raw, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		umiErr(w, http.StatusBadRequest, "ERR_BAD_BODY", err.Error())
		return nil, false
	}
	// Hand the body back so the handler's own decode still works.
	r.Body = io.NopCloser(bytes.NewReader(raw))

	key := r.Header.Get("Idempotency-Key")
	if key == "" {
		key = r.Header.Get("X-Idempotency-Key")
	}
	if key == "" || s.Idem == nil {
		return &idemTx{srv: s}, true
	}
	if len(key) > idemMaxKeyLen {
		umiErr(w, http.StatusBadRequest, "ERR_IDEMPOTENCY_KEY_TOO_LONG",
			"Idempotency-Key must be at most 255 characters")
		return nil, false
	}

	// Fingerprint over method + path + body, not the body alone. Two
	// different endpoints can legitimately receive the same bytes (an empty
	// object, say), and replaying a funding response to a servicing call
	// would be a silent, very confusing failure.
	fp := Fingerprint(append([]byte(r.Method+" "+r.URL.Path+"\n"), raw...))

	switch outcome, rec := s.Idem.Begin(key, fp); outcome {
	case IdemReplay:
		w.Header().Set("Idempotent-Replay", "true")
		writeRaw(w, rec.Status, idemReplayBody(rec.Body))
		return nil, false
	case IdemInFlight:
		umiErr(w, http.StatusConflict, "ERR_IDEMPOTENCY_IN_FLIGHT",
			"a request with this Idempotency-Key is still being processed")
		return nil, false
	case IdemConflict:
		umiErr(w, http.StatusUnprocessableEntity, "ERR_IDEMPOTENCY_KEY_REUSED",
			"this Idempotency-Key was already used with a different request body")
		return nil, false
	}
	return &idemTx{srv: s, key: key}, true
}

// finish writes the response and records it against the key, so a later retry
// replays this exact result instead of executing again.
//
// Failures are recorded too. Retrying a failed settlement must replay the
// failure rather than get a second attempt — that is what lets a caller tell
// "it failed" apart from "it never ran".
func (t *idemTx) finish(w http.ResponseWriter, status int, payload map[string]interface{}) {
	if t == nil {
		return
	}
	body, err := json.Marshal(payload)
	if err != nil {
		// Encoding failed, so there is no stable response to record. Fall
		// back to the normal writer and leave the key unclaimed.
		writeJSON(w, status, payload)
		return
	}
	if t.srv != nil && t.srv.Idem != nil && t.key != "" {
		t.srv.Idem.Complete(t.key, status, body)
		t.key = "" // completed, so the deferred release is a no-op
	}
	writeRaw(w, status, body)
}

// release frees a key whose handler never produced a response, so a panic or
// an early return does not lock the caller out for the full 24-hour TTL.
// Safe to defer unconditionally: it does nothing once finish has run.
func (t *idemTx) release() {
	if t == nil || t.srv == nil || t.srv.Idem == nil || t.key == "" {
		return
	}
	t.srv.Idem.Release(t.key)
	t.key = ""
}

// writeRaw emits an already-encoded JSON body.
func writeRaw(w http.ResponseWriter, status int, body []byte) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}
