package drunix

// Agent passports: a pseudonym for a software actor, with the principal behind
// it split across custodians instead of printed on the ledger.
//
// The mandate layer already answers authority: what this agent may do, on whose
// behalf, up to what amount, until when. It answers it by naming the principal
// in the clear, which is the one arrangement nobody actually argues for. The
// choices on the table are a principal who discloses selectively (and whose
// accountability is therefore voluntary), an authority holding the identity in
// escrow (accountable, but one party can open anyone), or a threshold: opening
// the pseudonym takes several independent parties, enforced by arithmetic.
//
// This file is the third, with the audit trail of the second. A passport binds
// a pseudonym to a purpose and a mandate; the principal is Shamir-split across
// named custodians; and nobody is re-identified without a request, a stated
// trigger, k separate approvals and a block for every one of those steps.
//
// Said plainly, because the file is worth less if it is oversold: the shares
// all live in this one process. The arithmetic genuinely needs k of them, so
// the protocol is real, but the distribution is simulated and whoever runs the
// host holds every share. Real custody means one share per organisation. The
// API returns that sentence with the data.

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

// Block types. Every step of an opening is on the chain: a principal must not
// be able to be un-masked quietly, and an unanswered request is itself a fact
// worth keeping.
const (
	BlockAgentRegistered      = "AGENT_REGISTERED"
	BlockAgentRevoked         = "AGENT_REVOKED"
	BlockAgentRevealRequested = "AGENT_REVEAL_REQUESTED"
	BlockAgentRevealApproved  = "AGENT_REVEAL_APPROVED"
	BlockAgentRevealed        = "AGENT_REVEALED"
	BlockAgentRevealExpired   = "AGENT_REVEAL_EXPIRED"
)

var (
	ErrAgentFields       = errors.New("ERR_UMI_AGENT_FIELDS")
	ErrAgentNotFound     = errors.New("ERR_UMI_AGENT_NOT_FOUND")
	ErrAgentNotPrincipal = errors.New("ERR_UMI_AGENT_NOT_PRINCIPAL")
	ErrAgentNotCustodian = errors.New("ERR_UMI_AGENT_NOT_CUSTODIAN")
	ErrAgentNoRequest    = errors.New("ERR_UMI_AGENT_NO_REVEAL_REQUEST")
	ErrAgentDuplicate    = errors.New("ERR_UMI_AGENT_ALREADY_APPROVED")
	ErrAgentRevealed     = errors.New("ERR_UMI_AGENT_ALREADY_REVEALED")
)

const (
	agentRevealWindow = 14 * 24 * time.Hour // long enough for a human process, short enough to lapse
	maxAgentCustodian = 7
)

// AgentPassport is what a counterparty is allowed to know about an automated
// actor, plus the sealed material that makes the rest recoverable.
type AgentPassport struct {
	AgentID    string   `json:"agentId"` // the pseudonym; the only identifier on public surfaces
	Purpose    string   `json:"purpose"`
	Version    string   `json:"version,omitempty"`
	MandateID  string   `json:"mandateId,omitempty"`
	Custodians []string `json:"custodians"`
	Threshold  int      `json:"threshold"`
	Sponsored  bool     `json:"sponsored"` // a liable principal exists, without naming them
	CreatedAt  time.Time
	Block      int64 `json:"registeredBlock"`

	Revoked   bool
	RevokedBy string
	RevokedAt time.Time

	// shares are held per custodian. Reconstructing the principal needs
	// Threshold of them, which is the entire point: one custodian holding a
	// share learns nothing, and neither do Threshold-1 of them together.
	shares map[string][]byte

	// reveal state
	RequestedBy  string
	RequestedAt  time.Time
	Reason       string
	RequestDueAt time.Time
	Approvals    []string
	Revealed     bool
	Principal    string // populated only once an opening completed
	RevealedAt   time.Time
}

// AgentRegistration is what a principal sends to put an agent on the register.
type AgentRegistration struct {
	Purpose    string   `json:"purpose"`
	Version    string   `json:"version"`
	MandateID  string   `json:"mandateId"`
	Custodians []string `json:"custodians"`
	Threshold  int      `json:"threshold"`
}

// AgentRegistry holds the passports and the escrowed principals.
type AgentRegistry struct {
	mu    sync.RWMutex
	chain *DrunixChain
	book  map[string]*AgentPassport
}

func NewAgentRegistry(chain *DrunixChain) *AgentRegistry {
	return &AgentRegistry{chain: chain, book: map[string]*AgentPassport{}}
}

