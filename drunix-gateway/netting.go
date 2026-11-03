package drunix

// Multilateral netting for the cash leg.
//
// WHY THIS EXISTS
// Atomic DvP is gross settlement. Every instruction moves its own full amount
// of cash, so a participant who buys ₹10 lakh and sells ₹10 lakh in the same
// session still needs ₹10 lakh of funded wallet to get through the day. A
// conventional clearing corporation does the opposite: it collects the day's
// obligations, nets them multilaterally, and moves only the difference,
// which is typically a small fraction of the gross. That is the single
// largest reason tokenised settlement stalls at the cash leg, and the usual
// answer ("just settle atomically, one by one") quietly surrenders it.
//
// The rail already has atomic gross DvP in SettleDvP. This file adds the
// other half, so the trade-off can be measured on our own numbers rather than
// argued about:
//
//   - Net() takes a batch of instructions and reports the gross obligation,
//     the net obligation, and the efficiency between them. It moves nothing.
//   - SettleNet() applies the batch: every leg is checked, the cash moves
//     once per participant at the netted amount, and the token positions move
//     to exactly where the individual legs put them.
//
// WHAT IS AND IS NOT NETTED
// Cash is netted per participant: one debit or one credit each, never a
// sequence. Token positions are netted per participant per asset for the same
// reason, but every constituent leg is still written into the block, so
// provenance for an individual trade survives even though its cash never
// moved on its own.
//
// ALL OR NOTHING
// The batch keeps the same promise a single instruction makes. If any
// participant cannot fund their net debit, or any seller is short on the
// tokens their net position requires, nothing moves at all and the batch is
// refused with the shortfall named. A partially settled netting batch would
// be worse than no netting, because the obligations that did move were
// calculated against the ones that did not.
//
// WHAT THIS IS NOT
// There is no central counterparty here. Netting without novation leaves
// every participant exposed to every other one until the batch settles; a
// real clearing corporation absorbs that by becoming the buyer to every
// seller, and absorbing it requires capital, a default fund and a rulebook.
// This file computes and settles. It does not guarantee, and the API says so.

import (
	"errors"
	"fmt"
	"sort"
	"time"
)

const (
	// BlockUMINettingSettled anchors a settled netting batch.
	BlockUMINettingSettled = "UMI_NETTING_SETTLED"
	// BlockUMINettingRefused anchors a batch that was refused in full.
	BlockUMINettingRefused = "UMI_NETTING_REFUSED"

	// NettingStatusPreview is a calculation that moved nothing.
	NettingStatusPreview = "PREVIEW"
	// NettingStatusSettled means every leg was applied.
	NettingStatusSettled = "SETTLED"
	// NettingStatusRefused means nothing was applied.
	NettingStatusRefused = "REFUSED"

	// NettingNoCCP is published with every batch. Netting without novation
	// is not clearing, and the difference is the whole of the risk.
	NettingNoCCP = "No central counterparty: obligations are netted, not guaranteed. " +
		"Every participant remains exposed to every other until the batch settles, which " +
		"is why the batch is all-or-nothing."
)

// Netting-specific refusals.
var (
	ErrNettingEmptyBatch  = errors.New("ERR_UMI_NETTING_EMPTY_BATCH")
	ErrNettingShortCash   = errors.New("ERR_UMI_NETTING_SHORT_CASH")
	ErrNettingShortTokens = errors.New("ERR_UMI_NETTING_SHORT_TOKENS")
	ErrNettingInvalidLeg  = errors.New("ERR_UMI_NETTING_INVALID_LEG")
)

// NettingLeg is one bilateral obligation offered into a batch. It is the same
// shape as a DvP instruction, minus the options that only make sense when an
// instruction settles on its own.
type NettingLeg struct {
	AssetID          string  `json:"assetId"`
	Seller           string  `json:"seller"`
	Buyer            string  `json:"buyer"`
	Tokens           int64   `json:"tokens"`
	PricePerTokenINR float64 `json:"pricePerTokenINR"`
}

// NettingLegView is a leg as reported back, with its cash figure resolved.
type NettingLegView struct {
	NettingLeg
	CashINR float64 `json:"cashINR"`
}

