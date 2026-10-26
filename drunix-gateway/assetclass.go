package drunix

// A second asset class, and the one operation property does not have.
//
// THE CLAIM BEING TESTED
//
// The settlement core never knew what a property was. `assetId` is an opaque
// string everywhere in the rail, DvP moves tokens against paise without an
// opinion about what the tokens represent, and pilotISINFor hashes whatever
// string it is given. So a second asset class ought to be a registry entry
// rather than a rewrite, and almost all of this file is registry.
//
// WHAT CARBON ACTUALLY ADDS
//
// One thing, and it is the reason carbon was chosen over a fourth flavour of
// real estate: a terminal state. A property token lives forever and changes
// hands. A carbon credit is RETIRED, consumed permanently against someone's
// emissions, and must never trade again. Getting that wrong is the best-known
// failure in carbon markets: double counting, the same tonne claimed twice.
//
// THE INVARIANT
//
// The securities leg was conserved when outstanding <= authorised, where
// outstanding sums the positive holder positions. Retirement debits a holder
// and credits nobody, so outstanding falls on its own and that check would
// keep passing while losing track of where the tokens went. The invariant is
// therefore widened to:
//
//	outstanding + retired <= authorised
//
// That is what makes double counting detectable rather than merely frowned
// upon. A retired credit cannot be settled again because no position remains
// to move, and cannot be quietly re-issued because authorised is pinned.
//
// RESTART IS THE DANGEROUS PART
//
// On restore the rail derives authorised from the restored positions. Retired
// tokens are not positions, so a naive restore would forget them, shrink the
// effective cap, and allow exactly the re-issuance this is meant to prevent.
// Retirements are therefore rebuilt from the chain, which is durable and
// already holds a block per retirement. The ledger is the source of truth for
// the thing the ledger exists to prove.
//
// HONESTY
//
// A real credit is issued and retired in an independent registry, and that
// registry is the authority on whether a serial is live. We are not connected
// to one. The serials here are ours, the registry is ours, and /trust says so.
// What is real is the lifecycle, the arithmetic, the irreversibility, and the
// block that proves it.

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
	"time"
)

// Asset classes. PROPERTY is the zero value on purpose: an asset nobody has
// registered behaves exactly as it did before this file existed.
const (
	AssetClassProperty = "PROPERTY"
	AssetClassCarbon   = "CARBON"

	BlockUMIAssetRegistered = "UMI_ASSET_REGISTERED"
	BlockUMICarbonRetired   = "UMI_CARBON_RETIRED"
)

// AssetProfile is what the rail knows about an asset beyond its id.
//
// Everything except AssetID and Class is carbon metadata. A property profile
// is legal and carries none of it, which is the point: the registry describes
// assets, it does not gate them.
type AssetProfile struct {
	AssetID string `json:"assetId"`
	Class   string `json:"assetClass"`
	Name    string `json:"name,omitempty"`

	// Carbon metadata. Serial numbers are ours, not a registry's.
	Registry     string `json:"registry,omitempty"`
	ProjectID    string `json:"projectId,omitempty"`
	Vintage      int    `json:"vintage,omitempty"`
	Methodology  string `json:"methodology,omitempty"`
	Country      string `json:"country,omitempty"`
	SerialPrefix string `json:"serialPrefix,omitempty"`

	RegisteredAt time.Time `json:"registeredAt"`
	BlockHeight  int64     `json:"blockHeight,omitempty"`

	// Simulated is always true for carbon here, and is serialised so a
	// consumer cannot read this profile and believe a registry stands
	// behind it.
	Simulated bool `json:"simulated"`
}

// Retirement is one permanent consumption of credits. It is the certificate:
// "prove this tonne was retired" is answered with a block height.
type Retirement struct {
	RetirementID string    `json:"retirementId"`
	AssetID      string    `json:"assetId"`
	Holder       string    `json:"holder"`
	Tokens       int64     `json:"tokens"`
	Beneficiary  string    `json:"beneficiary"`
	Reason       string    `json:"reason,omitempty"`
	SerialRange  string    `json:"serialRange,omitempty"`
	RetiredAt    time.Time `json:"retiredAt"`
	BlockHeight  int64     `json:"blockHeight"`
	BlockHash    string    `json:"blockHash"`
}

// ---------- registry ----------

// AssetClassOf returns the class of an asset. Unregistered means PROPERTY,
// which is what every asset in the system was before this existed.
func (r *UMIRail) AssetClassOf(assetID string) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.assetClassLocked(assetID)
}

func (r *UMIRail) assetClassLocked(assetID string) string {
	if p, ok := r.assets[assetID]; ok && p.Class != "" {
		return p.Class
	}
	return AssetClassProperty
}

