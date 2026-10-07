package drunix

// UMI rail — RBI Unified Market Interface settlement pattern, in Go.
//
// Context (SEBI + RBI, Global Fintech Fest, 10 Sep 2026): "Demat 2.0" issues a
// corporate bond as a NATIVE TOKEN on a permissioned DLT owned by the
// depositories, and settles the CASH leg in RBI WHOLESALE CBDC (e₹-W) through
// the RBI's Unified Market Interface (UMI). The result is atomic DvP — the
// asset and the money move as one linked transaction — plus programmable asset
// servicing (coupon/redemption straight into holders' CBDC wallets).
//
// AasthiChain already owns both ends of that sandwich: Drunix property-fraction
// tokens (securities leg) and UPI/PayU (retail money leg). This file adds the
// middle: a central-bank-money settlement interface.
//
// SCOPE / HONESTY: this is a PATTERN SIMULATION. There is no public UMI API;
// participation runs through the SEBI Regulatory Sandbox. Every response from
// this rail is stamped mode=simulation. We never claim RBI connectivity.
//
// Design notes:
//   - cash is int64 PAISE, never float: central-bank money must conserve exactly
//   - the securities leg is reached through the SecuritiesLedger interface (DIP),
//     so the same engine drives the demo positions today and live chaincode later
//   - settlement is lock-both-legs-then-commit under one mutex: there is no
//     observable state where one leg moved and the other did not
//   - every outcome (including failures) commits a block to the existing
//     hash-chained Drunix ledger, so /api/chain/verify proves the rail too
//
// Nothing in this file modifies existing behaviour; it is additive.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"sort"
	"strings"
	"sync"
	"time"
)

// ---------- constants ----------

const (
	// UMIMode marks every payload as a pattern simulation, never a live RBI link.
	UMIMode = "simulation"
	// UMIDisclaimer is returned with every UMI response.
	UMIDisclaimer = "Pattern simulation of RBI's Unified Market Interface (UMI) / SEBI Demat 2.0 atomic DvP in wholesale CBDC. No RBI or depository connectivity; sandbox-shaped demo only."
	// UMIContract is the settlement contract name written into blocks.
	UMIContract = "aasthi.umi-dvp-v1"
	// UMISettlementBank is the notional e₹-W issuing/settlement counterparty.
	UMISettlementBank = "RBI e₹-W (wholesale) — sandbox settlement account"

	// Settlement instruction states.
	UMIStatusReceived = "RECEIVED"
	UMIStatusMatched  = "MATCHED"
	UMIStatusLocked   = "LOCKED"
	UMIStatusSettled  = "SETTLED"
	UMIStatusFailed   = "FAILED"

	// Block types appended to the Drunix chain (all new).
	BlockUMIWalletFunded  = "UMI_WALLET_FUNDED"
	BlockUMIISINAssigned  = "UMI_ISIN_ASSIGNED"
	BlockUMIDvPSettled    = "UMI_DVP_SETTLED"
	BlockUMIDvPFailed     = "UMI_DVP_FAILED"
	BlockUMIServicingPaid = "UMI_SERVICING_PAID"
	// Basket (cross-property portfolio token) block types.
	BlockUMIBasketCreated     = "UMI_BASKET_CREATED"
	BlockUMIBasketSubscribed  = "UMI_BASKET_SUBSCRIBED"
	BlockUMIBasketRedeemed    = "UMI_BASKET_REDEEMED"
	BlockUMIBasketDvPSettled  = "UMI_BASKET_DVP_SETTLED"
	BlockUMIBasketTransferred = "UMI_BASKET_TRANSFERRED"
)

// Machine-readable failure reasons surfaced to the UI.
var (
	ErrUMINoWallet               = errors.New("ERR_UMI_NO_WALLET")
	ErrUMIInsufficientCBDC       = errors.New("ERR_UMI_INSUFFICIENT_CBDC")
	ErrUMISupplyExceeded         = errors.New("ERR_UMI_SUPPLY_EXCEEDED")
	ErrUMIInsufficientSecurities = errors.New("ERR_UMI_INSUFFICIENT_SECURITIES")
	ErrUMINotPilotEligible       = errors.New("ERR_UMI_NOT_PILOT_ELIGIBLE")
	ErrUMISelfSettlement         = errors.New("ERR_UMI_SELF_SETTLEMENT")
	ErrUMIInvalidAmount          = errors.New("ERR_UMI_INVALID_AMOUNT")
	ErrUMIInstructionNotFound    = errors.New("ERR_UMI_INSTRUCTION_NOT_FOUND")
	ErrUMINoHolders              = errors.New("ERR_UMI_NO_HOLDERS")
)

// ---------- securities leg (DIP boundary) ----------

// SecuritiesLedger is the asset side of DvP. The demo wires the in-memory
// position book below; production wires the Drunix chaincode token ledger
// (chaincode/token.go) without touching the settlement engine.
type SecuritiesLedger interface {
	// Position returns the holder's token count for an asset.
	Position(assetID, holder string) int64
	// Move transfers tokens. It must be atomic and return an error without
	// mutating anything if the seller is short.
	Move(assetID, from, to string, tokens int64) error
	// Holders returns every non-zero position for an asset.
	Holders(assetID string) map[string]int64
}

// MemorySecurities is a deterministic in-process position book implementing
// SecuritiesLedger — used by the gateway demo and the tests.
type MemorySecurities struct {
	mu   sync.Mutex
	book map[string]map[string]int64 // assetID -> holder -> tokens
}

// NewMemorySecurities creates an empty position book.
func NewMemorySecurities() *MemorySecurities {
	return &MemorySecurities{book: make(map[string]map[string]int64)}
}

// Credit adds tokens to a holder (seeding / mint parity for the demo).
func (m *MemorySecurities) Credit(assetID, holder string, tokens int64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.book[assetID] == nil {
		m.book[assetID] = make(map[string]int64)
	}
	m.book[assetID][holder] += tokens
}

// Set replaces a holder's position (used when restoring from the store).
func (m *MemorySecurities) Set(assetID, holder string, tokens int64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.book[assetID] == nil {
		m.book[assetID] = make(map[string]int64)
	}
	m.book[assetID][holder] = tokens
}

// Position implements SecuritiesLedger.
func (m *MemorySecurities) Position(assetID, holder string) int64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.book[assetID][holder]
}

// Holders implements SecuritiesLedger.
func (m *MemorySecurities) Holders(assetID string) map[string]int64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make(map[string]int64)
	for h, v := range m.book[assetID] {
		if v > 0 {
			out[h] = v
		}
	}
	return out
}

// Move implements SecuritiesLedger (all-or-nothing).
func (m *MemorySecurities) Move(assetID, from, to string, tokens int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if tokens <= 0 {
		return ErrUMIInvalidAmount
	}
	if m.book[assetID] == nil || m.book[assetID][from] < tokens {
		return ErrUMIInsufficientSecurities
	}
	m.book[assetID][from] -= tokens
	m.book[assetID][to] += tokens
	return nil
}

// ---------- cash leg: wholesale CBDC wallets ----------

