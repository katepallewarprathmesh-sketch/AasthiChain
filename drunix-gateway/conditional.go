package drunix

// Conditional settlement on the cash leg.
//
// WHY THIS EXISTS
//
// DvP here settles atomically or it fails. That is correct and it is also
// only half of what settlement does in practice. The shape missing from the
// rail was the middle state: cash locked at the point of agreement and
// released only when a named condition is satisfied, where the condition is
// the presentation of a valid credential and the party allowed to present it
// may be an agent acting under a mandate rather than the person themselves.
//
// Three subsystems already existed on their own: credentials (signed,
// anchored, revocable), mandates (bounded agent authority, spend counted on
// the ledger) and escrow (money reserved on a real wallet, never minted).
// This is the join. A conditional settlement is one object that uses all
// three, which is the difference between three demos and one mechanism.
//
// WHAT IS GUARANTEED
//
//   1. Money is reserved, never created. The buyer's paise stay in the
//      buyer's wallet, unspendable, until release or refund. Conservation
//      therefore holds at every instant, including while cash is pending,
//      and the reconciliation check can prove it.
//   2. Release moves both legs in one locked section, exactly as DvP does.
//      A securities leg that cannot complete releases the cash lock and
//      moves nothing.
//   3. A condition cannot strand money. Every condition carries a deadline,
//      Tick refunds anything past it, and the refund is a block.
//   4. A refusal is recorded. Presenting the wrong credential, a revoked
//      one, one from the wrong issuer, or presenting without authority all
//      write UMI_CONDITION_REFUSED and leave the condition open, because a
//      failed attempt is not the same as a cancelled agreement.
//
// WHAT IS SIMULATED
//
// The cash is simulated e₹-W, as everywhere else on this rail: no central
// bank money exists here. The credential is really signed and really
// verified; the fact it attests (a completed inspection, a registrar's
// approval) is asserted by whoever issued it, and this rail cannot check
// the world, only the signature.

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

const (
	// Condition states.
	ConditionOpen     = "OPEN"
	ConditionReleased = "RELEASED"
	ConditionRefunded = "REFUNDED"
	ConditionExpired  = "EXPIRED"

	// Block types.
	BlockConditionOpened   = "UMI_CONDITION_OPENED"
	BlockConditionReleased = "UMI_CONDITION_RELEASED"
	BlockConditionRefused  = "UMI_CONDITION_REFUSED"
	BlockConditionRefunded = "UMI_CONDITION_REFUNDED"

	conditionDefaultWindow = 24 * time.Hour
	conditionMaxWindow     = 30 * 24 * time.Hour
)

var (
	ErrConditionNotFound    = errors.New("ERR_UMI_CONDITION_NOT_FOUND")
	ErrConditionClosed      = errors.New("ERR_UMI_CONDITION_CLOSED")
	ErrConditionFields      = errors.New("ERR_UMI_CONDITION_FIELDS")
	ErrConditionExpired     = errors.New("ERR_UMI_CONDITION_EXPIRED")
	ErrConditionCredential  = errors.New("ERR_UMI_CONDITION_CREDENTIAL")
	ErrConditionNotAsserter = errors.New("ERR_UMI_CONDITION_NOT_ASSERTER")
	ErrConditionNoDesk      = errors.New("ERR_UMI_CONDITION_NO_DESK")
)

// ConditionRequest opens a conditional settlement.
type ConditionRequest struct {
	AssetID          string  `json:"assetId"`
	Seller           string  `json:"seller"`
	Buyer            string  `json:"buyer"`
	Tokens           int64   `json:"tokens"`
	PricePerTokenINR float64 `json:"pricePerTokenINR"`

	// The condition itself: a credential of this type, issued by this
	// issuer, naming this asset. Issuer may be empty to accept any issuer,
	// which is stated on the record rather than left implicit.
	CredentialType string `json:"credentialType"`
	Issuer         string `json:"issuer,omitempty"`

	// Who may present it. Empty means the seller, since the seller is the
	// party with something to prove before being paid.
	Asserter string `json:"asserter,omitempty"`

	// How long the buyer's money stays locked. "24h" by default, 30 days
	// at most: a lock with no end is a way to lose somebody's money.
	Window string `json:"window,omitempty"`
}

