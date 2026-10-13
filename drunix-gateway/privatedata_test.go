package drunix

import (
	"encoding/json"
	"strings"
	"testing"
)

func pdcRail(t testing.TB) *UMIRail {
	t.Helper()
	return NewUMIRail(NewMemorySecurities(), NewChain())
}

func kycValue() map[string]interface{} {
	return map[string]interface{}{
		"documentType": "AADHAAR",
		"holderName":   "Asha Kulkarni",
		"idLastFour":   "4417",
		"verifiedBy":   "registrar1",
		"score":        92,
	}
}

// The whole claim of this subsystem is that the personal data is not on the
// chain. Asserting the API refuses to serve it would not test that: the
// bytes could still be sitting in a block for anyone reading the ledger. So
// this walks the actual chain and looks for the data.
func TestPrivateValueNeverReachesTheChain(t *testing.T) {
	r := pdcRail(t)
	ps := r.Private()

	proof, err := ps.Put(PrivateWrite{
		Collection: CollectionKYC,
		Key:        "investor1",
		Owner:      "investor1",
		Value:      kycValue(),
	}, "registrar1", "registrar")
	if err != nil {
		t.Fatalf("write: %v", err)
	}

	raw, err := json.Marshal(r.chain.Snapshot())
	if err != nil {
		t.Fatalf("marshal chain: %v", err)
	}
	ledger := string(raw)
	for _, secret := range []string{"Asha Kulkarni", "4417", "AADHAAR"} {
		if strings.Contains(ledger, secret) {
			t.Fatalf("%q is on the public chain; the collection leaked its value", secret)
		}
	}
	if !strings.Contains(ledger, proof.ValueHash) {
		t.Fatal("the value hash must be on the chain, otherwise nobody can verify the record")
	}
	if !strings.Contains(ledger, proof.KeyHash) {
		t.Fatal("the key hash must be on the chain")
	}
	// The key itself is a participant id, which is personal data too.
	if strings.Contains(ledger, `"key":"investor1"`) {
		t.Fatal("the raw key must not be on the chain, only its hash")
	}
	if proof.BlockHeight == 0 {
		t.Fatal("a write must be anchored to a block")
	}
}

// Membership, from four angles: the member role, the subject, a stranger,
// and an anonymous caller. A test that only checks the happy read would pass
// against a store with no policy at all.
func TestPrivateReadFollowsThePolicy(t *testing.T) {
	r := pdcRail(t)
	ps := r.Private()
	if _, err := ps.Put(PrivateWrite{
		Collection: CollectionKYC, Key: "investor1", Owner: "investor1", Value: kycValue(),
	}, "registrar1", "registrar"); err != nil {
		t.Fatalf("write: %v", err)
	}

	cases := []struct {
		who, role string
		allowed   bool
	}{
		{"registrar1", "registrar", true},  // member role
		{"regulator1", "regulator", true},  // member role
		{"investor1", "investor", true},    // the subject reads their own
		{"investor2", "investor", false},   // a stranger
		{"", "", false},                    // anonymous
		{"investor2", "registrar", true},   // role is what counts, not the id
		{"REGULATOR1", "investor", false},  // the owner check must not match a member's id
		{"Investor1", "investor", true},    // ids compare case insensitively
		{"investor2", "REGULATOR", true},   // so do roles
		{"investor2", "originator", false}, // an unrelated role
	}
	for _, c := range cases {
		value, proof, err := ps.Get(CollectionKYC, "investor1", c.who, c.role)
		if proof == nil {
			t.Fatalf("%s/%s: the proof is public and must always come back", c.who, c.role)
		}
		if c.allowed {
			if err != nil {
				t.Fatalf("%s/%s should read the value, got %v", c.who, c.role, err)
			}
			if value["holderName"] != "Asha Kulkarni" {
				t.Fatalf("%s/%s got the wrong value: %v", c.who, c.role, value)
			}
			continue
		}
		if err == nil || value != nil {
			t.Fatalf("%s/%s must not read the value", c.who, c.role)
		}
		if proof.ValueHash == "" {
			t.Fatalf("%s/%s: a refusal still owes the caller the hash", c.who, c.role)
		}
	}
}

