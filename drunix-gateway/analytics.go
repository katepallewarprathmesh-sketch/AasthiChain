package drunix

// Advanced analytics — performance and risk, derived from settled history.
//
// Everything here is DERIVED. No new state, no new block types, nothing that
// can be written to: the numbers are recomputed from the settlement
// instructions, the servicing records and the position book that the rail
// already holds. If analytics and the ledger ever disagree, the ledger is
// right and this file has a bug.
//
// Three decisions worth stating, because they are the ones that make a
// performance number mean something specific rather than roughly-a-profit:
//
//  1. Cost basis is WEIGHTED AVERAGE, not FIFO. When an investor sells part of
//     a holding, the cost removed is the average cost of what they hold at
//     that moment. Average cost is what Indian mutual-fund and broker
//     statements show, and unlike FIFO it does not need a lot-by-lot register
//     that this rail never kept. It is stated in the response so nobody has to
//     reverse-engineer which convention produced the figure.
//
//  2. The mark price is the LAST PRICE THIS ASSET ACTUALLY SETTLED AT across
//     the whole rail — not an appraisal, not the issue price. If an asset has
//     never traded, it is marked at the holder's own cost, which makes the
//     unrealised P&L exactly zero instead of inventing a gain. Marking an
//     untraded asset at anything other than cost is how you manufacture
//     returns that do not exist, so the response labels the source of every
//     mark.
//
//  3. Dry runs and unsettled instructions are excluded everywhere. A
//     settlement that did not happen must not move a performance figure.
//
// Rounding: money is rounded to paise at the edge, never accumulated from
// rounded parts.

import (
	"math"
	"sort"
	"time"
)

// Cost-basis conventions reported in the response.
const (
	costBasisWeightedAverage = "weightedAverage"
)

// Mark sources, so a client can show how a valuation was arrived at.
const (
	markSourceLastTrade = "lastTrade" // the asset traded; marked at that price
	markSourceCost      = "cost"      // never traded; marked at the holder's own cost
	markSourceNone      = "none"      // no position and no history
)

// AssetPerformance is one asset's contribution to an investor's portfolio.
type AssetPerformance struct {
	AssetID string `json:"assetId"`
	ISIN    string `json:"isin,omitempty"`
	Tokens  int64  `json:"tokens"`

	AvgCostINR  float64 `json:"avgCostPerTokenINR"`
	CostBaseINR float64 `json:"costBasisINR"`

	MarkPriceINR float64 `json:"markPricePerTokenINR"`
	MarkSource   string  `json:"markSource"`
	MarketINR    float64 `json:"marketValueINR"`

	UnrealisedINR float64 `json:"unrealisedPnlINR"`
	RealisedINR   float64 `json:"realisedPnlINR"`
	IncomeINR     float64 `json:"incomeINR"`

	// TotalReturnPct is (unrealised + realised + income) over the money the
	// investor actually put in for this asset. Nil when they never paid
	// anything for it (a seeded position), because a return on zero outlay is
	// not a percentage, it is a divide by zero.
	TotalReturnPct *float64 `json:"totalReturnPct"`

	Trades       int   `json:"trades"`
	TokensBought int64 `json:"tokensBought"`
	TokensSold   int64 `json:"tokensSold"`

	FirstTradeAt *time.Time `json:"firstTradeAt,omitempty"`
	LastTradeAt  *time.Time `json:"lastTradeAt,omitempty"`
}

// Concentration measures how much of a portfolio rides on one asset.
type Concentration struct {
	// LargestPct is the biggest single holding as a share of market value.
	LargestPct float64 `json:"largestPositionPct"`
	LargestID  string  `json:"largestPositionAssetId,omitempty"`
	// HHI is the Herfindahl-Hirschman index over portfolio weights, scaled
	// 0-10000. One asset = 10000. The competition-authority thresholds are
	// the familiar reference points: under 1500 is diffuse, over 2500 is
	// concentrated.
	HHI float64 `json:"hhi"`
	// EffectiveAssets is 1/Σw² — how many equally sized holdings this
	// portfolio behaves like. Four assets at 97/1/1/1 is effectively one.
	EffectiveAssets float64 `json:"effectiveAssets"`
	Assets          int     `json:"assetsHeld"`
	Verdict         string  `json:"verdict"`
}

