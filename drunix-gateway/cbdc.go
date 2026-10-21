package drunix

// Central bank digital currency as the settlement asset, on the ledger.
//
// Everything in this repository up to now kept the money beside the chain:
// tokens moved on the ledger, rupees moved in a wallet table, and the chain
// took notes. This file moves the money itself onto the ledger in the form the
// regulator is actually piloting, and the test applied to every function here
// is the same one: does this run on the chain, or is the chain only watching.
//
// Four things are modelled, each because the pilot does it:
//
//   - **Programmable money.** The sponsor binds funds to a purpose, with the
//     parameters the central bank names: an expiry date, a merchant category,
//     named merchants, a geography. Food subsidy that can only be spent at a
//     fair price shop is the live example. A spend that breaks a condition is
//     refused and the refusal is written to the chain, because a control
//     nobody can audit is indistinguishable from no control.
//
//   - **An offline path.** Connectivity is the assumption every digital
//     payment makes and rural India regularly disproves. Value is reserved
//     while online, spent as signed vouchers while offline, and reconciled on
//     reconnection. Offline money cannot be checked against the ledger at the
//     moment it moves, so it is bounded: small values, few outstanding, short
//     expiry, and a double spend is caught deterministically rather than
//     hoped against.
//
//   - **Conditional release.** Money held against a rule and paid the instant
//     an attested event satisfies it. The flight that is cancelled at 02:00
//     and the refund that lands before the passenger reaches the taxi rank.
//     Nobody files a claim; the condition was written when the money went in.
//
//   - **Both finalities, never conflated.** Technical finality is a property
//     of this ledger: the block is committed and cannot be replaced. Financial
//     finality is a property of the law: the point at which a transfer is
//     irrevocable against third parties. A payment in central bank money is
//     both at once, which is the actual argument for settling in CBDC. A
//     payment that still has to cross a commercial bank rail is technically
//     final and financially provisional until that rail's window closes, and
//     this layer says so with the window named.
//
// The limits, stated once and enforced throughout: this issues no central bank
// money, holds no settlement account, and is designated under no statute. It
// is a simulation of published pilot behaviour. Supply is conserved
// arithmetically and that invariant is checkable by anyone over HTTP.

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"
)

// Block types. Refusals are committed alongside successes.
const (
	BlockCBDCIssued            = "UMI_CBDC_ISSUED"
	BlockCBDCTransferred       = "UMI_CBDC_TRANSFERRED"
	BlockCBDCRedeemed          = "UMI_CBDC_REDEEMED"
	BlockCBDCGranted           = "UMI_CBDC_GRANTED"
	BlockCBDCSpent             = "UMI_CBDC_SPENT"
	BlockCBDCRefused           = "UMI_CBDC_REFUSED"
	BlockCBDCOfflineIssued     = "UMI_CBDC_OFFLINE_ISSUED"
	BlockCBDCOfflineRedeemed   = "UMI_CBDC_OFFLINE_REDEEMED"
	BlockCBDCConditionOpened   = "UMI_CBDC_CONDITION_OPENED"
	BlockCBDCConditionReleased = "UMI_CBDC_CONDITION_RELEASED"
	BlockCBDCConditionRefunded = "UMI_CBDC_CONDITION_REFUNDED"
)

// Wallet segments, as the pilot divides them.
const (
	CBDCRetail    = "RETAIL"    // e₹-R: people and merchants
	CBDCWholesale = "WHOLESALE" // e₹-W: banks and institutions, the UMI settlement leg
)

// KYC tiers. Caps are the shape of the rule, not a quotation of any bank's
// product terms: a minimally verified wallet holds and moves little, a fully
// verified one holds and moves more, an institution is not capped this way.
const (
	KYCMinimal = "MIN_KYC"
	KYCFull    = "FULL_KYC"
)

const (
	minKYCBalanceCapPaise   = int64(1000000)  // ₹10,000
	minKYCTransferCapPaise  = int64(1000000)  // ₹10,000
	fullKYCBalanceCapPaise  = int64(20000000) // ₹2,00,000
	fullKYCTransferCapPaise = int64(10000000) // ₹1,00,000

	// Offline bounds. The pilot's offline work is deliberately small value,
	// and so is this: an offline spend is accepted before the ledger has seen
	// it, so the exposure has to be one somebody can absorb.
	offlineVoucherCapPaise = int64(50000) // ₹500
	offlineMaxOutstanding  = 5
	offlineVoucherLife     = 72 * time.Hour

	// Above this, a movement is reportable. The shape of a cash transaction
	// report, not a copy of any institution's filing policy.
	amlReportablePaise = int64(100000000) // ₹10,00,000
)

var (
	ErrCBDCFields      = errors.New("ERR_UMI_CBDC_FIELDS")
	ErrCBDCNotFound    = errors.New("ERR_UMI_CBDC_NOT_FOUND")
	ErrCBDCFunds       = errors.New("ERR_UMI_CBDC_INSUFFICIENT")
	ErrCBDCKYCCap      = errors.New("ERR_UMI_CBDC_KYC_CAP")
	ErrCBDCCondition   = errors.New("ERR_UMI_CBDC_CONDITION")
	ErrCBDCExpired     = errors.New("ERR_UMI_CBDC_EXPIRED")
	ErrCBDCDoubleSpend = errors.New("ERR_UMI_CBDC_DOUBLE_SPEND")
	ErrCBDCOfflineCap  = errors.New("ERR_UMI_CBDC_OFFLINE_CAP")
	ErrCBDCBlocked     = errors.New("ERR_UMI_CBDC_AML_BLOCKED")
	ErrCBDCClosed      = errors.New("ERR_UMI_CBDC_CLOSED")
)

// CBDCDisclaimer travels with every response from this layer.
const CBDCDisclaimer = "Simulated central bank digital currency. No central bank money is issued here, " +
	"no settlement account is held, and this system is designated under no statute. The mechanics follow " +
	"published pilot behaviour; the money does not exist."

/* ---------------------------------------------------------------- finality */

