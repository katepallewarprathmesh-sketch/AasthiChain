package drunix

// Recourse: what a holder actually gets when the thing under the token fails.
//
// WHY THIS FILE EXISTS
// Every tokenisation platform, including this one until now, answers the
// question "what if it fails?" in prose. Prose is where the hedging lives.
// "Investors are protected by a robust framework" is a sentence that survives
// contact with a regulator for about four seconds, because the next question
// is always the same: protected by what, paid out of which pot, in what
// order, and who decides it happened.
//
// So recourse here is data. An asset carries an ordered claim priority, a set
// of triggers with an observable test for each, and a remedy per rank. Given
// an asset, a trigger and a holder, the rail walks the waterfall and returns
// the number.
//
// THE RULE THAT KEEPS IT HONEST
// A remedy counts as funded only if it names a pot that this ledger can see:
// a backing statement that exists and is not withdrawn, or a reserve wallet
// with a balance. Anything else is recorded, simulated, and paid at zero.
// That rule is enforced here rather than in a disclaimer, because a simulated
// waterfall presented as protection is worse than saying nothing: it teaches
// a holder to expect money that does not exist.
//
// The consequence, today, is that the default simulation for every asset
// returns a recovery of zero and says so in the first field. That is the
// correct answer and it is the reason this is worth shipping. The structure
// is what a real cohort would fill in; the zero is what is true now.
//
// What this is NOT: a legal opinion, an insurance product, or a promise. No
// remedy described here has been underwritten by anyone.

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

// Block types for the recourse record.
const (
	// BlockRecourseTermsSet records the terms an asset is sold under. They
	// go on the ledger because terms a holder cannot prove were in force at
	// the time they bought are not terms.
	BlockRecourseTermsSet = "UMI_RECOURSE_TERMS_SET"
	// BlockRecourseTriggerDeclared records that a supervisor has declared a
	// trigger live for an asset. Declaring it pays nobody; it starts the
	// clock and fixes the facts.
	BlockRecourseTriggerDeclared = "UMI_RECOURSE_TRIGGER_DECLARED"
)

// RecourseDisclaimer is attached to every answer this file produces.
const RecourseDisclaimer = "This is a simulation of a claim waterfall on a demo rail. No remedy described here has been " +
	"underwritten, insured or funded by anyone, and nothing in this system can compel a payment. A rank is " +
	"reported as funded only when it names a pot this ledger can see; every other rank pays zero, which is " +
	"the honest answer and not a placeholder."

// Trigger identifiers. These are the four ways the thing under the token
// fails. They are deliberately few: a long list of triggers is a sign that
// nobody has decided which ones matter.
const (
	TriggerIssuerDefault        = "ISSUER_DEFAULT"
	TriggerImpairment           = "ASSET_IMPAIRMENT"
	TriggerAttestationWithdrawn = "ATTESTATION_WITHDRAWN"
	TriggerCustodianFailure     = "CUSTODIAN_FAILURE"
)

// Funding sources a rank may name.
const (
	// FundingBackingStatement: paid from the valuation in the asset's
	// backing statement. Real only while that statement stands.
	FundingBackingStatement = "backing-statement"
	// FundingReserveWallet: paid from a named wallet on this rail. Real to
	// the extent that the wallet has a balance.
	FundingReserveWallet = "reserve-wallet"
	// FundingNone: described but unfunded. Pays zero, always.
	FundingNone = "none"
)

var (
	ErrRecourseFields      = errors.New("recourse: an asset id, a known trigger and a holder are all required")
	ErrRecourseUnknownTrig = errors.New("recourse: unknown trigger")
	ErrRecourseNoPosition  = errors.New("recourse: that holder holds nothing in this asset, so there is nothing to recover")
	ErrRecourseNotYours    = errors.New("recourse: only a registrar or a supervisor sets the terms an asset is sold under")
	ErrRecourseBadRank     = errors.New("recourse: every rank needs a claimant, a remedy and a funding source of backing-statement, reserve-wallet or none")
)

