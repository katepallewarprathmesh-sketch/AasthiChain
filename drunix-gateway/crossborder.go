package drunix

// Cross-border funding: a stablecoin leg that cannot break FEMA.
//
// The problem it answers is real. The rupee legs of this demo are domestic,
// so a buyer outside India has no way to fund a purchase. Stablecoins are the
// obvious reach for that gap: minutes instead of days, network fees instead of
// a wire fee plus FX spread.
//
// The obvious reach is also the wrong one if it is taken literally, and this
// file exists to encode why.
//
//   - A foreign national of non-Indian origin resident outside India cannot
//     buy Indian immovable property at all. That is a restriction on the
//     buyer, not on the payment method, so no rail fixes it.
//   - For a buyer who is eligible, the consideration must arrive through
//     banking channels in rupees: inward remittance, or a debit to an NRE,
//     FCNR(B) or NRO account. Digital tokens are not one of the permitted
//     methods, and one bad leg taints the whole purchase.
//
// What industry actually does, and what is modelled here, is the only shape
// that survives both facts: take the stablecoin offshore, convert it offshore,
// and remit rupees into India through a regulated provider against the
// invoice, with a purpose code and the bank's advice. The token never touches
// an Indian wallet, and the seller is paid the way the law expects.
//
// So the lifecycle below is deliberately built to make the compliant path the
// only path. A funding request is screened before a quote exists; the
// destination is the off-ramp and never the seller; and the buyer's rupee
// wallet is credited only against an off-ramp attestation carrying a bank
// reference and a purpose code. There is no route through this file in which
// a token moves to a seller against crypto.
//
// Limits, stated because the whole value of the file is that it does not
// pretend:
//
//   - Nothing here is connected to any chain. A transfer reference is
//     recorded, not verified, and every response says so.
//   - The rate is indicative and configured. It is not an oracle.
//   - The off-ramp is an interface with a simulated implementation. No
//     provider is integrated and none is named.
//   - Eligibility is what the buyer declares. The rail records the
//     declaration and refuses on it; it does not check a passport.
//   - Tax figures are shown for information. Nothing is withheld or filed.

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

// Block types. Refusals are committed too: a gate whose operation nobody can
// read is indistinguishable from no gate.
const (
	BlockCBXQuoted    = "UMI_CBX_QUOTED"
	BlockCBXRefused   = "UMI_CBX_REFUSED"
	BlockCBXPaid      = "UMI_CBX_PAYMENT_RECORDED"
	BlockCBXOfframped = "UMI_CBX_OFFRAMPED"
	BlockCBXExpired   = "UMI_CBX_EXPIRED"
)

// Lifecycle.
const (
	CBXQuoted    = "QUOTED"           // rate pinned, nothing sent
	CBXPaid      = "PAYMENT_RECORDED" // buyer says they transferred
	CBXOfframped = "OFFRAMPED"        // provider attests INR reached India
	CBXExpired   = "EXPIRED"          // quote ran out before payment
)

// Declared buyer status. Only the first three may purchase.
const (
	BuyerResident = "RESIDENT"
	BuyerNRI      = "NRI"
	BuyerOCI      = "OCI"
	BuyerPIO      = "PIO"
	BuyerForeign  = "FOREIGN_NATIONAL"
)

var (
	ErrCBXFields     = errors.New("ERR_UMI_CBX_FIELDS")
	ErrCBXNotFound   = errors.New("ERR_UMI_CBX_NOT_FOUND")
	ErrCBXNotBuyer   = errors.New("ERR_UMI_CBX_NOT_BUYER")
	ErrCBXIneligible = errors.New("ERR_UMI_CBX_INELIGIBLE")
	ErrCBXRestricted = errors.New("ERR_UMI_CBX_RESTRICTED_NATIONALITY")
	ErrCBXKYC        = errors.New("ERR_UMI_CBX_KYC_REQUIRED")
	ErrCBXTravelRule = errors.New("ERR_UMI_CBX_TRAVEL_RULE")
	ErrCBXExpired    = errors.New("ERR_UMI_CBX_QUOTE_EXPIRED")
	ErrCBXState      = errors.New("ERR_UMI_CBX_STATE")
	ErrCBXOfframp    = errors.New("ERR_UMI_CBX_OFFRAMP")
	ErrCBXAsset      = errors.New("ERR_UMI_CBX_ASSET_NOT_PERMITTED")
)

