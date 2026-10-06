package drunix

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

// Secondary marketplace: holders selling to each other, rather than everyone
// buying from the originator.
//
// This is a thin book on top of the settlement rail. It owns no money and no
// tokens — an offer is an intention, and the only thing that moves value is
// the same atomic DvP every other trade uses. That matters: there is no path
// here that can transfer a token without the cash leg moving in the same
// instant, because this code cannot transfer tokens at all.
//
// Locking: the book keeps its own mutex and must never hold it while calling
// into the rail, which takes the rail lock in SettleDvP. Units are reserved
// before settlement and restored if it fails, so two buyers racing for the
// last tokens cannot both be filled.

var (
	// ErrOfferNotFound is an unknown or already-removed offer id.
	ErrOfferNotFound = errors.New("ERR_UMI_OFFER_NOT_FOUND")
	// ErrOfferClosed is an offer that is filled or cancelled.
	ErrOfferClosed = errors.New("ERR_UMI_OFFER_CLOSED")
	// ErrOfferNotSeller rejects cancelling somebody else's offer.
	ErrOfferNotSeller = errors.New("ERR_UMI_OFFER_NOT_SELLER")
	// ErrOfferSelfTrade rejects buying your own offer.
	ErrOfferSelfTrade = errors.New("ERR_UMI_OFFER_SELF_TRADE")
	// ErrOfferAmount rejects non-positive or over-sized quantities.
	ErrOfferAmount = errors.New("ERR_UMI_OFFER_AMOUNT")
	// ErrOfferOversold rejects listing more tokens than the seller holds
	// once their other open offers are counted.
	ErrOfferOversold = errors.New("ERR_UMI_OFFER_OVERSOLD")
)

// Offer statuses.
const (
	OfferOpen      = "OPEN"
	OfferFilled    = "FILLED"
	OfferCancelled = "CANCELLED"
)

// OfferFill records one execution against an offer.
type OfferFill struct {
	Buyer         string    `json:"buyer"`
	Tokens        int64     `json:"tokens"`
	CashINR       float64   `json:"cashINR"`
	InstructionID string    `json:"instructionId"`
	BlockHeight   int64     `json:"blockHeight"`
	At            time.Time `json:"at"`
}

// Offer is one holder's standing intention to sell.
type Offer struct {
	OfferID          string      `json:"offerId"`
	AssetID          string      `json:"assetId"`
	Seller           string      `json:"seller"`
	TokensTotal      int64       `json:"tokensTotal"`
	TokensRemaining  int64       `json:"tokensRemaining"`
	PricePerTokenINR float64     `json:"pricePerTokenINR"`
	Status           string      `json:"status"`
	CreatedAt        time.Time   `json:"createdAt"`
	Fills            []OfferFill `json:"fills"`
}

type offerBook struct {
	mu     sync.Mutex
	offers map[string]*Offer
	order  []string // ids, oldest first
	seq    uint64
}

func newOfferBook() *offerBook {
	return &offerBook{offers: map[string]*Offer{}}
}

func (b *offerBook) nextID() string {
	b.seq++
	return fmt.Sprintf("OFR-%06X", b.seq)
}

// committedLocked is how many tokens of an asset the seller has already
// promised in other open offers. Listing is checked against holdings minus
// this, so a holder cannot offer the same token twice.
func (b *offerBook) committedLocked(assetID, seller, exceptID string) int64 {
	var n int64
	for _, o := range b.offers {
		if o.OfferID == exceptID || o.Status != OfferOpen {
			continue
		}
		if o.AssetID == assetID && o.Seller == seller {
			n += o.TokensRemaining
		}
	}
	return n
}

// CreateOffer lists tokens for sale. It verifies the seller actually holds
// what they are offering, counting their other open offers.
func (r *UMIRail) CreateOffer(assetID, seller string, tokens int64, pricePerTokenINR float64) (*Offer, error) {
	assetID, seller = strings.TrimSpace(assetID), strings.TrimSpace(seller)
	if assetID == "" || seller == "" {
		return nil, ErrOfferAmount
	}
	if tokens <= 0 || pricePerTokenINR <= 0 {
		return nil, ErrOfferAmount
	}

	// Read the position through the rail (takes the rail lock) BEFORE the
	// book lock, never the other way around.
	held := r.PositionOf(assetID, seller)

	r.book.mu.Lock()
	defer r.book.mu.Unlock()
	if committed := r.book.committedLocked(assetID, seller, ""); held-committed < tokens {
		return nil, fmt.Errorf("%w: %s holds %d tokens of %s and has already offered %d",
			ErrOfferOversold, seller, held, assetID, committed)
	}

	o := &Offer{
		OfferID:          r.book.nextID(),
		AssetID:          assetID,
		Seller:           seller,
		TokensTotal:      tokens,
		TokensRemaining:  tokens,
		PricePerTokenINR: pricePerTokenINR,
		Status:           OfferOpen,
		CreatedAt:        time.Now().UTC(),
		Fills:            []OfferFill{},
	}
	r.book.offers[o.OfferID] = o
	r.book.order = append(r.book.order, o.OfferID)
	return o, nil
}

