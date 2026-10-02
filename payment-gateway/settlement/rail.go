// Package settlement defines the boundary between AasthiChain's product logic and
// whatever rail actually moves the money leg of a trade.
//
// # Why this exists
//
// India's tokenised-settlement pattern (SEBI "Demat 2.0", settled through the RBI's
// Unified Market Interface) separates two legs of every trade: the security leg on a
// permissioned ledger owned by the record-keeper, and the cash leg in central bank
// money. The two either move together or neither moves. AasthiChain cannot connect to
// that infrastructure — it is not an open API and participation is limited to
// RBI-supervised institutions — so this package models the *pattern* faithfully behind
// an interface, and ships a simulator for it.
//
// # Honesty contract
//
// Every rail in this package reports Capabilities().Simulated == true. No rail here
// moves real money, and no rail here is connected to RBI, SEBI, NPCI, NSDL or CDSL.
// A regulated participant could implement SettlementRail against a real connection
// without any change to the calling product code — that substitution is the entire
// point of the boundary.
package settlement

import (
	"context"
	"errors"
	"time"
)

// Rail identifies a settlement implementation. These strings are surfaced verbatim in
// API responses as `settlementRail`, so they must stay stable.
type Rail string

const (
	// RailUPISim is the existing UPI Collect simulation (INR, commercial bank money).
	RailUPISim Rail = "UPI_SIM"
	// RailPayUTest is the PayU test-mode PSP round trip (real signing, simulated settlement).
	RailPayUTest Rail = "PAYU_TEST"
	// RailUMISim models the Demat 2.0 / UMI wholesale-CBDC pattern. Simulated only.
	RailUMISim Rail = "UMI_SIM"
)

// RegulatoryStatus is deliberately verbose so it cannot be mistaken for an approval.
const (
	StatusSimulatedNotConnected = "SIMULATED_NOT_CONNECTED"
)

// Phase tracks a delivery-versus-payment attempt through its lifecycle. The names
// mirror the publicly described flow: the cash leg is reserved, the two legs are
// matched, and then both commit atomically or the reservation is unwound.
type Phase string

const (
	PhaseReserved Phase = "RESERVED"
	PhaseMatched  Phase = "MATCHED"
	PhaseSettled  Phase = "SETTLED"
	PhaseUnwound  Phase = "UNWOUND"
)

// Errors returned by rails. Callers match on these rather than on strings.
var (
	ErrInsufficientFunds  = errors.New("ERR_INSUFFICIENT_FUNDS")
	ErrLockNotFound       = errors.New("ERR_LOCK_NOT_FOUND")
	ErrLockConsumed       = errors.New("ERR_LOCK_ALREADY_CONSUMED")
	ErrLegMismatch        = errors.New("ERR_LEG_AMOUNT_MISMATCH")
	ErrInvalidAmount      = errors.New("ERR_INVALID_AMOUNT")
	ErrUnknownParticipant = errors.New("ERR_UNKNOWN_PARTICIPANT")
)

// Capabilities is what a rail honestly claims about itself. It is served verbatim by
// GET /api/umi/capabilities so that the claim is machine-checkable, not marketing copy.
type Capabilities struct {
	Rail Rail `json:"rail"`
	// Atomic reports whether both legs commit together or neither does.
	Atomic bool `json:"atomic"`
	// CentralBankMoney reports whether the cash leg settles in central bank money.
	// Only a real wholesale-CBDC connection may set this true. No rail here does.
	CentralBankMoney bool `json:"centralBankMoney"`
	// Simulated is true for every rail in this repository, without exception.
	Simulated bool `json:"simulated"`
	// RegulatoryStatus never claims an approval, connection or pilot participation.
	RegulatoryStatus string `json:"regulatoryStatus"`
	// SettlementWindow describes how long the cash leg takes to become final.
	SettlementWindow string `json:"settlementWindow"`
	// Notes is a plain-English description a non-technical reader can act on.
	Notes string `json:"notes"`
}

