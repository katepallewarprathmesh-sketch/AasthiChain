package drunix

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"
)

// Per-participant notifications.
//
// The rule here is that a notification is a *report of something that already
// happened on the ledger*, never a promise that something will. Each one is
// raised after the block is committed, carries the instruction or block that
// backs it, and is worded for the person receiving it rather than for an
// operator reading logs.
//
// Delivery is deliberately pull-based: the client asks for its own list. The
// live stream from events.go tells a browser *when* to look; this is what it
// finds. That keeps a missed connection from losing a notification, which is
// exactly the failure a push-only design has.

// Notification kinds.
const (
	NotifyBought       = "BOUGHT"
	NotifySold         = "SOLD"
	NotifySettleFailed = "SETTLEMENT_FAILED"
	NotifyIncome       = "INCOME"
	NotifyOfferFilled  = "OFFER_FILLED"
)

// Notification is one thing that happened to one participant.
type Notification struct {
	ID          string    `json:"id"`
	Participant string    `json:"participant"`
	Kind        string    `json:"kind"`
	Title       string    `json:"title"`
	Detail      string    `json:"detail"`
	AssetID     string    `json:"assetId,omitempty"`
	AmountINR   float64   `json:"amountINR,omitempty"`
	Reference   string    `json:"reference,omitempty"` // instruction id, where there is one
	BlockHeight int64     `json:"blockHeight,omitempty"`
	Read        bool      `json:"read"`
	At          time.Time `json:"at"`
}

// maxPerParticipant caps the history kept for one participant. This is a
// notification feed, not an audit trail — the ledger is the audit trail, and
// an unbounded in-memory list is just a slow leak.
const maxPerParticipant = 200

type notifyStore struct {
	mu   sync.Mutex
	byID map[string][]*Notification // participant -> newest last
	seq  uint64
}

func newNotifyStore() *notifyStore {
	return &notifyStore{byID: map[string][]*Notification{}}
}

// notificationID derives the id from the fact being reported, never from a
// counter or the clock.
//
// This is what makes the outbox safe: the relay guarantees at-least-once, so
// the same settlement can be delivered twice, and the consumer has to be able
// to recognise the second one as the same notification. A sequence number
// cannot do that — it would produce a second, identical-looking entry in the
// participant's feed every time a redelivery happened.
func notificationID(n *Notification) string {
	sum := sha256.Sum256([]byte(strings.Join([]string{
		n.Kind, n.Participant, n.AssetID, n.Reference, fmt.Sprint(n.BlockHeight),
	}, "|")))
	return "NTF-" + strings.ToUpper(hex.EncodeToString(sum[:6]))
}

// add files a notification, ignoring one that is already there.
//
// Returns true when something new was stored, so a caller (the outbox relay)
// can tell a repair from a no-op.
func (s *notifyStore) add(n *Notification) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	n.ID = notificationID(n)
	for _, existing := range s.byID[n.Participant] {
		if existing.ID == n.ID {
			return false // already reported; a redelivery must not duplicate it
		}
	}
	s.seq++
	n.At = time.Now().UTC()
	list := append(s.byID[n.Participant], n)
	if len(list) > maxPerParticipant {
		list = list[len(list)-maxPerParticipant:]
	}
	s.byID[n.Participant] = list
	return true
}

// list returns a participant's notifications newest first.
func (s *notifyStore) list(participant string, unreadOnly bool, limit int) ([]Notification, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	src := s.byID[participant]
	out := make([]Notification, 0, len(src))
	unread := 0
	for i := len(src) - 1; i >= 0; i-- {
		n := src[i]
		if !n.Read {
			unread++
		}
		if unreadOnly && n.Read {
			continue
		}
		if limit <= 0 || len(out) < limit {
			out = append(out, *n)
		}
	}
	return out, unread
}

func (s *notifyStore) markRead(participant, id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, n := range s.byID[participant] {
		if n.ID == id {
			n.Read = true
			return true
		}
	}
	return false
}

