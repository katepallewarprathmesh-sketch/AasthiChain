package drunix

// A proposing agent: it reads the rail, drafts an action, and stops.
//
// The useful half of an agent in a settlement system is noticing. The
// dangerous half is acting. This layer keeps the first and refuses the
// second: it scans live state, drafts a specific action with the evidence
// that prompted it, and leaves it in a queue for a named human to approve or
// reject. Nothing it drafts executes on a timer, on a schedule, or because
// the queue got long.
//
// WHY IT IS BUILT THIS WAY
//
// Three constraints, each of which rules out the obvious design:
//
//   - **The model does not choose the action.** Detection is ordinary code
//     reading ordinary state, and each detector can only produce one kind of
//     proposal with arguments drawn from the record that triggered it. A
//     model that picks its own action can be argued into picking one, and
//     this sits in front of money. The language model's role, where one is
//     configured at all, is to explain a proposal that already exists.
//   - **Approval re-checks the world.** A proposal carries the facts it was
//     drafted from. At the moment somebody approves it, those facts are
//     tested again. If the transfer was already confirmed, or the case was
//     already closed, the proposal goes stale and does not execute. An
//     approval is permission to perform an action against the state that
//     justified it, not against whatever state happens to exist later.
//   - **Approval is an act by a person, recorded as one.** The approver is
//     named in the block. "The agent did it" is not an audit trail, and this
//     layer never produces that sentence.
//
// What it cannot do: issue or redeem money, move anybody's balance directly,
// clear an AML case, change a price, or approve its own work. The handlers
// below are the entire list of things an approval can cause, and each one is
// an action a person already had the authority to perform by hand.

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	BlockAgentProposed = "UMI_AGENT_PROPOSED"
	BlockAgentApproved = "UMI_AGENT_APPROVED"
	BlockAgentRejected = "UMI_AGENT_REJECTED"
	BlockAgentStale    = "UMI_AGENT_STALE"
)

// Proposal states.
const (
	ProposalDraft    = "DRAFT"
	ProposalApproved = "APPROVED"
	ProposalRejected = "REJECTED"
	ProposalStale    = "STALE"
)

// The actions an approval can cause. This list is deliberately short and
// deliberately boring.
const (
	ActionConfirmForeignLeg       = "CONFIRM_FOREIGN_LEG"
	ActionOpenAMLCase             = "OPEN_AML_CASE"
	ActionRequestAttestionRefresh = "REQUEST_ATTESTATION_REFRESH"
	ActionFlagForReview           = "FLAG_FOR_REVIEW"
)

var (
	ErrProposalNotFound = errors.New("ERR_UMI_AGENT_NOT_FOUND")
	ErrProposalState    = errors.New("ERR_UMI_AGENT_STATE")
	ErrProposalStale    = errors.New("ERR_UMI_AGENT_STALE")
	ErrProposalFields   = errors.New("ERR_UMI_AGENT_FIELDS")
)

const agentDisclaimer = "A proposing agent. It reads state and drafts actions; it does not execute anything on " +
	"its own, it cannot move or create money, and every action it suggests is one a person already had the " +
	"authority to take by hand. Approval is an act by the named approver, not by the agent."

// Proposal is one drafted action.
type Proposal struct {
	ProposalID string `json:"proposalId"`

	// Kind is the handler that runs on approval. Subject is what it acts on.
	Kind    string `json:"kind"`
	Subject string `json:"subject"`

	Title string   `json:"title"`
	Why   []string `json:"why"`

	// Evidence is what was true when this was drafted, and what is tested
	// again at approval. A proposal whose evidence has moved does not run.
	Evidence map[string]interface{} `json:"evidence"`

	// WhatWillHappen says, in a sentence, the effect of approving. A queue of
	// actions nobody can read is a queue nobody should approve.
	WhatWillHappen string `json:"whatWillHappen"`
	IfIgnored      string `json:"ifIgnored"`

	Status      string `json:"status"`
	DraftedAt   string `json:"draftedAt"`
	DecidedAt   string `json:"decidedAt,omitempty"`
	DecidedBy   string `json:"decidedBy,omitempty"`
	Reason      string `json:"reason,omitempty"`
	Result      string `json:"result,omitempty"`
	BlockHeight int64  `json:"blockHeight,omitempty"`

	// key dedupes: one open proposal per situation, however often it scans.
	key string
}

