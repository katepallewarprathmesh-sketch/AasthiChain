package drunix

// Card rail economics and the dispute ladder.
//
// WHAT WAS MISSING
// The corridor catalogue already had CARD-SCHEME as its own rail, with the
// scheme membership it would need and the authorise-now-settle-later window
// named. What it did not have was the two things that actually make a card
// rail different from every other corridor in this system:
//
//   1. The money does not arrive whole. A card payment is split between the
//      issuer, the network and the acquirer before the merchant sees it, and
//      in India some of those splits are capped by law rather than
//      negotiated. A rail that reports "₹10,000 settled" without saying who
//      took what out of it is not modelling a card rail, it is modelling a
//      transfer.
//   2. An approval is not a payment. It is a guarantee that can be reversed
//      for months afterwards by a party who was never in the transaction.
//      The dispute ladder has deadlines on every rung, different ones per
//      network, and liability moves depending on how the cardholder was
//      authenticated. That reversibility is the whole reason card money and
//      ledger money behave differently.
//
// WHAT IS REAL AND WHAT IS NOT
// The arithmetic, the caps, the deadlines and the liability rules are real
// and each one cites where it comes from. The connection is not: this
// deployment holds no scheme membership, so nothing here authorises,
// presents or clears anything with a network. No money moves on this desk.
// It computes what would be taken and tracks what a dispute would do, which
// is the part a counterparty cannot otherwise see.
//
// THE INVARIANT
// The split must be exact. Interchange plus scheme fee plus acquirer margin
// equals the merchant discount rate to the paise, with the rounding residual
// going to the acquirer rather than vanishing. A fee model that does not
// balance is how a merchant ends up unable to reconcile a settlement file.

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	BlockCardPresented   = "UMI_CARD_PRESENTED"
	BlockCardDisputed    = "UMI_CARD_DISPUTED"
	BlockCardRepresented = "UMI_CARD_REPRESENTED"
	BlockCardEscalated   = "UMI_CARD_ESCALATED"
	BlockCardResolved    = "UMI_CARD_RESOLVED"
	BlockCardRefused     = "UMI_CARD_REFUSED"
)

// Instruments. The distinction matters because the law treats them
// differently, not because the plastic differs.
const (
	CardRuPayDebit        = "RUPAY_DEBIT"         // charge-free by statute
	CardOtherDebit        = "OTHER_DEBIT"         // RBI capped
	CardCredit            = "CREDIT"              // commercially set, uncapped
	CardCreditCrossBorder = "CREDIT_CROSS_BORDER" // plus the international legs
)

// Acceptance channels, which carry different caps on debit.
const (
	ChannelPOS    = "POS"
	ChannelQR     = "QR"
	ChannelOnline = "ONLINE"
)

// Dispute states, in the order a case can reach them.
const (
	CardPresented      = "PRESENTED"
	CardChargedBack    = "CHARGED_BACK"
	CardRepresented    = "REPRESENTED"
	CardPreArbitration = "PRE_ARBITRATION"
	CardArbitration    = "ARBITRATION"
	CardWonByMerchant  = "RESOLVED_MERCHANT"
	CardWonByIssuer    = "RESOLVED_ISSUER"
)

var (
	ErrCardFields     = errors.New("ERR_UMI_CARD_FIELDS")
	ErrCardNotFound   = errors.New("ERR_UMI_CARD_NOT_FOUND")
	ErrCardState      = errors.New("ERR_UMI_CARD_STATE")
	ErrCardWindow     = errors.New("ERR_UMI_CARD_WINDOW_CLOSED")
	ErrCardZeroMDR    = errors.New("ERR_UMI_CARD_ZERO_MDR")
	ErrCardLiability  = errors.New("ERR_UMI_CARD_LIABILITY_SHIFTED")
	ErrCardReasonCode = errors.New("ERR_UMI_CARD_REASON_CODE")
)

// gstOnFeeBps is the 18% GST charged on the merchant discount rate. It is
// not part of the split between the three parties; it goes to the exchequer,
// and showing it inside the split is a common way to mis-state the cost.
const gstOnFeeBps = 1800