// Finality records the two separate things that are usually said as one.
type Finality struct {
	Technical        string `json:"technical"` // FINAL_ON_LEDGER
	Height           int64  `json:"blockHeight"`
	BlockHash        string `json:"blockHash"`
	At               string `json:"at"`
	Financial        string `json:"financial"` // FINAL | PROVISIONAL
	Basis            string `json:"basis"`
	SettlementWindow string `json:"settlementWindow,omitempty"`
}

const (
	FinalityFinal       = "FINAL"
	FinalityProvisional = "PROVISIONAL"
)

// finalityFor builds the record from the committed block. CBDC legs are
// financially final on commit because the money is a claim on the issuer and
// there is no later settlement step. A leg still owed over a commercial bank
// rail is not, and carries the window that will close it.
func finalityFor(blk *DrunixBlock, bankRail bool) Finality {
	f := Finality{
		Technical: "FINAL_ON_LEDGER",
		At:        time.Now().UTC().Format(time.RFC3339Nano),
		Financial: FinalityFinal,
		Basis: "Settled in central bank money on the ledger. There is no further settlement step, " +
			"so technical and financial finality coincide.",
	}
	if blk != nil {
		f.Height = blk.Height
		f.BlockHash = blk.Hash
		f.At = blk.Timestamp
	}
	if bankRail {
		f.Financial = FinalityProvisional
		f.Basis = "The ledger entry is final, the money is not. A commercial bank leg remains " +
			"revocable until its system settles, so this is recorded as provisional rather than reported as done."
		f.SettlementWindow = "next clearing cycle of the funding rail. The ledger runs continuously; " +
			"the rail underneath it does not, and that gap is the settlement risk."
	}
	return f
}

/* ------------------------------------------------------------------ models */

// CBDCAccount holds a balance in paise. Integer paise throughout: money in
// floating point is a bug waiting for a rounding error.
type CBDCAccount struct {
	Holder          string `json:"holder"`
	Segment         string `json:"segment"`
	KYCTier         string `json:"kycTier"`
	BalancePaise    int64  `json:"balancePaise"`
	OfflineReserved int64  `json:"offlineReservedPaise"`
	LockedPaise     int64  `json:"lockedPaise"`
	OpenedAt        string `json:"openedAt"`
}

// Available is what the holder can actually move online right now.
func (w *CBDCAccount) Available() int64 {
	return w.BalancePaise - w.OfflineReserved - w.LockedPaise
}

// ProgramCondition is the purpose binding on a grant, in the parameters the
// central bank itself lists: expiry, merchant category, merchant identity and
// geography.
type ProgramCondition struct {
	Purpose            string   `json:"purpose"`
	ExpiresAt          string   `json:"expiresAt,omitempty"`
	MerchantCategories []string `json:"merchantCategories,omitempty"`
	AllowedMerchants   []string `json:"allowedMerchants,omitempty"`
	AllowedStates      []string `json:"allowedStates,omitempty"`
}

// CBDCGrant is purpose-bound money: issued to a beneficiary, spendable only
// where the conditions hold, returnable to the sponsor when it expires.
type CBDCGrant struct {
	GrantID     string           `json:"grantId"`
	Sponsor     string           `json:"sponsor"`
	Beneficiary string           `json:"beneficiary"`
	AmountPaise int64            `json:"amountPaise"`
	SpentPaise  int64            `json:"spentPaise"`
	Condition   ProgramCondition `json:"condition"`
	Status      string           `json:"status"` // OPEN | EXHAUSTED | EXPIRED
	CreatedAt   string           `json:"createdAt"`
}

// SpendContext is what a merchant presents at the point of sale.
type SpendContext struct {
	Merchant         string `json:"merchant"`
	MerchantCategory string `json:"merchantCategory"`
	State            string `json:"state"`
	AmountPaise      int64  `json:"amountPaise"`
}

// OfflineVoucher is value reserved on the ledger and carried away from it. The
// signature is what a receiving device can check with no connectivity; the
// nonce is what the ledger checks on return.
type OfflineVoucher struct {
	VoucherID   string `json:"voucherId"`
	Holder      string `json:"holder"`
	Device      string `json:"device"`
	AmountPaise int64  `json:"amountPaise"`
	Nonce       string `json:"nonce"`
	IssuedAt    string `json:"issuedAt"`
	ExpiresAt   string `json:"expiresAt"`
	Signature   string `json:"signature"`
	Status      string `json:"status"` // OUTSTANDING | REDEEMED | EXPIRED
	RedeemedBy  string `json:"redeemedBy,omitempty"`
	RedeemedAt  string `json:"redeemedAt,omitempty"`
}

// CBDCCondition is money locked against an event: the insurance refund that
// pays itself when the flight is cancelled.
type CBDCCondition struct {
	ConditionID string    `json:"conditionId"`
	Payer       string    `json:"payer"`
	Payee       string    `json:"payee"`
	AmountPaise int64     `json:"amountPaise"`
	EventType   string    `json:"eventType"`
	EventKey    string    `json:"eventKey"`
	Attestor    string    `json:"attestor"`
	Deadline    string    `json:"deadline"`
	Status      string    `json:"status"` // OPEN | RELEASED | REFUNDED
	OpenedAt    string    `json:"openedAt"`
	SettledAt   string    `json:"settledAt,omitempty"`
	Finality    *Finality `json:"finality,omitempty"`
	Note        string    `json:"note"`
}

// CBDCMovement is one movement of money, with its screening and its finality.
type CBDCMovement struct {
	MovementID  string   `json:"movementId"`
	Kind        string   `json:"kind"`
	From        string   `json:"from,omitempty"`
	To          string   `json:"to,omitempty"`
	AmountPaise int64    `json:"amountPaise"`
	Segment     string   `json:"segment"`
	Mode        string   `json:"mode"` // ONLINE | OFFLINE
	Finality    Finality `json:"finality"`
	AML         AMLCheck `json:"aml"`
	At          string   `json:"at"`
}

// AMLCheck is the screening attached to a movement. It reuses the published
// rules and the trained model from the risk layer rather than inventing a
// second opinion about the same question.
type AMLCheck struct {
	Decision     string   `json:"decision"`
	RuleScore    int      `json:"ruleScore"`
	ModelScore   int      `json:"modelScore"`
	Agreement    string   `json:"agreement"`
	Reportable   bool     `json:"reportable"`
	Reasons      []string `json:"reasons,omitempty"`
	LegalContext string   `json:"legalContext"`
}

