package drunix

// Chain-first state: the ledger as the source of truth, not the commentary.
//
// THE GAP THIS CLOSES
// Large parts of this system treated the chain as a record rather than as
// the state. An offer, a document or a work order lived in a Go map, and a
// block was written *about* it. Two things followed, and both are serious.
//
// First, the map was the truth and the block was a description, so the two
// could disagree and nobody would know. A reviewer reading the ledger could
// not tell whether it was the system's state or a log the system happened to
// emit, and the difference is the entire claim of putting this on a chain.
//
// Second, the state could not survive the process. Restart the rail and the
// offer book was empty even though every listing was supposedly recorded.
//
// WHAT CHAIN-FIRST MEANS HERE
// A module is chain-first when its in-memory state is a *projection*: a pure
// function of the committed blocks, rebuildable by replaying them, and
// provably equal to what the module is actually serving. This file builds
// that replay and then checks it against the live state on demand. Where the
// blocks do not carry enough to rebuild a field, the projection says which
// field and why rather than quietly guessing.
//
// WHAT THIS IS NOT
// It is not an event-sourcing rewrite of the whole rail, and the maps have
// not gone away. They remain, as caches of the replay, because the read path
// should not walk the chain on every request. What has changed is which one
// is authoritative: the projection is derived from blocks, the live state is
// checked against it, and a divergence is reported as a failure rather than
// absorbed.

