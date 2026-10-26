package drunix

// Cross-ledger transfer, framed the way Hyperledger Cacti frames it.
//
// The rail is a permissioned ledger. Plenty of the things a tokenised asset
// wants to touch are not: a public chain where a holder can prove ownership
// to someone who has never heard of us, or another institution's ledger
// entirely. Moving value between them is where most tokenisation projects
// either hand-wave or quietly create the same asset twice.
//
// Cacti (formerly Cactus) splits the problem into two pieces, and this file
// keeps that split visible:
//
//   - CONNECTORS. One per ledger, each knowing how to talk to its own chain
//     and nothing else. Here: the Drunix fork, and an EVM chain reached over
//     JSON-RPC. A connector reports honestly whether it is configured, so
//     "we support Sepolia" cannot be said by a connector that has no RPC URL.
//   - A BUSINESS LOGIC PLUGIN. One place that sequences a transfer across
//     connectors and owns the failure handling. That is InteropGateway below.
//
// The sequence is the standard lock-and-claim shape that the asset transfer
// work (SATP) formalises, because it is the only shape where a crash cannot
// leave the asset in both places:
//
//	PROPOSED -> LOCKED -> COMMITTED
//	                 \-> ABORTED
//
//   - LOCK immobilises the tokens on this ledger by moving them into a
//     custody account. They are gone from the holder's position, so they
//     cannot be sold here while they are represented elsewhere. This is a
//     real ledger movement with a block behind it, not a flag.
//   - COMMIT records that the counterpart leg exists. The tokens stay in
//     custody: that custody balance IS the amount represented on the other
//     ledger, which is what stops the same tonne or the same square metre
//     existing twice.
//   - ABORT returns the tokens to the holder. Allowed by the holder or a
//     supervisor before expiry, and by anyone after it, because a lock that
//     only its beneficiary can release is a way to strand someone's asset.
//
// WHAT IS REAL AND WHAT IS NOT. The lock, the custody movement, the abort,
// the state machine, the double-spend refusals and every block behind them
// are real and run on this rail. The counterpart leg is only as real as the
// connector: with EVM_RPC_URL and EVM_REGISTRY_ADDRESS set, the gateway
// checks the remote chain itself and the transfer is marked verified. With
// no connector configured, a commit records an ATTESTED reference supplied
// by a supervisor and says so in the record, in the API response and on the
// trust page. An attested transfer is never reported as verified, and the
// counts are kept separate so a reader cannot mistake one for the other.

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

// Block types committed by this subsystem.
const (
	BlockInteropLocked    = "UMI_INTEROP_LOCKED"
	BlockInteropCommitted = "UMI_INTEROP_COMMITTED"
	BlockInteropAborted   = "UMI_INTEROP_ABORTED"
)

// Transfer states.
const (
	InteropLocked    = "LOCKED"
	InteropCommitted = "COMMITTED"
	InteropAborted   = "ABORTED"
)

// InteropCustody is the account that holds locked tokens. It is a real
// position in the securities ledger, so an auditor can ask "how much of this
// asset is immobilised" and get an answer from the book rather than from a
// status field.
const InteropCustody = "interop-custody"

var (
	ErrInteropFields     = errors.New("ERR_UMI_INTEROP_FIELDS")
	ErrInteropNotFound   = errors.New("ERR_UMI_INTEROP_NOT_FOUND")
	ErrInteropState      = errors.New("ERR_UMI_INTEROP_STATE")
	ErrInteropNoLedger   = errors.New("ERR_UMI_INTEROP_UNKNOWN_LEDGER")
	ErrInteropNotExpired = errors.New("ERR_UMI_INTEROP_NOT_EXPIRED")
	ErrInteropForbidden  = errors.New("ERR_UMI_INTEROP_FORBIDDEN")
)

// CrossChainConnector is one ledger's adapter. Deliberately small: anything
// bigger would tempt a connector into owning business logic, which is the
// thing Cacti's split exists to prevent.
type CrossChainConnector interface {
	// Ledger is the name used in a transfer request.
	Ledger() string
	// Kind is the technology, for a reader deciding whether they trust it.
	Kind() string
	// Configured reports whether this connector can actually reach a chain.
	Configured() bool
	// Describe is one sentence of honest status.
	Describe() string
	// VerifyRemote checks that a digest is anchored on the remote chain.
	// A connector that cannot check returns configured=false rather than a
	// cheerful true.
	VerifyRemote(digest string) (anchored bool, detail string, err error)
}

