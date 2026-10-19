package drunix

// Proof of backing: tokens outstanding against what somebody has attested is
// actually there.
//
// The authorised supply this rail already enforces is self-declared. The
// issuer says "15,000 tokens" and the rail holds them to it. That catches an
// accident, not a lie, and the issuance-to-collateral mismatch is the failure
// the tokenised-asset field keeps reporting: a book that grows past the thing
// it is supposed to represent, discovered late.
//
// What is added here is the second number. A named attestor states how many
// units exist, what they are worth, by what method it was checked, as of when,
// and how often that statement will be refreshed. From then on:
//
//   - issuance is gated on the attested figure, not only on the declared cap;
//   - an attestation that is not refreshed on its own cadence goes STALE, and
//     a stale statement cannot authorise new issuance;
//   - a withdrawn statement cannot either;
//   - the coverage ratio is readable by anyone, including when it is bad.
//
// Three deliberate limits, because the point of this file is to stop a claim
// being made that is not true:
//
//   - An asset nobody has attested behaves exactly as it did before. The gate
//     binds where there is something to bind to; it does not invent backing.
//   - Nothing here verifies the real world. It records who said what, when,
//     and refuses to let the book outgrow that statement. A false attestation
//     produces a well-documented false number.
//   - Blocking is not reversing. Issuance already recorded stays recorded, and
//     over-issuance is reported rather than quietly corrected.

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Block types. A refusal is committed as well as a success: a gate nobody can
// see the operation of is indistinguishable from no gate.
const (
	BlockBackingAttested  = "UMI_BACKING_ATTESTED"
	BlockBackingWithdrawn = "UMI_BACKING_WITHDRAWN"
	BlockIssueBlocked     = "UMI_ISSUE_BLOCKED"
)

// Coverage states, in the order of how worried a holder should be.
const (
	BackingUnattested = "UNATTESTED"
	BackingBacked     = "BACKED"
	BackingStale      = "STALE"
	BackingWithdrawn  = "WITHDRAWN"
	BackingOverIssued = "OVER_ISSUED"
)

var (
	ErrBackingFields    = errors.New("ERR_UMI_BACKING_FIELDS")
	ErrBackingNotFound  = errors.New("ERR_UMI_BACKING_NOT_FOUND")
	ErrBackingNotYours  = errors.New("ERR_UMI_BACKING_NOT_ATTESTOR")
	ErrBackingShort     = errors.New("ERR_UMI_BACKING_SHORT")
	ErrBackingStale     = errors.New("ERR_UMI_BACKING_STALE")
	ErrBackingWithdrawn = errors.New("ERR_UMI_BACKING_WITHDRAWN")
)

const (
	defaultBackingCadence = 90 * 24 * time.Hour  // a quarter: the defensible minimum
	maxBackingCadence     = 365 * 24 * time.Hour // beyond a year it is not a cadence
	minBackingCadence     = time.Hour
)

var hex64 = regexp.MustCompile(`^[0-9a-f]{64}$`)

// BackingStatement is one attestor's statement about what sits under an asset.
// It is replaced, never edited: each refresh is a new statement with its own
// as-of date, and the previous one stays on the chain.
type BackingStatement struct {
	AssetID        string `json:"assetId"`
	Attestor       string `json:"attestor"`
	BackedUnits    int64  `json:"backedUnits"`
	ValuationPaise int64  `json:"valuationPaise"`
	Method         string `json:"method"`
	EvidenceHash   string `json:"evidenceHash"`
	CredentialID   string `json:"credentialId,omitempty"`

	AsOf      time.Time `json:"asOf"`
	Cadence   string    `json:"cadence"`
	NextDueAt time.Time `json:"nextDueAt"`
	Block     int64     `json:"block"`

	Withdrawn       bool      `json:"withdrawn"`
	WithdrawnAt     time.Time `json:"withdrawnAt,omitempty"`
	WithdrawnBy     string    `json:"withdrawnBy,omitempty"`
	WithdrawnReason string    `json:"withdrawnReason,omitempty"`
}

// BackingRequest is what an attestor submits.
type BackingRequest struct {
	AssetID        string  `json:"assetId"`
	BackedUnits    int64   `json:"backedUnits"`
	ValuationINR   float64 `json:"valuationINR"`
	ValuationPaise int64   `json:"valuationPaise"`
	Method         string  `json:"method"`
	EvidenceHash   string  `json:"evidenceHash"`
	CredentialID   string  `json:"credentialId"`
	AsOf           string  `json:"asOf"`
	Cadence        string  `json:"cadence"`
}