// RecourseRank is one step of the waterfall: a class of claimant, what they
// are owed, and where it would come from.
type RecourseRank struct {
	Rank     int    `json:"rank"`
	Claimant string `json:"claimant"`
	Remedy   string `json:"remedy"`
	// Funding names the pot. Anything other than a pot this ledger can see
	// resolves to FundingNone when the waterfall is walked.
	Funding string `json:"funding"`
	// ReserveWallet is the wallet id when Funding is FundingReserveWallet.
	ReserveWallet string `json:"reserveWallet,omitempty"`
	// CapPaise bounds this rank. Zero means uncapped.
	CapPaise int64 `json:"capPaise,omitempty"`
}

// RecourseTrigger is one failure, with the fact that makes it observable.
// A trigger whose test is "the board determines that a material adverse
// event has occurred" is not a trigger, it is a discretion.
type RecourseTrigger struct {
	ID string `json:"id"`
	// Test is the observable fact. Stated so a holder can check it.
	Test string `json:"test"`
	// Observable reports whether this rail can see that fact today, and
	// Source names the endpoint that shows it.
	Observable bool   `json:"observableOnThisRail"`
	Source     string `json:"source,omitempty"`
	// DeclaredBy says who may declare it. "nobody" is a real answer and
	// means the trigger has no owner, which is itself a finding.
	DeclaredBy string `json:"declaredBy"`
}

// RecourseTerms is the whole of what an asset is sold under.
type RecourseTerms struct {
	AssetID      string            `json:"assetId"`
	Jurisdiction string            `json:"jurisdiction"`
	Vehicle      string            `json:"vehicle"`
	Priority     []RecourseRank    `json:"claimPriority"`
	Triggers     []RecourseTrigger `json:"triggers"`
	// Default reports that nobody has registered terms for this asset and
	// these are the house defaults. A holder should know the difference
	// between terms somebody wrote down and terms nobody did.
	Default bool      `json:"houseDefault"`
	SetBy   string    `json:"setBy,omitempty"`
	SetAt   time.Time `json:"setAt,omitempty"`
	Block   int64     `json:"block,omitempty"`
	// Gaps are the things these terms do not cover, listed by the terms
	// themselves rather than discovered by the holder.
	Gaps []string `json:"gapsInTheseTerms"`
}

// RecoursePayout is one rank after the waterfall has been walked, with the
// arithmetic rather than the intention.
type RecoursePayout struct {
	Rank          int    `json:"rank"`
	Claimant      string `json:"claimant"`
	Remedy        string `json:"remedy"`
	Funding       string `json:"funding"`
	Funded        bool   `json:"funded"`
	ClaimPaise    int64  `json:"claimPaise"`
	AvailablePais int64  `json:"availablePaise"`
	PaidPaise     int64  `json:"paidPaise"`
	ShortfallPais int64  `json:"shortfallPaise"`
	// Why explains the number, especially when it is zero.
	Why string `json:"why"`
}

// RecourseSimulation is the answer to "if this fails, what do I get".
type RecourseSimulation struct {
	AssetID string `json:"assetId"`
	Holder  string `json:"holder"`
	Trigger string `json:"trigger"`

	// The headline, first, because it is the only line most readers need.
	RecoveryPaise int64  `json:"recoveryPaise"`
	RecoveryINR   string `json:"recoveryINR"`
	Verdict       string `json:"verdict"`

	TriggerObservable bool   `json:"triggerObservableOnThisRail"`
	TriggerTest       string `json:"triggerTest"`
	TriggerSource     string `json:"triggerSource,omitempty"`
	TriggerDeclaredBy string `json:"triggerDeclaredBy"`

	HolderTokens      int64  `json:"holderTokens"`
	TokensOutstanding int64  `json:"tokensOutstanding"`
	HolderSharePct    string `json:"holderSharePercent"`

	PoolPaise  int64            `json:"recoverablePoolPaise"`
	PoolSource string           `json:"recoverablePoolSource"`
	Waterfall  []RecoursePayout `json:"waterfall"`

	TermsAreHouseDefault bool     `json:"termsAreHouseDefault"`
	Gaps                 []string `json:"gapsInTheseTerms"`
	Disclaimer           string   `json:"disclaimer"`
}

