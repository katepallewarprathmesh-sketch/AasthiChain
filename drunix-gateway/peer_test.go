package drunix

import (
	"encoding/json"
	"strings"
	"testing"
)

func newTestPipeline() (*Pipeline, *StateDB, *TransientStore, *DrunixChain) {
	state := NewStateDB()
	transient := NewTransientStore()
	chain := NewChain()
	return NewPipeline(state, transient, chain), state, transient, chain
}

// 1. Happy path: mint under AND(OriginatorMSP, RegistrarMSP) policy.
func TestPipelineMintCommits(t *testing.T) {
	p, state, transient, chain := newTestPipeline()
	res, err := p.Submit("MintPropertyTokens", []string{"PROP-1", "originator1", "1000"}, nil)
	if err != nil || !res.Committed {
		t.Fatalf("mint should commit: %+v err=%v", res, err)
	}
	if res.Stage != "committed" || res.BlockHeight < 1 {
		t.Fatalf("expected committed with block height, got %+v", res)
	}
	if got := state.GetVersion("balance~PROP-1~originator1"); got.Value != "1000" || got.Version != 1 {
		t.Fatalf("state not applied: %+v", got)
	}
	if res.OrdererLeader < 1 || res.OrdererLeader > 3 {
		t.Fatalf("orderer leader out of range: %d", res.OrdererLeader)
	}
	// Endorsement policy satisfied by exactly the two required orgs
	if len(res.EndorsedBy) != 2 {
		t.Fatalf("expected 2 endorsers, got %v", res.EndorsedBy)
	}
	if transient.Size() != 0 {
		t.Fatalf("transient store should be empty after commit (no private data), size=%d", transient.Size())
	}
	// Hash-chain integrity holds after pipeline commits
	if !chain.Verify().Valid {
		t.Fatal("chain must verify after pipeline commit")
	}
	// Block carries the pipeline evidence
	blk := chain.Blocks[res.BlockHeight]
	if blk.Type != "TX_COMMITTED" || blk.Txns[0]["mvcc"] != "validated" || blk.Txns[0]["vscc"] != "policy-accepted" {
		t.Fatalf("block missing pipeline evidence: %+v", blk.Txns[0])
	}
}

// 2. TransferTokens: balance math across state versions.
func TestPipelineTransfer(t *testing.T) {
	p, _, _, _ := newTestPipeline()
	if _, err := p.Submit("MintPropertyTokens", []string{"PROP-2", "alice", "100"}, nil); err != nil {
		t.Fatal(err)
	}
	res, err := p.Submit("TransferTokens", []string{"PROP-2", "alice", "bob", "30"}, nil)
	if err != nil || !res.Committed {
		t.Fatalf("transfer should commit: %+v err=%v", res, err)
	}
	if v := p.CP.State.GetVersion("balance~PROP-2~alice").Value; v != "70" {
		t.Fatalf("alice balance = %q, want 70", v)
	}
	if v := p.CP.State.GetVersion("balance~PROP-2~bob").Value; v != "30" {
		t.Fatalf("bob balance = %q, want 30", v)
	}
}

// 3. Double-spend stopped at ENDORSEMENT (LP simulation, before ordering).
func TestInsufficientBalanceStoppedAtLitePeer(t *testing.T) {
	p, _, _, _ := newTestPipeline()
	p.Submit("MintPropertyTokens", []string{"PROP-3", "alice", "10"}, nil)
	res, err := p.Submit("TransferTokens", []string{"PROP-3", "alice", "bob", "999"}, nil)
	if err == nil || res.Committed {
		t.Fatalf("overdraft must fail at LP: %+v err=%v", res, err)
	}
	if res.Stage != "lite-peer" || !strings.Contains(res.Reason, "insufficient balance") {
		t.Fatalf("expected lite-peer rejection, got stage=%s reason=%s", res.Stage, res.Reason)
	}
}

