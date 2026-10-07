package drunix

import (
	"fmt"
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

func (s *notifyStore) add(n *Notification) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.seq++
	n.ID = fmt.Sprintf("NTF-%08X", s.seq)
	n.At = time.Now().UTC()
	list := append(s.byID[n.Participant], n)
	if len(list) > maxPerParticipant {
		list = list[len(list)-maxPerParticipant:]
	}
	s.byID[n.Participant] = list
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
func (r *UMIRail) notify(n *Notification) {
	if r == nil || r.notifications == nil || strings.TrimSpace(n.Participant) == "" {
		return
	}
	r.notifications.add(n)
}

// notifySettled reports a completed trade to both sides.
func (r *UMIRail) notifySettled(si *SettlementInstruction) {
	if si == nil {
		return
	}
	r.notify(&Notification{
		Participant: si.Buyer, Kind: NotifyBought,
		Title:   fmt.Sprintf("You bought %d tokens of %s", si.Tokens, si.AssetID),
		Detail:  fmt.Sprintf("₹%.2f left your e₹-W wallet and the tokens arrived in the same instant.", si.CashINR),
		AssetID: si.AssetID, AmountINR: si.CashINR,
		Reference: si.InstructionID, BlockHeight: si.BlockHeight,
	})
	r.notify(&Notification{
		Participant: si.Seller, Kind: NotifySold,
		Title:   fmt.Sprintf("You sold %d tokens of %s", si.Tokens, si.AssetID),
		Detail:  fmt.Sprintf("₹%.2f was credited to your e₹-W wallet as the tokens transferred.", si.CashINR),
		AssetID: si.AssetID, AmountINR: si.CashINR,
		Reference: si.InstructionID, BlockHeight: si.BlockHeight,
	})
}

// notifyFailed tells the buyer why nothing happened, and what would fix it.
func (r *UMIRail) notifyFailed(si *SettlementInstruction) {
	if si == nil {
		return
	}
	detail := "Neither the tokens nor the money moved."
	if si.ShortfallINR > 0 {
		detail = fmt.Sprintf("Your e₹-W wallet was short by ₹%.2f, so neither the tokens nor the money moved. Top up and try again.",
			si.ShortfallINR)
	}
	r.notify(&Notification{
		Participant: si.Buyer, Kind: NotifySettleFailed,
		Title:  fmt.Sprintf("Purchase of %d tokens of %s did not go through", si.Tokens, si.AssetID),
		Detail: detail, AssetID: si.AssetID, AmountINR: si.ShortfallINR,
		Reference: si.InstructionID, BlockHeight: si.BlockHeight,
	})
}

// notifyIncome reports rent or coupon reaching a holder's wallet.
func (r *UMIRail) notifyIncome(assetID string, payouts []ServicingPayout, blockHeight int64) {
	for _, p := range payouts {
		r.notify(&Notification{
			Participant: p.Holder, Kind: NotifyIncome,
			Title:   fmt.Sprintf("₹%.2f income from %s", p.AmountINR, assetID),
			Detail:  fmt.Sprintf("Paid straight into your e₹-W wallet for the %d tokens you hold.", p.Tokens),
			AssetID: assetID, AmountINR: p.AmountINR, BlockHeight: blockHeight,
		})
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