// ConditionEvent is one line of the condition's history.
type ConditionEvent struct {
	At      string `json:"at"`
	What    string `json:"what"`
	Who     string `json:"who,omitempty"`
	Detail  string `json:"detail,omitempty"`
	Refusal string `json:"refusal,omitempty"`
}

// Condition is the agreement itself.
type Condition struct {
	ConditionID      string  `json:"conditionId"`
	AssetID          string  `json:"assetId"`
	Seller           string  `json:"seller"`
	Buyer            string  `json:"buyer"`
	Tokens           int64   `json:"tokens"`
	PricePerTokenINR float64 `json:"pricePerTokenINR"`
	CashPaise        int64   `json:"cashPaise"`
	CashINR          float64 `json:"cashINR"`

	CredentialType string `json:"credentialType"`
	Issuer         string `json:"issuer,omitempty"`
	Asserter       string `json:"asserter"`

	Status   string `json:"status"`
	OpenedAt string `json:"openedAt"`
	// Block heights: the agreement and its outcome are both on the chain,
	// so a party can point at the record rather than at this process.
	OpenedBlock   int64  `json:"openedBlock"`
	ReleasedBlock int64  `json:"releasedBlock,omitempty"`
	DeadlineAt    string `json:"deadlineAt"`
	ClosedAt      string `json:"closedAt,omitempty"`

	ReleasedBy     string `json:"releasedBy,omitempty"`
	ReleasedUnder  string `json:"releasedUnderMandate,omitempty"`
	CredentialID   string `json:"credentialId,omitempty"`
	RefusalCount   int    `json:"refusals"`
	LastRefusal    string `json:"lastRefusal,omitempty"`
	SettlementNote string `json:"settlementNote,omitempty"`

	Events []ConditionEvent `json:"events"`

	Mode       string `json:"mode"`
	Disclaimer string `json:"disclaimer"`
	Boundary   string `json:"boundary"`
}

// ConditionDesk holds conditional settlements over the rail's own wallets.
type ConditionDesk struct {
	mu     sync.Mutex
	byID   map[string]*Condition
	order  []string
	seq    uint64
	rail   *UMIRail
	creds  *CredentialRegistry
	grants *MandateRegistry
	now    func() time.Time
}

// NewConditionDesk wires the desk to the rail whose wallets hold the money,
// the credential registry that decides whether the condition was met, and
// the mandate registry that decides whether an agent may say so.
func NewConditionDesk(rail *UMIRail, creds *CredentialRegistry, grants *MandateRegistry) *ConditionDesk {
	return &ConditionDesk{
		byID:   map[string]*Condition{},
		rail:   rail,
		creds:  creds,
		grants: grants,
		now:    func() time.Time { return time.Now().UTC() },
	}
}

func (d *ConditionDesk) nextID() string {
	d.seq++
	return fmt.Sprintf("COND-%s-%04d", d.now().Format("20060102"), d.seq)
}

func (d *ConditionDesk) stamp(c *Condition) {
	c.CashINR = paiseToINR(c.CashPaise)
	c.Mode = UMIMode
	c.Disclaimer = UMIDisclaimer
	c.Boundary = "The cash is simulated e₹-W. The credential is really signed and really verified; whether the thing it attests actually happened is the issuer's assertion, not an observation by this rail."
}

func (d *ConditionDesk) record(c *Condition, what, who, detail, refusal string) {
	c.Events = append(c.Events, ConditionEvent{
		At: d.now().Format(time.RFC3339), What: what, Who: who, Detail: detail, Refusal: refusal,
	})
}

