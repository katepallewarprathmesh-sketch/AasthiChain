package settlement

import (
	"context"
	"crypto/sha512"
	"encoding/hex"
	"fmt"
	"sync"
	"time"
)

// UMISimRail models the settlement pattern published for SEBI's Demat 2.0 pilot, where
// the cash leg settles in RBI wholesale CBDC through the Unified Market Interface.
//
// What is modelled (from public descriptions only):
//   - Participants hold a wholesale wallet at a participating bank.
//   - The cash leg is reserved before the trade is matched.
//   - Security leg and cash leg commit atomically, or neither commits.
//   - Corporate actions (coupon, rent, redemption) are pushed to holder wallets.
//
// What is NOT modelled, and cannot be: real e₹, a real UMI connection, depository
// ledger ownership, or any regulatory approval. Balances here are ordinary integers in
// this process. This is a teaching and conformance artefact, not a payment system.
type UMISimRail struct {
	mu      sync.Mutex
	wallets map[string]*Wallet
	locks   map[string]*Lock
	clock   func() time.Time
	// holdWindow is how long a reservation stays valid before it may be unwound.
	holdWindow time.Duration
}

// Wallet is a simulated wholesale CBDC wallet held with a participating bank.
type Wallet struct {
	ParticipantID string `json:"participantId"`
	// Class mirrors the institutional cast of the pilot rather than inventing roles.
	Class string `json:"participantClass"` // INVESTOR | ISSUER_SPV | INVESTMENT_MANAGER | TRUSTEE | DEPOSITORY | BANK
	Bank  string `json:"participatingBank"`
	// BalancePaise is spendable balance. HeldPaise is reserved against open locks.
	BalancePaise int64 `json:"balancePaise"`
	HeldPaise    int64 `json:"heldPaise"`
	// Simulated is serialised on every wallet response by contract.
	Simulated bool `json:"simulated"`
}

// AvailablePaise is what the participant can still commit to a new trade.
func (w *Wallet) AvailablePaise() int64 { return w.BalancePaise - w.HeldPaise }

// NewUMISimRail builds an empty simulator. Pass nil for clock to use time.Now.
func NewUMISimRail(clock func() time.Time) *UMISimRail {
	if clock == nil {
		clock = time.Now
	}
	return &UMISimRail{
		wallets:    make(map[string]*Wallet),
		locks:      make(map[string]*Lock),
		clock:      clock,
		holdWindow: 15 * time.Minute,
	}
}

func (r *UMISimRail) Name() Rail { return RailUMISim }

func (r *UMISimRail) Capabilities() Capabilities {
	return Capabilities{
		Rail:             RailUMISim,
		Atomic:           true,
		CentralBankMoney: false,
		Simulated:        true,
		RegulatoryStatus: StatusSimulatedNotConnected,
		SettlementWindow: "instant (both legs in one commit)",
		Notes: "Simulates the Demat 2.0 / UMI wholesale-CBDC settlement pattern. " +
			"No real e-rupee, no connection to RBI, SEBI, NSDL or CDSL. " +
			"Balances are in-process integers held for demonstration only.",
	}
}

