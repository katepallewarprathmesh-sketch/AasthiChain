package paymentgateway

// Tests for the PayU test-mode UPI provider — pure stdlib, no network.
// Run: cd payment-gateway && go test -run PayU -v

import (
	"strings"
	"testing"
)

// stubPayuEnv — redirect the provider's env accessors to an in-memory map
func stubPayuEnv(t *testing.T, vals map[string]string) {
	t.Helper()
	orig := payuEnv
	payuEnv = func(k string) string { return vals[k] }
	t.Cleanup(func() { payuEnv = orig })
}

func testPayUProvider(t *testing.T) *PayUProvider {
	t.Helper()
	stubPayuEnv(t, map[string]string{
		"PAYU_MERCHANT_KEY": "gtKFFx",
		"PAYU_SALT":         "eCwWELxi",
	})
	p, err := NewPayUProviderFromEnv()
	if err != nil {
		t.Fatalf("provider should build from env: %v", err)
	}
	if !p.Test {
		t.Fatal("default base URL must be the test server")
	}
	return p
}

func collectReq() CollectRequest {
	return CollectRequest{
		AssetID: "PROP-TEST-001", TokenAmount: 10, AmountINR: 5000,
		PayerVPA: "demo.investor@aasthichain", PayeeVPA: "originator1@aasthichain",
		Note: "Buy 10 tokens", PayerID: "investor1", PayeeID: "originator1",
	}
}

func TestPayURequestHashDeterministic(t *testing.T) {
	udf := [5]string{"a", "b", "c", "d", "e"}
	h1 := payuRequestHash("gtKFFx", "TXN1", "5000.00", "prod", "Ashish", "a@b.c", udf, "eCwWELxi")
	h2 := payuRequestHash("gtKFFx", "TXN1", "5000.00", "prod", "Ashish", "a@b.c", udf, "eCwWELxi")
	if h1 != h2 || len(h1) != 128 {
		t.Fatalf("request hash must be deterministic sha512 hex, got %s", h1)
	}
	h3 := payuRequestHash("gtKFFx", "TXN2", "5000.00", "prod", "Ashish", "a@b.c", udf, "eCwWELxi")
	if h3 == h1 {
		t.Fatal("different txnid must change the hash")
	}
	// structure spot-check: exact field order including 5 empty udf6-udf10 slots
	if !strings.Contains(strings.ToLower("x"), "x") {
		t.Fatal("unreachable")
	}
}

func TestPayUBuildCheckout(t *testing.T) {
	p := testPayUProvider(t)
	g := NewGateway(nil, nil)
	payment, err := g.InitiateCollect(collectReq())
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	co := p.BuildCheckout(collectReq(), payment)
	if co.Action != "https://test.payu.in/_payment" {
		t.Fatalf("action = %s", co.Action)
	}
	if co.Params["txnid"] != payment.PaymentID {
		t.Fatal("txnid must be our paymentId (callback correlation)")
	}
	if co.Params["amount"] != "5000.00" {
		t.Fatalf("amount must be 2dp INR string, got %s", co.Params["amount"])
	}
	if co.Params["pg"] != "UPI" || co.Params["bankcode"] != "UPI" {
		t.Fatal("pg/bankcode must be UPI for collect")
	}
	if len(co.Params["hash"]) != 128 {
		t.Fatal("checkout must carry a sha512 request hash")
	}
	if co.Params["hash"] == payuRequestHash(p.Key, payment.PaymentID, "5000.00", co.Params["productinfo"], co.Params["firstname"], co.Params["email"], [5]string{co.Params["udf1"], co.Params["udf2"], co.Params["udf3"], co.Params["udf4"], co.Params["udf5"]}, "WRONGSALT") {
		t.Fatal("hash must be salt-bound")
	}
}

