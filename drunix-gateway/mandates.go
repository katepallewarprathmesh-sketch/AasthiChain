package drunix

// Delegated authority for software agents.
//
// The question an agentic system has to answer before it is allowed near
// money is not "can the model do this task" but "who authorised this actor,
// to spend how much, on what, until when, and how is that revoked". Those
// are not model problems. They are ledger problems, and this file is where
// they are solved.
//
// A MANDATE is a signed, anchored grant from a principal (a human or an
// institution) to an agent:
//
//	principal  originator1
//	agent      agent:rebalancer-1
//	may        SETTLE_DVP, up to ₹50,000 in total, on asset PROP-7 only
//	until      2026-11-01T00:00:00Z
//
// The rail enforces every one of those bounds itself, on the settlement
// path, before anything moves. An agent that exceeds its budget is refused
// by the same code that refuses an unfunded buyer, and the refusal is as
// specific: which bound, and by how much.
//
// Four rules, each of them learned from how this goes wrong elsewhere:
//
//  1. A MANDATE IS A CREDENTIAL. It is issued through the same signing and
//     anchoring path as a title credential, so it can be presented, checked
//     and revoked by anybody with the document and the chain. An authority
//     grant that only our database knows about is not a grant, it is a
//     setting.
//
//  2. SPEND IS ACCUMULATED ON THE LEDGER, NOT TRUSTED FROM THE AGENT. The
//     agent reports nothing about its own consumption. The rail adds up what
//     it actually spent.
//
//  3. REVOCATION IS IMMEDIATE AND IS THE PRINCIPAL'S RIGHT. The principal
//     who granted authority can withdraw it, and so can a supervisor, and
//     the next action is refused. No grace, no in-flight exception.
//
//  4. EVERY AGENT ACTION IS ATTRIBUTED. The block records the agent, the
//     mandate it acted under and the principal it acted for. "The system did
//     it" is not an acceptable audit answer when the system acts on its own.
//
// WHAT IS REAL AND WHAT IS NOT. The mandate, the enforcement, the spend
// accounting, the expiry, the revocation and the audit trail are real and
// run here. There is no AI agent in this repository: nothing autonomous is
// making decisions. This is the authority layer such an actor would need,
// built and tested without pretending the actor exists.

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

// Block types committed by this subsystem.
const (
	BlockMandateGranted = "UMI_MANDATE_GRANTED"
	BlockMandateRevoked = "UMI_MANDATE_REVOKED"
	BlockMandateUsed    = "UMI_MANDATE_USED"
)

// Actions a mandate can authorise. Deliberately a short list: an agent
// cannot be granted authority the rail does not know how to bound.
const (
	ActionSettleDvP    = "SETTLE_DVP"
	ActionPlaceOffer   = "PLACE_OFFER"
	ActionAnchorDoc    = "ANCHOR_DOCUMENT"
	MandateCredential  = CredentialDelegated
	MandateDisclaimer  = "No autonomous agent runs on this deployment. This is the authority a software agent would act under, enforced by the rail."
	mandateMaxLifetime = 365 * 24 * time.Hour
)

var (
	ErrMandateNotFound  = errors.New("mandate not found")
	ErrMandateFields    = errors.New("a mandate needs a principal, an agent, at least one action and a positive limit")
	ErrMandateAction    = errors.New("that action cannot be delegated")
	ErrMandateRevoked   = errors.New("mandate revoked")
	ErrMandateExpired   = errors.New("mandate expired")
	ErrMandateExceeded  = errors.New("mandate spending limit exceeded")
	ErrMandateAssetward = errors.New("mandate does not cover that asset")
)

// Mandate is the grant itself.
type Mandate struct {
	MandateID    string   `json:"mandateId"`
	Principal    string   `json:"principal"`
	Agent        string   `json:"agent"`
	Actions      []string `json:"actions"`
	LimitPaise   int64    `json:"limitPaise"`
	SpentPaise   int64    `json:"spentPaise"`
	Assets       []string `json:"assets,omitempty"`
	ExpiresAt    string   `json:"expiresAt"`
	GrantedAt    string   `json:"grantedAt"`
	GrantedBlock int64    `json:"grantedBlock"`
	Revoked      bool     `json:"revoked"`
	RevokedBy    string   `json:"revokedBy,omitempty"`
	RevokedAt    string   `json:"revokedAt,omitempty"`
	Uses         int64    `json:"uses"`
	CredentialID string   `json:"credentialId,omitempty"`
}