// AgentDesk holds the queue. It is given read access to the layers it watches
// and write access to nothing except through the handlers below.
type AgentDesk struct {
	mu        sync.Mutex
	chain     *DrunixChain
	corridors *CorridorDesk
	cbdc      *CBDCLedger
	aml       *AMLDesk
	backing   *BackingRegistry

	proposals map[string]*Proposal
	order     []string
	lastScan  string
	scans     int
}

func NewAgentDesk(chain *DrunixChain, corridors *CorridorDesk, cbdc *CBDCLedger, aml *AMLDesk, backing *BackingRegistry) *AgentDesk {
	return &AgentDesk{
		chain: chain, corridors: corridors, cbdc: cbdc, aml: aml, backing: backing,
		proposals: map[string]*Proposal{},
	}
}

// ---------------------------------------------------------------------------
// Scanning: the noticing half
// ---------------------------------------------------------------------------

// Scan reads current state and drafts what it finds. It is called by a person
// or by a read of the queue, never by a timer, and it writes nothing except
// proposals. Running it twice over unchanged state produces no duplicates.
func (a *AgentDesk) Scan(now time.Time) []Proposal {
	drafted := []Proposal{}
	for _, d := range a.detect(now) {
		if p := a.draft(d, now); p != nil {
			drafted = append(drafted, *p)
		}
	}
	a.mu.Lock()
	a.lastScan = now.UTC().Format(time.RFC3339Nano)
	a.scans++
	a.mu.Unlock()
	return drafted
}