const (
	cbxQuoteLife = 15 * time.Minute // long enough to sign, short enough to honour
	// Travel Rule: FATF de-minimis is USD/EUR 1,000 and the EU applies no
	// threshold at all. The stricter of the two is the safe default.
	cbxTravelRuleUSD = 1000.0
	cbxDefaultRate   = 88.50 // INR per USD, indicative only
	cbxTDSRate       = 0.01  // 1% TDS on a VDA transfer
	cbxVDATaxRate    = 0.30  // 30% flat on VDA transfer gains

	// CBXDisclaimer rides on every response.
	CBXDisclaimer = "Simulated cross-border leg. No chain is connected, no custody is held and no money moves. " +
		"The stablecoin is received and converted outside India by a regulated provider; only rupees remitted " +
		"through banking channels fund a purchase. Rates are indicative, not quoted."
)

// cbxRestrictedNationalities need prior RBI permission whatever their
// residence, so the rail will not quote for them.
var cbxRestrictedNationalities = []string{
	"PAKISTAN", "BANGLADESH", "SRI LANKA", "AFGHANISTAN", "CHINA", "IRAN",
	"NEPAL", "BHUTAN", "MACAU", "HONG KONG", "NORTH KOREA",
}

// cbxPermittedCoins: MiCA closed the EEA to unauthorised issuers through 2026,
// which in practice narrows a cross-border leg to the authorised set.
var cbxPermittedCoins = map[string]string{
	"USDC": "USD",
	"EURC": "EUR",
}

// TravelRuleParty is the originator or beneficiary side of an IVMS-101 style
// record. Shaped after the standard, not a conformant encoding of it.
type TravelRuleParty struct {
	Name       string `json:"name"`
	Address    string `json:"address"`
	Country    string `json:"country"`
	AccountRef string `json:"accountRef"`
	LEI        string `json:"lei,omitempty"`
}

func (p TravelRuleParty) complete() bool {
	return strings.TrimSpace(p.Name) != "" &&
		strings.TrimSpace(p.Address) != "" &&
		strings.TrimSpace(p.Country) != "" &&
		strings.TrimSpace(p.AccountRef) != ""
}

// CBXRequest asks for a funding quote.
type CBXRequest struct {
	AssetID     string          `json:"assetId"`
	AmountINR   float64         `json:"amountINR"`
	Stablecoin  string          `json:"stablecoin"`
	Network     string          `json:"network"`
	BuyerStatus string          `json:"buyerStatus"`
	Nationality string          `json:"nationality"`
	KYCRef      string          `json:"kycRef"`
	Originator  TravelRuleParty `json:"originator"`
	Beneficiary TravelRuleParty `json:"beneficiary"`
}

// CBXIntent is one funding attempt, from quote to rupees in a wallet.
type CBXIntent struct {
	ID          string  `json:"id"`
	Buyer       string  `json:"buyer"`
	AssetID     string  `json:"assetId"`
	Status      string  `json:"status"`
	AmountINR   float64 `json:"amountINR"`
	Stablecoin  string  `json:"stablecoin"`
	Network     string  `json:"network"`
	AmountCoin  float64 `json:"amountCoin"`
	Rate        float64 `json:"rateINRPerUnit"`
	RateSource  string  `json:"rateSource"`
	BuyerStatus string  `json:"buyerStatus"`
	Nationality string  `json:"nationality"`
	KYCRef      string  `json:"kycRef"`

	PayTo       string          `json:"payTo"`
	PayToIs     string          `json:"payToIs"`
	TravelRule  bool            `json:"travelRuleApplied"`
	Originator  TravelRuleParty `json:"originator,omitempty"`
	Beneficiary TravelRuleParty `json:"beneficiary,omitempty"`

	TransferRef string `json:"transferRef,omitempty"`
	PaidAt      string `json:"paidAt,omitempty"`

	OfframpProvider string  `json:"offrampProvider,omitempty"`
	OfframpAdvice   string  `json:"offrampAdviceRef,omitempty"`
	PurposeCode     string  `json:"purposeCode,omitempty"`
	CreditedINR     float64 `json:"creditedINR,omitempty"`
	OfframpedAt     string  `json:"offrampedAt,omitempty"`

	IndicativeTDSINR float64 `json:"indicativeTDSINR"`
	QuotedAt         string  `json:"quotedAt"`
	ExpiresAt        string  `json:"expiresAt"`
	Note             string  `json:"note"`
}

