package drunix

// Cross-border corridors: the same payment, five different sets of rules.
//
// "Cross-border" is not one thing, and treating it as one is how a demo ends
// up claiming more than it does. Sending money out of India can mean a
// correspondent bank chain, a card scheme's own rail, an aggregator operating
// under its own authorisation, a direct link between two domestic schemes, or
// two central bank ledgers settling against each other. Those differ in who
// is allowed to do it, how much can move, how long the money is at risk, and
// what the receiver is actually relying on when they hand over the goods.
//
// So each corridor is modelled separately, with its own licence requirement,
// its own caps and its own settlement model. A payment is refused by the
// corridor that cannot carry it, and the refusal names the authorisation that
// is missing instead of returning a generic error.
//
// THE CASE THIS FILE EXISTS FOR
//
// Whether both legs sit on the same ledger changes everything, and it is the
// question the public precedents actually answer:
//
//   - **One ledger.** mBridge put several central banks' money on a single
//     platform and settled foreign exchange atomically: initiation, commit,
//     execute, with both legs settling or neither. No correspondent chain, no
//     principal risk in the gap, seconds instead of three to five days. Where
//     both participants hold accounts here, this layer does the same thing,
//     in one block.
//
//   - **Two ledgers.** Jasper-Ubin linked a Corda network in Canada and a
//     Quorum network in Singapore with hash time-locked contracts: a secret's
//     hash commits both sides, revealing the secret claims both, and a
//     timeout refunds if it never appears. No shared platform and no trusted
//     intermediary. Where the far leg is on a ledger this rail does not
//     control, that is what this layer implements, including the refund path,
//     which is the half that gets skipped in demonstrations.
//
// What is deliberately not claimed: this holds no authorisation of any kind.
// The licences below are declared in configuration so the gate can be seen
// working; declaring one here grants nothing in the real world.

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"
)

const (
	BlockCorridorInitiated = "UMI_CORRIDOR_INITIATED"
	BlockCorridorSettled   = "UMI_CORRIDOR_SETTLED"
	BlockCorridorLocked    = "UMI_CORRIDOR_LOCKED"
	BlockCorridorClaimed   = "UMI_CORRIDOR_CLAIMED"
	BlockCorridorRefunded  = "UMI_CORRIDOR_REFUNDED"
	BlockCorridorRefused   = "UMI_CORRIDOR_REFUSED"
)

// Settlement models, which is the thing that actually differs between rails.
const (
	SettleAtomicOnLedger = "ATOMIC_ON_LEDGER"   // both legs here, one block, no gap
	SettleHTLCCrossChain = "HTLC_CROSS_LEDGER"  // two ledgers, hash and timeout
	SettleDeferredBank   = "DEFERRED_BANK_LEG"  // correspondent or aggregator window
	SettleCardScheme     = "CARD_SCHEME_WINDOW" // authorised now, settled later
)

// Transfer states.
const (
	CorridorSettled       = "SETTLED"
	CorridorAwaitingClaim = "AWAITING_CLAIM"
	CorridorAwaitingLeg   = "AWAITING_FOREIGN_LEG"
	CorridorRefunded      = "REFUNDED"
)

var (
	ErrCorridorUnknown  = errors.New("ERR_UMI_CORRIDOR_UNKNOWN")
	ErrCorridorLicence  = errors.New("ERR_UMI_CORRIDOR_LICENCE")
	ErrCorridorCap      = errors.New("ERR_UMI_CORRIDOR_CAP")
	ErrCorridorPurpose  = errors.New("ERR_UMI_CORRIDOR_PURPOSE")
	ErrCorridorTravel   = errors.New("ERR_UMI_CORRIDOR_TRAVEL_RULE")
	ErrCorridorFields   = errors.New("ERR_UMI_CORRIDOR_FIELDS")
	ErrCorridorNotFound = errors.New("ERR_UMI_CORRIDOR_NOT_FOUND")
	ErrCorridorState    = errors.New("ERR_UMI_CORRIDOR_STATE")
	ErrCorridorSecret   = errors.New("ERR_UMI_CORRIDOR_SECRET")
)

// CorridorDisclaimer travels with every response from this layer.
const CorridorDisclaimer = "Simulated cross-border corridors. This deployment holds no payment licence, " +
	"no correspondent relationship and no scheme membership. Licences are declared in configuration so the " +
	"gate can be observed working, and declaring one grants nothing."