func (d *ConditionDesk) append(blockType string, c *Condition, extra map[string]interface{}) int64 {
	if d.rail == nil || d.rail.chain == nil {
		return 0
	}
	txn := map[string]interface{}{
		"kind":        "umi-condition",
		"conditionId": c.ConditionID,
		"assetId":     c.AssetID,
		"seller":      c.Seller,
		"buyer":       c.Buyer,
		"tokens":      c.Tokens,
		"cashINR":     c.CashINR,
		"status":      c.Status,
		"condition":   c.CredentialType,
		"asserter":    c.Asserter,
	}
	for k, v := range extra {
		txn[k] = v
	}
	if blk := d.rail.chain.Append(blockType, []map[string]interface{}{txn}); blk != nil {
		return blk.Height
	}
	return 0
}

// ---------- open ----------

// Open reserves the buyer's cash and records what has to be proved before it
// moves. Nothing has settled when this returns.
func (d *ConditionDesk) Open(req ConditionRequest, actor string, supervisor bool) (*Condition, error) {
	if d.rail == nil {
		return nil, ErrConditionNoDesk
	}
	if req.AssetID == "" || req.Seller == "" || req.Buyer == "" {
		return nil, fmt.Errorf("%w: assetId, seller and buyer are all required", ErrConditionFields)
	}
	if req.Seller == req.Buyer {
		return nil, fmt.Errorf("%w: a participant cannot settle against itself", ErrConditionFields)
	}
	if req.Tokens <= 0 || req.PricePerTokenINR <= 0 {
		return nil, fmt.Errorf("%w: tokens and pricePerTokenINR must both be positive", ErrConditionFields)
	}
	if strings.TrimSpace(req.CredentialType) == "" {
		return nil, fmt.Errorf("%w: credentialType names what has to be proved, and a condition without one is just a slow settlement", ErrConditionFields)
	}
	// The buyer's money is being locked, so the buyer or a supervisor opens
	// it. Anyone else locking somebody's balance is the whole problem.
	if !supervisor && !strings.EqualFold(actor, req.Buyer) {
		return nil, fmt.Errorf("%w: only %s or a supervisor can lock %s's wallet", ErrConditionNotAsserter, req.Buyer, req.Buyer)
	}

	window, err := parseWindow(req.Window, conditionDefaultWindow, conditionMaxWindow)
	if err != nil {
		return nil, fmt.Errorf("%w: %s", ErrConditionFields, err.Error())
	}

	cashPaise := INRToPaise(float64(req.Tokens) * req.PricePerTokenINR)
	if cashPaise <= 0 {
		return nil, fmt.Errorf("%w: the cash leg rounds to zero", ErrConditionFields)
	}

	// The seller must actually hold what they are agreeing to deliver. This
	// is checked again at release, because a position can move in between.
	if pos := d.rail.securities.Position(req.AssetID, req.Seller); pos < req.Tokens {
		return nil, fmt.Errorf("%w: %s holds %d tokens of %s, the agreement is for %d",
			ErrUMIInsufficientSecurities, req.Seller, pos, req.AssetID, req.Tokens)
	}

	asserter := strings.TrimSpace(req.Asserter)
	if asserter == "" {
		asserter = req.Seller
	}

	now := d.now()
	c := &Condition{
		AssetID:          req.AssetID,
		Seller:           req.Seller,
		Buyer:            req.Buyer,
		Tokens:           req.Tokens,
		PricePerTokenINR: req.PricePerTokenINR,
		CashPaise:        cashPaise,
		CredentialType:   strings.TrimSpace(req.CredentialType),
		Issuer:           strings.TrimSpace(req.Issuer),
		Asserter:         asserter,
		Status:           ConditionOpen,
		OpenedAt:         now.Format(time.RFC3339),
		DeadlineAt:       now.Add(window).Format(time.RFC3339),
	}
	d.stamp(c)

	// Reserve before taking the desk lock so wallet ordering matches the
	// rest of the rail: the rail's mutex is always the inner one.
	if err := d.reserve(req.Buyer, cashPaise); err != nil {
		return nil, err
	}

	d.mu.Lock()
	c.ConditionID = d.nextID()
	d.record(c, "OPENED", actor,
		fmt.Sprintf("₹%.2f reserved on %s's wallet against %s issued by %s.",
			c.CashINR, c.Buyer, c.CredentialType, issuerOrAny(c.Issuer)), "")
	d.byID[c.ConditionID] = c
	d.order = append(d.order, c.ConditionID)
	snapshot := *c
	d.mu.Unlock()

	openedAt := d.append(BlockConditionOpened, &snapshot, map[string]interface{}{
		"deadlineAt": c.DeadlineAt,
		"issuer":     issuerOrAny(c.Issuer),
		"guarantee":  "The money is reserved on the buyer's own wallet, not moved to ours. Nothing is created, and the total in issue is unchanged while it waits.",
	})
	d.mu.Lock()
	if stored := d.byID[c.ConditionID]; stored != nil {
		stored.OpenedBlock = openedAt
	}
	d.mu.Unlock()
	c.OpenedBlock = openedAt
	return c, nil
}

