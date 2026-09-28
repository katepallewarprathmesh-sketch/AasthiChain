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

// signEnv runs phases 1-2 without submitting: LP endorsement + client signature.
func signEnv(p *Pipeline, fn string, args []string, private map[string]map[string][]byte) *Envelope {
	proposal, rw, ends, refs, pd, err := p.LP.Endorse(fn, args, private)
	if err != nil {
		panic(err)
	}
	return p.Client.Sign(fn, args, proposal, rw, ends, refs, pd)
}

// commitDirect drives phases 3-5 for a pre-signed envelope.
func commitDirect(p *Pipeline, env *Envelope) *TxOutcome {
	p.Order.Submit(env)
	var out *TxOutcome
	for b := p.Order.Cut(); b != nil; b = p.Order.Cut() {
		for e, o := range p.CP.ProcessBlock(b) {
			if e == env {
				out = o
			}
		}
	}
	return out
}

// ---------- Phase 1 + full happy path ----------

// 1. Full 5-phase happy path: mint under AND(OriginatorMSP, RegistrarMSP).
func TestPipelineMintCommits(t *testing.T) {
	p, state, transient, chain := newTestPipeline()
	res, err := p.Submit("MintPropertyTokens", []string{"PROP-1", "originator1", "1000"}, nil)
	if err != nil || !res.Committed {
		t.Fatalf("mint should commit: %+v err=%v", res, err)
	}
	if res.Stage != "committed" || res.BlockHeight < 1 {
		t.Fatalf("expected committed with block height, got %+v", res)
	}
	// 5-phase trace must be complete
	want := []string{"1-endorsed", "2-signed", "3-ordered", "4-validated", "5-committed"}
	if len(res.Phases) != 5 {
		t.Fatalf("expected 5 phases, got %v", res.Phases)
	}
	for i, ph := range want {
		if res.Phases[i] != ph {
			t.Fatalf("phase %d = %s, want %s", i, res.Phases[i], ph)
		}
	}
	if res.VSNode != "vs-1" {
		t.Fatalf("first validation should run on vs-1, got %q", res.VSNode)
	}
	if res.BlockSeq < 1 {
		t.Fatalf("block sequence not recorded: %d", res.BlockSeq)
	}
	if got := state.GetVersion("balance~PROP-1~originator1"); got.Value != "1000" || got.Version != 1 {
		t.Fatalf("state not applied: %+v", got)
	}
	if len(res.EndorsedBy) != 2 {
		t.Fatalf("expected 2 endorsers, got %v", res.EndorsedBy)
	}
	if transient.Size() != 0 {
		t.Fatalf("transient store should be empty after commit, size=%d", transient.Size())
	}
	if !chain.Verify().Valid {
		t.Fatal("chain must verify after pipeline commit")
	}
	blk := chain.Blocks[res.BlockHeight]
	if blk.Type != "TX_COMMITTED" || blk.Txns[0]["mvcc"] != "validated" || blk.Txns[0]["vscc"] != "policy-accepted" {
		t.Fatalf("block missing pipeline evidence: %+v", blk.Txns[0])
	}
	if blk.Txns[0]["client"] != "aasthi-gateway" {
		t.Fatalf("block must record the signing client: %+v", blk.Txns[0]["client"])
	}
}

// 2. TransferTokens balance math across state versions.
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

// 3. Double-spend stopped at ENDORSEMENT (Phase 1, before ordering).
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