// drunixConnector is this rail. It is always configured, because it is us.
type drunixConnector struct{ chain *DrunixChain }

func (d *drunixConnector) Ledger() string   { return "drunix" }
func (d *drunixConnector) Kind() string     { return "hyperledger-fabric-fork (simulated network)" }
func (d *drunixConnector) Configured() bool { return d.chain != nil }
func (d *drunixConnector) Describe() string {
	return "The local hash-chained ledger. Blocks are committed in process, so this leg is always available."
}
func (d *drunixConnector) VerifyRemote(digest string) (bool, string, error) {
	if d.chain == nil {
		return false, "no chain", nil
	}
	for _, b := range d.chain.Snapshot() {
		if b.Hash == digest {
			return true, fmt.Sprintf("block %d", b.Height), nil
		}
	}
	return false, "no block with that hash", nil
}

// evmConnector wraps the existing EVM mirror (evm_mirror.go). Unconfigured
// is the normal case and is reported as such rather than hidden.
type evmConnector struct {
	mirror *EVMMirror
	name   string
}

func (e *evmConnector) Ledger() string   { return e.name }
func (e *evmConnector) Kind() string     { return "evm (JSON-RPC)" }
func (e *evmConnector) Configured() bool { return e.mirror != nil }
func (e *evmConnector) Describe() string {
	if e.mirror == nil {
		return "Not configured. Set EVM_RPC_URL and EVM_REGISTRY_ADDRESS to point this connector at a chain such as " +
			"Sepolia; until then a commit against this ledger is an attestation, " +
			"not an observation."
	}
	return e.mirror.Describe()
}
func (e *evmConnector) VerifyRemote(digest string) (bool, string, error) {
	if e.mirror == nil {
		return false, "connector not configured", nil
	}
	anchored, status, err := e.mirror.VerifyDigestOnChain(digest)
	if err != nil {
		// Never surface the raw RPC URL: a hosted provider carries its
		// API key in it and this error reaches an HTTP response.
		return false, "", errors.New(e.mirror.redactRPC(err.Error()))
	}
	return anchored, fmt.Sprintf("registry status %d", status), nil
}

// InteropTransfer is one cross-ledger movement.
type InteropTransfer struct {
	TransferID string `json:"transferId"`
	AssetID    string `json:"assetId"`
	Holder     string `json:"holder"`
	Tokens     int64  `json:"tokens"`

	RemoteLedger  string `json:"remoteLedger"`
	RemoteAccount string `json:"remoteAccount,omitempty"`

	Status    string `json:"status"`
	LockedAt  string `json:"lockedAt"`
	ExpiresAt string `json:"expiresAt"`
	ClosedAt  string `json:"closedAt,omitempty"`

	// Evidence of the counterpart leg.
	RemoteTxRef string `json:"remoteTxRef,omitempty"`
	RemoteProof string `json:"remoteProof,omitempty"`
	// Verified is true only when a configured connector checked the remote
	// chain itself. An attestation by a supervisor leaves this false.
	Verified    bool   `json:"remoteLegVerified"`
	Evidence    string `json:"remoteLegEvidence"`
	AbortReason string `json:"abortReason,omitempty"`
	LockBlock   int64  `json:"lockBlockHeight"`
	CloseBlock  int64  `json:"closeBlockHeight,omitempty"`
	AbortedBy   string `json:"abortedBy,omitempty"`
	CommittedBy string `json:"committedBy,omitempty"`
}

// Expired reports whether the lock window has passed.
func (t *InteropTransfer) Expired(now time.Time) bool {
	if t.ExpiresAt == "" {
		return false
	}
	exp, err := time.Parse(time.RFC3339Nano, t.ExpiresAt)
	if err != nil {
		return false
	}
	return now.After(exp)
}

// InteropGateway sequences transfers across connectors.
type InteropGateway struct {
	mu         sync.Mutex
	rail       *UMIRail
	connectors map[string]CrossChainConnector
	transfers  map[string]*InteropTransfer
	order      []string
	seq        int64
}

func newInteropGateway(r *UMIRail, chain *DrunixChain) *InteropGateway {
	g := &InteropGateway{
		rail:       r,
		connectors: map[string]CrossChainConnector{},
		transfers:  map[string]*InteropTransfer{},
	}
	g.register(&drunixConnector{chain: chain})
	// One EVM connector, configured or not. Registering it unconfigured is
	// the point: a reviewer can see exactly which leg is live.
	g.register(&evmConnector{mirror: OpenEVMMirrorFromEnv(), name: "evm"})
	return g
}

