package drunix

// Interoperability: paying somebody who holds a different kind of money.
//
// A digital rupee that can only pay another digital rupee wallet is a closed
// loop, and a closed loop is why most pilots stay pilots. The question that
// decides whether this is usable is whether a holder can pay a shopkeeper who
// has never opened a CBDC wallet, and whether a bank deposit can become
// central bank money and back again without either disappearing or appearing
// twice.
//
// The design here follows what the e-rupee pilot actually did: rather than
// asking merchants to accept a new instrument, the CBDC was made payable
// against the QR codes the country already has. The merchant does not opt in
// to a new rail, and the payer chooses the instrument.
//
// WHAT INTEROPERABILITY ACTUALLY COSTS
//
// Every pair of instruments has the same three questions, and this layer
// refuses to blur any of them:
//
//   - **Which leg is final, and when.** A digital rupee leg settles on this
//     ledger in the block it lands in. A bank leg settles on the scheme's own
//     cycle, which is later. A payment that crosses the two is final on one
//     side before the other, and saying "instant" would be a lie about the
//     half nobody can see.
//   - **Who holds the claim in the gap.** Between the two legs somebody is
//     exposed, and it is never nobody. Here the money sits in a named
//     interop suspense account, which is visible rather than implied.
//   - **Whether the total changed.** Converting a tokenised deposit into
//     central bank money must destroy exactly as much deposit as it creates
//     in e-rupee. Interoperability is the easiest place in a system like
//     this to accidentally create money, so the conversion is one operation
//     with one identity to check.
//
// WHAT IS SIMULATED
//
// There is no connection to any payment scheme, no bank, and no second
// central bank. The far leg of a bank payment is marked provisional and
// settles only when somebody records that the scheme settled, which in this
// deployment is a person pressing a button. The tokenised deposit is a
// balance this process keeps, not a claim on any real institution. What is
// real: the instrument matrix, the finality each pair produces, the suspense
// account, the conservation check across a conversion, and the refusals.

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

const (
	BlockInteropPaid    = "UMI_CBDC_INTEROP_PAID"
	BlockInteropSettled = "UMI_CBDC_INTEROP_SETTLED"
	BlockInteropConvert = "UMI_CBDC_INTEROP_CONVERTED"
	BlockInteropRefused = "UMI_CBDC_INTEROP_REFUSED"
)

// The instruments a payer can hold.
const (
	InstrumentERupee  = "E_RUPEE"           // central bank money on this ledger
	InstrumentBankUPI = "BANK_ACCOUNT_UPI"  // a deposit reachable over the retail scheme
	InstrumentDeposit = "TOKENISED_DEPOSIT" // a bank's own token, a claim on the bank
	InstrumentForeign = "FOREIGN_CBDC"      // another central bank's money
)

// Payment states.
const (
	InteropSettled     = "SETTLED"
	InteropAwaitingLeg = "AWAITING_SCHEME_SETTLEMENT"
)

var (
	ErrInstrumentPair     = errors.New("ERR_UMI_INTEROP_PAIR")
	ErrInstrumentFields   = errors.New("ERR_UMI_INTEROP_FIELDS")
	ErrInstrumentState    = errors.New("ERR_UMI_INTEROP_STATE")
	ErrInstrumentNotFound = errors.New("ERR_UMI_INTEROP_NOT_FOUND")
)

const interopSuspense = "suspense:cbdc-interop"

const interopDisclaimer = "Simulated interoperability. No payment scheme, bank or second central bank is " +
	"connected here: the far leg of a bank payment is provisional until somebody records that the scheme " +
	"settled, and a tokenised deposit is a balance this process keeps rather than a claim on any institution."

// InteropRoute is one ordered pair of instruments and what happens when money
// crosses it.
type InteropRoute struct {
	From            string `json:"from"`
	To              string `json:"to"`
	Supported       bool   `json:"supported"`
	NearLegFinality string `json:"nearLegFinality"`
	FarLegFinality  string `json:"farLegFinality"`
	Window          string `json:"settlementWindow,omitempty"`
	WhoHoldsTheGap  string `json:"whoHoldsTheGap,omitempty"`
	How             string `json:"how"`
}