func (s *notifyStore) markAllRead(participant string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for _, x := range s.byID[participant] {
		if !x.Read {
			x.Read = true
			n++
		}
	}
	return n
}

// notify raises one notification. Callers must NOT hold the rail lock: the
// store has its own, and keeping the two independent is what stops a
// notification from ever delaying a settlement.
func (r *UMIRail) notify(n *Notification) bool {
	if r == nil || r.notifications == nil || strings.TrimSpace(n.Participant) == "" {
		return false
	}
	return r.notifications.add(n)
}

// --- builders -----------------------------------------------------------
//
// Every notification is built by one of these and nothing else. The inline
// path (straight after a settlement) and the outbox relay (repairing one that
// never got filed) both call them with the same facts, so the two paths cannot
// drift into producing different text — or worse, different ids — for the same
// event.

func boughtNotification(buyer, assetID string, tokens int64, cashINR float64, ref string, height int64) *Notification {
	return &Notification{
		Participant: buyer, Kind: NotifyBought,
		Title:   fmt.Sprintf("You bought %d tokens of %s", tokens, assetID),
		Detail:  fmt.Sprintf("₹%.2f left your e₹-W wallet and the tokens arrived in the same instant.", cashINR),
		AssetID: assetID, AmountINR: cashINR,
		Reference: ref, BlockHeight: height,
	}
}

func soldNotification(seller, assetID string, tokens int64, cashINR float64, ref string, height int64) *Notification {
	return &Notification{
		Participant: seller, Kind: NotifySold,
		Title:   fmt.Sprintf("You sold %d tokens of %s", tokens, assetID),
		Detail:  fmt.Sprintf("₹%.2f was credited to your e₹-W wallet as the tokens transferred.", cashINR),
		AssetID: assetID, AmountINR: cashINR,
		Reference: ref, BlockHeight: height,
	}
}

func failedNotification(buyer, assetID string, tokens int64, shortfallINR float64, ref string, height int64) *Notification {
	detail := "Neither the tokens nor the money moved."
	if shortfallINR > 0 {
		detail = fmt.Sprintf("Your e₹-W wallet was short by ₹%.2f, so neither the tokens nor the money moved. Top up and try again.",
			shortfallINR)
	}
	return &Notification{
		Participant: buyer, Kind: NotifySettleFailed,
		Title:  fmt.Sprintf("Purchase of %d tokens of %s did not go through", tokens, assetID),
		Detail: detail, AssetID: assetID, AmountINR: shortfallINR,
		Reference: ref, BlockHeight: height,
	}
}

func incomeNotification(holder, assetID string, tokens int64, amountINR float64, height int64) *Notification {
	return &Notification{
		Participant: holder, Kind: NotifyIncome,
		Title:   fmt.Sprintf("₹%.2f income from %s", amountINR, assetID),
		Detail:  fmt.Sprintf("Paid straight into your e₹-W wallet for the %d tokens you hold.", tokens),
		AssetID: assetID, AmountINR: amountINR, BlockHeight: height,
	}
}

// notifySettled reports a completed trade to both sides.
func (r *UMIRail) notifySettled(si *SettlementInstruction) {
	if si == nil {
		return
	}
	r.notify(boughtNotification(si.Buyer, si.AssetID, si.Tokens, si.CashINR, si.InstructionID, si.BlockHeight))
	r.notify(soldNotification(si.Seller, si.AssetID, si.Tokens, si.CashINR, si.InstructionID, si.BlockHeight))
}

// notifyFailed tells the buyer why nothing happened, and what would fix it.
func (r *UMIRail) notifyFailed(si *SettlementInstruction) {
	if si == nil {
		return
	}
	r.notify(failedNotification(si.Buyer, si.AssetID, si.Tokens, si.ShortfallINR, si.InstructionID, si.BlockHeight))
}