// hasCredentialType reports whether the credential carries the type the
// condition asked for, ignoring case and ignoring position in the list.
func hasCredentialType(types []string, want string) bool {
	for _, t := range types {
		if strings.EqualFold(t, want) {
			return true
		}
	}
	return false
}

func issuerOrAny(s string) string {
	if s == "" {
		return "any issuer"
	}
	return s
}

// ---------- present ----------

// PresentRequest is the attempt to satisfy the condition.
type PresentRequest struct {
	CredentialID string `json:"credentialId"`
	MandateID    string `json:"mandateId,omitempty"`
}

// Present checks the credential and the presenter's authority, and on success
// settles both legs. A refusal is written to the chain and the condition
// stays open.
func (d *ConditionDesk) Present(conditionID string, req PresentRequest, presenter string, supervisor bool) (*Condition, error) {
	d.mu.Lock()
	c, ok := d.byID[conditionID]
	if !ok {
		d.mu.Unlock()
		return nil, ErrConditionNotFound
	}
	if c.Status != ConditionOpen {
		d.mu.Unlock()
		return nil, fmt.Errorf("%w: this condition is %s", ErrConditionClosed, c.Status)
	}
	snapshot := *c
	d.mu.Unlock()

	refuse := func(err error, detail string) (*Condition, error) {
		d.mu.Lock()
		c.RefusalCount++
		c.LastRefusal = detail
		d.record(c, "REFUSED", presenter, detail, err.Error())
		out := *c
		d.mu.Unlock()
		d.append(BlockConditionRefused, &out, map[string]interface{}{
			"refusal":      err.Error(),
			"detail":       detail,
			"presenter":    presenter,
			"credentialId": req.CredentialID,
			"note":         "The agreement is still open. A refusal records an attempt that did not satisfy the condition, which is not the same as the parties walking away.",
		})
		return &out, err
	}

	// Deadline first: an expired condition is refunded, not settled late.
	if deadline, err := time.Parse(time.RFC3339, c.DeadlineAt); err == nil && d.now().After(deadline) {
		d.expire(conditionID, "the deadline passed before the condition was met")
		return nil, fmt.Errorf("%w: the deadline was %s, the money has been returned", ErrConditionExpired, c.DeadlineAt)
	}

	// Authority. Either you are the named asserter, or you hold a mandate
	// from the asserter that covers this action, this asset and this amount.
	var mandateID string
	if !strings.EqualFold(presenter, snapshot.Asserter) {
		if req.MandateID == "" {
			return refuse(ErrConditionNotAsserter,
				fmt.Sprintf("%s is not the named asserter (%s) and presented no mandate", presenter, snapshot.Asserter))
		}
		if d.grants == nil {
			return refuse(ErrConditionNotAsserter, "no mandate registry is wired, so an agent cannot be checked")
		}
		m, err := d.grants.Authorise(req.MandateID, presenter, ActionReleaseCondition, snapshot.AssetID, snapshot.CashPaise)
		if err != nil {
			return refuse(ErrConditionNotAsserter, "mandate refused: "+err.Error())
		}
		if !strings.EqualFold(m.Principal, snapshot.Asserter) {
			return refuse(ErrConditionNotAsserter,
				fmt.Sprintf("mandate %s was granted by %s, but the asserter here is %s", m.MandateID, m.Principal, snapshot.Asserter))
		}
		mandateID = m.MandateID
	}

	// The credential itself.
	if d.creds == nil {
		return refuse(ErrConditionCredential, "no credential registry is wired")
	}
	rec, err := d.creds.Get(req.CredentialID)
	if err != nil {
		return refuse(ErrConditionCredential, "no such credential: "+req.CredentialID)
	}
	ver, err := d.creds.VerifyStored(req.CredentialID)
	if err != nil {
		return refuse(ErrConditionCredential, "verification failed: "+err.Error())
	}
	if ver.Revoked {
		return refuse(ErrConditionCredential, "credential "+req.CredentialID+" has been revoked")
	}
	if !ver.SignatureValid || !ver.AnchorMatches {
		return refuse(ErrConditionCredential, "credential "+req.CredentialID+" does not verify against its anchor")
	}
	// A verifiable credential carries a list of types, the first being the
	// generic "VerifiableCredential". The condition is satisfied if the
	// named type appears anywhere in it.
	if !hasCredentialType(rec.Credential.Type, snapshot.CredentialType) {
		return refuse(ErrConditionCredential,
			fmt.Sprintf("the condition names %s, the credential is %s",
				snapshot.CredentialType, strings.Join(rec.Credential.Type, "+")))
	}
	if snapshot.Issuer != "" && !strings.EqualFold(rec.IssuedBy, snapshot.Issuer) {
		return refuse(ErrConditionCredential,
			fmt.Sprintf("the condition requires an issuer of %s, this one was issued by %s", snapshot.Issuer, rec.IssuedBy))
	}
	// A credential about some other asset proves nothing about this one.
	if asset, ok := rec.Credential.CredentialSubject["assetId"].(string); ok && asset != "" &&
		!strings.EqualFold(asset, snapshot.AssetID) {
		return refuse(ErrConditionCredential,
			fmt.Sprintf("the credential is about %s, this settlement is about %s", asset, snapshot.AssetID))
	}

	// Both legs, one locked section.
	if err := d.settle(&snapshot); err != nil {
		return refuse(err, "the condition was met but settlement could not complete: "+err.Error())
	}

	// The mandate is only charged once the money has actually moved.
	if mandateID != "" {
		_ = d.grants.Consume(mandateID, ActionReleaseCondition, snapshot.AssetID, snapshot.ConditionID, snapshot.CashPaise)
	}

	d.mu.Lock()
	c.Status = ConditionReleased
	c.ClosedAt = d.now().Format(time.RFC3339)
	c.ReleasedBy = presenter
	c.ReleasedUnder = mandateID
	c.CredentialID = req.CredentialID
	c.SettlementNote = fmt.Sprintf("%d tokens of %s moved to %s and ₹%.2f moved to %s in the same step.",
		c.Tokens, c.AssetID, c.Buyer, c.CashINR, c.Seller)
	d.record(c, "RELEASED", presenter, c.SettlementNote, "")
	out := *c
	d.mu.Unlock()

	height := d.append(BlockConditionReleased, &out, map[string]interface{}{
		"credentialId":  req.CredentialID,
		"credentialTy":  strings.Join(rec.Credential.Type, "+"),
		"issuedBy":      rec.IssuedBy,
		"presenter":     presenter,
		"underMandate":  mandateID,
		"bothLegs":      "securities and cash moved in one locked section, as in an unconditional DvP",
		"whatWasProved": "a credential of the named type, verified against its anchor and not revoked",
	})
	d.mu.Lock()
	if stored := d.byID[c.ConditionID]; stored != nil {
		stored.ReleasedBlock = height
	}
	d.mu.Unlock()
	out.ReleasedBlock = height
	return &out, nil
}