// RecourseDesk holds the terms per asset and walks the waterfall. Like the
// backing registry, it derives every figure at read time from the live book,
// so a number here cannot drift away from the ledger it describes.
type RecourseDesk struct {
	mu      sync.Mutex
	rail    *UMIRail
	backing *BackingRegistry
	terms   map[string]*RecourseTerms
}

// NewRecourseDesk wires the layer. A nil rail disables it. The backing
// registry may be nil, in which case no rank can ever be funded from a
// backing statement, which the simulation will say.
func NewRecourseDesk(rail *UMIRail, backing *BackingRegistry) *RecourseDesk {
	if rail == nil {
		return nil
	}
	return &RecourseDesk{rail: rail, backing: backing, terms: make(map[string]*RecourseTerms)}
}

// houseDefaults are the terms that apply when nobody has written any: the
// honest description of this platform as it stands. Every rank is unfunded,
// because every rank is in fact unfunded, and two of the four triggers have
// no owner who may declare them.
//
// Writing the defaults this way means a new asset does not quietly inherit
// a flattering story. It inherits the truth, and somebody has to do work to
// replace it with something better.
func houseDefaults(assetID string) *RecourseTerms {
	return &RecourseTerms{
		AssetID:      assetID,
		Jurisdiction: "India. No forum has been agreed and no arbitration clause exists.",
		Vehicle: "None. Tokens here are a position on this rail, not a beneficial interest in a " +
			"special-purpose vehicle holding legal title. That structure is Phase 2 and is not built.",
		Default: true,
		Priority: []RecourseRank{
			{Rank: 1, Claimant: "Secured creditor of the issuer", Remedy: "Enforces against the property outside this rail, before any token holder is considered.", Funding: FundingNone},
			{Rank: 2, Claimant: "Token holders, pro rata", Remedy: "A share of whatever the property realises, proportional to tokens held.", Funding: FundingNone},
			{Rank: 3, Claimant: "The platform", Remedy: "Unpaid fees. Ranked last deliberately: a platform that ranks above its holders is selling itself, not the asset.", Funding: FundingNone},
		},
		Triggers: []RecourseTrigger{
			{
				ID: TriggerIssuerDefault, DeclaredBy: "nobody",
				Test:       "The issuer stops meeting an obligation: a distribution missed, or an insolvency filing.",
				Observable: false,
			},
			{
				ID: TriggerImpairment, DeclaredBy: "registrar or supervisor",
				Test:       "A new backing statement values the asset below the value of tokens outstanding.",
				Observable: true, Source: "GET /umi/backing/{assetId}",
			},
			{
				ID: TriggerAttestationWithdrawn, DeclaredBy: "the attestor, or a supervisor",
				Test:       "The attestation under the asset is withdrawn, which blocks further issuance immediately.",
				Observable: true, Source: "GET /umi/attestations/{credentialId}",
			},
			{
				ID: TriggerCustodianFailure, DeclaredBy: "nobody",
				Test:       "The party holding the deed or the cash leg fails.",
				Observable: false,
			},
		},
		Gaps: []string{
			"No rank is funded. The waterfall describes an order of payment for money that does not exist.",
			"Two of the four triggers have no owner who may declare them, so they can occur without anything happening.",
			"There is no SPV, so a token holder has no claim on legal title, only a position on this rail.",
			"Nothing here can compel a payment. The rail records an entitlement; it does not enforce one.",
		},
	}
}