/* ------------------------------------------------------------------ ledger */

// CBDCLedger is the whole layer. One mutex: this is money, and a clever
// locking scheme that is wrong once is worse than a coarse one that is always
// right.
type CBDCLedger struct {
	mu       sync.Mutex
	rail     *UMIRail
	chain    *DrunixChain
	secret   []byte
	issuer   string
	wallets  map[string]*CBDCAccount
	grants   map[string]*CBDCGrant
	vouchers map[string]*OfflineVoucher
	nonces   map[string]string // nonce -> voucherId, the double-spend index
	conds    map[string]*CBDCCondition
	moves    []CBDCMovement

	issuedPaise   int64
	redeemedPaise int64
}

// NewCBDCLedger wires the layer. A nil rail or chain disables it, like the
// rest of the optional surface.
func NewCBDCLedger(rail *UMIRail, chain *DrunixChain) *CBDCLedger {
	if rail == nil || chain == nil {
		return nil
	}
	secret := strings.TrimSpace(os.Getenv("CBDC_DEVICE_SECRET"))
	if secret == "" {
		// A per-process key. Vouchers do not survive a restart, which is the
		// honest behaviour for a demo: better that they stop verifying than
		// that they verify against a key printed in the source.
		b := make([]byte, 32)
		_, _ = rand.Read(b)
		secret = hex.EncodeToString(b)
	}
	return &CBDCLedger{
		rail:     rail,
		chain:    chain,
		secret:   []byte(secret),
		issuer:   "rbi-cbdc-issuer",
		wallets:  map[string]*CBDCAccount{},
		grants:   map[string]*CBDCGrant{},
		vouchers: map[string]*OfflineVoucher{},
		nonces:   map[string]string{},
		conds:    map[string]*CBDCCondition{},
	}
}

func cbdcID(prefix string) string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return prefix + "-" + fmt.Sprint(time.Now().UnixNano())
	}
	return prefix + "-" + strings.ToUpper(hex.EncodeToString(b))
}

// walletLocked fetches or opens a wallet. Caller holds l.mu.
func (l *CBDCLedger) walletLocked(holder, segment, tier string) *CBDCAccount {
	holder = strings.TrimSpace(holder)
	if w, ok := l.wallets[holder]; ok {
		return w
	}
	if segment == "" {
		segment = CBDCRetail
	}
	if tier == "" {
		tier = KYCMinimal
	}
	w := &CBDCAccount{
		Holder: holder, Segment: segment, KYCTier: tier,
		OpenedAt: time.Now().UTC().Format(time.RFC3339),
	}
	l.wallets[holder] = w
	return w
}

// capsFor returns the balance and per-movement ceilings for a wallet. An
// institution on the wholesale segment is not capped by retail KYC tiers.
func capsFor(w *CBDCAccount) (balanceCap, transferCap int64) {
	if w.Segment == CBDCWholesale {
		return 0, 0 // uncapped
	}
	if w.KYCTier == KYCFull {
		return fullKYCBalanceCapPaise, fullKYCTransferCapPaise
	}
	return minKYCBalanceCapPaise, minKYCTransferCapPaise
}

/* ---------------------------------------------------------------- issuance */

// Issue creates central bank money into a wallet. `fundedByBankRail` records
// the honest case: the holder's bank has been debited over a rail that has not
// settled yet, so the ledger entry is final and the funding is not.
func (l *CBDCLedger) Issue(holder, segment, tier string, amountPaise int64, fundedByBankRail bool, by string) (*CBDCAccount, *CBDCMovement, error) {
	if strings.TrimSpace(holder) == "" || amountPaise <= 0 {
		return nil, nil, fmt.Errorf("%w: holder and a positive amount in paise are required", ErrCBDCFields)
	}
	l.mu.Lock()
	defer l.mu.Unlock()

	w := l.walletLocked(holder, segment, tier)
	if cap, _ := capsFor(w); cap > 0 && w.BalancePaise+amountPaise > cap {
		return nil, nil, fmt.Errorf("%w: a %s wallet holds at most %s, and this issue would take it to %s",
			ErrCBDCKYCCap, w.KYCTier, rupees(cap), rupees(w.BalancePaise+amountPaise))
	}
	w.BalancePaise += amountPaise
	l.issuedPaise += amountPaise

	blk := l.rail.append(BlockCBDCIssued, map[string]interface{}{
		"kind":        "cbdc-issued",
		"holder":      holder,
		"segment":     w.Segment,
		"amountPaise": amountPaise,
		"issuer":      l.issuer,
		"by":          by,
		"funding":     fundingLabel(fundedByBankRail),
		"effect":      "Central bank money created into a wallet on this ledger. Supply rises by this amount.",
		"disclaimer":  CBDCDisclaimer,
	})
	mv := l.recordLocked(CBDCMovement{
		MovementID: cbdcID("CBDC-ISS"), Kind: "ISSUE", To: holder,
		AmountPaise: amountPaise, Segment: w.Segment, Mode: "ONLINE",
		Finality: finalityFor(blk, fundedByBankRail),
		AML: AMLCheck{Decision: DecisionApprove, Reportable: amountPaise >= amlReportablePaise,
			LegalContext: "Issuance is the central bank's own act; the screening that matters is on movement."},
	})
	return w, mv, nil
}

func fundingLabel(bankRail bool) string {
	if bankRail {
		return "debited over a commercial bank rail that has not settled yet"
	}
	return "issued directly by the central bank role"
}

