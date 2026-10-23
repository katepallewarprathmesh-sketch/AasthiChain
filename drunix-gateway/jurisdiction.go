package drunix

// The law of the land, modelled rather than described.
//
// WHAT WAS WRONG BEFORE
// This repository had the right instincts about Indian law scattered across
// it: a FEMA refusal in crossborder.go, a named missing PA-CB licence in
// corridors.go, finality caveats in the CBDC docs, disclaimers on most
// screens. Every one of those was prose. A reader had to take on trust that
// the rule existed, and a reviewer could not ask the system which rules it
// believed it was under, because nothing held that as data.
//
// WHAT THIS IS
// A rule set per jurisdiction, declared as values, that a transaction is
// actually tested against. Each rule carries the instrument it comes from,
// so a refusal cites its authority instead of asserting one. The evaluation
// returns every rule it ran, passed and failed, because a gate that only
// reports the first failure teaches a user to fix one thing at a time
// without ever seeing the shape of the regime.
//
// DESIGNATION
// A jurisdiction is not merely a list of rules; it has a state. DESIGNATED
// means this deployment claims to have modelled it. OBSERVED means the rules
// are recorded but the deployment does not operate there. SUSPENDED means it
// did and has stopped. An undeclared jurisdiction refuses by default rather
// than falling through to permissive behaviour, because the dangerous
// failure here is a transaction in a place nobody thought about succeeding
// quietly.
//
// WHAT THIS IS NOT
// It is not legal advice, it is not complete, and it is not maintained
// against a gazette. It is a model of a handful of rules that matter to the
// flows this rail actually performs, with each one traceable to a named
// instrument so that a reader can check it. Where a rule has been simplified,
// the rule says so in its own text rather than in a footnote.

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	BlockJurisdictionEvaluated = "UMI_JURISDICTION_EVALUATED"
	BlockJurisdictionRefused   = "UMI_JURISDICTION_REFUSED"
)

// Designation states.
const (
	JurisdictionDesignated = "DESIGNATED" // modelled and operated in
	JurisdictionObserved   = "OBSERVED"   // modelled, not operated in
	JurisdictionSuspended  = "SUSPENDED"  // was operated in, stopped
)

var (
	ErrJurisdictionUnknown = errors.New("ERR_UMI_JURISDICTION_UNKNOWN")
	ErrJurisdictionRefused = errors.New("ERR_UMI_JURISDICTION_REFUSED")
	ErrJurisdictionFields  = errors.New("ERR_UMI_JURISDICTION_FIELDS")
)

// Transaction kinds a rule can apply to.
const (
	TxAcquisition = "ACQUISITION" // buying an interest in immovable property
	TxLease       = "LEASE"       // taking a lease
	TxFunding     = "FUNDING"     // bringing money in to pay for one
	TxTransfer    = "TRANSFER"    // moving an existing interest on
)

// Rule is one testable statement of law.
//
// Instrument is the point of the whole exercise: a refusal that cannot name
// what refuses it is indistinguishable from a bug, and a permission that
// cannot name what permits it is worse.
type Rule struct {
	ID         string   `json:"id"`
	Applies    []string `json:"appliesTo"`  // transaction kinds
	Statement  string   `json:"statement"`  // what the rule requires, in plain words
	Instrument string   `json:"instrument"` // the authority it comes from
	Simplified string   `json:"simplifiedTo,omitempty"`

	// test returns ok, and when not ok the reason a person can act on.
	test func(Transaction) (bool, string)
}

// Transaction is what gets tested. Fields left empty are treated as
// undeclared, and a rule that needs one refuses rather than assuming.
type Transaction struct {
	Kind           string `json:"kind"`
	Jurisdiction   string `json:"jurisdiction"`
	BuyerStatus    string `json:"buyerStatus"`
	Nationality    string `json:"nationality"`
	AssetKind      string `json:"assetKind"` // RESIDENTIAL, COMMERCIAL, AGRICULTURAL, PLANTATION, FARMHOUSE
	AmountPaise    int64  `json:"amountPaise"`
	Consideration  string `json:"consideration"` // INR_BANKING_CHANNEL, CRYPTO, CASH
	LeaseYears     int    `json:"leaseYears,omitempty"`
	RERARegistered *bool  `json:"reraRegistered,omitempty"`
}