// InvestorAnalytics is the full performance picture for one participant.
type InvestorAnalytics struct {
	Participant string `json:"participant"`

	CostBasisMethod string `json:"costBasisMethod"`

	InvestedINR    float64  `json:"investedINR"`    // cost of what is still held
	MarketValueINR float64  `json:"marketValueINR"` // held, at mark
	UnrealisedINR  float64  `json:"unrealisedPnlINR"`
	RealisedINR    float64  `json:"realisedPnlINR"`
	IncomeINR      float64  `json:"incomeINR"`
	NetPnlINR      float64  `json:"netPnlINR"`
	CashINR        float64  `json:"cashBalanceINR"`
	NetWorthINR    float64  `json:"netWorthINR"` // market value + cash
	TotalOutlayINR float64  `json:"totalOutlayINR"`
	TotalReturnPct *float64 `json:"totalReturnPct"`
	// AnnualisedPct extrapolates the total return over the holding period.
	// Nil for a period under a week: annualising three days of a demo ledger
	// produces a number in the thousands of percent and means nothing.
	AnnualisedPct *float64 `json:"annualisedReturnPct"`
	HoldingDays   float64  `json:"holdingPeriodDays"`

	Concentration Concentration      `json:"concentration"`
	Assets        []AssetPerformance `json:"assets"`

	Trades        int        `json:"settledTrades"`
	FailedTrades  int        `json:"failedTrades"`
	FirstActivity *time.Time `json:"firstActivityAt,omitempty"`
	LastActivity  *time.Time `json:"lastActivityAt,omitempty"`

	Note string `json:"note"`
}

// lot tracks a running weighted-average position while replaying history.
type lot struct {
	tokens    int64
	costPaise int64 // total cost of the tokens currently held
	realised  int64
	bought    int64
	sold      int64
	trades    int
	first     *time.Time
	last      *time.Time
}

// avgCostPaise is the per-token average cost of what is held right now.
func (l *lot) avgCostPaise() float64 {
	if l.tokens <= 0 {
		return 0
	}
	return float64(l.costPaise) / float64(l.tokens)
}

// buy adds tokens at a price, raising the average cost.
func (l *lot) buy(tokens, cashPaise int64, at time.Time) {
	l.tokens += tokens
	l.costPaise += cashPaise
	l.bought += tokens
	l.touch(at)
}

// sell removes tokens at the running average cost and books the difference as
// realised profit or loss. Selling more than the replay thinks is held can
// happen when a position was seeded rather than bought, so the cost removed is
// capped at what is on the books instead of going negative.
func (l *lot) sell(tokens, cashPaise int64, at time.Time) {
	avg := l.avgCostPaise()
	costOut := int64(math.Round(avg * float64(tokens)))
	if costOut > l.costPaise {
		costOut = l.costPaise
	}
	l.realised += cashPaise - costOut
	l.costPaise -= costOut
	l.tokens -= tokens
	if l.tokens < 0 {
		l.tokens = 0
		l.costPaise = 0
	}
	l.sold += tokens
	l.touch(at)
}

func (l *lot) touch(at time.Time) {
	l.trades++
	t := at
	if l.first == nil || t.Before(*l.first) {
		c := t
		l.first = &c
	}
	if l.last == nil || t.After(*l.last) {
		c := t
		l.last = &c
	}
}

// settledAt is the time a settlement completed, falling back to creation time
// for records restored without one.
func settledAt(si *SettlementInstruction) time.Time {
	if si.SettledAt != nil {
		return *si.SettledAt
	}
	return si.CreatedAt
}