//  4. Phase 3+4: two txns batched into ONE block; the second conflicts with
//     the first (same-block MVCC) and is rejected by the Committing Peer.
func TestMVCCReadConflictSameBlock(t *testing.T) {
	p, _, _, _ := newTestPipeline()
	p.Submit("MintPropertyTokens", []string{"PROP-4", "alice", "100"}, nil)

	env1 := signEnv(p, "TransferTokens", []string{"PROP-4", "alice", "bob", "60"}, nil)
	env2 := signEnv(p, "TransferTokens", []string{"PROP-4", "alice", "carol", "60"}, nil)
	if env1.RW.Reads["balance~PROP-4~alice"] != env2.RW.Reads["balance~PROP-4~alice"] {
		t.Fatal("both txs must read the same version to constitute a conflict")
	}

	// Orderer BATCHES both into one block (Phase 3)...
	p.Order.Submit(env1)
	p.Order.Submit(env2)
	blk := p.Order.Cut()
	if len(blk.Envelopes) != 2 {
		t.Fatalf("orderer should batch 2 txns into one block, got %d", len(blk.Envelopes))
	}
	// ...and the CP processes it (Phases 4-5): first valid, second MVCC-conflict.
	outs := p.CP.ProcessBlock(blk)
	if !outs[env1].Committed {
		t.Fatalf("first tx should commit: %+v", outs[env1])
	}
	if outs[env2].Committed || outs[env2].Stage != "committing-peer-mvcc" || !strings.Contains(outs[env2].Reason, "READ_CONFLICT") {
		t.Fatalf("second tx must fail MVCC, got %+v", outs[env2])
	}
	if v := p.CP.State.GetVersion("balance~PROP-4~carol").Value; v != "" {
		t.Fatalf("carol must receive nothing, got %q", v)
	}
	if v := p.CP.State.GetVersion("balance~PROP-4~alice").Value; v != "40" {
		t.Fatalf("alice must be 40, got %q", v)
	}
}

// 5. Cross-block conflict: two Submits, each its own block, second still fails.
func TestMVCCReadConflictAcrossBlocks(t *testing.T) {
	p, _, _, _ := newTestPipeline()
	p.Submit("MintPropertyTokens", []string{"PROP-4b", "alice", "100"}, nil)
	env1 := signEnv(p, "TransferTokens", []string{"PROP-4b", "alice", "bob", "50"}, nil)
	env2 := signEnv(p, "TransferTokens", []string{"PROP-4b", "alice", "carol", "50"}, nil) // simulated BEFORE tx1 commits
	out1 := commitDirect(p, env1)
	if !out1.Committed {
		t.Fatalf("first should commit: %+v", out1)
	}
	out2 := commitDirect(p, env2) // stale read versions land in a LATER block
	if out2.Committed || out2.Stage != "committing-peer-mvcc" || !strings.Contains(out2.Reason, "READ_CONFLICT") {
		t.Fatalf("stale simulation must fail MVCC: %+v", out2)
	}
}