// Redeem destroys money back to the issuer. Supply falls: the same arithmetic
// in reverse, so the conservation check still balances.
func (l *CBDCLedger) Redeem(holder string, amountPaise int64, by string) (*CBDCAccount, *CBDCMovement, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	w, ok := l.wallets[strings.TrimSpace(holder)]
	if !ok {
		return nil, nil, fmt.Errorf("%w: no wallet for %q", ErrCBDCNotFound, holder)
	}
	if amountPaise <= 0 || w.Available() < amountPaise {
		return nil, nil, fmt.Errorf("%w: %s available, %s requested", ErrCBDCFunds, rupees(w.Available()), rupees(amountPaise))
	}
	w.BalancePaise -= amountPaise
	l.redeemedPaise += amountPaise

	blk := l.rail.append(BlockCBDCRedeemed, map[string]interface{}{
		"kind": "cbdc-redeemed", "holder": holder, "amountPaise": amountPaise,
		"by": by, "effect": "Money returned to the issuer and destroyed. Supply falls by this amount.",
		"disclaimer": CBDCDisclaimer,
	})
	mv := l.recordLocked(CBDCMovement{
		MovementID: cbdcID("CBDC-RED"), Kind: "REDEEM", From: holder,
		AmountPaise: amountPaise, Segment: w.Segment, Mode: "ONLINE",
		Finality: finalityFor(blk, false),
		AML:      AMLCheck{Decision: DecisionApprove, LegalContext: "Redemption to the issuing authority."},
	})
	return w, mv, nil
}

/* ---------------------------------------------------------------- transfer */

// Transfer moves money between wallets, screened on the way through.
func (l *CBDCLedger) Transfer(from, to string, amountPaise int64) (*CBDCMovement, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.transferLocked(from, to, amountPaise, "TRANSFER", "ONLINE", nil)
}

func (l *CBDCLedger) transferLocked(from, to string, amountPaise int64, kind, mode string, extra map[string]interface{}) (*CBDCMovement, error) {
	from, to = strings.TrimSpace(from), strings.TrimSpace(to)
	if from == "" || to == "" || from == to || amountPaise <= 0 {
		return nil, fmt.Errorf("%w: two different holders and a positive amount are required", ErrCBDCFields)
	}
	src, ok := l.wallets[from]
	if !ok {
		return nil, fmt.Errorf("%w: no wallet for %q", ErrCBDCNotFound, from)
	}
	if src.Available() < amountPaise {
		return nil, fmt.Errorf("%w: %s available, %s requested", ErrCBDCFunds, rupees(src.Available()), rupees(amountPaise))
	}
	if _, tcap := capsFor(src); tcap > 0 && amountPaise > tcap {
		return nil, fmt.Errorf("%w: a %s wallet moves at most %s in one payment", ErrCBDCKYCCap, src.KYCTier, rupees(tcap))
	}
	dst := l.walletLocked(to, src.Segment, KYCMinimal)
	if bcap, _ := capsFor(dst); bcap > 0 && dst.BalancePaise+amountPaise > bcap {
		return nil, fmt.Errorf("%w: the receiving %s wallet cannot hold more than %s", ErrCBDCKYCCap, dst.KYCTier, rupees(bcap))
	}

	aml := l.screenLocked(from, amountPaise)
	if aml.Decision == DecisionBlock {
		l.rail.append(BlockCBDCRefused, map[string]interface{}{
			"kind": "cbdc-refused", "reason": "AML_BLOCKED", "from": from, "to": to,
			"amountPaise": amountPaise, "ruleScore": aml.RuleScore, "modelScore": aml.ModelScore,
			"reasons": aml.Reasons, "disclaimer": CBDCDisclaimer,
			"effect": "The payment did not happen. The refusal is on the chain so the control can be audited.",
		})
		return nil, fmt.Errorf("%w: screening blocked this payment (%s)", ErrCBDCBlocked, strings.Join(aml.Reasons, "; "))
	}

	src.BalancePaise -= amountPaise
	dst.BalancePaise += amountPaise

	txn := map[string]interface{}{
		"kind": "cbdc-transferred", "from": from, "to": to, "amountPaise": amountPaise,
		"segment": src.Segment, "mode": mode, "amlDecision": aml.Decision,
		"reportable": aml.Reportable, "disclaimer": CBDCDisclaimer,
		"effect": "Money moved between wallets on this ledger. Central bank money, so the transfer is " +
			"final when the block commits.",
	}
	for k, v := range extra {
		txn[k] = v
	}
	blk := l.rail.append(BlockCBDCTransferred, txn)

	mv := l.recordLocked(CBDCMovement{
		MovementID: cbdcID("CBDC-MOV"), Kind: kind, From: from, To: to,
		AmountPaise: amountPaise, Segment: src.Segment, Mode: mode,
		Finality: finalityFor(blk, false), AML: aml,
	})
	return mv, nil
}

// screenLocked runs the published rules and the trained model over the
// movement. Reportability is arithmetic and separate from the model: a large
// payment is reportable whatever any classifier thinks of it.
func (l *CBDCLedger) screenLocked(payer string, amountPaise int64) AMLCheck {
	amount := float64(amountPaise) / 100
	recent := []float64{}
	var total24h float64
	count10m, count24h := 0, 0
	cutoff10m := time.Now().UTC().Add(-10 * time.Minute)
	for i := len(l.moves) - 1; i >= 0 && len(recent) < 10; i-- {
		m := l.moves[i]
		if m.From != payer {
			continue
		}
		v := float64(m.AmountPaise) / 100
		recent = append(recent, v)
		total24h += v
		count24h++
		if at, err := time.Parse(time.RFC3339Nano, m.At); err == nil && at.After(cutoff10m) {
			count10m++
		}
	}
	in := PaymentInput{PaymentID: cbdcID("AML"), PayerID: payer, AmountINR: amount, CreatedAt: time.Now().UTC()}
	h := HistorySummary{
		TxnCount10m: count10m, TxnCount24h: count24h, TotalINR24h: total24h + amount,
		RecentINR: recent, AccountAgeMin: 10000, KYCVerified: true,
	}
	a := AssessPayment(in, h, DefaultThresholds())

	out := AMLCheck{
		Decision: a.Decision, RuleScore: a.Rules.Score, Agreement: a.Agreement,
		Reportable: amountPaise >= amlReportablePaise,
		LegalContext: "Screening under the money-laundering rules of the jurisdiction this rail models. " +
			"The published rules decide; the trained model is advisory and is reported beside them.",
	}
	if a.Model != nil {
		out.ModelScore = a.Model.Score
	}
	for _, f := range a.Rules.Factors {
		out.Reasons = append(out.Reasons, f.Note)
	}
	if out.Reportable {
		out.Reasons = append(out.Reasons,
			"above the reporting threshold of "+rupees(amlReportablePaise)+", so it is reportable regardless of score")
	}
	return out
}

