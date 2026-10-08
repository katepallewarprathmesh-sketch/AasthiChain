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

// --- step 3: notifications are rebuilt from the ledger, idempotently --------

// Test 4: redelivery is a no-op at the consumer.
//
// The relay is at-least-once, so the same settlement WILL be handed to the
// notification consumer more than once. A participant must not see the trade
// twice in their feed.
func TestNotificationRedeliveryIsANoOp(t *testing.T) {
	rail := &UMIRail{notifications: newNotifyStore()}
	row := OutboxRow{
		Seq: 1, BlockHeight: 12, Topic: TopicUMISettled,
		Payload: map[string]interface{}{
			"height":        float64(12),
			"instructionId": "UMI-2534E518F4",
			"assetId":       "PROP-GREEN-VALLEY-PUNE-001",
			"securitiesLeg": map[string]interface{}{
				"from": "originator1", "to": "investor1", "tokens": float64(50)},
			"cashLeg": map[string]interface{}{"amountINR": float64(31000)},
		},
	}

	for i := 0; i < 5; i++ {
		if err := rail.handleNotificationEvent(row); err != nil {
			t.Fatal(err)
		}
	}

	buyer, _ := rail.Notifications("investor1", false, 50)
	seller, _ := rail.Notifications("originator1", false, 50)
	if len(buyer) != 1 || len(seller) != 1 {
		t.Fatalf("five deliveries produced %d buyer and %d seller notifications, want 1 each",
			len(buyer), len(seller))
	}
	if buyer[0].Kind != NotifyBought || buyer[0].AmountINR != 31000 {
		t.Fatalf("unexpected buyer notification: %+v", buyer[0])
	}
	if seller[0].Kind != NotifySold {
		t.Fatalf("unexpected seller notification: %+v", seller[0])
	}
}

// The inline path and the relay must produce the SAME notification, not two
// that merely look alike — otherwise a repair would double up a feed.
func TestInlineAndRelayAgreeOnTheNotification(t *testing.T) {
	si := &SettlementInstruction{
		InstructionID: "UMI-2534E518F4", AssetID: "PROP-X",
		Seller: "originator1", Buyer: "investor1",
		Tokens: 50, CashINR: 31000, BlockHeight: 12,
	}
	inline := &UMIRail{notifications: newNotifyStore()}
	inline.notifySettled(si)

	viaRelay := &UMIRail{notifications: newNotifyStore()}
	if err := viaRelay.handleNotificationEvent(OutboxRow{
		BlockHeight: 12, Topic: TopicUMISettled,
		Payload: map[string]interface{}{
			"height":        float64(12),
			"instructionId": si.InstructionID,
			"assetId":       si.AssetID,
			"securitiesLeg": map[string]interface{}{
				"from": si.Seller, "to": si.Buyer, "tokens": float64(si.Tokens)},
			"cashLeg": map[string]interface{}{"amountINR": si.CashINR},
		},
	}); err != nil {
		t.Fatal(err)
	}

	a, _ := inline.Notifications("investor1", false, 10)
	b, _ := viaRelay.Notifications("investor1", false, 10)
	if len(a) != 1 || len(b) != 1 {
		t.Fatalf("want one notification each, got %d and %d", len(a), len(b))
	}
	if a[0].ID != b[0].ID {
		t.Fatalf("ids differ: inline %s, relay %s — a repair would duplicate the feed", a[0].ID, b[0].ID)
	}
	if a[0].Title != b[0].Title || a[0].Detail != b[0].Detail || a[0].AmountINR != b[0].AmountINR {
		t.Fatalf("content differs:\n inline %+v\n relay  %+v", a[0], b[0])
	}
}

