package drunix

// Work orders — escrowed property work, paid on accepted delivery.
//
// Why this exists: AasthiChain settles the TRADE atomically (umi.go) but never
// modelled the COST OF KEEPING THE ASSET REAL — inspections, repairs,
// revaluation, title re-verification. That work happens off-ledger today, on
// trust, against an invoice nobody can audit.
//
// It is the same problem DvP solved, with labour in place of a security: two
// things that must happen together (work delivered, money paid) and no honest
// way to make them simultaneous. So the answer is the same shape. The fee is
// RESERVED on the funder's e₹-W wallet when the order is funded, and it moves
// to the worker in the same locked section that records the deliverable's hash
// on the chain. There is no observable state where one happened and not the
// other.
//
// The idea is the one gig-work marketplaces are built on: a contract links
// pay to task completion. This is that idea implemented against our ledger.
// The boundary to whoever supplies the worker is a thin adapter
// (talentprovider.go), and escrow, state and evidence stay here.
//
// Design rules, same as the rail:
//   - money is int64 PAISE, reserved-then-transferred, never minted
//   - one mutex (the rail's) guards wallets, so escrow and settlement cannot
//     race each other over the same balance
//   - every transition appends a block, which is also how the desk restores
//     itself at boot — no new table, and it cannot drift from the audit trail
//   - nothing here modifies existing behaviour; it is additive

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

// ---------- constants ----------

const (
	// WorkContract is the contract name written into work blocks.
	WorkContract = "aasthi.work-escrow-v1"

	WorkStatusCreated   = "CREATED"
	WorkStatusFunded    = "FUNDED"
	WorkStatusAssigned  = "ASSIGNED"
	WorkStatusSubmitted = "SUBMITTED"
	WorkStatusAccepted  = "ACCEPTED"
	WorkStatusDisputed  = "DISPUTED"
	WorkStatusRefunded  = "REFUNDED"
	WorkStatusCancelled = "CANCELLED"

	BlockWorkCreated   = "WORK_CREATED"
	BlockWorkFunded    = "WORK_FUNDED"
	BlockWorkAssigned  = "WORK_ASSIGNED"
	BlockWorkSubmitted = "WORK_SUBMITTED"
	BlockWorkAccepted  = "WORK_ACCEPTED"
	BlockWorkDisputed  = "WORK_DISPUTED"
	BlockWorkRefunded  = "WORK_REFUNDED"
	BlockWorkCancelled = "WORK_CANCELLED"
)

// WorkCategories are the kinds of upkeep a tokenised property actually needs.
var WorkCategories = []string{
	"INSPECTION",
	"REPAIR",
	"VALUATION",
	"TITLE_VERIFICATION",
	"PHOTOGRAPHY",
	"LEGAL_REVIEW",
	"OTHER",
}

// Machine-readable refusals surfaced to the UI.
var (
	ErrWorkNotFound      = errors.New("ERR_WORK_NOT_FOUND")
	ErrWorkBadState      = errors.New("ERR_WORK_BAD_STATE")
	ErrWorkInvalidAmount = errors.New("ERR_WORK_INVALID_AMOUNT")
	ErrWorkMissingField  = errors.New("ERR_WORK_MISSING_FIELD")
	ErrWorkNoEscrow      = errors.New("ERR_WORK_NO_ESCROW")
	ErrWorkSelfDeal      = errors.New("ERR_WORK_SELF_DEAL")
	ErrWorkBadCategory   = errors.New("ERR_WORK_BAD_CATEGORY")
	ErrWorkBadHash       = errors.New("ERR_WORK_BAD_HASH")
)

// ---------- model ----------

// WorkEvent is one entry in an order's audit trail.
type WorkEvent struct {
	Seq       int       `json:"seq"`
	Status    string    `json:"status"`
	Actor     string    `json:"actor"`
	Detail    string    `json:"detail"`
	Timestamp time.Time `json:"timestamp"`
}