// detect holds every rule. Each returns a fully formed proposal including the
// evidence that will be re-tested at approval time.
func (a *AgentDesk) detect(now time.Time) []Proposal {
	out := []Proposal{}

	// 1. A correspondent or card leg whose settlement window has run out.
	// Somebody has to chase the far institution and then record the answer;
	// the agent cannot know the far leg landed, so it proposes rather than
	// confirms.
	if a.corridors != nil {
		for _, t := range a.corridors.Transfers(200) {
			if t.Status != CorridorAwaitingLeg {
				continue
			}
			opened, err := time.Parse(time.RFC3339Nano, t.OpenedAt)
			if err != nil {
				continue
			}
			hours := int64(now.Sub(opened).Hours())
			if hours < 120 { // five business days, the stated correspondent window
				continue
			}
			out = append(out, Proposal{
				Kind: ActionConfirmForeignLeg, Subject: t.TransferID,
				key:   "confirm:" + t.TransferID,
				Title: fmt.Sprintf("Chase and record the far leg of %s", t.TransferID),
				Why: []string{
					fmt.Sprintf("This transfer has been awaiting its foreign leg for %d hours.", hours),
					"The stated window for this corridor is three to five business days, which has passed.",
					"The money is in corridor suspense: the payer has paid and the payee has not been credited.",
				},
				Evidence: map[string]interface{}{
					"transferId": t.TransferID, "status": t.Status, "amountPaise": t.AmountPaise,
					"openedAt": t.OpenedAt, "hoursOutstanding": hours,
				},
				WhatWillHappen: "Records that the far institution has confirmed its leg, which releases the money " +
					"to the payee and makes the transfer final. Approve this only once the far side has actually " +
					"confirmed: this rail cannot see their books.",
				IfIgnored: "The payee stays uncredited and the money stays in suspense. Nothing expires on its own.",
			})
		}
	}

	// 2. A conditional payment close to its deadline with nobody having
	// attested. The agent will not release it (only the named attestor can
	// do that) and will not cancel it (the sweep does that, in the payer's
	// favour). It proposes that a person look, which is the honest action.
	if a.cbdc != nil {
		for _, c := range a.cbdc.Conditions() {
			if !strings.EqualFold(c.Status, "OPEN") {
				continue
			}
			deadline, err := time.Parse(time.RFC3339, c.Deadline)
			if err != nil {
				if deadline, err = time.Parse(time.RFC3339Nano, c.Deadline); err != nil {
					continue
				}
			}
			left := deadline.Sub(now)
			if left <= 0 || left > 6*time.Hour {
				continue
			}
			out = append(out, Proposal{
				Kind: ActionFlagForReview, Subject: c.ConditionID,
				key:   "expiring:" + c.ConditionID,
				Title: fmt.Sprintf("Conditional payment %s expires in under six hours", c.ConditionID),
				Why: []string{
					fmt.Sprintf("The attestor named on it (%s) has not attested the event.", c.Attestor),
					fmt.Sprintf("The deadline is %s, which is %d minutes away.", c.Deadline, int(left.Minutes())),
					"On expiry the locked money returns to the payer and the payee receives nothing.",
				},
				Evidence: map[string]interface{}{
					"conditionId": c.ConditionID, "status": c.Status, "attestor": c.Attestor,
					"deadline": c.Deadline, "amountPaise": c.AmountPaise,
				},
				WhatWillHappen: "Records that this was flagged for a person's attention, and who flagged it. " +
					"It does not release the money and does not extend the deadline: only the named attestor can " +
					"release, and only the payer and payee can agree a new condition.",
				IfIgnored: "The deadline passes and the money returns to the payer, which may be the correct " +
					"outcome. The point of the flag is that somebody decided it was.",
			})
		}
	}

	// 3. An AML case nobody has picked up. An alert that sits unworked is the
	// failure mode regulators actually find.
	if a.aml != nil {
		for _, c := range a.aml.Cases(200) {
			if c.Status != CaseOpen {
				continue
			}
			opened, err := time.Parse(time.RFC3339Nano, c.OpenedAt)
			if err != nil {
				continue
			}
			hours := int64(now.Sub(opened).Hours())
			if hours < 24 {
				continue
			}
			out = append(out, Proposal{
				Kind: ActionFlagForReview, Subject: c.CaseID,
				key:   "unworked:" + c.CaseID,
				Title: fmt.Sprintf("AML case %s has been open for %d hours with no reviewer", c.CaseID, hours),
				Why: []string{
					fmt.Sprintf("Subject: %s.", c.Subject),
					"No reviewer has picked it up, so no human judgement has been recorded.",
					"A screening hit that nobody works is the same as no screening.",
				},
				Evidence: map[string]interface{}{
					"caseId": c.CaseID, "status": c.Status, "openedAt": c.OpenedAt, "hoursOpen": hours,
				},
				WhatWillHappen: "Records that this case was escalated for attention, and by whom. It does not " +
					"clear the case, does not report it, and does not touch the payment: clearing and reporting " +
					"stay with a reviewer who states their grounds.",
				IfIgnored: "The case stays open and unattributed.",
			})
		}
	}

	// 4. An attestation that has gone stale or short. Issuance is already
	// blocked by the gate; what is missing is somebody asking the attestor
	// for a fresh statement.
	if a.backing != nil {
		sol := a.backing.Solvency(now)
		rows, _ := sol["assets"].([]BackingCoverage)
		for _, row := range rows {
			if row.Status != BackingStale && row.Status != BackingOverIssued {
				continue
			}
			out = append(out, Proposal{
				Kind: ActionRequestAttestionRefresh, Subject: row.AssetID,
				key:   "attestation:" + row.AssetID + ":" + row.Status,
				Title: fmt.Sprintf("Ask %s for a fresh statement on %s", firstNonEmptyAgent(row.Attestor, "the attestor"), row.AssetID),
				Why: []string{
					fmt.Sprintf("Backing status is %s.", row.Status),
					fmt.Sprintf("The last statement is %d hours old against a stated cadence of %s.", row.AgeHours, firstNonEmptyAgent(row.Cadence, "none recorded")),
					"Issuance on this asset is already blocked by the gate; the statement is what is missing.",
				},
				Evidence: map[string]interface{}{
					"assetId": row.AssetID, "backingStatus": row.Status,
					"tokensOutstanding": row.TokensOutstanding, "statementAgeHours": row.AgeHours,
				},
				WhatWillHappen: "Records a request to the named attestor for a current statement, with the " +
					"reading that prompted it. It does not attest anything: only the attestor can do that, and " +
					"this rail cannot check that what they say is true.",
				IfIgnored: "Issuance stays blocked, which is the safe direction, and the published coverage " +
					"figure stays out of date.",
			})
		}
	}

	return out
}