// OfframpAttestation is what a regulated provider returns after converting the
// stablecoin outside India and remitting rupees through banking channels.
type OfframpAttestation struct {
	Provider    string  `json:"provider"`
	AdviceRef   string  `json:"adviceRef"`   // the bank's advice (eFIRA equivalent)
	PurposeCode string  `json:"purposeCode"` // RBI purpose code on the inward remittance
	AmountINR   float64 `json:"amountINR"`
}

// Offramp converts a recorded stablecoin transfer into an attested inward
// remittance. The simulated implementation is the only one in the tree.
type Offramp interface {
	Convert(intent CBXIntent) (OfframpAttestation, error)
}

// SimulatedOfframp stands in for a regulated provider. It applies a spread and
// returns a reference shaped like a bank advice. It converts nothing.
type SimulatedOfframp struct {
	Provider    string
	SpreadBps   float64 // provider margin, basis points
	PurposeCode string
}

// NewSimulatedOfframp uses a purpose code for immovable-property consideration
// and a spread inside the range a provider of this kind charges.
func NewSimulatedOfframp() *SimulatedOfframp {
	return &SimulatedOfframp{
		Provider:    "simulated-offramp",
		SpreadBps:   150, // 1.5%, the going merchant rate
		PurposeCode: "S0005",
	}
}

func (o *SimulatedOfframp) Convert(intent CBXIntent) (OfframpAttestation, error) {
	if strings.TrimSpace(intent.TransferRef) == "" {
		return OfframpAttestation{}, ErrCBXOfframp
	}
	net := intent.AmountINR * (1 - o.SpreadBps/10000)
	sum := sha256.Sum256([]byte("aasthi-offramp|" + intent.ID + "|" + intent.TransferRef))
	return OfframpAttestation{
		Provider:    o.Provider,
		AdviceRef:   "ADV-" + strings.ToUpper(hex.EncodeToString(sum[:6])),
		PurposeCode: o.PurposeCode,
		AmountINR:   float64(int64(net*100)) / 100,
	}, nil
}

// CBXRegistry holds funding intents.
type CBXRegistry struct {
	mu      sync.RWMutex
	rail    *UMIRail
	chain   *DrunixChain
	offramp Offramp
	rate    float64
	intents map[string]*CBXIntent
	order   []string
	seq     int64
}

// NewCBXRegistry wires the layer. A nil rail or chain disables it, which is
// how the server decides whether to mount the routes.
func NewCBXRegistry(rail *UMIRail, chain *DrunixChain, offramp Offramp) *CBXRegistry {
	if rail == nil || chain == nil {
		return nil
	}
	if offramp == nil {
		offramp = NewSimulatedOfframp()
	}
	return &CBXRegistry{
		rail:    rail,
		chain:   chain,
		offramp: offramp,
		rate:    cbxDefaultRate,
		intents: map[string]*CBXIntent{},
	}
}

// SetRate overrides the indicative rate. Still not an oracle.
func (c *CBXRegistry) SetRate(inrPerUSD float64) {
	if inrPerUSD <= 0 {
		return
	}
	c.mu.Lock()
	c.rate = inrPerUSD
	c.mu.Unlock()
}

// EligibilityOf reports whether a declared buyer may purchase at all, and why
// not when they may not. Exported because the answer is useful before anybody
// asks for a quote.
func EligibilityOf(status, nationality string) (bool, string) {
	s := strings.ToUpper(strings.TrimSpace(status))
	n := strings.ToUpper(strings.TrimSpace(nationality))
	for _, bad := range cbxRestrictedNationalities {
		if n == bad {
			return false, "A citizen of " + titleWord(bad) + " needs prior RBI permission " +
				"before acquiring immovable property in India. The rail will not quote without it."
		}
	}
	switch s {
	case BuyerResident, BuyerNRI, BuyerOCI, BuyerPIO:
		return true, ""
	case BuyerForeign:
		return false, "A foreign national of non-Indian origin resident outside India cannot purchase immovable " +
			"property in India. A lease of up to five years is the route that is open. No payment method changes this."
	default:
		return false, "Declare a buyer status: RESIDENT, NRI, OCI, PIO or FOREIGN_NATIONAL."
	}
}

