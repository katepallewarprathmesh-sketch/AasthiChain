package drunix

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"
)

// The relay: step 2 of docs/EVENT-OUTBOX.md.
//
// It drains umi_outbox and hands each row to the consumer registered for its
// topic. Delivery is AT-LEAST-ONCE and deliberately so: the alternative is to
// mark a row delivered before the consumer has actually done the work, which
// turns a duplicate (harmless, every consumer is idempotent) into a loss (not
// harmless at all). A crash between "the consumer succeeded" and "the row is
// marked" redelivers, and the dedupe key absorbs it.
//
// Nothing here is on the settlement path. The relay runs in its own goroutine
// and a settlement never waits on it.

// OutboxRow is one pending row handed to a consumer.
type OutboxRow struct {
	Seq         int64
	BlockHeight int64
	Topic       string
	DedupeKey   string
	Payload     map[string]interface{}
	Attempts    int
}

// OutboxHandler delivers one row. Returning an error leaves the row pending
// for a later attempt, so a handler must be safe to call twice with the same
// row.
type OutboxHandler func(OutboxRow) error

// OutboxProcessor is the storage side of the relay.
//
// ProcessPending owns the transaction and calls dispatch inside it, rather
// than handing rows out and trusting the caller to mark them. That is what
// keeps FOR UPDATE SKIP LOCKED meaningful: the row stays locked for the whole
// attempt, so a second relay never picks up work already in flight.
type OutboxProcessor interface {
	ProcessPending(ctx context.Context, limit int, dispatch OutboxHandler) (int, error)
}

// OutboxRelay drains the outbox on an interval.
type OutboxRelay struct {
	store    OutboxProcessor
	interval time.Duration
	batch    int

	mu       sync.RWMutex
	handlers map[string]OutboxHandler

	stop chan struct{}
	done chan struct{}
}

// NewOutboxRelay builds a relay. A nil store yields a nil relay: with no
// durable store there is no outbox, and every call below is a safe no-op.
func NewOutboxRelay(store OutboxProcessor) *OutboxRelay {
	if store == nil {
		return nil
	}
	return &OutboxRelay{
		store:    store,
		interval: 2 * time.Second,
		batch:    100,
		handlers: map[string]OutboxHandler{},
		stop:     make(chan struct{}),
		done:     make(chan struct{}),
	}
}

// Handle registers the consumer for a topic. Registering twice replaces, which
// keeps wiring order from mattering.
func (r *OutboxRelay) Handle(topic string, fn OutboxHandler) {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.handlers[topic] = fn
}

// dispatch routes one row.
//
// An unregistered topic is an error, not a silent success. A row that nothing
// can deliver must stay pending and show up in the failed count — marking it
// delivered would quietly drop a settlement's consequence, which is the exact
// failure this whole mechanism exists to prevent.
func (r *OutboxRelay) dispatch(row OutboxRow) error {
	r.mu.RLock()
	fn, ok := r.handlers[row.Topic]
	r.mu.RUnlock()
	if !ok {
		return fmt.Errorf("no consumer registered for topic %q", row.Topic)
	}
	return fn(row)
}

// RunOnce drains up to one batch. Exposed separately from Start so tests can
// step the relay deterministically instead of sleeping on a ticker.
func (r *OutboxRelay) RunOnce(ctx context.Context) (int, error) {
	if r == nil {
		return 0, nil
	}
	return r.store.ProcessPending(ctx, r.batch, r.dispatch)
}

// Start runs the relay until the context is cancelled or Stop is called.
func (r *OutboxRelay) Start(ctx context.Context) {
	if r == nil {
		return
	}
	go func() {
		defer close(r.done)
		t := time.NewTicker(r.interval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-r.stop:
				return
			case <-t.C:
				if n, err := r.RunOnce(ctx); err != nil {
					log.Printf("outbox relay: %v", err)
				} else if n > 0 {
					log.Printf("outbox relay: delivered %d event(s)", n)
				}
			}
		}
	}()
}

// Stop halts the relay and waits for the loop to exit.
func (r *OutboxRelay) Stop() {
	if r == nil {
		return
	}
	close(r.stop)
	<-r.done
}

// outboxBackoff spaces out retries: 1s, 2s, 4s … capped at a minute. Capped
// rather than unbounded because a consumer that is down for an hour should
// still recover within a minute of coming back, not hours later.
func outboxBackoff(attempts int) time.Duration {
	if attempts < 0 {
		attempts = 0
	}
	if attempts > 6 {
		return time.Minute
	}
	if d := time.Second << attempts; d < time.Minute {
		return d
	}
	return time.Minute
}