/* ------------------------------------------------------------ economics */

// FeeSchedule is one published pricing rule, with its authority.
type FeeSchedule struct {
	Instrument    string `json:"instrument"`
	Channel       string `json:"channel"`
	SmallMerchant bool   `json:"smallMerchant"`
	MDRBps        int    `json:"mdrBps"`
	CapPaise      int64  `json:"perTransactionCapPaise"`
	Statutory     bool   `json:"statutory"`
	Instrument2   string `json:"authority"`
}

// cardSchedules is the published pricing this desk applies.
//
// Debit is capped by the RBI's December 2017 circular, which splits on
// whether the merchant turned over more than ₹20 lakh in the preceding
// financial year and on whether acceptance was over a QR code. RuPay debit
// is charge-free by statute, not by policy: section 10A of the Payment and
// Settlement Systems Act 2007, as notified on 14 September 2026. Credit
// carries no regulatory cap at all and is set between merchant, acquirer and
// network, which is why the figure here is a declared default rather than a
// rule.
func cardSchedules() []FeeSchedule {
	return []FeeSchedule{
		{Instrument: CardRuPayDebit, Channel: ChannelPOS, MDRBps: 0, Statutory: true,
			Instrument2: "Payment and Settlement Systems Act 2007, section 10A; notification S.O. 5067(E) of 14 September 2026"},
		{Instrument: CardRuPayDebit, Channel: ChannelQR, MDRBps: 0, Statutory: true,
			Instrument2: "Payment and Settlement Systems Act 2007, section 10A"},
		{Instrument: CardRuPayDebit, Channel: ChannelOnline, MDRBps: 0, Statutory: true,
			Instrument2: "Payment and Settlement Systems Act 2007, section 10A"},

		{Instrument: CardOtherDebit, Channel: ChannelPOS, SmallMerchant: true, MDRBps: 40, CapPaise: 20000,
			Instrument2: "RBI circular DPSS.CO.PD.No.1633/02.14.003/2017-18, 6 December 2017"},
		{Instrument: CardOtherDebit, Channel: ChannelOnline, SmallMerchant: true, MDRBps: 40, CapPaise: 20000,
			Instrument2: "RBI circular DPSS.CO.PD.No.1633/02.14.003/2017-18, 6 December 2017"},
		{Instrument: CardOtherDebit, Channel: ChannelQR, SmallMerchant: true, MDRBps: 30, CapPaise: 20000,
			Instrument2: "RBI circular DPSS.CO.PD.No.1633/02.14.003/2017-18, 6 December 2017"},
		{Instrument: CardOtherDebit, Channel: ChannelPOS, MDRBps: 90, CapPaise: 100000,
			Instrument2: "RBI circular DPSS.CO.PD.No.1633/02.14.003/2017-18, 6 December 2017"},
		{Instrument: CardOtherDebit, Channel: ChannelOnline, MDRBps: 90, CapPaise: 100000,
			Instrument2: "RBI circular DPSS.CO.PD.No.1633/02.14.003/2017-18, 6 December 2017"},
		{Instrument: CardOtherDebit, Channel: ChannelQR, MDRBps: 80, CapPaise: 100000,
			Instrument2: "RBI circular DPSS.CO.PD.No.1633/02.14.003/2017-18, 6 December 2017"},

		{Instrument: CardCredit, Channel: ChannelPOS, MDRBps: 200,
			Instrument2: "No regulatory cap. Commercially set between merchant, acquirer and network; 150 to 250 bps is the usual band."},
		{Instrument: CardCredit, Channel: ChannelOnline, MDRBps: 200,
			Instrument2: "No regulatory cap. Commercially set between merchant, acquirer and network."},
		{Instrument: CardCredit, Channel: ChannelQR, MDRBps: 200,
			Instrument2: "No regulatory cap. Commercially set between merchant, acquirer and network."},

		{Instrument: CardCreditCrossBorder, Channel: ChannelOnline, MDRBps: 250,
			Instrument2: "No regulatory cap. Cross-border acceptance prices above domestic because the acquirer carries settlement and dispute risk across a border."},
		{Instrument: CardCreditCrossBorder, Channel: ChannelPOS, MDRBps: 250,
			Instrument2: "No regulatory cap."},
	}
}