func (g *InteropGateway) register(c CrossChainConnector) {
	g.connectors[strings.ToLower(c.Ledger())] = c
}

// Connectors lists the adapters and their honest status.
func (g *InteropGateway) Connectors() []map[string]interface{} {
	g.mu.Lock()
	defer g.mu.Unlock()
	out := make([]map[string]interface{}, 0, len(g.connectors))
	for _, c := range g.connectors {
		out = append(out, map[string]interface{}{
			"ledger":     c.Ledger(),
			"kind":       c.Kind(),
			"configured": c.Configured(),
			"status":     c.Describe(),
		})
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i]["ledger"].(string) < out[j]["ledger"].(string)
	})
	return out
}

// LockRequest starts a transfer.
type LockRequest struct {
	AssetID       string `json:"assetId"`
	Holder        string `json:"holder"`
	Tokens        int64  `json:"tokens"`
	RemoteLedger  string `json:"remoteLedger"`
	RemoteAccount string `json:"remoteAccount"`
	ExpiresInSec  int64  `json:"expiresInSec"`
}

// Lock immobilises tokens on this ledger pending a counterpart leg.
func (g *InteropGateway) Lock(req LockRequest) (*InteropTransfer, error) {
	g.mu.Lock()
	defer g.mu.Unlock()

	req.AssetID = strings.TrimSpace(req.AssetID)
	req.Holder = strings.TrimSpace(req.Holder)
	ledger := strings.ToLower(strings.TrimSpace(req.RemoteLedger))
	if req.AssetID == "" || req.Holder == "" || req.Tokens <= 0 {
		return nil, fmt.Errorf("%w: assetId, holder and a positive token count are required", ErrInteropFields)
	}
	conn, ok := g.connectors[ledger]
	if !ok {
		return nil, fmt.Errorf("%w: no connector for %q", ErrInteropNoLedger, req.RemoteLedger)
	}
	if ledger == "drunix" {
		return nil, fmt.Errorf("%w: a transfer to this same ledger is an ordinary settlement, use /umi/dvp", ErrInteropFields)
	}

	// The ledger movement is the lock. If this fails, nothing else happened.
	if err := g.rail.securities.Move(req.AssetID, req.Holder, InteropCustody, req.Tokens); err != nil {
		return nil, err
	}

	g.seq++
	now := time.Now().UTC()
	window := req.ExpiresInSec
	if window <= 0 {
		window = 3600
	}
	t := &InteropTransfer{
		TransferID:    fmt.Sprintf("XCHAIN-%06d", g.seq),
		AssetID:       req.AssetID,
		Holder:        req.Holder,
		Tokens:        req.Tokens,
		RemoteLedger:  conn.Ledger(),
		RemoteAccount: strings.TrimSpace(req.RemoteAccount),
		Status:        InteropLocked,
		LockedAt:      now.Format(time.RFC3339Nano),
		ExpiresAt:     now.Add(time.Duration(window) * time.Second).Format(time.RFC3339Nano),
		Evidence:      "none yet: the tokens are immobilised here and nothing has been claimed on the other ledger",
	}
	if blk := g.rail.append(BlockInteropLocked, map[string]interface{}{
		"kind":          "interop-lock",
		"transferId":    t.TransferID,
		"assetId":       t.AssetID,
		"holder":        t.Holder,
		"tokens":        t.Tokens,
		"custody":       InteropCustody,
		"remoteLedger":  t.RemoteLedger,
		"remoteAccount": t.RemoteAccount,
		"expiresAt":     t.ExpiresAt,
		"note":          "Tokens moved into custody on this ledger. They cannot be settled here until this transfer closes.",
	}); blk != nil {
		t.LockBlock = blk.Height
	}
	g.transfers[t.TransferID] = t
	g.order = append(g.order, t.TransferID)
	return t, nil
}

// CommitRequest records the counterpart leg.
type CommitRequest struct {
	RemoteTxRef string `json:"remoteTxRef"`
	// Digest is what a configured connector checks on the remote chain.
	Digest string `json:"digest"`
}