// AgentDisclaimer is returned with every read. The honest limits of this layer
// belong next to its output, not in a document nobody opens.
const AgentDisclaimer = "An agent here acts under a pseudonym. A liable principal is recorded but " +
	"sealed, and recovering it takes a threshold of named custodians, each approval written to the " +
	"chain. The split is real arithmetic; the custody is not distributed, because every share is " +
	"held by this one process. Treat the pseudonym as re-identifiable, which is what it is."

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

// Register seals the principal behind a new pseudonym.
//
// The caller is the principal: an agent's accountability is not something a
// third party gets to assign. A participant cannot be its own agent, for the
// same reason a mandate cannot be granted to oneself.
func (r *AgentRegistry) Register(principal string, req AgentRegistration) (*AgentPassport, error) {
	principal = strings.TrimSpace(principal)
	purpose := strings.TrimSpace(req.Purpose)
	if principal == "" || purpose == "" {
		return nil, fmt.Errorf("%w: a principal and a stated purpose are both required", ErrAgentFields)
	}
	if len(purpose) > 200 {
		return nil, fmt.Errorf("%w: keep the purpose under 200 characters", ErrAgentFields)
	}

	custodians, err := normaliseCustodians(principal, req.Custodians)
	if err != nil {
		return nil, err
	}
	// A threshold of one is the escrow model with the safeguard removed: one
	// party could open anybody. Two is the floor, by construction.
	if req.Threshold < 2 || req.Threshold > len(custodians) {
		return nil, fmt.Errorf("%w: threshold must be at least 2 and no more than the %d custodians",
			ErrAgentFields, len(custodians))
	}

	shares, err := splitSecret([]byte(principal), req.Threshold, len(custodians))
	if err != nil {
		return nil, err
	}

	now := time.Now().UTC()
	p := &AgentPassport{
		AgentID:    agentPseudonym(principal, purpose, now),
		Purpose:    purpose,
		Version:    strings.TrimSpace(req.Version),
		MandateID:  strings.TrimSpace(req.MandateID),
		Custodians: custodians,
		Threshold:  req.Threshold,
		Sponsored:  true,
		CreatedAt:  now,
		shares:     map[string][]byte{},
	}
	for i, c := range custodians {
		p.shares[c] = shares[i]
	}

	// The block carries the pseudonym and never the principal. A ledger that
	// records the thing being hidden has hidden nothing.
	blk := r.commit(BlockAgentRegistered, map[string]interface{}{
		"agentId":    p.AgentID,
		"purpose":    p.Purpose,
		"version":    p.Version,
		"mandateId":  p.MandateID,
		"custodians": custodians,
		"threshold":  p.Threshold,
		"sponsored":  true,
	})
	p.Block = blk

	r.mu.Lock()
	r.book[p.AgentID] = p
	r.mu.Unlock()
	return p, nil
}

func normaliseCustodians(principal string, in []string) ([]string, error) {
	seen := map[string]bool{}
	out := []string{}
	for _, c := range in {
		c = strings.TrimSpace(strings.ToLower(c))
		if c == "" {
			continue
		}
		if c == strings.ToLower(principal) {
			// A principal holding a share of its own identity is not a
			// custodian, it is a veto on being identified.
			return nil, fmt.Errorf("%w: the principal cannot be one of its own custodians", ErrAgentFields)
		}
		if seen[c] {
			continue
		}
		seen[c] = true
		out = append(out, c)
	}
	if len(out) < 2 {
		return nil, fmt.Errorf("%w: name at least two distinct custodians", ErrAgentFields)
	}
	if len(out) > maxAgentCustodian {
		return nil, fmt.Errorf("%w: at most %d custodians", ErrAgentFields, maxAgentCustodian)
	}
	sort.Strings(out)
	return out, nil
}

// agentPseudonym is derived, not sequential, so the order of registration
// leaks nothing either.
func agentPseudonym(principal, purpose string, at time.Time) string {
	var nonce [16]byte
	_, _ = rand.Read(nonce[:])
	sum := sha256.Sum256([]byte("aasthi-agent|" + principal + "|" + purpose + "|" +
		at.Format(time.RFC3339Nano) + "|" + hex.EncodeToString(nonce[:])))
	return "agent:aasthi:" + hex.EncodeToString(sum[:])[:16]
}

// ---------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------

