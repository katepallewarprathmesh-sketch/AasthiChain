package drunix

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func cardRig(t *testing.T) (*CardDesk, *DrunixChain) {
	t.Helper()
	chain := NewChain()
	d := NewCardDesk(chain)
	if d == nil {
		t.Fatal("the desk should wire with a chain")
	}
	return d, chain
}

// The invariant. A split that does not balance produces a settlement file a
// merchant cannot reconcile, which is the whole failure this guards.
func TestCardSplitBalancesToThePaise(t *testing.T) {
	d, _ := cardRig(t)
	for _, amount := range []int64{100, 999, 123457, 100000, 98765432, 3} {
		for _, inst := range []string{CardOtherDebit, CardCredit, CardCreditCrossBorder} {
			s, err := d.Price(CardQuote{AmountPaise: amount, Instrument: inst, Channel: ChannelOnline})
			if err != nil {
				t.Fatalf("%s at %d: %v", inst, amount, err)
			}
			sum := s.InterchangePaise + s.SchemeFeePaise + s.AcquirerPaise
			if sum != s.MDRPaise {
				t.Fatalf("%s at %d: split %d does not equal MDR %d", inst, amount, sum, s.MDRPaise)
			}
			if s.AcquirerPaise < 0 {
				t.Fatalf("%s at %d: acquirer margin went negative", inst, amount)
			}
			if s.MerchantReceivesPaise+s.MDRPaise+s.GSTPaise != amount {
				t.Fatalf("%s at %d: the merchant's side does not add up", inst, amount)
			}
		}
	}
}

// Charge-free by statute, not by policy.
func TestCardRuPayDebitIsFreeByLaw(t *testing.T) {
	d, _ := cardRig(t)
	s, err := d.Price(CardQuote{AmountPaise: 5000000, Instrument: CardRuPayDebit, Channel: ChannelPOS})
	if err != nil {
		t.Fatal(err)
	}
	if s.MDRPaise != 0 || s.GSTPaise != 0 {
		t.Fatalf("RuPay debit must carry no fee, got %d", s.MDRPaise)
	}
	if !s.Statutory || !strings.Contains(s.Authority, "section 10A") {
		t.Fatalf("the prohibition should cite its statute, got %q", s.Authority)
	}
	if s.MerchantReceivesPaise != 5000000 {
		t.Fatal("the merchant should receive the whole amount")
	}
}

// The ceiling bites before the percentage does on a large debit payment, and
// when it does the acquirer absorbs it rather than the issuer.
func TestCardDebitCapIsEnforcedAndAcquirerAbsorbsIt(t *testing.T) {
	d, _ := cardRig(t)
	// Rs 10,00,000 at 0.9% would be Rs 9,000, well over the Rs 1,000 cap.
	s, err := d.Price(CardQuote{AmountPaise: 100000000, Instrument: CardOtherDebit, Channel: ChannelPOS})
	if err != nil {
		t.Fatal(err)
	}
	if !s.CapApplied || s.MDRPaise != 100000 {
		t.Fatalf("the Rs 1,000 cap should hold, got %d paise, capped=%v", s.MDRPaise, s.CapApplied)
	}
	if s.InterchangePaise+s.SchemeFeePaise != s.MDRPaise {
		t.Fatal("with the cap biting, the issuer and network are paid first and the acquirer takes the shortfall")
	}
	if s.AcquirerPaise != 0 {
		t.Fatalf("the acquirer should be left with nothing here, got %d", s.AcquirerPaise)
	}
	// The small-merchant cap is lower still.
	small, _ := d.Price(CardQuote{AmountPaise: 100000000, Instrument: CardOtherDebit, Channel: ChannelPOS, SmallMerchant: true})
	if small.MDRPaise != 20000 {
		t.Fatalf("a small merchant is capped at Rs 200, got %d paise", small.MDRPaise)
	}
}

// The cardholder pays more than the merchant loses on a cross-border card.
func TestCardCrossBorderChargesFallOnTheCardholder(t *testing.T) {
	d, _ := cardRig(t)
	s, err := d.Price(CardQuote{AmountPaise: 10000000, Instrument: CardCreditCrossBorder, Channel: ChannelOnline})
	if err != nil {
		t.Fatal(err)
	}
	if s.FXMarkupPaise == 0 || s.CrossBorderFeePaise == 0 {
		t.Fatal("a cross-border card payment carries an assessment and a currency markup")
	}
	if s.CardholderPaysPaise <= s.AmountPaise {
		t.Fatal("the cardholder is billed more than the ticket price")
	}
	merchantLoses := s.AmountPaise - s.MerchantReceivesPaise
	cardholderExtra := s.CardholderPaysPaise - s.AmountPaise
	if cardholderExtra <= merchantLoses {
		t.Fatalf("the issuer markup should dominate: cardholder %d, merchant %d", cardholderExtra, merchantLoses)
	}
}