// CBDCWallet is a participant's wholesale e₹ wallet. Balances are PAISE.
type CBDCWallet struct {
	WalletID      string `json:"walletId"`
	Participant   string `json:"participant"`
	Bank          string `json:"bank"`
	BalancePaise  int64  `json:"balancePaise"`
	ReservedPaise int64  `json:"reservedPaise"` // earmarked by in-flight instructions
	// Rev is a monotonic revision stamped under the rail's mutex. Persistence
	// happens after the mutex is released, so without it two concurrent
	// settlements on one wallet could write their snapshots out of order and
	// leave a stale balance in the database. Not part of the public JSON.
	Rev          int64     `json:"-"`
	BalanceINR   float64   `json:"balanceINR"`
	AvailableINR float64   `json:"availableINR"`
	OpenedAt     time.Time `json:"openedAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
}

func (w *CBDCWallet) available() int64 { return w.BalancePaise - w.ReservedPaise }

func (w *CBDCWallet) refresh() {
	w.BalanceINR = paiseToINR(w.BalancePaise)
	w.AvailableINR = paiseToINR(w.available())
	w.UpdatedAt = time.Now().UTC()
}

func paiseToINR(p int64) float64 { return float64(p) / 100.0 }

// INRToPaise converts rupees to paise with half-up rounding (no float drift).
func INRToPaise(inr float64) int64 {
	if inr >= 0 {
		return int64(inr*100 + 0.5)
	}
	return -int64(-inr*100 + 0.5)
}

// ---------- pilot ISIN register ----------

// PilotISIN is the Demat 2.0-style identifier flagged as part of the pilot.
// Same instrument, one identifier — the pilot flag does not split the asset.
type PilotISIN struct {
	AssetID    string    `json:"assetId"`
	ISIN       string    `json:"isin"`
	Issuer     string    `json:"issuer"`
	PilotFlag  bool      `json:"pilotFlag"`
	Depository string    `json:"depository"`
	AssignedAt time.Time `json:"assignedAt"`
}

func pilotISINFor(assetID string) string {
	sum := sha256.Sum256([]byte("aasthi-pilot-isin|" + assetID))
	return "AASTHI" + strings.ToUpper(hex.EncodeToString(sum[:])[:6])
}

// ---------- ISO 20022 message trace ----------

// UMIMessage is one leg of the regulator-grade audit trail. The families match
// what a real securities-settlement + central-bank-money rail emits.
type UMIMessage struct {
	Seq       int       `json:"seq"`
	Family    string    `json:"family"` // sese.023 | sese.024 | pacs.009 | sese.025 | camt.054 | camt.019
	Name      string    `json:"name"`
	Detail    string    `json:"detail"`
	Timestamp time.Time `json:"timestamp"`
}

var umiMessageNames = map[string]string{
	"sese.023": "SecuritiesSettlementTransactionInstruction",
	"sese.024": "SecuritiesSettlementTransactionStatusAdvice",
	"pacs.009": "FinancialInstitutionCreditTransfer (e₹-W cash leg)",
	"sese.025": "SecuritiesSettlementTransactionConfirmation",
	"camt.054": "BankToCustomerDebitCreditNotification",
	"camt.019": "ReturnBusinessDayInformation / reject advice",
}

// ---------- settlement instruction ----------

// SettlementInstruction is one atomic DvP across the two legs.
type SettlementInstruction struct {
	InstructionID    string  `json:"instructionId"`
	AssetID          string  `json:"assetId"`
	ISIN             string  `json:"isin"`
	Seller           string  `json:"seller"`
	Buyer            string  `json:"buyer"`
	Tokens           int64   `json:"tokens"`
	PricePerTokenINR float64 `json:"pricePerTokenINR"`
	CashPaise        int64   `json:"cashPaise"`
	CashINR          float64 `json:"cashINR"`
	Status           string  `json:"status"`
	FailureReason    string  `json:"failureReason,omitempty"`
	FailureDetail    string  `json:"failureDetail,omitempty"`
	// A short cash leg is the most common reason a settlement fails, and the
	// caller's next move is always "top up by exactly this much". Carrying the
	// figures as numbers saves every client from parsing them back out of the
	// prose in FailureDetail.
	ShortfallINR  float64      `json:"shortfallINR,omitempty"`
	AvailableINR  float64      `json:"availableINR,omitempty"`
	Atomic        string       `json:"atomic"`
	SecuritiesLeg string       `json:"securitiesLeg"`
	CashLeg       string       `json:"cashLeg"`
	BlockHeight   int64        `json:"blockHeight"`
	Rev           int64        `json:"-"` // monotonic persistence revision
	BlockHash     string       `json:"blockHash,omitempty"`
	Messages      []UMIMessage `json:"messages"`
	CreatedAt     time.Time    `json:"createdAt"`
	SettledAt     *time.Time   `json:"settledAt,omitempty"`
	DryRun        bool         `json:"dryRun"`
	Mode          string       `json:"mode"`
	Disclaimer    string       `json:"disclaimer"`
}

func (si *SettlementInstruction) msg(family, detail string) {
	si.Messages = append(si.Messages, UMIMessage{
		Seq:       len(si.Messages) + 1,
		Family:    family,
		Name:      umiMessageNames[family],
		Detail:    detail,
		Timestamp: time.Now().UTC(),
	})
}

// ---------- the rail ----------

// UMIRail is the settlement interface between the Drunix securities ledger and
// wholesale central-bank money. Safe for concurrent use.
type UMIRail struct {
	mu           sync.Mutex
	wallets      map[string]*CBDCWallet            // participant -> wallet
	isins        map[string]*PilotISIN             // assetID -> pilot ISIN
	instructions map[string]*SettlementInstruction // id -> instruction
	order        []string                          // instruction ids, oldest first
	seq          uint64

	baskets   map[string]*Basket // basketId -> cross-property portfolio token
	ownership *ownershipLog      // append-only journal of position changes

	securities   SecuritiesLedger
	chain        *DrunixChain
	store        UMIStore // durable mirror (nil = in-memory only, original behaviour)
	fundedPaise  int64    // lifetime sandbox funding in
	settledCount int64
	failedCount  int64
	rev          int64             // monotonic persistence revision (see nextRev)
	servicing    []ServicingRecord // per-holder income history, oldest first

	// authorised is the issued supply per asset: the maximum number of tokens
	// that may exist. Seeding cannot push outstanding above it, which is what
	// stops a property showing as 101% allocated. Derived on restore from the
	// restored outstanding, or set by the first seed / an explicit
	// authorisedTokens, whichever comes first.
	authorised map[string]int64

	// notifications is the per-participant feed (see notifications.go). It
	// keeps its own lock so raising one can never delay a settlement.
	notifications *notifyStore

	// book is the secondary marketplace order book (see marketplace.go). It
	// keeps its own lock and owns no value — offers settle through SettleDvP
	// like any other trade.
	book *offerBook

	// derived marks a cap that was inferred from restored positions rather
	// than declared at issuance. An inferred cap may be wrong - if the book
	// was inflated before caps existed, restore would bake the inflated
	// number in and the breach would vanish - so a derived cap can be
	// corrected once by an explicit declaration. A declared one cannot.
	derived map[string]bool
}

// ServicingRecord is one holder's share of one servicing run — the row an
// investor needs to answer "what rent/coupon have I actually been paid?".
// Kept per holder (the block only recorded a holder count, which no investor
// view can use) and mirrored to the store so it survives restarts.
type ServicingRecord struct {
	ServicingID string    `json:"servicingId"`
	AssetID     string    `json:"assetId"`
	ISIN        string    `json:"isin,omitempty"`
	Payer       string    `json:"payer"`
	Holder      string    `json:"holder"`
	Tokens      int64     `json:"tokens"`
	AmountPaise int64     `json:"amountPaise"`
	AmountINR   float64   `json:"amountINR"`
	BlockHeight int64     `json:"blockHeight"`
	SettledAt   time.Time `json:"settledAt"`
	Rev         int64     `json:"-"`
}

// NewUMIRail wires the rail to a securities ledger and the Drunix chain (DIP).
// chain may be nil (settlement still works; no blocks are appended).
func NewUMIRail(sec SecuritiesLedger, chain *DrunixChain) *UMIRail {
	if sec == nil {
		sec = NewMemorySecurities()
	}
	return &UMIRail{
		wallets:       make(map[string]*CBDCWallet),
		authorised:    make(map[string]int64),
		derived:       make(map[string]bool),
		isins:         make(map[string]*PilotISIN),
		instructions:  make(map[string]*SettlementInstruction),
		baskets:       make(map[string]*Basket),
		ownership:     &ownershipLog{},
		securities:    sec,
		chain:         chain,
		book:          newOfferBook(),
		notifications: newNotifyStore(),
	}
}

// SettlementCounts reports settled and failed totals plus a breakdown of the
// failure reasons, for /metrics. Counting reasons here rather than in the
// metrics layer keeps the rail the single owner of settlement state.
func (r *UMIRail) SettlementCounts() (settled, failed int64, byReason map[string]int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	byReason = map[string]int64{}
	for _, si := range r.instructions {
		if si.Status == UMIStatusFailed && si.FailureReason != "" {
			byReason[si.FailureReason]++
		}
	}
	return r.settledCount, r.failedCount, byReason
}

// WalletCount reports how many CBDC wallets exist.
func (r *UMIRail) WalletCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.wallets)
}

// PositionOf reports a holder's token position, taking the rail lock. Callers
// already holding it must use r.securities.Position directly.
func (r *UMIRail) PositionOf(assetID, holder string) int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.securities.Position(assetID, holder)
}

// Securities exposes the asset-leg ledger (used by the HTTP layer for seeding).
func (r *UMIRail) Securities() SecuritiesLedger { return r.securities }

// WithStore attaches a durable mirror and replays whatever it holds. Persistence
// is best-effort by design: a database problem degrades to in-memory operation
// and is reported through /umi/config, never by failing a settlement.
func (r *UMIRail) WithStore(store UMIStore) *UMIRail {
	if store == nil {
		return r
	}
	r.store = store
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	snap, err := store.LoadSnapshot(ctx)
	if err != nil || snap == nil {
		return r
	}
	r.mu.Lock()
	for _, w := range snap.Wallets {
		cp := w
		cp.ReservedPaise = 0
		cp.refresh()
		r.wallets[w.Participant] = &cp
	}
	for _, p := range snap.ISINs {
		cp := p
		r.isins[p.AssetID] = &cp
	}
	for _, si := range snap.Instructions {
		cp := si
		r.instructions[si.InstructionID] = &cp
		r.order = append(r.order, si.InstructionID)
	}
	// Resume above the highest persisted revision. Without this the rev guard
	// would reject every write made after a restart — persistence would look
	// healthy and silently stop recording.
	// Whatever was legitimately outstanding at restore time becomes the
	// authorised supply. Without this a restart would forget every cap and the
	// next seed could inflate the book again.
	for _, pos := range snap.Positions {
		if pos.Tokens > 0 {
			r.authorised[pos.AssetID] += pos.Tokens
			r.derived[pos.AssetID] = true
		}
	}
	r.servicing = append(r.servicing, snap.Servicing...)
	r.rev = snap.MaxRev
	r.fundedPaise = snap.FundedPaise
	r.settledCount = snap.Settled
	r.failedCount = snap.Failed
	r.mu.Unlock()

	if mem, ok := r.securities.(*MemorySecurities); ok {
		for _, p := range snap.Positions {
			mem.Set(p.AssetID, p.Holder, p.Tokens)
		}
	}
	log.Printf("UMI rail restored from %s: %d wallets, %d positions, %d ISINs, %d instructions",
		store.Mode(), len(snap.Wallets), len(snap.Positions), len(snap.ISINs), len(snap.Instructions))
	return r
}

// persistence helpers — all no-ops when no store is attached.

// nextRev returns the next monotonic revision. Caller must hold r.mu, so the
// order of revisions matches the order state actually changed.
func (r *UMIRail) nextRev() int64 {
	r.rev++
	return r.rev
}

// snapWallet stamps and copies a wallet for persistence. Caller must hold r.mu.
func (r *UMIRail) snapWallet(w *CBDCWallet) CBDCWallet {
	w.Rev = r.nextRev()
	return *w
}

func (r *UMIRail) pWallet(w CBDCWallet) {
	if r.store != nil {
		_ = r.store.SaveWallet(w)
	}
}

// pPosition persists holdings. Values and revisions are captured under the
// mutex by the caller via snapPositions, so a slow write cannot resurrect a
// stale token count.
func (r *UMIRail) pPosition(rows []PositionRow) {
	if r.store == nil {
		return
	}
	for _, p := range rows {
		_ = r.store.SavePosition(p.AssetID, p.Holder, p.Tokens, p.Rev)
	}
}

// snapPositions reads holdings and stamps revisions. Caller must hold r.mu.
func (r *UMIRail) snapPositions(assetID string, holders ...string) []PositionRow {
	if r.store == nil {
		return nil
	}
	out := make([]PositionRow, 0, len(holders))
	for _, h := range holders {
		out = append(out, PositionRow{AssetID: assetID, Holder: h,
			Tokens: r.securities.Position(assetID, h), Rev: r.nextRev()})
	}
	return out
}

func (r *UMIRail) pInstruction(si SettlementInstruction) {
	if r.store != nil {
		_ = r.store.SaveInstruction(si)
	}
}

func (r *UMIRail) pServicing(rows []ServicingRecord) {
	if r.store == nil {
		return
	}
	for _, rec := range rows {
		_ = r.store.SaveServicing(rec)
	}
}

func (r *UMIRail) pISIN(p PilotISIN) {
	if r.store != nil {
		_ = r.store.SaveISIN(p)
	}
}

func (r *UMIRail) pMeta() {
	if r.store == nil {
		return
	}
	r.mu.Lock()
	funded, settled, failed := r.fundedPaise, r.settledCount, r.failedCount
	r.mu.Unlock()
	_ = r.store.SaveMeta(funded, settled, failed)
}

// SeedPosition establishes a demo holding. It is ABSOLUTE, not additive: it
// sets the holder's position to exactly `tokens`. The old behaviour credited
// on every call, so clicking "seed" twice created tokens out of nothing and a
// property could report 101% allocated — more tokens in existence than were
// ever issued.
//
// authorisedTokens is the issued supply. Passed on the first seed for an asset
// it fixes the cap (use the property's declared total). Omitted, the first
// seed itself defines the supply. Either way no seed may push the asset's
// outstanding total above that cap.
func (r *UMIRail) SeedPosition(assetID, holder string, tokens, authorisedTokens int64) (int64, error) {
	mem, ok := r.securities.(*MemorySecurities)
	if !ok {
		return 0, fmt.Errorf("ERR_UMI_LEDGER_NOT_SEEDABLE")
	}
	if assetID == "" || holder == "" || tokens <= 0 {
		return 0, ErrUMIInvalidAmount
	}

	r.mu.Lock()
	cap0, known := r.authorised[assetID]
	if !known {
		// First sight of this asset: its supply is whatever is being declared,
		// or the size of this first seed.
		cap0 = authorisedTokens
		if cap0 <= 0 {
			cap0 = tokens
		}
		r.authorised[assetID] = cap0
	} else if authorisedTokens > 0 && authorisedTokens != cap0 {
		if r.derived[assetID] {
			// The cap was only inferred from restored positions, so it carries
			// no authority. Accept the declared figure once - this is how an
			// operator states the true issue size for a book that was inflated
			// before caps existed.
			cap0 = authorisedTokens
			r.authorised[assetID] = cap0
			r.derived[assetID] = false
		} else {
			// Declared at issuance. Re-declaring would make the cap
			// meaningless, so refuse rather than silently ignore.
			r.mu.Unlock()
			return 0, fmt.Errorf("%w: %s supply is already %d tokens, cannot redeclare as %d",
				ErrUMISupplyExceeded, assetID, cap0, authorisedTokens)
		}
	} else if authorisedTokens > 0 {
		r.derived[assetID] = false
	}
	r.mu.Unlock()

	// Outstanding excluding this holder, because the write is absolute.
	outstanding := int64(0)
	for h, v := range mem.Holders(assetID) {
		if h != holder {
			outstanding += v
		}
	}
	if outstanding+tokens > cap0 {
		return 0, fmt.Errorf("%w: %s has %d of %d tokens issued to other holders, cannot seed %d more",
			ErrUMISupplyExceeded, assetID, outstanding, cap0, tokens)
	}

	mem.Set(assetID, holder, tokens)
	r.RecordOwnership(assetID, holder, tokens, "SEEDED")
	r.mu.Lock()
	snap := r.snapPositions(assetID, holder)
	r.mu.Unlock()
	r.pPosition(snap)
	return mem.Position(assetID, holder), nil
}

// AuthorisedSupply reports the issued supply and the outstanding total for an
// asset. outstanding > authorised means the book was inflated before the cap
// existed; /umi/reconciliation surfaces that rather than hiding it.
func (r *UMIRail) AuthorisedSupply(assetID string) (authorised, outstanding int64) {
	r.mu.Lock()
	authorised = r.authorised[assetID]
	r.mu.Unlock()
	if mem, ok := r.securities.(*MemorySecurities); ok {
		for _, v := range mem.Holders(assetID) {
			outstanding += v
		}
	}
	return authorised, outstanding
}

// SupplyBreaches lists assets whose outstanding tokens exceed the authorised
// supply — the conservation check for the securities leg, mirroring what
// /umi/reconciliation already does for cash.
func (r *UMIRail) SupplyBreaches() []map[string]interface{} {
	mem, ok := r.securities.(*MemorySecurities)
	if !ok {
		return nil
	}
	r.mu.Lock()
	caps := make(map[string]int64, len(r.authorised))
	for k, v := range r.authorised {
		caps[k] = v
	}
	r.mu.Unlock()
	out := []map[string]interface{}{}
	for assetID, cap0 := range caps {
		outstanding := int64(0)
		for _, v := range mem.Holders(assetID) {
			outstanding += v
		}
		if outstanding > cap0 {
			out = append(out, map[string]interface{}{
				"assetId": assetID, "authorisedTokens": cap0,
				"outstandingTokens": outstanding, "excessTokens": outstanding - cap0,
			})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i]["assetId"].(string) < out[j]["assetId"].(string)
	})
	return out
}

// IsEmpty reports whether the rail has no state yet (used to decide whether
// boot seeding is appropriate — never re-seed a restored ledger).
func (r *UMIRail) IsEmpty() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.wallets) == 0 && len(r.order) == 0 && r.fundedPaise == 0
}

// PersistenceStatus describes the durable mirror for /umi/config.
func (r *UMIRail) PersistenceStatus() map[string]interface{} {
	if r.store == nil {
		return map[string]interface{}{
			"mode": "in-memory",
			"note": "State resets on restart. Set DATABASE_URL (Neon) to persist wallets, positions, pilot ISINs and instructions.",
		}
	}
	st := map[string]interface{}{
		"mode":   r.store.Mode(),
		"tables": []string{"umi_wallet", "umi_position", "umi_isin", "umi_instruction", "umi_meta"},
		"note":   "Write-through mirror; settlement invariants are enforced in memory under one mutex, the database is the durable copy.",
	}
	if e := r.store.LastError(); e != "" {
		st["lastError"] = e
	}
	return st
}

func (r *UMIRail) nextID(prefix string) string {
	r.seq++
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s|%d|%d", prefix, r.seq, time.Now().UnixNano())))
	return prefix + "-" + strings.ToUpper(hex.EncodeToString(sum[:])[:10])
}

func (r *UMIRail) append(blockType string, txn map[string]interface{}) *DrunixBlock {
	if r.chain == nil {
		return nil
	}
	txn["contract"] = UMIContract
	txn["rail"] = "RBI-UMI (simulated)"
	return r.chain.Append(blockType, []map[string]interface{}{txn})
}

// --- wallets ---

// walletLocked returns (creating if needed) a participant's e₹-W wallet.
// Caller must hold r.mu.
func (r *UMIRail) walletLocked(participant string) *CBDCWallet {
	if w, ok := r.wallets[participant]; ok {
		return w
	}
	w := &CBDCWallet{
		WalletID:    "UMI-W-" + strings.ToUpper(participant),
		Participant: participant,
		Bank:        UMISettlementBank,
		OpenedAt:    time.Now().UTC(),
	}
	w.refresh()
	r.wallets[participant] = w
	return w
}

// OpenWallet creates (idempotently) a wholesale CBDC wallet for a participant.
func (r *UMIRail) OpenWallet(participant string) (*CBDCWallet, error) {
	if strings.TrimSpace(participant) == "" {
		return nil, ErrUMINoWallet
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	w := r.walletLocked(participant)
	cp := *w
	return &cp, nil
}

// FundWallet performs a sandbox top-up from the settlement bank.
func (r *UMIRail) FundWallet(participant string, amountINR float64) (*CBDCWallet, *DrunixBlock, error) {
	paise := INRToPaise(amountINR)
	if paise <= 0 {
		return nil, nil, ErrUMIInvalidAmount
	}
	r.mu.Lock()
	w := r.walletLocked(participant)
	w.BalancePaise += paise
	r.fundedPaise += paise
	w.refresh()
	snapshot := r.snapWallet(w)
	r.mu.Unlock()

	r.pWallet(snapshot)
	r.pMeta()
	blk := r.append(BlockUMIWalletFunded, map[string]interface{}{
		"kind":            "umi-funding",
		"walletId":        snapshot.WalletID,
		"participant":     participant,
		"amountINR":       paiseToINR(paise),
		"balanceINR":      snapshot.BalanceINR,
		"source":          UMISettlementBank,
		"settlementAsset": "e₹-W (wholesale CBDC, simulated)",
	})
	return &snapshot, blk, nil
}

// Wallets returns every wallet, sorted by participant.
func (r *UMIRail) Wallets() []CBDCWallet {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]CBDCWallet, 0, len(r.wallets))
	for _, w := range r.wallets {
		w.refresh()
		out = append(out, *w)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Participant < out[j].Participant })
	return out
}

// Wallet returns one participant's wallet.
func (r *UMIRail) Wallet(participant string) (*CBDCWallet, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	w, ok := r.wallets[participant]
	if !ok {
		return nil, false
	}
	w.refresh()
	cp := *w
	return &cp, true
}

// --- pilot ISIN ---

// AssignISIN registers a property as pilot-eligible under a Demat 2.0-style ISIN.
func (r *UMIRail) AssignISIN(assetID, issuer, depository string) (*PilotISIN, *DrunixBlock, error) {
	if strings.TrimSpace(assetID) == "" {
		return nil, nil, ErrUMINotPilotEligible
	}
	if depository == "" {
		depository = "AasthiChain Depository (Drunix channel, 5 MSPs)"
	}
	r.mu.Lock()
	if existing, ok := r.isins[assetID]; ok {
		cp := *existing
		r.mu.Unlock()
		return &cp, nil, nil
	}
	rec := &PilotISIN{
		AssetID:    assetID,
		ISIN:       pilotISINFor(assetID),
		Issuer:     issuer,
		PilotFlag:  true,
		Depository: depository,
		AssignedAt: time.Now().UTC(),
	}
	r.isins[assetID] = rec
	cp := *rec
	r.mu.Unlock()

	r.pISIN(cp)
	blk := r.append(BlockUMIISINAssigned, map[string]interface{}{
		"kind":       "umi-isin",
		"assetId":    assetID,
		"isin":       rec.ISIN,
		"issuer":     issuer,
		"pilotFlag":  true,
		"depository": rec.Depository,
		"note":       "One identifier, flagged as pilot — the instrument is not split in two (Demat 2.0 pattern)",
	})
	return &cp, blk, nil
}

// ISINs returns the pilot register.
func (r *UMIRail) ISINs() []PilotISIN {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]PilotISIN, 0, len(r.isins))
	for _, v := range r.isins {
		out = append(out, *v)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].AssetID < out[j].AssetID })
	return out
}

// --- settlement ---

// DvPRequest is one settlement instruction submitted to the rail.
type DvPRequest struct {
	AssetID          string  `json:"assetId"`
	Seller           string  `json:"seller"`
	Buyer            string  `json:"buyer"`
	Tokens           int64   `json:"tokens"`
	PricePerTokenINR float64 `json:"pricePerTokenINR"`
	DryRun           bool    `json:"dryRun"`
	// AutoAssignISIN registers the asset in the pilot register if absent
	// (default true via the HTTP layer, so the demo never dead-ends).
	AutoAssignISIN bool `json:"autoAssignIsin"`
}

// SettleDvP runs the full UMI flow: validate → match → lock BOTH legs → commit
// atomically. On any failure nothing moves and the instruction ends FAILED.
func (r *UMIRail) SettleDvP(req DvPRequest) (*SettlementInstruction, error) {
	now := time.Now().UTC()
	cashPaise := INRToPaise(float64(req.Tokens) * req.PricePerTokenINR)

	r.mu.Lock()
	si := &SettlementInstruction{
		InstructionID:    r.nextID("UMI"),
		AssetID:          req.AssetID,
		Seller:           req.Seller,
		Buyer:            req.Buyer,
		Tokens:           req.Tokens,
		PricePerTokenINR: req.PricePerTokenINR,
		CashPaise:        cashPaise,
		CashINR:          paiseToINR(cashPaise),
		Status:           UMIStatusReceived,
		Atomic:           "all-or-nothing (DvP, both legs or neither)",
		SecuritiesLeg:    "Drunix permissioned ledger — property fraction tokens",
		CashLeg:          "RBI wholesale CBDC e₹-W via UMI (simulated)",
		CreatedAt:        now,
		DryRun:           req.DryRun,
		Mode:             UMIMode,
		Disclaimer:       UMIDisclaimer,
	}
	si.msg("sese.023", fmt.Sprintf("Instruction received: %d tokens of %s, %s → %s, cash ₹%.2f settled in e₹-W",
		req.Tokens, req.AssetID, req.Seller, req.Buyer, si.CashINR))

	// an ISIN minted inline below is mirrored to the store after the lock drops
	var autoAssigned *PilotISIN

	// stampRev assigns the instruction's persistence revision. Caller holds r.mu.
	stampRev := func(si *SettlementInstruction) { si.Rev = r.nextRev() }

	fail := func(err error, detail string) (*SettlementInstruction, error) {
		si.Status = UMIStatusFailed
		si.FailureReason = err.Error()
		si.FailureDetail = detail
		si.msg("sese.024", "Settlement status advice: UNSETTLED — "+err.Error())
		si.msg("camt.019", "Reject advice: "+detail+". Neither leg moved.")
		if !req.DryRun {
			r.failedCount++
			r.instructions[si.InstructionID] = si
			r.order = append(r.order, si.InstructionID)
		}
		stampRev(si)
		r.mu.Unlock()
		if !req.DryRun {
			if autoAssigned != nil {
				r.pISIN(*autoAssigned)
			}
			r.pMeta()
			if blk := r.append(BlockUMIDvPFailed, map[string]interface{}{
				"kind":          "umi-dvp",
				"instructionId": si.InstructionID,
				"assetId":       si.AssetID,
				"seller":        si.Seller,
				"buyer":         si.Buyer,
				"tokens":        si.Tokens,
				"cashINR":       si.CashINR,
				"status":        UMIStatusFailed,
				"failureReason": si.FailureReason,
				"atomic":        "no partial settlement — both legs rolled back",
			}); blk != nil {
				si.BlockHeight, si.BlockHash = blk.Height, blk.Hash
			}
			// persisted after the block so the anchor survives a restart
			r.pInstruction(*si)
			// Only for real attempts: a dry run is a question, not an event,
			// and nobody should be notified about one.
			r.notifyFailed(si)
		}
		return si, err
	}

	// --- validation ---
	if req.Tokens <= 0 || req.PricePerTokenINR <= 0 || cashPaise <= 0 {
		return fail(ErrUMIInvalidAmount, "tokens and pricePerTokenINR must both be positive")
	}
	if req.Seller == "" || req.Buyer == "" {
		return fail(ErrUMINoWallet, "seller and buyer identities are required")
	}
	if req.Seller == req.Buyer {
		return fail(ErrUMISelfSettlement, "a participant cannot settle against itself")
	}

	isin, ok := r.isins[req.AssetID]
	if !ok {
		if !req.AutoAssignISIN {
			return fail(ErrUMINotPilotEligible, "asset "+req.AssetID+" is not in the pilot ISIN register — POST /umi/isin first")
		}
		isin = &PilotISIN{
			AssetID: req.AssetID, ISIN: pilotISINFor(req.AssetID), Issuer: req.Seller,
			PilotFlag: true, Depository: "AasthiChain Depository (Drunix channel, 5 MSPs)", AssignedAt: now,
		}
		r.isins[req.AssetID] = isin
		autoAssigned = isin
	}
	si.ISIN = isin.ISIN

	// --- leg checks (pre-lock) ---
	sellerPos := r.securities.Position(req.AssetID, req.Seller)
	if sellerPos < req.Tokens {
		return fail(ErrUMIInsufficientSecurities,
			fmt.Sprintf("%s holds %d tokens of %s, needs %d", req.Seller, sellerPos, req.AssetID, req.Tokens))
	}
	buyerWallet, hasBuyer := r.wallets[req.Buyer]
	if !hasBuyer {
		return fail(ErrUMINoWallet, "buyer "+req.Buyer+" has no wholesale CBDC wallet — fund one via POST /umi/wallets/{id}/fund")
	}
	if buyerWallet.available() < cashPaise {
		si.AvailableINR = paiseToINR(buyerWallet.available())
		si.ShortfallINR = paiseToINR(cashPaise - buyerWallet.available())
		return fail(ErrUMIInsufficientCBDC,
			fmt.Sprintf("buyer e₹-W available ₹%.2f, instruction needs ₹%.2f — short by ₹%.2f",
				si.AvailableINR, si.CashINR, si.ShortfallINR))
	}
	sellerWallet := r.walletLocked(req.Seller)

	si.Status = UMIStatusMatched
	si.msg("sese.024", "Settlement status advice: MATCHED — both legs validated against the shared ledger")

	// --- lock both legs ---
	buyerWallet.ReservedPaise += cashPaise
	si.Status = UMIStatusLocked
	si.msg("sese.024", fmt.Sprintf("Settlement status advice: LOCKED — %d tokens earmarked at the depository, ₹%.2f reserved in e₹-W",
		req.Tokens, si.CashINR))

	if req.DryRun {
		// release the earmark; report what would have happened
		buyerWallet.ReservedPaise -= cashPaise
		buyerWallet.refresh()
		si.Status = UMIStatusMatched
		si.msg("sese.024", "Dry run: instruction is settleable. No state changed.")
		r.mu.Unlock()
		if autoAssigned != nil {
			r.pISIN(*autoAssigned)
		}
		return si, nil
	}

	// --- atomic commit ---
	if err := r.securities.Move(req.AssetID, req.Seller, req.Buyer, req.Tokens); err != nil {
		buyerWallet.ReservedPaise -= cashPaise // release cash lock, nothing moved
		buyerWallet.refresh()
		return fail(ErrUMIInsufficientSecurities, "securities leg rejected at commit: "+err.Error())
	}
	// Ownership changed hands: journal both sides so the stake can later be
	// measured over a period, not just read off as a snapshot.
	r.RecordOwnership(req.AssetID, req.Seller, r.securities.Position(req.AssetID, req.Seller), "DVP_SETTLED")
	r.RecordOwnership(req.AssetID, req.Buyer, r.securities.Position(req.AssetID, req.Buyer), "DVP_SETTLED")

	buyerWallet.ReservedPaise -= cashPaise
	buyerWallet.BalancePaise -= cashPaise
	sellerWallet.BalancePaise += cashPaise
	buyerWallet.refresh()
	sellerWallet.refresh()

	settledAt := time.Now().UTC()
	si.Status = UMIStatusSettled
	si.SettledAt = &settledAt
	si.msg("pacs.009", fmt.Sprintf("Cash leg executed in central bank money: ₹%.2f debited %s, credited %s (e₹-W)",
		si.CashINR, buyerWallet.WalletID, sellerWallet.WalletID))
	si.msg("sese.025", "Settlement confirmation: DvP complete — securities and cash moved in the same transaction")
	si.msg("camt.054", fmt.Sprintf("Credit/debit notification issued to %s and %s", req.Buyer, req.Seller))

	r.instructions[si.InstructionID] = si
	r.order = append(r.order, si.InstructionID)
	r.settledCount++
	buyerSnapshot, sellerSnapshot := r.snapWallet(buyerWallet), r.snapWallet(sellerWallet)
	posSnapshot := r.snapPositions(si.AssetID, si.Seller, si.Buyer)
	si.Rev = r.nextRev()
	r.mu.Unlock()

	if autoAssigned != nil {
		r.pISIN(*autoAssigned)
	}
	r.pWallet(buyerSnapshot)
	r.pWallet(sellerSnapshot)
	r.pPosition(posSnapshot)
	r.pMeta()
	if blk := r.append(BlockUMIDvPSettled, map[string]interface{}{
		"kind":          "umi-dvp",
		"instructionId": si.InstructionID,
		"assetId":       si.AssetID,
		"isin":          si.ISIN,
		"securitiesLeg": map[string]interface{}{"from": si.Seller, "to": si.Buyer, "tokens": si.Tokens},
		"cashLeg":       map[string]interface{}{"from": buyerSnapshot.WalletID, "to": sellerSnapshot.WalletID, "amountINR": si.CashINR, "asset": "e₹-W wholesale CBDC (simulated)"},
		"status":        UMIStatusSettled,
		"atomic":        "both legs in one block — no settlement-risk window",
		"interface":     "RBI Unified Market Interface (pattern simulation)",
	}); blk != nil {
		si.BlockHeight, si.BlockHash = blk.Height, blk.Hash
	}
	// Persisted only now: the instruction is not fully described until it knows
	// which block anchors it, and a restart must restore that link.
	r.pInstruction(*si)
	// Raised after the commit, never before: a notification reports what the
	// ledger already records, so it cannot promise a trade that did not happen.
	r.notifySettled(si)
	return si, nil
}

// servicingPayoutsForBlock renders payouts for the ledger block, so the chain
// itself records who was paid what — not merely how many holders there were.
func servicingPayoutsForBlock(ps []ServicingPayout) []map[string]interface{} {
	out := make([]map[string]interface{}, 0, len(ps))
	for _, p := range ps {
		out = append(out, map[string]interface{}{
			"holder": p.Holder, "tokens": p.Tokens, "amountINR": p.AmountINR, "walletId": p.WalletID,
		})
	}
	return out
}

// Income returns one participant's servicing (rent / coupon) history, newest
// first, with the lifetime total. Empty slice, not nil, when there is none.
func (r *UMIRail) Income(participant string) (float64, []ServicingRecord) {
	r.mu.Lock()
	defer r.mu.Unlock()
	rows := make([]ServicingRecord, 0, 8)
	var totalPaise int64
	for i := len(r.servicing) - 1; i >= 0; i-- {
		if r.servicing[i].Holder == participant {
			rows = append(rows, r.servicing[i])
			totalPaise += r.servicing[i].AmountPaise
		}
	}
	return paiseToINR(totalPaise), rows
}

// ServicingHistory returns every servicing payout, newest first.
func (r *UMIRail) ServicingHistory(limit int) []ServicingRecord {
	r.mu.Lock()
	defer r.mu.Unlock()
	if limit <= 0 || limit > len(r.servicing) {
		limit = len(r.servicing)
	}
	out := make([]ServicingRecord, 0, limit)
	for i := len(r.servicing) - 1; i >= 0 && len(out) < limit; i-- {
		out = append(out, r.servicing[i])
	}
	return out
}

// --- asset servicing ---

// ServicingPayout is one holder's share of a servicing run.
type ServicingPayout struct {
	Holder     string  `json:"holder"`
	WalletID   string  `json:"walletId"`
	Tokens     int64   `json:"tokens"`
	AmountINR  float64 `json:"amountINR"`
	BalanceINR float64 `json:"balanceINR"`
}

// ServicingResult is the outcome of a coupon / rent distribution.
type ServicingResult struct {
	ServicingID    string            `json:"servicingId"`
	AssetID        string            `json:"assetId"`
	ISIN           string            `json:"isin"`
	Payer          string            `json:"payer"`
	GrossINR       float64           `json:"grossINR"`
	DistributedINR float64           `json:"distributedINR"`
	RemainderINR   float64           `json:"remainderINR"`
	Payouts        []ServicingPayout `json:"payouts"`
	// Basis records how the split was decided, so a payout can be explained
	// months later without guessing.
	Basis       string    `json:"basis"`
	BlockHeight int64     `json:"blockHeight"`
	BlockHash   string    `json:"blockHash,omitempty"`
	SettledAt   time.Time `json:"settledAt"`
	Contract    string    `json:"contract"`
	Mode        string    `json:"mode"`
	Disclaimer  string    `json:"disclaimer"`
}

// Servicing distributes rent/coupon pro-rata straight into holders' CBDC
// wallets — the Demat 2.0 "payment reaches the holder's wallet on the due date,
// no registrar file-shuffling" behaviour. Excluded holders: the payer itself.
// Rounding remainder (sub-paise dust) is reported, never silently created.
// Servicing distributes income on the current register. Unchanged behaviour:
// whoever holds tokens at this instant is paid pro rata.
func (r *UMIRail) Servicing(assetID, payer string, grossINR float64) (*ServicingResult, error) {
	return r.ServicingByBasis(assetID, payer, grossINR, ServicingBasisSnapshot, time.Time{}, time.Time{})
}

// ServicingByBasis distributes income on a chosen basis.
//
// A snapshot pays someone who bought yesterday exactly as much as someone who
// held all year, which is wrong for rent that accrued over the whole period.
// The time-weighted basis splits by token-days actually held.
func (r *UMIRail) ServicingByBasis(assetID, payer string, grossINR float64, basis string, from, to time.Time) (*ServicingResult, error) {
	gross := INRToPaise(grossINR)
	if gross <= 0 {
		return nil, ErrUMIInvalidAmount
	}
	tokens := r.securities.Holders(assetID)
	delete(tokens, payer)
	if len(tokens) == 0 {
		return nil, ErrUMINoHolders
	}

	// weights decide the split; tokens stay on the payout for the record.
	weights := make(map[string]int64, len(tokens))
	switch basis {
	case ServicingBasisTimeWeighted:
		for _, sl := range r.CapTable(assetID, from, to) {
			if sl.Holder == payer {
				continue
			}
			if _, holds := tokens[sl.Holder]; !holds {
				// Sold out before the payout: no current position, no payout.
				continue
			}
			// Token-days are fractional; scale to integer paise-grade weight
			// so the split stays exact integer arithmetic.
			weights[sl.Holder] = int64(sl.TokenDays * 1000)
		}
	default:
		basis = ServicingBasisSnapshot
		for h, t := range tokens {
			weights[h] = t
		}
	}

	var totalTokens int64
	names := make([]string, 0, len(weights))
	for h, w := range weights {
		totalTokens += w
		names = append(names, h)
	}
	sort.Strings(names)
	if totalTokens <= 0 {
		// Time-weighting can legitimately produce no history at all (every
		// position opened after the window). Fall back rather than refuse to
		// pay anyone.
		if basis == ServicingBasisTimeWeighted {
			return r.ServicingByBasis(assetID, payer, grossINR, ServicingBasisSnapshot, time.Time{}, time.Time{})
		}
		return nil, ErrUMINoHolders
	}
	holders := weights

	r.mu.Lock()
	payerWallet := r.walletLocked(payer)
	if payerWallet.available() < gross {
		avail := paiseToINR(payerWallet.available())
		r.mu.Unlock()
		return nil, fmt.Errorf("%w: payer e₹-W available ₹%.2f, servicing needs ₹%.2f", ErrUMIInsufficientCBDC, avail, paiseToINR(gross))
	}

	res := &ServicingResult{
		ServicingID: r.nextID("UMISRV"),
		AssetID:     assetID,
		Payer:       payer,
		GrossINR:    paiseToINR(gross),
		SettledAt:   time.Now().UTC(),
		Basis:       basis,
		Contract:    "aasthi.servicing-umi-v1",
		Mode:        UMIMode,
		Disclaimer:  UMIDisclaimer,
	}
	if isin, ok := r.isins[assetID]; ok {
		res.ISIN = isin.ISIN
	}

	var distributed int64
	for _, h := range names {
		share := gross * holders[h] / totalTokens // integer paise, floor
		if share <= 0 {
			continue
		}
		w := r.walletLocked(h)
		w.BalancePaise += share
		w.refresh()
		distributed += share
		res.Payouts = append(res.Payouts, ServicingPayout{
			Holder: h, WalletID: w.WalletID, Tokens: tokens[h],
			AmountINR: paiseToINR(share), BalanceINR: w.BalanceINR,
		})
	}
	payerWallet.BalancePaise -= distributed
	payerWallet.refresh()
	// servicing is an internal transfer between wallets: conservation unaffected
	res.DistributedINR = paiseToINR(distributed)
	res.RemainderINR = paiseToINR(gross - distributed)
	touched := make([]CBDCWallet, 0, len(res.Payouts)+1)
	touched = append(touched, r.snapWallet(payerWallet))
	for _, p := range res.Payouts {
		if w, ok := r.wallets[p.Holder]; ok {
			touched = append(touched, r.snapWallet(w))
		}
	}
	records := make([]ServicingRecord, 0, len(res.Payouts))
	for _, p := range res.Payouts {
		rec := ServicingRecord{
			ServicingID: res.ServicingID, AssetID: assetID, ISIN: res.ISIN, Payer: payer,
			Holder: p.Holder, Tokens: p.Tokens, AmountPaise: INRToPaise(p.AmountINR),
			AmountINR: p.AmountINR, SettledAt: res.SettledAt, Rev: r.nextRev(),
		}
		records = append(records, rec)
	}
	r.servicing = append(r.servicing, records...)
	r.mu.Unlock()
	for _, w := range touched {
		r.pWallet(w)
	}

	if blk := r.append(BlockUMIServicingPaid, map[string]interface{}{
		"kind":            "umi-servicing",
		"servicingId":     res.ServicingID,
		"assetId":         assetID,
		"isin":            res.ISIN,
		"payer":           payer,
		"grossINR":        res.GrossINR,
		"distributedINR":  res.DistributedINR,
		"holders":         len(res.Payouts),
		"payouts":         servicingPayoutsForBlock(res.Payouts),
		"settlementAsset": "e₹-W wholesale CBDC (simulated)",
		"note":            "Smart-contract servicing: funds land in holders' CBDC wallets on the due date, no registrar file exchange",
	}); blk != nil {
		for i := range records {
			records[i].BlockHeight = blk.Height
		}
		r.mu.Lock()
		n := len(r.servicing)
		for i := range records {
			if idx := n - len(records) + i; idx >= 0 && idx < n {
				r.servicing[idx].BlockHeight = blk.Height
			}
		}
		r.mu.Unlock()
		res.BlockHeight, res.BlockHash = blk.Height, blk.Hash
	}
	// persisted only once the block anchor is known, so a restart can still
	// point each payout at the block that proves it
	r.pServicing(records)
	r.notifyIncome(assetID, res.Payouts, res.BlockHeight)
	return res, nil
}

// --- queries ---

// Instructions returns instructions newest-first (optionally capped).
func (r *UMIRail) Instructions(limit int) []SettlementInstruction {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]SettlementInstruction, 0, len(r.order))
	for i := len(r.order) - 1; i >= 0; i-- {
		if limit > 0 && len(out) >= limit {
			break
		}
		if si, ok := r.instructions[r.order[i]]; ok {
			out = append(out, *si)
		}
	}
	return out
}

// Instruction returns a single instruction with its full ISO 20022 trace.
func (r *UMIRail) Instruction(id string) (*SettlementInstruction, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	si, ok := r.instructions[id]
	if !ok {
		return nil, ErrUMIInstructionNotFound
	}
	cp := *si
	return &cp, nil
}

// Reconciliation is the money-conservation + leg-integrity report.
type Reconciliation struct {
	AsOf             time.Time         `json:"asOf"`
	Wallets          int               `json:"wallets"`
	TotalBalanceINR  float64           `json:"totalBalanceINR"`
	TotalReservedINR float64           `json:"totalReservedINR"`
	TotalFundedINR   float64           `json:"totalFundedINR"`
	Conserved        bool              `json:"conserved"`
	ConservationNote string            `json:"conservationNote"`
	SettledCount     int64             `json:"settledInstructions"`
	FailedCount      int64             `json:"failedInstructions"`
	PilotISINs       int               `json:"pilotIsins"`
	Chain            ChainVerification `json:"chain"`
	Mode             string            `json:"mode"`
	Disclaimer       string            `json:"disclaimer"`
	// Securities-leg conservation. The cash leg has always been checked; the
	// token book was not, which is how an asset came to report 101% allocated.
	SupplyConserved bool                     `json:"supplyConserved"`
	SupplyNote      string                   `json:"supplyNote"`
	SupplyBreaches  []map[string]interface{} `json:"supplyBreaches,omitempty"`
}

// Reconcile asserts that no paisa was created or destroyed by the rail:
// Σ wallet balances must equal lifetime sandbox funding (DvP and servicing are
// internal transfers and must net to zero).
func (r *UMIRail) Reconcile() Reconciliation {
	r.mu.Lock()
	var total, reserved int64
	for _, w := range r.wallets {
		total += w.BalancePaise
		reserved += w.ReservedPaise
	}
	rec := Reconciliation{
		AsOf:             time.Now().UTC(),
		Wallets:          len(r.wallets),
		TotalBalanceINR:  paiseToINR(total),
		TotalReservedINR: paiseToINR(reserved),
		TotalFundedINR:   paiseToINR(r.fundedPaise),
		Conserved:        total == r.fundedPaise,
		SettledCount:     r.settledCount,
		FailedCount:      r.failedCount,
		PilotISINs:       len(r.isins),
		Mode:             UMIMode,
		Disclaimer:       UMIDisclaimer,
	}
	r.mu.Unlock()

	if rec.Conserved {
		rec.ConservationNote = "Σ wallet balances == lifetime funding: every settled DvP and servicing run moved money, none created it."
	} else {
		rec.ConservationNote = "MISMATCH — settlement engine created or destroyed central bank money. This must never happen."
	}
	breaches := r.SupplyBreaches()
	rec.SupplyBreaches = breaches
	rec.SupplyConserved = len(breaches) == 0
	if rec.SupplyConserved {
		rec.SupplyNote = "No asset has more tokens outstanding than were issued."
	} else {
		rec.SupplyNote = "MISMATCH — tokens exist beyond the issued supply. Seeding inflated the book before the cap was enforced."
	}

	if r.chain != nil {
		rec.Chain = r.chain.Verify()
	}
	return rec
}

// Config describes the rail for the UI and for judges.
func (r *UMIRail) Config() map[string]interface{} {
	r.mu.Lock()
	wallets, isins, instr := len(r.wallets), len(r.isins), len(r.order)
	r.mu.Unlock()
	return map[string]interface{}{
		"rail":            "RBI Unified Market Interface (UMI)",
		"pattern":         "SEBI Demat 2.0 — tokenised asset on a permissioned depository ledger, cash leg in RBI wholesale CBDC, atomic DvP",
		"launchContext":   "Announced by RBI Governor Sanjay Malhotra and SEBI Chairman Tuhin Kanta Pandey at Global Fintech Fest, 10 Sep 2026; first phase ₹1,025 crore of tokenised corporate bonds (REC, L&T, IIFL).",
		"mode":            UMIMode,
		"disclaimer":      UMIDisclaimer,
		"language":        "golang",
		"service":         "aasthichain-drunix-gateway (umi.go)",
		"contract":        UMIContract,
		"settlementAsset": "e₹-W wholesale CBDC (simulated, integer paise)",
		"securitiesLeg":   "Drunix permissioned ledger — property fraction tokens",
		"blockTypes":      []string{BlockUMIWalletFunded, BlockUMIISINAssigned, BlockUMIDvPSettled, BlockUMIDvPFailed, BlockUMIServicingPaid, BlockUMIBasketCreated, BlockUMIBasketSubscribed, BlockUMIBasketRedeemed, BlockUMIBasketDvPSettled, BlockUMIBasketTransferred},
		"messageFamilies": umiMessageNames,
		"states":          []string{UMIStatusReceived, UMIStatusMatched, UMIStatusLocked, UMIStatusSettled, UMIStatusFailed},
		"failureReasons": []string{
			ErrUMINoWallet.Error(), ErrUMIInsufficientCBDC.Error(), ErrUMIInsufficientSecurities.Error(),
			ErrUMINotPilotEligible.Error(), ErrUMISelfSettlement.Error(), ErrUMIInvalidAmount.Error(),
		},
		"counts":      map[string]int{"wallets": wallets, "pilotIsins": isins, "instructions": instr},
		"persistence": r.PersistenceStatus(),
		"endpoints":   umiEndpointList,
		"notUMI": []string{
			"Not a public blockchain, token standard or SDK — UMI is a settlement interface to central bank money.",
			"Retail e₹ is out of scope: UMI settles WHOLESALE CBDC between institutions.",
			"UPI remains AasthiChain's retail money leg; UMI is the institutional rail beside it.",
		},
	}
}