// Split is where a card payment actually goes.
type Split struct {
	AmountPaise int64 `json:"amountPaise"`

	MDRBps     int    `json:"mdrBps"`
	MDRPaise   int64  `json:"mdrPaise"`
	CapApplied bool   `json:"perTransactionCapApplied"`
	Statutory  bool   `json:"statutoryRate"`
	Authority  string `json:"authority"`

	// The three parties the MDR is divided between. These sum to MDRPaise.
	InterchangePaise int64 `json:"interchangePaise"`
	InterchangeBps   int   `json:"interchangeBps"`
	SchemeFeePaise   int64 `json:"schemeFeePaise"`
	SchemeFeeBps     int   `json:"schemeFeeBps"`
	AcquirerPaise    int64 `json:"acquirerMarginPaise"`

	// Charged on top of the MDR, not out of it.
	GSTPaise int64 `json:"gstOnFeePaise"`

	// Cross-border only, and borne by the cardholder rather than the
	// merchant, which is why they sit outside the MDR entirely.
	CrossBorderFeePaise int64 `json:"crossBorderAssessmentPaise,omitempty"`
	FXMarkupPaise       int64 `json:"issuerFXMarkupPaise,omitempty"`
	CardholderPaysPaise int64 `json:"cardholderPaysPaise"`

	MerchantReceivesPaise int64  `json:"merchantReceivesPaise"`
	EffectiveMerchantBps  int    `json:"effectiveMerchantCostBps"`
	Note                  string `json:"note"`
	Disclaimer            string `json:"disclaimer"`
}

// CardQuote asks what a payment would cost.
type CardQuote struct {
	AmountPaise   int64  `json:"amountPaise"`
	Instrument    string `json:"instrument"`
	Channel       string `json:"channel"`
	SmallMerchant bool   `json:"smallMerchant"`
}

// interchange and scheme shares of the MDR, in basis points of the
// transaction. The issuer takes the largest share because it carries the
// credit risk and funds the rewards; the network's cut is small and the
// acquirer keeps what is left, which on a capped debit transaction can be
// close to nothing. The NPCI circular operative since October 2022 puts
// RuPay credit on UPI at roughly 1.5% issuer against 0.5% network and
// acquirer, which is the proportion used here.
func cardShares(instrument string) (interchangeBps, schemeBps int) {
	switch instrument {
	case CardRuPayDebit:
		return 0, 0
	case CardOtherDebit:
		return 15, 2
	case CardCredit:
		return 150, 15
	case CardCreditCrossBorder:
		// The network takes more on a cross-border authorisation: an
		// international service assessment sits on top of the ordinary
		// scheme fee.
		return 150, 40
	}
	return 0, 0
}