// titleWord lower-cases a shouting constant for display. strings.Title is
// deprecated, and this only ever sees country names.
func titleWord(s string) string {
	out := make([]string, 0, 3)
	for _, w := range strings.Fields(strings.ToLower(s)) {
		out = append(out, strings.ToUpper(w[:1])+w[1:])
	}
	return strings.Join(out, " ")
}

func (c *CBXRegistry) refuse(buyer, assetID, reason, detail string, err error) error {
	c.chain.Append(BlockCBXRefused, []map[string]interface{}{{
		"kind":    "umi-crossborder-refusal",
		"buyer":   buyer,
		"assetId": assetID,
		"reason":  reason,
		"detail":  detail,
	}})
	return fmt.Errorf("%w: %s", err, detail)
}

// Quote screens a funding request and, if it survives, pins a rate.
func (c *CBXRegistry) Quote(req CBXRequest, buyer string, now time.Time) (*CBXIntent, error) {
	buyer = strings.TrimSpace(buyer)
	assetID := strings.TrimSpace(req.AssetID)
	if buyer == "" || assetID == "" || req.AmountINR <= 0 {
		return nil, fmt.Errorf("%w: name an asset and an amount in rupees above zero", ErrCBXFields)
	}
	if strings.TrimSpace(req.KYCRef) == "" {
		return nil, c.refuse(buyer, assetID, "KYC_MISSING",
			"A cross-border funding leg needs a completed KYC reference before a quote exists.", ErrCBXKYC)
	}

	ok, why := EligibilityOf(req.BuyerStatus, req.Nationality)
	if !ok {
		sentinel := ErrCBXIneligible
		reason := "BUYER_INELIGIBLE"
		if strings.Contains(why, "prior RBI permission") {
			sentinel, reason = ErrCBXRestricted, "RESTRICTED_NATIONALITY"
		}
		if strings.HasPrefix(why, "Declare a buyer status") {
			return nil, fmt.Errorf("%w: %s", ErrCBXFields, why)
		}
		return nil, c.refuse(buyer, assetID, reason, why, sentinel)
	}

	coin := strings.ToUpper(strings.TrimSpace(req.Stablecoin))
	if coin == "" {
		coin = "USDC"
	}
	if _, found := cbxPermittedCoins[coin]; !found {
		return nil, fmt.Errorf("%w: this leg accepts USDC or EURC, the issuers authorised across the "+
			"jurisdictions it would have to clear", ErrCBXFields)
	}
	network := strings.TrimSpace(req.Network)
	if network == "" {
		network = "base-sepolia"
	}

	c.mu.RLock()
	rate := c.rate
	c.mu.RUnlock()
	amountCoin := float64(int64(req.AmountINR/rate*100)) / 100

	travelRule := amountCoin >= cbxTravelRuleUSD
	if travelRule && (!req.Originator.complete() || !req.Beneficiary.complete()) {
		return nil, c.refuse(buyer, assetID, "TRAVEL_RULE_INCOMPLETE",
			"Above the Travel Rule threshold both originator and beneficiary need a name, an address, "+
				"a country and an account reference before the transfer can be instructed.", ErrCBXTravelRule)
	}

	c.mu.Lock()
	c.seq++
	id := fmt.Sprintf("CBX-%04d", c.seq)
	intent := &CBXIntent{
		ID:               id,
		Buyer:            buyer,
		AssetID:          assetID,
		Status:           CBXQuoted,
		AmountINR:        req.AmountINR,
		Stablecoin:       coin,
		Network:          network,
		AmountCoin:       amountCoin,
		Rate:             rate,
		RateSource:       "indicative, configured on the rail; not a live quote",
		BuyerStatus:      strings.ToUpper(strings.TrimSpace(req.BuyerStatus)),
		Nationality:      strings.ToUpper(strings.TrimSpace(req.Nationality)),
		KYCRef:           strings.TrimSpace(req.KYCRef),
		PayTo:            "offramp:" + network + ":simulated",
		PayToIs:          "the off-ramp provider outside India, never the seller",
		TravelRule:       travelRule,
		IndicativeTDSINR: float64(int64(req.AmountINR*cbxTDSRate*100)) / 100,
		QuotedAt:         now.UTC().Format(time.RFC3339),
		ExpiresAt:        now.UTC().Add(cbxQuoteLife).Format(time.RFC3339),
		Note: "The stablecoin is converted outside India. Your rupee wallet is credited only against the " +
			"provider's attestation that an inward remittance reached India through banking channels.",
	}
	if travelRule {
		intent.Originator = req.Originator
		intent.Beneficiary = req.Beneficiary
	}
	c.intents[id] = intent
	c.order = append(c.order, id)
	snapshot := *intent
	c.mu.Unlock()

	c.chain.Append(BlockCBXQuoted, []map[string]interface{}{{
		"kind":        "umi-crossborder-quote",
		"intentId":    id,
		"buyer":       buyer,
		"assetId":     assetID,
		"amountINR":   snapshot.AmountINR,
		"amountCoin":  snapshot.AmountCoin,
		"stablecoin":  coin,
		"network":     network,
		"buyerStatus": snapshot.BuyerStatus,
		"travelRule":  travelRule,
		"expiresAt":   snapshot.ExpiresAt,
		"simulated":   true,
	}})
	return &snapshot, nil
}