// DvPRequest is one delivery-versus-payment instruction: move AmountPaise from Payer
// to Payee against TokenCount units of AssetID.
type DvPRequest struct {
	DvPID       string `json:"dvpId"`
	AssetID     string `json:"assetId"`
	PayerID     string `json:"payerId"`
	PayeeID     string `json:"payeeId"`
	AmountPaise int64  `json:"amountPaise"`
	TokenCount  int64  `json:"tokenCount"`
	Reference   string `json:"reference,omitempty"`
}

// Lock is a reservation on the cash leg. Holding a Lock does not move money; it only
// guarantees the money cannot be spent elsewhere until settle or unwind.
type Lock struct {
	LockID      string    `json:"lockId"`
	DvPID       string    `json:"dvpId"`
	Rail        Rail      `json:"settlementRail"`
	PayerID     string    `json:"payerId"`
	PayeeID     string    `json:"payeeId"`
	AmountPaise int64     `json:"amountPaise"`
	Phase       Phase     `json:"phase"`
	ReservedAt  time.Time `json:"reservedAt"`
	ExpiresAt   time.Time `json:"expiresAt"`
}

// TokenLeg is the security side of the trade, as recorded by the ledger.
type TokenLeg struct {
	AssetID    string `json:"assetId"`
	FromID     string `json:"fromId"`
	ToID       string `json:"toId"`
	TokenCount int64  `json:"tokenCount"`
	// LedgerTxID is the ledger's identifier for the security leg. A rail treats this
	// as opaque; it exists so the receipt can tie both legs to one another.
	LedgerTxID string `json:"ledgerTxId"`
}

// Receipt is the proof that both legs committed together.
type Receipt struct {
	DvPID       string    `json:"dvpId"`
	Rail        Rail      `json:"settlementRail"`
	Phase       Phase     `json:"phase"`
	CashRef     string    `json:"cashRef"`    // UTR, PayU mihpayid, or simulated e₹ instruction ref
	LedgerTxID  string    `json:"ledgerTxId"` // security leg reference
	AmountPaise int64     `json:"amountPaise"`
	TokenCount  int64     `json:"tokenCount"`
	SettledAt   time.Time `json:"settledAt"`
	// Simulated is always true and is serialised on every response by contract.
	Simulated bool `json:"simulated"`
	// CentralBankMoney mirrors Capabilities and is always false in this repository.
	CentralBankMoney bool   `json:"centralBankMoney"`
	RegulatoryStatus string `json:"regulatoryStatus"`
}

// SettlementRail is the substitution boundary. A regulated participant can implement
// this against real infrastructure; the product code above it does not change.
type SettlementRail interface {
	// Name returns the stable rail identifier surfaced as `settlementRail`.
	Name() Rail

	// Capabilities returns the rail's honest self-description.
	Capabilities() Capabilities

	// Reserve locks the cash leg. It must not move money.
	Reserve(ctx context.Context, req DvPRequest) (*Lock, error)

	// AtomicSettle commits the cash leg against an already-recorded security leg.
	// It must either produce a Receipt with both references, or return an error
	// having left the cash leg untouched.
	AtomicSettle(ctx context.Context, lock *Lock, leg TokenLeg) (*Receipt, error)

	// Unwind releases a reservation without settling. It must be safe to call on an
	// already-unwound lock only by returning ErrLockConsumed, never by moving money.
	Unwind(ctx context.Context, lock *Lock, reason string) error
}

// AssertSimulated is a guard used by tests and by server start-up. It exists so that a
// rail can never silently claim to be real inside this repository.
func AssertSimulated(r SettlementRail) error {
	c := r.Capabilities()
	if !c.Simulated {
		return errors.New("rail claims to be non-simulated: refusing to run")
	}
	if c.CentralBankMoney {
		return errors.New("rail claims central bank money: refusing to run")
	}
	if c.RegulatoryStatus != StatusSimulatedNotConnected {
		return errors.New("rail must report regulatoryStatus=" + StatusSimulatedNotConnected)
	}
	return nil
}