// Writing is a member act even for the subject: being the person a KYC record
// is about does not make you the registrar who attests it.
func TestSubjectCannotWriteTheirOwnKYC(t *testing.T) {
	ps := pdcRail(t).Private()
	if _, err := ps.Put(PrivateWrite{
		Collection: CollectionKYC, Key: "investor1", Owner: "investor1", Value: kycValue(),
	}, "investor1", "investor"); err == nil {
		t.Fatal("a subject must not be able to write their own KYC evidence")
	}
}

// A hash nobody outside the package can reproduce is not a proof. Verify has
// to accept the same content arriving as JSON (every number a float64) and
// has to reject a single changed digit.
func TestVerifyAcceptsTheTruthAndRejectsATamper(t *testing.T) {
	ps := pdcRail(t).Private()
	if _, err := ps.Put(PrivateWrite{
		Collection: CollectionKYC, Key: "investor1", Owner: "investor1", Value: kycValue(),
	}, "registrar1", "registrar"); err != nil {
		t.Fatalf("write: %v", err)
	}

	// Round trip through JSON, as a counterparty holding a copy would.
	raw, _ := json.Marshal(kycValue())
	var asJSON map[string]interface{}
	if err := json.Unmarshal(raw, &asJSON); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	ok, _, err := ps.Verify(CollectionKYC, "investor1", asJSON)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if !ok {
		t.Fatal("the committed value must verify even after a JSON round trip")
	}

	tampered := kycValue()
	tampered["idLastFour"] = "4418"
	if ok, _, _ := ps.Verify(CollectionKYC, "investor1", tampered); ok {
		t.Fatal("a changed value must not verify")
	}

	// Field order must not matter, or two honest parties would disagree.
	reordered := map[string]interface{}{
		"score": 92, "verifiedBy": "registrar1", "idLastFour": "4417",
		"holderName": "Asha Kulkarni", "documentType": "AADHAAR",
	}
	if ok, _, _ := ps.Verify(CollectionKYC, "investor1", reordered); !ok {
		t.Fatal("the hash must not depend on the order the fields were written in")
	}
}

// blockToLive: the value goes, the proof stays. This is the retention story,
// so it has to be the real thing and not a flag flipped by the test.
func TestBlockToLivePurgesTheValueAndKeepsTheProof(t *testing.T) {
	r := pdcRail(t)
	ps := r.Private()
	def := ps.defs[CollectionTerms]
	def.BlockToLive = 3
	ps.define(def)

	if _, err := ps.Put(PrivateWrite{
		Collection: CollectionTerms,
		Key:        "SETL-1",
		Owner:      "investor1",
		Parties:    []string{"investor1", "originator1"},
		Value:      map[string]interface{}{"pricePerTokenINR": 512, "discountPct": 4},
	}, "regulator1", "regulator"); err != nil {
		t.Fatalf("write: %v", err)
	}

	// A named party reads it while it lives.
	if v, _, err := ps.Get(CollectionTerms, "SETL-1", "originator1", "originator"); err != nil || v == nil {
		t.Fatalf("a named counterparty must read the terms: %v", err)
	}

	for i := 0; i < 4; i++ {
		r.chain.Append("TEST_FILLER", []map[string]interface{}{{"n": i}})
	}

	v, proof, err := ps.Get(CollectionTerms, "SETL-1", "regulator1", "regulator")
	if v != nil {
		t.Fatal("the value must be gone once blockToLive has passed")
	}
	if err == nil {
		t.Fatal("a read of a purged value must say so rather than look like an empty record")
	}
	if proof == nil || proof.ValueHash == "" || !proof.Purged {
		t.Fatalf("the proof must survive the purge and say it was purged: %+v", proof)
	}

	var purgeBlocks int
	for _, b := range r.chain.Snapshot() {
		if b.Type == BlockPDCPurged {
			purgeBlocks++
		}
	}
	if purgeBlocks != 1 {
		t.Fatalf("want exactly one purge block, got %d", purgeBlocks)
	}
	// And it must not keep re-committing one on every subsequent read.
	_, _, _ = ps.Get(CollectionTerms, "SETL-1", "regulator1", "regulator")
	purgeBlocks = 0
	for _, b := range r.chain.Snapshot() {
		if b.Type == BlockPDCPurged {
			purgeBlocks++
		}
	}
	if purgeBlocks != 1 {
		t.Fatalf("purging must happen once, got %d blocks", purgeBlocks)
	}
}