func (l *CBDCLedger) recordLocked(m CBDCMovement) *CBDCMovement {
	m.At = time.Now().UTC().Format(time.RFC3339Nano)
	l.moves = append(l.moves, m)
	if len(l.moves) > 2000 {
		l.moves = l.moves[len(l.moves)-2000:]
	}
	return &l.moves[len(l.moves)-1]
}

/* ------------------------------------------------------- programmable money */

// Grant issues purpose-bound money to a beneficiary. The money is real money
// in the beneficiary's wallet; what the grant adds is a condition the rail
// enforces at the point of spending.
func (l *CBDCLedger) Grant(sponsor, beneficiary string, amountPaise int64, cond ProgramCondition) (*CBDCGrant, error) {
	if strings.TrimSpace(cond.Purpose) == "" {
		return nil, fmt.Errorf("%w: purpose-bound money needs a stated purpose", ErrCBDCFields)
	}
	l.mu.Lock()
	defer l.mu.Unlock()

	if _, err := l.transferLocked(sponsor, beneficiary, amountPaise, "GRANT", "ONLINE", map[string]interface{}{
		"purpose": cond.Purpose,
	}); err != nil {
		return nil, err
	}
	g := &CBDCGrant{
		GrantID: cbdcID("CBDC-GRANT"), Sponsor: sponsor, Beneficiary: beneficiary,
		AmountPaise: amountPaise, Condition: cond, Status: "OPEN",
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
	}
	l.grants[g.GrantID] = g

	l.rail.append(BlockCBDCGranted, map[string]interface{}{
		"kind": "cbdc-granted", "grantId": g.GrantID, "sponsor": sponsor, "beneficiary": beneficiary,
		"amountPaise": amountPaise, "purpose": cond.Purpose, "expiresAt": cond.ExpiresAt,
		"merchantCategories": cond.MerchantCategories, "allowedMerchants": cond.AllowedMerchants,
		"allowedStates": cond.AllowedStates, "disclaimer": CBDCDisclaimer,
		"effect": "Money bound to a purpose. A spend outside these conditions is refused by the rail, " +
			"not by a reconciliation after the fact.",
	})
	return g, nil
}

// Spend draws against a grant at a merchant. Every condition is checked before
// anything moves, and a failure is written to the chain with the reason.
func (l *CBDCLedger) Spend(grantID string, ctx SpendContext, now time.Time) (*CBDCGrant, *CBDCMovement, error) {
	l.mu.Lock()
	defer l.mu.Unlock()

	g, ok := l.grants[strings.TrimSpace(grantID)]
	if !ok {
		return nil, nil, fmt.Errorf("%w: no grant %q", ErrCBDCNotFound, grantID)
	}
	if g.Status != "OPEN" {
		return nil, nil, fmt.Errorf("%w: this grant is %s", ErrCBDCClosed, g.Status)
	}
	if ctx.AmountPaise <= 0 {
		return nil, nil, fmt.Errorf("%w: a positive amount is required", ErrCBDCFields)
	}

	refuse := func(reason, detail string, err error) (*CBDCGrant, *CBDCMovement, error) {
		l.rail.append(BlockCBDCRefused, map[string]interface{}{
			"kind": "cbdc-refused", "reason": reason, "grantId": g.GrantID,
			"beneficiary": g.Beneficiary, "merchant": ctx.Merchant,
			"merchantCategory": ctx.MerchantCategory, "state": ctx.State,
			"amountPaise": ctx.AmountPaise, "detail": detail, "disclaimer": CBDCDisclaimer,
			"effect": "The spend did not happen. Programmability is only credible when the refusals are " +
				"as visible as the payments.",
		})
		return nil, nil, fmt.Errorf("%w: %s", err, detail)
	}

	if g.Condition.ExpiresAt != "" {
		if exp, err := time.Parse(time.RFC3339, g.Condition.ExpiresAt); err == nil && now.After(exp) {
			g.Status = "EXPIRED"
			return refuse("EXPIRED", "the grant expired at "+g.Condition.ExpiresAt, ErrCBDCExpired)
		}
	}
	if n := len(g.Condition.MerchantCategories); n > 0 && !containsFold(g.Condition.MerchantCategories, ctx.MerchantCategory) {
		return refuse("CATEGORY", "this money is spendable only at "+strings.Join(g.Condition.MerchantCategories, ", ")+
			", and the merchant is categorised "+orNone(ctx.MerchantCategory), ErrCBDCCondition)
	}
	if n := len(g.Condition.AllowedMerchants); n > 0 && !containsFold(g.Condition.AllowedMerchants, ctx.Merchant) {
		return refuse("MERCHANT", "merchant "+orNone(ctx.Merchant)+" is not on the list this grant names", ErrCBDCCondition)
	}
	if n := len(g.Condition.AllowedStates); n > 0 && !containsFold(g.Condition.AllowedStates, ctx.State) {
		return refuse("GEOGRAPHY", "this grant is spendable in "+strings.Join(g.Condition.AllowedStates, ", ")+
			", and the spend is in "+orNone(ctx.State), ErrCBDCCondition)
	}
	if g.SpentPaise+ctx.AmountPaise > g.AmountPaise {
		return refuse("EXHAUSTED", "only "+rupees(g.AmountPaise-g.SpentPaise)+" remains on this grant", ErrCBDCFunds)
	}

	mv, err := l.transferLocked(g.Beneficiary, ctx.Merchant, ctx.AmountPaise, "SPEND", "ONLINE", map[string]interface{}{
		"grantId": g.GrantID, "purpose": g.Condition.Purpose, "merchantCategory": ctx.MerchantCategory,
	})
	if err != nil {
		return nil, nil, err
	}
	g.SpentPaise += ctx.AmountPaise
	if g.SpentPaise >= g.AmountPaise {
		g.Status = "EXHAUSTED"
	}
	l.rail.append(BlockCBDCSpent, map[string]interface{}{
		"kind": "cbdc-spent", "grantId": g.GrantID, "merchant": ctx.Merchant,
		"merchantCategory": ctx.MerchantCategory, "state": ctx.State,
		"amountPaise": ctx.AmountPaise, "remainingPaise": g.AmountPaise - g.SpentPaise,
		"purpose": g.Condition.Purpose, "disclaimer": CBDCDisclaimer,
		"effect": "Purpose-bound money spent where its conditions allowed it.",
	})
	return g, mv, nil
}