// InteropPayment is one payment that crossed instruments.
type InteropPayment struct {
	PaymentID   string    `json:"paymentId"`
	Payer       string    `json:"payer"`
	Payee       string    `json:"payee"`
	From        string    `json:"fromInstrument"`
	To          string    `json:"toInstrument"`
	AmountPaise int64     `json:"amountPaise"`
	Status      string    `json:"status"`
	Finality    *Finality `json:"finality,omitempty"`
	AcceptedVia string    `json:"acceptedVia,omitempty"`
	OpenedAt    string    `json:"openedAt"`
	SettledAt   string    `json:"settledAt,omitempty"`
	SettledBy   string    `json:"settledBy,omitempty"`
	Note        string    `json:"note"`
}

// CBDCInteropDesk holds the tokenised deposit balances and the payments.
type CBDCInteropDesk struct {
	mu       sync.Mutex
	chain    *DrunixChain
	cbdc     *CBDCLedger
	deposits map[string]int64
	payments map[string]*InteropPayment
	order    []string
}

func NewCBDCInteropDesk(chain *DrunixChain, cbdc *CBDCLedger) *CBDCInteropDesk {
	if chain == nil || cbdc == nil {
		return nil
	}
	return &CBDCInteropDesk{
		chain: chain, cbdc: cbdc,
		deposits: map[string]int64{}, payments: map[string]*InteropPayment{},
	}
}

// Routes is the matrix, published rather than described. A pair that is not
// supported says so, with the reason, because "interoperable" with an
// unstated boundary is the claim this layer exists to avoid making.
func (d *CBDCInteropDesk) Routes() []InteropRoute {
	return []InteropRoute{
		{
			From: InstrumentERupee, To: InstrumentERupee, Supported: true,
			NearLegFinality: FinalityFinal, FarLegFinality: FinalityFinal,
			How: "Both sides hold central bank money on this ledger, so it is one movement in one block " +
				"with nothing in between.",
		},
		{
			From: InstrumentERupee, To: InstrumentBankUPI, Supported: true,
			NearLegFinality: FinalityFinal, FarLegFinality: FinalityProvisional,
			Window:         "the retail scheme settles on its own cycle, so the payee's bank credits before the institutions are square",
			WhoHoldsTheGap: "the interop suspense account on this ledger, visibly, until the scheme settlement is recorded",
			How: "The payer's digital rupees leave their wallet into suspense and are final here immediately. " +
				"The bank leg is a different rail with a later clock, and it is marked provisional until " +
				"somebody records that the scheme settled.",
		},
		{
			From: InstrumentBankUPI, To: InstrumentERupee, Supported: false,
			NearLegFinality: FinalityProvisional, FarLegFinality: FinalityFinal,
			How: "Not supported here, and the reason is worth stating: pulling money out of a bank account " +
				"needs a rail this deployment is not connected to and an authorisation it does not hold. " +
				"Funding a wallet from a bank is already modelled on the issuance path, where it is marked " +
				"provisional for the same reason.",
		},
		{
			From: InstrumentDeposit, To: InstrumentERupee, Supported: true,
			NearLegFinality: FinalityFinal, FarLegFinality: FinalityFinal,
			How: "A conversion, not a payment: the deposit token is destroyed and exactly that much central " +
				"bank money is created in the same operation. The holder swaps a claim on a bank for a claim " +
				"on the central bank.",
		},
		{
			From: InstrumentERupee, To: InstrumentDeposit, Supported: true,
			NearLegFinality: FinalityFinal, FarLegFinality: FinalityFinal,
			How: "The same conversion in reverse: central bank money is redeemed and the equivalent deposit " +
				"token is issued. The holder goes back to holding a claim on a bank.",
		},
		{
			From: InstrumentERupee, To: InstrumentForeign, Supported: true,
			NearLegFinality: FinalityFinal, FarLegFinality: FinalityProvisional,
			Window:         "depends on the corridor: atomic where both legs sit on one ledger, hash time-locked across two",
			WhoHoldsTheGap: "nobody, on an atomic corridor; the hash lock, on a linked one",
			How: "Handled by the corridor layer rather than duplicated here, because which central bank " +
				"ledger the far leg sits on changes the settlement model entirely.",
		},
	}
}