// OpenWallet registers a simulated wholesale wallet. Re-opening an existing wallet
// returns the existing record rather than resetting a balance.
func (r *UMISimRail) OpenWallet(participantID, class, bank string, openingPaise int64) (*Wallet, error) {
	if participantID == "" {
		return nil, ErrUnknownParticipant
	}
	if openingPaise < 0 {
		return nil, ErrInvalidAmount
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if w, ok := r.wallets[participantID]; ok {
		return w.copy(), nil
	}
	w := &Wallet{
		ParticipantID: participantID,
		Class:         class,
		Bank:          bank,
		BalancePaise:  openingPaise,
		Simulated:     true,
	}
	r.wallets[participantID] = w
	return w.copy(), nil
}

// GetWallet returns a copy of the wallet so callers cannot mutate rail state.
func (r *UMISimRail) GetWallet(participantID string) (*Wallet, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	w, ok := r.wallets[participantID]
	if !ok {
		return nil, ErrUnknownParticipant
	}
	return w.copy(), nil
}

// Reserve holds the cash leg on the payer's wallet. Money does not move here: the
// balance is untouched and only the held amount rises. This is the property that makes
// the later settle atomic — the funds are already proven to exist.
func (r *UMISimRail) Reserve(ctx context.Context, req DvPRequest) (*Lock, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if req.AmountPaise <= 0 || req.TokenCount <= 0 {
		return nil, ErrInvalidAmount
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	payer, ok := r.wallets[req.PayerID]
	if !ok {
		return nil, ErrUnknownParticipant
	}
	if _, ok := r.wallets[req.PayeeID]; !ok {
		return nil, ErrUnknownParticipant
	}
	if payer.AvailablePaise() < req.AmountPaise {
		return nil, ErrInsufficientFunds
	}

	now := r.clock()
	lock := &Lock{
		LockID:      r.deriveID("LOCK", req.DvPID, req.PayerID, now),
		DvPID:       req.DvPID,
		Rail:        RailUMISim,
		PayerID:     req.PayerID,
		PayeeID:     req.PayeeID,
		AmountPaise: req.AmountPaise,
		Phase:       PhaseReserved,
		ReservedAt:  now,
		ExpiresAt:   now.Add(r.holdWindow),
	}
	payer.HeldPaise += req.AmountPaise
	r.locks[lock.LockID] = lock
	return lock.copy(), nil
}

// AtomicSettle commits both legs. The security leg is supplied by the ledger; this
// method verifies the two legs describe the same trade before moving anything, then
// applies the cash movement in one critical section so no partial state is observable.
func (r *UMISimRail) AtomicSettle(ctx context.Context, lock *Lock, leg TokenLeg) (*Receipt, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if lock == nil {
		return nil, ErrLockNotFound
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	held, ok := r.locks[lock.LockID]
	if !ok {
		return nil, ErrLockNotFound
	}
	if held.Phase != PhaseReserved {
		return nil, ErrLockConsumed
	}
	// The cash leg and the security leg must describe the same counterparties, or the
	// trade is not a delivery-versus-payment at all.
	if leg.FromID != held.PayeeID || leg.ToID != held.PayerID {
		return nil, ErrLegMismatch
	}
	if leg.TokenCount <= 0 || leg.LedgerTxID == "" {
		return nil, ErrLegMismatch
	}

	payer := r.wallets[held.PayerID]
	payee := r.wallets[held.PayeeID]
	if payer == nil || payee == nil {
		return nil, ErrUnknownParticipant
	}
	if payer.HeldPaise < held.AmountPaise || payer.BalancePaise < held.AmountPaise {
		// Should be unreachable while Reserve is the only writer, but an atomic rail
		// must refuse rather than produce a half-settled trade.
		return nil, ErrInsufficientFunds
	}

	now := r.clock()
	payer.BalancePaise -= held.AmountPaise
	payer.HeldPaise -= held.AmountPaise
	payee.BalancePaise += held.AmountPaise
	held.Phase = PhaseSettled

	return &Receipt{
		DvPID:            held.DvPID,
		Rail:             RailUMISim,
		Phase:            PhaseSettled,
		CashRef:          r.deriveID("ERUPEE-SIM", held.DvPID, leg.LedgerTxID, now),
		LedgerTxID:       leg.LedgerTxID,
		AmountPaise:      held.AmountPaise,
		TokenCount:       leg.TokenCount,
		SettledAt:        now,
		Simulated:        true,
		CentralBankMoney: false,
		RegulatoryStatus: StatusSimulatedNotConnected,
	}, nil
}

// Unwind releases a reservation without moving money.
func (r *UMISimRail) Unwind(ctx context.Context, lock *Lock, reason string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if lock == nil {
		return ErrLockNotFound
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	held, ok := r.locks[lock.LockID]
	if !ok {
		return ErrLockNotFound
	}
	if held.Phase != PhaseReserved {
		return ErrLockConsumed
	}
	payer := r.wallets[held.PayerID]
	if payer == nil {
		return ErrUnknownParticipant
	}
	payer.HeldPaise -= held.AmountPaise
	held.Phase = PhaseUnwound
	return nil
}

// CorporateAction is an automated servicing event — the pattern's "smart contract pays
// the holder's wallet on the due date" behaviour, applied to rent or redemption.
type CorporateAction struct {
	ActionID   string           `json:"actionId"`
	AssetID    string           `json:"assetId"`
	Kind       string           `json:"kind"` // RENT | YIELD | REDEMPTION
	FromID     string           `json:"fromId"`
	Splits     map[string]int64 `json:"splits"` // participantID -> paise
	ExecutedAt time.Time        `json:"executedAt"`
	Simulated  bool             `json:"simulated"`
}

// DistributeCorporateAction pays every holder in one pass, or pays nobody. Allocation
// is done by the caller in paise so that no rounding can create or destroy money here;
// this method verifies that invariant before moving anything.
func (r *UMISimRail) DistributeCorporateAction(ctx context.Context, action CorporateAction) (*CorporateAction, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if len(action.Splits) == 0 {
		return nil, ErrInvalidAmount
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	payer, ok := r.wallets[action.FromID]
	if !ok {
		return nil, ErrUnknownParticipant
	}

	var total int64
	for participant, paise := range action.Splits {
		if paise <= 0 {
			return nil, ErrInvalidAmount
		}
		if _, ok := r.wallets[participant]; !ok {
			return nil, ErrUnknownParticipant
		}
		total += paise
	}
	if payer.AvailablePaise() < total {
		return nil, ErrInsufficientFunds
	}

	now := r.clock()
	payer.BalancePaise -= total
	for participant, paise := range action.Splits {
		r.wallets[participant].BalancePaise += paise
	}

	action.ExecutedAt = now
	action.Simulated = true
	if action.ActionID == "" {
		action.ActionID = r.deriveID("CA-SIM", action.AssetID, action.Kind, now)
	}
	return &action, nil
}

// deriveID produces a deterministic, readable reference. Deterministic derivation keeps
// tests reproducible and makes it obvious that these are not bank-issued references.
func (r *UMISimRail) deriveID(prefix string, parts ...interface{}) string {
	h := sha512.New()
	for _, p := range parts {
		fmt.Fprintf(h, "%v|", p)
	}
	return prefix + "-" + hex.EncodeToString(h.Sum(nil))[:16]
}

func (w *Wallet) copy() *Wallet {
	c := *w
	return &c
}

func (l *Lock) copy() *Lock {
	c := *l
	return &c
}