// 6. Phase 4 (VS): endorsement policy violation caught by the round-robin VS.
func TestEndorsementPolicyRejected(t *testing.T) {
	p, _, _, _ := newTestPipeline()
	p.Submit("MintPropertyTokens", []string{"PROP-5", "owner", "50"}, nil)
	proposal, rw, endorsements, refs, pd, err := p.LP.Endorse("MintPropertyTokens", []string{"PROP-5b", "owner", "50"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	env := p.Client.Sign("MintPropertyTokens", []string{"PROP-5b", "owner", "50"}, proposal, rw, endorsements[:1], refs, pd)
	out := commitDirect(p, env)
	if out.Committed || out.Stage != "validation-service" || !strings.Contains(out.Reason, "not satisfied") {
		t.Fatalf("VS must reject on policy: %+v", out)
	}
}

//  7. Phase 4 (VS): tampering with the proposal after endorsement breaks the
//     endorsement signatures.
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
	env := p.Client.Sign("TransferTokens", []string{"PROP-6", "a", "b", "1"}, tampered, rw, endorsements, refs, pd)
	out := commitDirect(p, env)
	if out.Committed || out.Stage != "validation-service" || !strings.Contains(out.Reason, "invalid signature") {
		t.Fatalf("VS must catch tampering: %+v", out)
	}
}

// 8. Phase 2/4: a broken client signature is caught by the VS.
func TestClientSignatureRejected(t *testing.T) {
	p, _, _, _ := newTestPipeline()
	p.Submit("MintPropertyTokens", []string{"PROP-6b", "a", "10"}, nil)
	env := signEnv(p, "TransferTokens", []string{"PROP-6b", "a", "b", "1"}, nil)
	env.ClientSig = strings.Repeat("0", len(env.ClientSig))
	out := commitDirect(p, env)
	if out.Committed || out.Stage != "validation-service" || !strings.Contains(out.Reason, "invalid client signature") {
		t.Fatalf("VS must verify the client signature: %+v", out)
	}
}

//  9. Transient store (KeyDB, Phase 1): private data crosses LP to CP, is
//     hashed into the signed proposal and the block, never persisted.
func TestTransientPrivateDataLifecycle(t *testing.T) {
	p, _, transient, _ := newTestPipeline()
	priv := map[string]map[string][]byte{
		"InvestorMSP": {"pan": []byte("ABCPX1234F"), "aadhaarLast4": []byte("4321")},
	}
	// transfer BEFORE mint: fails at LP, but leaves the private entries behind
	res, err := p.Submit("TransferTokens", []string{"PROP-7", "a", "b", "1"}, priv)
	if err == nil || res.Committed {
		t.Fatal("transfer before mint must fail at the Lite Peer")
	}
	if transient.Size() != 0 {
		t.Fatalf("failed simulation must not leave private data in KeyDB, size=%d", transient.Size())
	}
	// fresh pipeline, correct order: mint then transfer with private data
	p2, _, transient2, chain2 := newTestPipeline()
	p2.Submit("MintPropertyTokens", []string{"PROP-7", "a", "100"}, nil)
	res2, err := p2.Submit("TransferTokens", []string{"PROP-7", "a", "b", "1"}, priv)
	if err != nil || !res2.Committed {
		t.Fatalf("tx with private data should commit: %+v err=%v", res2, err)
	}
	if res2.PrivateHash == "" {
		t.Fatal("block must record the private-data hash")
	}
	if transient2.Size() != 0 {
		t.Fatalf("committed pipeline must consume its private entries, size=%d", transient2.Size())
	}
	raw, _ := json.Marshal(chain2.Blocks[res2.BlockHeight].Txns)
	if strings.Contains(string(raw), "ABCPX1234F") {
		t.Fatal("private data leaked into the ledger!")
	}
}

// 10. Phase 3: orderer batches txns into blocks (auto-cut at BatchMax).
func TestOrdererBatchesIntoBlocks(t *testing.T) {
	p, _, _, _ := newTestPipeline()
	p.Order.BatchMax = 2
	e1 := signEnv(p, "MintPropertyTokens", []string{"P-a", "o", "1"}, nil)
	e2 := signEnv(p, "MintPropertyTokens", []string{"P-b", "o", "1"}, nil)
	e3 := signEnv(p, "MintPropertyTokens", []string{"P-c", "o", "1"}, nil)
	p.Order.Submit(e1)
	if p.Order.Full() {
		t.Fatal("batch of 1 must not be full")
	}
	p.Order.Submit(e2)
	if !p.Order.Full() {
		t.Fatal("batch of 2 must be full (BatchMax=2)")
	}
	blk := p.Order.Cut()
	if len(blk.Envelopes) != 2 || blk.Seq != 1 {
		t.Fatalf("block 1 should carry 2 txns, got %+v", blk)
	}
	p.Order.Submit(e3)
	blk2 := p.Order.Cut()
	if len(blk2.Envelopes) != 1 || blk2.Seq != 2 {
		t.Fatalf("block 2 should carry 1 txn, got %+v", blk2)
	}
	if p.Order.BlocksCut() != 2 || p.Order.Pending() != 0 {
		t.Fatalf("orderer counters wrong: cut=%d pending=%d", p.Order.BlocksCut(), p.Order.Pending())
	}
}

// 11. Phase 3: CP pulls consecutive blocks in order.
func TestCPPullsConsecutiveBlocks(t *testing.T) {
	p, _, _, _ := newTestPipeline()
	p.Order.BatchMax = 1
	for _, id := range []string{"x1", "x2", "x3"} {
		p.Order.Submit(signEnv(p, "MintPropertyTokens", []string{id, "o", "1"}, nil))
		p.Order.Cut()
	}
	for want := uint64(1); want <= 3; want++ {
		blk := p.CP.PullNext()
		if blk == nil || blk.Seq != want {
			t.Fatalf("pull %d: got %+v", want, blk)
		}
	}
	if blk := p.CP.PullNext(); blk != nil {
		t.Fatalf("no fourth block expected, got %+v", blk)
	}
}

// 12. Phase 4: CP dispatches to the VS pool ROUND-ROBIN.
func TestVSRoundRobin(t *testing.T) {
	p, _, _, _ := newTestPipeline()
	p.Submit("MintPropertyTokens", []string{"R-1", "o", "100"}, nil)
	r1, _ := p.Submit("TransferTokens", []string{"R-1", "o", "a", "1"}, nil)
	r2, _ := p.Submit("TransferTokens", []string{"R-1", "o", "b", "1"}, nil)
	if r1.VSNode == "" || r2.VSNode == "" || r1.VSNode == r2.VSNode {
		t.Fatalf("round-robin broken: %s then %s", r1.VSNode, r2.VSNode)
	}
}

// 13. Buffered submissions batch into ONE ledger block.
func TestBufferedBatchCommitsAsOneBlock(t *testing.T) {
	p, _, _, chain := newTestPipeline()
	p.Submit("MintPropertyTokens", []string{"B-1", "o", "100"}, nil)
	h0 := len(chain.Blocks)

	r1, _ := p.SubmitBuffered("TransferTokens", []string{"B-1", "o", "i1", "10"}, nil)
	r2, _ := p.SubmitBuffered("DistributeYield", []string{"B-1", "500"}, nil)
	r3, _ := p.SubmitBuffered("FreezeProperty", []string{"B-1"}, nil)
	for _, r := range []CommitResult{r1, r2, r3} {
		if r.Committed || r.Stage != "ordered" {
			t.Fatalf("buffered txn must wait in batch: %+v", r)
		}
	}
	if len(chain.Blocks) != h0 {
		t.Fatalf("nothing must commit until Flush: height %d -> %d", h0, len(chain.Blocks))
	}
	if n := p.Flush(); n != 3 {
		t.Fatalf("flush should commit 3 txns, got %d", n)
	}
	if len(chain.Blocks) != h0+1 {
		t.Fatalf("3 buffered txns must land in ONE block: height %d -> %d", h0, len(chain.Blocks))
	}
	blk := chain.Blocks[h0]
	if len(blk.Txns) != 3 || blk.Type != "TX_COMMITTED" {
		t.Fatalf("batch block wrong: %+v", blk)
	}
	if v := p.CP.State.GetVersion("balance~B-1~o").Value; v != "90" {
		t.Fatalf("o balance = %q, want 90", v)
	}
	if v := p.CP.State.GetVersion("balance~B-1~i1").Value; v != "10" {
		t.Fatalf("i1 balance = %q, want 10", v)
	}
	if v := p.CP.State.GetVersion("property~B-1").Value; v != "FROZEN" {
		t.Fatalf("freeze not applied: %q", v)
	}
	if !chain.Verify().Valid {
		t.Fatal("chain must verify after batch commit")
	}
}

// 14. Orderer leader rotation (Raft simulated).
func TestOrdererRotation(t *testing.T) {
	o := NewOrderer(3)
	leaders := []int{}
	for i := 0; i < 3; i++ {
		seq, leader := o.Submit(&Envelope{Fn: "noop"})
		if seq != uint64(i+1) {
			t.Fatalf("sequence must increment: got %d want %d", seq, i+1)
		}
		leaders = append(leaders, leader)
	}
	if leaders[0] != 1 || leaders[1] != 2 || leaders[2] != 3 {
		t.Fatalf("leader should rotate 1,2,3: %v", leaders)
	}
}

// 15. End-to-end story: mint, transfer, yield, failed overdraft, freeze.
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