// RemainingPaise is what the agent may still spend under this mandate.
func (m *Mandate) RemainingPaise() int64 {
	if m.SpentPaise >= m.LimitPaise {
		return 0
	}
	return m.LimitPaise - m.SpentPaise
}

// MandateRegistry holds grants and enforces them.
type MandateRegistry struct {
	mu      sync.RWMutex
	byID    map[string]*Mandate
	order   []string
	chain   *DrunixChain
	creds   *CredentialRegistry
	nowFunc func() time.Time
}

// NewMandateRegistry wires the registry to the chain it anchors into and,
// optionally, to the credential registry that signs the grant.
func NewMandateRegistry(chain *DrunixChain, creds *CredentialRegistry) *MandateRegistry {
	return &MandateRegistry{
		byID:    map[string]*Mandate{},
		chain:   chain,
		creds:   creds,
		nowFunc: func() time.Time { return time.Now().UTC() },
	}
}

func (r *MandateRegistry) now() time.Time { return r.nowFunc() }

func knownAction(a string) bool {
	switch strings.ToUpper(strings.TrimSpace(a)) {
	case ActionSettleDvP, ActionPlaceOffer, ActionAnchorDoc:
		return true
	}
	return false
}

// GrantRequest is what a principal sends to delegate authority.
type GrantRequest struct {
	Agent     string   `json:"agent"`
	Actions   []string `json:"actions"`
	LimitINR  float64  `json:"limitINR"`
	Assets    []string `json:"assets"`
	ExpiresIn string   `json:"expiresIn"`
	ExpiresAt string   `json:"expiresAt"`
	Purpose   string   `json:"purpose"`
}

// Grant creates a mandate. The principal is taken from the authenticated
// caller, never from the body: an agent that could name its own principal
// would be granting itself authority.
func (r *MandateRegistry) Grant(principal string, req GrantRequest) (*Mandate, error) {
	principal = strings.TrimSpace(principal)
	agent := strings.TrimSpace(req.Agent)
	if principal == "" || agent == "" || len(req.Actions) == 0 || req.LimitINR <= 0 {
		return nil, ErrMandateFields
	}
	if strings.EqualFold(principal, agent) {
		return nil, fmt.Errorf("%w: a principal cannot delegate to itself", ErrMandateFields)
	}

	actions := make([]string, 0, len(req.Actions))
	for _, a := range req.Actions {
		if !knownAction(a) {
			return nil, fmt.Errorf("%w: %q", ErrMandateAction, a)
		}
		actions = append(actions, strings.ToUpper(strings.TrimSpace(a)))
	}

	// Expiry is mandatory. An open-ended grant to an automated actor is the
	// thing everybody regrets, so there is no way to ask for one: the
	// default is short and the ceiling is a year.
	expiry := r.now().Add(24 * time.Hour)
	switch {
	case strings.TrimSpace(req.ExpiresAt) != "":
		t, err := time.Parse(time.RFC3339, req.ExpiresAt)
		if err != nil {
			return nil, fmt.Errorf("%w: expiresAt must be RFC3339", ErrMandateFields)
		}
		expiry = t.UTC()
	case strings.TrimSpace(req.ExpiresIn) != "":
		d, err := time.ParseDuration(req.ExpiresIn)
		if err != nil || d <= 0 {
			return nil, fmt.Errorf("%w: expiresIn must be a positive duration such as 24h", ErrMandateFields)
		}
		expiry = r.now().Add(d)
	}
	if max := r.now().Add(mandateMaxLifetime); expiry.After(max) {
		expiry = max
	}
	if !expiry.After(r.now()) {
		return nil, fmt.Errorf("%w: expiry is already in the past", ErrMandateFields)
	}

	assets := []string{}
	for _, a := range req.Assets {
		if s := strings.TrimSpace(a); s != "" {
			assets = append(assets, s)
		}
	}

	limit := INRToPaise(req.LimitINR)
	m := &Mandate{
		Principal:  principal,
		Agent:      agent,
		Actions:    actions,
		LimitPaise: limit,
		Assets:     assets,
		ExpiresAt:  expiry.Format(time.RFC3339),
	}

	blk := r.chain.Append(BlockMandateGranted, []map[string]interface{}{{
		"principal":  principal,
		"agent":      agent,
		"actions":    actions,
		"limitPaise": limit,
		"assets":     assets,
		"expiresAt":  m.ExpiresAt,
		"purpose":    strings.TrimSpace(req.Purpose),
		"disclaimer": MandateDisclaimer,
	}})
	m.MandateID = fmt.Sprintf("MANDATE-%d-%s", blk.Height, strings.ToLower(agent))
	m.GrantedAt = blk.Timestamp
	m.GrantedBlock = blk.Height

	// The grant is also issued as a credential, so the agent can present it
	// elsewhere and anyone can check it without asking this rail.
	if r.creds != nil {
		rec, err := r.creds.Issue(principal, MandateCredential, map[string]interface{}{
			"id":         agent,
			"mandateId":  m.MandateID,
			"principal":  principal,
			"actions":    actions,
			"limitPaise": limit,
			"assets":     assets,
			"expiresAt":  m.ExpiresAt,
			"disclaimer": MandateDisclaimer,
		})
		if err == nil && rec != nil {
			m.CredentialID = rec.Credential.ID
		}
	}

	r.mu.Lock()
	r.byID[m.MandateID] = m
	r.order = append(r.order, m.MandateID)
	r.mu.Unlock()
	return m, nil
}