// RuleResult is one rule's verdict.
type RuleResult struct {
	ID         string `json:"id"`
	Statement  string `json:"statement"`
	Instrument string `json:"instrument"`
	Passed     bool   `json:"passed"`
	Reason     string `json:"reason,omitempty"`
	Simplified string `json:"simplifiedTo,omitempty"`
}

// Decision is the whole evaluation: every rule that ran, not only the first
// one that failed.
type Decision struct {
	Jurisdiction string       `json:"jurisdiction"`
	Name         string       `json:"jurisdictionName"`
	Designation  string       `json:"designation"`
	Kind         string       `json:"transactionKind"`
	Allowed      bool         `json:"allowed"`
	RulesRun     int          `json:"rulesRun"`
	Failed       int          `json:"failed"`
	Results      []RuleResult `json:"results"`
	Costs        *Costs       `json:"indicativeCosts,omitempty"`
	EvaluatedAt  string       `json:"evaluatedAt"`
	Block        int64        `json:"block,omitempty"`
	Disclaimer   string       `json:"disclaimer"`
}

// Costs are the statutory charges a buyer meets on top of the price. They are
// indicative: slabs, city-level cesses, women-buyer rebates and first-time
// concessions all move these numbers, and none of that is modelled.
type Costs struct {
	StampDutyBps         int    `json:"stampDutyBps"`
	StampDutyPaise       int64  `json:"stampDutyPaise"`
	RegistrationBps      int    `json:"registrationFeeBps"`
	RegistrationPaise    int64  `json:"registrationFeePaise"`
	RegistrationCapPaise int64  `json:"registrationFeeCapPaise,omitempty"`
	TotalPaise           int64  `json:"totalPaise"`
	Note                 string `json:"note"`
}

// Jurisdiction is a place with a declared rule set.
type Jurisdiction struct {
	Code        string `json:"code"`
	Name        string `json:"name"`
	Designation string `json:"designation"`
	Since       string `json:"designatedSince,omitempty"`
	Note        string `json:"note,omitempty"`

	StampDutyBps         int   `json:"stampDutyBps"`
	RegistrationBps      int   `json:"registrationFeeBps"`
	RegistrationCapPaise int64 `json:"registrationFeeCapPaise,omitempty"`

	Rules []Rule `json:"-"`
}

// ---------------------------------------------------------------- rules ---

