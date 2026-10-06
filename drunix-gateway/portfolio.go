package drunix

// Cross-property portfolio tokens and dynamic ownership.
//
// Two gaps this closes.
//
// 1. A portfolio was only ever a VIEW. The app could add up what an investor
//    held across properties, but there was no instrument: nothing you could
//    hold, transfer or settle that represented a basket of properties as one
//    unit. This adds a real one. A basket unit is fully backed — to create one
//    unit the subscriber delivers the exact component tokens into custody, and
//    redeeming returns them. Nothing is minted out of thin air, so the
//    conservation checks that already guard the rail keep holding.
//
// 2. Ownership was a SNAPSHOT. The book says who holds what right now, which
//    silently rewards someone who buys the day before a rent payout as much as
//    someone who held all year. Dynamic ownership keeps the history of every
//    position change so a stake can be measured over a period, not just at an
//    instant.
//
// Both commit their state changes to the same hash-chained Drunix ledger as
// every other UMI operation.

import (
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"
)

var (
	// ErrBasketNotFound is returned for an unknown basket id.
	ErrBasketNotFound = errors.New("ERR_UMI_BASKET_NOT_FOUND")
	// ErrBasketExists guards against redefining a basket that already has units.
	ErrBasketExists = errors.New("ERR_UMI_BASKET_EXISTS")
	// ErrBasketComponents rejects a basket that is not a basket.
	ErrBasketComponents = errors.New("ERR_UMI_BASKET_COMPONENTS")
	// ErrBasketUnits rejects a non-positive unit count.
	ErrBasketUnits = errors.New("ERR_UMI_BASKET_UNITS")
	// ErrBasketInsufficientUnits is a redemption larger than the holding.
	ErrBasketInsufficientUnits = errors.New("ERR_UMI_BASKET_INSUFFICIENT_UNITS")
)

// Bases on which income can be split between holders.
const (
	// ServicingBasisSnapshot pays on the register as it stands right now.
	ServicingBasisSnapshot = "snapshot"
	// ServicingBasisTimeWeighted pays on token-days held across the period
	// the income accrued over.
	ServicingBasisTimeWeighted = "timeWeighted"
)

// BasketComponent is one property's contribution to a single basket unit.
type BasketComponent struct {
	AssetID string `json:"assetId"`
	// TokensPerUnit is how many property tokens back ONE basket unit. Integer
	// on purpose: a basket unit must be redeemable for a whole number of
	// tokens, or redemption cannot be exact.
	TokensPerUnit int64 `json:"tokensPerUnit"`
	// IndicativePriceINR values the component for NAV. Indicative because this
	// rail does not run a price oracle; it is the last agreed price, not a mark.
	IndicativePriceINR float64 `json:"indicativePriceINR"`
}

// Basket is a tradeable claim on a fixed recipe of property tokens.
type Basket struct {
	BasketID string `json:"basketId"`
	Name     string `json:"name"`
	// Custodian holds the component tokens that back every issued unit.
	Custodian        string            `json:"custodian"`
	Components       []BasketComponent `json:"components"`
	UnitsOutstanding int64             `json:"unitsOutstanding"`
	Units            map[string]int64  `json:"units"` // holder -> units
	CreatedAt        time.Time         `json:"createdAt"`
	ISIN             string            `json:"isin,omitempty"`
}

// NAVPerUnitINR values one unit from its recipe.
func (b *Basket) NAVPerUnitINR() float64 {
	var nav float64
	for _, c := range b.Components {
		nav += float64(c.TokensPerUnit) * c.IndicativePriceINR
	}
	return nav
}

// OwnershipEvent is one position of one holder at one instant. Appended, never
// edited — the series is what makes ownership measurable over time.
type OwnershipEvent struct {
	AssetID string    `json:"assetId"`
	Holder  string    `json:"holder"`
	Tokens  int64     `json:"tokens"` // position AFTER the change
	At      time.Time `json:"at"`
	Reason  string    `json:"reason"`
}

// OwnershipSlice is a holder's stake in an asset, now and over a window.
type OwnershipSlice struct {
	Holder string `json:"holder"`
	Tokens int64  `json:"tokens"`
	// PctNow is the stake at this instant.
	PctNow float64 `json:"pctNow"`
	// PctTimeWeighted is the average stake across the requested window. A
	// holder who bought yesterday scores far lower here than one who held
	// throughout, which is what makes an income split fair.
	PctTimeWeighted float64 `json:"pctTimeWeighted"`
	// TokenDays is the raw integral, exposed so a caller can audit the split.
	TokenDays float64 `json:"tokenDays"`
}