// countsForPerformance filters out everything that did not actually move value.
func countsForPerformance(si *SettlementInstruction) bool {
	return si.Status == UMIStatusSettled && !si.DryRun && si.Tokens > 0
}

// Analytics computes performance and risk for one participant.
//
// Takes r.mu for the duration of the read so the instruction list, the
// servicing records and the position book are all read from the same instant;
// a settlement landing midway through would otherwise produce a portfolio that
// never existed.
func (r *UMIRail) Analytics(participant string) InvestorAnalytics {
	r.mu.Lock()
	defer r.mu.Unlock()

	out := InvestorAnalytics{
		Participant:     participant,
		CostBasisMethod: costBasisWeightedAverage,
		Assets:          []AssetPerformance{},
		Note:            "Derived from settled instructions; dry runs and unsettled instructions are excluded. Marks are last traded price, or cost where an asset has never traded.",
	}

	// Replay in chronological order — a weighted average is path dependent,
	// so processing a sale before the purchase that funded it gives the wrong
	// cost basis.
	hist := make([]*SettlementInstruction, 0, len(r.order))
	for _, id := range r.order {
		if si, ok := r.instructions[id]; ok {
			hist = append(hist, si)
		}
	}
	sort.SliceStable(hist, func(i, j int) bool {
		return settledAt(hist[i]).Before(settledAt(hist[j]))
	})

	// Rail-wide last traded price per asset, used to mark every holder's book
	// consistently. Built from the same chronological pass.
	lastPricePaise := map[string]int64{}
	lots := map[string]*lot{}
	lotFor := func(assetID string) *lot {
		if l, ok := lots[assetID]; ok {
			return l
		}
		l := &lot{}
		lots[assetID] = l
		return l
	}

	for _, si := range hist {
		if !countsForPerformance(si) {
			if si.Status == UMIStatusFailed && !si.DryRun &&
				(si.Buyer == participant || si.Seller == participant) {
				out.FailedTrades++
			}
			continue
		}
		if si.Tokens > 0 {
			lastPricePaise[si.AssetID] = int64(math.Round(float64(si.CashPaise) / float64(si.Tokens)))
		}
		when := settledAt(si)
		switch participant {
		case si.Buyer:
			lotFor(si.AssetID).buy(si.Tokens, si.CashPaise, when)
			out.Trades++
			markActivity(&out, when)
		case si.Seller:
			lotFor(si.AssetID).sell(si.Tokens, si.CashPaise, when)
			out.Trades++
			markActivity(&out, when)
		}
	}

	// Income received, per asset and in total.
	incomeByAsset := map[string]int64{}
	var incomePaise int64
	for i := range r.servicing {
		if r.servicing[i].Holder != participant {
			continue
		}
		incomeByAsset[r.servicing[i].AssetID] += r.servicing[i].AmountPaise
		incomePaise += r.servicing[i].AmountPaise
		markActivity(&out, r.servicing[i].SettledAt)
	}

	// Every asset the participant has a position in or a history with. A sold
	// out position still belongs in the report — its realised P&L is real.
	assetIDs := map[string]bool{}
	for id := range lots {
		assetIDs[id] = true
	}
	for id := range incomeByAsset {
		assetIDs[id] = true
	}
	// The securities ledger has no "list every asset" call, so the known
	// universe is the set the rail has issued supply or an ISIN for. A
	// position can only exist against one of those.
	for id := range r.authorised {
		if r.securities.Position(id, participant) > 0 {
			assetIDs[id] = true
		}
	}
	for id := range r.isins {
		if r.securities.Position(id, participant) > 0 {
			assetIDs[id] = true
		}
	}

	var totalCost, totalMarket, totalRealised int64
	rows := make([]AssetPerformance, 0, len(assetIDs))
	for id := range assetIDs {
		l := lots[id]
		if l == nil {
			l = &lot{}
		}
		held := r.securities.Position(id, participant)

		// The book of record is the securities ledger, not the replay. They
		// differ when a position was seeded (no purchase, so no cost) or
		// restored from the store. Trust the ledger for the quantity and
		// scale the replayed cost to match, so cost per token stays sane.
		costPaise := l.costPaise
		if l.tokens != held {
			if l.tokens > 0 {
				costPaise = int64(math.Round(l.avgCostPaise() * float64(held)))
			} else {
				costPaise = 0 // never bought it: zero cost, not an invented one
			}
		}

		markPaise, source := int64(0), markSourceNone
		if p, ok := lastPricePaise[id]; ok && p > 0 {
			markPaise, source = p, markSourceLastTrade
		} else if held > 0 && costPaise > 0 {
			markPaise = int64(math.Round(float64(costPaise) / float64(held)))
			source = markSourceCost
		}
		marketPaise := markPaise * held

		row := AssetPerformance{
			AssetID:       id,
			Tokens:        held,
			CostBaseINR:   paiseToINR(costPaise),
			MarkPriceINR:  paiseToINR(markPaise),
			MarkSource:    source,
			MarketINR:     paiseToINR(marketPaise),
			UnrealisedINR: paiseToINR(marketPaise - costPaise),
			RealisedINR:   paiseToINR(l.realised),
			IncomeINR:     paiseToINR(incomeByAsset[id]),
			Trades:        l.trades,
			TokensBought:  l.bought,
			TokensSold:    l.sold,
			FirstTradeAt:  l.first,
			LastTradeAt:   l.last,
		}
		if held > 0 && costPaise > 0 {
			row.AvgCostINR = paiseToINR(int64(math.Round(float64(costPaise) / float64(held))))
		}
		if isin, ok := r.isins[id]; ok && isin != nil {
			row.ISIN = isin.ISIN
		}
		// Return is measured against what was paid in, which for a position
		// already sold is the cost that has left the book.
		outlay := costPaise
		if outlay == 0 && l.sold > 0 {
			outlay = int64(math.Round(l.avgCostPaise() * float64(l.sold)))
		}
		if outlay > 0 {
			pct := round2(float64(marketPaise-costPaise+l.realised+incomeByAsset[id]) / float64(outlay) * 100)
			row.TotalReturnPct = &pct
		}

		totalCost += costPaise
		totalMarket += marketPaise
		totalRealised += l.realised
		rows = append(rows, row)
	}

	// Largest market value first — the answer to "what am I most exposed to"
	// should be the first row.
	sort.SliceStable(rows, func(i, j int) bool {
		if rows[i].MarketINR != rows[j].MarketINR {
			return rows[i].MarketINR > rows[j].MarketINR
		}
		return rows[i].AssetID < rows[j].AssetID
	})
	out.Assets = rows

	var cashPaise int64
	if w, ok := r.wallets[participant]; ok && w != nil {
		cashPaise = w.BalancePaise
	}

	out.InvestedINR = paiseToINR(totalCost)
	out.MarketValueINR = paiseToINR(totalMarket)
	out.UnrealisedINR = paiseToINR(totalMarket - totalCost)
	out.RealisedINR = paiseToINR(totalRealised)
	out.IncomeINR = paiseToINR(incomePaise)
	out.NetPnlINR = paiseToINR(totalMarket - totalCost + totalRealised + incomePaise)
	out.CashINR = paiseToINR(cashPaise)
	out.NetWorthINR = paiseToINR(totalMarket + cashPaise)
	out.TotalOutlayINR = paiseToINR(totalCost)

	if totalCost > 0 {
		pct := round2(float64(totalMarket-totalCost+totalRealised+incomePaise) / float64(totalCost) * 100)
		out.TotalReturnPct = &pct
		if out.FirstActivity != nil {
			days := time.Since(*out.FirstActivity).Hours() / 24
			out.HoldingDays = round2(days)
			// Annualising a very short period turns noise into a headline
			// number. A week is the floor.
			if days >= 7 {
				ann := round2((math.Pow(1+pct/100, 365/days) - 1) * 100)
				if !math.IsInf(ann, 0) && !math.IsNaN(ann) {
					out.AnnualisedPct = &ann
				}
			}
		}
	}
	out.Concentration = concentrationOf(rows)
	return out
}

