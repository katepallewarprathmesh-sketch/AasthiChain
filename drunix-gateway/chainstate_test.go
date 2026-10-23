package drunix

import (
	"strings"
	"testing"
)

// The claim under test: the offer book is a projection of the ledger, not a
// Go map the ledger comments on. The proof is that a second, empty rail
// sharing the same chain can rebuild the book and serve the same answers.
// chainStateRig gives a rail with a seeded position and the chain behind it.
func chainStateRig(t *testing.T) (*UMIRail, *DrunixChain) {
	t.Helper()
	chain := NewChain()
	r := NewUMIRail(NewMemorySecurities(), chain)
	if _, err := r.SeedPosition(offerTestAsset, offerTestSeller, 1000, 1000); err != nil {
		t.Fatalf("seed: %v", err)
	}
	return r, chain
}

const (
	offerTestAsset  = "PROP-CHAINSTATE"
	offerTestSeller = "alice"
)

func TestOfferBookRebuildsFromTheLedgerAlone(t *testing.T) {
	rail, chain := chainStateRig(t)

	o, err := rail.CreateOffer(offerTestAsset, offerTestSeller, 40, 1000)
	if err != nil {
		t.Fatalf("listing: %v", err)
	}
	if o.BlockHeight == 0 {
		t.Fatal("a listing that commits no block cannot be rebuilt from the ledger")
	}

	// A fresh rail, same chain, empty book: exactly the position after a
	// restart.
	restarted := NewUMIRail(NewMemorySecurities(), chain)
	if len(restarted.Offers("", false)) != 0 {
		t.Fatal("the fresh rail should start with nothing")
	}
	cs := NewChainState(chain, restarted, nil, nil)
	if n := cs.RestoreOffers(); n != 1 {
		t.Fatalf("expected one offer rebuilt from the chain, got %d", n)
	}
	back := restarted.Offers("", false)
	if len(back) != 1 {
		t.Fatalf("the book did not come back, got %d offers", len(back))
	}
	if back[0].OfferID != o.OfferID || back[0].Seller != o.Seller ||
		back[0].TokensRemaining != o.TokensRemaining || back[0].PricePerTokenINR != o.PricePerTokenINR {
		t.Fatalf("the rebuilt offer differs from the original: %+v vs %+v", back[0], o)
	}
	if restarted.book.seq < offerSeqOf(o.OfferID) {
		t.Fatal("a restored book must not reissue identifiers the ledger already used")
	}
}

func TestOfferProjectionFollowsCancellation(t *testing.T) {
	rail, chain := chainStateRig(t)
	o, err := rail.CreateOffer(offerTestAsset, offerTestSeller, 10, 500)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := rail.CancelOffer(o.OfferID, offerTestSeller); err != nil {
		t.Fatal(err)
	}
	cs := NewChainState(chain, rail, nil, nil)
	p := cs.ProjectOffers()
	if p.Count != 1 {
		t.Fatalf("expected one projected offer, got %d", p.Count)
	}
	if p.Entities[0].Status != OfferCancelled {
		t.Fatalf("the ledger should carry the withdrawal, got %s", p.Entities[0].Status)
	}
	if len(p.Entities[0].Blocks) != 2 {
		t.Fatalf("listing and cancellation are two blocks, got %d", len(p.Entities[0].Blocks))
	}
}

// The verification is only worth something if it can fail.
func TestVerifyFailsWhenTheServedStateDivergesFromTheLedger(t *testing.T) {
	rail, chain := chainStateRig(t)
	if _, err := rail.CreateOffer(offerTestAsset, offerTestSeller, 10, 500); err != nil {
		t.Fatal(err)
	}
	cs := NewChainState(chain, rail, nil, nil)
	if c := cs.CheckOffers(); !c.Agrees {
		t.Fatalf("an untouched book should agree with its own blocks: %+v", c.Divergences)
	}

	// Reach past the rail and change the served state without writing a
	// block. This is precisely the failure the check exists to catch: a map
	// that drifted from the ledger it claims to be backed by.
	rail.book.mu.Lock()
	for _, o := range rail.book.offers {
		o.TokensRemaining = 999
	}
	rail.book.mu.Unlock()

	c := cs.CheckOffers()
	if c.Agrees {
		t.Fatal("state that no block accounts for must be reported as a divergence")
	}
	found := false
	for _, d := range c.Divergences {
		if d.Field == "tokensRemaining" && d.OnLive == "999" {
			found = true
		}
	}
	if !found {
		t.Fatalf("the divergence should name the field and both values, got %+v", c.Divergences)
	}
}

func TestVerifyReportsEveryModuleAndItsLimits(t *testing.T) {
	rail, chain := chainStateRig(t)
	cs := NewChainState(chain, rail, NewDocumentRegistry(chain, nil), nil)
	v := cs.Verify()
	checks, _ := v["checks"].([]StateCheck)
	if len(checks) != 3 {
		t.Fatalf("offers, documents and work should all be checked, got %d", len(checks))
	}
	if v["agrees"] != true {
		t.Fatalf("an untouched rail should agree: %+v", checks)
	}
	proves, _ := v["whatThisDoesNotProve"].(string)
	if !strings.Contains(proves, "still hold state") {
		t.Fatal("the verification must state what it does not cover")
	}
	for _, c := range checks {
		if c.Module == "documents" && len(c.NotOnChain) == 0 {
			t.Fatal("the register should admit that the bytes are not on the chain")
		}
	}
}

func TestDocumentProjectionRebuildsAnchors(t *testing.T) {
	_, chain := chainStateRig(t)
	docs := NewDocumentRegistry(chain, nil)
	d, _, err := docs.Anchor(AnchorRequest{
		AssetID: "PROP-1", DocType: "TITLE_DEED", Title: "deed.pdf",
		Content: []byte("a deed that will be re-hashed in five years"), SubmittedBy: "registrar1",
	})
	if err != nil {
		t.Fatal(err)
	}
	cs := NewChainState(chain, nil, docs, nil)
	p := cs.ProjectDocuments()
	if p.Count != 1 {
		t.Fatalf("expected one projected document, got %d", p.Count)
	}
	if sha, _ := p.Entities[0].Fields["sha256"].(string); !strings.EqualFold(sha, d.SHA256) {
		t.Fatalf("the hash on the block should match the register: %q vs %q", sha, d.SHA256)
	}
	if c := cs.CheckDocuments(); !c.Agrees {
		t.Fatalf("the register should agree with its own blocks: %+v", c.Divergences)
	}
}

func TestUnknownModuleHasNoProjection(t *testing.T) {
	_, chain := chainStateRig(t)
	cs := NewChainState(chain, nil, nil, nil)
	if _, ok := cs.Projection("tea-leaves"); ok {
		t.Fatal("a module nobody projects must not report an empty projection as success")
	}
}