// Revoke stops an agent acting. It deliberately does not seal the record any
// further: revocation is about the future, and who was accountable for what
// already happened stays recoverable.
func (r *AgentRegistry) Revoke(agentID, by string, supervisor bool) (*AgentPassport, error) {
	r.mu.Lock()
	p, ok := r.book[agentID]
	if !ok {
		r.mu.Unlock()
		return nil, ErrAgentNotFound
	}
	// Only the principal (who is sealed, so this is the supervisor's job in
	// practice) or a supervisor may revoke. A custodian holding a share is not
	// thereby in charge of the agent.
	if !supervisor && !p.Revealed {
		r.mu.Unlock()
		return nil, ErrAgentNotPrincipal
	}
	if !supervisor && !strings.EqualFold(by, p.Principal) {
		r.mu.Unlock()
		return nil, ErrAgentNotPrincipal
	}
	p.Revoked = true
	p.RevokedBy = by
	p.RevokedAt = time.Now().UTC()
	snapshot := *p
	r.mu.Unlock()

	r.commit(BlockAgentRevoked, map[string]interface{}{
		"agentId":   agentID,
		"revokedBy": by,
		"revokedAt": snapshot.RevokedAt.Format(time.RFC3339),
	})
	return &snapshot, nil
}

// ---------------------------------------------------------------------------
// Opening a pseudonym
// ---------------------------------------------------------------------------

// RequestReveal opens a governed request to identify the principal. A reason
// is mandatory: "a dispute, a legal process, a fraud finding" is the whole
// justification for the capability existing, so an unstated trigger is refused.
func (r *AgentRegistry) RequestReveal(agentID, reason, by string, supervisor bool) (*AgentPassport, error) {
	reason = strings.TrimSpace(reason)
	if len(reason) < 8 {
		return nil, fmt.Errorf("%w: state the trigger for the request", ErrAgentFields)
	}

	r.mu.Lock()
	p, ok := r.book[agentID]
	if !ok {
		r.mu.Unlock()
		return nil, ErrAgentNotFound
	}
	if p.Revealed {
		r.mu.Unlock()
		return nil, ErrAgentRevealed
	}
	if !supervisor && !isCustodian(p, by) {
		r.mu.Unlock()
		return nil, ErrAgentNotCustodian
	}
	now := time.Now().UTC()
	p.RequestedBy = by
	p.RequestedAt = now
	p.Reason = reason
	p.RequestDueAt = now.Add(agentRevealWindow)
	p.Approvals = nil
	snapshot := *p
	r.mu.Unlock()

	r.commit(BlockAgentRevealRequested, map[string]interface{}{
		"agentId":     agentID,
		"requestedBy": by,
		"reason":      reason,
		"threshold":   snapshot.Threshold,
		"dueAt":       snapshot.RequestDueAt.Format(time.RFC3339),
	})
	return &snapshot, nil
}

// ApproveReveal contributes one custodian's share. When the threshold is met
// the principal is reconstructed, written to the chain and returned. Short of
// the threshold it returns the passport with the approval recorded and the
// principal still sealed.
func (r *AgentRegistry) ApproveReveal(agentID, by string) (*AgentPassport, error) {
	by = strings.TrimSpace(strings.ToLower(by))

	r.mu.Lock()
	p, ok := r.book[agentID]
	if !ok {
		r.mu.Unlock()
		return nil, ErrAgentNotFound
	}
	if p.Revealed {
		r.mu.Unlock()
		return nil, ErrAgentRevealed
	}
	if p.RequestedAt.IsZero() {
		r.mu.Unlock()
		return nil, ErrAgentNoRequest
	}
	now := time.Now().UTC()
	if now.After(p.RequestDueAt) {
		// A request nobody completed lapses, and the lapse is recorded. An
		// expired ask that quietly stayed open would be a standing warrant.
		p.RequestedAt = time.Time{}
		p.Approvals = nil
		reason := p.Reason
		r.mu.Unlock()
		r.commit(BlockAgentRevealExpired, map[string]interface{}{
			"agentId": agentID,
			"reason":  reason,
		})
		return nil, ErrAgentNoRequest
	}
	if !isCustodian(p, by) {
		r.mu.Unlock()
		return nil, ErrAgentNotCustodian
	}
	for _, a := range p.Approvals {
		if strings.EqualFold(a, by) {
			r.mu.Unlock()
			return nil, ErrAgentDuplicate
		}
	}
	p.Approvals = append(p.Approvals, by)

	if len(p.Approvals) < p.Threshold {
		snapshot := *p
		r.mu.Unlock()
		r.commit(BlockAgentRevealApproved, map[string]interface{}{
			"agentId":   agentID,
			"custodian": by,
			"approvals": len(snapshot.Approvals),
			"threshold": snapshot.Threshold,
		})
		return &snapshot, nil
	}

	// Threshold reached: combine exactly the shares that were approved.
	parts := make([]secretShare, 0, len(p.Approvals))
	for _, a := range p.Approvals {
		parts = append(parts, secretShare{x: custodianIndex(p, a), y: p.shares[a]})
	}
	principal, err := combineSecret(parts)
	if err != nil {
		p.Approvals = p.Approvals[:len(p.Approvals)-1]
		r.mu.Unlock()
		return nil, err
	}
	p.Revealed = true
	p.Principal = string(principal)
	p.RevealedAt = now
	snapshot := *p
	r.mu.Unlock()

	r.commit(BlockAgentRevealApproved, map[string]interface{}{
		"agentId":   agentID,
		"custodian": by,
		"approvals": len(snapshot.Approvals),
		"threshold": snapshot.Threshold,
	})
	// The reveal names the principal on the chain. An identity opened in
	// private has been handed to whoever asked, with no record for the person
	// it belongs to.
	r.commit(BlockAgentRevealed, map[string]interface{}{
		"agentId":    agentID,
		"principal":  snapshot.Principal,
		"reason":     snapshot.Reason,
		"custodians": append([]string{}, snapshot.Approvals...),
		"revealedAt": snapshot.RevealedAt.Format(time.RFC3339),
	})
	return &snapshot, nil
}