// Get returns a mandate by id.
func (r *MandateRegistry) Get(id string) (*Mandate, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	m, ok := r.byID[id]
	if !ok {
		return nil, ErrMandateNotFound
	}
	return m, nil
}

// List returns mandates, optionally filtered by principal or agent.
func (r *MandateRegistry) List(principal, agent string, limit int) []*Mandate {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	out := []*Mandate{}
	for i := len(r.order) - 1; i >= 0 && len(out) < limit; i-- {
		m := r.byID[r.order[i]]
		if m == nil {
			continue
		}
		if principal != "" && !strings.EqualFold(m.Principal, principal) {
			continue
		}
		if agent != "" && !strings.EqualFold(m.Agent, agent) {
			continue
		}
		out = append(out, m)
	}
	return out
}

// Revoke withdraws authority. Immediate: the next check fails.
func (r *MandateRegistry) Revoke(id, by string) (*Mandate, error) {
	r.mu.Lock()
	m, ok := r.byID[id]
	if !ok {
		r.mu.Unlock()
		return nil, ErrMandateNotFound
	}
	if m.Revoked {
		r.mu.Unlock()
		return nil, ErrMandateRevoked
	}
	r.mu.Unlock()

	blk := r.chain.Append(BlockMandateRevoked, []map[string]interface{}{{
		"mandateId": id,
		"agent":     m.Agent,
		"principal": m.Principal,
		"revokedBy": by,
	}})

	r.mu.Lock()
	m.Revoked = true
	m.RevokedBy = by
	m.RevokedAt = blk.Timestamp
	r.mu.Unlock()

	if r.creds != nil && m.CredentialID != "" {
		_, _ = r.creds.Revoke(m.CredentialID, by, "mandate revoked")
	}
	return m, nil
}

// Authorise checks a proposed action against a mandate without consuming
// anything. Every bound is checked, and the error says which one failed.
func (r *MandateRegistry) Authorise(id, agent, action, assetID string, amountPaise int64) (*Mandate, error) {
	m, err := r.Get(id)
	if err != nil {
		return nil, err
	}
	r.mu.RLock()
	defer r.mu.RUnlock()

	if !strings.EqualFold(m.Agent, agent) {
		return nil, fmt.Errorf("%w: this mandate was granted to %s", ErrMandateNotFound, m.Agent)
	}
	if m.Revoked {
		return nil, fmt.Errorf("%w: withdrawn by %s", ErrMandateRevoked, m.RevokedBy)
	}
	if exp, perr := time.Parse(time.RFC3339, m.ExpiresAt); perr == nil && !r.now().Before(exp) {
		return nil, fmt.Errorf("%w: expired at %s", ErrMandateExpired, m.ExpiresAt)
	}
	allowed := false
	for _, a := range m.Actions {
		if strings.EqualFold(a, action) {
			allowed = true
			break
		}
	}
	if !allowed {
		return nil, fmt.Errorf("%w: %s is not in [%s]", ErrMandateAction, action, strings.Join(m.Actions, " "))
	}
	if len(m.Assets) > 0 && assetID != "" {
		covered := false
		for _, a := range m.Assets {
			if strings.EqualFold(a, assetID) {
				covered = true
				break
			}
		}
		if !covered {
			return nil, fmt.Errorf("%w: %s is limited to [%s]", ErrMandateAssetward, assetID, strings.Join(m.Assets, " "))
		}
	}
	if amountPaise > 0 && m.SpentPaise+amountPaise > m.LimitPaise {
		return nil, fmt.Errorf("%w: %d paise remaining, %d paise requested",
			ErrMandateExceeded, m.RemainingPaise(), amountPaise)
	}
	return m, nil
}

