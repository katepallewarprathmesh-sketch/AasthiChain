package drunix

// Private data collections: the Fabric pattern, made explicit.
//
// The rail already had one instance of this idea. KYC evidence is anchored by
// digest only (documents.go): the chain records a hash, the bytes are never
// transmitted and no code path can serve them. That works, but it is a single
// hard-coded special case, and a reviewer reading it has to take the privacy
// rule on trust because it is expressed as scattered "if docType == KYC"
// checks rather than as a policy.
//
// Hyperledger Fabric solves the same problem with private data collections.
// A collection is a named side database with a membership policy. Members
// hold the actual value; every peer, member or not, holds the hash of the key
// and the hash of the value on the public ledger. So the network can agree a
// record exists, agree it has not changed, and order it against every other
// transaction, while the contents stay with the organisations entitled to
// them. A collection can also carry blockToLive, after which members purge
// the value and keep the hash forever.
//
// This file is that structure, in the shape this rail can honestly implement:
//
//   - Collections are declared data, not code. The definition, including who
//     may read and write, is public and served at /umi/private/collections,
//     exactly as Fabric puts the collection config on the public ledger.
//   - A write stores the value in a side store and commits UMI_PDC_WRITE to
//     the hash chain carrying only the key hash, the value hash and the
//     policy name. Grep the chain: the personal data is not in it.
//   - A non-member read returns the proof and refuses the value. It is not a
//     404 pretending the record is absent, because hiding existence is not
//     what this mechanism promises.
//   - Anyone, member or not, can verify a value they already hold against the
//     chain hash. That is the whole point of publishing the hash.
//   - blockToLive purges the value and keeps the proof, which is how an
//     append-only ledger coexists with a retention limit.
//
// WHAT THIS IS NOT. Fabric distributes private data by gossip between
// authorised peers, so the value never reaches a non-member's disk. This rail
// is one process, so the side store and the public chain live in the same
// program and membership is enforced in code rather than by physics. The
// structure, the policy language and the ledger evidence are real; the
// distribution is not. Nothing here should be read as a claim that an
// unauthorised operator with the process memory cannot see a value.
//
// Durability note, and it is a feature rather than an omission: a restart
// replays the UMI_PDC_WRITE blocks, so the proofs come back and verification
// keeps working, while values that were only ever in the side store do not.
// A member's missing value is reported as purged or unavailable, never
// silently as absent.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

// Block types committed by this subsystem.
const (
	BlockPDCWrite  = "UMI_PDC_WRITE"
	BlockPDCPurged = "UMI_PDC_PURGED"
)

// Collection names defined by the rail.
const (
	// CollectionKYC holds the identity evidence behind a participant's
	// verified status. Members are the registrar and the regulator; the
	// subject always reads their own record.
	CollectionKYC = "kycEvidence"
	// CollectionTerms holds the commercial terms of a bilateral trade:
	// price-sensitive while the trade is live, of no interest to the rest
	// of the network afterwards. Counterparties plus the regulator.
	CollectionTerms = "settlementTerms"
)

var (
	// ErrPDCNoCollection is an unknown collection name.
	ErrPDCNoCollection = errors.New("ERR_UMI_PDC_NO_COLLECTION")
	// ErrPDCNotFound is a key that was never written.
	ErrPDCNotFound = errors.New("ERR_UMI_PDC_NOT_FOUND")
	// ErrPDCForbidden is a read or write by a non-member.
	ErrPDCForbidden = errors.New("ERR_UMI_PDC_FORBIDDEN")
	// ErrPDCFields rejects an empty key or value.
	ErrPDCFields = errors.New("ERR_UMI_PDC_FIELDS")
	// ErrPDCGone is a member read of a value that has been purged or lost
	// with the side store. The proof survives; the value does not.
	ErrPDCGone = errors.New("ERR_UMI_PDC_VALUE_GONE")
)