func (d *CBDCInteropDesk) routeFor(from, to string) (InteropRoute, bool) {
	for _, r := range d.Routes() {
		if r.From == from && r.To == to {
			return r, true
		}
	}
	return InteropRoute{}, false
}

// Pay moves money across instruments. The only pair that reaches another rail
// is e-rupee to a bank account, and that is exactly the pair whose far leg is
// provisional.
func (d *CBDCInteropDesk) Pay(payer, payee, from, to string, amountPaise int64, acceptedVia string, now time.Time) (*InteropPayment, error) {
	from, to = strings.ToUpper(strings.TrimSpace(from)), strings.ToUpper(strings.TrimSpace(to))
	if strings.TrimSpace(payer) == "" || strings.TrimSpace(payee) == "" || amountPaise <= 0 {
		return nil, fmt.Errorf("%w: payer, payee and a positive amount in paise are required", ErrInstrumentFields)
	}
	route, known := d.routeFor(from, to)
	if !known {
		return nil, fmt.Errorf("%w: no route from %s to %s. The supported pairs are published at /umi/cbdc/interop",
			ErrInstrumentPair, from, to)
	}
	if !route.Supported {
		d.commit(BlockInteropRefused, map[string]interface{}{
			"payer": payer, "from": from, "to": to, "reason": route.How,
		})
		return nil, fmt.Errorf("%w: %s", ErrInstrumentPair, route.How)
	}
	if from == InstrumentForeign || to == InstrumentForeign {
		return nil, fmt.Errorf("%w: a payment to another central bank's money goes through the corridor layer "+
			"at /umi/corridors, which models whether the two ledgers settle atomically or across a hash lock",
			ErrInstrumentPair)
	}
	if from == InstrumentDeposit || to == InstrumentDeposit {
		return nil, fmt.Errorf("%w: moving between a tokenised deposit and central bank money is a conversion, "+
			"not a payment. Use /umi/cbdc/interop/convert, which destroys one and creates the other in a single "+
			"operation so the total cannot drift", ErrInstrumentPair)
	}

	p := &InteropPayment{
		PaymentID: cbdcID("CBIX"), Payer: payer, Payee: payee, From: from, To: to,
		AmountPaise: amountPaise, AcceptedVia: acceptedVia,
		OpenedAt: now.UTC().Format(time.RFC3339Nano),
	}

	switch to {
	case InstrumentERupee:
		mv, err := d.cbdc.Transfer(payer, payee, amountPaise)
		if err != nil {
			return nil, err
		}
		p.Status = InteropSettled
		p.SettledAt = p.OpenedAt
		p.Finality = &mv.Finality
		p.Note = "Both sides hold central bank money here, so this settled in one movement."

	case InstrumentBankUPI:
		// The payer's money becomes final here and the payee's bank is paid
		// on a different clock. The suspense account makes the gap a place
		// rather than a feeling.
		mv, err := d.cbdc.Transfer(payer, interopSuspense, amountPaise)
		if err != nil {
			return nil, err
		}
		f := mv.Finality
		f.Financial = FinalityProvisional
		f.SettlementWindow = route.Window
		f.Basis = "The digital rupee leg is final: the money has left the payer and is in interop suspense. " +
			"The payment is not final, because the bank leg settles on the scheme's cycle and nothing here " +
			"can observe that."
		p.Status = InteropAwaitingLeg
		p.Finality = &f
		p.Note = "The payee's bank credits them on scheme trust. Until the scheme settlement is recorded, " +
			"this is a claim on an institution rather than settled money."
	}

	d.mu.Lock()
	d.payments[p.PaymentID] = p
	d.order = append(d.order, p.PaymentID)
	d.mu.Unlock()

	d.commit(BlockInteropPaid, map[string]interface{}{
		"paymentId": p.PaymentID, "payer": payer, "payee": payee, "from": from, "to": to,
		"amountPaise": amountPaise, "status": p.Status, "acceptedVia": acceptedVia,
		"note": p.Note,
	})
	return p, nil
}