/* -------------------------------------------------------- offline protocol */

// IssueOffline reserves value on the ledger and hands back a signed voucher
// the holder can spend with no connectivity. The reservation is the whole
// trick: the money is already gone from the online balance, so an offline
// spend cannot create money, only move money that was set aside.
func (l *CBDCLedger) IssueOffline(holder, device string, amountPaise int64, now time.Time) (*OfflineVoucher, error) {
	if strings.TrimSpace(device) == "" {
		return nil, fmt.Errorf("%w: a device identifier is required, because the voucher is bound to it", ErrCBDCFields)
	}
	if amountPaise <= 0 || amountPaise > offlineVoucherCapPaise {
		return nil, fmt.Errorf("%w: an offline voucher is capped at %s, which bounds what an undetected "+
			"double spend can cost", ErrCBDCOfflineCap, rupees(offlineVoucherCapPaise))
	}
	l.mu.Lock()
	defer l.mu.Unlock()

	w, ok := l.wallets[strings.TrimSpace(holder)]
	if !ok {
		return nil, fmt.Errorf("%w: no wallet for %q", ErrCBDCNotFound, holder)
	}
	outstanding := 0
	for _, v := range l.vouchers {
		if v.Holder == w.Holder && v.Status == "OUTSTANDING" {
			outstanding++
		}
	}
	if outstanding >= offlineMaxOutstanding {
		return nil, fmt.Errorf("%w: %d vouchers are already outstanding, which is the limit", ErrCBDCOfflineCap, outstanding)
	}
	if w.Available() < amountPaise {
		return nil, fmt.Errorf("%w: %s available to reserve", ErrCBDCFunds, rupees(w.Available()))
	}

	nonceBytes := make([]byte, 16)
	_, _ = rand.Read(nonceBytes)
	v := &OfflineVoucher{
		VoucherID: cbdcID("CBDC-OFF"), Holder: w.Holder, Device: strings.TrimSpace(device),
		AmountPaise: amountPaise, Nonce: hex.EncodeToString(nonceBytes),
		IssuedAt: now.UTC().Format(time.RFC3339), ExpiresAt: now.UTC().Add(offlineVoucherLife).Format(time.RFC3339),
		Status: "OUTSTANDING",
	}
	v.Signature = l.signVoucher(v)
	w.OfflineReserved += amountPaise
	l.vouchers[v.VoucherID] = v

	l.rail.append(BlockCBDCOfflineIssued, map[string]interface{}{
		"kind": "cbdc-offline-issued", "voucherId": v.VoucherID, "holder": v.Holder,
		"device": v.Device, "amountPaise": amountPaise, "expiresAt": v.ExpiresAt,
		"disclaimer": CBDCDisclaimer,
		"effect": "Value reserved on the ledger and carried off it. The online balance is already reduced, " +
			"so spending this voucher cannot create money.",
	})
	return v, nil
}

// signVoucher is the device-checkable signature. Symmetric, because in this
// design both the issuing rail and the accepting device are provisioned by the
// same operator; a production build would use per-device asymmetric keys so an
// accepting device cannot mint vouchers.
func (l *CBDCLedger) signVoucher(v *OfflineVoucher) string {
	mac := hmac.New(sha256.New, l.secret)
	fmt.Fprintf(mac, "%s|%s|%s|%d|%s|%s", v.VoucherID, v.Holder, v.Device, v.AmountPaise, v.Nonce, v.ExpiresAt)
	return hex.EncodeToString(mac.Sum(nil))
}

// RedeemOffline is what happens when the accepting device gets a signal back.
// Three ways this fails and all of them are detected rather than assumed away:
// a forged signature, an expired voucher, and the same voucher presented
// twice.
func (l *CBDCLedger) RedeemOffline(v OfflineVoucher, payee string, now time.Time) (*CBDCMovement, error) {
	l.mu.Lock()
	defer l.mu.Unlock()

	held, ok := l.vouchers[strings.TrimSpace(v.VoucherID)]
	if !ok {
		return nil, fmt.Errorf("%w: no voucher %q was ever issued by this rail", ErrCBDCNotFound, v.VoucherID)
	}
	if !hmac.Equal([]byte(v.Signature), []byte(held.Signature)) || v.AmountPaise != held.AmountPaise {
		l.rail.append(BlockCBDCRefused, map[string]interface{}{
			"kind": "cbdc-refused", "reason": "BAD_VOUCHER_SIGNATURE", "voucherId": v.VoucherID,
			"disclaimer": CBDCDisclaimer,
			"effect":     "An offline voucher was presented that this rail did not sign for that amount.",
		})
		return nil, fmt.Errorf("%w: the voucher signature does not match what this rail issued", ErrCBDCCondition)
	}
	if held.Status == "REDEEMED" {
		// The failure mode that defines offline money. Caught on the first
		// presentation after the first, named as what it is, and written down.
		l.rail.append(BlockCBDCRefused, map[string]interface{}{
			"kind": "cbdc-refused", "reason": "DOUBLE_SPEND", "voucherId": held.VoucherID,
			"holder": held.Holder, "firstRedeemedBy": held.RedeemedBy, "firstRedeemedAt": held.RedeemedAt,
			"attemptedBy": payee, "amountPaise": held.AmountPaise, "disclaimer": CBDCDisclaimer,
			"effect": "The same offline voucher was presented twice. The second presentation is refused and " +
				"recorded against the holder's device.",
		})
		return nil, fmt.Errorf("%w: voucher %s was already redeemed by %s at %s",
			ErrCBDCDoubleSpend, held.VoucherID, held.RedeemedBy, held.RedeemedAt)
	}
	if exp, err := time.Parse(time.RFC3339, held.ExpiresAt); err == nil && now.After(exp) {
		held.Status = "EXPIRED"
		if w, ok := l.wallets[held.Holder]; ok {
			w.OfflineReserved -= held.AmountPaise
		}
		return nil, fmt.Errorf("%w: the voucher expired at %s and its value has returned to the online balance",
			ErrCBDCExpired, held.ExpiresAt)
	}

	// Release the reservation, then move the money for real.
	w := l.wallets[held.Holder]
	w.OfflineReserved -= held.AmountPaise
	mv, err := l.transferLocked(held.Holder, payee, held.AmountPaise, "OFFLINE_REDEEM", "OFFLINE", map[string]interface{}{
		"voucherId": held.VoucherID, "device": held.Device,
	})
	if err != nil {
		w.OfflineReserved += held.AmountPaise // put it back: nothing moved
		return nil, err
	}
	held.Status = "REDEEMED"
	held.RedeemedBy = payee
	held.RedeemedAt = now.UTC().Format(time.RFC3339)

	l.rail.append(BlockCBDCOfflineRedeemed, map[string]interface{}{
		"kind": "cbdc-offline-redeemed", "voucherId": held.VoucherID, "holder": held.Holder,
		"payee": payee, "amountPaise": held.AmountPaise, "device": held.Device,
		"disclaimer": CBDCDisclaimer,
		"effect": "An offline payment reconciled against the ledger. The payment happened when the two " +
			"devices met; this is when the ledger learned about it.",
	})
	return mv, nil
}