// BackingRegistry holds the current statement per asset and answers coverage
// questions. It derives every ratio at read time from the live position book,
// so a number here cannot drift away from the ledger it describes.
type BackingRegistry struct {
	mu    sync.Mutex
	rail  *UMIRail
	chain *DrunixChain
	book  map[string]*BackingStatement // assetID -> current statement
}

// NewBackingRegistry wires the layer. A nil rail or chain disables it, like
// the rest of the optional surface.
func NewBackingRegistry(rail *UMIRail, chain *DrunixChain) *BackingRegistry {
	if rail == nil || chain == nil {
		return nil
	}
	return &BackingRegistry{rail: rail, chain: chain, book: make(map[string]*BackingStatement)}
}

func parseCadence(s string) (time.Duration, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return defaultBackingCadence, nil
	}
	d, err := time.ParseDuration(s)
	if err != nil {
		return 0, fmt.Errorf("%w: cadence %q is not a duration like 720h", ErrBackingFields, s)
	}
	if d < minBackingCadence || d > maxBackingCadence {
		return 0, fmt.Errorf("%w: cadence must be between %s and %s", ErrBackingFields, minBackingCadence, maxBackingCadence)
	}
	return d, nil
}

// Attest records a statement of backing. Only a registrar or a supervisor may
// make one: the whole value of the figure is that the party stating it is not
// the party whose book benefits from it.
func (b *BackingRegistry) Attest(req BackingRequest, actor string, supervisor bool) (*BackingStatement, error) {
	if b == nil {
		return nil, ErrBackingNotFound
	}
	assetID := strings.TrimSpace(req.AssetID)
	actor = strings.TrimSpace(actor)
	if assetID == "" || actor == "" {
		return nil, fmt.Errorf("%w: assetId and an identified attestor are both required", ErrBackingFields)
	}
	if req.BackedUnits <= 0 {
		return nil, fmt.Errorf("%w: backedUnits must be a positive count of real units", ErrBackingFields)
	}
	evidence := strings.ToLower(strings.TrimSpace(req.EvidenceHash))
	if !hex64.MatchString(evidence) {
		return nil, fmt.Errorf("%w: evidenceHash must be the SHA-256 of the document checked (64 hex characters), "+
			"so the statement can be tied to what was inspected", ErrBackingFields)
	}
	method := strings.TrimSpace(req.Method)
	if method == "" {
		return nil, fmt.Errorf("%w: say how this was checked, for example \"registry extract\" or \"site inspection\"", ErrBackingFields)
	}

	valuation := req.ValuationPaise
	if valuation == 0 && req.ValuationINR > 0 {
		valuation = INRToPaise(req.ValuationINR)
	}
	if valuation < 0 {
		return nil, fmt.Errorf("%w: valuation cannot be negative", ErrBackingFields)
	}

	now := time.Now().UTC()
	asOf := now
	if s := strings.TrimSpace(req.AsOf); s != "" {
		parsed, err := time.Parse(time.RFC3339, s)
		if err != nil {
			return nil, fmt.Errorf("%w: asOf must be an RFC3339 timestamp", ErrBackingFields)
		}
		asOf = parsed.UTC()
		if asOf.After(now.Add(time.Minute)) {
			return nil, fmt.Errorf("%w: a statement cannot be as of the future", ErrBackingFields)
		}
	}
	cadence, err := parseCadence(req.Cadence)
	if err != nil {
		return nil, err
	}

	st := &BackingStatement{
		AssetID:        assetID,
		Attestor:       actor,
		BackedUnits:    req.BackedUnits,
		ValuationPaise: valuation,
		Method:         method,
		EvidenceHash:   evidence,
		CredentialID:   strings.TrimSpace(req.CredentialID),
		AsOf:           asOf,
		Cadence:        cadence.String(),
		NextDueAt:      asOf.Add(cadence),
	}

	// Committed before it is believed, so the statement and the moment it
	// entered the book are the same fact.
	blk := b.rail.append(BlockBackingAttested, map[string]interface{}{
		"kind":           "backing-attested",
		"assetId":        assetID,
		"attestor":       actor,
		"backedUnits":    req.BackedUnits,
		"valuationPaise": valuation,
		"method":         method,
		"evidenceHash":   evidence,
		"credentialId":   st.CredentialID,
		"asOf":           asOf.Format(time.RFC3339),
		"cadence":        st.Cadence,
		"nextDueAt":      st.NextDueAt.Format(time.RFC3339),
		"supervisor":     supervisor,
		"effect": "States what exists under the asset. Issuance beyond this figure, or after this statement " +
			"goes stale, is refused by the rail.",
	})
	if blk != nil {
		st.Block = blk.Height
	}

	b.mu.Lock()
	b.book[assetID] = st
	b.mu.Unlock()
	return st, nil
}