// Travel Rule threshold and the reporting line, in paise.
const (
	travelRulePaise     = int64(8850000)   // about USD 1,000 at the published rate
	corridorReportPaise = int64(100000000) // ₹10,00,000
)

// Corridor is one way money can leave or enter the country, with the rules
// that attach to that way and nothing borrowed from another.
type Corridor struct {
	ID              string   `json:"id"`
	Name            string   `json:"name"`
	Lane            string   `json:"lane"`
	SettlementModel string   `json:"settlementModel"`
	Licences        []string `json:"licencesRequired"`
	PerTxnCapPaise  int64    `json:"perTransactionCapPaise,omitempty"`
	MonthlyCapPaise int64    `json:"monthlyCapPaise,omitempty"`
	PurposeCodes    []string `json:"purposeCodes,omitempty"`
	SameLedger      bool     `json:"bothLegsOnThisLedger"`
	Window          string   `json:"settlementWindow"`
	Precedent       string   `json:"precedent"`
	Note            string   `json:"note"`
}

// corridorCatalogue is the published set. The numbers are the public ones and
// are cited in docs/CORRIDORS.md rather than invented here.
func corridorCatalogue() []Corridor {
	return []Corridor{
		{
			ID: "NIPL-P2P-NP", Name: "Scheme to scheme, person to person (India to Nepal)",
			Lane: "UPI to NPI", SettlementModel: SettleDeferredBank,
			Licences:       []string{"NPCI_SCHEME_MEMBER", "AD_BANK_SPONSORSHIP"},
			PerTxnCapPaise: 1500000, MonthlyCapPaise: 10000000,
			PurposeCodes: []string{"P2P_REMITTANCE"},
			Window:       "the two schemes settle on their own cycles, so the beneficiary is credited before the institutions are square",
			Precedent:    "The UPI to NPI link that went live in June 2026: real-time to the user, scheme settlement behind it.",
			Note:         "Person to person only. A merchant payment is a different corridor with different rules.",
		},
		{
			ID: "PACB-ECOM", Name: "Payment aggregator, cross border (e-commerce)",
			Lane: "Indian buyer or seller to an overseas counterparty", SettlementModel: SettleDeferredBank,
			Licences:       []string{"RBI_PA_CB_AUTHORISATION", "FIU_INDIA_REGISTRATION"},
			PerTxnCapPaise: 250000000,
			PurposeCodes:   []string{"IMPORT_GOODS", "IMPORT_SERVICES", "EXPORT_GOODS", "EXPORT_SERVICES"},
			Window:         "funds pass through a collection account at an authorised dealer bank before they reach the far side",
			Precedent:      "The Payment Aggregator Directions of September 2025: authorisation, a net worth test and a per-transaction ceiling.",
			Note:           "Current account transactions not prohibited under the foreign exchange law, through e-commerce, for onboarded merchants.",
		},
		{
			ID: "BANK-CORRESPONDENT", Name: "Bank to bank through correspondents",
			Lane: "Authorised dealer bank to overseas bank", SettlementModel: SettleDeferredBank,
			Licences:     []string{"AD_CATEGORY_I_BANK"},
			PurposeCodes: []string{"IMPORT_GOODS", "IMPORT_SERVICES", "FAMILY_MAINTENANCE", "EDUCATION", "P2P_REMITTANCE"},
			Window:       "three to five business days through the correspondent chain, with the money at risk for the whole of it",
			Precedent:    "The model every multi-CBDC experiment measures itself against, and the reason they exist.",
			Note:         "Each hop charges and each hop can hold. The delay is the product of the chain, not of any one bank.",
		},
		{
			ID: "CARD-SCHEME", Name: "Card network rail",
			Lane: "Cardholder to overseas merchant", SettlementModel: SettleCardScheme,
			Licences:     []string{"CARD_SCHEME_MEMBERSHIP", "PCI_DSS"},
			PurposeCodes: []string{"IMPORT_GOODS", "IMPORT_SERVICES"},
			Window:       "authorisation is instant and settlement is not: the scheme clears later, and a chargeback can reverse it afterwards",
			Precedent:    "The networks run their own rails under their own rules, which is a different corridor rather than a variant of the others.",
			Note:         "The merchant sees an approval, which is a guarantee of payment and not a payment.",
		},
		{
			ID: "MULTI-CBDC-PVP", Name: "Multi-CBDC, both legs on this ledger",
			Lane: "Central bank money against central bank money", SettlementModel: SettleAtomicOnLedger,
			Licences:   []string{},
			SameLedger: true,
			Window:     "none: both legs commit in the same block or neither does",
			Precedent:  "mBridge, where several central banks' money sat on one platform and foreign exchange settled atomically in seconds rather than days.",
			Note:       "This is the case where the ledger genuinely removes the risk rather than recording it.",
		},
		{
			ID: "HTLC-LINKED", Name: "Two ledgers, hash time-locked",
			Lane: "This ledger to a ledger nobody here controls", SettlementModel: SettleHTLCCrossChain,
			Licences:  []string{},
			Window:    "until the secret is revealed or the timeout expires, whichever comes first",
			Precedent: "Jasper-Ubin, which joined a Corda network and a Quorum network with hash time-locked contracts and no trusted intermediary.",
			Note:      "Atomicity without a shared platform. The refund path is as important as the claim path and is implemented here.",
		},
	}
}