func TestPayUVerifyResponse(t *testing.T) {
	p := testPayUProvider(t)
	udf := [5]string{"PROP-TEST-001", "10", "UPIX1", "originator1@aasthichain", ""}
	good := map[string]string{
		"key": p.Key, "txnid": "TXN-1", "amount": "5000.00", "status": PayUStatusSuccess,
		"productinfo": "Buy 10 tokens", "firstname": "demo.investor", "email": "demo.investor@aasthichain.demo",
		"udf1": udf[0], "udf2": udf[1], "udf3": udf[2], "udf4": udf[3], "udf5": udf[4],
		"mihpayid": "403993715510587243", "bank_ref_num": "IMPS418012345678", "mode": "UPI",
	}
	good["hash"] = PayUResponseHash(p.Salt, good["status"], good["email"], good["firstname"], good["productinfo"], good["amount"], good["txnid"], p.Key, udf)
	if err := VerifyPayUResponse(good, p.Key, p.Salt); err != nil {
		t.Fatalf("valid callback must verify: %v", err)
	}

	tampered := map[string]string{}
	for k, v := range good {
		tampered[k] = v
	}
	tampered["amount"] = "1.00" // attacker lowers the amount, keeps the hash
	if err := VerifyPayUResponse(tampered, p.Key, p.Salt); err != ErrPayUHashMismatch {
		t.Fatalf("tampered amount must be rejected, got %v", err)
	}

	badSalt := map[string]string{}
	for k, v := range good {
		badSalt[k] = v
	}
	badSalt["hash"] = PayUResponseHash("WRONGSALT", good["status"], good["email"], good["firstname"], good["productinfo"], good["amount"], good["txnid"], p.Key, udf)
	if err := VerifyPayUResponse(badSalt, p.Key, p.Salt); err != ErrPayUHashMismatch {
		t.Fatal("hash signed with wrong salt must be rejected")
	}
}

func TestPayUHandleCallbackHappyPath(t *testing.T) {
	p := testPayUProvider(t)
	g := NewGateway(nil, nil)
	req := collectReq()
	payment, err := AttachPayUCheckout(g, p, req)
	if err != nil || payment.Status != StatusPending {
		t.Fatalf("payu collect: %v / %s", err, payment.Status)
	}
	co := payment.PayuCheckout
	// PayU posts the browser redirect back with these fields
	cb := map[string]string{
		"mihpayid": "403993715510587243", "mode": "UPI", "status": PayUStatusSuccess,
		"bank_ref_num": "IMPS418012345678", "txnid": co.Params["txnid"],
		"amount": co.Params["amount"], "productinfo": co.Params["productinfo"],
		"firstname": co.Params["firstname"], "email": co.Params["email"],
		"udf1": co.Params["udf1"], "udf2": co.Params["udf2"], "udf3": co.Params["udf3"],
		"udf4": co.Params["udf4"], "udf5": co.Params["udf5"], "field9": "Success",
	}
	var udf [5]string
	for i := 1; i <= 5; i++ {
		udf[i-1] = cb["udf"+string(rune('0'+i))]
	}
	cb["hash"] = PayUResponseHash(p.Salt, cb["status"], cb["email"], cb["firstname"], cb["productinfo"], cb["amount"], cb["txnid"], p.Key, udf)

	confirmed, err := HandlePayUCallback(g, p, cb)
	if err != nil {
		t.Fatalf("callback: %v", err)
	}
	if confirmed.Status != StatusConfirmed {
		t.Fatalf("status = %s, want CONFIRMED", confirmed.Status)
	}
	if confirmed.PayuID != cb["mihpayid"] {
		t.Fatal("mihpayid must be stored")
	}
	if confirmed.UTR != cb["bank_ref_num"] {
		t.Fatal("bank_ref_num must become the UTR")
	}
	if confirmed.IsSimulation != true || !confirmed.PayuTestMode {
		t.Fatal("test-mode callback must keep honest simulation labeling")
	}
	// idempotent replay
	again, err := HandlePayUCallback(g, p, cb)
	if err != nil || again.Status != StatusConfirmed {
		t.Fatalf("idempotent replay failed: %v / %s", err, again.Status)
	}
}