// settle moves both legs. Mirrors SettleDvP's commit: securities first, and
// if they cannot move, the cash lock is released and nothing happens.
func (d *ConditionDesk) settle(c *Condition) error {
	r := d.rail
	if r == nil {
		return ErrConditionNoDesk
	}
	r.mu.Lock()
	buyer := r.walletLocked(c.Buyer)
	seller := r.walletLocked(c.Seller)
	if buyer.BalancePaise < c.CashPaise {
		r.mu.Unlock()
		return ErrUMIInsufficientCBDC
	}
	if err := r.securities.Move(c.AssetID, c.Seller, c.Buyer, c.Tokens); err != nil {
		// Release the lock: the buyer should not keep money frozen against
		// a delivery the seller can no longer make.
		buyer.ReservedPaise -= c.CashPaise
		if buyer.ReservedPaise < 0 {
			buyer.ReservedPaise = 0
		}
		buyer.refresh()
		snap := r.snapWallet(buyer)
		r.mu.Unlock()
		r.pWallet(snap)
		return fmt.Errorf("%w: %s", ErrUMIInsufficientSecurities, err.Error())
	}
	buyer.ReservedPaise -= c.CashPaise
	if buyer.ReservedPaise < 0 {
		buyer.ReservedPaise = 0
	}
	buyer.BalancePaise -= c.CashPaise
	seller.BalancePaise += c.CashPaise
	buyer.refresh()
	seller.refresh()
	bs, ss := r.snapWallet(buyer), r.snapWallet(seller)
	pos := r.snapPositions(c.AssetID, c.Seller, c.Buyer)
	r.mu.Unlock()

	r.RecordOwnership(c.AssetID, c.Seller, r.securities.Position(c.AssetID, c.Seller), "CONDITION_RELEASED")
	r.RecordOwnership(c.AssetID, c.Buyer, r.securities.Position(c.AssetID, c.Buyer), "CONDITION_RELEASED")
	r.pWallet(bs)
	r.pWallet(ss)
	r.pPosition(pos)
	return nil
}