// CorridorTransfer is one payment, with everything that was checked.
type CorridorTransfer struct {
	TransferID    string   `json:"transferId"`
	CorridorID    string   `json:"corridorId"`
	Payer         string   `json:"payer"`
	Payee         string   `json:"payee"`
	AmountPaise   int64    `json:"amountPaise"`
	PurposeCode   string   `json:"purposeCode"`
	Status        string   `json:"status"`
	Finality      Finality `json:"finality"`
	Reportable    bool     `json:"reportable"`
	TravelRule    bool     `json:"travelRuleApplied"`
	HashLock      string   `json:"hashLock,omitempty"`
	TimeoutAt     string   `json:"timeoutAt,omitempty"`
	Secret        string   `json:"secretRevealed,omitempty"`
	ForeignLedger string   `json:"foreignLedger,omitempty"`
	OpenedAt      string   `json:"openedAt"`
	SettledAt     string   `json:"settledAt,omitempty"`
	Note          string   `json:"note"`
}

// CorridorDesk holds the corridors and the payments crossing them.
type CorridorDesk struct {
	mu        sync.Mutex
	rail      *UMIRail
	chain     *DrunixChain
	cbdc      *CBDCLedger
	licences  map[string]bool
	corridors map[string]Corridor
	transfers map[string]*CorridorTransfer
	order     []string

	// AML is optional. When a desk is attached, the parties named under the
	// Travel Rule are screened before anything moves, and a listed name
	// stops the payment instead of being noticed afterwards.
	AML *AMLDesk
}

// NewCorridorDesk wires the layer. Licences come from CORRIDOR_LICENCES as a
// comma separated list; the default set deliberately leaves two corridors
// unauthorised so the gate is visible rather than theoretical.
func NewCorridorDesk(rail *UMIRail, chain *DrunixChain, cbdc *CBDCLedger) *CorridorDesk {
	if rail == nil || chain == nil || cbdc == nil {
		return nil
	}
	declared := strings.TrimSpace(os.Getenv("CORRIDOR_LICENCES"))
	if declared == "" {
		declared = "NPCI_SCHEME_MEMBER,AD_BANK_SPONSORSHIP,AD_CATEGORY_I_BANK"
	}
	held := map[string]bool{}
	for _, l := range strings.Split(declared, ",") {
		if l = strings.ToUpper(strings.TrimSpace(l)); l != "" {
			held[l] = true
		}
	}
	d := &CorridorDesk{
		rail: rail, chain: chain, cbdc: cbdc, licences: held,
		corridors: map[string]Corridor{}, transfers: map[string]*CorridorTransfer{},
	}
	for _, c := range corridorCatalogue() {
		d.corridors[c.ID] = c
	}
	return d
}

// suspense is where money sits while a corridor's far leg is outstanding. It
// is an account on this ledger, so the money is always somewhere and the
// conservation check still balances.
func suspenseFor(corridorID string) string { return "suspense:" + corridorID }

/* ----------------------------------------------------------------- quoting */

// CorridorCheck is the answer to "can this payment use this corridor", with
// every reason it cannot.
type CorridorCheck struct {
	CorridorID      string   `json:"corridorId"`
	Eligible        bool     `json:"eligible"`
	Refusals        []string `json:"refusals,omitempty"`
	MissingLicences []string `json:"missingLicences,omitempty"`
	Reportable      bool     `json:"reportable"`
	TravelRule      bool     `json:"travelRuleApplies"`
	Settlement      string   `json:"settlementModel"`
	Window          string   `json:"settlementWindow"`
	Finality        string   `json:"financialFinality"`
}

