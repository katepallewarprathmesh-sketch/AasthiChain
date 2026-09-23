package drunix

import (
	"testing"
)

func TestSubmitLifecycleCommitted(t *testing.T) {
	l := NewMockLedger()
	rec, err := l.SubmitTransaction(ChaincodeName, "TransferTokens",
		[]string{"PROP-1", "originator1", "investor1", "100"}, "InvestorMSP")
	if err != nil {
		t.Fatalf("submit: %v", err)
	}
	if rec.Status != TxStatusCommitted {
		t.Fatalf("status = %s, want COMMITTED", rec.Status)
	}
	if rec.ValidationCode != ValidationCodeOK {
		t.Fatalf("validationCode = %d, want 0", rec.ValidationCode)
	}
	if rec.Event == nil || rec.Event.Name != "TokenTransferred" {
		t.Fatalf("event = %+v, want TokenTransferred", rec.Event)
	}
	if len(rec.WriteSet) == 0 {
		t.Fatal("write set empty")
	}
	st, _ := l.LedgerStatus()
	if st.Height != 2 || st.TxCount != 1 { // genesis 1 + one commit
		t.Fatalf("height=%d txCount=%d, want 2/1", st.Height, st.TxCount)
	}
}

func TestDeterministicTxID(t *testing.T) {
	a, _ := NewMockLedger().SubmitTransaction(ChaincodeName, "SettleDvP",
		[]string{"PAY-1", "UTR-1", "PROP-1", "a", "b"}, "InvestorMSP")
	b, _ := NewMockLedger().SubmitTransaction(ChaincodeName, "SettleDvP",
		[]string{"PAY-1", "UTR-1", "PROP-1", "a", "b"}, "InvestorMSP")
	// Same inputs -> same txID (replay across demo runs is reproducible).
	if a.TxID != b.TxID {
		t.Fatalf("txIDs differ for identical inputs: %s vs %s", a.TxID[:12], b.TxID[:12])
	}
}

func TestEvaluateConsumesNoBlock(t *testing.T) {
	l := NewMockLedger()
	before, _ := l.LedgerStatus()
	if _, err := l.EvaluateTransaction(ChaincodeName, "GetBalance", []string{"PROP-1", "investor1"}, "InvestorMSP"); err != nil {
		t.Fatalf("evaluate: %v", err)
	}
	after, _ := l.LedgerStatus()
	if after.Height != before.Height {
		t.Fatalf("evaluate consumed a block: %d -> %d", before.Height, after.Height)
	}
}

func TestGetTransactionNotFound(t *testing.T) {
	if _, err := NewMockLedger().GetTransaction("missing"); err == nil {
		t.Fatal("expected error for missing tx")
	}
}