func isCustodian(p *AgentPassport, who string) bool {
	for _, c := range p.Custodians {
		if strings.EqualFold(c, who) {
			return true
		}
	}
	return false
}

func custodianIndex(p *AgentPassport, who string) byte {
	for i, c := range p.Custodians {
		if strings.EqualFold(c, who) {
			return byte(i + 1) // x = 0 would hand over the secret itself
		}
	}
	return 0
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

// AgentView is the public shape: everything a counterparty needs to decide
// whether to deal with the agent, and nothing that identifies the principal
// unless an opening already completed in public.
type AgentView struct {
	AgentID      string   `json:"agentId"`
	Purpose      string   `json:"purpose"`
	Version      string   `json:"version,omitempty"`
	MandateID    string   `json:"mandateId,omitempty"`
	Custodians   []string `json:"custodians"`
	Threshold    int      `json:"threshold"`
	Sponsored    bool     `json:"sponsored"`
	Status       string   `json:"status"`
	RegisteredAt string   `json:"registeredAt"`
	Block        int64    `json:"registeredBlock"`

	RevealRequested bool     `json:"revealRequested"`
	RevealReason    string   `json:"revealReason,omitempty"`
	RevealDueAt     string   `json:"revealDueAt,omitempty"`
	Approvals       int      `json:"approvals"`
	ApprovedBy      []string `json:"approvedBy,omitempty"`
	Revealed        bool     `json:"revealed"`
	Principal       string   `json:"principal,omitempty"`
	RevealedAt      string   `json:"revealedAt,omitempty"`
	Reading         string   `json:"reading"`
}

func viewOf(p *AgentPassport, now time.Time) AgentView {
	v := AgentView{
		AgentID: p.AgentID, Purpose: p.Purpose, Version: p.Version, MandateID: p.MandateID,
		Custodians: append([]string{}, p.Custodians...), Threshold: p.Threshold,
		Sponsored: p.Sponsored, RegisteredAt: p.CreatedAt.Format(time.RFC3339), Block: p.Block,
		Approvals: len(p.Approvals), Revealed: p.Revealed,
	}
	if len(p.Approvals) > 0 {
		v.ApprovedBy = append([]string{}, p.Approvals...)
	}
	switch {
	case p.Revealed:
		v.Status = "IDENTIFIED"
		v.Principal = p.Principal
		v.RevealedAt = p.RevealedAt.Format(time.RFC3339)
		v.Reading = "The principal behind this agent was identified by " + fmt.Sprint(p.Threshold) +
			" custodians acting together. The request, each approval and the result are on the chain."
	case p.Revoked:
		v.Status = "REVOKED"
		v.Reading = "This agent may no longer act. Who stands behind what it already did is still recoverable."
	case !p.RequestedAt.IsZero() && now.Before(p.RequestDueAt):
		v.Status = "REVEAL_PENDING"
		v.RevealRequested = true
		v.RevealReason = p.Reason
		v.RevealDueAt = p.RequestDueAt.Format(time.RFC3339)
		v.Reading = fmt.Sprintf("An identification request is open with %d of %d approvals. It lapses if nobody completes it.",
			len(p.Approvals), p.Threshold)
	default:
		v.Status = "ACTIVE"
		v.Reading = fmt.Sprintf("A liable principal is recorded and sealed. Identifying them takes %d of these %d custodians.",
			p.Threshold, len(p.Custodians))
	}
	return v
}

// List returns every passport, pending openings first, because an open request
// is the thing a reader is most likely to be looking for.
func (r *AgentRegistry) List(now time.Time) []AgentView {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]AgentView, 0, len(r.book))
	for _, p := range r.book {
		out = append(out, viewOf(p, now))
	}
	rank := map[string]int{"REVEAL_PENDING": 0, "IDENTIFIED": 1, "ACTIVE": 2, "REVOKED": 3}
	sort.SliceStable(out, func(i, j int) bool {
		if rank[out[i].Status] != rank[out[j].Status] {
			return rank[out[i].Status] < rank[out[j].Status]
		}
		return out[i].AgentID < out[j].AgentID
	})
	return out
}