// WorkOrder is one defined piece of work with a fee escrowed against it.
type WorkOrder struct {
	OrderID  string `json:"orderId"`
	AssetID  string `json:"assetId"`
	Title    string `json:"title"`
	Spec     string `json:"spec"`
	Category string `json:"category"`

	// Funder pays; Worker delivers. Both are rail participants, so the fee
	// settles between two e₹-W wallets exactly like any other transfer.
	Funder string `json:"funder"`
	Worker string `json:"worker,omitempty"`

	FeePaise int64   `json:"feePaise"`
	FeeINR   float64 `json:"feeINR"`

	Status             string   `json:"status"`
	AcceptanceCriteria []string `json:"acceptanceCriteria"`

	// Evidence. The hash is the reason this module is worth building: the
	// report handed over today can be re-hashed in five years and checked
	// against a block nobody can rewrite.
	DeliverableHash string `json:"deliverableHash,omitempty"`
	DeliverableURI  string `json:"deliverableUri,omitempty"`

	Provider     string `json:"provider"`
	ProviderRef  string `json:"providerRef,omitempty"`
	ProviderMode string `json:"providerMode"`

	Reason string `json:"reason,omitempty"`

	Events      []WorkEvent `json:"events"`
	BlockHeight int64       `json:"blockHeight,omitempty"`
	BlockHash   string      `json:"blockHash,omitempty"`

	CreatedAt time.Time  `json:"createdAt"`
	UpdatedAt time.Time  `json:"updatedAt"`
	SettledAt *time.Time `json:"settledAt,omitempty"`

	Escrowed   bool   `json:"escrowed"`
	Mode       string `json:"mode"`
	Disclaimer string `json:"disclaimer"`
}

// party reports whether an identity is one of the two sides of the order.
func (o *WorkOrder) party(id string) bool {
	return id != "" && (strings.EqualFold(o.Funder, id) || strings.EqualFold(o.Worker, id))
}

func (o *WorkOrder) event(status, actor, detail string) {
	o.Events = append(o.Events, WorkEvent{
		Seq:       len(o.Events) + 1,
		Status:    status,
		Actor:     actor,
		Detail:    detail,
		Timestamp: time.Now().UTC(),
	})
	o.Status = status
	o.UpdatedAt = time.Now().UTC()
}

// legalWorkTransitions is the whole state machine. A transition absent from
// this table is refused: the engine never infers intent from a bare status
// write.
var legalWorkTransitions = map[string][]string{
	WorkStatusCreated:   {WorkStatusFunded, WorkStatusCancelled},
	WorkStatusFunded:    {WorkStatusAssigned, WorkStatusRefunded, WorkStatusCancelled},
	WorkStatusAssigned:  {WorkStatusSubmitted, WorkStatusDisputed, WorkStatusRefunded},
	WorkStatusSubmitted: {WorkStatusAccepted, WorkStatusDisputed},
	WorkStatusDisputed:  {WorkStatusAccepted, WorkStatusRefunded},
}

func canMove(from, to string) bool {
	for _, s := range legalWorkTransitions[from] {
		if s == to {
			return true
		}
	}
	return false
}

// ---------- the desk ----------

// WorkDesk holds the open and historic work orders. It borrows the rail's
// wallets for escrow rather than keeping a cash book of its own, which is what
// keeps conservation true without a reconciliation between two sets of books.
type WorkDesk struct {
	mu       sync.Mutex
	orders   map[string]*WorkOrder
	order    []string // ids, oldest first
	seq      uint64
	rail     *UMIRail
	provider TalentProvider
}

// NewWorkDesk builds a desk over an existing rail.
func NewWorkDesk(rail *UMIRail, provider TalentProvider) *WorkDesk {
	if provider == nil {
		provider = NewWorkProvider()
	}
	return &WorkDesk{
		orders:   make(map[string]*WorkOrder),
		rail:     rail,
		provider: provider,
	}
}

// Provider exposes the talent adapter (for /umi/work/provider).
func (d *WorkDesk) Provider() TalentProvider { return d.provider }