// AssetProfileOf returns the registered profile, or a synthesised PROPERTY
// profile so a caller never has to special-case "not registered".
func (r *UMIRail) AssetProfileOf(assetID string) AssetProfile {
	r.mu.Lock()
	defer r.mu.Unlock()
	if p, ok := r.assets[assetID]; ok {
		return *p
	}
	return AssetProfile{AssetID: assetID, Class: AssetClassProperty}
}

// AssetProfiles lists every registered profile, oldest first.
func (r *UMIRail) AssetProfiles() []AssetProfile {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]AssetProfile, 0, len(r.assets))
	for _, p := range r.assets {
		out = append(out, *p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].RegisteredAt.Before(out[j].RegisteredAt) })
	return out
}

// RegisterAsset records an asset's class and metadata and commits a block.
//
// Re-registering the same class is allowed and simply updates the metadata.
// CHANGING the class is refused: positions, retirements and the conservation
// arithmetic are all interpreted through the class, so flipping it after the
// fact would reinterpret history rather than describe it.
func (r *UMIRail) RegisterAsset(p AssetProfile) (AssetProfile, error) {
	p.AssetID = strings.TrimSpace(p.AssetID)
	if p.AssetID == "" {
		return AssetProfile{}, ErrUMIUnknownAsset
	}
	p.Class = strings.ToUpper(strings.TrimSpace(p.Class))
	if p.Class == "" {
		p.Class = AssetClassProperty
	}
	if p.Class != AssetClassProperty && p.Class != AssetClassCarbon {
		return AssetProfile{}, fmt.Errorf("%w: %s", ErrUMIUnknownAssetClass, p.Class)
	}

	r.mu.Lock()
	if prior, ok := r.assets[p.AssetID]; ok && prior.Class != p.Class {
		r.mu.Unlock()
		return AssetProfile{}, ErrUMIAssetClassLocked
	}
	p.RegisteredAt = time.Now().UTC()
	// Nothing here is backed by an external registry, and the flag travels
	// with the record so a consumer cannot miss it.
	p.Simulated = true
	if p.Class == AssetClassCarbon && p.Registry == "" {
		p.Registry = "AASTHI-CARBON-REGISTRY (simulation, not an external registry)"
	}
	cp := p
	r.assets[p.AssetID] = &cp
	r.mu.Unlock()

	blk := r.append(BlockUMIAssetRegistered, map[string]interface{}{
		"kind":        "umi-asset-registered",
		"assetId":     p.AssetID,
		"assetClass":  p.Class,
		"name":        p.Name,
		"registry":    p.Registry,
		"projectId":   p.ProjectID,
		"vintage":     p.Vintage,
		"methodology": p.Methodology,
		"country":     p.Country,
		"simulated":   true,
	})
	if blk != nil {
		r.mu.Lock()
		if cur, ok := r.assets[p.AssetID]; ok {
			cur.BlockHeight = blk.Height
			cp = *cur
		}
		r.mu.Unlock()
	}
	return cp, nil
}

// ---------- retirement ----------

// RetiredTokens reports how many of an asset's tokens have been permanently
// consumed.
func (r *UMIRail) RetiredTokens(assetID string) int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.retired[assetID]
}

// Retirements lists the retirement register, newest first.
func (r *UMIRail) Retirements(assetID string) []Retirement {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := []Retirement{}
	for i := len(r.retirements) - 1; i >= 0; i-- {
		if assetID == "" || r.retirements[i].AssetID == assetID {
			out = append(out, r.retirements[i])
		}
	}
	return out
}

