package drunix

// Cash leg for the Drunix ledger — the money side of Delivery-versus-Payment.
//
// WHY THIS EXISTS
//
// Before this file, the Drunix chaincode knew only about tokens:
// MintPropertyTokens, TransferTokens, DistributeYield, FreezeProperty. Money
// never existed as ledger state. "Atomic DvP" was implemented above the chain
// as two sequential ledger appends — TOKEN_TRANSFERRED, then ESCROW_RELEASED.
//
// Two appends are not one transaction. If the process died between them, the
// securities leg was committed and the cash leg was not, and no amount of
// ledger inspection afterwards could undo it. The MVCC protection the Drunix
// committing peer already provides covered the token balances only, because
// those were the only keys in the read-write set.
//
// This file puts cash on the ledger as first-class state and makes DvP a
// SINGLE chaincode invocation. Both legs land in one RW set, get one
// endorsement round, one MVCC validation and one block commit. Either both
// writes apply or neither does — enforced by the pipeline that already
// existed, not by a mutex in an application server.
//
// MONEY REPRESENTATION
//
// Every amount is an integer count of paise, stored as a decimal string.
// There is no float anywhere in this file. Binary floating point cannot
// represent 0.1 exactly, and a rounding error inside a settlement system is
// not a rounding error, it is a reconciliation break.
//
// KEY LAYOUT
//
//	cash~<party>          integer paise held by a party, decimal string
//	escrow~<paymentId>    escrow record, see escrowRecord.encode()
//	balance~<asset>~<who> token balance (pre-existing, owned by peer.go)
//
// The escrow record is a single key on purpose. Two concurrent settlements of
// the same payment both read escrow~<id> at the same version, so the second
// one to reach the committing peer fails MVCC validation. Splitting escrow
// state across several keys would open exactly the double-release window this
// design is meant to close.
//
// HONESTY
//
// This is simulated money on a simulated Drunix network. No bank account is
// debited, no RBI or NPCI system is contacted, and nothing here moves real
// value. The cash ledger models the *shape* of a wholesale settlement account
// so the atomicity property can be demonstrated and tested.

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// Chaincode function names for the cash leg.
const (
	FnCreditCash  = "CreditCash"  // fund a party's cash position (bank credit)
	FnLockEscrow  = "LockEscrow"  // move payer cash into escrow for one payment
	FnSettleDvP   = "SettleDvP"   // atomic: escrow -> seller, tokens -> buyer
	FnRefundCash  = "RefundCash"  // release escrow back to the payer
	FnCashBalance = "CashBalance" // read-only helper name, not a write path
)

// Escrow lifecycle states.
const (
	EscrowLocked   = "LOCKED"
	EscrowSettled  = "SETTLED"
	EscrowRefunded = "REFUNDED"
)

// MSPs that endorse the money leg. In the Drunix/NPCI shape the payment
// operator and the tokenisation platform are separate organisations, and a
// DvP requires both to sign — neither side can move the other's asset alone.
const (
	MSPPaymentOperator = "NPCIMSP"
	MSPPlatform        = "AasthiChainMSP"
)

// Sentinel errors so callers can branch on cause rather than string matching.
var (
	ErrInsufficientCash  = errors.New("insufficient cash balance")
	ErrInsufficientToken = errors.New("insufficient token balance")
	ErrEscrowExists      = errors.New("escrow already exists for this payment")
	ErrEscrowMissing     = errors.New("no escrow for this payment")
	ErrEscrowNotLocked   = errors.New("escrow is not in LOCKED state")
	ErrAmountNotPositive = errors.New("amount must be a positive integer number of paise")
)

// cashKey and escrowKey centralise the key layout so no caller hand-builds one.
func cashKey(party string) string       { return "cash~" + party }
func escrowKey(paymentID string) string { return "escrow~" + paymentID }
func tokenKey(assetID, owner string) string {
	return "balance~" + assetID + "~" + owner
}

// escrowRecord is the on-ledger escrow state for one payment.
//
// Encoded as a single pipe-delimited string so the whole record occupies one
// ledger key and therefore one MVCC version. Field order is fixed; adding a
// field means appending, never inserting.
type escrowRecord struct {
	PaymentID   string
	Payer       string // buyer: pays cash, receives tokens
	Payee       string // seller: receives cash, delivers tokens
	AmountPaise uint64
	AssetID     string
	Tokens      uint64
	Status      string
}