// Check runs the gate without moving anything.
// timer starts a per-path measurement (see pathspeed.go).
func (d *CorridorDesk) timer(name string) *pathTimer {
	if d == nil || d.rail == nil {
		return nil
	}
	return d.rail.speed.begin(name)
}

func (d *CorridorDesk) Check(corridorID string, amountPaise int64, purpose, payer string, now time.Time) (_res CorridorCheck, err error) {
	spd := d.timer("corridor.check")
	defer func() { spd.done(err == nil) }()
	d.mu.Lock()
	spd.locked()
	defer d.mu.Unlock()
	return d.checkLocked(corridorID, amountPaise, purpose, payer, now)
}

func (d *CorridorDesk) checkLocked(corridorID string, amountPaise int64, purpose, payer string, now time.Time) (CorridorCheck, error) {
	c, ok := d.corridors[strings.TrimSpace(corridorID)]
	if !ok {
		return CorridorCheck{}, fmt.Errorf("%w: no corridor %q. Ask /umi/corridors for the list", ErrCorridorUnknown, corridorID)
	}
	out := CorridorCheck{
		CorridorID: c.ID, Eligible: true, Settlement: c.SettlementModel, Window: c.Window,
		Reportable: amountPaise >= corridorReportPaise,
		TravelRule: amountPaise >= travelRulePaise,
		Finality:   financialFinalityOf(c),
	}
	for _, l := range c.Licences {
		if !d.licences[l] {
			out.Eligible = false
			out.MissingLicences = append(out.MissingLicences, l)
			out.Refusals = append(out.Refusals,
				"this corridor needs "+humanLicence(l)+", which this deployment does not hold")
		}
	}
	if amountPaise <= 0 {
		out.Eligible = false
		out.Refusals = append(out.Refusals, "a positive amount is required")
	}
	if c.PerTxnCapPaise > 0 && amountPaise > c.PerTxnCapPaise {
		out.Eligible = false
		out.Refusals = append(out.Refusals, "the per-transaction ceiling on this corridor is "+rupees(c.PerTxnCapPaise))
	}
	if len(c.PurposeCodes) > 0 && !containsFold(c.PurposeCodes, purpose) {
		out.Eligible = false
		out.Refusals = append(out.Refusals,
			"this corridor carries "+strings.Join(c.PurposeCodes, ", ")+" and the purpose given is "+orNone(purpose))
	}
	if c.MonthlyCapPaise > 0 {
		used := d.monthlyUsedLocked(payer, c.ID, now)
		if used+amountPaise > c.MonthlyCapPaise {
			out.Eligible = false
			out.Refusals = append(out.Refusals, fmt.Sprintf(
				"the monthly ceiling is %s and %s has already moved %s on this corridor in the last thirty days",
				rupees(c.MonthlyCapPaise), payer, rupees(used)))
		}
	}
	return out, nil
}

func (d *CorridorDesk) monthlyUsedLocked(payer, corridorID string, now time.Time) int64 {
	cut := now.Add(-30 * 24 * time.Hour)
	var used int64
	for _, t := range d.transfers {
		if t.Payer != payer || t.CorridorID != corridorID || t.Status == CorridorRefunded {
			continue
		}
		if at, err := time.Parse(time.RFC3339Nano, t.OpenedAt); err == nil && at.After(cut) {
			used += t.AmountPaise
		}
	}
	return used
}

func financialFinalityOf(c Corridor) string {
	if c.SettlementModel == SettleAtomicOnLedger {
		return FinalityFinal
	}
	return FinalityProvisional
}

func humanLicence(code string) string {
	switch code {
	case "RBI_PA_CB_AUTHORISATION":
		return "a cross-border payment aggregator authorisation"
	case "FIU_INDIA_REGISTRATION":
		return "registration with the financial intelligence unit"
	case "AD_CATEGORY_I_BANK":
		return "authorised dealer bank status"
	case "AD_BANK_SPONSORSHIP":
		return "sponsorship by an authorised dealer bank"
	case "NPCI_SCHEME_MEMBER":
		return "membership of the domestic scheme"
	case "CARD_SCHEME_MEMBERSHIP":
		return "card scheme membership"
	case "PCI_DSS":
		return "card data security certification"
	}
	return strings.ToLower(strings.ReplaceAll(code, "_", " "))
}