// After a restart the proofs come back from the chain and the values do not,
// because the values were never on it. The restored record must not pretend
// to hold a value.
func TestRestartRestoresProofsButNotValues(t *testing.T) {
	r := pdcRail(t)
	if _, err := r.Private().Put(PrivateWrite{
		Collection: CollectionKYC, Key: "investor1", Owner: "investor1", Value: kycValue(),
	}, "registrar1", "registrar"); err != nil {
		t.Fatalf("write: %v", err)
	}

	// Same chain, fresh side store: that is exactly what a restart leaves.
	fresh := newPrivateStore(r.chain)
	fresh.restorePrivateDataFromChain()

	stats := fresh.Stats()
	if stats["records"].(int) != 1 {
		t.Fatalf("the proof must be recovered from the chain, got %v", stats["records"])
	}
	if stats["valuesHeld"].(int) != 0 {
		t.Fatal("no value can be recovered from the chain, because none was written to it")
	}
	proofs, err := fresh.Keys(CollectionKYC, "regulator1", "regulator")
	if err != nil || len(proofs) != 1 {
		t.Fatalf("want one recovered proof, got %d (%v)", len(proofs), err)
	}
	if proofs[0].Available {
		t.Fatal("a recovered proof must not claim its value is available")
	}
	if proofs[0].ValueHash == "" || proofs[0].BlockHeight == 0 {
		t.Fatalf("a recovered proof is only useful with its hash and height: %+v", proofs[0])
	}
}

// Listing is scoped the same way reading is, or the list becomes the leak.
func TestKeysAreScopedToTheReader(t *testing.T) {
	ps := pdcRail(t).Private()
	for _, who := range []string{"investor1", "investor2"} {
		if _, err := ps.Put(PrivateWrite{
			Collection: CollectionKYC, Key: who, Owner: who, Value: kycValue(),
		}, "registrar1", "registrar"); err != nil {
			t.Fatalf("write %s: %v", who, err)
		}
	}
	if got, _ := ps.Keys(CollectionKYC, "regulator1", "regulator"); len(got) != 2 {
		t.Fatalf("a member sees the collection, got %d", len(got))
	}
	got, _ := ps.Keys(CollectionKYC, "investor1", "investor")
	if len(got) != 1 {
		t.Fatalf("a subject sees only their own record, got %d", len(got))
	}
	if got[0].Collection != CollectionKYC {
		t.Fatalf("unexpected proof: %+v", got[0])
	}
	if none, _ := ps.Keys(CollectionKYC, "stranger", "investor"); len(none) != 0 {
		t.Fatalf("a stranger sees nothing, got %d", len(none))
	}
}

func TestUnknownCollectionIsRefused(t *testing.T) {
	ps := pdcRail(t).Private()
	if _, err := ps.Put(PrivateWrite{Collection: "whatever", Key: "k", Value: kycValue()},
		"regulator1", "regulator"); err == nil {
		t.Fatal("a collection has to be declared before it can be written to")
	}
	if _, _, err := ps.Get("whatever", "k", "regulator1", "regulator"); err == nil {
		t.Fatal("reading an undeclared collection must fail")
	}
}