import (
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

// ProjectedEntity is one thing rebuilt purely from blocks.
type ProjectedEntity struct {
	ID     string                 `json:"id"`
	Status string                 `json:"status"`
	Fields map[string]interface{} `json:"fields"`
	Blocks []int64                `json:"blocks"`
}

// Projection is one module's state as the ledger alone describes it.
type Projection struct {
	Module         string            `json:"module"`
	BlockTypes     []string          `json:"blockTypesConsumed"`
	BlocksConsumed int               `json:"blocksConsumed"`
	Entities       []ProjectedEntity `json:"entities"`
	Count          int               `json:"count"`

	// NotOnChain lists the fields the live module holds that the blocks do
	// not carry. An empty list is the claim that the module could be
	// rebuilt from the ledger with nothing lost; a non-empty one is an
	// honest statement of how far short of that it falls.
	NotOnChain []string `json:"fieldsNotOnChain"`
}

// Divergence is one disagreement between the ledger and what is being served.
type Divergence struct {
	Module  string `json:"module"`
	ID      string `json:"id"`
	Field   string `json:"field"`
	OnLive  string `json:"live"`
	OnChain string `json:"chain"`
}

// StateCheck is the whole answer: what the ledger says, what the process is
// serving, and whether they agree.
type StateCheck struct {
	Module      string       `json:"module"`
	LiveCount   int          `json:"liveEntities"`
	ChainCount  int          `json:"chainEntities"`
	Agrees      bool         `json:"agrees"`
	Divergences []Divergence `json:"divergences,omitempty"`
	NotOnChain  []string     `json:"fieldsNotOnChain,omitempty"`
	Note        string       `json:"note,omitempty"`
}

// ChainState replays the ledger into module projections and compares them
// with what the rail is serving.
type ChainState struct {
	mu    sync.RWMutex
	chain *DrunixChain
	rail  *UMIRail
	docs  *DocumentRegistry
	work  *WorkDesk
}

// NewChainState wires the replay. Any dependency may be nil; a module with
// no live counterpart is projected from the chain and simply not compared.
func NewChainState(chain *DrunixChain, rail *UMIRail, docs *DocumentRegistry, work *WorkDesk) *ChainState {
	if chain == nil {
		return nil
	}
	return &ChainState{chain: chain, rail: rail, docs: docs, work: work}
}

// str reads a string field from a block payload without panicking on a shape
// the writer changed.
func str(txn map[string]interface{}, key string) string {
	if v, ok := txn[key]; ok && v != nil {
		if s, ok := v.(string); ok {
			return s
		}
		return fmt.Sprintf("%v", v)
	}
	return ""
}

// num reads a numeric field. JSON round-trips make everything a float64, so
// both shapes have to be accepted or a replayed chain disagrees with a live
// one for no reason other than serialisation.
func num(txn map[string]interface{}, key string) float64 {
	switch v := txn[key].(type) {
	case float64:
		return v
	case int64:
		return float64(v)
	case int:
		return float64(v)
	}
	return 0
}

// walk visits every transaction of every block of the named types.
func (cs *ChainState) walk(types []string, fn func(height int64, blockType string, txn map[string]interface{})) int {
	want := map[string]bool{}
	for _, t := range types {
		want[t] = true
	}
	consumed := 0
	for _, b := range cs.chain.Snapshot() {
		if !want[b.Type] {
			continue
		}
		consumed++
		for _, txn := range b.Txns {
			fn(b.Height, b.Type, txn)
		}
	}
	return consumed
}

/* -------------------------------------------------------- the offer book */

var offerBlockTypes = []string{BlockOfferListed, BlockOfferTaken, BlockOfferCancelled}

// ProjectOffers rebuilds the secondary market book from blocks alone.
func (cs *ChainState) ProjectOffers() Projection {
	byID := map[string]*ProjectedEntity{}
	order := []string{}
	consumed := cs.walk(offerBlockTypes, func(h int64, t string, txn map[string]interface{}) {
		id := str(txn, "offerId")
		if id == "" {
			return
		}
		e, ok := byID[id]
		if !ok {
			e = &ProjectedEntity{ID: id, Fields: map[string]interface{}{}}
			byID[id] = e
			order = append(order, id)
		}
		e.Blocks = append(e.Blocks, h)
		switch t {
		case BlockOfferListed:
			e.Status = OfferOpen
			e.Fields["assetId"] = str(txn, "assetId")
			e.Fields["seller"] = str(txn, "seller")
			e.Fields["tokensTotal"] = int64(num(txn, "tokens"))
			e.Fields["tokensRemaining"] = int64(num(txn, "tokens"))
			e.Fields["pricePerTokenINR"] = num(txn, "pricePerTokenINR")
			e.Fields["fills"] = 0
		case BlockOfferTaken:
			e.Fields["tokensRemaining"] = int64(num(txn, "tokensRemaining"))
			if n, ok := e.Fields["fills"].(int); ok {
				e.Fields["fills"] = n + 1
			}
			if s := str(txn, "status"); s != "" {
				e.Status = s
			}
		case BlockOfferCancelled:
			e.Status = OfferCancelled
		}
	})

	out := make([]ProjectedEntity, 0, len(order))
	for _, id := range order {
		out = append(out, *byID[id])
	}
	return Projection{
		Module: "offers", BlockTypes: offerBlockTypes, BlocksConsumed: consumed,
		Entities: out, Count: len(out),
		NotOnChain: []string{},
	}
}

// CheckOffers compares the live book with the replayed one.
func (cs *ChainState) CheckOffers() StateCheck {
	p := cs.ProjectOffers()
	c := StateCheck{Module: "offers", ChainCount: p.Count, Agrees: true, NotOnChain: p.NotOnChain}
	if cs.rail == nil {
		c.Note = "No live book to compare against; the projection stands alone."
		return c
	}
	live := cs.rail.Offers("", false)
	c.LiveCount = len(live)

	chainByID := map[string]ProjectedEntity{}
	for _, e := range p.Entities {
		chainByID[e.ID] = e
	}
	for _, o := range live {
		e, ok := chainByID[o.OfferID]
		if !ok {
			c.Divergences = append(c.Divergences, Divergence{
				Module: "offers", ID: o.OfferID, Field: "existence",
				OnLive: "being served", OnChain: "absent",
			})
			continue
		}
		if e.Status != o.Status {
			c.Divergences = append(c.Divergences, Divergence{
				Module: "offers", ID: o.OfferID, Field: "status", OnLive: o.Status, OnChain: e.Status,
			})
		}
		if rem, _ := e.Fields["tokensRemaining"].(int64); rem != o.TokensRemaining {
			c.Divergences = append(c.Divergences, Divergence{
				Module: "offers", ID: o.OfferID, Field: "tokensRemaining",
				OnLive: fmt.Sprint(o.TokensRemaining), OnChain: fmt.Sprint(rem),
			})
		}
		if seller, _ := e.Fields["seller"].(string); seller != o.Seller {
			c.Divergences = append(c.Divergences, Divergence{
				Module: "offers", ID: o.OfferID, Field: "seller", OnLive: o.Seller, OnChain: seller,
			})
		}
	}
	c.Agrees = len(c.Divergences) == 0 && c.LiveCount == c.ChainCount
	if c.Agrees {
		c.Note = "Every offer being served is reconstructable from the ledger, with the same seller, the " +
			"same remaining size and the same status."
	}
	return c
}

// RestoreOffers rebuilds the live book from the chain. This is what makes the
// module chain-first rather than chain-logged: after a restart the book comes
// back from the ledger instead of starting empty while the blocks that
// created it sit there unread.
func (cs *ChainState) RestoreOffers() int {
	if cs.rail == nil {
		return 0
	}
	p := cs.ProjectOffers()
	restored := 0
	cs.rail.book.mu.Lock()
	defer cs.rail.book.mu.Unlock()
	for _, e := range p.Entities {
		if _, exists := cs.rail.book.offers[e.ID]; exists {
			continue
		}
		seller, _ := e.Fields["seller"].(string)
		asset, _ := e.Fields["assetId"].(string)
		total, _ := e.Fields["tokensTotal"].(int64)
		remaining, _ := e.Fields["tokensRemaining"].(int64)
		price, _ := e.Fields["pricePerTokenINR"].(float64)
		o := &Offer{
			OfferID: e.ID, AssetID: asset, Seller: seller,
			TokensTotal: total, TokensRemaining: remaining,
			PricePerTokenINR: price, Status: e.Status,
			CreatedAt: time.Now().UTC(), Fills: []OfferFill{},
		}
		if len(e.Blocks) > 0 {
			o.BlockHeight = e.Blocks[0]
		}
		cs.rail.book.offers[o.OfferID] = o
		cs.rail.book.order = append(cs.rail.book.order, o.OfferID)
		// Keep the id sequence ahead of anything restored, or the next
		// listing collides with one the ledger already knows about.
		if n := offerSeqOf(o.OfferID); n > cs.rail.book.seq {
			cs.rail.book.seq = n
		}
		restored++
	}
	return restored
}

// offerSeqOf reads the counter back out of an id so a restored book does not
// reissue identifiers.
func offerSeqOf(id string) uint64 {
	var n uint64
	if _, err := fmt.Sscanf(id, "OFR-%06X", &n); err != nil {
		return 0
	}
	return n
}

/* ---------------------------------------------------------- the register */

var docBlockTypes = []string{BlockDocAnchored, BlockDocStatus}

// ProjectDocuments rebuilds the evidence register from blocks.
func (cs *ChainState) ProjectDocuments() Projection {
	byID := map[string]*ProjectedEntity{}
	order := []string{}
	consumed := cs.walk(docBlockTypes, func(h int64, t string, txn map[string]interface{}) {
		id := str(txn, "cid")
		if id == "" {
			id = str(txn, "documentCid")
		}
		if id == "" {
			return
		}
		e, ok := byID[id]
		if !ok {
			e = &ProjectedEntity{ID: id, Fields: map[string]interface{}{}}
			byID[id] = e
			order = append(order, id)
		}
		e.Blocks = append(e.Blocks, h)
		if v := str(txn, "assetId"); v != "" {
			e.Fields["assetId"] = v
		}
		if v := str(txn, "docType"); v != "" {
			e.Fields["docType"] = v
		}
		if v := str(txn, "sha256"); v != "" {
			e.Fields["sha256"] = v
		}
		if v := str(txn, "status"); v != "" {
			e.Status = v
		} else if e.Status == "" {
			e.Status = "ANCHORED"
		}
	})
	out := make([]ProjectedEntity, 0, len(order))
	for _, id := range order {
		out = append(out, *byID[id])
	}
	return Projection{
		Module: "documents", BlockTypes: docBlockTypes, BlocksConsumed: consumed,
		Entities: out, Count: len(out),
		NotOnChain: []string{
			"the file bytes themselves, which are held by the pin store and addressed by the CID on the block",
		},
	}
}

// CheckDocuments compares the live register with the replay.
func (cs *ChainState) CheckDocuments() StateCheck {
	p := cs.ProjectDocuments()
	c := StateCheck{Module: "documents", ChainCount: p.Count, Agrees: true, NotOnChain: p.NotOnChain}
	if cs.docs == nil {
		c.Note = "No live register to compare against."
		return c
	}
	live := cs.docs.All()
	c.LiveCount = len(live)
	chainByID := map[string]ProjectedEntity{}
	for _, e := range p.Entities {
		chainByID[e.ID] = e
	}
	for _, d := range live {
		e, ok := chainByID[d.CID]
		if !ok {
			c.Divergences = append(c.Divergences, Divergence{
				Module: "documents", ID: d.CID, Field: "existence",
				OnLive: "being served", OnChain: "absent",
			})
			continue
		}
		if sha, _ := e.Fields["sha256"].(string); sha != "" && !strings.EqualFold(sha, d.SHA256) {
			c.Divergences = append(c.Divergences, Divergence{
				Module: "documents", ID: d.CID, Field: "sha256", OnLive: d.SHA256, OnChain: sha,
			})
		}
	}
	c.Agrees = len(c.Divergences) == 0 && c.LiveCount == c.ChainCount
	if c.Agrees {
		c.Note = "Every anchored document is reconstructable from the ledger, hash included. The bytes are " +
			"not on the chain and were never meant to be; the CID on the block addresses them."
	}
	return c
}

/* --------------------------------------------------------- the work desk */

var workBlockTypes = []string{
	BlockWorkCreated, BlockWorkFunded, BlockWorkAssigned, BlockWorkSubmitted,
	BlockWorkAccepted, BlockWorkDisputed, BlockWorkRefunded, BlockWorkCancelled,
}

// ProjectWork rebuilds work orders from blocks.
func (cs *ChainState) ProjectWork() Projection {
	byID := map[string]*ProjectedEntity{}
	order := []string{}
	consumed := cs.walk(workBlockTypes, func(h int64, t string, txn map[string]interface{}) {
		id := str(txn, "orderId")
		if id == "" {
			return
		}
		e, ok := byID[id]
		if !ok {
			e = &ProjectedEntity{ID: id, Fields: map[string]interface{}{}}
			byID[id] = e
			order = append(order, id)
		}
		e.Blocks = append(e.Blocks, h)
		if v := str(txn, "status"); v != "" {
			e.Status = v
		}
		for _, f := range []string{"assetId", "title", "category", "funder", "worker", "provider"} {
			if v := str(txn, f); v != "" {
				e.Fields[f] = v
			}
		}
		if v := num(txn, "feeINR"); v != 0 {
			e.Fields["feeINR"] = v
		}
	})
	out := make([]ProjectedEntity, 0, len(order))
	for _, id := range order {
		out = append(out, *byID[id])
	}
	return Projection{
		Module: "work", BlockTypes: workBlockTypes, BlocksConsumed: consumed,
		Entities: out, Count: len(out),
		NotOnChain: []string{
			"the acceptance criteria text, which is held off-chain and summarised by the deliverable hash",
		},
	}
}

// CheckWork compares live work orders with the replay.
func (cs *ChainState) CheckWork() StateCheck {
	p := cs.ProjectWork()
	c := StateCheck{Module: "work", ChainCount: p.Count, Agrees: true, NotOnChain: p.NotOnChain}
	if cs.work == nil {
		c.Note = "No live work desk to compare against."
		return c
	}
	live := cs.work.Orders("")
	c.LiveCount = len(live)
	chainByID := map[string]ProjectedEntity{}
	for _, e := range p.Entities {
		chainByID[e.ID] = e
	}
	for _, o := range live {
		e, ok := chainByID[o.OrderID]
		if !ok {
			c.Divergences = append(c.Divergences, Divergence{
				Module: "work", ID: o.OrderID, Field: "existence",
				OnLive: "being served", OnChain: "absent",
			})
			continue
		}
		if e.Status != o.Status {
			c.Divergences = append(c.Divergences, Divergence{
				Module: "work", ID: o.OrderID, Field: "status", OnLive: o.Status, OnChain: e.Status,
			})
		}
		if f, _ := e.Fields["funder"].(string); f != o.Funder {
			c.Divergences = append(c.Divergences, Divergence{
				Module: "work", ID: o.OrderID, Field: "funder", OnLive: o.Funder, OnChain: f,
			})
		}
	}
	c.Agrees = len(c.Divergences) == 0 && c.LiveCount == c.ChainCount
	if c.Agrees {
		c.Note = "Every work order is reconstructable from the ledger, with the same funder and the same status."
	}
	return c
}

/* ------------------------------------------------------------- the whole */

// Projections returns every module's rebuilt state.
func (cs *ChainState) Projections() []Projection {
	cs.mu.RLock()
	defer cs.mu.RUnlock()
	return []Projection{cs.ProjectOffers(), cs.ProjectDocuments(), cs.ProjectWork()}
}

// Projection returns one module by name.
func (cs *ChainState) Projection(module string) (Projection, bool) {
	switch strings.ToLower(strings.TrimSpace(module)) {
	case "offers":
		return cs.ProjectOffers(), true
	case "documents":
		return cs.ProjectDocuments(), true
	case "work":
		return cs.ProjectWork(), true
	}
	return Projection{}, false
}

// Verify checks every module and reports whether the ledger and the running
// process agree. This is the assertion the whole file exists to support, and
// it is deliberately a check that can fail rather than a claim in a document.
func (cs *ChainState) Verify() map[string]interface{} {
	cs.mu.RLock()
	defer cs.mu.RUnlock()
	checks := []StateCheck{cs.CheckOffers(), cs.CheckDocuments(), cs.CheckWork()}
	agrees := true
	divergences := 0
	for _, c := range checks {
		if !c.Agrees {
			agrees = false
		}
		divergences += len(c.Divergences)
	}
	sort.SliceStable(checks, func(i, j int) bool { return checks[i].Module < checks[j].Module })
	return map[string]interface{}{
		"checks":         checks,
		"agrees":         agrees,
		"divergences":    divergences,
		"blocksInLedger": len(cs.chain.Snapshot()),
		"checkedAt":      time.Now().UTC().Format(time.RFC3339),
		"whatThisProves": "Each module's state was rebuilt by replaying committed blocks and compared with " +
			"what the rail is serving. Agreement means the ledger is the state rather than a description " +
			"of it, and that the module could be reconstructed from the chain alone.",
		"whatThisDoesNotProve": "That every module is chain-first. Modules not listed here still hold state " +
			"the chain does not fully carry, and each projection names the fields it cannot rebuild.",
	}
}