// ownershipLog is the append-only journal of position changes.
type ownershipLog struct {
	mu     sync.Mutex
	events []OwnershipEvent
}

func (l *ownershipLog) record(e OwnershipEvent) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.events = append(l.events, e)
}

func (l *ownershipLog) forAsset(assetID string) []OwnershipEvent {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]OwnershipEvent, 0, len(l.events))
	for _, e := range l.events {
		if e.AssetID == assetID {
			out = append(out, e)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].At.Before(out[j].At) })
	return out
}

// RecordOwnership notes a holder's position after it changed. Safe to call
// with the rail lock held; the journal keeps its own.
func (r *UMIRail) RecordOwnership(assetID, holder string, tokens int64, reason string) {
	if r.ownership == nil {
		r.ownership = &ownershipLog{}
	}
	r.ownership.record(OwnershipEvent{
		AssetID: assetID, Holder: holder, Tokens: tokens,
		At: time.Now().UTC(), Reason: reason,
	})
}

// OwnershipHistory returns the raw journal for an asset.
func (r *UMIRail) OwnershipHistory(assetID string) []OwnershipEvent {
	if r.ownership == nil {
		return nil
	}
	return r.ownership.forAsset(assetID)
}

// CapTable answers "who owns this, now and over the window [from, to]".
//
// The time-weighted figure integrates each holder's position over the window.
// Between two journal entries a position is constant, so the integral is a sum
// of rectangles; the final entry extends to the end of the window.
func (r *UMIRail) CapTable(assetID string, from, to time.Time) []OwnershipSlice {
	if to.IsZero() || to.After(time.Now().UTC()) {
		to = time.Now().UTC()
	}
	if from.IsZero() || !from.Before(to) {
		from = to.Add(-30 * 24 * time.Hour)
	}

	current := r.securities.Holders(assetID)
	var outstanding int64
	for _, v := range current {
		outstanding += v
	}

	events := r.OwnershipHistory(assetID)
	tokenDays := map[string]float64{}
	// running[holder] = position in force at the cursor
	running := map[string]int64{}
	cursor := from

	advance := func(until time.Time) {
		if !until.After(cursor) {
			return
		}
		days := until.Sub(cursor).Hours() / 24
		for h, tok := range running {
			if tok > 0 {
				tokenDays[h] += float64(tok) * days
			}
		}
		cursor = until
	}

	for _, e := range events {
		if e.At.Before(from) {
			// Before the window: only sets the opening position.
			running[e.Holder] = e.Tokens
			continue
		}
		if e.At.After(to) {
			break
		}
		advance(e.At)
		running[e.Holder] = e.Tokens
	}
	advance(to)

	windowDays := to.Sub(from).Hours() / 24
	var totalTokenDays float64
	for _, td := range tokenDays {
		totalTokenDays += td
	}

	holders := map[string]bool{}
	for h := range current {
		holders[h] = true
	}
	for h := range tokenDays {
		holders[h] = true
	}

	out := make([]OwnershipSlice, 0, len(holders))
	for h := range holders {
		s := OwnershipSlice{Holder: h, Tokens: current[h], TokenDays: tokenDays[h]}
		if outstanding > 0 {
			s.PctNow = round4(float64(current[h]) / float64(outstanding) * 100)
		}
		if totalTokenDays > 0 {
			s.PctTimeWeighted = round4(tokenDays[h] / totalTokenDays * 100)
		}
		out = append(out, s)
	}
	_ = windowDays
	sort.Slice(out, func(i, j int) bool {
		if out[i].Tokens != out[j].Tokens {
			return out[i].Tokens > out[j].Tokens
		}
		return out[i].Holder < out[j].Holder
	})
	return out
}

func round4(f float64) float64 {
	return float64(int64(f*10000+0.5)) / 10000
}

// --- baskets ---