// Price computes the split for one payment.
//
// Everything is integer paise and the residual lands on the acquirer, so the
// three shares always sum to the MDR exactly. Floating point here would
// produce a settlement file that does not reconcile, which is the specific
// failure this method exists to avoid.
func (d *CardDesk) Price(q CardQuote) (*Split, error) {
	if q.AmountPaise <= 0 {
		return nil, fmt.Errorf("%w: an amount is required", ErrCardFields)
	}
	instrument := strings.ToUpper(strings.TrimSpace(q.Instrument))
	channel := strings.ToUpper(strings.TrimSpace(q.Channel))
	if channel == "" {
		channel = ChannelONLINEDefault
	}
	var sched *FeeSchedule
	for _, s := range cardSchedules() {
		if s.Instrument == instrument && s.Channel == channel && s.SmallMerchant == q.SmallMerchant {
			cp := s
			sched = &cp
			break
		}
	}
	if sched == nil {
		return nil, fmt.Errorf("%w: no published rate for %s over %s", ErrCardFields, instrument, channel)
	}

	mdr := q.AmountPaise * int64(sched.MDRBps) / 10000
	capped := false
	if sched.CapPaise > 0 && mdr > sched.CapPaise {
		mdr = sched.CapPaise
		capped = true
	}

	icBps, schBps := cardShares(instrument)
	interchange := q.AmountPaise * int64(icBps) / 10000
	scheme := q.AmountPaise * int64(schBps) / 10000
	// When the cap bites, the issuer and the network are paid first and the
	// acquirer absorbs the shortfall. That is what actually happens, and it
	// is why acquirers price small-merchant debit acceptance as a loss
	// leader rather than a product.
	if interchange+scheme > mdr {
		if interchange > mdr {
			interchange = mdr
		}
		scheme = mdr - interchange
	}
	acquirer := mdr - interchange - scheme

	s := &Split{
		AmountPaise: q.AmountPaise,
		MDRBps:      sched.MDRBps, MDRPaise: mdr, CapApplied: capped,
		Statutory: sched.Statutory, Authority: sched.Instrument2,
		InterchangePaise: interchange, InterchangeBps: icBps,
		SchemeFeePaise: scheme, SchemeFeeBps: schBps,
		AcquirerPaise: acquirer,
		GSTPaise:      mdr * gstOnFeeBps / 10000,
		Disclaimer: "Modelled, not charged. This deployment holds no scheme membership, so nothing here is " +
			"authorised, presented or cleared with a network and no money moves.",
	}

	if instrument == CardCreditCrossBorder {
		// Borne by the cardholder on their statement, not deducted from the
		// merchant. Indian issuers commonly add 3.5% on a foreign-currency
		// transaction, which dwarfs everything the merchant pays.
		s.CrossBorderFeePaise = q.AmountPaise * 100 / 10000
		s.FXMarkupPaise = q.AmountPaise * 350 / 10000
		s.Note = "The cardholder pays more than the merchant loses. The issuer's foreign-currency markup is the " +
			"largest single charge on a cross-border card payment and never appears in the merchant's settlement."
	}
	s.CardholderPaysPaise = q.AmountPaise + s.CrossBorderFeePaise + s.FXMarkupPaise
	s.MerchantReceivesPaise = q.AmountPaise - mdr - s.GSTPaise
	if q.AmountPaise > 0 {
		s.EffectiveMerchantBps = int((mdr + s.GSTPaise) * 10000 / q.AmountPaise)
	}
	if s.Statutory && mdr == 0 {
		s.Note = "Charge-free by statute. A fee on this instrument is not a commercial choice, it is prohibited."
	}
	if capped && s.Note == "" {
		s.Note = "The per-transaction ceiling bit before the percentage did, so the effective rate is below the headline one."
	}
	return s, nil
}

// ChannelONLINEDefault keeps the default explicit rather than implied.
const ChannelONLINEDefault = ChannelOnline

/* --------------------------------------------------------------- disputes */

// NetworkRules are the dispute deadlines and fees of one scheme. The two
// networks run different clocks, and a dispute process written for one of
// them produces missed deadlines on the other.
type NetworkRules struct {
	Network              string `json:"network"`
	FilingDays           int    `json:"cardholderFilingDays"`
	ExtendedFilingDays   int    `json:"extendedFilingDays"`
	MerchantResponseDays int    `json:"merchantResponseDays"`
	PreArbitrationDays   int    `json:"preArbitrationDays"`
	ArbitrationDays      int    `json:"arbitrationFilingDays"`
	ArbitrationFeeUSD    int    `json:"arbitrationFeeUSD"`
	ResponseName         string `json:"merchantResponseName"`
	Note                 string `json:"note"`
}

func cardNetworks() map[string]NetworkRules {
	return map[string]NetworkRules{
		"VISA": {
			Network: "VISA", FilingDays: 120, ExtendedFilingDays: 540,
			MerchantResponseDays: 30, PreArbitrationDays: 30, ArbitrationDays: 10,
			ArbitrationFeeUSD: 600, ResponseName: "dispute response",
			Note: "Fraud and authorisation disputes are allocated on the network's own data with no separate " +
				"response stage, so the acquirer's challenge is itself a pre-arbitration attempt. The case " +
				"ruling fee rose to USD 600 on 1 April 2025 and falls on the losing side.",
		},
		"MASTERCARD": {
			Network: "MASTERCARD", FilingDays: 120, ExtendedFilingDays: 540,
			MerchantResponseDays: 45, PreArbitrationDays: 45, ArbitrationDays: 45,
			ArbitrationFeeUSD: 575, ResponseName: "second presentment",
			Note: "A linear ladder: first chargeback, second presentment, pre-arbitration, arbitration. " +
				"Codes 4808, 4870 and 4871 skip pre-arbitration entirely. The combined arbitration cost is " +
				"USD 575 and falls on the losing side.",
		},
	}
}