func (c *CBXRegistry) expiredLocked(in *CBXIntent, now time.Time) bool {
	if in.Status != CBXQuoted {
		return false
	}
	exp, err := time.Parse(time.RFC3339, in.ExpiresAt)
	return err == nil && now.After(exp)
}

// RecordPayment notes the buyer's transfer reference. It verifies nothing: the
// rail is not connected to a chain and says so rather than implying a check.
func (c *CBXRegistry) RecordPayment(id, transferRef, caller string, now time.Time) (*CBXIntent, error) {
	transferRef = strings.TrimSpace(transferRef)
	if transferRef == "" {
		return nil, fmt.Errorf("%w: give the transfer reference", ErrCBXFields)
	}
	c.mu.Lock()
	in, found := c.intents[strings.TrimSpace(id)]
	if !found {
		c.mu.Unlock()
		return nil, ErrCBXNotFound
	}
	if !strings.EqualFold(in.Buyer, caller) {
		c.mu.Unlock()
		return nil, fmt.Errorf("%w: only the buyer who asked for the quote can report paying it", ErrCBXNotBuyer)
	}
	if c.expiredLocked(in, now) {
		in.Status = CBXExpired
		snapshot := *in
		c.mu.Unlock()
		c.chain.Append(BlockCBXExpired, []map[string]interface{}{{
			"kind": "umi-crossborder-expiry", "intentId": snapshot.ID, "buyer": snapshot.Buyer,
			"reason": "the pinned rate ran out before payment was reported",
		}})
		return nil, fmt.Errorf("%w: the quote expired at %s. Ask for a fresh one", ErrCBXExpired, snapshot.ExpiresAt)
	}
	if in.Status != CBXQuoted {
		c.mu.Unlock()
		return nil, fmt.Errorf("%w: this intent is %s", ErrCBXState, in.Status)
	}
	in.Status = CBXPaid
	in.TransferRef = transferRef
	in.PaidAt = now.UTC().Format(time.RFC3339)
	snapshot := *in
	c.mu.Unlock()

	c.chain.Append(BlockCBXPaid, []map[string]interface{}{{
		"kind":        "umi-crossborder-payment",
		"intentId":    snapshot.ID,
		"buyer":       snapshot.Buyer,
		"transferRef": transferRef,
		"amountCoin":  snapshot.AmountCoin,
		"stablecoin":  snapshot.Stablecoin,
		"verified":    false,
		"note":        "reference recorded as reported; no chain is connected to confirm it",
	}})
	return &snapshot, nil
}