// Terms returns the terms for an asset, falling back to the house defaults.
func (d *RecourseDesk) Terms(assetID string) *RecourseTerms {
	assetID = strings.TrimSpace(assetID)
	if d == nil {
		return houseDefaults(assetID)
	}
	d.mu.Lock()
	t, ok := d.terms[assetID]
	d.mu.Unlock()
	if !ok {
		return houseDefaults(assetID)
	}
	cp := *t
	return &cp
}

// SetTerms records the terms an asset is sold under. Registrar or supervisor
// only: terms written by the issuer about the issuer's own failure are a
// marketing document.
func (d *RecourseDesk) SetTerms(t RecourseTerms, actor string, maySet bool) (*RecourseTerms, error) {
	if d == nil {
		return nil, ErrRecourseFields
	}
	if !maySet {
		return nil, ErrRecourseNotYours
	}
	assetID := strings.TrimSpace(t.AssetID)
	if assetID == "" || len(t.Priority) == 0 {
		return nil, ErrRecourseFields
	}
	for i := range t.Priority {
		rk := &t.Priority[i]
		rk.Claimant = strings.TrimSpace(rk.Claimant)
		rk.Remedy = strings.TrimSpace(rk.Remedy)
		switch rk.Funding {
		case FundingBackingStatement, FundingReserveWallet, FundingNone:
		case "":
			rk.Funding = FundingNone
		default:
			return nil, ErrRecourseBadRank
		}
		if rk.Claimant == "" || rk.Remedy == "" {
			return nil, ErrRecourseBadRank
		}
		if rk.Funding == FundingReserveWallet && strings.TrimSpace(rk.ReserveWallet) == "" {
			return nil, ErrRecourseBadRank
		}
		if rk.CapPaise < 0 {
			return nil, ErrRecourseBadRank
		}
	}
	sort.SliceStable(t.Priority, func(i, j int) bool { return t.Priority[i].Rank < t.Priority[j].Rank })
	for i := range t.Priority {
		t.Priority[i].Rank = i + 1
	}

	def := houseDefaults(assetID)
	if len(t.Triggers) == 0 {
		t.Triggers = def.Triggers
	}
	if strings.TrimSpace(t.Jurisdiction) == "" {
		t.Jurisdiction = def.Jurisdiction
	}
	if strings.TrimSpace(t.Vehicle) == "" {
		t.Vehicle = def.Vehicle
	}
	t.AssetID = assetID
	t.Default = false
	t.SetBy = actor
	t.SetAt = time.Now().UTC()
	t.Gaps = d.gapsIn(&t)

	blk := d.rail.append(BlockRecourseTermsSet, map[string]interface{}{
		"kind":         "recourse-terms-set",
		"assetId":      assetID,
		"setBy":        actor,
		"jurisdiction": t.Jurisdiction,
		"vehicle":      t.Vehicle,
		"ranks":        len(t.Priority),
		"fundedRanks":  countFunded(t.Priority),
		"effect": "Records the order in which claims are paid if this asset fails, and which ranks name a pot " +
			"this ledger can see. A rank naming no pot pays zero.",
	})
	if blk != nil {
		t.Block = blk.Height
	}

	d.mu.Lock()
	stored := t
	d.terms[assetID] = &stored
	d.mu.Unlock()
	cp := t
	return &cp, nil
}

func countFunded(ranks []RecourseRank) int {
	n := 0
	for _, r := range ranks {
		if r.Funding != FundingNone {
			n++
		}
	}
	return n
}