func firstNonEmptyAgent(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

// draft files a proposal unless the same situation is already queued.
func (a *AgentDesk) draft(p Proposal, now time.Time) *Proposal {
	a.mu.Lock()
	for _, id := range a.order {
		if existing, ok := a.proposals[id]; ok && existing.key == p.key && existing.Status == ProposalDraft {
			a.mu.Unlock()
			return nil
		}
	}
	p.ProposalID = cbdcID("AGT")
	p.Status = ProposalDraft
	p.DraftedAt = now.UTC().Format(time.RFC3339Nano)
	a.proposals[p.ProposalID] = &p
	a.order = append(a.order, p.ProposalID)
	a.mu.Unlock()

	a.commit(BlockAgentProposed, map[string]interface{}{
		"proposalId": p.ProposalID, "kind": p.Kind, "subject": p.Subject, "title": p.Title,
		"status": ProposalDraft,
		"note":   "Drafted by the proposing agent. Nothing has happened. A named person must approve it.",
	})
	return &p
}

// ---------------------------------------------------------------------------
// Deciding: the half that belongs to a person
// ---------------------------------------------------------------------------

// Approve re-tests the evidence and then performs the action. The approver is
// named everywhere the result appears.
func (a *AgentDesk) Approve(proposalID, who, note string) (*Proposal, error) {
	if strings.TrimSpace(who) == "" {
		return nil, fmt.Errorf("%w: an approval has to be somebody's", ErrProposalFields)
	}
	a.mu.Lock()
	p, ok := a.proposals[proposalID]
	if !ok {
		a.mu.Unlock()
		return nil, fmt.Errorf("%w: no proposal with that reference", ErrProposalNotFound)
	}
	if p.Status != ProposalDraft {
		a.mu.Unlock()
		return nil, fmt.Errorf("%w: this proposal is already %s", ErrProposalState, strings.ToLower(p.Status))
	}
	copyP := *p
	a.mu.Unlock()

	// The world may have moved since the draft. An approval is permission to
	// act on the state that justified it, not on whatever exists now.
	if why, fresh := a.evidenceStillHolds(copyP, time.Now()); !fresh {
		a.mu.Lock()
		p.Status = ProposalStale
		p.DecidedAt = time.Now().UTC().Format(time.RFC3339Nano)
		p.DecidedBy = who
		p.Reason = why
		out := *p
		a.mu.Unlock()
		a.commit(BlockAgentStale, map[string]interface{}{
			"proposalId": out.ProposalID, "subject": out.Subject, "approver": who, "reason": why,
			"note": "Approved, but the state it was drafted from had changed. Nothing was performed.",
		})
		return &out, fmt.Errorf("%w: %s", ErrProposalStale, why)
	}

	result, err := a.perform(copyP, who)
	if err != nil {
		return nil, err
	}

	now := time.Now().UTC().Format(time.RFC3339Nano)
	a.mu.Lock()
	p.Status = ProposalApproved
	p.DecidedAt = now
	p.DecidedBy = who
	p.Reason = note
	p.Result = result
	out := *p
	a.mu.Unlock()

	blk := a.commit(BlockAgentApproved, map[string]interface{}{
		"proposalId": out.ProposalID, "kind": out.Kind, "subject": out.Subject,
		"approvedBy": who, "note": note, "result": result,
		"recordedAs": "An act by " + who + ", on a proposal drafted by the agent.",
	})
	if blk != nil {
		a.mu.Lock()
		p.BlockHeight = blk.Height
		out.BlockHeight = blk.Height
		a.mu.Unlock()
	}
	return &out, nil
}

// Reject closes a proposal. A reason is required: a queue cleared without
// reasons teaches nobody anything, including the people writing the rules.
func (a *AgentDesk) Reject(proposalID, who, reason string) (*Proposal, error) {
	if strings.TrimSpace(reason) == "" {
		return nil, fmt.Errorf("%w: rejecting a proposal requires a reason", ErrProposalFields)
	}
	a.mu.Lock()
	p, ok := a.proposals[proposalID]
	if !ok {
		a.mu.Unlock()
		return nil, fmt.Errorf("%w: no proposal with that reference", ErrProposalNotFound)
	}
	if p.Status != ProposalDraft {
		a.mu.Unlock()
		return nil, fmt.Errorf("%w: this proposal is already %s", ErrProposalState, strings.ToLower(p.Status))
	}
	p.Status = ProposalRejected
	p.DecidedAt = time.Now().UTC().Format(time.RFC3339Nano)
	p.DecidedBy = who
	p.Reason = reason
	out := *p
	a.mu.Unlock()

	a.commit(BlockAgentRejected, map[string]interface{}{
		"proposalId": out.ProposalID, "subject": out.Subject, "rejectedBy": who, "reason": reason,
	})
	return &out, nil
}

// evidenceStillHolds re-reads the record a proposal was drafted from.
func (a *AgentDesk) evidenceStillHolds(p Proposal, now time.Time) (string, bool) {
	switch p.Kind {
	case ActionConfirmForeignLeg:
		if a.corridors == nil {
			return "the corridor layer is not mounted", false
		}
		t, ok := a.corridors.Transfer(p.Subject)
		if !ok {
			return "that transfer no longer exists", false
		}
		if t.Status != CorridorAwaitingLeg {
			return "the transfer is now " + t.Status + ", so there is no outstanding leg to record", false
		}
	case ActionRequestAttestionRefresh:
		if a.backing == nil {
			return "the backing registry is not mounted", false
		}
		want, _ := p.Evidence["backingStatus"].(string)
		got := a.backing.Coverage(p.Subject, now).Status
		if got != want {
			return "the backing status is now " + got + ", not " + want, false
		}
	case ActionFlagForReview:
		// Flagging an AML case that has since been worked is pointless.
		if strings.HasPrefix(p.Subject, "AML-CASE") && a.aml != nil {
			c, err := a.aml.Case(p.Subject)
			if err != nil {
				return "that case no longer exists", false
			}
			if c.Status != CaseOpen {
				return "the case is now " + strings.ToLower(c.Status) + ", so somebody has already worked it", false
			}
		}
	}
	return "", true
}

// perform is the whole list of things an approval can cause.
func (a *AgentDesk) perform(p Proposal, who string) (string, error) {
	switch p.Kind {
	case ActionConfirmForeignLeg:
		t, err := a.corridors.ConfirmLeg(p.Subject, who, time.Now())
		if err != nil {
			return "", err
		}
		return fmt.Sprintf("Far leg recorded as confirmed by %s. Transfer %s is now %s.", who, t.TransferID, t.Status), nil

	case ActionOpenAMLCase:
		if a.aml == nil {
			return "", fmt.Errorf("%w: the screening layer is not mounted", ErrProposalState)
		}
		c := a.aml.OpenCase(a.aml.Screen(p.Subject), who, fmt.Sprint(p.Evidence["relatedRef"]), "", 0)
		return "Case " + c.CaseID + " opened for " + p.Subject + ".", nil

	case ActionRequestAttestionRefresh:
		// Deliberately a record, not an act. This rail cannot make an
		// attestor say anything, and pretending otherwise would put a
		// fabricated statement under a real token.
		return "Recorded a request to the attestor for a current statement on " + p.Subject +
			". No attestation has been created: only the attestor can make one.", nil

	case ActionFlagForReview:
		return "Flagged " + p.Subject + " for attention by " + who + ". Nothing was moved, released or closed.", nil
	}
	return "", fmt.Errorf("%w: unknown action %q", ErrProposalFields, p.Kind)
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

func (a *AgentDesk) Proposals(status string, limit int) []Proposal {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := []Proposal{}
	for i := len(a.order) - 1; i >= 0 && (limit <= 0 || len(out) < limit); i-- {
		p, ok := a.proposals[a.order[i]]
		if !ok {
			continue
		}
		if status != "" && !strings.EqualFold(p.Status, status) {
			continue
		}
		out = append(out, *p)
	}
	return out
}

func (a *AgentDesk) Proposal(id string) (*Proposal, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	p, ok := a.proposals[id]
	if !ok {
		return nil, fmt.Errorf("%w: no proposal with that reference", ErrProposalNotFound)
	}
	cp := *p
	return &cp, nil
}

func (a *AgentDesk) Status() map[string]interface{} {
	a.mu.Lock()
	defer a.mu.Unlock()
	counts := map[string]int{ProposalDraft: 0, ProposalApproved: 0, ProposalRejected: 0, ProposalStale: 0}
	for _, p := range a.proposals {
		counts[p.Status]++
	}
	kinds := make([]string, 0, 4)
	for _, k := range []string{ActionConfirmForeignLeg, ActionFlagForReview, ActionRequestAttestionRefresh, ActionOpenAMLCase} {
		kinds = append(kinds, k)
	}
	sort.Strings(kinds)
	return map[string]interface{}{
		"proposals":           counts,
		"lastScan":            a.lastScan,
		"scans":               a.scans,
		"actionsItCanPropose": kinds,
		"itCannot": []string{
			"execute anything without a named person approving it",
			"issue, redeem or move money",
			"clear or report an AML case",
			"create an attestation",
			"approve its own proposal",
			"act on a timer or a schedule",
		},
		"onApproval": "The evidence is re-read first. If the state it was drafted from has changed, the " +
			"proposal goes stale and nothing is performed.",
		"disclaimer": agentDisclaimer,
	}
}

func (a *AgentDesk) commit(blockType string, txn map[string]interface{}) *DrunixBlock {
	if a.chain == nil {
		return nil
	}
	txn["rail"] = "Proposing agent (drafts only, never executes on its own)"
	return a.chain.Append(blockType, []map[string]interface{}{txn})
}