/* ----------------------------------------------------- conditional release */

// OpenCondition locks money against an event. The cancelled flight and the
// refund that pays itself: nobody files a claim, because the rule was written
// when the money went in.
func (l *CBDCLedger) OpenCondition(payer, payee string, amountPaise int64, eventType, eventKey, attestor string, deadline time.Time) (*CBDCCondition, error) {
	if strings.TrimSpace(eventType) == "" || strings.TrimSpace(eventKey) == "" || strings.TrimSpace(attestor) == "" {
		return nil, fmt.Errorf("%w: an event type, a key and the party trusted to attest it are required", ErrCBDCFields)
	}
	l.mu.Lock()
	defer l.mu.Unlock()

	w, ok := l.wallets[strings.TrimSpace(payer)]
	if !ok {
		return nil, fmt.Errorf("%w: no wallet for %q", ErrCBDCNotFound, payer)
	}
	if amountPaise <= 0 || w.Available() < amountPaise {
		return nil, fmt.Errorf("%w: %s available to lock", ErrCBDCFunds, rupees(w.Available()))
	}
	w.LockedPaise += amountPaise

	c := &CBDCCondition{
		ConditionID: cbdcID("CBDC-COND"), Payer: payer, Payee: payee, AmountPaise: amountPaise,
		EventType: strings.ToUpper(strings.TrimSpace(eventType)), EventKey: strings.TrimSpace(eventKey),
		Attestor: attestor, Deadline: deadline.UTC().Format(time.RFC3339), Status: "OPEN",
		OpenedAt: time.Now().UTC().Format(time.RFC3339),
		Note: "The money is locked, not promised. It pays the moment the named party attests the event, " +
			"and returns to the payer if the deadline passes without one.",
	}
	l.conds[c.ConditionID] = c

	l.rail.append(BlockCBDCConditionOpened, map[string]interface{}{
		"kind": "cbdc-condition-opened", "conditionId": c.ConditionID, "payer": payer, "payee": payee,
		"amountPaise": amountPaise, "eventType": c.EventType, "eventKey": c.EventKey,
		"attestor": attestor, "deadline": c.Deadline, "disclaimer": CBDCDisclaimer,
		"effect": "Money locked against a rule. Release is automatic and needs no claim, no form and no " +
			"call centre.",
	})
	return c, nil
}

// SubmitEvent is the oracle call: the airline says the flight was cancelled.
// Every open condition waiting on that event pays immediately. Only the party
// named at the time the money was locked can attest it, which is the whole
// security model and is checked rather than assumed.
func (l *CBDCLedger) SubmitEvent(attestor, eventType, eventKey string, now time.Time) ([]*CBDCCondition, error) {
	l.mu.Lock()
	defer l.mu.Unlock()

	eventType = strings.ToUpper(strings.TrimSpace(eventType))
	eventKey = strings.TrimSpace(eventKey)
	released := []*CBDCCondition{}
	for _, c := range l.conds {
		if c.Status != "OPEN" || c.EventType != eventType || c.EventKey != eventKey {
			continue
		}
		if !strings.EqualFold(c.Attestor, attestor) {
			l.rail.append(BlockCBDCRefused, map[string]interface{}{
				"kind": "cbdc-refused", "reason": "WRONG_ATTESTOR", "conditionId": c.ConditionID,
				"expected": c.Attestor, "presented": attestor, "disclaimer": CBDCDisclaimer,
				"effect": "An event was submitted by a party this condition does not trust. Nothing moved.",
			})
			continue
		}
		w := l.wallets[c.Payer]
		w.LockedPaise -= c.AmountPaise
		mv, err := l.transferLocked(c.Payer, c.Payee, c.AmountPaise, "CONDITION_RELEASE", "ONLINE", map[string]interface{}{
			"conditionId": c.ConditionID, "eventType": eventType, "eventKey": eventKey,
		})
		if err != nil {
			w.LockedPaise += c.AmountPaise
			continue
		}
		c.Status = "RELEASED"
		c.SettledAt = now.UTC().Format(time.RFC3339)
		f := mv.Finality
		c.Finality = &f
		released = append(released, c)

		l.rail.append(BlockCBDCConditionReleased, map[string]interface{}{
			"kind": "cbdc-condition-released", "conditionId": c.ConditionID, "payer": c.Payer,
			"payee": c.Payee, "amountPaise": c.AmountPaise, "eventType": eventType,
			"eventKey": eventKey, "attestor": attestor, "disclaimer": CBDCDisclaimer,
			"effect": "The condition was satisfied and the money paid itself. No claim was filed.",
		})
	}
	return released, nil
}