// Withdraw marks the current statement as no longer stood behind. Like an
// attestation withdrawal, it is a notice: no token is burned and no trade is
// reversed, but nothing further may be issued against it.
func (b *BackingRegistry) Withdraw(assetID, reason, actor string, supervisor bool) (*BackingStatement, error) {
	if b == nil {
		return nil, ErrBackingNotFound
	}
	b.mu.Lock()
	st, ok := b.book[strings.TrimSpace(assetID)]
	if !ok {
		b.mu.Unlock()
		return nil, ErrBackingNotFound
	}
	if !supervisor && !strings.EqualFold(st.Attestor, actor) {
		b.mu.Unlock()
		return nil, fmt.Errorf("%w: %s made this statement, so only they or a supervisor may withdraw it",
			ErrBackingNotYours, st.Attestor)
	}
	now := time.Now().UTC()
	st.Withdrawn = true
	st.WithdrawnAt = now
	st.WithdrawnBy = actor
	st.WithdrawnReason = strings.TrimSpace(reason)
	outstanding := b.outstanding(st.AssetID)
	copyOut := *st
	b.mu.Unlock()

	b.rail.append(BlockBackingWithdrawn, map[string]interface{}{
		"kind":                "backing-withdrawn",
		"assetId":             st.AssetID,
		"withdrawnBy":         actor,
		"reason":              st.WithdrawnReason,
		"tokensOutstanding":   outstanding,
		"backedUnitsAsStated": st.BackedUnits,
		"effect": "Notice only. No token is burned and no settled trade is reversed. New issuance against " +
			"this asset is refused until a fresh statement is made.",
	})
	return &copyOut, nil
}

// outstanding totals the position book for an asset. Caller may hold b.mu;
// the rail takes its own lock.
func (b *BackingRegistry) outstanding(assetID string) int64 {
	_, outstanding := b.rail.AuthorisedSupply(assetID)
	return outstanding
}

// BackingCoverage is the public answer: how much is out, how much is attested,
// and whether the statement still counts.
type BackingCoverage struct {
	AssetID           string  `json:"assetId"`
	Status            string  `json:"status"`
	TokensOutstanding int64   `json:"tokensOutstanding"`
	BackedUnits       int64   `json:"backedUnits"`
	CoveragePercent   float64 `json:"coveragePercent"`
	Headroom          int64   `json:"headroom"`

	Attestor       string `json:"attestor,omitempty"`
	Method         string `json:"method,omitempty"`
	EvidenceHash   string `json:"evidenceHash,omitempty"`
	ValuationPaise int64  `json:"valuationPaise,omitempty"`
	AsOf           string `json:"asOf,omitempty"`
	NextDueAt      string `json:"nextDueAt,omitempty"`
	Cadence        string `json:"cadence,omitempty"`
	AgeHours       int64  `json:"statementAgeHours,omitempty"`
	Block          int64  `json:"block,omitempty"`

	WithdrawnBy     string `json:"withdrawnBy,omitempty"`
	WithdrawnReason string `json:"withdrawnReason,omitempty"`

	MayIssue bool   `json:"mayIssue"`
	Reading  string `json:"reading"`
}