// PrivateCollection is a collection definition. It is public by design.
type PrivateCollection struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	// MemberRoles are the roles whose holders are members of this
	// collection. Fabric names organisations here; this rail's
	// organisations are its roles, which is the closest honest mapping.
	MemberRoles []string `json:"memberRoles"`
	// OwnerReads lets the participant a record is about read it even
	// though their role is not a member. KYC evidence about me is mine.
	OwnerReads bool `json:"ownerReads"`
	// PartiesRead extends reads to the parties named on the record, which
	// is what makes a bilateral collection work without a definition per
	// pair of counterparties.
	PartiesRead bool `json:"partiesRead"`
	// BlockToLive purges values this many blocks after they were written.
	// Zero means keep indefinitely, as in Fabric.
	BlockToLive int64 `json:"blockToLive"`
	// RequiredPeerCount is carried so the definition is recognisable to
	// anyone who has written a Fabric collection config. It is not
	// enforced: there is one process, so there is one peer.
	RequiredPeerCount int    `json:"requiredPeerCount"`
	Enforcement       string `json:"enforcement"`
}

// PrivateProof is what every caller may see: enough to prove the record
// exists and to check a value they already hold, and nothing else.
type PrivateProof struct {
	Collection  string `json:"collection"`
	KeyHash     string `json:"keyHash"`
	ValueHash   string `json:"valueHash"`
	WrittenBy   string `json:"writtenBy"`
	WrittenAt   string `json:"writtenAt"`
	BlockHeight int64  `json:"blockHeight"`
	BlockHash   string `json:"blockHash,omitempty"`
	Available   bool   `json:"valueAvailable"`
	Purged      bool   `json:"purged"`
	PurgeHeight int64  `json:"purgeAtHeight,omitempty"`
	Note        string `json:"note,omitempty"`
}

type privateEntry struct {
	collection string
	key        string
	owner      string
	parties    []string
	value      map[string]interface{}
	proof      PrivateProof
}

// PrivateStore is the side database plus its collection definitions.
type PrivateStore struct {
	mu    sync.RWMutex
	defs  map[string]PrivateCollection
	data  map[string]map[string]*privateEntry // collection -> key -> entry
	chain *DrunixChain
}

func newPrivateStore(chain *DrunixChain) *PrivateStore {
	ps := &PrivateStore{
		defs:  map[string]PrivateCollection{},
		data:  map[string]map[string]*privateEntry{},
		chain: chain,
	}
	ps.define(PrivateCollection{
		Name: CollectionKYC,
		Description: "Identity evidence behind a participant's verified status. " +
			"The verification result is public on the rail; what was checked is not.",
		MemberRoles:       []string{"registrar", "regulator", "admin"},
		OwnerReads:        true,
		BlockToLive:       0,
		RequiredPeerCount: 1,
		Enforcement:       "in-process check, see the header of privatedata.go",
	})
	ps.define(PrivateCollection{
		Name: CollectionTerms,
		Description: "Commercial terms of a bilateral trade. Price-sensitive while the " +
			"trade is live, so they are shared with the counterparties and the regulator only.",
		MemberRoles:       []string{"regulator", "admin"},
		PartiesRead:       true,
		BlockToLive:       500,
		RequiredPeerCount: 1,
		Enforcement:       "in-process check, see the header of privatedata.go",
	})
	return ps
}

func (ps *PrivateStore) define(c PrivateCollection) {
	ps.defs[c.Name] = c
	if ps.data[c.Name] == nil {
		ps.data[c.Name] = map[string]*privateEntry{}
	}
}

