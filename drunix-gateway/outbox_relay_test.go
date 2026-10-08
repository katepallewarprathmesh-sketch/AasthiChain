package drunix

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

// fakeOutbox stands in for umi_outbox. The locking is the interesting part:
// ProcessPending takes the rows it claims out of circulation for the duration
// of the dispatch, which is what FOR UPDATE SKIP LOCKED buys us in Postgres.
type fakeOutbox struct {
	mu     sync.Mutex
	rows   []*OutboxRow
	locked map[int64]bool
	done   map[int64]bool
	next   int64
}

func newFakeOutbox() *fakeOutbox {
	return &fakeOutbox{locked: map[int64]bool{}, done: map[int64]bool{}}
}

func (f *fakeOutbox) add(topic string, height int64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.next++
	f.rows = append(f.rows, &OutboxRow{Seq: f.next, BlockHeight: height, Topic: topic,
		DedupeKey: topic + ":" + string(rune('0'+height))})
}

func (f *fakeOutbox) claim(limit int) []*OutboxRow {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []*OutboxRow
	for _, r := range f.rows {
		if len(out) == limit {
			break
		}
		if f.done[r.Seq] || f.locked[r.Seq] {
			continue // SKIP LOCKED
		}
		f.locked[r.Seq] = true
		out = append(out, r)
	}
	return out
}

func (f *fakeOutbox) release(r *OutboxRow, delivered bool, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.locked, r.Seq)
	if delivered {
		f.done[r.Seq] = true
		return
	}
	r.Attempts++
	_ = err
}

func (f *fakeOutbox) ProcessPending(ctx context.Context, limit int, dispatch OutboxHandler) (int, error) {
	claimed := f.claim(limit)
	n := 0
	for _, r := range claimed {
		if err := dispatch(*r); err != nil {
			f.release(r, false, err)
			continue
		}
		f.release(r, true, nil)
		n++
	}
	return n, nil
}

func (f *fakeOutbox) pending() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.rows) - len(f.done)
}

func (f *fakeOutbox) attempts(seq int64) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, r := range f.rows {
		if r.Seq == seq {
			return r.Attempts
		}
	}
	return -1
}

// Test 3: a delivered row is marked; a failing consumer leaves the row pending
// with its attempt count raised, so the work is neither lost nor hammered.
func TestRelayMarksDeliveredAndRetriesFailures(t *testing.T) {
	store := newFakeOutbox()
	store.add(TopicLedgerBlock, 1)
	store.add(TopicLedgerBlock, 2)

	var seen []int64
	fail := true
	relay := NewOutboxRelay(store)
	relay.Handle(TopicLedgerBlock, func(r OutboxRow) error {
		if fail {
			return errors.New("consumer is down")
		}
		seen = append(seen, r.BlockHeight)
		return nil
	})

	n, err := relay.RunOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 || store.pending() != 2 {
		t.Fatalf("a failing consumer must deliver nothing: delivered=%d pending=%d", n, store.pending())
	}
	if store.attempts(1) != 1 {
		t.Fatalf("failed delivery should raise attempts, got %d", store.attempts(1))
	}

	fail = false
	n, err = relay.RunOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 || store.pending() != 0 {
		t.Fatalf("recovered consumer should drain the backlog: delivered=%d pending=%d", n, store.pending())
	}
	if len(seen) != 2 {
		t.Fatalf("consumer saw %d rows, want 2", len(seen))
	}
}

// An unregistered topic must not be silently marked delivered — that would
// drop a settlement's consequence, the exact failure the outbox prevents.
func TestRelayKeepsRowsWithNoConsumer(t *testing.T) {
	store := newFakeOutbox()
	store.add("umi.settled", 1)

	relay := NewOutboxRelay(store)
	n, err := relay.RunOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 || store.pending() != 1 {
		t.Fatalf("row with no consumer must stay pending: delivered=%d pending=%d", n, store.pending())
	}
}

// Test 5: two relays over one table deliver each row exactly once. This is the
// property that lets the gateway scale past a single instance without a
// leader election.
func TestTwoRelaysDeliverEachRowOnce(t *testing.T) {
	store := newFakeOutbox()
	for i := int64(1); i <= 20; i++ {
		store.add(TopicLedgerBlock, i)
	}

	var mu sync.Mutex
	count := map[int64]int{}
	handler := func(r OutboxRow) error {
		// Hold the row briefly so the two relays genuinely overlap.
		time.Sleep(time.Millisecond)
		mu.Lock()
		count[r.Seq]++
		mu.Unlock()
		return nil
	}

	a := NewOutboxRelay(store)
	a.batch = 5
	a.Handle(TopicLedgerBlock, handler)
	b := NewOutboxRelay(store)
	b.batch = 5
	b.Handle(TopicLedgerBlock, handler)

	var wg sync.WaitGroup
	for _, r := range []*OutboxRelay{a, b} {
		wg.Add(1)
		go func(rel *OutboxRelay) {
			defer wg.Done()
			for i := 0; i < 10; i++ {
				if _, err := rel.RunOnce(context.Background()); err != nil {
					t.Error(err)
					return
				}
			}
		}(r)
	}
	wg.Wait()

	if store.pending() != 0 {
		t.Fatalf("%d rows left undelivered", store.pending())
	}
	for seq, c := range count {
		if c != 1 {
			t.Fatalf("row %d delivered %d times, want exactly once", seq, c)
		}
	}
	if len(count) != 20 {
		t.Fatalf("delivered %d distinct rows, want 20", len(count))
	}
}

// Backoff has to be bounded in both directions: no retry storm, and no row
// parked for hours after a consumer comes back.
func TestOutboxBackoffIsBounded(t *testing.T) {
	if got := outboxBackoff(0); got != time.Second {
		t.Fatalf("first retry should be 1s, got %v", got)
	}
	if got := outboxBackoff(3); got != 8*time.Second {
		t.Fatalf("fourth retry should be 8s, got %v", got)
	}
	for _, a := range []int{7, 20, 1000} {
		if got := outboxBackoff(a); got != time.Minute {
			t.Fatalf("attempt %d should cap at 1m, got %v", a, got)
		}
	}
}

// A nil relay is the no-store case, which is every local run today. Every
// method must be a safe no-op rather than a panic.
func TestNilRelayIsSafe(t *testing.T) {
	var r *OutboxRelay = NewOutboxRelay(nil)
	r.Handle(TopicLedgerBlock, func(OutboxRow) error { return nil })
	if n, err := r.RunOnce(context.Background()); n != 0 || err != nil {
		t.Fatalf("nil relay should do nothing, got %d %v", n, err)
	}
	r.Start(context.Background())
	r.Stop()
}