func TestCardUnknownInstrumentHasNoPrice(t *testing.T) {
	d, _ := cardRig(t)
	if _, err := d.Price(CardQuote{AmountPaise: 1000, Instrument: "COWRIE_SHELL"}); !errors.Is(err, ErrCardFields) {
		t.Fatalf("an instrument with no published rate must refuse, got %v", err)
	}
	if _, err := d.Price(CardQuote{AmountPaise: 0, Instrument: CardCredit}); !errors.Is(err, ErrCardFields) {
		t.Fatal("a zero amount has no price")
	}
}

/* ----------------------------------------------------------- the ladder */

func presented(t *testing.T, d *CardDesk, network string, authenticated bool, now time.Time) *CardPayment {
	t.Helper()
	p, err := d.Present("merchant1", network, CardQuote{
		AmountPaise: 10000000, Instrument: CardCredit, Channel: ChannelOnline,
	}, authenticated, now)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestCardFullLadderToArbitration(t *testing.T) {
	d, chain := cardRig(t)
	now := time.Now().UTC()
	p := presented(t, d, "VISA", false, now)
	if p.Status != CardPresented {
		t.Fatal("a presented payment starts presented")
	}

	cb, err := d.Chargeback(p.PaymentID, "10.4", "issuer1", now.AddDate(0, 0, 30))
	if err != nil {
		t.Fatalf("an unauthenticated fraud dispute inside the window should be accepted: %v", err)
	}
	if cb.Status != CardChargedBack || cb.LiableParty != "MERCHANT" {
		t.Fatalf("the merchant is debited at this rung, got %s / %s", cb.Status, cb.LiableParty)
	}
	if cb.DeadlineAt == "" || !strings.Contains(cb.DeadlineFor, "dispute response") {
		t.Fatalf("Visa calls the merchant's answer a dispute response, got %q", cb.DeadlineFor)
	}

	rep, err := d.Represent(p.PaymentID, "Delivery signed for at the billing address on 3 March.", "merchant1", now.AddDate(0, 0, 40))
	if err != nil {
		t.Fatalf("a response inside the window should be accepted: %v", err)
	}
	if rep.Status != CardRepresented || rep.LiableParty != "ISSUER" {
		t.Fatal("liability moves back on a filed response")
	}

	if _, err := d.Arbitrate(p.PaymentID, "network", true, now.AddDate(0, 0, 45)); !errors.Is(err, ErrCardState) {
		t.Fatal("arbitration cannot be reached without pre-arbitration")
	}

	pre, err := d.PreArbitrate(p.PaymentID, "The cardholder maintains they never received it.", "issuer1", now.AddDate(0, 0, 50))
	if err != nil {
		t.Fatal(err)
	}
	if pre.Status != CardPreArbitration {
		t.Fatal("pre-arbitration should be reachable after a response")
	}

	fin, err := d.Arbitrate(p.PaymentID, "network", true, now.AddDate(0, 0, 55))
	if err != nil {
		t.Fatal(err)
	}
	if fin.Status != CardWonByMerchant || fin.LiableParty != "ISSUER" {
		t.Fatal("the merchant won, so the issuer carries it")
	}
	if fin.FeeUSD != 600 {
		t.Fatalf("the Visa case fee is USD 600, got %d", fin.FeeUSD)
	}
	if len(fin.History) != 5 {
		t.Fatalf("every rung should be recorded, got %d events", len(fin.History))
	}
	for _, ev := range fin.History {
		if ev.Block == 0 && ev.Stage != "PRESENTED" {
			t.Fatalf("stage %s was not committed to the chain", ev.Stage)
		}
	}
	if len(chain.Blocks) < 5 {
		t.Fatal("the ladder should be auditable on the ledger, not only in memory")
	}
}

// The refusal that matters most: authentication moves fraud liability.
func TestCardThreeDSShiftsFraudLiability(t *testing.T) {
	d, _ := cardRig(t)
	now := time.Now().UTC()
	p := presented(t, d, "VISA", true, now)

	_, err := d.Chargeback(p.PaymentID, "10.4", "issuer1", now.AddDate(0, 0, 10))
	if !errors.Is(err, ErrCardLiability) {
		t.Fatalf("an authenticated fraud dispute cannot be charged back to the merchant, got %v", err)
	}
	after, _ := d.Payment(p.PaymentID)
	if after.LiableParty != "ISSUER" {
		t.Fatal("liability should be recorded as the issuer's")
	}
	if after.Status != CardPresented {
		t.Fatal("the payment stands")
	}

	// A non-fraud ground is unaffected: 3-D Secure proves who authorised the
	// payment, not that the goods arrived.
	if _, err := d.Chargeback(p.PaymentID, "13.1", "issuer1", now.AddDate(0, 0, 10)); err != nil {
		t.Fatalf("goods not received is still open on an authenticated payment: %v", err)
	}
}

func TestCardFilingWindowCloses(t *testing.T) {
	d, _ := cardRig(t)
	now := time.Now().UTC()
	p := presented(t, d, "MASTERCARD", false, now)
	_, err := d.Chargeback(p.PaymentID, "4837", "issuer1", now.AddDate(0, 0, 200))
	if !errors.Is(err, ErrCardWindow) {
		t.Fatalf("120 days is 120 days, got %v", err)
	}
	// The consolidated cardholder-dispute code runs to 540 days, so the same
	// delay is in time on a different ground.
	if _, err := d.Chargeback(p.PaymentID, "4853", "issuer1", now.AddDate(0, 0, 200)); err != nil {
		t.Fatalf("4853 allows 540 days: %v", err)
	}
}

func TestCardMissedResponseLosesTheCase(t *testing.T) {
	d, _ := cardRig(t)
	now := time.Now().UTC()
	p := presented(t, d, "VISA", false, now)
	if _, err := d.Chargeback(p.PaymentID, "10.4", "issuer1", now); err != nil {
		t.Fatal(err)
	}
	_, err := d.Represent(p.PaymentID, "Delivery proof.", "merchant1", now.AddDate(0, 0, 45))
	if !errors.Is(err, ErrCardWindow) {
		t.Fatalf("a response after the 30 day window is not considered, got %v", err)
	}
	after, _ := d.Payment(p.PaymentID)
	if after.Status != CardWonByIssuer || after.LiableParty != "MERCHANT" {
		t.Fatal("missing the clock loses the case outright")
	}
}

func TestCardNetworksRunDifferentClocks(t *testing.T) {
	d, _ := cardRig(t)
	now := time.Now().UTC()
	v := presented(t, d, "VISA", false, now)
	m := presented(t, d, "MASTERCARD", false, now)
	if _, err := d.Chargeback(v.PaymentID, "10.4", "issuer1", now); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Chargeback(m.PaymentID, "4837", "issuer1", now); err != nil {
		t.Fatal(err)
	}
	// Day 40 is late at Visa and in time at Mastercard.
	if _, err := d.Represent(v.PaymentID, "proof", "merchant1", now.AddDate(0, 0, 40)); !errors.Is(err, ErrCardWindow) {
		t.Fatal("Visa gives 30 days")
	}
	if _, err := d.Represent(m.PaymentID, "proof", "merchant1", now.AddDate(0, 0, 40)); err != nil {
		t.Fatalf("Mastercard gives 45 days: %v", err)
	}
}

func TestCardReasonCodeMustMatchTheNetwork(t *testing.T) {
	d, _ := cardRig(t)
	now := time.Now().UTC()
	p := presented(t, d, "VISA", false, now)
	if _, err := d.Chargeback(p.PaymentID, "4837", "issuer1", now); !errors.Is(err, ErrCardReasonCode) {
		t.Fatalf("a Mastercard code on a Visa payment is meaningless, got %v", err)
	}
	if _, err := d.Chargeback(p.PaymentID, "99.9", "issuer1", now); !errors.Is(err, ErrCardReasonCode) {
		t.Fatal("an invented reason code must refuse")
	}
}

func TestCardPostureIsPublishedWithItsBoundary(t *testing.T) {
	d, _ := cardRig(t)
	p := d.Posture()
	if len(p["schedules"].([]FeeSchedule)) < 10 {
		t.Fatal("the fee schedule should be published in full")
	}
	if len(p["reasonCodes"].([]ReasonCode)) < 8 {
		t.Fatal("the reason codes should be published")
	}
	sim, _ := p["simulated"].(string)
	if !strings.Contains(sim, "no card scheme membership") {
		t.Fatal("the desk must declare that it is not connected to a network")
	}
}