// The rules common to every Indian jurisdiction. They are built per
// jurisdiction rather than shared by pointer so that a state can override one
// without mutating another's copy.
func indiaCommonRules() []Rule {
	return []Rule{
		{
			ID:         "FEMA-ACQUISITION-ELIGIBILITY",
			Applies:    []string{TxAcquisition, TxTransfer},
			Statement:  "A person resident outside India who is not of Indian origin may not acquire immovable property in India.",
			Instrument: "FEMA (Non-debt Instruments) Rules 2019, rule 24; FEMA 21(R)",
			test: func(t Transaction) (bool, string) {
				switch strings.ToUpper(t.BuyerStatus) {
				case BuyerResident, BuyerNRI, BuyerOCI, BuyerPIO:
					return true, ""
				case BuyerForeign:
					return false, "A foreign national of non-Indian origin resident outside India cannot acquire " +
						"immovable property here. A lease not exceeding five years is the route that is open."
				default:
					return false, "Buyer status is undeclared. Declare RESIDENT, NRI, OCI, PIO or FOREIGN_NATIONAL."
				}
			},
		},
		{
			ID:         "FEMA-RESTRICTED-NATIONALITY",
			Applies:    []string{TxAcquisition, TxTransfer, TxLease},
			Statement:  "Citizens of certain neighbouring countries need prior RBI approval, whatever their residency.",
			Instrument: "FEMA (Non-debt Instruments) Rules 2019, rule 25",
			test: func(t Transaction) (bool, string) {
				n := strings.ToUpper(strings.TrimSpace(t.Nationality))
				for _, bad := range cbxRestrictedNationalities {
					if n == bad {
						return false, "A citizen of " + titleWord(bad) + " needs prior RBI permission. " +
							"This rail will not proceed without evidence of it, which it has no way to verify."
					}
				}
				return true, ""
			},
		},
		{
			ID:         "FEMA-AGRICULTURAL-LAND",
			Applies:    []string{TxAcquisition, TxTransfer},
			Statement:  "An NRI, OCI or PIO may not acquire agricultural land, a plantation or a farmhouse.",
			Instrument: "FEMA (Non-debt Instruments) Rules 2019, rule 24(b)",
			test: func(t Transaction) (bool, string) {
				kind := strings.ToUpper(strings.TrimSpace(t.AssetKind))
				restricted := kind == "AGRICULTURAL" || kind == "PLANTATION" || kind == "FARMHOUSE"
				if !restricted {
					return true, ""
				}
				switch strings.ToUpper(t.BuyerStatus) {
				case BuyerNRI, BuyerOCI, BuyerPIO:
					return false, "Agricultural land, plantations and farmhouses are outside what an NRI, OCI or " +
						"PIO may acquire. Inheritance is a separate route and is not modelled here."
				case BuyerForeign:
					return false, "Not acquirable by this buyer on any asset kind."
				}
				return true, ""
			},
		},
		{
			ID:         "FEMA-CONSIDERATION-CHANNEL",
			Applies:    []string{TxAcquisition, TxFunding},
			Statement:  "Consideration must be paid in rupees through normal banking channels, or from an NRE, NRO or FCNR account.",
			Instrument: "FEMA (Non-debt Instruments) Rules 2019, rule 24(c)",
			test: func(t Transaction) (bool, string) {
				switch strings.ToUpper(strings.TrimSpace(t.Consideration)) {
				case "INR_BANKING_CHANNEL", "NRE", "NRO", "FCNR":
					return true, ""
				case "CRYPTO":
					return false, "Paying the seller in cryptocurrency or digital tokens is not a permitted " +
						"consideration for Indian immovable property. Convert outside India and remit rupees."
				case "CASH":
					return false, "Cash consideration is not a permitted channel here, and cash receipts of " +
						"₹2,00,000 or more attract a penalty equal to the amount received."
				case "":
					return false, "The consideration channel is undeclared."
				default:
					return false, "Unrecognised consideration channel."
				}
			},
		},
		{
			ID:         "IT-269ST-CASH",
			Applies:    []string{TxAcquisition, TxTransfer},
			Statement:  "No person may receive ₹2,00,000 or more in cash in respect of a single transaction.",
			Instrument: "Income-tax Act 1961, section 269ST",
			test: func(t Transaction) (bool, string) {
				if strings.EqualFold(t.Consideration, "CASH") && t.AmountPaise >= 20000000 {
					return false, "Section 269ST penalises the recipient by the full amount received."
				}
				return true, ""
			},
		},
		{
			ID:         "IT-194IA-TDS",
			Applies:    []string{TxAcquisition, TxTransfer},
			Statement:  "Consideration of ₹50,00,000 or more requires 1% tax deducted at source by the buyer.",
			Instrument: "Income-tax Act 1961, section 194-IA",
			Simplified: "Modelled as a notice, not a deduction: nothing is withheld by this rail.",
			test: func(t Transaction) (bool, string) {
				// A threshold notice, never a refusal: failing to withhold is
				// the buyer's default, not a reason to stop the trade.
				return true, ""
			},
		},
		{
			ID:         "LEASE-FIVE-YEAR-LIMIT",
			Applies:    []string{TxLease},
			Statement:  "A person not otherwise eligible to acquire may take a lease not exceeding five years.",
			Instrument: "FEMA (Non-debt Instruments) Rules 2019, rule 24",
			test: func(t Transaction) (bool, string) {
				if t.LeaseYears > 5 {
					return false, fmt.Sprintf("A lease of %d years exceeds the five-year limit that makes this "+
						"route available without acquisition eligibility.", t.LeaseYears)
				}
				return true, ""
			},
		},
		{
			ID:         "RERA-REGISTRATION",
			Applies:    []string{TxAcquisition},
			Statement:  "A project above the prescribed size must be registered with the state RERA authority before it is marketed.",
			Instrument: "Real Estate (Regulation and Development) Act 2016, section 3",
			Simplified: "Modelled as a declared flag. This rail does not query any state RERA register.",
			test: func(t Transaction) (bool, string) {
				if t.RERARegistered != nil && !*t.RERARegistered {
					return false, "The project is declared as not RERA registered, so it may not be marketed or sold."
				}
				return true, ""
			},
		},
	}
}