// ReasonCode is one ground on which a cardholder can reverse a payment.
type ReasonCode struct {
	Code        string `json:"code"`
	Network     string `json:"network"`
	Description string `json:"description"`
	Fraud       bool   `json:"fraud"`
	FilingDays  int    `json:"filingDays"`
	Evidence    string `json:"evidenceThatDefendsIt"`
}

func cardReasonCodes() []ReasonCode {
	return []ReasonCode{
		{Code: "10.4", Network: "VISA", Description: "Other fraud, card-absent environment", Fraud: true, FilingDays: 120,
			Evidence: "Authentication data: the 3-D Secure result, the ECI indicator, device and address matches."},
		{Code: "11.3", Network: "VISA", Description: "No authorisation", Fraud: false, FilingDays: 120,
			Evidence: "The authorisation code, its date and the amount, with proof the settled amount matched."},
		{Code: "12.5", Network: "VISA", Description: "Incorrect amount or duplicate processing", Fraud: false, FilingDays: 120,
			Evidence: "The settlement record and proof the second charge was a different transaction."},
		{Code: "13.1", Network: "VISA", Description: "Merchandise or services not received", Fraud: false, FilingDays: 540,
			Evidence: "Proof of delivery or of the service being performed, and the agreed delivery date."},
		{Code: "4837", Network: "MASTERCARD", Description: "No cardholder authorisation", Fraud: true, FilingDays: 120,
			Evidence: "Identity Check authentication, prior undisputed purchase history, device data."},
		{Code: "4853", Network: "MASTERCARD", Description: "Cardholder dispute, the consolidated code", Fraud: false, FilingDays: 540,
			Evidence: "The terms the cardholder accepted, delivery evidence and the refund policy shown at checkout."},
		{Code: "4808", Network: "MASTERCARD", Description: "Authorisation-related chargeback", Fraud: false, FilingDays: 120,
			Evidence: "The authorisation record. This code skips pre-arbitration and goes straight to arbitration."},
		{Code: "4870", Network: "MASTERCARD", Description: "Chip liability shift", Fraud: true, FilingDays: 120,
			Evidence: "Proof the terminal was EMV compliant and that the chip was read."},
	}
}

func reasonCodeFor(code string) (ReasonCode, bool) {
	code = strings.ToUpper(strings.TrimSpace(code))
	for _, r := range cardReasonCodes() {
		if r.Code == code {
			return r, true
		}
	}
	return ReasonCode{}, false
}

// CardPayment is one presented transaction and everything that happened to it.
type CardPayment struct {
	PaymentID   string `json:"paymentId"`
	Merchant    string `json:"merchant"`
	Network     string `json:"network"`
	Instrument  string `json:"instrument"`
	Channel     string `json:"channel"`
	AmountPaise int64  `json:"amountPaise"`
	Split       Split  `json:"split"`

	// Authenticated records whether the cardholder passed 3-D Secure. It is
	// the single field that most changes who loses a fraud dispute.
	Authenticated bool `json:"threeDSAuthenticated"`

	Status      string      `json:"status"`
	PresentedAt string      `json:"presentedAt"`
	ReasonCode  string      `json:"reasonCode,omitempty"`
	LiableParty string      `json:"liableParty,omitempty"`
	DeadlineAt  string      `json:"nextDeadlineAt,omitempty"`
	DeadlineFor string      `json:"nextDeadlineFor,omitempty"`
	FeeUSD      int         `json:"arbitrationFeeUSD,omitempty"`
	History     []CardEvent `json:"history"`
}