/* --------------------------------------------------------------- initiating */

// SendRequest is one cross-border payment as asked for.
type SendRequest struct {
	CorridorID    string `json:"corridorId"`
	Payer         string `json:"payer"`
	Payee         string `json:"payee"`
	AmountPaise   int64  `json:"amountPaise"`
	PurposeCode   string `json:"purposeCode"`
	Originator    string `json:"originator"`
	Beneficiary   string `json:"beneficiary"`
	HashLock      string `json:"hashLock"`
	TimeoutHours  int    `json:"timeoutHours"`
	ForeignLedger string `json:"foreignLedger"`
}

// Send puts a payment on a corridor. What happens next depends entirely on
// the settlement model, which is the point of the whole file.
func (d *CorridorDesk) Send(req SendRequest, now time.Time) (_tr *CorridorTransfer, err error) {
	spd := d.timer("corridor.send")
	defer func() { spd.done(err == nil) }()
	d.mu.Lock()
	spd.locked()
	defer d.mu.Unlock()

	chk, err := d.checkLocked(req.CorridorID, req.AmountPaise, req.PurposeCode, req.Payer, now)
	if err != nil {
		return nil, err
	}
	c := d.corridors[req.CorridorID]

	// The Travel Rule: above the threshold, both ends have to be named. A
	// payment that cannot say who is sending and who is receiving does not
	// travel, rather than travelling with the fields left blank.
	if chk.TravelRule && (strings.TrimSpace(req.Originator) == "" || strings.TrimSpace(req.Beneficiary) == "") {
		d.refuseLocked(c, req, "TRAVEL_RULE", "above "+rupees(travelRulePaise)+" the originator and the beneficiary must both be identified")
		return nil, fmt.Errorf("%w: above %s this corridor carries originator and beneficiary details, and one of them is missing",
			ErrCorridorTravel, rupees(travelRulePaise))
	}
	// Sanctions and PEP screening, before the money moves rather than in a
	// report the following morning. Only the names the Travel Rule already
	// requires are screened; a corridor that carries no names has nothing to
	// screen, which is itself worth knowing.
	if d.AML != nil {
		scr := d.AML.ScreenParties(req.Originator, req.Beneficiary)
		switch scr.Decision {
		case AMLBlock:
			d.AML.OpenCase(scr, req.Payer, req.CorridorID, req.Payee, req.AmountPaise)
			d.refuseLocked(c, req, "SANCTIONS", scr.Note)
			return nil, fmt.Errorf("%w: %s", ErrAMLBlocked, scr.Note)
		case AMLReview:
			// A near match is a question, not an answer. The payment goes,
			// and a case is open before it lands.
			d.AML.OpenCase(scr, req.Payer, req.CorridorID, req.Payee, req.AmountPaise)
		}
	}

	if !chk.Eligible {
		reason := "INELIGIBLE"
		errOut := ErrCorridorCap
		if len(chk.MissingLicences) > 0 {
			reason, errOut = "LICENCE", ErrCorridorLicence
		} else if len(c.PurposeCodes) > 0 && !containsFold(c.PurposeCodes, req.PurposeCode) {
			reason, errOut = "PURPOSE", ErrCorridorPurpose
		}
		d.refuseLocked(c, req, reason, strings.Join(chk.Refusals, "; "))
		return nil, fmt.Errorf("%w: %s", errOut, strings.Join(chk.Refusals, "; "))
	}

	t := &CorridorTransfer{
		TransferID: cbdcID("CBX"), CorridorID: c.ID, Payer: req.Payer, Payee: req.Payee,
		AmountPaise: req.AmountPaise, PurposeCode: strings.ToUpper(strings.TrimSpace(req.PurposeCode)),
		Reportable: chk.Reportable, TravelRule: chk.TravelRule,
		OpenedAt: now.UTC().Format(time.RFC3339Nano), ForeignLedger: req.ForeignLedger,
	}

	switch c.SettlementModel {
	case SettleAtomicOnLedger:
		// Both legs here. One movement, one block, nothing in between for
		// anybody to lose.
		mv, err := d.cbdc.Transfer(req.Payer, req.Payee, req.AmountPaise)
		if err != nil {
			return nil, err
		}
		t.Status = CorridorSettled
		t.SettledAt = now.UTC().Format(time.RFC3339Nano)
		t.Finality = mv.Finality
		t.Note = "Both legs settled on this ledger in the same movement. There was no window in which one " +
			"side had paid and the other had not."

	case SettleHTLCCrossChain:
		if !isHex64(req.HashLock) {
			return nil, fmt.Errorf("%w: a cross-ledger transfer needs the hash of a secret (64 hex characters)", ErrCorridorFields)
		}
		hours := req.TimeoutHours
		if hours <= 0 {
			hours = 24
		}
		// Money leaves the payer into corridor suspense. It is committed and
		// it is not the payee's yet: that is the honest state.
		mv, err := d.cbdc.Transfer(req.Payer, suspenseFor(c.ID), req.AmountPaise)
		if err != nil {
			return nil, err
		}
		t.Status = CorridorAwaitingClaim
		t.HashLock = strings.ToLower(req.HashLock)
		t.TimeoutAt = now.UTC().Add(time.Duration(hours) * time.Hour).Format(time.RFC3339)
		f := mv.Finality
		f.Financial = FinalityProvisional
		f.SettlementWindow = "until the secret is revealed or the lock times out at " + t.TimeoutAt
		f.Basis = "The money has left the payer and has not reached the payee. Revealing the secret claims " +
			"both legs; letting the clock run returns both. Neither side can take one leg alone."
		t.Finality = f
		t.Note = "Hash time-locked across two ledgers, after the Jasper-Ubin design: no shared platform and " +
			"no intermediary trusted with the gap."

	default: // deferred bank leg or card scheme
		mv, err := d.cbdc.Transfer(req.Payer, suspenseFor(c.ID), req.AmountPaise)
		if err != nil {
			return nil, err
		}
		t.Status = CorridorAwaitingLeg
		f := mv.Finality
		f.Financial = FinalityProvisional
		f.SettlementWindow = c.Window
		f.Basis = "The ledger entry is final. The payment is not, because the leg that completes it runs " +
			"on a system with its own clock."
		t.Finality = f
		t.Note = "Awaiting confirmation from the far side. Until that arrives this is a claim on an " +
			"institution, not settled money."
	}

	d.transfers[t.TransferID] = t
	d.order = append(d.order, t.TransferID)

	d.rail.append(BlockCorridorInitiated, map[string]interface{}{
		"kind": "corridor-initiated", "transferId": t.TransferID, "corridorId": c.ID,
		"settlementModel": c.SettlementModel, "payer": t.Payer, "payee": t.Payee,
		"amountPaise": t.AmountPaise, "purposeCode": t.PurposeCode,
		"travelRule": t.TravelRule, "reportable": t.Reportable, "status": t.Status,
		"financialFinality": t.Finality.Financial, "disclaimer": CorridorDisclaimer,
		"effect": "A cross-border payment entered a corridor under that corridor's rules.",
	})
	if t.Status == CorridorSettled {
		d.rail.append(BlockCorridorSettled, map[string]interface{}{
			"kind": "corridor-settled", "transferId": t.TransferID, "corridorId": c.ID,
			"amountPaise": t.AmountPaise, "disclaimer": CorridorDisclaimer,
			"effect": "Both legs settled atomically on this ledger.",
		})
	} else if t.Status == CorridorAwaitingClaim {
		d.rail.append(BlockCorridorLocked, map[string]interface{}{
			"kind": "corridor-locked", "transferId": t.TransferID, "hashLock": t.HashLock,
			"timeoutAt": t.TimeoutAt, "foreignLedger": t.ForeignLedger, "disclaimer": CorridorDisclaimer,
			"effect": "Value locked against a hash. It can only move by revealing the secret or by timing out.",
		})
	}
	return t, nil
}