// CreateBasket defines a basket. Defining it issues nothing; units only exist
// once somebody delivers the backing tokens through Subscribe.
func (r *UMIRail) CreateBasket(basketID, name, custodian string, components []BasketComponent) (*Basket, *DrunixBlock, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.baskets == nil {
		r.baskets = make(map[string]*Basket)
	}
	if basketID == "" {
		basketID = r.nextID("BASKET")
	}
	if existing, ok := r.baskets[basketID]; ok {
		// Redefining the recipe under issued units would break the backing.
		if existing.UnitsOutstanding > 0 {
			return nil, nil, ErrBasketExists
		}
	}
	// A basket of one property is just that property with extra steps.
	if len(components) < 2 {
		return nil, nil, ErrBasketComponents
	}
	seen := map[string]bool{}
	for _, c := range components {
		if c.AssetID == "" || c.TokensPerUnit <= 0 {
			return nil, nil, ErrBasketComponents
		}
		if seen[c.AssetID] {
			return nil, nil, ErrBasketComponents
		}
		seen[c.AssetID] = true
	}
	if custodian == "" {
		custodian = basketID + "-CUSTODY"
	}

	b := &Basket{
		BasketID: basketID, Name: name, Custodian: custodian,
		Components: components, Units: map[string]int64{},
		CreatedAt: time.Now().UTC(),
	}
	r.baskets[basketID] = b

	blk := r.append("UMI_BASKET_CREATED", map[string]interface{}{
		"basketId": b.BasketID, "name": b.Name, "custodian": b.Custodian,
		"components": b.Components, "navPerUnitINR": b.NAVPerUnitINR(),
	})
	return b, blk, nil
}

// Subscribe issues units against delivered component tokens.
//
// All-or-nothing: every component must be deliverable, or the whole
// subscription is undone. A partially backed unit is not a unit.
func (r *UMIRail) Subscribe(basketID, holder string, units int64) (*Basket, *DrunixBlock, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	b, ok := r.baskets[basketID]
	if !ok {
		return nil, nil, ErrBasketNotFound
	}
	if units <= 0 {
		return nil, nil, ErrBasketUnits
	}
	if holder == "" {
		return nil, nil, ErrBasketUnits
	}

	type moved struct {
		assetID string
		tokens  int64
	}
	done := make([]moved, 0, len(b.Components))
	rollback := func() {
		for _, m := range done {
			_ = r.securities.Move(m.assetID, b.Custodian, holder, m.tokens)
		}
	}

	delivered := make([]map[string]interface{}, 0, len(b.Components))
	for _, c := range b.Components {
		need := c.TokensPerUnit * units
		if err := r.securities.Move(c.AssetID, holder, b.Custodian, need); err != nil {
			rollback()
			return nil, nil, fmt.Errorf("%w: %s needs %d token(s)", ErrUMIInsufficientSecurities, c.AssetID, need)
		}
		done = append(done, moved{c.AssetID, need})
		delivered = append(delivered, map[string]interface{}{
			"assetId": c.AssetID, "tokens": need,
		})
	}

	b.Units[holder] += units
	b.UnitsOutstanding += units

	for _, c := range b.Components {
		r.RecordOwnership(c.AssetID, holder, r.securities.Position(c.AssetID, holder), "BASKET_SUBSCRIBE")
		r.RecordOwnership(c.AssetID, b.Custodian, r.securities.Position(c.AssetID, b.Custodian), "BASKET_SUBSCRIBE")
	}

	blk := r.append("UMI_BASKET_SUBSCRIBED", map[string]interface{}{
		"basketId": b.BasketID, "holder": holder, "units": units,
		"unitsOutstanding": b.UnitsOutstanding, "delivered": delivered,
		"navPerUnitINR": b.NAVPerUnitINR(), "custodian": b.Custodian,
	})
	return b, blk, nil
}

// Redeem burns units and returns the backing tokens to the holder.
func (r *UMIRail) Redeem(basketID, holder string, units int64) (*Basket, *DrunixBlock, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	b, ok := r.baskets[basketID]
	if !ok {
		return nil, nil, ErrBasketNotFound
	}
	if units <= 0 {
		return nil, nil, ErrBasketUnits
	}
	if b.Units[holder] < units {
		return nil, nil, ErrBasketInsufficientUnits
	}

	returned := make([]map[string]interface{}, 0, len(b.Components))
	for _, c := range b.Components {
		back := c.TokensPerUnit * units
		// Custody is only ever credited by Subscribe, so this cannot fail
		// unless the book was corrupted elsewhere — surface it rather than
		// silently burn the units.
		if err := r.securities.Move(c.AssetID, b.Custodian, holder, back); err != nil {
			return nil, nil, fmt.Errorf("custody short on %s: %w", c.AssetID, err)
		}
		returned = append(returned, map[string]interface{}{"assetId": c.AssetID, "tokens": back})
	}

	b.Units[holder] -= units
	if b.Units[holder] == 0 {
		delete(b.Units, holder)
	}
	b.UnitsOutstanding -= units

	for _, c := range b.Components {
		r.RecordOwnership(c.AssetID, holder, r.securities.Position(c.AssetID, holder), "BASKET_REDEEM")
		r.RecordOwnership(c.AssetID, b.Custodian, r.securities.Position(c.AssetID, b.Custodian), "BASKET_REDEEM")
	}

	blk := r.append("UMI_BASKET_REDEEMED", map[string]interface{}{
		"basketId": b.BasketID, "holder": holder, "units": units,
		"unitsOutstanding": b.UnitsOutstanding, "returned": returned,
		"navPerUnitINR": b.NAVPerUnitINR(),
	})
	return b, blk, nil
}

