package drunix

// Outcome terms: paying for a result instead of for effort.
//
// The work desk (work.go) already escrows a fee and releases it when the
// funder accepts. That is better than an invoice, but it still settles on
// goodwill: the funder decides, alone, whether the work happened. The
// objection to outcome-based contracting has never been the pricing, it is
// verification. Who decides the result was delivered, and what happens when
// the two sides disagree? Where that answer is missing, both sides retreat
// to billing for hours, because hours are uncontested.
//
// This file adds the missing half:
//
//   - acceptance criteria become named checks, each one recorded pass or
//     fail with its evidence, rather than a paragraph to argue about
//   - a named verifier, agreed when the order is opened, records them. It
//     can be a third party, and it is never the worker
//   - when every required check passes the order becomes VERIFIED. The money
//     does not move yet
//   - the funder has a stated dispute window to object. If they do not, the
//     escrow releases on time rather than when somebody remembers
//   - if nothing is delivered by the deadline, the escrow goes back
//
// None of it is automatic in the sense of trusting a machine's opinion: a
// check is recorded by an identity and anchored, so the record says who
// asserted what and when. What is automatic is the consequence.

import (
	"fmt"
	"sort"
	"strings"
	"time"
)

// Extra states and blocks. The original flow is untouched: an order with no
// outcome terms behaves exactly as it did.
const (
	// WorkStatusVerified means every required check passed and the dispute
	// window is running. The fee is still escrowed.
	WorkStatusVerified = "VERIFIED"

	BlockWorkCheckRecorded = "WORK_CHECK_RECORDED"
	BlockWorkVerified      = "WORK_VERIFIED"
	BlockWorkFinalised     = "WORK_FINALISED"
	BlockWorkExpired       = "WORK_EXPIRED"

	CheckPending = "PENDING"
	CheckPassed  = "PASSED"
	CheckFailed  = "FAILED"

	// Defaults chosen to be short enough to demonstrate and long enough to
	// be arguable in real life.
	defaultDisputeWindow = 24 * time.Hour
	maxDisputeWindow     = 30 * 24 * time.Hour
	maxDeliveryWindow    = 365 * 24 * time.Hour
)

// OutcomeCheck is one acceptance criterion that can be settled on rather
// than discussed. "The report is good" is not a check. "The 42 pre-agreed
// tests pass, evidenced by this hash" is.
type OutcomeCheck struct {
	Name        string     `json:"name"`
	Description string     `json:"description,omitempty"`
	Required    bool       `json:"required"`
	Status      string     `json:"status"`
	Evidence    string     `json:"evidence,omitempty"`
	Detail      string     `json:"detail,omitempty"`
	VerifiedBy  string     `json:"verifiedBy,omitempty"`
	VerifiedAt  *time.Time `json:"verifiedAt,omitempty"`
}

// OutcomeTerms are agreed when the order is opened and cannot be edited
// afterwards. Terms a party can change mid-engagement are not terms.
type OutcomeTerms struct {
	Verifier       string         `json:"verifier"`
	Checks         []OutcomeCheck `json:"checks"`
	DeliverBy      *time.Time     `json:"deliverBy,omitempty"`
	DisputeWindow  string         `json:"disputeWindow"`
	VerifiedAt     *time.Time     `json:"verifiedAt,omitempty"`
	ReleaseDueAt   *time.Time     `json:"releaseDueAt,omitempty"`
	FinalisedAt    *time.Time     `json:"finalisedAt,omitempty"`
	ReleaseTrigger string         `json:"releaseTrigger,omitempty"`
}

// CheckRequest records one verification result.
type CheckRequest struct {
	Name     string `json:"name"`
	Passed   bool   `json:"passed"`
	Evidence string `json:"evidence"`
	Detail   string `json:"detail"`
}

// outcomeOf returns the terms attached to an order, or nil.
func (o *WorkOrder) outcomeOf() *OutcomeTerms { return o.Outcome }

// hasOutcomeTerms reports whether this order settles on verification.
func (o *WorkOrder) hasOutcomeTerms() bool {
	return o.Outcome != nil && len(o.Outcome.Checks) > 0
}