// markActivity widens the first/last activity window.
func markActivity(a *InvestorAnalytics, t time.Time) {
	if t.IsZero() {
		return
	}
	if a.FirstActivity == nil || t.Before(*a.FirstActivity) {
		c := t
		a.FirstActivity = &c
	}
	if a.LastActivity == nil || t.After(*a.LastActivity) {
		c := t
		a.LastActivity = &c
	}
}

// concentrationOf measures single-name risk across held positions.
func concentrationOf(rows []AssetPerformance) Concentration {
	var total float64
	held := make([]AssetPerformance, 0, len(rows))
	for _, r := range rows {
		if r.Tokens > 0 && r.MarketINR > 0 {
			total += r.MarketINR
			held = append(held, r)
		}
	}
	c := Concentration{Assets: len(held), Verdict: "no holdings"}
	if total <= 0 || len(held) == 0 {
		return c
	}
	var hhi float64
	for _, r := range held {
		w := r.MarketINR / total
		hhi += w * w
		if pct := round2(w * 100); pct > c.LargestPct {
			c.LargestPct, c.LargestID = pct, r.AssetID
		}
	}
	c.HHI = round2(hhi * 10000)
	c.EffectiveAssets = round2(1 / hhi)
	switch {
	case c.HHI >= 2500:
		c.Verdict = "concentrated"
	case c.HHI >= 1500:
		c.Verdict = "moderately concentrated"
	default:
		c.Verdict = "diversified"
	}
	return c
}