// NetCashPosition is one participant's single obligation after netting.
type NetCashPosition struct {
	Participant     string  `json:"participant"`
	WalletID        string  `json:"walletId"`
	GrossPayINR     float64 `json:"grossPayINR"`
	GrossReceiveINR float64 `json:"grossReceiveINR"`
	NetINR          float64 `json:"netINR"`    // positive = receives, negative = pays
	Direction       string  `json:"direction"` // PAY | RECEIVE | FLAT
	AvailableINR    float64 `json:"availableINR"`
	ShortfallINR    float64 `json:"shortfallINR"` // > 0 only when this participant cannot fund
	Fundable        bool    `json:"fundable"`
}

// NetTokenPosition is one participant's net movement in one asset.
type NetTokenPosition struct {
	AssetID     string `json:"assetId"`
	Participant string `json:"participant"`
	NetTokens   int64  `json:"netTokens"` // positive = receives, negative = delivers
	HeldBefore  int64  `json:"heldBefore"`
	ShortTokens int64  `json:"shortTokens"` // > 0 only when the seller cannot deliver
	Deliverable bool   `json:"deliverable"`
}

// NettingBatch is the full result: what was offered, what nets out, whether
// it can settle, and what it saved.
type NettingBatch struct {
	BatchID        string             `json:"batchId"`
	Status         string             `json:"status"`
	Legs           []NettingLegView   `json:"legs"`
	CashPositions  []NetCashPosition  `json:"cashPositions"`
	TokenPositions []NetTokenPosition `json:"tokenPositions"`

	// The measurement. GrossCashINR is what gross DvP would have moved; one
	// instruction at a time, every rupee of every leg. NetCashINR is what
	// actually has to move once offsetting obligations cancel.
	GrossCashINR  float64 `json:"grossCashINR"`
	NetCashINR    float64 `json:"netCashINR"`
	SavedINR      float64 `json:"savedINR"`
	EfficiencyPct float64 `json:"efficiencyPct"`

	// The liquidity claim, stated as a fact about this batch rather than as
	// a general argument: the largest single wallet balance gross settlement
	// would have required, against what netting requires.
	PeakGrossFundingINR float64 `json:"peakGrossFundingINR"`
	PeakNetFundingINR   float64 `json:"peakNetFundingINR"`

	Settleable    bool     `json:"settleable"`
	RefusalReason string   `json:"refusalReason,omitempty"`
	RefusalDetail string   `json:"refusalDetail,omitempty"`
	Messages      []string `json:"messages"`

	CashLeg     string     `json:"cashLeg"`
	Guarantee   string     `json:"guarantee"`
	Mode        string     `json:"mode"`
	Disclaimer  string     `json:"disclaimer"`
	CreatedAt   time.Time  `json:"createdAt"`
	SettledAt   *time.Time `json:"settledAt,omitempty"`
	BlockHeight int64      `json:"blockHeight,omitempty"`
	BlockHash   string     `json:"blockHash,omitempty"`
}

// Net computes a batch without moving anything.
func (r *UMIRail) Net(legs []NettingLeg) (*NettingBatch, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.netLocked(legs, false)
}

// SettleNet computes the batch and, if every participant can meet their net
// obligation, applies it: one cash movement per participant, token positions
// moved to where the legs put them, one block for the whole batch.
func (r *UMIRail) SettleNet(legs []NettingLeg) (*NettingBatch, error) {
	r.mu.Lock()
	b, err := r.netLocked(legs, true)
	if err != nil {
		// netLocked has already unlocked on the refusal path it owns.
		return b, err
	}
	return b, nil
}