func (e escrowRecord) encode() string {
	return strings.Join([]string{
		e.PaymentID, e.Payer, e.Payee,
		strconv.FormatUint(e.AmountPaise, 10),
		e.AssetID,
		strconv.FormatUint(e.Tokens, 10),
		e.Status,
	}, "|")
}

func decodeEscrow(s string) (escrowRecord, bool) {
	if s == "" {
		return escrowRecord{}, false
	}
	p := strings.Split(s, "|")
	if len(p) != 7 {
		return escrowRecord{}, false
	}
	amount, err1 := strconv.ParseUint(p[3], 10, 64)
	tokens, err2 := strconv.ParseUint(p[5], 10, 64)
	if err1 != nil || err2 != nil {
		return escrowRecord{}, false
	}
	return escrowRecord{
		PaymentID: p[0], Payer: p[1], Payee: p[2],
		AmountPaise: amount, AssetID: p[4], Tokens: tokens, Status: p[6],
	}, true
}

// parsePaise reads a non-negative integer amount. An empty key reads as zero,
// which is how a party with no prior cash position is represented.
func parsePaise(s string) uint64 {
	if s == "" {
		return 0
	}
	n, err := strconv.ParseUint(s, 10, 64)
	if err != nil {
		return 0
	}
	return n
}

func requirePositive(s string) (uint64, error) {
	n, err := strconv.ParseUint(s, 10, 64)
	if err != nil || n == 0 {
		return 0, fmt.Errorf("%w: got %q", ErrAmountNotPositive, s)
	}
	return n, nil
}

// cashPolicyFor returns the endorsement policy for the money-leg functions.
// Reported as (policy, true) only for functions this file owns, so peer.go can
// fall through to its own policy table for everything else.
func cashPolicyFor(fn string) (EndorsementPolicy, bool) {
	switch fn {
	case FnCreditCash, FnLockEscrow, FnRefundCash:
		// Only the payment operator may create, hold or release funds.
		return EndorsementPolicy{RequiredMSPs: []string{MSPPaymentOperator}}, true
	case FnSettleDvP:
		// DvP moves cash AND securities in one transaction, so the payment
		// operator and the tokenisation platform must both endorse it.
		// This is the on-ledger expression of "neither leg without the other".
		return EndorsementPolicy{RequiredMSPs: []string{MSPPaymentOperator, MSPPlatform}}, true
	}
	return EndorsementPolicy{}, false
}