func (d *ConditionDesk) reserve(participant string, paise int64) error {
	r := d.rail
	r.mu.Lock()
	w := r.walletLocked(participant)
	if w.available() < paise {
		short := paise - w.available()
		r.mu.Unlock()
		return fmt.Errorf("%w: short by ₹%.2f (available ₹%.2f)",
			ErrUMIInsufficientCBDC, paiseToINR(short), paiseToINR(w.available()))
	}
	w.ReservedPaise += paise
	w.refresh()
	snap := r.snapWallet(w)
	r.mu.Unlock()
	r.pWallet(snap)
	return nil
}

func (d *ConditionDesk) unreserve(participant string, paise int64) {
	r := d.rail
	r.mu.Lock()
	w := r.walletLocked(participant)
	w.ReservedPaise -= paise
	if w.ReservedPaise < 0 {
		w.ReservedPaise = 0
	}
	w.refresh()
	snap := r.snapWallet(w)
	r.mu.Unlock()
	r.pWallet(snap)
}

// ---------- ending it without a release ----------

// Cancel returns the money early. Either party can walk away before the
// condition is met, and a supervisor can end it for them.
func (d *ConditionDesk) Cancel(conditionID, actor string, supervisor bool) (*Condition, error) {
	d.mu.Lock()
	c, ok := d.byID[conditionID]
	if !ok {
		d.mu.Unlock()
		return nil, ErrConditionNotFound
	}
	if c.Status != ConditionOpen {
		d.mu.Unlock()
		return nil, fmt.Errorf("%w: this condition is %s", ErrConditionClosed, c.Status)
	}
	if !supervisor && !strings.EqualFold(actor, c.Buyer) && !strings.EqualFold(actor, c.Seller) {
		d.mu.Unlock()
		return nil, fmt.Errorf("%w: only %s, %s or a supervisor can end this", ErrConditionNotAsserter, c.Buyer, c.Seller)
	}
	buyer, paise := c.Buyer, c.CashPaise
	d.mu.Unlock()

	d.unreserve(buyer, paise)

	d.mu.Lock()
	c.Status = ConditionRefunded
	c.ClosedAt = d.now().Format(time.RFC3339)
	d.record(c, "REFUNDED", actor, fmt.Sprintf("₹%.2f released back to %s. Neither leg moved.", c.CashINR, c.Buyer), "")
	out := *c
	d.mu.Unlock()

	d.append(BlockConditionRefunded, &out, map[string]interface{}{
		"endedBy": actor,
		"reason":  "cancelled before the condition was met",
		"note":    "The reservation is lifted. The buyer's balance was never debited, so there is nothing to credit back.",
	})
	return &out, nil
}