// requiredOutstanding counts required checks that have not passed.
func (t *OutcomeTerms) requiredOutstanding() int {
	n := 0
	for _, c := range t.Checks {
		if c.Required && c.Status != CheckPassed {
			n++
		}
	}
	return n
}

func (t *OutcomeTerms) failedRequired() []string {
	var out []string
	for _, c := range t.Checks {
		if c.Required && c.Status == CheckFailed {
			out = append(out, c.Name)
		}
	}
	return out
}

func parseWindow(s string, def, max time.Duration) (time.Duration, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return def, nil
	}
	d, err := time.ParseDuration(s)
	if err != nil {
		return 0, fmt.Errorf("%w: %q is not a duration such as 48h", ErrWorkMissingField, s)
	}
	if d <= 0 {
		return 0, fmt.Errorf("%w: the window must be positive", ErrWorkMissingField)
	}
	if d > max {
		return 0, fmt.Errorf("%w: %s is longer than the ceiling of %s", ErrWorkMissingField, d, max)
	}
	return d, nil
}

// buildOutcomeTerms validates the terms supplied when an order is opened.
func buildOutcomeTerms(req WorkRequest, funder string, now time.Time) (*OutcomeTerms, error) {
	verifier := strings.TrimSpace(req.Verifier)
	if verifier == "" && len(req.Checks) == 0 {
		return nil, nil // an ordinary work order, as before
	}
	if verifier == "" {
		return nil, fmt.Errorf("%w: checks need a verifier who records them", ErrWorkMissingField)
	}
	if len(req.Checks) == 0 {
		return nil, fmt.Errorf("%w: a verifier with nothing to verify is not a term", ErrWorkMissingField)
	}
	seen := map[string]bool{}
	checks := make([]OutcomeCheck, 0, len(req.Checks))
	required := 0
	for _, c := range req.Checks {
		name := strings.TrimSpace(c.Name)
		if name == "" {
			return nil, fmt.Errorf("%w: every check needs a name", ErrWorkMissingField)
		}
		key := strings.ToLower(name)
		if seen[key] {
			return nil, fmt.Errorf("%w: check %q is listed twice", ErrWorkMissingField, name)
		}
		seen[key] = true
		if c.Required {
			required++
		}
		checks = append(checks, OutcomeCheck{
			Name:        name,
			Description: strings.TrimSpace(c.Description),
			Required:    c.Required,
			Status:      CheckPending,
		})
	}
	if required == 0 {
		return nil, fmt.Errorf("%w: at least one check must be required, or nothing gates the money", ErrWorkMissingField)
	}
	window, err := parseWindow(req.DisputeWindow, defaultDisputeWindow, maxDisputeWindow)
	if err != nil {
		return nil, err
	}
	terms := &OutcomeTerms{
		Verifier:      verifier,
		Checks:        checks,
		DisputeWindow: window.String(),
	}
	if strings.TrimSpace(req.DeliverWithin) != "" {
		d, err := parseWindow(req.DeliverWithin, 0, maxDeliveryWindow)
		if err != nil {
			return nil, err
		}
		by := now.Add(d)
		terms.DeliverBy = &by
	}
	return terms, nil
}