// CardEvent is one rung of the ladder, with the clock that governed it.
type CardEvent struct {
	At       string `json:"at"`
	Stage    string `json:"stage"`
	By       string `json:"by"`
	Detail   string `json:"detail"`
	Deadline string `json:"deadlineThatApplied,omitempty"`
	Block    int64  `json:"block,omitempty"`
}

// CardDesk holds presented payments and their disputes.
type CardDesk struct {
	mu       sync.Mutex
	chain    *DrunixChain
	payments map[string]*CardPayment
	order    []string
	seq      int64
}

// NewCardDesk wires the desk. A nil chain disables it, which is how the
// server decides whether to mount the routes.
func NewCardDesk(chain *DrunixChain) *CardDesk {
	if chain == nil {
		return nil
	}
	return &CardDesk{chain: chain, payments: map[string]*CardPayment{}}
}

func (d *CardDesk) append(p *CardPayment, blockType, stage, by, detail, deadline string) {
	ev := CardEvent{
		At: time.Now().UTC().Format(time.RFC3339), Stage: stage, By: by,
		Detail: detail, Deadline: deadline,
	}
	if d.chain != nil {
		b := d.chain.Append(blockType, []map[string]interface{}{{
			"kind":        "umi-card-" + strings.ToLower(stage),
			"paymentId":   p.PaymentID,
			"network":     p.Network,
			"stage":       stage,
			"by":          by,
			"reasonCode":  p.ReasonCode,
			"amountPaise": p.AmountPaise,
			"liableParty": p.LiableParty,
		}})
		if b != nil {
			ev.Block = b.Height
		}
	}
	p.History = append(p.History, ev)
}

// Present records an authorised card payment and prices it.
func (d *CardDesk) Present(merchant, network string, q CardQuote, authenticated bool, now time.Time) (*CardPayment, error) {
	split, err := d.Price(q)
	if err != nil {
		return nil, err
	}
	net := strings.ToUpper(strings.TrimSpace(network))
	if _, ok := cardNetworks()[net]; !ok {
		return nil, fmt.Errorf("%w: network must be VISA or MASTERCARD", ErrCardFields)
	}
	if strings.TrimSpace(merchant) == "" {
		return nil, fmt.Errorf("%w: a merchant is required", ErrCardFields)
	}

	d.mu.Lock()
	d.seq++
	id := fmt.Sprintf("CARD-%04d", d.seq)
	p := &CardPayment{
		PaymentID: id, Merchant: merchant, Network: net,
		Instrument: strings.ToUpper(q.Instrument), Channel: split.authChannel(q.Channel),
		AmountPaise: q.AmountPaise, Split: *split, Authenticated: authenticated,
		Status: CardPresented, PresentedAt: now.UTC().Format(time.RFC3339),
	}
	d.payments[id] = p
	d.order = append(d.order, id)
	d.append(p, BlockCardPresented, "PRESENTED", merchant,
		"Authorised and presented. An approval is a guarantee of payment, not a payment: it can be reversed "+
			"for 120 days and longer on some grounds.", "")
	out := *p
	d.mu.Unlock()
	return &out, nil
}

// authChannel keeps the stored channel consistent with the one priced.
func (s *Split) authChannel(requested string) string {
	c := strings.ToUpper(strings.TrimSpace(requested))
	if c == "" {
		return ChannelOnline
	}
	return c
}