// Commit closes a transfer as done. The tokens stay in custody: that balance
// is the amount now represented on the other ledger.
func (g *InteropGateway) Commit(id string, req CommitRequest, by string) (*InteropTransfer, error) {
	g.mu.Lock()
	defer g.mu.Unlock()

	t, ok := g.transfers[strings.TrimSpace(id)]
	if !ok {
		return nil, fmt.Errorf("%w: no transfer %q", ErrInteropNotFound, id)
	}
	if t.Status != InteropLocked {
		return nil, fmt.Errorf("%w: %s is already %s", ErrInteropState, t.TransferID, t.Status)
	}
	if strings.TrimSpace(req.RemoteTxRef) == "" {
		return nil, fmt.Errorf("%w: remoteTxRef is required, a commit with no counterpart reference is just a deletion", ErrInteropFields)
	}

	conn := g.connectors[strings.ToLower(t.RemoteLedger)]
	verified, detail := false, ""
	if conn != nil && conn.Configured() && strings.TrimSpace(req.Digest) != "" {
		ok, d, err := conn.VerifyRemote(strings.TrimSpace(req.Digest))
		switch {
		case err != nil:
			detail = "connector is configured but the check failed: " + err.Error()
		case !ok:
			// Refusing here is the whole value of having a connector: a
			// commit that the remote chain does not support must not be
			// recorded as if it does.
			return nil, fmt.Errorf("%w: %s has no record of that digest (%s)", ErrInteropState, t.RemoteLedger, d)
		default:
			verified, detail = true, "checked against "+t.RemoteLedger+": "+d
		}
	} else {
		detail = "attested by " + by + ". No configured connector observed this, so it is a claim, not a confirmation."
	}

	t.Status = InteropCommitted
	t.RemoteTxRef = strings.TrimSpace(req.RemoteTxRef)
	t.RemoteProof = strings.TrimSpace(req.Digest)
	t.Verified = verified
	t.Evidence = detail
	t.CommittedBy = by
	t.ClosedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if blk := g.rail.append(BlockInteropCommitted, map[string]interface{}{
		"kind":         "interop-commit",
		"transferId":   t.TransferID,
		"assetId":      t.AssetID,
		"tokens":       t.Tokens,
		"remoteLedger": t.RemoteLedger,
		"remoteTxRef":  t.RemoteTxRef,
		"remoteProof":  t.RemoteProof,
		"verified":     verified,
		"evidence":     detail,
		"committedBy":  by,
		"note": "The tokens remain in custody on this ledger. That custody balance is the amount represented " +
			"on the remote ledger, which is what prevents the asset existing twice.",
	}); blk != nil {
		t.CloseBlock = blk.Height
	}
	cp := *t
	return &cp, nil
}

// Abort returns the tokens. Before expiry only the holder or a supervisor
// may do it; after expiry anyone may, because a stuck lock is worse than an
// impatient release.
func (g *InteropGateway) Abort(id, by string, supervisor bool, reason string) (*InteropTransfer, error) {
	g.mu.Lock()
	defer g.mu.Unlock()

	t, ok := g.transfers[strings.TrimSpace(id)]
	if !ok {
		return nil, fmt.Errorf("%w: no transfer %q", ErrInteropNotFound, id)
	}
	if t.Status != InteropLocked {
		return nil, fmt.Errorf("%w: %s is already %s", ErrInteropState, t.TransferID, t.Status)
	}
	expired := t.Expired(time.Now().UTC())
	if !expired && !supervisor && !strings.EqualFold(by, t.Holder) {
		return nil, fmt.Errorf("%w: before expiry only %s or a supervisor can release this lock", ErrInteropForbidden, t.Holder)
	}

	// Put the tokens back before recording anything, so a failure here
	// cannot leave a record saying they were returned when they were not.
	if err := g.rail.securities.Move(t.AssetID, InteropCustody, t.Holder, t.Tokens); err != nil {
		return nil, err
	}
	t.Status = InteropAborted
	t.AbortedBy = by
	t.AbortReason = strings.TrimSpace(reason)
	if t.AbortReason == "" {
		if expired {
			t.AbortReason = "lock expired with no counterpart leg"
		} else {
			t.AbortReason = "released by " + by
		}
	}
	t.ClosedAt = time.Now().UTC().Format(time.RFC3339Nano)
	t.Evidence = "none: the tokens were returned and nothing is represented on the remote ledger"
	if blk := g.rail.append(BlockInteropAborted, map[string]interface{}{
		"kind":         "interop-abort",
		"transferId":   t.TransferID,
		"assetId":      t.AssetID,
		"tokens":       t.Tokens,
		"holder":       t.Holder,
		"remoteLedger": t.RemoteLedger,
		"abortedBy":    by,
		"expired":      expired,
		"reason":       t.AbortReason,
		"note":         "Tokens returned from custody to the holder. The asset was never represented on the remote ledger.",
	}); blk != nil {
		t.CloseBlock = blk.Height
	}
	cp := *t
	return &cp, nil
}