// ------------------------------------------------------------- registry ---

// JurisdictionRegistry holds the declared jurisdictions and evaluates
// transactions against them.
type JurisdictionRegistry struct {
	mu    sync.RWMutex
	byID  map[string]*Jurisdiction
	order []string
	chain *DrunixChain
}

// NewJurisdictionRegistry declares the jurisdictions this deployment models.
//
// Four Indian states are DESIGNATED because the demo catalogue has property
// in them and their stamp duty differs enough to be worth showing. The rest
// of India is OBSERVED: the central rules apply, the state charges are not
// modelled. A code that is not here refuses.
func NewJurisdictionRegistry(chain *DrunixChain) *JurisdictionRegistry {
	r := &JurisdictionRegistry{byID: map[string]*Jurisdiction{}, chain: chain}
	add := func(j *Jurisdiction) {
		j.Rules = indiaCommonRules()
		j.Code = strings.ToUpper(j.Code)
		r.byID[j.Code] = j
		r.order = append(r.order, j.Code)
	}
	add(&Jurisdiction{
		Code: "IN-MH", Name: "Maharashtra", Designation: JurisdictionDesignated, Since: "2026-10-23",
		StampDutyBps: 600, RegistrationBps: 100, RegistrationCapPaise: 3000000,
		Note: "6% includes the 1% metro cess applicable in Mumbai, Pune, Nagpur and Nashik. Registration is capped at ₹30,000.",
	})
	add(&Jurisdiction{
		Code: "IN-KA", Name: "Karnataka", Designation: JurisdictionDesignated, Since: "2026-10-23",
		StampDutyBps: 500, RegistrationBps: 100,
		Note: "5% applies above ₹45,00,000. Lower slabs exist below that and are not modelled.",
	})
	add(&Jurisdiction{
		Code: "IN-TG", Name: "Telangana", Designation: JurisdictionDesignated, Since: "2026-10-23",
		StampDutyBps: 500, RegistrationBps: 50,
		Note: "Transfer duty of 1.5% is charged separately in municipal areas and is not modelled.",
	})
	add(&Jurisdiction{
		Code: "IN-WB", Name: "West Bengal", Designation: JurisdictionDesignated, Since: "2026-10-23",
		StampDutyBps: 600, RegistrationBps: 100,
		Note: "Urban rate. Rural property attracts a lower rate that is not modelled.",
	})
	add(&Jurisdiction{
		Code: "IN", Name: "India, state charges not modelled", Designation: JurisdictionObserved,
		StampDutyBps: 0, RegistrationBps: 0,
		Note: "The central rules apply in full. Stamp duty and registration are state subjects and are not " +
			"modelled for this code, so the indicative costs are zero rather than wrong.",
	})
	return r
}

// Jurisdictions lists what is declared, designated first.
func (r *JurisdictionRegistry) Jurisdictions() []Jurisdiction {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]Jurisdiction, 0, len(r.order))
	for _, id := range r.order {
		out = append(out, *r.byID[id])
	}
	sort.SliceStable(out, func(i, j int) bool {
		rank := func(d string) int {
			switch d {
			case JurisdictionDesignated:
				return 0
			case JurisdictionSuspended:
				return 1
			default:
				return 2
			}
		}
		if rank(out[i].Designation) != rank(out[j].Designation) {
			return rank(out[i].Designation) < rank(out[j].Designation)
		}
		return out[i].Code < out[j].Code
	})
	return out
}

// Jurisdiction returns one by code.
func (r *JurisdictionRegistry) Jurisdiction(code string) (*Jurisdiction, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	j, ok := r.byID[strings.ToUpper(strings.TrimSpace(code))]
	if !ok {
		return nil, false
	}
	out := *j
	return &out, true
}

// RulesOf returns the declared rules for a jurisdiction, for display.
func (r *JurisdictionRegistry) RulesOf(code string) ([]RuleResult, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	j, ok := r.byID[strings.ToUpper(strings.TrimSpace(code))]
	if !ok {
		return nil, false
	}
	out := make([]RuleResult, 0, len(j.Rules))
	for _, rule := range j.Rules {
		out = append(out, RuleResult{
			ID: rule.ID, Statement: rule.Statement, Instrument: rule.Instrument,
			Simplified: rule.Simplified, Passed: true,
		})
	}
	return out, true
}