func (d *WorkDesk) nextID() string {
	d.seq++
	return fmt.Sprintf("WORK-%s-%04d", time.Now().UTC().Format("20060102"), d.seq)
}

func (d *WorkDesk) stamp(o *WorkOrder) {
	o.FeeINR = paiseToINR(o.FeePaise)
	o.Mode = UMIMode
	o.Disclaimer = UMIDisclaimer
	o.Provider = d.provider.Name()
	o.ProviderMode = d.provider.Mode()
}

func (d *WorkDesk) append(blockType string, o *WorkOrder, extra map[string]interface{}) {
	if d.rail == nil || d.rail.chain == nil {
		return
	}
	txn := map[string]interface{}{
		"kind":      "work-escrow",
		"contract":  WorkContract,
		"orderId":   o.OrderID,
		"assetId":   o.AssetID,
		"title":     o.Title,
		"category":  o.Category,
		"funder":    o.Funder,
		"worker":    o.Worker,
		"feeINR":    o.FeeINR,
		"status":    o.Status,
		"provider":  o.Provider,
		"createdAt": o.CreatedAt.Format(time.RFC3339Nano),
	}
	for k, v := range extra {
		txn[k] = v
	}
	if blk := d.rail.chain.Append(blockType, []map[string]interface{}{txn}); blk != nil {
		o.BlockHeight = blk.Height
		o.BlockHash = blk.Hash
	}
}

func (d *WorkDesk) snap(o *WorkOrder) WorkOrder {
	cp := *o
	cp.AcceptanceCriteria = append([]string(nil), o.AcceptanceCriteria...)
	cp.Events = append([]WorkEvent(nil), o.Events...)
	return cp
}

// ---------- escrow against the rail's wallets ----------
//
// reserve/release/settle are the only places this file touches money, and each
// one takes the rail's mutex so an escrow can never interleave with a DvP over
// the same wallet. Note what is NOT here: there is no credit path that creates
// paise. Acceptance moves an existing balance between two wallets; everything
// else only moves the reservation.