// gapsIn re-derives the gap list from the terms themselves, so terms cannot
// be registered with a flattering gap list attached. The holder's warning is
// computed, not supplied.
func (d *RecourseDesk) gapsIn(t *RecourseTerms) []string {
	var gaps []string
	if countFunded(t.Priority) == 0 {
		gaps = append(gaps, "No rank is funded. The waterfall describes an order of payment for money that does not exist.")
	}
	orphan := 0
	for _, tr := range t.Triggers {
		if strings.EqualFold(strings.TrimSpace(tr.DeclaredBy), "nobody") || strings.TrimSpace(tr.DeclaredBy) == "" {
			orphan++
		}
	}
	if orphan > 0 {
		gaps = append(gaps, fmt.Sprintf("%d of %d triggers have no owner who may declare them, so they can occur without anything happening.",
			orphan, len(t.Triggers)))
	}
	if strings.HasPrefix(strings.TrimSpace(t.Vehicle), "None") {
		gaps = append(gaps, "There is no SPV, so a token holder has no claim on legal title, only a position on this rail.")
	}
	gaps = append(gaps, "Nothing here can compel a payment. The rail records an entitlement; it does not enforce one.")
	return gaps
}

// Simulate walks the waterfall for one holder under one trigger.
func (d *RecourseDesk) Simulate(assetID, trigger, holder string, now time.Time) (*RecourseSimulation, error) {
	if d == nil {
		return nil, ErrRecourseFields
	}
	assetID = strings.TrimSpace(assetID)
	holder = strings.TrimSpace(holder)
	trigger = strings.ToUpper(strings.TrimSpace(trigger))
	if assetID == "" || holder == "" || trigger == "" {
		return nil, ErrRecourseFields
	}

	terms := d.Terms(assetID)
	var tr *RecourseTrigger
	for i := range terms.Triggers {
		if terms.Triggers[i].ID == trigger {
			tr = &terms.Triggers[i]
			break
		}
	}
	if tr == nil {
		return nil, fmt.Errorf("%w: %s. Known triggers are %s, %s, %s and %s",
			ErrRecourseUnknownTrig, trigger,
			TriggerIssuerDefault, TriggerImpairment, TriggerAttestationWithdrawn, TriggerCustodianFailure)
	}

	holders := d.rail.securities.Holders(assetID)
	var outstanding int64
	for _, n := range holders {
		outstanding += n
	}
	mine := holders[holder]
	if mine <= 0 {
		return nil, ErrRecourseNoPosition
	}

	sim := &RecourseSimulation{
		AssetID: assetID, Holder: holder, Trigger: trigger,
		TriggerObservable: tr.Observable, TriggerTest: tr.Test,
		TriggerSource: tr.Source, TriggerDeclaredBy: tr.DeclaredBy,
		HolderTokens: mine, TokensOutstanding: outstanding,
		HolderSharePct:       itoaPct(int(mine), int(outstanding)),
		TermsAreHouseDefault: terms.Default,
		Gaps:                 terms.Gaps,
		Disclaimer:           RecourseDisclaimer,
	}

	// The pool. This is where the honesty lives: a pot is worth what this
	// ledger can see of it, not what the terms assert about it.
	pool, source := d.poolFor(assetID, terms, trigger, now)
	sim.PoolPaise = pool
	sim.PoolSource = source

	remaining := pool
	for _, rk := range terms.Priority {
		funded, avail, why := d.fundingFor(assetID, rk, terms, trigger, now)
		p := RecoursePayout{
			Rank: rk.Rank, Claimant: rk.Claimant, Remedy: rk.Remedy,
			Funding: rk.Funding, Funded: funded, Why: why,
		}
		if !funded {
			p.ClaimPaise = 0
			p.AvailablePais = 0
			sim.Waterfall = append(sim.Waterfall, p)
			continue
		}
		claim := avail
		if rk.CapPaise > 0 && claim > rk.CapPaise {
			claim = rk.CapPaise
		}
		p.ClaimPaise = claim
		p.AvailablePais = remaining
		paid := claim
		if paid > remaining {
			paid = remaining
		}
		p.PaidPaise = paid
		p.ShortfallPais = claim - paid
		remaining -= paid

		// Only the holder's own rank converts into the holder's number, and
		// only their pro-rata share of it.
		if isHolderRank(rk) && outstanding > 0 {
			sim.RecoveryPaise += paid * mine / outstanding
		}
		sim.Waterfall = append(sim.Waterfall, p)
	}

	sim.RecoveryINR = paiseToINRString(sim.RecoveryPaise)
	sim.Verdict = verdictFor(sim, terms)
	return sim, nil
}