// Chargeback files a dispute against a presented payment.
//
// Three things can refuse it, and all three are the point of the model: the
// filing window can have closed, the reason code can be one the network does
// not recognise, and a fraud code against a transaction the cardholder
// authenticated has already shifted liability to the issuer, so it cannot be
// charged back to the merchant at all.
func (d *CardDesk) Chargeback(paymentID, code, by string, now time.Time) (*CardPayment, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	p, ok := d.payments[paymentID]
	if !ok {
		return nil, ErrCardNotFound
	}
	if p.Status != CardPresented {
		return nil, fmt.Errorf("%w: a payment already in %s cannot be charged back again", ErrCardState, p.Status)
	}
	rc, ok := reasonCodeFor(code)
	if !ok {
		return nil, fmt.Errorf("%w: %q is not a reason code this desk models", ErrCardReasonCode, code)
	}
	if rc.Network != p.Network {
		return nil, fmt.Errorf("%w: %s is a %s code and this payment ran on %s",
			ErrCardReasonCode, rc.Code, rc.Network, p.Network)
	}

	presented, _ := time.Parse(time.RFC3339, p.PresentedAt)
	age := int(now.Sub(presented).Hours() / 24)
	if age > rc.FilingDays {
		p.LiableParty = "ISSUER"
		d.append(p, BlockCardRefused, "WINDOW_CLOSED", by,
			fmt.Sprintf("Filed %d days after presentment against a %d day window for %s. The merchant keeps the money.",
				age, rc.FilingDays, rc.Code), "")
		out := *p
		return &out, fmt.Errorf("%w: %s allows %d days and this was filed on day %d",
			ErrCardWindow, rc.Code, rc.FilingDays, age)
	}

	if rc.Fraud && p.Authenticated {
		// The liability shift is the reason 3-D Secure exists. It applies to
		// fraud grounds only: an authenticated transaction can still be
		// disputed as goods not received.
		p.LiableParty = "ISSUER"
		d.append(p, BlockCardRefused, "LIABILITY_SHIFTED", by,
			"The cardholder authenticated through 3-D Secure, so liability for a fraud ground sits with the "+
				"issuer and the payment cannot be charged back to the merchant. A non-fraud ground still can be.", "")
		out := *p
		return &out, fmt.Errorf("%w: %s is a fraud ground and this transaction was authenticated",
			ErrCardLiability, rc.Code)
	}

	rules := cardNetworks()[p.Network]
	p.Status = CardChargedBack
	p.ReasonCode = rc.Code
	p.LiableParty = "MERCHANT"
	p.DeadlineAt = now.AddDate(0, 0, rules.MerchantResponseDays).UTC().Format(time.RFC3339)
	p.DeadlineFor = rules.ResponseName
	d.append(p, BlockCardDisputed, "CHARGED_BACK", by,
		fmt.Sprintf("%s: %s. The acquirer debits the merchant now and the merchant gets the money back only by "+
			"winning. %s", rc.Code, rc.Description, rc.Evidence),
		fmt.Sprintf("%s within %d days", rules.ResponseName, rules.MerchantResponseDays))
	out := *p
	return &out, nil
}

// Represent is the merchant's answer, called a dispute response at Visa and
// a second presentment at Mastercard. Filed late, it is not considered.
func (d *CardDesk) Represent(paymentID, evidence, by string, now time.Time) (*CardPayment, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	p, ok := d.payments[paymentID]
	if !ok {
		return nil, ErrCardNotFound
	}
	if p.Status != CardChargedBack {
		return nil, fmt.Errorf("%w: only a charged-back payment can be answered, this one is %s", ErrCardState, p.Status)
	}
	if strings.TrimSpace(evidence) == "" {
		return nil, fmt.Errorf("%w: evidence is required, an assertion is not a defence", ErrCardFields)
	}
	if deadline, err := time.Parse(time.RFC3339, p.DeadlineAt); err == nil && now.After(deadline) {
		p.Status = CardWonByIssuer
		p.LiableParty = "MERCHANT"
		p.DeadlineAt, p.DeadlineFor = "", ""
		d.append(p, BlockCardResolved, "RESOLVED_ISSUER", by,
			"The response window closed before anything was filed, so the chargeback stands and the merchant "+
				"bears the loss. Missing the clock loses more cases than losing on the evidence does.", "")
		out := *p
		return &out, fmt.Errorf("%w: the response window had already closed", ErrCardWindow)
	}

	rules := cardNetworks()[p.Network]
	p.Status = CardRepresented
	p.LiableParty = "ISSUER"
	p.DeadlineAt = now.AddDate(0, 0, rules.PreArbitrationDays).UTC().Format(time.RFC3339)
	p.DeadlineFor = "issuer pre-arbitration"
	d.append(p, BlockCardRepresented, "REPRESENTED", by, evidence,
		fmt.Sprintf("issuer may pre-arbitrate within %d days", rules.PreArbitrationDays))
	out := *p
	return &out, nil
}