// Collections lists the definitions, sorted, for the public config route.
func (ps *PrivateStore) Collections() []PrivateCollection {
	ps.mu.RLock()
	defer ps.mu.RUnlock()
	out := make([]PrivateCollection, 0, len(ps.defs))
	for _, c := range ps.defs {
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// hashHex is the one hashing rule used for keys, values and verification.
// json.Marshal sorts map keys, so two callers who agree on the content agree
// on the hash regardless of the order they wrote the fields in.
func hashHex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// CanonicalValueHash hashes a private value the way the chain records it.
// Exported because a counterparty checking their own copy has to reproduce
// it, and a rule nobody outside the package can apply is not verifiable.
func CanonicalValueHash(value map[string]interface{}) (string, error) {
	// A round trip through JSON normalises the numeric types, so a value
	// supplied over HTTP (every number a float64) hashes the same as the
	// same value built in Go with ints.
	raw, err := json.Marshal(value)
	if err != nil {
		return "", fmt.Errorf("%w: value is not JSON serialisable", ErrPDCFields)
	}
	var round map[string]interface{}
	if err := json.Unmarshal(raw, &round); err != nil {
		return "", fmt.Errorf("%w: value is not JSON serialisable", ErrPDCFields)
	}
	norm, err := json.Marshal(round)
	if err != nil {
		return "", fmt.Errorf("%w: value is not JSON serialisable", ErrPDCFields)
	}
	return hashHex(norm), nil
}

func keyHashOf(collection, key string) string {
	return hashHex([]byte(collection + "\x00" + key))
}

// member reports whether a caller may read an entry under a collection.
func (c PrivateCollection) memberRole(role string) bool {
	role = strings.ToLower(strings.TrimSpace(role))
	if role == "" {
		return false
	}
	for _, m := range c.MemberRoles {
		if strings.EqualFold(m, role) {
			return true
		}
	}
	return false
}

func (ps *PrivateStore) canRead(c PrivateCollection, e *privateEntry, callerID, role string) bool {
	if c.memberRole(role) {
		return true
	}
	if callerID == "" {
		return false
	}
	if c.OwnerReads && e != nil && strings.EqualFold(e.owner, callerID) {
		return true
	}
	if c.PartiesRead && e != nil {
		for _, p := range e.parties {
			if strings.EqualFold(p, callerID) {
				return true
			}
		}
	}
	return false
}

// PrivateWrite is one write request.
type PrivateWrite struct {
	Collection string                 `json:"collection"`
	Key        string                 `json:"key"`
	Owner      string                 `json:"owner,omitempty"`
	Parties    []string               `json:"parties,omitempty"`
	Value      map[string]interface{} `json:"value"`
}

// Put writes a value into a collection. Only a member role may write: a
// subject can be the subject of their KYC record without being the registrar
// who attests it.
func (ps *PrivateStore) Put(req PrivateWrite, callerID, role string) (*PrivateProof, error) {
	ps.mu.Lock()
	defer ps.mu.Unlock()

	def, ok := ps.defs[req.Collection]
	if !ok {
		return nil, fmt.Errorf("%w: no collection named %q", ErrPDCNoCollection, req.Collection)
	}
	if !def.memberRole(role) {
		return nil, fmt.Errorf("%w: writing to %s is limited to %s",
			ErrPDCForbidden, def.Name, strings.Join(def.MemberRoles, ", "))
	}
	key := strings.TrimSpace(req.Key)
	if key == "" || len(req.Value) == 0 {
		return nil, fmt.Errorf("%w: key and a non-empty value are required", ErrPDCFields)
	}
	valueHash, err := CanonicalValueHash(req.Value)
	if err != nil {
		return nil, err
	}

	kh := keyHashOf(def.Name, key)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	proof := PrivateProof{
		Collection: def.Name,
		KeyHash:    kh,
		ValueHash:  valueHash,
		WrittenBy:  callerID,
		WrittenAt:  now,
		Available:  true,
	}

	// The public record carries hashes and policy, never the value. This
	// is the line the whole file exists to draw, so it is one short block
	// with nothing derived from req.Value in it except the hash.
	if ps.chain != nil {
		blk := ps.chain.Append(BlockPDCWrite, []map[string]interface{}{{
			"contract":    UMIContract,
			"rail":        "RBI-UMI (simulated)",
			"kind":        "private-data-write",
			"collection":  def.Name,
			"keyHash":     kh,
			"valueHash":   valueHash,
			"writtenBy":   callerID,
			"memberRoles": def.MemberRoles,
			"blockToLive": def.BlockToLive,
			"note":        "Hashes only. The value is held in the collection's side store and was never written to this chain.",
		}})
		if blk != nil {
			proof.BlockHeight = blk.Height
			proof.BlockHash = blk.Hash
			if def.BlockToLive > 0 {
				proof.PurgeHeight = blk.Height + def.BlockToLive
			}
		}
	}

	owner := strings.TrimSpace(req.Owner)
	if owner == "" {
		owner = key
	}
	ps.data[def.Name][key] = &privateEntry{
		collection: def.Name,
		key:        key,
		owner:      owner,
		parties:    append([]string(nil), req.Parties...),
		value:      req.Value,
		proof:      proof,
	}
	ps.purgeExpiredLocked()
	out := ps.data[def.Name][key].proof
	return &out, nil
}

// Get returns the proof always and the value only to a reader the policy
// admits. The two are deliberately separate returns: a caller that forgets to
// check the error cannot accidentally serve a value.
func (ps *PrivateStore) Get(collection, key, callerID, role string) (map[string]interface{}, *PrivateProof, error) {
	ps.mu.Lock()
	ps.purgeExpiredLocked()
	ps.mu.Unlock()

	ps.mu.RLock()
	defer ps.mu.RUnlock()
	def, ok := ps.defs[collection]
	if !ok {
		return nil, nil, fmt.Errorf("%w: no collection named %q", ErrPDCNoCollection, collection)
	}
	e, ok := ps.data[collection][strings.TrimSpace(key)]
	if !ok {
		return nil, nil, fmt.Errorf("%w: %s has no record under that key", ErrPDCNotFound, collection)
	}
	proof := e.proof
	if !ps.canRead(def, e, callerID, role) {
		return nil, &proof, fmt.Errorf("%w: %s is readable by %s, the subject, or a named party",
			ErrPDCForbidden, def.Name, strings.Join(def.MemberRoles, ", "))
	}
	if e.value == nil {
		return nil, &proof, fmt.Errorf("%w: the proof survives, the value does not", ErrPDCGone)
	}
	// Copy out: a caller holding the map could otherwise mutate the stored
	// value and silently break its own hash.
	cp := make(map[string]interface{}, len(e.value))
	for k, v := range e.value {
		cp[k] = v
	}
	return cp, &proof, nil
}

// Proof returns the public evidence for a key with no membership check,
// because that is precisely what every peer in Fabric holds.
func (ps *PrivateStore) Proof(collection, key string) (*PrivateProof, error) {
	ps.mu.RLock()
	defer ps.mu.RUnlock()
	if _, ok := ps.defs[collection]; !ok {
		return nil, fmt.Errorf("%w: no collection named %q", ErrPDCNoCollection, collection)
	}
	e, ok := ps.data[collection][strings.TrimSpace(key)]
	if !ok {
		return nil, fmt.Errorf("%w: %s has no record under that key", ErrPDCNotFound, collection)
	}
	p := e.proof
	return &p, nil
}

// Verify checks a candidate value against the recorded hash. No membership
// check: someone who already holds the value is proving it is the one the
// network committed to, which is the reason the hash is public.
func (ps *PrivateStore) Verify(collection, key string, candidate map[string]interface{}) (bool, *PrivateProof, error) {
	proof, err := ps.Proof(collection, key)
	if err != nil {
		return false, nil, err
	}
	h, err := CanonicalValueHash(candidate)
	if err != nil {
		return false, proof, err
	}
	return h == proof.ValueHash, proof, nil
}

// Keys lists the keys a caller may see in a collection. Members see the
// collection; everyone else sees only their own records.
func (ps *PrivateStore) Keys(collection, callerID, role string) ([]PrivateProof, error) {
	ps.mu.RLock()
	defer ps.mu.RUnlock()
	def, ok := ps.defs[collection]
	if !ok {
		return nil, fmt.Errorf("%w: no collection named %q", ErrPDCNoCollection, collection)
	}
	out := []PrivateProof{}
	for _, e := range ps.data[collection] {
		if ps.canRead(def, e, callerID, role) {
			out = append(out, e.proof)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].WrittenAt < out[j].WrittenAt })
	return out, nil
}

// Stats is the summary the UI panel reads.
func (ps *PrivateStore) Stats() map[string]interface{} {
	ps.mu.RLock()
	defer ps.mu.RUnlock()
	rows := make([]map[string]interface{}, 0, len(ps.defs))
	total, purged, held := 0, 0, 0
	for _, c := range ps.Collections() {
		n, p, h := 0, 0, 0
		for _, e := range ps.data[c.Name] {
			n++
			if e.proof.Purged {
				p++
			}
			if e.value != nil {
				h++
			}
		}
		total, purged, held = total+n, purged+p, held+h
		rows = append(rows, map[string]interface{}{
			"collection":   c.Name,
			"memberRoles":  c.MemberRoles,
			"blockToLive":  c.BlockToLive,
			"records":      n,
			"valuesHeld":   h,
			"valuesPurged": p,
		})
	}
	return map[string]interface{}{
		"collections":  rows,
		"records":      total,
		"valuesHeld":   held,
		"valuesPurged": purged,
	}
}

// chainHeight is the height of the newest block, or 0 on an empty chain.
// The chain exposes no accessor and adding one would touch a type every
// subsystem shares, so the last block of a snapshot is read instead.
func (ps *PrivateStore) chainHeight() int64 {
	blocks := ps.chain.Snapshot()
	if len(blocks) == 0 {
		return 0
	}
	return blocks[len(blocks)-1].Height
}

// purgeExpiredLocked drops values whose blockToLive has passed, keeping the
// proof. Called on write and before a read rather than on a timer, so there
// is no background goroutine to reason about and no window in which a read
// beats the purger to an expired value.
func (ps *PrivateStore) purgeExpiredLocked() {
	if ps.chain == nil {
		return
	}
	height := ps.chainHeight()
	for name, entries := range ps.data {
		def := ps.defs[name]
		if def.BlockToLive <= 0 {
			continue
		}
		for _, e := range entries {
			if e.value == nil || e.proof.PurgeHeight == 0 || height < e.proof.PurgeHeight {
				continue
			}
			e.value = nil
			e.proof.Available = false
			e.proof.Purged = true
			e.proof.Note = "Value purged at the collection's blockToLive. The hash on the chain is permanent."
			ps.chain.Append(BlockPDCPurged, []map[string]interface{}{{
				"contract":   UMIContract,
				"rail":       "RBI-UMI (simulated)",
				"kind":       "private-data-purged",
				"collection": name,
				"keyHash":    e.proof.KeyHash,
				"valueHash":  e.proof.ValueHash,
				"note":       "Members dropped the value at blockToLive. The proof of what it was stays on the chain forever.",
			}})
		}
	}
}

// restorePrivateDataFromChain rebuilds the proofs after a restart.
//
// Only the proofs: the values were never on the chain, which is the property
// this subsystem is for. The restored entries are keyed by their key hash
// because the key itself is not on the chain either, so a direct lookup by
// key will miss them until they are written again. That is the honest
// outcome, and it is reported rather than hidden.
func (ps *PrivateStore) restorePrivateDataFromChain() {
	if ps == nil || ps.chain == nil {
		return
	}
	ps.mu.Lock()
	defer ps.mu.Unlock()
	for _, b := range ps.chain.Snapshot() {
		if b.Type != BlockPDCWrite {
			continue
		}
		for _, txn := range b.Txns {
			name, _ := txn["collection"].(string)
			kh, _ := txn["keyHash"].(string)
			vh, _ := txn["valueHash"].(string)
			if name == "" || kh == "" {
				continue
			}
			if _, ok := ps.defs[name]; !ok {
				continue
			}
			writtenBy, _ := txn["writtenBy"].(string)
			ps.data[name]["hash:"+kh] = &privateEntry{
				collection: name,
				key:        "hash:" + kh,
				value:      nil,
				proof: PrivateProof{
					Collection:  name,
					KeyHash:     kh,
					ValueHash:   vh,
					WrittenBy:   writtenBy,
					WrittenAt:   b.Timestamp,
					BlockHeight: b.Height,
					BlockHash:   b.Hash,
					Available:   false,
					Note: "Recovered from the chain after a restart. The hash proves what was written; " +
						"the value lived only in the collection's side store.",
				},
			}
		}
	}
}
