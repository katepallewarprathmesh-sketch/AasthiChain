package drunix

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestServerEndpoints(t *testing.T) {
	s := NewServer(NewMockLedger())
	h := s.Router()

	// health
	r := httptest.NewRecorder()
	h.ServeHTTP(r, httptest.NewRequest("GET", "/health", nil))
	if r.Code != 200 || !strings.Contains(r.Body.String(), `"golang"`) {
		t.Fatalf("health: %d %s", r.Code, r.Body.String())
	}

	// submit
	r = httptest.NewRecorder()
	body := `{"chaincode":"aasthichain","function":"SettleDvP","args":["PAY-9","UTR-9","PROP-1","originator1","investor1"],"creatorMsp":"InvestorMSP"}`
	h.ServeHTTP(r, httptest.NewRequest("POST", "/drunix/submit", strings.NewReader(body)))
	if r.Code != 201 {
		t.Fatalf("submit: %d %s", r.Code, r.Body.String())
	}
	var rec TxRecord
	if err := json.Unmarshal(r.Body.Bytes(), &rec); err != nil || rec.TxID == "" {
		t.Fatalf("submit decode: %v", err)
	}

	// get tx
	r = httptest.NewRecorder()
	h.ServeHTTP(r, httptest.NewRequest("GET", "/drunix/tx/"+rec.TxID, nil))
	if r.Code != 200 || !strings.Contains(r.Body.String(), "SettlementRecorded") {
		t.Fatalf("get tx: %d %s", r.Code, r.Body.String())
	}

	// ledger status
	r = httptest.NewRecorder()
	h.ServeHTTP(r, httptest.NewRequest("GET", "/drunix/ledger/status", nil))
	if r.Code != 200 || !strings.Contains(r.Body.String(), `"height":2`) {
		t.Fatalf("status: %d %s", r.Code, r.Body.String())
	}

	// fraud score
	r = httptest.NewRecorder()
	fb := `{"payment":{"paymentId":"NPCI-X","payerId":"investor1","payerVpa":"demo.investor@aasthichain","payeeVpa":"originator1@aasthichain","amountINR":5000},"history":{"kycVerified":true,"txnCount10m":1}}`
	h.ServeHTTP(r, httptest.NewRequest("POST", "/fraud/score", strings.NewReader(fb)))
	if r.Code != 200 || !strings.Contains(r.Body.String(), `"APPROVE"`) {
		t.Fatalf("fraud: %d %s", r.Code, r.Body.String())
	}
}