// RetireCredits permanently consumes credits held by one participant.
//
// It debits the holder and credits nobody. There is no un-retire route and
// there will not be one: a retirement that can be reversed is not a
// retirement, it is a transfer with extra steps.
func (r *UMIRail) RetireCredits(assetID, holder string, tokens int64, beneficiary, reason string) (Retirement, error) {
	assetID = strings.TrimSpace(assetID)
	holder = strings.TrimSpace(holder)
	if assetID == "" || holder == "" {
		return Retirement{}, ErrUMIUnknownAsset
	}
	if tokens <= 0 {
		return Retirement{}, ErrUMIInvalidAmount
	}

	// Only carbon retires. Letting a property through would make the
	// conservation arithmetic meaningless for the class that relies on it.
	if r.AssetClassOf(assetID) != AssetClassCarbon {
		return Retirement{}, ErrUMINotRetirable
	}

	mem, ok := r.securities.(IssuingLedger)
	if !ok {
		return Retirement{}, ErrUMINotRetirable
	}

	// Debited under the ledger's own lock, so a concurrent settlement cannot
	// see the same tokens as available. The check and the subtraction belong
	// to the ledger, not to this caller.
	if err := mem.Burn(assetID, holder, tokens); err != nil {
		return Retirement{}, err
	}

	r.mu.Lock()
	r.retired[assetID] += tokens
	r.seq++
	rec := Retirement{
		RetirementID: fmt.Sprintf("RET-%s-%06d", strings.ToUpper(shortHash(assetID)), r.seq),
		AssetID:      assetID,
		Holder:       holder,
		Tokens:       tokens,
		Beneficiary:  strings.TrimSpace(beneficiary),
		Reason:       strings.TrimSpace(reason),
		RetiredAt:    time.Now().UTC(),
	}
	if rec.Beneficiary == "" {
		rec.Beneficiary = holder
	}
	if p, ok := r.assets[assetID]; ok && p.SerialPrefix != "" {
		rec.SerialRange = fmt.Sprintf("%s-%d", p.SerialPrefix, r.seq)
	}
	r.mu.Unlock()

	blk := r.append(BlockUMICarbonRetired, map[string]interface{}{
		"kind":         "umi-carbon-retired",
		"retirementId": rec.RetirementID,
		"assetId":      assetID,
		"assetClass":   AssetClassCarbon,
		"holder":       holder,
		"tokens":       tokens,
		"beneficiary":  rec.Beneficiary,
		"reason":       rec.Reason,
		"serialRange":  rec.SerialRange,
		"irreversible": true,
		"note":         "Permanently consumed. These credits can never be settled again.",
		"simulated":    true,
	})
	if blk != nil {
		rec.BlockHeight, rec.BlockHash = blk.Height, blk.Hash
	}

	r.mu.Lock()
	r.retirements = append(r.retirements, rec)
	r.mu.Unlock()
	return rec, nil
}

// ---------- restore ----------

// restoreCarbonFromChain rebuilds asset profiles and retired totals by
// replaying the chain.
//
// This exists because of a hole that is easy to miss. On restore the rail
// derives authorised supply from the restored positions, and retired tokens
// are not positions: they were debited and credited to nobody. A restore that
// ignored them would shrink the effective cap by exactly the retired amount
// and let that supply be issued a second time, which is the double count this
// whole feature is meant to make impossible.
//
// The chain already holds a block per registration and per retirement, and
// the chain is durable, so it is both the simplest and the most defensible
// place to rebuild from: the ledger is the source of truth for the thing the
// ledger exists to prove.
//
// Caller holds r.mu.
func (r *UMIRail) restoreCarbonFromChain() {
	if r.chain == nil {
		return
	}
	blocks := r.chain.Snapshot()
	for _, b := range blocks {
		switch b.Type {
		case BlockUMIAssetRegistered:
			for _, txn := range b.Txns {
				id, _ := txn["assetId"].(string)
				class, _ := txn["assetClass"].(string)
				if id == "" || class == "" {
					continue
				}
				p := &AssetProfile{AssetID: id, Class: class, Simulated: true, BlockHeight: b.Height}
				if v, ok := txn["name"].(string); ok {
					p.Name = v
				}
				if v, ok := txn["registry"].(string); ok {
					p.Registry = v
				}
				if v, ok := txn["projectId"].(string); ok {
					p.ProjectID = v
				}
				if v, ok := txn["methodology"].(string); ok {
					p.Methodology = v
				}
				if v, ok := txn["country"].(string); ok {
					p.Country = v
				}
				if v, ok := txn["vintage"].(float64); ok {
					p.Vintage = int(v)
				}
				r.assets[id] = p
			}
		case BlockUMICarbonRetired:
			for _, txn := range b.Txns {
				id, _ := txn["assetId"].(string)
				if id == "" {
					continue
				}
				var tokens int64
				switch v := txn["tokens"].(type) {
				case float64:
					tokens = int64(v)
				case int64:
					tokens = v
				case int:
					tokens = int64(v)
				}
				if tokens <= 0 {
					continue
				}
				r.retired[id] += tokens
				rec := Retirement{AssetID: id, Tokens: tokens, BlockHeight: b.Height, BlockHash: b.Hash}
				if v, ok := txn["retirementId"].(string); ok {
					rec.RetirementID = v
				}
				if v, ok := txn["holder"].(string); ok {
					rec.Holder = v
				}
				if v, ok := txn["beneficiary"].(string); ok {
					rec.Beneficiary = v
				}
				if v, ok := txn["reason"].(string); ok {
					rec.Reason = v
				}
				r.retirements = append(r.retirements, rec)
			}
		}
	}
	// Retired supply was issued once and must stay accounted for, or the cap
	// shrinks and the same tonne can be sold twice.
	for id, n := range r.retired {
		r.authorised[id] += n
	}
}

// shortHash gives a stable, short, human-safe tag for an asset id. Used only
// for readable retirement ids, never for anything that must be unique on its
// own (the sequence number carries that).
func shortHash(s string) string {
	sum := sha256.Sum256([]byte("aasthi-asset-tag|" + s))
	return hex.EncodeToString(sum[:])[:6]
}