// RecordCheck sets one check pass or fail.
//
// Only the verifier named in the terms may do it, or a supervisor. The worker
// never can: a party marking its own homework is the thing this prevents, and
// an agent doing it would be worse.
func (d *WorkDesk) RecordCheck(orderID string, req CheckRequest, actor string, supervisor bool) (*WorkOrder, error) {
	name := strings.TrimSpace(req.Name)
	if name == "" {
		return nil, fmt.Errorf("%w: name the check being recorded", ErrWorkMissingField)
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	o, err := d.mustFind(orderID)
	if err != nil {
		return nil, err
	}
	if !o.hasOutcomeTerms() {
		return nil, fmt.Errorf("%w: this order has no outcome terms to verify", ErrWorkBadState)
	}
	t := o.Outcome
	if !supervisor && !strings.EqualFold(t.Verifier, actor) {
		return nil, fmt.Errorf("%w: only %s may record checks on this order", ErrWorkNotVerifier, t.Verifier)
	}
	if strings.EqualFold(o.Worker, actor) && !supervisor {
		return nil, fmt.Errorf("%w: the worker cannot verify its own delivery", ErrWorkSelfDeal)
	}
	if o.Status != WorkStatusSubmitted {
		return nil, fmt.Errorf("%w: checks are recorded against a submitted deliverable, not a %s order",
			ErrWorkBadState, o.Status)
	}

	idx := -1
	for i := range t.Checks {
		if strings.EqualFold(t.Checks[i].Name, name) {
			idx = i
			break
		}
	}
	if idx < 0 {
		return nil, fmt.Errorf("%w: %q is not one of the agreed checks", ErrWorkMissingField, name)
	}
	if t.Checks[idx].Status != CheckPending {
		return nil, fmt.Errorf("%w: %q was already recorded as %s", ErrWorkBadState, name, t.Checks[idx].Status)
	}

	now := time.Now().UTC()
	t.Checks[idx].Status = CheckPassed
	if !req.Passed {
		t.Checks[idx].Status = CheckFailed
	}
	t.Checks[idx].Evidence = strings.TrimSpace(req.Evidence)
	t.Checks[idx].Detail = strings.TrimSpace(req.Detail)
	t.Checks[idx].VerifiedBy = actor
	t.Checks[idx].VerifiedAt = &now

	o.event(o.Status, actor, fmt.Sprintf("Check %q recorded as %s.", name, t.Checks[idx].Status))
	d.append(BlockWorkCheckRecorded, o, map[string]interface{}{
		"check":      name,
		"result":     t.Checks[idx].Status,
		"required":   t.Checks[idx].Required,
		"evidence":   t.Checks[idx].Evidence,
		"verifier":   actor,
		"outstandng": t.requiredOutstanding(),
	})

	// A failed required check parks the order rather than refunding it. The
	// machine reports the result; it does not get to end the engagement.
	if failed := t.failedRequired(); len(failed) > 0 {
		if canMove(o.Status, WorkStatusDisputed) {
			o.Status = WorkStatusDisputed
			o.Reason = "required check failed: " + strings.Join(failed, ", ")
			o.event(WorkStatusDisputed, actor, "A required check failed. Escrow stays frozen pending the parties.")
			d.append(BlockWorkDisputed, o, map[string]interface{}{"reason": o.Reason, "source": "verification"})
		}
		out := d.snap(o)
		return &out, nil
	}

	if t.requiredOutstanding() == 0 {
		window, _ := time.ParseDuration(t.DisputeWindow)
		due := now.Add(window)
		t.VerifiedAt = &now
		t.ReleaseDueAt = &due
		o.Status = WorkStatusVerified
		o.event(WorkStatusVerified, actor, fmt.Sprintf(
			"Every required check passed. The fee releases after the dispute window closes at %s unless the funder objects.",
			due.Format(time.RFC3339)))
		d.append(BlockWorkVerified, o, map[string]interface{}{
			"verifier":     t.Verifier,
			"checks":       checkSummary(t.Checks),
			"releaseDueAt": due.Format(time.RFC3339),
			"effect":       "The fee is still escrowed. It releases when the dispute window closes, not on this block.",
		})
	}

	out := d.snap(o)
	return &out, nil
}

func checkSummary(checks []OutcomeCheck) []map[string]interface{} {
	out := make([]map[string]interface{}, 0, len(checks))
	for _, c := range checks {
		out = append(out, map[string]interface{}{
			"name": c.Name, "required": c.Required, "result": c.Status, "evidence": c.Evidence,
		})
	}
	return out
}

// Finalise releases a verified order's escrow.
//
// Either the funder waives the rest of the window, or the window has closed
// and anyone may trigger it. The second case is the point: the worker does
// not have to chase payment, and the funder cannot obtain free delay by
// saying nothing.
func (d *WorkDesk) Finalise(orderID, actor string, supervisor bool) (*WorkOrder, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	o, err := d.mustFind(orderID)
	if err != nil {
		return nil, err
	}
	if o.Status != WorkStatusVerified || o.Outcome == nil {
		return nil, fmt.Errorf("%w: only a verified order can be finalised, this one is %s", ErrWorkBadState, o.Status)
	}
	now := time.Now().UTC()
	windowOpen := o.Outcome.ReleaseDueAt != nil && now.Before(*o.Outcome.ReleaseDueAt)
	waived := supervisor || strings.EqualFold(o.Funder, actor)
	if windowOpen && !waived {
		return nil, fmt.Errorf("%w: the dispute window is open until %s; the funder may waive it",
			ErrWorkWindowOpen, o.Outcome.ReleaseDueAt.Format(time.RFC3339))
	}
	trigger := "dispute window closed"
	if windowOpen {
		trigger = "funder waived the remaining window"
	}
	if err := d.releaseLocked(o, actor, trigger, now); err != nil {
		return nil, err
	}
	out := d.snap(o)
	return &out, nil
}

// releaseLocked moves the money and closes the order. Caller holds d.mu.
func (d *WorkDesk) releaseLocked(o *WorkOrder, actor, trigger string, now time.Time) error {
	if err := d.settleEscrow(o.Funder, o.Worker, o.FeePaise); err != nil {
		return err
	}
	o.Escrowed = false
	o.Status = WorkStatusAccepted
	o.SettledAt = &now
	if o.Outcome != nil {
		o.Outcome.FinalisedAt = &now
		o.Outcome.ReleaseTrigger = trigger
	}
	o.event(WorkStatusAccepted, actor, fmt.Sprintf("Released: ₹%.2f to %s (%s).", o.FeeINR, o.Worker, trigger))
	d.append(BlockWorkFinalised, o, map[string]interface{}{
		"paidINR": o.FeeINR,
		"paidTo":  o.Worker,
		"trigger": trigger,
		"checks":  checkSummary(outcomeChecks(o)),
		"atomic":  "the verified result and the fee release commit in one block",
	})
	return nil
}

func outcomeChecks(o *WorkOrder) []OutcomeCheck {
	if o.Outcome == nil {
		return nil
	}
	return o.Outcome.Checks
}

// Tick applies the clock: deadlines that have passed, windows that have
// closed. It is called on demand rather than from a timer, so the rail has
// no background goroutine deciding to move money while nobody is watching.
// Every state change it makes is anchored like any other.
func (d *WorkDesk) Tick(now time.Time) []string {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	var changed []string
	ids := append([]string(nil), d.order...)
	sort.Strings(ids)
	for _, id := range ids {
		o := d.orders[id]
		if o == nil || o.Outcome == nil {
			continue
		}
		t := o.Outcome

		// Nothing delivered by the deadline: the money goes home.
		if t.DeliverBy != nil && now.After(*t.DeliverBy) && o.Escrowed &&
			(o.Status == WorkStatusFunded || o.Status == WorkStatusAssigned) {
			d.unreserve(o.Funder, o.FeePaise)
			o.Escrowed = false
			o.Status = WorkStatusRefunded
			o.Reason = "nothing was delivered by " + t.DeliverBy.Format(time.RFC3339)
			o.event(WorkStatusRefunded, "rail-clock", "Delivery deadline passed. Escrow returned to the funder.")
			d.append(BlockWorkExpired, o, map[string]interface{}{
				"reason":    o.Reason,
				"refunded":  o.FeeINR,
				"refundTo":  o.Funder,
				"deliverBy": t.DeliverBy.Format(time.RFC3339),
			})
			changed = append(changed, o.OrderID)
			continue
		}

		// Verified and nobody objected in time: pay.
		if o.Status == WorkStatusVerified && t.ReleaseDueAt != nil && now.After(*t.ReleaseDueAt) {
			if err := d.releaseLocked(o, "rail-clock", "dispute window closed", now); err == nil {
				changed = append(changed, o.OrderID)
			}
		}
	}
	return changed
}

// OutcomeSummary describes the layer for the API index.
func (d *WorkDesk) OutcomeSummary() map[string]interface{} {
	d.mu.Lock()
	defer d.mu.Unlock()
	withTerms, verified, finalised, expired := 0, 0, 0, 0
	for _, o := range d.orders {
		if o.Outcome == nil {
			continue
		}
		withTerms++
		switch {
		case o.Outcome.FinalisedAt != nil:
			finalised++
		case o.Status == WorkStatusVerified:
			verified++
		case o.Status == WorkStatusRefunded && strings.Contains(o.Reason, "nothing was delivered"):
			expired++
		}
	}
	return map[string]interface{}{
		"ordersWithOutcomeTerms": withTerms,
		"awaitingRelease":        verified,
		"released":               finalised,
		"expiredUndelivered":     expired,
		"model": "Payment is escrowed when the engagement starts, released when every required check has been " +
			"recorded as passed by the agreed verifier, and only after the dispute window closes. A failed " +
			"required check freezes the escrow instead of paying out, and an undelivered order returns it.",
		"defaultDisputeWindow": defaultDisputeWindow.String(),
		"disclaimer": "The verifier is an identity on a simulated rail, not an adjudicator with legal standing. " +
			"What is real here is that the money cannot move except through the agreed path.",
	}
}

// applyOutcomeTxn rebuilds outcome terms from the chain, so a restarted
// process knows which checks passed, when the window closes and whether the
// money has already moved. A budget or a deadline that resets on restart is
// not a term.
func applyOutcomeTxn(o *WorkOrder, blockType string, txn map[string]interface{}) {
	str := func(k string) string { s, _ := txn[k].(string); return s }
	ensure := func() *OutcomeTerms {
		if o.Outcome == nil {
			o.Outcome = &OutcomeTerms{DisputeWindow: defaultDisputeWindow.String()}
		}
		return o.Outcome
	}

	switch blockType {
	case BlockWorkCreated:
		if v := str("verifier"); v != "" {
			t := ensure()
			t.Verifier = v
			if w := str("disputeWindow"); w != "" {
				t.DisputeWindow = w
			}
			if by := str("deliverBy"); by != "" {
				if parsed, err := time.Parse(time.RFC3339, by); err == nil {
					u := parsed.UTC()
					t.DeliverBy = &u
				}
			}
			t.Checks = checksFromTxn(txn["checks"])
		}
	case BlockWorkCheckRecorded:
		if o.Outcome == nil {
			return
		}
		name, result := str("check"), str("result")
		for i := range o.Outcome.Checks {
			if strings.EqualFold(o.Outcome.Checks[i].Name, name) {
				o.Outcome.Checks[i].Status = result
				o.Outcome.Checks[i].Evidence = str("evidence")
				o.Outcome.Checks[i].VerifiedBy = str("verifier")
			}
		}
	case BlockWorkVerified:
		t := ensure()
		if due := str("releaseDueAt"); due != "" {
			if parsed, err := time.Parse(time.RFC3339, due); err == nil {
				u := parsed.UTC()
				t.ReleaseDueAt = &u
			}
		}
	case BlockWorkFinalised:
		t := ensure()
		now := time.Now().UTC()
		t.FinalisedAt = &now
		t.ReleaseTrigger = str("trigger")
		o.Status = WorkStatusAccepted
	case BlockWorkExpired:
		o.Status = WorkStatusRefunded
		o.Reason = str("reason")
	}
}

func checksFromTxn(v interface{}) []OutcomeCheck {
	list, ok := v.([]interface{})
	if !ok {
		return nil
	}
	out := make([]OutcomeCheck, 0, len(list))
	for _, item := range list {
		m, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		name, _ := m["name"].(string)
		if name == "" {
			continue
		}
		required, _ := m["required"].(bool)
		status, _ := m["result"].(string)
		if status == "" {
			status = CheckPending
		}
		evidence, _ := m["evidence"].(string)
		out = append(out, OutcomeCheck{Name: name, Required: required, Status: status, Evidence: evidence})
	}
	return out
}