func (d *CorridorDesk) refuseLocked(c Corridor, req SendRequest, reason, detail string) {
	d.rail.append(BlockCorridorRefused, map[string]interface{}{
		"kind": "corridor-refused", "corridorId": c.ID, "reason": reason,
		"payer": req.Payer, "payee": req.Payee, "amountPaise": req.AmountPaise,
		"purposeCode": req.PurposeCode, "detail": detail, "disclaimer": CorridorDisclaimer,
		"effect": "The payment did not enter the corridor. The rule that stopped it is named here so it " +
			"can be audited rather than guessed at.",
	})
}

/* ------------------------------------------------------------ claim, refund */

// Claim completes a hash time-locked transfer by revealing the secret. The
// preimage is checked, not taken on trust: this is the mechanism that makes a
// two-ledger swap atomic without anybody holding both sides.
func (d *CorridorDesk) Claim(transferID, secret string, now time.Time) (_tr *CorridorTransfer, err error) {
	spd := d.timer("corridor.claim")
	defer func() { spd.done(err == nil) }()
	d.mu.Lock()
	spd.locked()
	defer d.mu.Unlock()

	t, ok := d.transfers[strings.TrimSpace(transferID)]
	if !ok {
		return nil, fmt.Errorf("%w: no transfer %q", ErrCorridorNotFound, transferID)
	}
	if t.Status != CorridorAwaitingClaim {
		return nil, fmt.Errorf("%w: this transfer is %s", ErrCorridorState, t.Status)
	}
	if to, err := time.Parse(time.RFC3339, t.TimeoutAt); err == nil && now.After(to) {
		return nil, fmt.Errorf("%w: the lock expired at %s and the money is refundable, not claimable",
			ErrCorridorState, t.TimeoutAt)
	}
	sum := sha256.Sum256([]byte(secret))
	if hex.EncodeToString(sum[:]) != t.HashLock {
		d.rail.append(BlockCorridorRefused, map[string]interface{}{
			"kind": "corridor-refused", "reason": "BAD_PREIMAGE", "transferId": t.TransferID,
			"disclaimer": CorridorDisclaimer,
			"effect":     "A claim was presented with a secret that does not hash to the lock. Nothing moved.",
		})
		return nil, fmt.Errorf("%w: that secret does not hash to this transfer's lock", ErrCorridorSecret)
	}

	if _, err := d.cbdc.Transfer(suspenseFor(t.CorridorID), t.Payee, t.AmountPaise); err != nil {
		return nil, err
	}
	t.Status = CorridorSettled
	t.Secret = secret
	t.SettledAt = now.UTC().Format(time.RFC3339Nano)
	t.Finality.Financial = FinalityFinal
	t.Finality.SettlementWindow = ""
	t.Finality.Basis = "The secret was revealed, so both legs are claimable and the gap is closed."

	d.rail.append(BlockCorridorClaimed, map[string]interface{}{
		"kind": "corridor-claimed", "transferId": t.TransferID, "corridorId": t.CorridorID,
		"payee": t.Payee, "amountPaise": t.AmountPaise, "secret": secret,
		"disclaimer": CorridorDisclaimer,
		"effect": "Revealing the secret here also reveals it to the counterparty on the other ledger, " +
			"which is what makes the two legs one transaction.",
	})
	return t, nil
}