// RecordSchemeSettlement is the far side reporting in. It is a person's act,
// because nothing in this deployment can see a scheme settle.
func (d *CBDCInteropDesk) RecordSchemeSettlement(paymentID, by string, now time.Time) (*InteropPayment, error) {
	d.mu.Lock()
	p, ok := d.payments[paymentID]
	if !ok {
		d.mu.Unlock()
		return nil, fmt.Errorf("%w: no interop payment with that reference", ErrInstrumentNotFound)
	}
	if p.Status != InteropAwaitingLeg {
		d.mu.Unlock()
		return nil, fmt.Errorf("%w: this payment is already %s", ErrInstrumentState, strings.ToLower(p.Status))
	}
	amount, payee := p.AmountPaise, p.Payee
	d.mu.Unlock()

	// The suspense account pays out. In a connected deployment the money
	// would leave for the scheme; here it lands in the payee's wallet so the
	// identity still balances and the movement is visible.
	if _, err := d.cbdc.Transfer(interopSuspense, payee, amount); err != nil {
		return nil, err
	}

	d.mu.Lock()
	p.Status = InteropSettled
	p.SettledAt = now.UTC().Format(time.RFC3339Nano)
	p.SettledBy = by
	if p.Finality != nil {
		p.Finality.Financial = FinalityFinal
		p.Finality.Basis = "The scheme settlement was recorded by " + by + ", so both legs are now final."
	}
	out := *p
	d.mu.Unlock()

	d.commit(BlockInteropSettled, map[string]interface{}{
		"paymentId": out.PaymentID, "payee": payee, "amountPaise": amount, "recordedBy": by,
		"note": "Recorded by a person. This rail cannot observe a payment scheme settling.",
	})
	return &out, nil
}

// Convert swaps a tokenised deposit for central bank money or back. One
// operation, because two would be a window in which the total is wrong.
func (d *CBDCInteropDesk) Convert(holder, direction string, amountPaise int64, by string) (map[string]interface{}, error) {
	holder = strings.TrimSpace(holder)
	direction = strings.ToUpper(strings.TrimSpace(direction))
	if holder == "" || amountPaise <= 0 {
		return nil, fmt.Errorf("%w: a holder and a positive amount in paise are required", ErrInstrumentFields)
	}

	switch direction {
	case "DEPOSIT_TO_E_RUPEE":
		d.mu.Lock()
		if d.deposits[holder] < amountPaise {
			have := d.deposits[holder]
			d.mu.Unlock()
			return nil, fmt.Errorf("%w: the holder has %s in tokenised deposits and asked to convert %s",
				ErrInstrumentState, rupees(have), rupees(amountPaise))
		}
		d.deposits[holder] -= amountPaise
		remaining := d.deposits[holder]
		d.mu.Unlock()

		_, mv, err := d.cbdc.Issue(holder, CBDCRetail, "", amountPaise, false, by)
		if err != nil {
			// Put the deposit back: a failed conversion must not destroy it.
			d.mu.Lock()
			d.deposits[holder] += amountPaise
			d.mu.Unlock()
			return nil, err
		}
		d.commit(BlockInteropConvert, map[string]interface{}{
			"holder": holder, "direction": direction, "amountPaise": amountPaise,
			"depositRemaining": remaining, "by": by,
			"note": "A claim on a bank became a claim on the central bank. The deposit token was destroyed in " +
				"the same operation that created the money, so the total did not change.",
		})
		return map[string]interface{}{
			"direction": direction, "amountPaise": amountPaise, "depositBalancePaise": remaining,
			"movement": mv,
			"meaning":  "The holder now holds central bank money rather than a claim on a bank.",
		}, nil

	case "E_RUPEE_TO_DEPOSIT":
		if _, mv, err := d.cbdc.Redeem(holder, amountPaise, by); err != nil {
			return nil, err
		} else {
			d.mu.Lock()
			d.deposits[holder] += amountPaise
			remaining := d.deposits[holder]
			d.mu.Unlock()
			d.commit(BlockInteropConvert, map[string]interface{}{
				"holder": holder, "direction": direction, "amountPaise": amountPaise,
				"depositBalance": remaining, "by": by,
				"note": "Central bank money was redeemed and the equivalent deposit token issued in the same " +
					"operation. The holder is back to holding a claim on a bank.",
			})
			return map[string]interface{}{
				"direction": direction, "amountPaise": amountPaise, "depositBalancePaise": remaining,
				"movement": mv,
				"meaning":  "The holder now holds a claim on a bank rather than central bank money.",
			}, nil
		}
	}
	return nil, fmt.Errorf("%w: direction is DEPOSIT_TO_E_RUPEE or E_RUPEE_TO_DEPOSIT", ErrInstrumentFields)
}