//  4. MVCC READ_CONFLICT: two concurrent transfers read the same version;
//     the first commits, the second is rejected by the Committing Peer.
func TestMVCCReadConflict(t *testing.T) {
	p, _, _, _ := newTestPipeline()
	p.Submit("MintPropertyTokens", []string{"PROP-4", "alice", "100"}, nil)

	// Both transactions simulate against the same state (same read versions).
	prop1, rw1, end1, refs1, pd1, err := p.LP.Endorse("TransferTokens", []string{"PROP-4", "alice", "bob", "60"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	prop2, rw2, end2, refs2, pd2, err := p.LP.Endorse("TransferTokens", []string{"PROP-4", "alice", "carol", "60"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if rw1.Reads["balance~PROP-4~alice"] != rw2.Reads["balance~PROP-4~alice"] {
		t.Fatal("both txs must read the same version to constitute a conflict")
	}

	// Both order, then commit sequentially — classic concurrent-submission race.
	seq1, leader1 := p.Order.Order()
	if res := p.CP.Commit("TransferTokens", []string{"PROP-4", "alice", "bob", "60"}, prop1, rw1, end1, refs1, pd1, uint64(leader1), seq1); !res.Committed {
		t.Fatalf("first tx should commit: %+v", res)
	}
	seq2, leader2 := p.Order.Order()
	res2 := p.CP.Commit("TransferTokens", []string{"PROP-4", "alice", "carol", "60"}, prop2, rw2, end2, refs2, pd2, uint64(leader2), seq2)
	if res2.Committed {
		t.Fatal("second tx must fail MVCC — alice no longer has 100")
	}
	if res2.Stage != "committing-peer-mvcc" || !strings.Contains(res2.Reason, "READ_CONFLICT") {
		t.Fatalf("expected MVCC READ_CONFLICT, got %+v", res2)
	}
	// bob got 60, carol got nothing — the double spend did not happen
	if v := p.CP.State.GetVersion("balance~PROP-4~carol").Value; v != "" {
		t.Fatalf("carol must receive nothing, got %q", v)
	}
	if v := p.CP.State.GetVersion("balance~PROP-4~alice").Value; v != "40" {
		t.Fatalf("alice must be 40, got %q", v)
	}
}

// 5. Endorsement policy violation: missing required MSP is caught by the VS.
func TestEndorsementPolicyRejected(t *testing.T) {
	p, _, _, _ := newTestPipeline()
	proposal, rw, endorsements, refs, pd, err := p.LP.Endorse("MintPropertyTokens", []string{"PROP-5", "owner", "50"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	// Drop the RegistrarMSP endorsement → AND(OriginatorMSP, RegistrarMSP) unsatisfied.
	kept := endorsements[:1]
	seq, leader := p.Order.Order()
	res := p.CP.Commit("MintPropertyTokens", []string{"PROP-5", "owner", "50"}, proposal, rw, kept, refs, pd, uint64(leader), seq)
	if res.Committed || res.Stage != "validation-service" || !strings.Contains(res.Reason, "not satisfied") {
		t.Fatalf("VS must reject on policy: %+v", res)
	}
}

//  6. Signature verification: tampering with the proposal after endorsement
//     invalidates every signature (VS rejects).
func TestTamperedProposalRejected(t *testing.T) {
	p, _, _, _ := newTestPipeline()
	p.Submit("MintPropertyTokens", []string{"PROP-6", "a", "10"}, nil)
	proposal, rw, endorsements, refs, pd, err := p.LP.Endorse("TransferTokens", []string{"PROP-6", "a", "b", "1"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	tampered := proposal[:len(proposal)-1] + "X" // flip the last digest char
	if tampered == proposal {
		t.Fatal("tamper should change the proposal string")
	}
	seq, leader := p.Order.Order()
	res := p.CP.Commit("TransferTokens", []string{"PROP-6", "a", "b", "1"}, tampered, rw, endorsements, refs, pd, uint64(leader), seq)
	if res.Committed || res.Stage != "validation-service" || !strings.Contains(res.Reason, "invalid signature") {
		t.Fatalf("VS must catch tampering: %+v", res)
	}
}

//  7. Transient store (KeyDB): private data crosses LP → CP, is hashed into the
//     signed proposal and the block, and is never persisted (consumed on apply).
func TestTransientPrivateDataLifecycle(t *testing.T) {
	p, _, transient, chain := newTestPipeline()
	priv := map[string]map[string][]byte{
		"InvestorMSP": {"pan": []byte("ABCPX1234F"), "aadhaarLast4": []byte("4321")},
	}
	p.Submit("MintPropertyTokens", []string{"PROP-7", "a", "100"}, nil)
	res, err := p.Submit("TransferTokens", []string{"PROP-7", "a", "b", "1"}, priv)
	if err != nil || !res.Committed {
		t.Fatalf("tx with private data should commit: %+v err=%v", res, err)
	}
	if res.PrivateHash == "" {
		t.Fatal("block must record the private-data hash")
	}
	if transient.Size() != 0 {
		t.Fatalf("transient store must be consumed after commit, size=%d", transient.Size())
	}
	// The committed txn carries the hash, never the values.
	blk := chain.Blocks[res.BlockHeight]
	raw, _ := json.Marshal(blk.Txns)
	if strings.Contains(string(raw), "ABCPX1234F") {
		t.Fatal("private data leaked into the ledger!")
	}
}

// 8. Orderer: deterministic Raft-style leader rotation + sequence.
func TestOrdererRotation(t *testing.T) {
	o := NewOrderer(3)
	s1, l1 := o.Order()
	s2, l2 := o.Order()
	s3, l3 := o.Order()
	if s2 != s1+1 || s3 != s2+1 {
		t.Fatalf("sequence must increment: %d %d %d", s1, s2, s3)
	}
	if l1 != 1 || l2 != 2 || l3 != 3 {
		t.Fatalf("leader should rotate 1,2,3: %d %d %d", l1, l2, l3)
	}
}

// 9. End-to-end story: mint → transfer → conflicting tx rejected → chain verifies.
func TestPipelineStoryIntegrity(t *testing.T) {
	p, _, _, chain := newTestPipeline()
	p.Submit("MintPropertyTokens", []string{"PROP-9", "o", "500"}, nil)
	p.Submit("TransferTokens", []string{"PROP-9", "o", "i1", "200"}, nil)
	p.Submit("DistributeYield", []string{"PROP-9", "1250"}, nil)
	if _, err := p.Submit("TransferTokens", []string{"PROP-9", "o", "i2", "999999"}, nil); err == nil {
		t.Fatal("overdraft must fail")
	}
	p.Submit("FreezeProperty", []string{"PROP-9"}, nil)
	if v := p.CP.State.GetVersion("property~PROP-9").Value; v != "FROZEN" {
		t.Fatalf("freeze not applied: %q", v)
	}
	if !chain.Verify().Valid {
		t.Fatal("chain must verify after the full story")
	}
}