// PreArbitrate is the issuer coming back with new evidence.
func (d *CardDesk) PreArbitrate(paymentID, detail, by string, now time.Time) (*CardPayment, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	p, ok := d.payments[paymentID]
	if !ok {
		return nil, ErrCardNotFound
	}
	if p.Status != CardRepresented {
		return nil, fmt.Errorf("%w: pre-arbitration follows a response, this payment is %s", ErrCardState, p.Status)
	}
	rules := cardNetworks()[p.Network]
	p.Status = CardPreArbitration
	p.LiableParty = "MERCHANT"
	p.DeadlineAt = now.AddDate(0, 0, rules.ArbitrationDays).UTC().Format(time.RFC3339)
	p.DeadlineFor = "arbitration filing"
	d.append(p, BlockCardEscalated, "PRE_ARBITRATION", by, detail,
		fmt.Sprintf("arbitration may be filed within %d days", rules.ArbitrationDays))
	out := *p
	return &out, nil
}

// Arbitrate sends the case to the network for a binding ruling. The loser
// pays the fee, which on most disputes is larger than the amount in dispute
// and is the reason almost nothing reaches this rung.
func (d *CardDesk) Arbitrate(paymentID, by string, merchantWins bool, now time.Time) (*CardPayment, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	p, ok := d.payments[paymentID]
	if !ok {
		return nil, ErrCardNotFound
	}
	if p.Status != CardPreArbitration {
		return nil, fmt.Errorf("%w: arbitration follows pre-arbitration, this payment is %s", ErrCardState, p.Status)
	}
	rules := cardNetworks()[p.Network]
	p.FeeUSD = rules.ArbitrationFeeUSD
	p.DeadlineAt, p.DeadlineFor = "", ""
	if merchantWins {
		p.Status = CardWonByMerchant
		p.LiableParty = "ISSUER"
	} else {
		p.Status = CardWonByIssuer
		p.LiableParty = "MERCHANT"
	}
	d.append(p, BlockCardResolved, p.Status, by,
		fmt.Sprintf("Binding ruling. The losing side pays the USD %d case fee, which on a dispute of %s is "+
			"usually worth more than the transaction.", rules.ArbitrationFeeUSD, cardRupees(p.AmountPaise)), "")
	out := *p
	return &out, nil
}

// cardRupees formats paise for a sentence.
func cardRupees(paise int64) string {
	return fmt.Sprintf("Rs %d.%02d", paise/100, paise%100)
}

// Payments lists what the desk holds, newest first.
func (d *CardDesk) Payments() []CardPayment {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := make([]CardPayment, 0, len(d.order))
	for _, id := range d.order {
		out = append(out, *d.payments[id])
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].PresentedAt > out[j].PresentedAt })
	return out
}

// Payment reads one.
func (d *CardDesk) Payment(id string) (*CardPayment, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	p, ok := d.payments[id]
	if !ok {
		return nil, false
	}
	out := *p
	return &out, true
}

// Posture is everything the desk will apply, published before anyone uses it.
func (d *CardDesk) Posture() map[string]interface{} {
	nets := make([]NetworkRules, 0, 2)
	for _, n := range cardNetworks() {
		nets = append(nets, n)
	}
	sort.Slice(nets, func(i, j int) bool { return nets[i].Network < nets[j].Network })
	return map[string]interface{}{
		"schedules":   cardSchedules(),
		"networks":    nets,
		"reasonCodes": cardReasonCodes(),
		"gstOnFeeBps": gstOnFeeBps,
		"invariant": "Interchange plus scheme fee plus acquirer margin equals the merchant discount rate to the " +
			"paise. The rounding residual goes to the acquirer rather than disappearing.",
		"liabilityShift": "3-D Secure moves liability for a fraud ground to the issuer. It does nothing for a " +
			"goods-not-received ground, which is the dispute merchants actually lose.",
		"simulated": "This deployment holds no card scheme membership and no PCI DSS attestation. Nothing here " +
			"is authorised, presented or cleared with a network, and no money moves on this desk. The " +
			"arithmetic, the caps, the deadlines and the liability rules are real and cite their source.",
	}
}