// notifyIncome reports rent or coupon reaching a holder's wallet.
func (r *UMIRail) notifyIncome(assetID string, payouts []ServicingPayout, blockHeight int64) {
	for _, p := range payouts {
		r.notify(incomeNotification(p.Holder, assetID, p.Tokens, p.AmountINR, blockHeight))
	}
}

// Notifications reads one participant's feed.
func (r *UMIRail) Notifications(participant string, unreadOnly bool, limit int) ([]Notification, int) {
	if r.notifications == nil {
		return []Notification{}, 0
	}
	return r.notifications.list(participant, unreadOnly, limit)
}

// MarkNotificationRead marks one as read.
func (r *UMIRail) MarkNotificationRead(participant, id string) bool {
	if r.notifications == nil {
		return false
	}
	return r.notifications.markRead(participant, id)
}

// MarkAllNotificationsRead clears a participant's unread count.
func (r *UMIRail) MarkAllNotificationsRead(participant string) int {
	if r.notifications == nil {
		return 0
	}
	return r.notifications.markAllRead(participant)
}

// --- outbox consumers -------------------------------------------------------

// notificationsFromEvent rebuilds the notifications a settlement, failure or
// servicing payout implies, from the outbox payload alone.
//
// The payload is a copy of the block's transaction, so this is a pure function
// of committed ledger facts — the same property the document bodies rely on.
// Nothing here reads rail state, which is why it still produces the right
// answer when it runs minutes later in a fresh process.
func notificationsFromEvent(row OutboxRow) []*Notification {
	p := row.Payload
	str := func(k string) string { v, _ := p[k].(string); return v }
	num := func(k string) float64 { v, _ := p[k].(float64); return v }
	height := int64(num("height"))
	if height == 0 {
		height = row.BlockHeight
	}

	switch row.Topic {
	case TopicUMISettled:
		sec, _ := p["securitiesLeg"].(map[string]interface{})
		cash, _ := p["cashLeg"].(map[string]interface{})
		if sec == nil || cash == nil {
			return nil
		}
		seller, _ := sec["from"].(string)
		buyer, _ := sec["to"].(string)
		tokens, _ := sec["tokens"].(float64)
		amount, _ := cash["amountINR"].(float64)
		ref, asset := str("instructionId"), str("assetId")
		return []*Notification{
			boughtNotification(buyer, asset, int64(tokens), amount, ref, height),
			soldNotification(seller, asset, int64(tokens), amount, ref, height),
		}

	case TopicUMIFailed:
		return []*Notification{failedNotification(
			str("buyer"), str("assetId"), int64(num("tokens")),
			num("shortfallINR"), str("instructionId"), height)}

	case TopicUMIServicing:
		payouts, _ := p["payouts"].([]interface{})
		asset := str("assetId")
		out := make([]*Notification, 0, len(payouts))
		for _, raw := range payouts {
			po, _ := raw.(map[string]interface{})
			if po == nil {
				continue
			}
			holder, _ := po["holder"].(string)
			tokens, _ := po["tokens"].(float64)
			amount, _ := po["amountINR"].(float64)
			out = append(out, incomeNotification(holder, asset, int64(tokens), amount, height))
		}
		return out
	}
	return nil
}

// handleNotificationEvent is the relay consumer. It is a repair, not the
// primary path: the inline notify already ran at settlement time, so in the
// normal case every notification here is a duplicate and add() returns false.
// The case it exists for is the abnormal one — the process died between
// committing the block and filing the notification.
func (r *UMIRail) handleNotificationEvent(row OutboxRow) error {
	if r == nil {
		return fmt.Errorf("no rail wired for topic %q", row.Topic)
	}
	for _, n := range notificationsFromEvent(row) {
		if r.notify(n) {
			log.Printf("outbox: filed a notification that was lost before it reached %s (block %d)",
				n.Participant, n.BlockHeight)
		}
	}
	return nil
}