// Coverage reports one asset. now is passed in so the staleness boundary is
// testable rather than wall-clock-only.
func (b *BackingRegistry) Coverage(assetID string, now time.Time) BackingCoverage {
	assetID = strings.TrimSpace(assetID)
	out := BackingCoverage{AssetID: assetID, Status: BackingUnattested}
	if b == nil {
		return out
	}
	out.TokensOutstanding = b.outstanding(assetID)

	b.mu.Lock()
	st, ok := b.book[assetID]
	var copyStatement BackingStatement
	if ok {
		copyStatement = *st
	}
	b.mu.Unlock()

	if !ok {
		out.Reading = "Nobody has stated what is under this asset. The supply cap is the issuer's own figure, " +
			"and the rail is not pretending otherwise."
		out.MayIssue = true
		return out
	}

	st = &copyStatement
	out.BackedUnits = st.BackedUnits
	out.Attestor = st.Attestor
	out.Method = st.Method
	out.EvidenceHash = st.EvidenceHash
	out.ValuationPaise = st.ValuationPaise
	out.AsOf = st.AsOf.Format(time.RFC3339)
	out.NextDueAt = st.NextDueAt.Format(time.RFC3339)
	out.Cadence = st.Cadence
	out.Block = st.Block
	out.AgeHours = int64(now.Sub(st.AsOf).Hours())
	out.Headroom = st.BackedUnits - out.TokensOutstanding
	if st.BackedUnits > 0 {
		out.CoveragePercent = float64(out.TokensOutstanding) / float64(st.BackedUnits) * 100
	}

	switch {
	case out.TokensOutstanding > st.BackedUnits:
		// Reported first whatever else is true: more tokens than units is the
		// condition everything else exists to prevent.
		out.Status = BackingOverIssued
		out.MayIssue = false
		out.Reading = fmt.Sprintf("%d tokens are outstanding against %d attested units. The book is larger than "+
			"the thing it represents. Nothing is reversed automatically; this is the number to act on.",
			out.TokensOutstanding, st.BackedUnits)
	case st.Withdrawn:
		out.Status = BackingWithdrawn
		out.WithdrawnBy = st.WithdrawnBy
		out.WithdrawnReason = st.WithdrawnReason
		out.MayIssue = false
		out.Reading = "The attestor no longer stands behind this statement. Existing tokens are untouched; " +
			"nothing further may be issued until somebody makes a fresh statement."
	case now.After(st.NextDueAt):
		out.Status = BackingStale
		out.MayIssue = false
		out.Reading = fmt.Sprintf("The statement was due for refresh on %s and has not been refreshed. It is "+
			"evidence about the past, so it cannot authorise new issuance today.",
			st.NextDueAt.Format(time.RFC3339))
	default:
		out.Status = BackingBacked
		out.MayIssue = true
		out.Reading = fmt.Sprintf("%d of %d attested units are issued as tokens, leaving %d. %s checked this on %s "+
			"by %s, and the statement is due for refresh by %s.",
			out.TokensOutstanding, st.BackedUnits, out.Headroom, st.Attestor,
			st.AsOf.Format("2 Jan 2006"), st.Method, st.NextDueAt.Format("2 Jan 2006"))
	}
	return out
}

// GateIssue is the hook the issuance path calls. It refuses, and records the
// refusal, when a statement exists and the issuance would outrun it. An asset
// with no statement passes through unchanged.
func (b *BackingRegistry) GateIssue(assetID string, tokens int64, actor string, now time.Time) error {
	if b == nil || tokens <= 0 {
		return nil
	}
	cov := b.Coverage(assetID, now)
	if cov.Status == BackingUnattested {
		return nil
	}

	var reason string
	var sentinel error
	switch cov.Status {
	case BackingWithdrawn:
		sentinel, reason = ErrBackingWithdrawn, "the attestor has withdrawn the statement of backing"
	case BackingStale:
		sentinel, reason = ErrBackingStale, "the statement of backing is past its refresh date"
	case BackingOverIssued:
		sentinel, reason = ErrBackingShort, "the book already exceeds the attested backing"
	default:
		if cov.TokensOutstanding+tokens > cov.BackedUnits {
			sentinel = ErrBackingShort
			reason = fmt.Sprintf("issuing %d more would put %d tokens against %d attested units",
				tokens, cov.TokensOutstanding+tokens, cov.BackedUnits)
		}
	}
	if sentinel == nil {
		return nil
	}

	b.rail.append(BlockIssueBlocked, map[string]interface{}{
		"kind":              "issue-blocked",
		"assetId":           assetID,
		"requestedTokens":   tokens,
		"requestedBy":       actor,
		"tokensOutstanding": cov.TokensOutstanding,
		"backedUnits":       cov.BackedUnits,
		"status":            cov.Status,
		"reason":            reason,
		"effect":            "No tokens were issued. The refusal is recorded so the gate can be audited.",
	})
	return fmt.Errorf("%w: %s (%s)", sentinel, reason, assetID)
}