// SweepConditions returns locked money whose deadline passed with no event.
// Money that can be locked but never unlocked is a trap, so this runs on read
// as well as on a timer.
func (l *CBDCLedger) SweepConditions(now time.Time) []*CBDCCondition {
	l.mu.Lock()
	defer l.mu.Unlock()
	refunded := []*CBDCCondition{}
	for _, c := range l.conds {
		if c.Status != "OPEN" {
			continue
		}
		dl, err := time.Parse(time.RFC3339, c.Deadline)
		if err != nil || !now.After(dl) {
			continue
		}
		if w, ok := l.wallets[c.Payer]; ok {
			w.LockedPaise -= c.AmountPaise
		}
		c.Status = "REFUNDED"
		c.SettledAt = now.UTC().Format(time.RFC3339)
		refunded = append(refunded, c)
		l.rail.append(BlockCBDCConditionRefunded, map[string]interface{}{
			"kind": "cbdc-condition-refunded", "conditionId": c.ConditionID, "payer": c.Payer,
			"amountPaise": c.AmountPaise, "deadline": c.Deadline, "disclaimer": CBDCDisclaimer,
			"effect": "The deadline passed with no attested event, so the lock was released back to the payer.",
		})
	}
	return refunded
}

/* -------------------------------------------------------------- read paths */

// Conservation is the invariant anybody can check: everything issued is either
// held in a wallet or has been redeemed. Published rather than asserted.
func (l *CBDCLedger) Conservation() map[string]interface{} {
	l.mu.Lock()
	defer l.mu.Unlock()
	var held, reserved, locked int64
	for _, w := range l.wallets {
		held += w.BalancePaise
		reserved += w.OfflineReserved
		locked += w.LockedPaise
	}
	outstanding := l.issuedPaise - l.redeemedPaise
	return map[string]interface{}{
		"issuedPaise":          l.issuedPaise,
		"redeemedPaise":        l.redeemedPaise,
		"outstandingPaise":     outstanding,
		"heldInWalletsPaise":   held,
		"offlineReservedPaise": reserved,
		"lockedInConditions":   locked,
		"conserved":            outstanding == held,
		"meaning": "Every paise issued is either sitting in a wallet or has been redeemed. Offline " +
			"reservations and locked conditions are held inside wallet balances, not outside them.",
	}
}

// Status is the public description of the layer.
func (l *CBDCLedger) Status() map[string]interface{} {
	l.mu.Lock()
	wallets, grants, vouchers, conds, moves := len(l.wallets), len(l.grants), len(l.vouchers), len(l.conds), len(l.moves)
	l.mu.Unlock()
	return map[string]interface{}{
		"segments": []string{CBDCRetail, CBDCWholesale},
		"counts": map[string]int{
			"wallets": wallets, "grants": grants, "offlineVouchers": vouchers,
			"conditions": conds, "movements": moves,
		},
		"policy": map[string]interface{}{
			"kycTiers": map[string]interface{}{
				KYCMinimal: map[string]string{"balanceCap": rupees(minKYCBalanceCapPaise), "perPayment": rupees(minKYCTransferCapPaise)},
				KYCFull:    map[string]string{"balanceCap": rupees(fullKYCBalanceCapPaise), "perPayment": rupees(fullKYCTransferCapPaise)},
			},
			"offline": map[string]interface{}{
				"voucherCap": rupees(offlineVoucherCapPaise), "maxOutstanding": offlineMaxOutstanding,
				"life": offlineVoucherLife.String(),
				"why":  "An offline spend is accepted before the ledger sees it, so the exposure is bounded on purpose.",
			},
			"amlReportableAbove": rupees(amlReportablePaise),
		},
		"finality": map[string]string{
			"technical": "The block is committed and cannot be replaced. Milliseconds, continuously, with no cut-off.",
			"financial": "Irrevocable against third parties. In central bank money that is the same moment; " +
				"over a commercial bank rail it is not, and the gap is reported rather than hidden.",
		},
		"conservation": l.Conservation(),
		"disclaimer":   CBDCDisclaimer,
	}
}

// Wallets lists every wallet, smallest surface that is still useful.
func (l *CBDCLedger) Wallets() []CBDCAccount {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]CBDCAccount, 0, len(l.wallets))
	for _, w := range l.wallets {
		out = append(out, *w)
	}
	return out
}

func (l *CBDCLedger) Wallet(holder string) (CBDCAccount, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	w, ok := l.wallets[strings.TrimSpace(holder)]
	if !ok {
		return CBDCAccount{}, false
	}
	return *w, true
}

func (l *CBDCLedger) Grants() []CBDCGrant {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]CBDCGrant, 0, len(l.grants))
	for _, g := range l.grants {
		out = append(out, *g)
	}
	return out
}

func (l *CBDCLedger) Conditions() []CBDCCondition {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]CBDCCondition, 0, len(l.conds))
	for _, c := range l.conds {
		out = append(out, *c)
	}
	return out
}

// Movements returns the most recent movements, newest first.
func (l *CBDCLedger) Movements(limit int) []CBDCMovement {
	l.mu.Lock()
	defer l.mu.Unlock()
	if limit <= 0 || limit > len(l.moves) {
		limit = len(l.moves)
	}
	out := make([]CBDCMovement, 0, limit)
	for i := len(l.moves) - 1; i >= 0 && len(out) < limit; i-- {
		out = append(out, l.moves[i])
	}
	return out
}

/* ------------------------------------------------------------------ helpers */

func containsFold(list []string, v string) bool {
	v = strings.TrimSpace(v)
	if v == "" {
		return false
	}
	for _, item := range list {
		if strings.EqualFold(strings.TrimSpace(item), v) {
			return true
		}
	}
	return false
}

func orNone(v string) string {
	if strings.TrimSpace(v) == "" {
		return "(none given)"
	}
	return v
}

// rupees formats paise for a human, which is who reads the error messages.
func rupees(paise int64) string {
	return fmt.Sprintf("₹%.2f", float64(paise)/100)
}