// Transfers lists them, newest first.
func (g *InteropGateway) Transfers(limit int) []*InteropTransfer {
	g.mu.Lock()
	defer g.mu.Unlock()
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	out := []*InteropTransfer{}
	for i := len(g.order) - 1; i >= 0 && len(out) < limit; i-- {
		if t, ok := g.transfers[g.order[i]]; ok {
			cp := *t
			out = append(out, &cp)
		}
	}
	return out
}

// Transfer returns one.
func (g *InteropGateway) Transfer(id string) (*InteropTransfer, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	t, ok := g.transfers[strings.TrimSpace(id)]
	if !ok {
		return nil, fmt.Errorf("%w: no transfer %q", ErrInteropNotFound, id)
	}
	cp := *t
	return &cp, nil
}

// Stats summarises the book. Verified and attested are counted separately on
// purpose: adding them together would be the dishonest number.
func (g *InteropGateway) Stats() map[string]interface{} {
	g.mu.Lock()
	defer g.mu.Unlock()
	var locked, committed, aborted, verified, attested, lockedTokens, representedTokens int64
	for _, t := range g.transfers {
		switch t.Status {
		case InteropLocked:
			locked++
			lockedTokens += t.Tokens
		case InteropCommitted:
			committed++
			representedTokens += t.Tokens
			if t.Verified {
				verified++
			} else {
				attested++
			}
		case InteropAborted:
			aborted++
		}
	}
	return map[string]interface{}{
		"locked":                    locked,
		"committed":                 committed,
		"aborted":                   aborted,
		"committedVerified":         verified,
		"committedAttestedOnly":     attested,
		"tokensLockedPending":       lockedTokens,
		"tokensRepresentedRemotely": representedTokens,
		"custodyAccount":            InteropCustody,
	}
}

// restoreInteropFromChain rebuilds the transfer book after a restart. The
// positions themselves come back with the rest of the securities ledger, so
// this only has to recover what each custody balance means.
func (g *InteropGateway) restoreInteropFromChain(chain *DrunixChain) int {
	if g == nil || chain == nil {
		return 0
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	restored := 0
	for _, b := range chain.Snapshot() {
		for _, txn := range b.Txns {
			id, _ := txn["transferId"].(string)
			if id == "" {
				continue
			}
			switch b.Type {
			case BlockInteropLocked:
				t := &InteropTransfer{
					TransferID: id,
					Status:     InteropLocked,
					LockBlock:  b.Height,
					LockedAt:   b.Timestamp,
				}
				t.AssetID, _ = txn["assetId"].(string)
				t.Holder, _ = txn["holder"].(string)
				t.RemoteLedger, _ = txn["remoteLedger"].(string)
				t.RemoteAccount, _ = txn["remoteAccount"].(string)
				t.ExpiresAt, _ = txn["expiresAt"].(string)
				if v, ok := txn["tokens"].(float64); ok {
					t.Tokens = int64(v)
				} else if v, ok := txn["tokens"].(int64); ok {
					t.Tokens = v
				}
				if _, seen := g.transfers[id]; !seen {
					g.order = append(g.order, id)
				}
				g.transfers[id] = t
				restored++
				if n := seqOfTransfer(id); n > g.seq {
					g.seq = n
				}
			case BlockInteropCommitted:
				if t, ok := g.transfers[id]; ok {
					t.Status = InteropCommitted
					t.CloseBlock = b.Height
					t.ClosedAt = b.Timestamp
					t.RemoteTxRef, _ = txn["remoteTxRef"].(string)
					t.RemoteProof, _ = txn["remoteProof"].(string)
					t.Verified, _ = txn["verified"].(bool)
					t.Evidence, _ = txn["evidence"].(string)
					t.CommittedBy, _ = txn["committedBy"].(string)
				}
			case BlockInteropAborted:
				if t, ok := g.transfers[id]; ok {
					t.Status = InteropAborted
					t.CloseBlock = b.Height
					t.ClosedAt = b.Timestamp
					t.AbortedBy, _ = txn["abortedBy"].(string)
					t.AbortReason, _ = txn["reason"].(string)
				}
			}
		}
	}
	return restored
}

// seqOfTransfer reads the counter out of XCHAIN-000123 so a restart does not
// hand out an id that already exists.
func seqOfTransfer(id string) int64 {
	var n int64
	if _, err := fmt.Sscanf(id, "XCHAIN-%d", &n); err != nil {
		return 0
	}
	return n
}