// ---------------------------------------------------------------------------
// Rail-level analytics
// ---------------------------------------------------------------------------

// AssetActivity summarises trading in one asset.
type AssetActivity struct {
	AssetID       string     `json:"assetId"`
	Trades        int        `json:"trades"`
	TokensTraded  int64      `json:"tokensTraded"`
	VolumeINR     float64    `json:"volumeINR"`
	LastPriceINR  float64    `json:"lastPriceINR"`
	FirstPriceINR float64    `json:"firstPriceINR"`
	ChangePct     *float64   `json:"priceChangePct"`
	Holders       int        `json:"holders"`
	LastTradeAt   *time.Time `json:"lastTradeAt,omitempty"`
}

// DayVolume is one day of settlement activity.
type DayVolume struct {
	Date      string  `json:"date"`
	Trades    int     `json:"trades"`
	VolumeINR float64 `json:"volumeINR"`
	Failed    int     `json:"failed"`
}

// RailAnalytics is the market-wide view.
type RailAnalytics struct {
	Settled          int64            `json:"settled"`
	Failed           int64            `json:"failed"`
	SuccessRatePct   float64          `json:"successRatePct"`
	FailuresByReason map[string]int64 `json:"failuresByReason"`
	VolumeINR        float64          `json:"volumeINR"`
	TokensTraded     int64            `json:"tokensTraded"`
	AvgTradeINR      float64          `json:"averageTradeINR"`
	Participants     int              `json:"participants"`
	AssetsTraded     int              `json:"assetsTraded"`
	TopAssets        []AssetActivity  `json:"topAssets"`
	Daily            []DayVolume      `json:"daily"`
	Note             string           `json:"note"`
}