// simulateCashChaincode executes the money-leg functions against ledger state,
// recording every key touched in the RW set. Returns handled=false for
// functions it does not own.
//
// Every guard here runs at ENDORSEMENT time, before ordering. A transaction
// that fails validation never reaches a block, so an invalid settlement costs
// no ledger space and produces no committed side effect.
func simulateCashChaincode(state *StateDB, fn string, args []string, rw *RWSet) (handled bool, err error) {
	switch fn {

	case FnCreditCash: // args: party, amountPaise
		if len(args) < 2 {
			return true, fmt.Errorf("%s needs party, amountPaise", FnCreditCash)
		}
		amount, err := requirePositive(args[1])
		if err != nil {
			return true, err
		}
		key := cashKey(args[0])
		current := parsePaise(rw.read(state, key))
		rw.write(key, strconv.FormatUint(current+amount, 10))
		return true, nil

	case FnLockEscrow: // args: paymentId, payer, payee, amountPaise, assetId, tokens
		if len(args) < 6 {
			return true, fmt.Errorf("%s needs paymentId, payer, payee, amountPaise, assetId, tokens", FnLockEscrow)
		}
		paymentID, payer, payee, assetID := args[0], args[1], args[2], args[4]
		amount, err := requirePositive(args[3])
		if err != nil {
			return true, err
		}
		tokens, err := requirePositive(args[5])
		if err != nil {
			return true, err
		}

		// Re-locking the same paymentId would double-charge the payer.
		ek := escrowKey(paymentID)
		if existing := rw.read(state, ek); existing != "" {
			return true, fmt.Errorf("%w: %s", ErrEscrowExists, paymentID)
		}

		ck := cashKey(payer)
		balance := parsePaise(rw.read(state, ck))
		if balance < amount {
			return true, fmt.Errorf("%w: %s holds %d paise, needs %d (stopped at endorsement)",
				ErrInsufficientCash, payer, balance, amount)
		}

		rw.write(ck, strconv.FormatUint(balance-amount, 10))
		rw.write(ek, escrowRecord{
			PaymentID: paymentID, Payer: payer, Payee: payee,
			AmountPaise: amount, AssetID: assetID, Tokens: tokens,
			Status: EscrowLocked,
		}.encode())
		return true, nil

	case FnSettleDvP: // args: paymentId
		//
		// THE ATOMIC POINT OF THIS WHOLE FILE.
		//
		// Both legs are written into one RW set:
		//     cash:   escrow          -> payee (seller)
		//     tokens: payee (seller)  -> payer (buyer)
		//
		// One proposal, one endorsement round, one MVCC check, one block. A
		// failure anywhere below returns an error and NOTHING is written,
		// because the RW set is discarded whole.
		//
		if len(args) < 1 {
			return true, fmt.Errorf("%s needs paymentId", FnSettleDvP)
		}
		paymentID := args[0]
		ek := escrowKey(paymentID)

		esc, ok := decodeEscrow(rw.read(state, ek))
		if !ok {
			return true, fmt.Errorf("%w: %s", ErrEscrowMissing, paymentID)
		}
		if esc.Status != EscrowLocked {
			// Replay protection: a settled or refunded escrow cannot settle
			// again. Combined with the MVCC check on this same key, a
			// concurrent duplicate is rejected even if it passes this guard.
			return true, fmt.Errorf("%w: %s is %s", ErrEscrowNotLocked, paymentID, esc.Status)
		}

		// Securities leg — the seller must actually hold what they promised.
		sellerKey := tokenKey(esc.AssetID, esc.Payee)
		buyerKey := tokenKey(esc.AssetID, esc.Payer)
		sellerTokens := parsePaise(rw.read(state, sellerKey))
		if sellerTokens < esc.Tokens {
			// Cash stays in escrow. Nothing is written. The buyer's money is
			// recoverable with RefundCash — it was never handed over on a
			// promise that could not be kept.
			return true, fmt.Errorf("%w: seller %s holds %d tokens of %s, needs %d",
				ErrInsufficientToken, esc.Payee, sellerTokens, esc.AssetID, esc.Tokens)
		}
		buyerTokens := parsePaise(rw.read(state, buyerKey))

		// Cash leg — escrow is released to the seller.
		payeeCashKey := cashKey(esc.Payee)
		payeeCash := parsePaise(rw.read(state, payeeCashKey))

		rw.write(sellerKey, strconv.FormatUint(sellerTokens-esc.Tokens, 10))
		rw.write(buyerKey, strconv.FormatUint(buyerTokens+esc.Tokens, 10))
		rw.write(payeeCashKey, strconv.FormatUint(payeeCash+esc.AmountPaise, 10))

		esc.Status = EscrowSettled
		rw.write(ek, esc.encode())
		return true, nil

	case FnRefundCash: // args: paymentId
		if len(args) < 1 {
			return true, fmt.Errorf("%s needs paymentId", FnRefundCash)
		}
		paymentID := args[0]
		ek := escrowKey(paymentID)

		esc, ok := decodeEscrow(rw.read(state, ek))
		if !ok {
			return true, fmt.Errorf("%w: %s", ErrEscrowMissing, paymentID)
		}
		if esc.Status != EscrowLocked {
			return true, fmt.Errorf("%w: %s is %s", ErrEscrowNotLocked, paymentID, esc.Status)
		}

		ck := cashKey(esc.Payer)
		balance := parsePaise(rw.read(state, ck))
		rw.write(ck, strconv.FormatUint(balance+esc.AmountPaise, 10))

		esc.Status = EscrowRefunded
		rw.write(ek, esc.encode())
		return true, nil
	}

	return false, nil
}

// ---------- read-only queries (no RW set, no transaction) ----------