// Consume records that an authorised action actually happened, adds it to
// the mandate's spend and attributes it on the chain.
//
// Spend is counted here rather than taken from the agent's word for it.
func (r *MandateRegistry) Consume(id, action, assetID, reference string, amountPaise int64) error {
	r.mu.Lock()
	m, ok := r.byID[id]
	if !ok {
		r.mu.Unlock()
		return ErrMandateNotFound
	}
	m.SpentPaise += amountPaise
	m.Uses++
	spent, uses, remaining := m.SpentPaise, m.Uses, m.RemainingPaise()
	agent, principal := m.Agent, m.Principal
	r.mu.Unlock()

	r.chain.Append(BlockMandateUsed, []map[string]interface{}{{
		"mandateId":      id,
		"agent":          agent,
		"principal":      principal,
		"action":         action,
		"assetId":        assetID,
		"reference":      reference,
		"amountPaise":    amountPaise,
		"spentPaise":     spent,
		"remainingPaise": remaining,
		"uses":           uses,
	}})
	return nil
}

// RestoreFromChain rebuilds the mandate book after a restart, including how
// much each agent has already spent. A budget that resets on redeploy is not
// a budget.
func (r *MandateRegistry) RestoreFromChain() int {
	if r == nil || r.chain == nil {
		return 0
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	restored := 0
	for _, b := range r.chain.Snapshot() {
		for _, txn := range b.Txns {
			switch b.Type {
			case BlockMandateGranted:
				agent, _ := txn["agent"].(string)
				if agent == "" {
					continue
				}
				id := fmt.Sprintf("MANDATE-%d-%s", b.Height, strings.ToLower(agent))
				if _, seen := r.byID[id]; seen {
					continue
				}
				m := &Mandate{
					MandateID:    id,
					Agent:        agent,
					GrantedAt:    b.Timestamp,
					GrantedBlock: b.Height,
				}
				m.Principal, _ = txn["principal"].(string)
				m.ExpiresAt, _ = txn["expiresAt"].(string)
				m.LimitPaise = asInt64(txn["limitPaise"])
				m.Actions = asStrings(txn["actions"])
				m.Assets = asStrings(txn["assets"])
				r.byID[id] = m
				r.order = append(r.order, id)
				restored++
			case BlockMandateUsed:
				id, _ := txn["mandateId"].(string)
				if m, ok := r.byID[id]; ok {
					m.SpentPaise += asInt64(txn["amountPaise"])
					m.Uses++
				}
			case BlockMandateRevoked:
				id, _ := txn["mandateId"].(string)
				if m, ok := r.byID[id]; ok {
					m.Revoked = true
					m.RevokedBy, _ = txn["revokedBy"].(string)
					m.RevokedAt = b.Timestamp
				}
			}
		}
	}
	return restored
}

// asInt64 reads a number that may have come back from JSON as a float.
func asInt64(v interface{}) int64 {
	switch n := v.(type) {
	case int64:
		return n
	case int:
		return int64(n)
	case float64:
		return int64(n)
	}
	return 0
}

func asStrings(v interface{}) []string {
	switch list := v.(type) {
	case []string:
		return list
	case []interface{}:
		out := make([]string, 0, len(list))
		for _, item := range list {
			if s, ok := item.(string); ok {
				out = append(out, s)
			}
		}
		return out
	}
	return nil
}

// Summary describes the registry for /umi/config and the trust surface.
func (r *MandateRegistry) Summary() map[string]interface{} {
	r.mu.RLock()
	defer r.mu.RUnlock()
	active, revoked := 0, 0
	for _, m := range r.byID {
		if m.Revoked {
			revoked++
			continue
		}
		active++
	}
	return map[string]interface{}{
		"granted":    len(r.order),
		"active":     active,
		"revoked":    revoked,
		"actions":    []string{ActionSettleDvP, ActionPlaceOffer, ActionAnchorDoc},
		"enforcedBy": "the settlement path, before anything moves",
		"disclaimer": MandateDisclaimer,
	}
}