// ConfirmLeg is the far institution reporting that its side completed. Only
// then does a deferred corridor become financially final.
func (d *CorridorDesk) ConfirmLeg(transferID, attestor string, now time.Time) (_tr *CorridorTransfer, err error) {
	spd := d.timer("corridor.confirm")
	defer func() { spd.done(err == nil) }()
	d.mu.Lock()
	spd.locked()
	defer d.mu.Unlock()

	t, ok := d.transfers[strings.TrimSpace(transferID)]
	if !ok {
		return nil, fmt.Errorf("%w: no transfer %q", ErrCorridorNotFound, transferID)
	}
	if t.Status != CorridorAwaitingLeg {
		return nil, fmt.Errorf("%w: this transfer is %s", ErrCorridorState, t.Status)
	}
	if _, err := d.cbdc.Transfer(suspenseFor(t.CorridorID), t.Payee, t.AmountPaise); err != nil {
		return nil, err
	}
	t.Status = CorridorSettled
	t.SettledAt = now.UTC().Format(time.RFC3339Nano)
	t.Finality.Financial = FinalityFinal
	t.Finality.SettlementWindow = ""
	t.Finality.Basis = "The far leg was confirmed by " + attestor + ", so the payment is irrevocable rather than merely recorded."

	d.rail.append(BlockCorridorSettled, map[string]interface{}{
		"kind": "corridor-settled", "transferId": t.TransferID, "corridorId": t.CorridorID,
		"confirmedBy": attestor, "amountPaise": t.AmountPaise, "disclaimer": CorridorDisclaimer,
		"effect": "A deferred corridor reached financial finality. Until this point the ledger entry was " +
			"final and the money was not.",
	})
	return t, nil
}