// CashBalanceOf reports a party's committed cash position in paise.
func CashBalanceOf(state *StateDB, party string) uint64 {
	return parsePaise(state.GetVersion(cashKey(party)).Value)
}

// TokenBalanceOf reports a party's committed token balance for one asset.
func TokenBalanceOf(state *StateDB, assetID, owner string) uint64 {
	return parsePaise(state.GetVersion(tokenKey(assetID, owner)).Value)
}

// EscrowView is the read model for one payment's escrow.
type EscrowView struct {
	PaymentID   string `json:"paymentId"`
	Payer       string `json:"payer"`
	Payee       string `json:"payee"`
	AmountPaise uint64 `json:"amountPaise"`
	AssetID     string `json:"assetId"`
	Tokens      uint64 `json:"tokens"`
	Status      string `json:"status"`
	Found       bool   `json:"found"`
	Simulated   bool   `json:"simulated"` // always true; no real money exists here
}

// EscrowOf reports the committed escrow record for a payment.
func EscrowOf(state *StateDB, paymentID string) EscrowView {
	esc, ok := decodeEscrow(state.GetVersion(escrowKey(paymentID)).Value)
	if !ok {
		return EscrowView{PaymentID: paymentID, Found: false, Simulated: true}
	}
	return EscrowView{
		PaymentID: esc.PaymentID, Payer: esc.Payer, Payee: esc.Payee,
		AmountPaise: esc.AmountPaise, AssetID: esc.AssetID, Tokens: esc.Tokens,
		Status: esc.Status, Found: true, Simulated: true,
	}
}

// ---------- pipeline conveniences ----------

// DvPResult reports both legs of a settlement and the single transaction that
// carried them, so a caller can prove the two moved together.
type DvPResult struct {
	PaymentID   string       `json:"paymentId"`
	Lock        CommitResult `json:"lock"`
	Settle      CommitResult `json:"settle"`
	AtomicTxID  string       `json:"atomicTxId"`  // the one txId holding both legs
	BlockHeight int64        `json:"blockHeight"` // the one block holding both legs
	Simulated   bool         `json:"simulated"`
}

// LockEscrow runs phase one of DvP: the payer's cash moves into escrow.
func (p *Pipeline) LockEscrow(paymentID, payer, payee string, amountPaise uint64, assetID string, tokens uint64) (CommitResult, error) {
	return p.Submit(FnLockEscrow, []string{
		paymentID, payer, payee,
		strconv.FormatUint(amountPaise, 10),
		assetID,
		strconv.FormatUint(tokens, 10),
	}, nil)
}

// SettleDvP runs phase two: one transaction moving cash and securities together.
func (p *Pipeline) SettleDvP(paymentID string) (CommitResult, error) {
	return p.Submit(FnSettleDvP, []string{paymentID}, nil)
}

// RefundCash releases a locked escrow back to the payer.
func (p *Pipeline) RefundCash(paymentID string) (CommitResult, error) {
	return p.Submit(FnRefundCash, []string{paymentID}, nil)
}

// CreditCash funds a party's cash position.
func (p *Pipeline) CreditCash(party string, amountPaise uint64) (CommitResult, error) {
	return p.Submit(FnCreditCash, []string{party, strconv.FormatUint(amountPaise, 10)}, nil)
}

// RunDvP locks the escrow then settles it, reporting both stages. The
// settlement itself is the atomic step; the lock is a separate, earlier
// transaction because the buyer's funds must be committed before the seller
// is asked to part with anything.
func (p *Pipeline) RunDvP(paymentID, payer, payee string, amountPaise uint64, assetID string, tokens uint64) (DvPResult, error) {
	out := DvPResult{PaymentID: paymentID, Simulated: true}

	lock, err := p.LockEscrow(paymentID, payer, payee, amountPaise, assetID, tokens)
	out.Lock = lock
	if err != nil {
		return out, fmt.Errorf("lock failed: %w", err)
	}

	settle, err := p.SettleDvP(paymentID)
	out.Settle = settle
	if err != nil {
		return out, fmt.Errorf("settle failed: %w", err)
	}

	out.AtomicTxID = settle.TxID
	out.BlockHeight = settle.BlockHeight
	return out, nil
}