// BasketView is a basket plus the figures a caller would otherwise recompute.
type BasketView struct {
	*Basket
	NAVPerUnitINR float64                  `json:"navPerUnitINR"`
	NAVTotalINR   float64                  `json:"navTotalINR"`
	Backing       []map[string]interface{} `json:"backing"`
	FullyBacked   bool                     `json:"fullyBacked"`
}

// BasketByID returns one basket with its backing verified against the book.
func (r *UMIRail) BasketByID(basketID string) (*BasketView, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	b, ok := r.baskets[basketID]
	if !ok {
		return nil, ErrBasketNotFound
	}
	return r.basketViewLocked(b), nil
}

// basketViewLocked builds the view. Caller must hold r.mu.
func (r *UMIRail) basketViewLocked(b *Basket) *BasketView {
	backing := make([]map[string]interface{}, 0, len(b.Components))
	full := true
	for _, c := range b.Components {
		required := c.TokensPerUnit * b.UnitsOutstanding
		held := r.securities.Position(c.AssetID, b.Custodian)
		if held < required {
			full = false
		}
		backing = append(backing, map[string]interface{}{
			"assetId": c.AssetID, "tokensPerUnit": c.TokensPerUnit,
			"requiredInCustody": required, "heldInCustody": held,
			"sufficient": held >= required,
		})
	}
	nav := b.NAVPerUnitINR()
	return &BasketView{
		Basket: b, NAVPerUnitINR: nav,
		NAVTotalINR: nav * float64(b.UnitsOutstanding),
		Backing:     backing, FullyBacked: full,
	}
}

// Baskets lists every basket.
func (r *UMIRail) Baskets() []*BasketView {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]*BasketView, 0, len(r.baskets))
	for _, b := range r.baskets {
		out = append(out, r.basketViewLocked(b))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].BasketID < out[j].BasketID })
	return out
}

// BasketHoldings reports one participant's basket units across all baskets.
func (r *UMIRail) BasketHoldings(holder string) []map[string]interface{} {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := []map[string]interface{}{}
	for _, b := range r.baskets {
		if u := b.Units[holder]; u > 0 {
			out = append(out, map[string]interface{}{
				"basketId": b.BasketID, "name": b.Name, "units": u,
				"navPerUnitINR": b.NAVPerUnitINR(),
				"valueINR":      b.NAVPerUnitINR() * float64(u),
			})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i]["basketId"].(string) < out[j]["basketId"].(string)
	})
	return out
}

// --- making a basket unit actually tradeable ---
//
// Creating and redeeming units is not trading: it only lets a holder wrap and
// unwrap their own tokens. For a basket to be a tradeable instrument someone
// else has to be able to buy it, which means units must change hands against
// cash in one movement — the same delivery-versus-payment discipline the
// property leg already uses. Half a trade is worse than no trade.

var (
	// ErrBasketSelfTrade rejects a trade with yourself.
	ErrBasketSelfTrade = errors.New("ERR_UMI_BASKET_SELF_TRADE")
	// ErrBasketPrice rejects a non-positive price.
	ErrBasketPrice = errors.New("ERR_UMI_BASKET_PRICE")
)

// TransferUnits moves units between holders with no cash leg. This is a
// delivery instruction (a gift, a correction, a custody move) — for a sale,
// use SettleBasketDvP so the cash cannot go missing.
func (r *UMIRail) TransferUnits(basketID, from, to string, units int64) (*Basket, *DrunixBlock, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	b, ok := r.baskets[basketID]
	if !ok {
		return nil, nil, ErrBasketNotFound
	}
	if units <= 0 || from == "" || to == "" {
		return nil, nil, ErrBasketUnits
	}
	if from == to {
		return nil, nil, ErrBasketSelfTrade
	}
	if b.Units[from] < units {
		return nil, nil, ErrBasketInsufficientUnits
	}

	b.Units[from] -= units
	if b.Units[from] == 0 {
		delete(b.Units, from)
	}
	b.Units[to] += units

	blk := r.append("UMI_BASKET_TRANSFERRED", map[string]interface{}{
		"basketId": b.BasketID, "from": from, "to": to, "units": units,
		"navPerUnitINR": b.NAVPerUnitINR(),
	})
	return b, blk, nil
}