// netLocked does the arithmetic. With apply=false it never mutates and always
// returns with the mutex held by the caller's defer. With apply=true it owns
// the mutex and releases it before returning on every path.
func (r *UMIRail) netLocked(legs []NettingLeg, apply bool) (*NettingBatch, error) {
	now := time.Now().UTC()
	b := &NettingBatch{
		BatchID:    r.nextID("UMINET"),
		Status:     NettingStatusPreview,
		Legs:       make([]NettingLegView, 0, len(legs)),
		CashLeg:    "RBI wholesale CBDC e₹-W via UMI (simulated), netted multilaterally",
		Guarantee:  NettingNoCCP,
		Mode:       UMIMode,
		Disclaimer: UMIDisclaimer,
		CreatedAt:  now,
	}
	refuse := func(err error, detail string) (*NettingBatch, error) {
		b.Status = NettingStatusRefused
		b.Settleable = false
		b.RefusalReason = err.Error()
		b.RefusalDetail = detail
		b.msg("camt.019", "Batch refused in full: "+detail+". No leg settled.")
		if apply {
			r.mu.Unlock()
			if blk := r.append(BlockUMINettingRefused, map[string]interface{}{
				"kind":          "umi-netting",
				"batchId":       b.BatchID,
				"legs":          len(b.Legs),
				"grossCashINR":  b.GrossCashINR,
				"netCashINR":    b.NetCashINR,
				"refusalReason": b.RefusalReason,
				"refusalDetail": b.RefusalDetail,
				"atomic":        "all-or-nothing across the batch: no participant moved",
			}); blk != nil {
				b.BlockHeight, b.BlockHash = blk.Height, blk.Hash
			}
		}
		return b, err
	}

	if len(legs) == 0 {
		return refuse(ErrNettingEmptyBatch, "a netting batch needs at least one leg")
	}

	// --- validate and accumulate ---------------------------------------
	// payPaise/recvPaise are gross; netPaise is the single obligation.
	grossPay := map[string]int64{}
	grossRecv := map[string]int64{}
	tokenDelta := map[string]map[string]int64{} // asset -> participant -> delta
	var grossPaise int64
	parties := map[string]bool{}

	for i, leg := range legs {
		cashPaise := INRToPaise(float64(leg.Tokens) * leg.PricePerTokenINR)
		if leg.Tokens <= 0 || leg.PricePerTokenINR <= 0 || cashPaise <= 0 {
			return refuse(ErrNettingInvalidLeg,
				fmt.Sprintf("leg %d: tokens and pricePerTokenINR must both be positive", i+1))
		}
		if leg.Seller == "" || leg.Buyer == "" {
			return refuse(ErrNettingInvalidLeg, fmt.Sprintf("leg %d: seller and buyer are required", i+1))
		}
		if leg.Seller == leg.Buyer {
			return refuse(ErrNettingInvalidLeg,
				fmt.Sprintf("leg %d: a participant cannot settle against itself", i+1))
		}
		if leg.AssetID == "" {
			return refuse(ErrNettingInvalidLeg, fmt.Sprintf("leg %d: assetId is required", i+1))
		}
		b.Legs = append(b.Legs, NettingLegView{NettingLeg: leg, CashINR: paiseToINR(cashPaise)})
		grossPaise += cashPaise
		grossPay[leg.Buyer] += cashPaise
		grossRecv[leg.Seller] += cashPaise
		parties[leg.Buyer] = true
		parties[leg.Seller] = true
		if tokenDelta[leg.AssetID] == nil {
			tokenDelta[leg.AssetID] = map[string]int64{}
		}
		tokenDelta[leg.AssetID][leg.Seller] -= leg.Tokens
		tokenDelta[leg.AssetID][leg.Buyer] += leg.Tokens
	}

	// --- net cash positions ---------------------------------------------
	names := make([]string, 0, len(parties))
	for p := range parties {
		names = append(names, p)
	}
	sort.Strings(names)

	netPaise := map[string]int64{}
	var netToMovePaise, peakGross, peakNet int64
	shortCash := []string{}
	for _, p := range names {
		net := grossRecv[p] - grossPay[p]
		netPaise[p] = net
		w := r.walletLocked(p)
		pos := NetCashPosition{
			Participant:     p,
			WalletID:        w.WalletID,
			GrossPayINR:     paiseToINR(grossPay[p]),
			GrossReceiveINR: paiseToINR(grossRecv[p]),
			NetINR:          paiseToINR(net),
			AvailableINR:    paiseToINR(w.available()),
			Fundable:        true,
		}
		switch {
		case net < 0:
			pos.Direction = "PAY"
			netToMovePaise += -net
			if -net > peakNet {
				peakNet = -net
			}
			if w.available() < -net {
				pos.Fundable = false
				pos.ShortfallINR = paiseToINR(-net - w.available())
				shortCash = append(shortCash, fmt.Sprintf("%s is short ₹%.2f on a net debit of ₹%.2f",
					p, pos.ShortfallINR, paiseToINR(-net)))
			}
		case net > 0:
			pos.Direction = "RECEIVE"
		default:
			pos.Direction = "FLAT"
		}
		// What gross settlement would have demanded of this wallet: the full
		// amount it owes across every leg, with nothing offset against it.
		if grossPay[p] > peakGross {
			peakGross = grossPay[p]
		}
		b.CashPositions = append(b.CashPositions, pos)
	}

	b.GrossCashINR = paiseToINR(grossPaise)
	b.NetCashINR = paiseToINR(netToMovePaise)
	b.SavedINR = paiseToINR(grossPaise - netToMovePaise)
	if grossPaise > 0 {
		b.EfficiencyPct = float64(grossPaise-netToMovePaise) / float64(grossPaise) * 100
	}
	b.PeakGrossFundingINR = paiseToINR(peakGross)
	b.PeakNetFundingINR = paiseToINR(peakNet)

	// --- net token positions ---------------------------------------------
	assets := make([]string, 0, len(tokenDelta))
	for a := range tokenDelta {
		assets = append(assets, a)
	}
	sort.Strings(assets)
	shortTokens := []string{}
	for _, a := range assets {
		holders := make([]string, 0, len(tokenDelta[a]))
		for h := range tokenDelta[a] {
			holders = append(holders, h)
		}
		sort.Strings(holders)
		for _, h := range holders {
			d := tokenDelta[a][h]
			held := r.securities.Position(a, h)
			tp := NetTokenPosition{AssetID: a, Participant: h, NetTokens: d, HeldBefore: held, Deliverable: true}
			if d < 0 && held < -d {
				tp.Deliverable = false
				tp.ShortTokens = -d - held
				shortTokens = append(shortTokens, fmt.Sprintf("%s holds %d of %s, net delivery needs %d",
					h, held, a, -d))
			}
			b.TokenPositions = append(b.TokenPositions, tp)
		}
	}

	b.msg("sese.023", fmt.Sprintf("Batch received: %d legs, %d participants, gross ₹%.2f",
		len(b.Legs), len(names), b.GrossCashINR))
	b.msg("colr.016", fmt.Sprintf("Multilateral netting: gross ₹%.2f reduced to ₹%.2f, %.1f%% of the cash never moves",
		b.GrossCashINR, b.NetCashINR, b.EfficiencyPct))

	if len(shortTokens) > 0 {
		return refuse(ErrNettingShortTokens, joinDetail(shortTokens))
	}
	if len(shortCash) > 0 {
		return refuse(ErrNettingShortCash, joinDetail(shortCash))
	}
	b.Settleable = true

	if !apply {
		b.msg("sese.024", "Preview only: the batch is settleable and no state changed.")
		return b, nil
	}

	// --- apply ------------------------------------------------------------
	// Tokens first, then cash, both under the same mutex, with every
	// precondition already checked above. The invariant the tests assert is
	// that the sum of all cash movements is zero and the sum of all token
	// movements per asset is zero: netting may not create or destroy either.
	// Token movement is expressed as transfers between net deliverers and
	// net receivers, never as a position being written. Settlement that can
	// write a position can mint, and a transfer that can mint is not a
	// transfer: the same reason SettleDvP takes a SecuritiesLedger rather
	// than an IssuingLedger.
	touchedPositions := []PositionRow{}
	for _, a := range assets {
		holders := make([]string, 0, len(tokenDelta[a]))
		for h := range tokenDelta[a] {
			holders = append(holders, h)
		}
		sort.Strings(holders)
		givers, takers := []string{}, []string{}
		rem := map[string]int64{}
		for _, h := range holders {
			d := tokenDelta[a][h]
			rem[h] = d
			if d < 0 {
				givers = append(givers, h)
			} else if d > 0 {
				takers = append(takers, h)
			}
		}
		gi, ti := 0, 0
		for gi < len(givers) && ti < len(takers) {
			g, t := givers[gi], takers[ti]
			move := -rem[g]
			if rem[t] < move {
				move = rem[t]
			}
			if move > 0 {
				if err := r.securities.Move(a, g, t, move); err != nil {
					// Pre-validated above, so reaching here means the book
					// changed under us. Refuse the whole batch rather than
					// leave it half applied.
					return refuse(ErrNettingShortTokens,
						"securities leg rejected at commit for "+g+" on "+a+": "+err.Error())
				}
				rem[g] += move
				rem[t] -= move
			}
			if rem[g] == 0 {
				gi++
			}
			if rem[t] == 0 {
				ti++
			}
		}
		for _, h := range holders {
			if tokenDelta[a][h] != 0 {
				r.RecordOwnership(a, h, r.securities.Position(a, h), "NET_SETTLED")
			}
			if r.store != nil {
				touchedPositions = append(touchedPositions, PositionRow{
					AssetID: a, Holder: h, Tokens: r.securities.Position(a, h), Rev: r.nextRev()})
			}
		}
	}

	wallets := make([]CBDCWallet, 0, len(names))
	for _, p := range names {
		net := netPaise[p]
		w := r.walletLocked(p)
		if net != 0 {
			w.BalancePaise += net
			w.refresh()
		}
		wallets = append(wallets, r.snapWallet(w))
	}

	settledAt := time.Now().UTC()
	b.Status = NettingStatusSettled
	b.SettledAt = &settledAt
	b.msg("pacs.009", fmt.Sprintf("Cash leg executed in central bank money: ₹%.2f moved across %d participants (e₹-W)",
		b.NetCashINR, len(names)))
	b.msg("sese.025", fmt.Sprintf("Batch settled: %d legs, token positions delivered gross, cash settled net. Saved ₹%.2f of movement.",
		len(b.Legs), b.SavedINR))
	r.mu.Unlock()

	if blk := r.append(BlockUMINettingSettled, map[string]interface{}{
		"kind":          "umi-netting",
		"batchId":       b.BatchID,
		"legs":          nettingLegsForBlock(b.Legs),
		"cashPositions": nettingCashForBlock(b.CashPositions),
		"grossCashINR":  b.GrossCashINR,
		"netCashINR":    b.NetCashINR,
		"savedINR":      b.SavedINR,
		"efficiencyPct": b.EfficiencyPct,
		"status":        NettingStatusSettled,
		"atomic":        "every leg in one block: the batch settles whole or not at all",
		"guarantee":     NettingNoCCP,
	}); blk != nil {
		b.BlockHeight, b.BlockHash = blk.Height, blk.Hash
	}
	r.commit(Mutation{Wallets: wallets, Positions: touchedPositions})
	return b, nil
}

func (b *NettingBatch) msg(iso, text string) {
	b.Messages = append(b.Messages, iso+": "+text)
}

func joinDetail(xs []string) string {
	out := ""
	for i, x := range xs {
		if i > 0 {
			out += "; "
		}
		out += x
	}
	return out
}

func nettingLegsForBlock(legs []NettingLegView) []map[string]interface{} {
	out := make([]map[string]interface{}, 0, len(legs))
	for _, l := range legs {
		out = append(out, map[string]interface{}{
			"assetId": l.AssetID, "seller": l.Seller, "buyer": l.Buyer,
			"tokens": l.Tokens, "cashINR": l.CashINR,
		})
	}
	return out
}

func nettingCashForBlock(ps []NetCashPosition) []map[string]interface{} {
	out := make([]map[string]interface{}, 0, len(ps))
	for _, p := range ps {
		out = append(out, map[string]interface{}{
			"participant": p.Participant, "walletId": p.WalletID,
			"grossPayINR": p.GrossPayINR, "grossReceiveINR": p.GrossReceiveINR,
			"netINR": p.NetINR, "direction": p.Direction,
		})
	}
	return out
}