// Sweep returns money whose lock or window expired. The refund path is the
// half of an atomic swap that gets skipped in demonstrations, so it runs on
// read as well as on a timer.
func (d *CorridorDesk) Sweep(now time.Time) []*CorridorTransfer {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := []*CorridorTransfer{}
	for _, t := range d.transfers {
		if t.Status != CorridorAwaitingClaim {
			continue
		}
		to, err := time.Parse(time.RFC3339, t.TimeoutAt)
		if err != nil || !now.After(to) {
			continue
		}
		if _, err := d.cbdc.Transfer(suspenseFor(t.CorridorID), t.Payer, t.AmountPaise); err != nil {
			continue
		}
		t.Status = CorridorRefunded
		t.SettledAt = now.UTC().Format(time.RFC3339Nano)
		t.Finality.Financial = FinalityFinal
		t.Finality.Basis = "The lock expired without the secret, so the money returned to the payer and the " +
			"far leg cannot have completed either."
		out = append(out, t)
		d.rail.append(BlockCorridorRefunded, map[string]interface{}{
			"kind": "corridor-refunded", "transferId": t.TransferID, "corridorId": t.CorridorID,
			"payer": t.Payer, "amountPaise": t.AmountPaise, "timeoutAt": t.TimeoutAt,
			"disclaimer": CorridorDisclaimer,
			"effect": "A time-locked transfer that was never claimed returned to the payer. Nobody is out " +
				"of pocket on either ledger.",
		})
	}
	return out
}

/* ------------------------------------------------------------- read surface */

func (d *CorridorDesk) Corridors() []Corridor {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := make([]Corridor, 0, len(d.corridors))
	for _, c := range corridorCatalogue() {
		if live, ok := d.corridors[c.ID]; ok {
			out = append(out, live)
		}
	}
	return out
}

// Status describes the desk, including which corridors this deployment could
// not use if any of this were real.
func (d *CorridorDesk) Status() map[string]interface{} {
	d.mu.Lock()
	held := make([]string, 0, len(d.licences))
	for l := range d.licences {
		held = append(held, l)
	}
	open, awaiting, settled, refunded := 0, 0, 0, 0
	for _, t := range d.transfers {
		switch t.Status {
		case CorridorSettled:
			settled++
		case CorridorAwaitingClaim:
			open++
		case CorridorAwaitingLeg:
			awaiting++
		case CorridorRefunded:
			refunded++
		}
	}
	d.mu.Unlock()

	usable := []string{}
	blocked := map[string][]string{}
	for _, c := range d.Corridors() {
		missing := []string{}
		for _, l := range c.Licences {
			if !d.licences[l] {
				missing = append(missing, humanLicence(l))
			}
		}
		if len(missing) == 0 {
			usable = append(usable, c.ID)
		} else {
			blocked[c.ID] = missing
		}
	}
	return map[string]interface{}{
		"corridors":        d.Corridors(),
		"licencesDeclared": held,
		"usableCorridors":  usable,
		"blockedCorridors": blocked,
		"transfers": map[string]int{
			"settled": settled, "awaitingClaim": open, "awaitingForeignLeg": awaiting, "refunded": refunded,
		},
		"thresholds": map[string]string{
			"travelRule": rupees(travelRulePaise) + " and above carries originator and beneficiary details",
			"reporting":  rupees(corridorReportPaise) + " and above is reportable",
		},
		"theQuestionThatMatters": "Whether both legs sit on this ledger. If they do, settlement is atomic and " +
			"there is no window in which one side has paid and the other has not. If they do not, the gap is " +
			"real and is closed either by a revealed secret or by somebody's clearing cycle.",
		"disclaimer": CorridorDisclaimer,
	}
}

func (d *CorridorDesk) Transfers(limit int) []CorridorTransfer {
	d.mu.Lock()
	defer d.mu.Unlock()
	if limit <= 0 || limit > len(d.order) {
		limit = len(d.order)
	}
	out := make([]CorridorTransfer, 0, limit)
	for i := len(d.order) - 1; i >= 0 && len(out) < limit; i-- {
		if t, ok := d.transfers[d.order[i]]; ok {
			out = append(out, *t)
		}
	}
	return out
}

func (d *CorridorDesk) Transfer(id string) (CorridorTransfer, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	t, ok := d.transfers[strings.TrimSpace(id)]
	if !ok {
		return CorridorTransfer{}, false
	}
	return *t, true
}

func isHex64(s string) bool {
	s = strings.ToLower(strings.TrimSpace(s))
	if len(s) != 64 {
		return false
	}
	_, err := hex.DecodeString(s)
	return err == nil
}