// Solvency is the whole-rail view: every attested asset, worst first.
func (b *BackingRegistry) Solvency(now time.Time) map[string]interface{} {
	if b == nil {
		return map[string]interface{}{"assets": []BackingCoverage{}}
	}
	b.mu.Lock()
	ids := make([]string, 0, len(b.book))
	for id := range b.book {
		ids = append(ids, id)
	}
	b.mu.Unlock()

	rank := map[string]int{BackingOverIssued: 0, BackingWithdrawn: 1, BackingStale: 2, BackingBacked: 3, BackingUnattested: 4}
	rows := make([]BackingCoverage, 0, len(ids))
	counts := map[string]int{}
	for _, id := range ids {
		c := b.Coverage(id, now)
		counts[c.Status]++
		rows = append(rows, c)
	}
	for i := 1; i < len(rows); i++ {
		for j := i; j > 0 && rank[rows[j].Status] < rank[rows[j-1].Status]; j-- {
			rows[j], rows[j-1] = rows[j-1], rows[j]
		}
	}

	return map[string]interface{}{
		"assets":     rows,
		"attested":   len(rows),
		"byStatus":   counts,
		"checkedAt":  now.Format(time.RFC3339),
		"model":      "Tokens outstanding against units a named party has attested exist, refreshed on a stated cadence.",
		"onFailure":  "A short, stale or withdrawn statement blocks further issuance. It does not burn tokens or reverse trades.",
		"disclaimer": BackingDisclaimer,
	}
}

// BackingDisclaimer is the sentence that keeps this honest. The rail verifies
// arithmetic, not reality.
const BackingDisclaimer = "This rail checks that the book does not outgrow the attested figure. It cannot check " +
	"that the attestation is true. A false statement here produces a precise, well-evidenced, false number, which " +
	"is why the attestor's own record is published beside it."

// RestoreBackingFromChain rebuilds the statements after a restart. A gate that
// forgets its bound on reboot is not a bound.
func (b *BackingRegistry) RestoreBackingFromChain() int {
	if b == nil || b.chain == nil {
		return 0
	}
	n := 0
	for _, blk := range b.chain.Blocks {
		for _, txn := range blk.Txns {
			switch blk.Type {
			case BlockBackingAttested:
				st := statementFromTxn(txn)
				if st == nil {
					continue
				}
				st.Block = blk.Height
				b.mu.Lock()
				b.book[st.AssetID] = st
				b.mu.Unlock()
				n++
			case BlockBackingWithdrawn:
				assetID, _ := txn["assetId"].(string)
				b.mu.Lock()
				if st, ok := b.book[strings.TrimSpace(assetID)]; ok {
					st.Withdrawn = true
					st.WithdrawnBy, _ = txn["withdrawnBy"].(string)
					st.WithdrawnReason, _ = txn["reason"].(string)
				}
				b.mu.Unlock()
			}
		}
	}
	return n
}

func statementFromTxn(txn map[string]interface{}) *BackingStatement {
	str := func(k string) string { s, _ := txn[k].(string); return s }
	num := func(k string) int64 {
		switch v := txn[k].(type) {
		case float64:
			return int64(v)
		case int64:
			return v
		case int:
			return int64(v)
		}
		return 0
	}
	assetID := strings.TrimSpace(str("assetId"))
	if assetID == "" {
		return nil
	}
	st := &BackingStatement{
		AssetID:        assetID,
		Attestor:       str("attestor"),
		BackedUnits:    num("backedUnits"),
		ValuationPaise: num("valuationPaise"),
		Method:         str("method"),
		EvidenceHash:   str("evidenceHash"),
		CredentialID:   str("credentialId"),
		Cadence:        str("cadence"),
	}
	if t, err := time.Parse(time.RFC3339, str("asOf")); err == nil {
		st.AsOf = t.UTC()
	}
	if t, err := time.Parse(time.RFC3339, str("nextDueAt")); err == nil {
		st.NextDueAt = t.UTC()
	} else if d, err := time.ParseDuration(st.Cadence); err == nil {
		st.NextDueAt = st.AsOf.Add(d)
	}
	return st
}

// IssuanceGate is the narrow interface the rail knows about, so umi.go does
// not depend on the backing layer and the layer stays removable.
type IssuanceGate interface {
	GateIssue(assetID string, tokens int64, actor string, now time.Time) error
}

// SetIssuanceGate installs the gate. Nil leaves issuance bounded only by the
// declared supply cap, which is the behaviour every existing test expects.
func (r *UMIRail) SetIssuanceGate(g IssuanceGate) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.gate = g
}

func (r *UMIRail) issuanceGate() IssuanceGate {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.gate
}
