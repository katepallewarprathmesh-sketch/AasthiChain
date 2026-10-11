package drunix

import (
	"encoding/json"
	"testing"
)

// A committed block must stop depending on whatever the caller does next.
// The production chain sealed itself because a basket's component slice went
// into a block and was then changed underneath it: the stored transactions no
// longer matched the merkle root computed at commit, and the next restart
// refused the chain as tampered.
func TestCommittedBlockIgnoresLaterMutation(t *testing.T) {
	c := NewChain()
	components := []map[string]interface{}{
		{"assetId": "PROP-1", "tokensPerUnit": 2, "indicativePriceINR": 500.0},
	}
	txn := map[string]interface{}{
		"basketId":   "BASKET-1",
		"components": components,
		"custodian":  "BASKET-1-CUSTODY",
	}
	blk := c.Append("UMI_BASKET_CREATED", []map[string]interface{}{txn})
	if blk == nil {
		t.Fatal("append refused")
	}
	rootAtCommit := blk.TxnsRoot

	// The caller carries on using its own structures, as the rail does.
	txn["custodian"] = "SOMEONE-ELSE"
	components[0]["indicativePriceINR"] = 9999.0
	components[0]["tokensPerUnit"] = 7

	if blk.TxnsRoot != rootAtCommit {
		t.Fatalf("root changed after commit: %s -> %s", rootAtCommit, blk.TxnsRoot)
	}
	if got := TxnsRoot(blk.Txns); got != rootAtCommit {
		t.Fatalf("BLOCK CONTENTS DRIFTED FROM THEIR ROOT: recomputed %s, committed %s", got, rootAtCommit)
	}
	if v := c.Verify(); !v.Valid {
		t.Fatalf("chain stopped verifying after a caller mutated its own data: %+v", v)
	}
	if blk.Txns[0]["custodian"] != "BASKET-1-CUSTODY" {
		t.Fatalf("the block kept a live reference to the caller's map: %v", blk.Txns[0]["custodian"])
	}
}

// What is hashed must be exactly what a restore decodes, or a block that
// verified when written fails the moment it comes back from storage.
func TestCommittedBlockSurvivesAStorageRoundTrip(t *testing.T) {
	c := NewChain()
	blk := c.Append("UMI_DVP_SETTLED", []map[string]interface{}{{
		"tokens":    int64(10),
		"cashPaise": int64(5000000),
		"nested":    map[string]interface{}{"from": "investor1", "to": "investor2"},
		"legs":      []interface{}{"cash", "securities"},
	}})
	if blk == nil {
		t.Fatal("append refused")
	}
	raw, err := json.Marshal(blk.Txns)
	if err != nil {
		t.Fatal(err)
	}
	var reloaded []map[string]interface{}
	if err := json.Unmarshal(raw, &reloaded); err != nil {
		t.Fatal(err)
	}
	if got := TxnsRoot(reloaded); got != blk.TxnsRoot {
		t.Fatalf("root differs after a storage round-trip: stored %s, reloaded %s", blk.TxnsRoot, got)
	}
}