// isHolderRank decides which rank the person asking belongs to. Matching on
// the word is crude, and it is marked crude rather than hidden: a real
// structure would carry a claimant class as an enum agreed with counsel.
func isHolderRank(rk RecourseRank) bool {
	l := strings.ToLower(rk.Claimant)
	return strings.Contains(l, "token holder") || strings.Contains(l, "unitholder") || strings.Contains(l, "investor")
}

// poolFor is what could actually be paid out, from pots this ledger can see.
func (d *RecourseDesk) poolFor(assetID string, terms *RecourseTerms, trigger string, now time.Time) (int64, string) {
	var total int64
	var sources []string
	seenBacking := false
	// Two ranks may name the same pot. That does not make it two pots, and
	// counting it twice is precisely the arithmetic that makes an unfunded
	// structure look solvent.
	seenWallet := map[string]bool{}
	for _, rk := range terms.Priority {
		switch rk.Funding {
		case FundingBackingStatement:
			if seenBacking || d.backing == nil {
				continue
			}
			seenBacking = true
			cov := d.backing.Coverage(assetID, now)
			if cov.ValuationPaise > 0 && cov.Status != BackingWithdrawn {
				total += cov.ValuationPaise
				sources = append(sources, "the standing backing statement for "+assetID)
			}
		case FundingReserveWallet:
			if seenWallet[rk.ReserveWallet] {
				continue
			}
			seenWallet[rk.ReserveWallet] = true
			if w, ok := d.rail.Wallet(rk.ReserveWallet); ok && w != nil {
				bal := w.BalancePaise
				if bal > 0 {
					total += bal
					sources = append(sources, "reserve wallet "+rk.ReserveWallet)
				}
			}
		}
	}
	if total == 0 {
		return 0, "Nothing. No rank names a pot this ledger can see, so there is no pool to distribute."
	}
	return total, strings.Join(sources, " and ")
}

// fundingFor resolves one rank against reality.
func (d *RecourseDesk) fundingFor(assetID string, rk RecourseRank, terms *RecourseTerms, trigger string, now time.Time) (bool, int64, string) {
	switch rk.Funding {
	case FundingBackingStatement:
		if d.backing == nil {
			return false, 0, "This rank is paid from a backing statement, but no backing registry is mounted, so it pays zero."
		}
		cov := d.backing.Coverage(assetID, now)
		if cov.Status == BackingWithdrawn {
			return false, 0, "This rank is paid from the backing statement, and that statement has been withdrawn. It pays zero."
		}
		if cov.ValuationPaise <= 0 {
			return false, 0, "This rank is paid from a backing statement, and no statement values this asset. It pays zero."
		}
		if trigger == TriggerImpairment {
			return true, cov.ValuationPaise, "Paid from the standing backing statement, at the valuation in force. An impairment is a fall in that figure, so it is the figure that pays."
		}
		return true, cov.ValuationPaise, "Paid from the standing backing statement, at the valuation in force."
	case FundingReserveWallet:
		w, ok := d.rail.Wallet(rk.ReserveWallet)
		if !ok || w == nil {
			return false, 0, "This rank names reserve wallet " + rk.ReserveWallet + ", which does not exist on this rail. It pays zero."
		}
		if w.BalancePaise <= 0 {
			return false, 0, "Reserve wallet " + rk.ReserveWallet + " exists and is empty. A named empty pot pays the same as no pot."
		}
		return true, w.BalancePaise, "Paid from reserve wallet " + rk.ReserveWallet + ", to the extent of its balance."
	default:
		return false, 0, "No pot is named for this rank. It is described, not funded, and pays zero."
	}
}