// Get returns one passport.
func (r *AgentRegistry) Get(agentID string, now time.Time) (AgentView, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	p, ok := r.book[agentID]
	if !ok {
		return AgentView{}, ErrAgentNotFound
	}
	return viewOf(p, now), nil
}

// ---------------------------------------------------------------------------
// Chain
// ---------------------------------------------------------------------------

func (r *AgentRegistry) commit(kind string, payload map[string]interface{}) int64 {
	if r.chain == nil {
		return 0
	}
	payload["contract"] = UMIContract
	blk := r.chain.Append(kind, []map[string]interface{}{payload})
	if blk == nil {
		return 0
	}
	return blk.Height
}

// ---------------------------------------------------------------------------
// Shamir's secret sharing over GF(256)
//
// Small, self-contained and standard: a random polynomial of degree k-1 whose
// constant term is the secret byte, evaluated at x = 1..n. Any k points
// determine it by Lagrange interpolation; k-1 points determine nothing, which
// is a property of the field rather than an assurance anybody has to be
// trusted for.
// ---------------------------------------------------------------------------

type secretShare struct {
	x byte
	y []byte
}

func gfMul(a, b byte) byte {
	var p byte
	for i := 0; i < 8 && b != 0; i++ {
		if b&1 == 1 {
			p ^= a
		}
		hi := a & 0x80
		a <<= 1
		if hi != 0 {
			a ^= 0x1b // the AES field polynomial
		}
		b >>= 1
	}
	return p
}

func gfPow(a byte, n int) byte {
	var out byte = 1
	for i := 0; i < n; i++ {
		out = gfMul(out, a)
	}
	return out
}

// gfInv uses a^254 = a^-1 in GF(256), which avoids carrying a table.
func gfInv(a byte) byte { return gfPow(a, 254) }

func splitSecret(secret []byte, k, n int) ([][]byte, error) {
	if k < 2 || n < k || n > 255 {
		return nil, fmt.Errorf("%w: a %d-of-%d split is not meaningful", ErrAgentFields, k, n)
	}
	out := make([][]byte, n)
	for i := range out {
		out[i] = make([]byte, len(secret))
	}
	coeffs := make([]byte, k-1)
	for bi, b := range secret {
		if _, err := rand.Read(coeffs); err != nil {
			return nil, err
		}
		for i := 0; i < n; i++ {
			x := byte(i + 1)
			y := b
			for d, c := range coeffs {
				y ^= gfMul(c, gfPow(x, d+1))
			}
			out[i][bi] = y
		}
	}
	return out, nil
}

func combineSecret(parts []secretShare) ([]byte, error) {
	if len(parts) < 2 {
		return nil, fmt.Errorf("%w: a single share recovers nothing", ErrAgentFields)
	}
	size := len(parts[0].y)
	for _, p := range parts {
		if p.x == 0 || len(p.y) != size {
			return nil, fmt.Errorf("%w: malformed share", ErrAgentFields)
		}
	}
	out := make([]byte, size)
	for bi := 0; bi < size; bi++ {
		var acc byte
		for i, pi := range parts {
			num, den := byte(1), byte(1)
			for j, pj := range parts {
				if i == j {
					continue
				}
				num = gfMul(num, pj.x)
				den = gfMul(den, pi.x^pj.x)
			}
			if den == 0 {
				return nil, fmt.Errorf("%w: duplicate share", ErrAgentFields)
			}
			acc ^= gfMul(pi.y[bi], gfMul(num, gfInv(den)))
		}
		out[bi] = acc
	}
	return out, nil
}