// CreditDeposit exists so a deposit balance can be set up to convert from.
// It is a supervisor's act and it says plainly that no bank was involved.
func (d *CBDCInteropDesk) CreditDeposit(holder string, amountPaise int64, by string) (int64, error) {
	if strings.TrimSpace(holder) == "" || amountPaise <= 0 {
		return 0, fmt.Errorf("%w: a holder and a positive amount in paise are required", ErrInstrumentFields)
	}
	d.mu.Lock()
	d.deposits[holder] += amountPaise
	out := d.deposits[holder]
	d.mu.Unlock()
	d.commit(BlockInteropConvert, map[string]interface{}{
		"holder": holder, "direction": "DEPOSIT_CREDITED", "amountPaise": amountPaise, "by": by,
		"note": "A simulated tokenised deposit was credited. No bank was involved and this is not a claim on one.",
	})
	return out, nil
}

func (d *CBDCInteropDesk) Payments(limit int) []InteropPayment {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := []InteropPayment{}
	for i := len(d.order) - 1; i >= 0 && (limit <= 0 || len(out) < limit); i-- {
		if p, ok := d.payments[d.order[i]]; ok {
			out = append(out, *p)
		}
	}
	return out
}

func (d *CBDCInteropDesk) Payment(id string) (*InteropPayment, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	p, ok := d.payments[id]
	if !ok {
		return nil, fmt.Errorf("%w: no interop payment with that reference", ErrInstrumentNotFound)
	}
	cp := *p
	return &cp, nil
}

func (d *CBDCInteropDesk) Status() map[string]interface{} {
	d.mu.Lock()
	awaiting, settled := 0, 0
	for _, p := range d.payments {
		if p.Status == InteropAwaitingLeg {
			awaiting++
		} else {
			settled++
		}
	}
	depositTotal := int64(0)
	for _, v := range d.deposits {
		depositTotal += v
	}
	holders := len(d.deposits)
	d.mu.Unlock()

	suspense := int64(0)
	if w, ok := d.cbdc.Wallet(interopSuspense); ok {
		suspense = w.BalancePaise
	}

	return map[string]interface{}{
		"routes": d.Routes(),
		"payments": map[string]int{
			"settled": settled, "awaitingSchemeSettlement": awaiting,
		},
		"tokenisedDeposits": map[string]interface{}{
			"holders": holders, "totalPaise": depositTotal, "total": rupees(depositTotal),
			"meaning": "A claim on a bank, simulated here as a balance this process keeps. Converting it to " +
				"central bank money destroys it in the same operation that creates the money.",
		},
		"suspense": map[string]interface{}{
			"account": interopSuspense, "balancePaise": suspense, "balance": rupees(suspense),
			"meaning": "Money that has left a payer and not yet reached a payee on the other rail. The gap " +
				"between two legs always has somebody in it, and this is where it is visible.",
		},
		"theThreeQuestions": []string{
			"Which leg is final, and when: published per route rather than averaged into the word instant.",
			"Who holds the claim in the gap: a named suspense account, not nobody.",
			"Whether the total changed: a conversion destroys and creates in one operation.",
		},
		"disclaimer": interopDisclaimer,
	}
}

func (d *CBDCInteropDesk) commit(blockType string, txn map[string]interface{}) *DrunixBlock {
	if d.chain == nil {
		return nil
	}
	txn["rail"] = "CBDC interoperability (simulated far legs)"
	return d.chain.Append(blockType, []map[string]interface{}{txn})
}