// RailAnalytics summarises settlement activity across every participant.
// Dry runs are excluded; failures are counted but contribute no volume.
func (r *UMIRail) RailAnalytics(days int) RailAnalytics {
	if days <= 0 {
		days = 14
	}
	r.mu.Lock()
	defer r.mu.Unlock()

	out := RailAnalytics{
		FailuresByReason: map[string]int64{},
		TopAssets:        []AssetActivity{},
		Daily:            []DayVolume{},
		Note:             "Settled, non-dry-run instructions only. Volume is the cash leg actually moved.",
	}

	type agg struct {
		trades      int
		tokens      int64
		volumePaise int64
		firstPaise  int64
		lastPaise   int64
		lastAt      *time.Time
	}
	byAsset := map[string]*agg{}
	byDay := map[string]*DayVolume{}
	participants := map[string]bool{}

	hist := make([]*SettlementInstruction, 0, len(r.order))
	for _, id := range r.order {
		if si, ok := r.instructions[id]; ok {
			hist = append(hist, si)
		}
	}
	sort.SliceStable(hist, func(i, j int) bool {
		return settledAt(hist[i]).Before(settledAt(hist[j]))
	})

	cutoff := time.Now().UTC().AddDate(0, 0, -days)
	for _, si := range hist {
		if si.DryRun {
			continue
		}
		when := settledAt(si)
		day := when.UTC().Format("2006-01-02")
		if when.After(cutoff) {
			if byDay[day] == nil {
				byDay[day] = &DayVolume{Date: day}
			}
		}
		if si.Status == UMIStatusFailed {
			out.Failed++
			if si.FailureReason != "" {
				out.FailuresByReason[si.FailureReason]++
			}
			if d := byDay[day]; d != nil {
				d.Failed++
			}
			continue
		}
		if !countsForPerformance(si) {
			continue
		}
		out.Settled++
		out.TokensTraded += si.Tokens
		participants[si.Buyer] = true
		participants[si.Seller] = true

		a := byAsset[si.AssetID]
		if a == nil {
			a = &agg{}
			byAsset[si.AssetID] = a
		}
		unit := int64(math.Round(float64(si.CashPaise) / float64(si.Tokens)))
		if a.trades == 0 {
			a.firstPaise = unit
		}
		a.trades++
		a.tokens += si.Tokens
		a.volumePaise += si.CashPaise
		a.lastPaise = unit
		w := when
		a.lastAt = &w

		if d := byDay[day]; d != nil {
			d.Trades++
			d.VolumeINR = round2(d.VolumeINR + paiseToINR(si.CashPaise))
		}
	}

	var volumePaise int64
	for id, a := range byAsset {
		volumePaise += a.volumePaise
		row := AssetActivity{
			AssetID:       id,
			Trades:        a.trades,
			TokensTraded:  a.tokens,
			VolumeINR:     paiseToINR(a.volumePaise),
			LastPriceINR:  paiseToINR(a.lastPaise),
			FirstPriceINR: paiseToINR(a.firstPaise),
			Holders:       len(r.securities.Holders(id)),
			LastTradeAt:   a.lastAt,
		}
		if a.firstPaise > 0 {
			pct := round2(float64(a.lastPaise-a.firstPaise) / float64(a.firstPaise) * 100)
			row.ChangePct = &pct
		}
		out.TopAssets = append(out.TopAssets, row)
	}
	sort.SliceStable(out.TopAssets, func(i, j int) bool {
		if out.TopAssets[i].VolumeINR != out.TopAssets[j].VolumeINR {
			return out.TopAssets[i].VolumeINR > out.TopAssets[j].VolumeINR
		}
		return out.TopAssets[i].AssetID < out.TopAssets[j].AssetID
	})

	out.VolumeINR = paiseToINR(volumePaise)
	out.Participants = len(participants)
	out.AssetsTraded = len(byAsset)
	if out.Settled > 0 {
		out.AvgTradeINR = round2(out.VolumeINR / float64(out.Settled))
	}
	if total := out.Settled + out.Failed; total > 0 {
		out.SuccessRatePct = round2(float64(out.Settled) / float64(total) * 100)
	}

	dates := make([]string, 0, len(byDay))
	for d := range byDay {
		dates = append(dates, d)
	}
	sort.Strings(dates)
	for _, d := range dates {
		out.Daily = append(out.Daily, *byDay[d])
	}
	return out
}

// round2 rounds to two decimals — money and percentages, as displayed.
func round2(f float64) float64 {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return 0
	}
	return math.Round(f*100) / 100
}