func (d *ConditionDesk) expire(conditionID, reason string) {
	d.mu.Lock()
	c, ok := d.byID[conditionID]
	if !ok || c.Status != ConditionOpen {
		d.mu.Unlock()
		return
	}
	buyer, paise := c.Buyer, c.CashPaise
	d.mu.Unlock()

	d.unreserve(buyer, paise)

	d.mu.Lock()
	c.Status = ConditionExpired
	c.ClosedAt = d.now().Format(time.RFC3339)
	d.record(c, "EXPIRED", "rail", reason, "")
	out := *c
	d.mu.Unlock()

	d.append(BlockConditionRefunded, &out, map[string]interface{}{
		"endedBy": "rail",
		"reason":  reason,
		"note":    "A deadline that is not enforced is a way to lose somebody's money. This runs without anyone asking.",
	})
}

// Tick refunds every condition whose deadline has passed. Returns the ids it
// closed. Safe to call as often as you like.
func (d *ConditionDesk) Tick(now time.Time) []string {
	if d == nil || d.rail == nil {
		return nil
	}
	d.mu.Lock()
	var due []string
	for _, id := range d.order {
		c := d.byID[id]
		if c == nil || c.Status != ConditionOpen {
			continue
		}
		if deadline, err := time.Parse(time.RFC3339, c.DeadlineAt); err == nil && now.After(deadline) {
			due = append(due, id)
		}
	}
	d.mu.Unlock()

	for _, id := range due {
		d.expire(id, "the deadline passed before the condition was met")
	}
	return due
}

// ---------- reading ----------

// Get returns one condition.
func (d *ConditionDesk) Get(id string) (*Condition, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	c, ok := d.byID[id]
	if !ok {
		return nil, ErrConditionNotFound
	}
	out := *c
	return &out, nil
}

// List returns conditions newest first, optionally filtered by participant.
func (d *ConditionDesk) List(participant string, limit int) []*Condition {
	d.mu.Lock()
	defer d.mu.Unlock()
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	out := []*Condition{}
	for i := len(d.order) - 1; i >= 0 && len(out) < limit; i-- {
		c := d.byID[d.order[i]]
		if c == nil {
			continue
		}
		if participant != "" &&
			!strings.EqualFold(participant, c.Buyer) &&
			!strings.EqualFold(participant, c.Seller) &&
			!strings.EqualFold(participant, c.Asserter) {
			continue
		}
		copied := *c
		out = append(out, &copied)
	}
	return out
}

// Summary is what the screen reads: the counts, the money currently locked,
// and the statement of conservation while it is locked.
func (d *ConditionDesk) Summary() map[string]interface{} {
	d.mu.Lock()
	defer d.mu.Unlock()
	var open, released, refunded, expired, refusals int
	var lockedPaise int64
	for _, id := range d.order {
		c := d.byID[id]
		if c == nil {
			continue
		}
		refusals += c.RefusalCount
		switch c.Status {
		case ConditionOpen:
			open++
			lockedPaise += c.CashPaise
		case ConditionReleased:
			released++
		case ConditionRefunded:
			refunded++
		case ConditionExpired:
			expired++
		}
	}
	return map[string]interface{}{
		"open":            open,
		"released":        released,
		"refunded":        refunded,
		"expired":         expired,
		"refusals":        refusals,
		"lockedPaise":     lockedPaise,
		"lockedINR":       paiseToINR(lockedPaise),
		"action":          ActionReleaseCondition,
		"defaultWindow":   conditionDefaultWindow.String(),
		"maxWindow":       conditionMaxWindow.String(),
		"conservation":    "Locked cash is reserved inside the buyer's own wallet, so the money identity holds while a condition is pending: nothing is issued, moved or held off-ledger.",
		"mode":            UMIMode,
		"disclaimer":      UMIDisclaimer,
		"whatIsSimulated": "The cash leg is simulated e₹-W. The credential is really signed and really verified; whether the thing it attests happened in the world is the issuer's assertion.",
	}
}