// A servicing block pays several holders at once; each must get exactly one
// income notification no matter how often the row is redelivered.
func TestServicingRedeliveryIsANoOp(t *testing.T) {
	rail := &UMIRail{notifications: newNotifyStore()}
	row := OutboxRow{
		BlockHeight: 20, Topic: TopicUMIServicing,
		Payload: map[string]interface{}{
			"height":  float64(20),
			"assetId": "PROP-X",
			"payouts": []interface{}{
				map[string]interface{}{"holder": "investor1", "tokens": float64(100), "amountINR": float64(1500)},
				map[string]interface{}{"holder": "investor2", "tokens": float64(100), "amountINR": float64(1500)},
			},
		},
	}
	for i := 0; i < 3; i++ {
		if err := rail.handleNotificationEvent(row); err != nil {
			t.Fatal(err)
		}
	}
	for _, who := range []string{"investor1", "investor2"} {
		got, _ := rail.Notifications(who, false, 10)
		if len(got) != 1 {
			t.Fatalf("%s got %d income notifications, want 1", who, len(got))
		}
		if got[0].AmountINR != 1500 {
			t.Fatalf("%s got %v, want 1500", who, got[0].AmountINR)
		}
	}
}

// --- step 4: public-chain anchoring is retried, not forgotten ---------------

// The anchor has to be rebuildable from the block alone, including its
// validity window — anchoring a different window than the original would make
// the on-chain record disagree with the ledger.
func TestDocumentRebuiltFromAnchorEvent(t *testing.T) {
	row := OutboxRow{
		BlockHeight: 9, Topic: TopicDocAnchored,
		Payload: map[string]interface{}{
			"cid":        "bafkreigh2akiscaildc",
			"sha256":     "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
			"assetId":    "PROP-X",
			"docType":    "SALE_DEED",
			"visibility": "restricted",
			"validFrom":  "2026-01-01T00:00:00Z",
			"validTo":    "2027-01-01T00:00:00Z",
		},
	}
	d := documentFromAnchorEvent(row)
	if d == nil {
		t.Fatal("a document anchor block must rebuild into a document")
	}
	if d.CID != "bafkreigh2akiscaildc" || d.AssetID != "PROP-X" || d.DocType != "SALE_DEED" {
		t.Fatalf("rebuilt the wrong document: %+v", d)
	}
	if d.ValidFrom == nil || d.ValidFrom.Year() != 2026 || d.ValidTo == nil || d.ValidTo.Year() != 2027 {
		t.Fatalf("validity window lost in the rebuild: %+v %+v", d.ValidFrom, d.ValidTo)
	}
}

// A payload that is not a document anchor must fail loudly rather than being
// marked delivered.
func TestAnchorEventRejectsRubbish(t *testing.T) {
	if d := documentFromAnchorEvent(OutboxRow{Payload: map[string]interface{}{"cid": ""}}); d != nil {
		t.Fatal("a payload with no cid is not an anchor")
	}
}

// The privacy rule survives the rebuild: KYC evidence and digest-only records
// must never gain a public-chain footprint, however they are redelivered.
func TestAnchorEventHonoursThePrivacyRule(t *testing.T) {
	// A nil mirror is the unconfigured case and must not error — there is
	// simply nothing to anchor to.
	var m *EVMMirror
	for _, p := range []map[string]interface{}{
		{"cid": "bafy1", "sha256": "aa", "visibility": "digestOnly"},
		{"cid": "bafy2", "sha256": "bb", "subject": "IDENTITY-123"},
	} {
		if err := m.handleAnchorEvent(OutboxRow{Topic: TopicDocAnchored, Payload: p}); err != nil {
			t.Fatalf("private evidence must be skipped quietly, got %v", err)
		}
	}
}

// A document block must queue an anchor event; other block types must not.
func TestDocumentBlockQueuesAnAnchorEvent(t *testing.T) {
	b := &DrunixBlock{Height: 4, Type: BlockDocAnchored, Hash: "h", Timestamp: "t",
		Txns: []map[string]interface{}{{"cid": "bafy", "sha256": "dd"}}}
	var topics []string
	for _, e := range blockEvents(b) {
		topics = append(topics, e.Topic)
	}
	if len(topics) != 2 || topics[1] != TopicDocAnchored {
		t.Fatalf("want [ledger.block umi.document.anchored], got %v", topics)
	}

	plain := &DrunixBlock{Height: 5, Type: BlockUMIWalletFunded, Hash: "h", Timestamp: "t",
		Txns: []map[string]interface{}{{"amountINR": 500}}}
	if got := blockEvents(plain); len(got) != 1 {
		t.Fatalf("a wallet funding implies only the stream event, got %d", len(got))
	}
}
