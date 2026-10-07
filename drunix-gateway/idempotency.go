package drunix

// Request-level idempotency for the money-moving UMI endpoints.
//
// Why this exists: POST /umi/dvp moves tokens and cash. If the caller's
// connection drops after the rail has committed the block but before the
// response arrives, the caller cannot tell whether it settled. The only safe
// thing a client can do is retry — and without this layer a retry settles a
// second time, moving the money twice. That is the single most expensive bug
// a settlement system can have, and no amount of care on the client side can
// fix it, because the ambiguity is on the network.
//
// The contract is the standard one (Stripe's, and the one ISO 20022 assumes
// via end-to-end identification):
//
//   - caller sends Idempotency-Key on a POST
//   - first time: the request runs, and the response is recorded against the
//     key together with a fingerprint of the request body
//   - retry with the same key and the same body: the recorded response is
//     replayed verbatim, with no second settlement
//   - same key, DIFFERENT body: 422. This is a client bug, and quietly
//     settling the new payload under an old key would hide it
//   - retry while the first is still running: 409. Concurrent duplicates are
//     rejected rather than queued, because the caller is about to receive the
//     first response anyway
//
// Storage: Postgres when DATABASE_URL is set, so the guarantee survives the
// restart it exists to protect against; an in-memory map otherwise. Sending
// no key preserves exactly the old behaviour, so nothing that worked before
// this change behaves differently.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"sync"
	"time"
)

const (
	idemTTL       = 24 * time.Hour
	idemMaxKeyLen = 255
)

// IdemPersister is the optional durable backend. PostgresUMIStore implements
// it; the in-memory store does not, and the layer degrades to process-local.
type IdemPersister interface {
	IdemInit(ctx context.Context) error
	IdemGet(ctx context.Context, key string) (*IdemRecord, error)
	// IdemClaim inserts a reservation and reports whether this caller won the
	// race. It must be atomic — the whole guarantee rests on it.
	IdemClaim(ctx context.Context, key, fingerprint string, expires time.Time) (won bool, existing *IdemRecord, err error)
	IdemComplete(ctx context.Context, key string, status int, body []byte) error
	IdemRelease(ctx context.Context, key string) error
}

// IdemRecord is one recorded request.
type IdemRecord struct {
	Key         string    `json:"key"`
	Fingerprint string    `json:"fingerprint"`
	Status      int       `json:"status"` // 0 while in flight
	Body        []byte    `json:"body"`   // recorded response
	Done        bool      `json:"done"`
	CreatedAt   time.Time `json:"createdAt"`
	ExpiresAt   time.Time `json:"expiresAt"`
}

// IdemStore is the in-memory half, and the front for the durable half.
type IdemStore struct {
	mu      sync.Mutex
	mem     map[string]*IdemRecord
	durable IdemPersister
	stop    chan struct{}
}

func NewIdemStore() *IdemStore {
	s := &IdemStore{mem: make(map[string]*IdemRecord), stop: make(chan struct{})}
	go s.cleanupLoop()
	return s
}

// WithPersister attaches durable storage. Safe to call with nil.
func (s *IdemStore) WithPersister(p IdemPersister) *IdemStore {
	if p == nil {
		return s
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	if err := p.IdemInit(ctx); err != nil {
		// Durable setup failed: stay in memory rather than refuse to serve.
		log.Printf("UMI idempotency: durable init failed, staying in-memory: %v", err)
		return s
	}
	s.durable = p
	log.Printf("UMI idempotency: durable — keys survive restart (24h TTL)")
	return s
}

func (s *IdemStore) Mode() string {
	if s.durable != nil {
		return "postgres"
	}
	return "in-memory (resets on restart)"
}

// Fingerprint is a stable hash of the request body, used to detect a key
// being reused for a different request.
func Fingerprint(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

// IdemOutcome tells the handler what to do.
type IdemOutcome int

const (
	IdemProceed  IdemOutcome = iota // first time; run the request
	IdemReplay                      // completed before; replay Record
	IdemInFlight                    // duplicate still running; 409
	IdemConflict                    // key reused with a different body; 422
)

// Begin claims the key. The returned record is meaningful for IdemReplay.
func (s *IdemStore) Begin(key, fingerprint string) (IdemOutcome, *IdemRecord) {
	if key == "" {
		return IdemProceed, nil
	}
	now := time.Now()
	expires := now.Add(idemTTL)

	if s.durable != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		won, existing, err := s.durable.IdemClaim(ctx, key, fingerprint, expires)
		if err != nil {
			// Durable store unreachable. Fall through to the in-memory path:
			// a weaker guarantee is better than refusing to settle, and the
			// caller is no worse off than before this layer existed.
			log.Printf("UMI idempotency: durable claim failed, falling back to memory: %v", err)
		} else if won {
			s.mu.Lock()
			s.mem[key] = &IdemRecord{Key: key, Fingerprint: fingerprint, CreatedAt: now, ExpiresAt: expires}
			s.mu.Unlock()
			return IdemProceed, nil
		} else if existing != nil {
			return classify(existing, fingerprint), existing
		}
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if rec, ok := s.mem[key]; ok {
		if now.After(rec.ExpiresAt) {
			delete(s.mem, key)
		} else {
			return classify(rec, fingerprint), rec
		}
	}
	s.mem[key] = &IdemRecord{Key: key, Fingerprint: fingerprint, CreatedAt: now, ExpiresAt: expires}
	return IdemProceed, nil
}

func classify(rec *IdemRecord, fingerprint string) IdemOutcome {
	if rec.Fingerprint != "" && rec.Fingerprint != fingerprint {
		return IdemConflict
	}
	if !rec.Done {
		return IdemInFlight
	}
	return IdemReplay
}

// Complete records the response so a later retry can replay it.
func (s *IdemStore) Complete(key string, status int, body []byte) {
	if key == "" {
		return
	}
	s.mu.Lock()
	if rec, ok := s.mem[key]; ok {
		rec.Status = status
		rec.Body = append([]byte(nil), body...)
		rec.Done = true
	}
	s.mu.Unlock()

	if s.durable != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		if err := s.durable.IdemComplete(ctx, key, status, body); err != nil {
			log.Printf("UMI idempotency: durable complete failed for %s: %v", key, err)
		}
	}
}

// Release drops a reservation whose handler never produced a response, so the
// caller is not locked out for 24 hours by a panic.
func (s *IdemStore) Release(key string) {
	if key == "" {
		return
	}
	s.mu.Lock()
	if rec, ok := s.mem[key]; ok && !rec.Done {
		delete(s.mem, key)
	}
	s.mu.Unlock()

	if s.durable != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = s.durable.IdemRelease(ctx, key)
	}
}

func (s *IdemStore) cleanupLoop() {
	t := time.NewTicker(1 * time.Hour)
	defer t.Stop()
	for {
		select {
		case <-s.stop:
			return
		case <-t.C:
			s.mu.Lock()
			now := time.Now()
			for k, v := range s.mem {
				if now.After(v.ExpiresAt) {
					delete(s.mem, k)
				}
			}
			s.mu.Unlock()
		}
	}
}

func (s *IdemStore) Close() { close(s.stop) }

// idemReplayBody is what a replayed response carries, so the caller can tell
// a replay from a fresh settlement. Hiding that would be worse: a client
// reconciling two identical responses should know only one settlement
// happened.
func idemReplayBody(raw []byte) []byte {
	var m map[string]interface{}
	if err := json.Unmarshal(raw, &m); err != nil {
		return raw
	}
	m["idempotentReplay"] = true
	out, err := json.Marshal(m)
	if err != nil {
		return raw
	}
	return out
}