// BasketTrade is the outcome of a unit sale.
type BasketTrade struct {
	TradeID          string    `json:"tradeId"`
	BasketID         string    `json:"basketId"`
	Seller           string    `json:"seller"`
	Buyer            string    `json:"buyer"`
	Units            int64     `json:"units"`
	PricePerUnitINR  float64   `json:"pricePerUnitINR"`
	ConsiderationINR float64   `json:"considerationINR"`
	NAVPerUnitINR    float64   `json:"navPerUnitINR"`
	PremiumToNAVPct  float64   `json:"premiumToNavPct"`
	SellerUnitsLeft  int64     `json:"sellerUnitsLeft"`
	BuyerUnits       int64     `json:"buyerUnits"`
	BuyerCashINR     float64   `json:"buyerCashINR"`
	SellerCashINR    float64   `json:"sellerCashINR"`
	SettledAt        time.Time `json:"settledAt"`
	DryRun           bool      `json:"dryRun"`
	Mode             string    `json:"mode"`
}

// SettleBasketDvP sells units for e₹-W cash atomically.
//
// Either the buyer gets the units and the seller gets the cash, or nothing
// moves at all. dryRun answers "would this work" without committing, so a UI
// can warn before the investor commits rather than after.
func (r *UMIRail) SettleBasketDvP(basketID, seller, buyer string, units int64, pricePerUnitINR float64, dryRun bool) (*BasketTrade, *DrunixBlock, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	b, ok := r.baskets[basketID]
	if !ok {
		return nil, nil, ErrBasketNotFound
	}
	if units <= 0 || seller == "" || buyer == "" {
		return nil, nil, ErrBasketUnits
	}
	if seller == buyer {
		return nil, nil, ErrBasketSelfTrade
	}
	if pricePerUnitINR <= 0 {
		return nil, nil, ErrBasketPrice
	}
	if b.Units[seller] < units {
		return nil, nil, fmt.Errorf("%w: seller holds %d unit(s), not %d",
			ErrBasketInsufficientUnits, b.Units[seller], units)
	}

	cash := INRToPaise(pricePerUnitINR * float64(units))
	buyerWallet := r.walletLocked(buyer)
	if buyerWallet.available() < cash {
		return nil, nil, fmt.Errorf("%w: buyer e₹-W available ₹%.2f, trade needs ₹%.2f",
			ErrUMIInsufficientCBDC, paiseToINR(buyerWallet.available()), paiseToINR(cash))
	}
	sellerWallet := r.walletLocked(seller)

	nav := b.NAVPerUnitINR()
	trade := &BasketTrade{
		TradeID: r.nextID("UMIBSKT"), BasketID: b.BasketID,
		Seller: seller, Buyer: buyer, Units: units,
		PricePerUnitINR: pricePerUnitINR, ConsiderationINR: paiseToINR(cash),
		NAVPerUnitINR: nav, SettledAt: time.Now().UTC(), DryRun: dryRun, Mode: UMIMode,
	}
	if nav > 0 {
		trade.PremiumToNAVPct = round4((pricePerUnitINR - nav) / nav * 100)
	}

	if dryRun {
		// Report what would happen; touch nothing.
		trade.SellerUnitsLeft = b.Units[seller] - units
		trade.BuyerUnits = b.Units[buyer] + units
		trade.BuyerCashINR = paiseToINR(buyerWallet.BalancePaise - cash)
		trade.SellerCashINR = paiseToINR(sellerWallet.BalancePaise + cash)
		return trade, nil, nil
	}

	// Both legs, together.
	b.Units[seller] -= units
	if b.Units[seller] == 0 {
		delete(b.Units, seller)
	}
	b.Units[buyer] += units
	buyerWallet.BalancePaise -= cash
	sellerWallet.BalancePaise += cash
	buyerWallet.refresh()
	sellerWallet.refresh()

	trade.SellerUnitsLeft = b.Units[seller]
	trade.BuyerUnits = b.Units[buyer]
	trade.BuyerCashINR = buyerWallet.BalanceINR
	trade.SellerCashINR = sellerWallet.BalanceINR

	blk := r.append("UMI_BASKET_DVP_SETTLED", map[string]interface{}{
		"tradeId": trade.TradeID, "basketId": b.BasketID,
		"seller": seller, "buyer": buyer, "units": units,
		"pricePerUnitINR": pricePerUnitINR, "considerationINR": trade.ConsiderationINR,
		"navPerUnitINR": nav, "premiumToNavPct": trade.PremiumToNAVPct,
		"atomic": "units and e₹-W cash moved in one commit",
	})
	return trade, blk, nil
}