// Offramp converts the recorded transfer and credits the buyer's rupee wallet
// against the provider's attestation. This is the only step that creates
// rupees, and it needs a bank advice reference and a purpose code to do it.
func (c *CBXRegistry) Offramp(id, caller string, supervisor bool, now time.Time) (*CBXIntent, error) {
	c.mu.Lock()
	in, found := c.intents[strings.TrimSpace(id)]
	if !found {
		c.mu.Unlock()
		return nil, ErrCBXNotFound
	}
	if in.Status != CBXPaid {
		c.mu.Unlock()
		return nil, fmt.Errorf("%w: an intent is off-ramped once a payment has been recorded against it, "+
			"and this one is %s", ErrCBXState, in.Status)
	}
	snapshot := *in
	c.mu.Unlock()

	att, err := c.offramp.Convert(snapshot)
	if err != nil {
		return nil, fmt.Errorf("%w: the provider did not attest the conversion", ErrCBXOfframp)
	}
	if strings.TrimSpace(att.AdviceRef) == "" || strings.TrimSpace(att.PurposeCode) == "" || att.AmountINR <= 0 {
		return nil, fmt.Errorf("%w: an attestation without a bank advice reference and a purpose code is not "+
			"evidence that money entered India through banking channels", ErrCBXOfframp)
	}

	// Credit the rupee wallet. Never called while holding c.mu.
	if _, _, err := c.rail.FundWallet(snapshot.Buyer, att.AmountINR); err != nil {
		return nil, err
	}

	c.mu.Lock()
	live := c.intents[snapshot.ID]
	live.Status = CBXOfframped
	live.OfframpProvider = att.Provider
	live.OfframpAdvice = att.AdviceRef
	live.PurposeCode = att.PurposeCode
	live.CreditedINR = att.AmountINR
	live.OfframpedAt = now.UTC().Format(time.RFC3339)
	out := *live
	c.mu.Unlock()

	c.chain.Append(BlockCBXOfframped, []map[string]interface{}{{
		"kind":        "umi-crossborder-offramp",
		"intentId":    out.ID,
		"buyer":       out.Buyer,
		"assetId":     out.AssetID,
		"provider":    att.Provider,
		"adviceRef":   att.AdviceRef,
		"purposeCode": att.PurposeCode,
		"creditedINR": att.AmountINR,
		"channel":     "inward remittance through banking channels (simulated)",
		"settlesIn":   "INR",
	}})
	return &out, nil
}

// Intent reads one, marking a lapsed quote expired as it goes.
func (c *CBXRegistry) Intent(id string, now time.Time) (*CBXIntent, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	in, found := c.intents[strings.TrimSpace(id)]
	if !found {
		return nil, false
	}
	if c.expiredLocked(in, now) {
		in.Status = CBXExpired
	}
	out := *in
	return &out, true
}

// Intents lists, newest first, optionally for one buyer.
func (c *CBXRegistry) Intents(buyer string, limit int, now time.Time) []CBXIntent {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]CBXIntent, 0, len(c.order))
	for _, id := range c.order {
		in := c.intents[id]
		if in == nil {
			continue
		}
		if buyer != "" && !strings.EqualFold(in.Buyer, buyer) {
			continue
		}
		if c.expiredLocked(in, now) {
			in.Status = CBXExpired
		}
		out = append(out, *in)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].QuotedAt > out[j].QuotedAt })
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}

// Rules is the readable statement of what this leg will and will not do.
func (c *CBXRegistry) Rules() map[string]interface{} {
	c.mu.RLock()
	rate := c.rate
	c.mu.RUnlock()
	coins := make([]string, 0, len(cbxPermittedCoins))
	for k := range cbxPermittedCoins {
		coins = append(coins, k)
	}
	sort.Strings(coins)
	return map[string]interface{}{
		"eligibleBuyers":   []string{BuyerResident, BuyerNRI, BuyerOCI, BuyerPIO},
		"ineligibleBuyers": []string{BuyerForeign},
		"ineligibleReason": "A foreign national of non-Indian origin resident outside India cannot purchase " +
			"immovable property in India at all. That is a restriction on the buyer, not on the payment method.",
		"restrictedNationalities": cbxRestrictedNationalities,
		"acceptedStablecoins":     coins,
		"settlementCurrency":      "INR",
		"paymentChannel": "The stablecoin is received and converted outside India. The purchase is funded by an " +
			"inward remittance through banking channels, which is the only method permitted for the " +
			"consideration on Indian immovable property.",
		"prohibited": "Paying a seller in cryptocurrency or digital tokens for Indian immovable property. " +
			"No route through this rail does that.",
		"travelRuleThresholdUSD": cbxTravelRuleUSD,
		"travelRuleFields":       []string{"name", "address", "country", "accountRef", "lei (entities)"},
		"quoteLifeMinutes":       int(cbxQuoteLife / time.Minute),
		"indicativeRateINRPerUS": rate,
		"taxNote": fmt.Sprintf("Indian tax on a virtual digital asset transfer is a flat %.0f%% on gains plus cess, "+
			"with %.0f%% TDS withheld at source and no loss set-off. Shown for information; nothing is withheld here.",
			cbxVDATaxRate*100, cbxTDSRate*100),
		"lifecycle":  []string{CBXQuoted, CBXPaid, CBXOfframped, CBXExpired},
		"disclaimer": CBXDisclaimer,
	}
}