func (d *WorkDesk) reserve(participant string, paise int64) error {
	if d.rail == nil {
		return ErrWorkNoEscrow
	}
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

func (d *WorkDesk) unreserve(participant string, paise int64) {
	if d.rail == nil {
		return
	}
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

// settleEscrow releases the reservation and moves the fee to the worker in one
// locked section. Conservation holds by construction: the same paise leave one
// wallet and arrive in the other.
func (d *WorkDesk) settleEscrow(funder, worker string, paise int64) error {
	if d.rail == nil {
		return ErrWorkNoEscrow
	}
	r := d.rail
	r.mu.Lock()
	fw := r.walletLocked(funder)
	ww := r.walletLocked(worker)
	if fw.BalancePaise < paise {
		r.mu.Unlock()
		return ErrUMIInsufficientCBDC
	}
	fw.ReservedPaise -= paise
	if fw.ReservedPaise < 0 {
		fw.ReservedPaise = 0
	}
	fw.BalancePaise -= paise
	ww.BalancePaise += paise
	fw.refresh()
	ww.refresh()
	fs, ws := r.snapWallet(fw), r.snapWallet(ww)
	r.mu.Unlock()
	r.pWallet(fs)
	r.pWallet(ws)
	return nil
}

// ---------- operations ----------

// WorkRequest creates an order.
type WorkRequest struct {
	AssetID            string   `json:"assetId"`
	Title              string   `json:"title"`
	Spec               string   `json:"spec"`
	Category           string   `json:"category"`
	Funder             string   `json:"funder"`
	FeeINR             float64  `json:"feeINR"`
	AcceptanceCriteria []string `json:"acceptanceCriteria"`
}

// Create opens a work order. No money moves yet — CREATED is a statement of
// intent, and a funder who never funds it has escrowed nothing.
func (d *WorkDesk) Create(req WorkRequest, actor string) (*WorkOrder, error) {
	title := strings.TrimSpace(req.Title)
	funder := strings.TrimSpace(req.Funder)
	if title == "" || funder == "" || strings.TrimSpace(req.AssetID) == "" {
		return nil, fmt.Errorf("%w: assetId, title and funder are required", ErrWorkMissingField)
	}
	cat := strings.ToUpper(strings.TrimSpace(req.Category))
	if cat == "" {
		cat = "OTHER"
	}
	if !validCategory(cat) {
		return nil, fmt.Errorf("%w: %s is not one of %s", ErrWorkBadCategory, cat, strings.Join(WorkCategories, ", "))
	}
	paise := INRToPaise(req.FeeINR)
	if paise <= 0 {
		return nil, fmt.Errorf("%w: the fee must be greater than zero", ErrWorkInvalidAmount)
	}

	d.mu.Lock()
	defer d.mu.Unlock()
	now := time.Now().UTC()
	o := &WorkOrder{
		OrderID:            d.nextID(),
		AssetID:            strings.TrimSpace(req.AssetID),
		Title:              title,
		Spec:               strings.TrimSpace(req.Spec),
		Category:           cat,
		Funder:             funder,
		FeePaise:           paise,
		AcceptanceCriteria: trimmedList(req.AcceptanceCriteria),
		CreatedAt:          now,
		UpdatedAt:          now,
	}
	d.stamp(o)
	o.event(WorkStatusCreated, actor, "Work order opened against "+o.AssetID+".")
	d.orders[o.OrderID] = o
	d.order = append(d.order, o.OrderID)
	d.append(BlockWorkCreated, o, map[string]interface{}{
		"spec":               o.Spec,
		"acceptanceCriteria": o.AcceptanceCriteria,
	})
	out := d.snap(o)
	return &out, nil
}

// Fund reserves the fee on the funder's wallet. From here the money is real:
// it still belongs to the funder but they can no longer spend it elsewhere,
// which is exactly what makes the promise to the worker worth anything.
func (d *WorkDesk) Fund(orderID, actor string) (*WorkOrder, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	o, err := d.mustFind(orderID)
	if err != nil {
		return nil, err
	}
	if !canMove(o.Status, WorkStatusFunded) {
		return nil, badState(o, WorkStatusFunded)
	}
	if err := d.reserve(o.Funder, o.FeePaise); err != nil {
		return nil, err
	}
	o.Escrowed = true
	o.event(WorkStatusFunded, actor,
		fmt.Sprintf("₹%.2f reserved on %s's e₹-W wallet and held against delivery.", o.FeeINR, o.Funder))
	d.append(BlockWorkFunded, o, map[string]interface{}{"escrowINR": o.FeeINR})
	out := d.snap(o)
	return &out, nil
}

// Assign names the worker who will deliver, optionally carrying the partner's
// own reference for the engagement.
func (d *WorkDesk) Assign(orderID, worker, providerRef, actor string) (*WorkOrder, error) {
	worker = strings.TrimSpace(worker)
	if worker == "" {
		return nil, fmt.Errorf("%w: worker is required", ErrWorkMissingField)
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	o, err := d.mustFind(orderID)
	if err != nil {
		return nil, err
	}
	if !canMove(o.Status, WorkStatusAssigned) {
		return nil, badState(o, WorkStatusAssigned)
	}
	// Paying yourself out of escrow you control is not a contract, it is a
	// withdrawal with extra steps.
	if strings.EqualFold(worker, o.Funder) {
		return nil, fmt.Errorf("%w: the funder cannot also be the worker", ErrWorkSelfDeal)
	}
	o.Worker = worker
	o.ProviderRef = strings.TrimSpace(providerRef)
	o.event(WorkStatusAssigned, actor, worker+" accepted the engagement.")
	d.append(BlockWorkAssigned, o, map[string]interface{}{"providerRef": o.ProviderRef})
	out := d.snap(o)
	return &out, nil
}

// Submit records the deliverable. The hash is mandatory: a submission with no
// evidence is just a claim, and the whole point of the module is that the
// claim and the payment are backed by the same block.
func (d *WorkDesk) Submit(orderID, hash, uri, note, actor string) (*WorkOrder, error) {
	hash = strings.ToLower(strings.TrimSpace(hash))
	if !looksLikeSHA256(hash) {
		return nil, fmt.Errorf("%w: deliverableHash must be a 64-character hex SHA-256", ErrWorkBadHash)
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	o, err := d.mustFind(orderID)
	if err != nil {
		return nil, err
	}
	if !canMove(o.Status, WorkStatusSubmitted) {
		return nil, badState(o, WorkStatusSubmitted)
	}
	o.DeliverableHash = hash
	o.DeliverableURI = strings.TrimSpace(uri)
	detail := "Deliverable submitted and anchored."
	if strings.TrimSpace(note) != "" {
		detail = strings.TrimSpace(note)
	}
	o.event(WorkStatusSubmitted, actor, detail)
	d.append(BlockWorkSubmitted, o, map[string]interface{}{
		"deliverableHash": o.DeliverableHash,
		"deliverableUri":  o.DeliverableURI,
		"note":            strings.TrimSpace(note),
	})
	out := d.snap(o)
	return &out, nil
}

// Accept releases the escrow to the worker. This is the atomic moment: the
// money moves and the acceptance block is written with the deliverable's hash
// on it.
func (d *WorkDesk) Accept(orderID, note, actor string) (*WorkOrder, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	o, err := d.mustFind(orderID)
	if err != nil {
		return nil, err
	}
	if !canMove(o.Status, WorkStatusAccepted) {
		return nil, badState(o, WorkStatusAccepted)
	}
	if o.DeliverableHash == "" {
		return nil, fmt.Errorf("%w: nothing has been delivered to accept", ErrWorkBadState)
	}
	if err := d.settleEscrow(o.Funder, o.Worker, o.FeePaise); err != nil {
		return nil, err
	}
	o.Escrowed = false
	now := time.Now().UTC()
	o.SettledAt = &now
	detail := fmt.Sprintf("Accepted; ₹%.2f released to %s.", o.FeeINR, o.Worker)
	if strings.TrimSpace(note) != "" {
		detail += " " + strings.TrimSpace(note)
	}
	o.event(WorkStatusAccepted, actor, detail)
	d.append(BlockWorkAccepted, o, map[string]interface{}{
		"deliverableHash": o.DeliverableHash,
		"paidINR":         o.FeeINR,
		"paidTo":          o.Worker,
		"atomic":          "deliverable hash and fee release commit in one block",
	})
	out := d.snap(o)
	return &out, nil
}

// Dispute parks the escrow. It deliberately does not decide anything — it
// records that the parties disagree, keeps the money frozen, and waits for a
// human.
func (d *WorkDesk) Dispute(orderID, reason, actor string) (*WorkOrder, error) {
	if strings.TrimSpace(reason) == "" {
		return nil, fmt.Errorf("%w: a dispute needs a reason", ErrWorkMissingField)
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	o, err := d.mustFind(orderID)
	if err != nil {
		return nil, err
	}
	if !canMove(o.Status, WorkStatusDisputed) {
		return nil, badState(o, WorkStatusDisputed)
	}
	o.Reason = strings.TrimSpace(reason)
	o.event(WorkStatusDisputed, actor, "Disputed: "+o.Reason+" Escrow stays frozen.")
	d.append(BlockWorkDisputed, o, map[string]interface{}{"reason": o.Reason})
	out := d.snap(o)
	return &out, nil
}

// Refund returns the escrow to the funder.
func (d *WorkDesk) Refund(orderID, reason, actor string) (*WorkOrder, error) {
	return d.unwind(orderID, reason, actor, WorkStatusRefunded, BlockWorkRefunded)
}

// Cancel closes an order that never got going.
func (d *WorkDesk) Cancel(orderID, reason, actor string) (*WorkOrder, error) {
	return d.unwind(orderID, reason, actor, WorkStatusCancelled, BlockWorkCancelled)
}

func (d *WorkDesk) unwind(orderID, reason, actor, status, blockType string) (*WorkOrder, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	o, err := d.mustFind(orderID)
	if err != nil {
		return nil, err
	}
	if !canMove(o.Status, status) {
		return nil, badState(o, status)
	}
	if o.Escrowed {
		d.unreserve(o.Funder, o.FeePaise)
		o.Escrowed = false
	}
	o.Reason = strings.TrimSpace(reason)
	detail := strings.ToLower(status) + "."
	if o.Reason != "" {
		detail = o.Reason
	}
	if status == WorkStatusRefunded {
		detail = fmt.Sprintf("₹%.2f released back to %s. %s", o.FeeINR, o.Funder, detail)
	}
	o.event(status, actor, detail)
	d.append(blockType, o, map[string]interface{}{"reason": o.Reason, "releasedINR": o.FeeINR})
	out := d.snap(o)
	return &out, nil
}

// ---------- reads ----------

// Order returns one order.
func (d *WorkDesk) Order(orderID string) (*WorkOrder, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	o, ok := d.orders[orderID]
	if !ok {
		return nil, false
	}
	out := d.snap(o)
	return &out, true
}

// Orders returns the desk, newest first, optionally filtered to one asset.
func (d *WorkDesk) Orders(assetID string) []WorkOrder {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := make([]WorkOrder, 0, len(d.order))
	for _, id := range d.order {
		o := d.orders[id]
		if assetID != "" && !strings.EqualFold(o.AssetID, assetID) {
			continue
		}
		out = append(out, d.snap(o))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out
}

// Summary is the desk at a glance, for the UI and for reconciliation.
func (d *WorkDesk) Summary() map[string]interface{} {
	d.mu.Lock()
	defer d.mu.Unlock()
	byStatus := map[string]int{}
	var escrowPaise, paidPaise int64
	for _, o := range d.orders {
		byStatus[o.Status]++
		if o.Escrowed {
			escrowPaise += o.FeePaise
		}
		if o.Status == WorkStatusAccepted {
			paidPaise += o.FeePaise
		}
	}
	return map[string]interface{}{
		"orders":       len(d.orders),
		"byStatus":     byStatus,
		"inEscrowINR":  paiseToINR(escrowPaise),
		"paidOutINR":   paiseToINR(paidPaise),
		"provider":     d.provider.Name(),
		"providerMode": d.provider.Mode(),
		"categories":   WorkCategories,
		"states":       []string{WorkStatusCreated, WorkStatusFunded, WorkStatusAssigned, WorkStatusSubmitted, WorkStatusAccepted, WorkStatusDisputed, WorkStatusRefunded, WorkStatusCancelled},
		"contract":     WorkContract,
		"mode":         UMIMode,
		"disclaimer":   UMIDisclaimer,
		"guarantee":    "The fee leaves the funder's wallet in the same locked step that anchors the deliverable's hash. Before acceptance the money is reserved and unspendable; after it, the evidence is on the chain.",
	}
}

// ---------- restore ----------

// RestoreWorkFromChain rebuilds the desk by replaying WORK_* blocks.
//
// The chain is already durable and already append-only, so it is a better
// source of truth for this than a second table would be: a restored desk
// cannot disagree with the audit trail, because it IS the audit trail. Wallet
// reservations are re-applied for orders that were still holding escrow when
// the process stopped.
func (d *WorkDesk) RestoreWorkFromChain() int {
	if d.rail == nil || d.rail.chain == nil {
		return 0
	}
	blocks := d.rail.chain.Snapshot()
	d.mu.Lock()
	defer d.mu.Unlock()
	restored := 0
	for _, b := range blocks {
		if !strings.HasPrefix(b.Type, "WORK_") {
			continue
		}
		for _, txn := range b.Txns {
			id, _ := txn["orderId"].(string)
			if id == "" {
				continue
			}
			o, ok := d.orders[id]
			if !ok {
				o = &WorkOrder{OrderID: id, CreatedAt: parseWorkTime(txn["createdAt"])}
				d.orders[id] = o
				d.order = append(d.order, id)
				restored++
			}
			applyWorkTxn(o, b.Type, txn)
			d.stamp(o)
		}
	}
	// Re-apply live escrow so a restarted process does not let a funder spend
	// money that is still promised to a worker.
	for _, o := range d.orders {
		if o.Escrowed && o.FeePaise > 0 {
			_ = d.reserve(o.Funder, o.FeePaise)
		}
		if n := len(o.Events); n > 0 {
			o.UpdatedAt = o.Events[n-1].Timestamp
		}
	}
	return restored
}

func applyWorkTxn(o *WorkOrder, blockType string, txn map[string]interface{}) {
	str := func(k string) string { s, _ := txn[k].(string); return s }
	if v := str("assetId"); v != "" {
		o.AssetID = v
	}
	if v := str("title"); v != "" {
		o.Title = v
	}
	if v := str("category"); v != "" {
		o.Category = v
	}
	if v := str("funder"); v != "" {
		o.Funder = v
	}
	if v := str("worker"); v != "" {
		o.Worker = v
	}
	if v := str("spec"); v != "" {
		o.Spec = v
	}
	if v := str("providerRef"); v != "" {
		o.ProviderRef = v
	}
	if v := str("deliverableHash"); v != "" {
		o.DeliverableHash = v
	}
	if v := str("deliverableUri"); v != "" {
		o.DeliverableURI = v
	}
	if v := str("reason"); v != "" {
		o.Reason = v
	}
	if f, ok := txn["feeINR"].(float64); ok && f > 0 {
		o.FeePaise = INRToPaise(f)
	}
	if list, ok := txn["acceptanceCriteria"].([]interface{}); ok {
		for _, it := range list {
			if s, ok := it.(string); ok {
				o.AcceptanceCriteria = append(o.AcceptanceCriteria, s)
			}
		}
	}
	if v := str("status"); v != "" {
		o.Status = v
	}
	switch blockType {
	case BlockWorkFunded:
		o.Escrowed = true
	case BlockWorkAccepted, BlockWorkRefunded, BlockWorkCancelled:
		o.Escrowed = false
	}
	o.Events = append(o.Events, WorkEvent{
		Seq:       len(o.Events) + 1,
		Status:    o.Status,
		Actor:     "chain-replay",
		Detail:    "Restored from block " + blockType + ".",
		Timestamp: time.Now().UTC(),
	})
}

func parseWorkTime(v interface{}) time.Time {
	if s, ok := v.(string); ok {
		if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
			return t
		}
	}
	return time.Now().UTC()
}

// ---------- helpers ----------

func (d *WorkDesk) mustFind(orderID string) (*WorkOrder, error) {
	o, ok := d.orders[strings.TrimSpace(orderID)]
	if !ok {
		return nil, ErrWorkNotFound
	}
	return o, nil
}

func badState(o *WorkOrder, want string) error {
	allowed := legalWorkTransitions[o.Status]
	next := "nothing — this order is closed"
	if len(allowed) > 0 {
		next = strings.Join(allowed, " or ")
	}
	return fmt.Errorf("%w: the order is %s, so it can move to %s, not %s", ErrWorkBadState, o.Status, next, want)
}

func validCategory(c string) bool {
	for _, k := range WorkCategories {
		if k == c {
			return true
		}
	}
	return false
}

func trimmedList(in []string) []string {
	out := make([]string, 0, len(in))
	for _, s := range in {
		if t := strings.TrimSpace(s); t != "" {
			out = append(out, t)
		}
	}
	return out
}

func looksLikeSHA256(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, r := range s {
		if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f')) {
			return false
		}
	}
	return true
}