// verdictFor is the one line at the top. It is written to be quotable
// against us, because a holder reading this deserves the sentence they would
// have had to work out for themselves.
func verdictFor(sim *RecourseSimulation, terms *RecourseTerms) string {
	switch {
	case sim.RecoveryPaise == 0 && sim.PoolPaise == 0:
		return "You would recover nothing. No rank in these terms names a pot this ledger can see, so the " +
			"waterfall is an order of payment for money that does not exist. That is the position today."
	case sim.RecoveryPaise == 0:
		return "You would recover nothing. There is a pool, but it is exhausted by ranks above yours before " +
			"your rank is reached."
	case !sim.TriggerObservable:
		return "You would recover " + sim.RecoveryINR + ", but only if somebody declares this trigger, and these " +
			"terms name nobody who may. An entitlement nobody can start is not an entitlement."
	default:
		return "You would recover " + sim.RecoveryINR + " from a pool of " + paiseToINRString(sim.PoolPaise) +
			", after the ranks above yours are paid. This is a simulation, not a promise."
	}
}

// Declare records that a supervisor says a trigger has occurred. It moves no
// money, by design: fixing the facts and paying the claim are different acts
// and conflating them is how a platform ends up adjudicating its own failure.
func (d *RecourseDesk) Declare(assetID, trigger, reason, actor string, supervisor bool) (*DrunixBlock, error) {
	if d == nil {
		return nil, ErrRecourseFields
	}
	if !supervisor {
		return nil, ErrRecourseNotYours
	}
	assetID = strings.TrimSpace(assetID)
	trigger = strings.ToUpper(strings.TrimSpace(trigger))
	if assetID == "" || trigger == "" {
		return nil, ErrRecourseFields
	}
	terms := d.Terms(assetID)
	known := false
	for _, t := range terms.Triggers {
		if t.ID == trigger {
			known = true
			break
		}
	}
	if !known {
		return nil, fmt.Errorf("%w: %s", ErrRecourseUnknownTrig, trigger)
	}
	holders := d.rail.securities.Holders(assetID)
	var outstanding int64
	for _, n := range holders {
		outstanding += n
	}
	blk := d.rail.append(BlockRecourseTriggerDeclared, map[string]interface{}{
		"kind":              "recourse-trigger-declared",
		"assetId":           assetID,
		"trigger":           trigger,
		"declaredBy":        actor,
		"reason":            strings.TrimSpace(reason),
		"holderCount":       len(holders),
		"tokensOutstanding": outstanding,
		"declaredAt":        time.Now().UTC().Format(time.RFC3339),
		"effect": "Fixes the facts and the moment. It moves no money: declaring a failure and paying for it " +
			"are different acts, and the rail does only the first.",
	})
	return blk, nil
}

// paiseToINRString formats for a human without pulling in a locale package.
func paiseToINRString(p int64) string {
	neg := p < 0
	if neg {
		p = -p
	}
	rupees := p / 100
	pa := p % 100
	s := groupIndian(rupees)
	out := fmt.Sprintf("Rs %s.%02d", s, pa)
	if neg {
		return "-" + out
	}
	return out
}

// groupIndian applies lakh/crore grouping: 1,50,000 rather than 150,000.
func groupIndian(n int64) string {
	s := fmt.Sprintf("%d", n)
	if len(s) <= 3 {
		return s
	}
	head, tail := s[:len(s)-3], s[len(s)-3:]
	var parts []string
	for len(head) > 2 {
		parts = append([]string{head[len(head)-2:]}, parts...)
		head = head[:len(head)-2]
	}
	if head != "" {
		parts = append([]string{head}, parts...)
	}
	return strings.Join(parts, ",") + "," + tail
}