// Offers lists the book, newest first. Empty assetID means every asset, and
// openOnly hides filled and cancelled offers.
func (r *UMIRail) Offers(assetID string, openOnly bool) []*Offer {
	r.book.mu.Lock()
	defer r.book.mu.Unlock()
	out := []*Offer{}
	for _, id := range r.book.order {
		o := r.book.offers[id]
		if o == nil {
			continue
		}
		if assetID != "" && o.AssetID != assetID {
			continue
		}
		if openOnly && o.Status != OfferOpen {
			continue
		}
		cp := *cloneOffer(o)
		out = append(out, &cp)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out
}

func cloneOffer(o *Offer) *Offer {
	cp := *o
	cp.Fills = append([]OfferFill{}, o.Fills...)
	return &cp
}

// Offer returns one offer by id.
func (r *UMIRail) Offer(offerID string) (*Offer, error) {
	r.book.mu.Lock()
	defer r.book.mu.Unlock()
	o, ok := r.book.offers[offerID]
	if !ok {
		return nil, ErrOfferNotFound
	}
	return cloneOffer(o), nil
}

// CancelOffer withdraws an offer. Only its seller may do so.
func (r *UMIRail) CancelOffer(offerID, who string) (*Offer, error) {
	r.book.mu.Lock()
	defer r.book.mu.Unlock()
	o, ok := r.book.offers[offerID]
	if !ok {
		return nil, ErrOfferNotFound
	}
	if o.Seller != who {
		return nil, ErrOfferNotSeller
	}
	if o.Status != OfferOpen {
		return nil, ErrOfferClosed
	}
	o.Status = OfferCancelled
	return cloneOffer(o), nil
}

// TakeOffer buys against an offer. Settlement is the ordinary atomic DvP, so
// either the tokens and the cash both move or neither does; the book is only
// updated once the rail confirms.
func (r *UMIRail) TakeOffer(offerID, buyer string, tokens int64, dryRun bool) (*Offer, *SettlementInstruction, error) {
	buyer = strings.TrimSpace(buyer)
	if buyer == "" || tokens <= 0 {
		return nil, nil, ErrOfferAmount
	}

	// --- reserve under the book lock ---
	r.book.mu.Lock()
	o, ok := r.book.offers[offerID]
	if !ok {
		r.book.mu.Unlock()
		return nil, nil, ErrOfferNotFound
	}
	if o.Status != OfferOpen {
		r.book.mu.Unlock()
		return nil, nil, ErrOfferClosed
	}
	if o.Seller == buyer {
		r.book.mu.Unlock()
		return nil, nil, ErrOfferSelfTrade
	}
	if tokens > o.TokensRemaining {
		r.book.mu.Unlock()
		return nil, nil, fmt.Errorf("%w: offer has %d tokens left, asked for %d",
			ErrOfferAmount, o.TokensRemaining, tokens)
	}
	// Hold the units so a second buyer racing for the same tail cannot also
	// be filled. Restored below if settlement fails or this is a dry run.
	o.TokensRemaining -= tokens
	seller, assetID, price := o.Seller, o.AssetID, o.PricePerTokenINR
	r.book.mu.Unlock()

	restore := func() {
		r.book.mu.Lock()
		if cur, ok := r.book.offers[offerID]; ok {
			cur.TokensRemaining += tokens
			if cur.Status == OfferFilled {
				cur.Status = OfferOpen
			}
		}
		r.book.mu.Unlock()
	}

	si, err := r.SettleDvP(DvPRequest{
		AssetID:          assetID,
		Seller:           seller,
		Buyer:            buyer,
		Tokens:           tokens,
		PricePerTokenINR: price,
		DryRun:           dryRun,
		AutoAssignISIN:   true,
	})
	if err != nil || dryRun {
		// A dry run must leave the book exactly as it found it.
		restore()
		if err != nil {
			return nil, si, err
		}
		cur, _ := r.Offer(offerID)
		return cur, si, nil
	}

	// --- commit the fill ---
	r.book.mu.Lock()
	defer r.book.mu.Unlock()
	cur := r.book.offers[offerID]
	if cur == nil {
		return nil, si, ErrOfferNotFound
	}
	cur.Fills = append(cur.Fills, OfferFill{
		Buyer: buyer, Tokens: tokens, CashINR: si.CashINR,
		InstructionID: si.InstructionID, BlockHeight: si.BlockHeight, At: time.Now().UTC(),
	})
	if cur.TokensRemaining == 0 {
		cur.Status = OfferFilled
	}
	return cloneOffer(cur), si, nil
}

// MarketDepth summarises the open book for an asset.
func (r *UMIRail) MarketDepth(assetID string) map[string]interface{} {
	offers := r.Offers(assetID, true)
	var tokens int64
	best := 0.0
	for _, o := range offers {
		tokens += o.TokensRemaining
		if best == 0 || o.PricePerTokenINR < best {
			best = o.PricePerTokenINR
		}
	}
	return map[string]interface{}{
		"assetId":         assetID,
		"openOffers":      len(offers),
		"tokensForSale":   tokens,
		"bestPriceINR":    best,
		"disclaimer":      "Secondary trading simulation. Offers settle through the same atomic DvP as every other trade.",
		"settlementModel": "delivery-versus-payment, both legs or neither",
	}
}