// Evaluate tests a transaction against a jurisdiction's declared rules.
//
// Every applicable rule runs. Returning on the first failure would hide the
// shape of the regime from someone trying to understand why they cannot
// proceed, and would make the result depend on rule order.
func (r *JurisdictionRegistry) Evaluate(t Transaction, now time.Time) (*Decision, error) {
	kind := strings.ToUpper(strings.TrimSpace(t.Kind))
	if kind == "" {
		kind = TxAcquisition
	}
	code := strings.ToUpper(strings.TrimSpace(t.Jurisdiction))
	if code == "" {
		return nil, fmt.Errorf("%w: declare a jurisdiction", ErrJurisdictionFields)
	}

	r.mu.RLock()
	j, ok := r.byID[code]
	r.mu.RUnlock()
	if !ok {
		// Refuse by default. A transaction in a place nobody modelled must
		// not succeed merely because no rule was written to stop it.
		if r.chain != nil {
			r.chain.Append(BlockJurisdictionRefused, []map[string]interface{}{{
				"kind":         "umi-jurisdiction-unknown",
				"jurisdiction": code,
				"transaction":  kind,
				"reason":       "no rule set is declared for this jurisdiction",
			}})
		}
		return nil, fmt.Errorf("%w: no rule set is declared for %q, and an undeclared jurisdiction refuses "+
			"rather than defaulting to permitted", ErrJurisdictionUnknown, code)
	}

	results := make([]RuleResult, 0, len(j.Rules))
	failed := 0
	for _, rule := range j.Rules {
		applies := false
		for _, k := range rule.Applies {
			if k == kind {
				applies = true
				break
			}
		}
		if !applies {
			continue
		}
		ok, reason := rule.test(t)
		if !ok {
			failed++
		}
		results = append(results, RuleResult{
			ID: rule.ID, Statement: rule.Statement, Instrument: rule.Instrument,
			Simplified: rule.Simplified, Passed: ok, Reason: reason,
		})
	}

	d := &Decision{
		Jurisdiction: j.Code,
		Name:         j.Name,
		Designation:  j.Designation,
		Kind:         kind,
		Allowed:      failed == 0,
		RulesRun:     len(results),
		Failed:       failed,
		Results:      results,
		EvaluatedAt:  now.UTC().Format(time.RFC3339),
		Disclaimer: "A model of selected rules, not legal advice and not a complete statement of the law. " +
			"Each rule names the instrument it comes from so that it can be checked.",
	}
	if t.AmountPaise > 0 && (kind == TxAcquisition || kind == TxTransfer) {
		d.Costs = costsFor(j, t.AmountPaise)
	}

	if r.chain != nil {
		blockType := BlockJurisdictionEvaluated
		if !d.Allowed {
			blockType = BlockJurisdictionRefused
		}
		reasons := make([]string, 0, failed)
		for _, res := range results {
			if !res.Passed {
				reasons = append(reasons, res.ID)
			}
		}
		b := r.chain.Append(blockType, []map[string]interface{}{{
			"kind":         "umi-jurisdiction-evaluation",
			"jurisdiction": j.Code,
			"designation":  j.Designation,
			"transaction":  kind,
			"allowed":      d.Allowed,
			"rulesRun":     len(results),
			"failedRules":  reasons,
		}})
		if b != nil {
			d.Block = b.Height
		}
	}
	return d, nil
}

// costsFor computes the indicative statutory charges.
func costsFor(j *Jurisdiction, amountPaise int64) *Costs {
	stamp := amountPaise * int64(j.StampDutyBps) / 10000
	reg := amountPaise * int64(j.RegistrationBps) / 10000
	if j.RegistrationCapPaise > 0 && reg > j.RegistrationCapPaise {
		reg = j.RegistrationCapPaise
	}
	note := j.Note
	if j.StampDutyBps == 0 && j.RegistrationBps == 0 {
		note = "Stamp duty and registration are state subjects and are not modelled for this code."
	}
	return &Costs{
		StampDutyBps: j.StampDutyBps, StampDutyPaise: stamp,
		RegistrationBps: j.RegistrationBps, RegistrationPaise: reg,
		RegistrationCapPaise: j.RegistrationCapPaise,
		TotalPaise:           stamp + reg,
		Note:                 note,
	}
}