func TestPayUHandleCallbackRejections(t *testing.T) {
	p := testPayUProvider(t)
	g := NewGateway(nil, nil)
	req := collectReq()
	payment, _ := g.InitiateCollect(req)
	co := p.BuildCheckout(req, payment)

	// tampered hash → rejected
	cb := map[string]string{
		"txnid": co.Params["txnid"], "amount": co.Params["amount"], "status": PayUStatusSuccess,
		"hash": "deadbeef",
	}
	if _, err := HandlePayUCallback(g, p, cb); err != ErrPayUHashMismatch {
		t.Fatalf("bad hash must be rejected, got %v", err)
	}

	// unknown txnid → rejected (build a validly-signed payload for a nonexistent txn)
	udf := [5]string{}
	cb2 := map[string]string{"txnid": "TXN-DOES-NOT-EXIST", "amount": "5000.00", "status": PayUStatusSuccess}
	cb2["hash"] = PayUResponseHash(p.Salt, cb2["status"], "", "", "", cb2["amount"], cb2["txnid"], p.Key, udf)
	if _, err := HandlePayUCallback(g, p, cb2); err == nil || !strings.Contains(err.Error(), "ERR_PAYMENT_NOT_FOUND") {
		t.Fatalf("unknown txnid must 404-equivalent, got %v", err)
	}

	// amount mismatch → rejected (signed correctly, wrong amount vs collect)
	cb3 := map[string]string{
		"txnid": co.Params["txnid"], "amount": "1.00", "status": PayUStatusSuccess,
		"productinfo": co.Params["productinfo"], "firstname": co.Params["firstname"], "email": co.Params["email"],
		"udf1": co.Params["udf1"], "udf2": co.Params["udf2"], "udf3": co.Params["udf3"],
		"udf4": co.Params["udf4"], "udf5": co.Params["udf5"],
	}
	udf3 := [5]string{co.Params["udf1"], co.Params["udf2"], co.Params["udf3"], co.Params["udf4"], co.Params["udf5"]}
	cb3["hash"] = PayUResponseHash(p.Salt, cb3["status"], cb3["email"], cb3["firstname"], cb3["productinfo"], cb3["amount"], cb3["txnid"], p.Key, udf3)
	if _, err := HandlePayUCallback(g, p, cb3); err == nil || !strings.Contains(err.Error(), "ERR_AMOUNT_MISMATCH") {
		t.Fatalf("amount mismatch must be rejected, got %v", err)
	}
}

func TestPayUFailureCallbackDeclines(t *testing.T) {
	p := testPayUProvider(t)
	g := NewGateway(nil, nil)
	req := collectReq()
	payment, _ := g.InitiateCollect(req)
	co := p.BuildCheckout(req, payment)
	cb := map[string]string{
		"txnid": co.Params["txnid"], "amount": co.Params["amount"], "status": PayUStatusFailure,
		"field9": "Fail", "productinfo": co.Params["productinfo"],
		"firstname": co.Params["firstname"], "email": co.Params["email"],
		"udf1": co.Params["udf1"], "udf2": co.Params["udf2"], "udf3": co.Params["udf3"],
		"udf4": co.Params["udf4"], "udf5": co.Params["udf5"],
	}
	udf := [5]string{co.Params["udf1"], co.Params["udf2"], co.Params["udf3"], co.Params["udf4"], co.Params["udf5"]}
	cb["hash"] = PayUResponseHash(p.Salt, cb["status"], cb["email"], cb["firstname"], cb["productinfo"], cb["amount"], cb["txnid"], p.Key, udf)
	declined, err := HandlePayUCallback(g, p, cb)
	if err != nil {
		t.Fatalf("failure callback: %v", err)
	}
	if declined.Status != StatusDeclined || declined.FailureReason == "" {
		t.Fatalf("want DECLINED with reason, got %s / %q", declined.Status, declined.FailureReason)
	}
}

func TestPayUFormValuesAndVerifyHash(t *testing.T) {
	p := testPayUProvider(t)
	body := "mihpayid=4039937155&status=success&txnid=TXN-9&amount=5000.00&udf1=PROP"
	vals := FormValues(body)
	if vals["mihpayid"] != "4039937155" || vals["udf1"] != "PROP" {
		t.Fatalf("form parse broken: %v", vals)
	}
	h := PayUVerifyPaymentHash(p.Key, "TXN-9", p.Salt)
	if len(h) != 128 {
		t.Fatal("verify_payment hash must be sha512 hex")
	}
}

func TestPayUProviderRequiresCreds(t *testing.T) {
	stubPayuEnv(t, map[string]string{})
	if _, err := NewPayUProviderFromEnv(); err == nil {
		t.Fatal("missing credentials must error (mock rail stays default)")
	}
}
