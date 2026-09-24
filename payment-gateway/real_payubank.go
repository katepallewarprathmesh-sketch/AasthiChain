package paymentgateway

// PayU test-mode UPI provider — "feels like real UPI" for testing.
//
// PayU India hosted checkout on the TEST server (https://test.payu.in/_payment):
//   - Real PSP API contract: SHA-512 request signing, server-side reverse-hash
//     verification of the callback, mihpayid + bank_ref_num references,
//     verify_payment S2S reconciliation — the exact production flow.
//   - Simulated settlement: no NPCI switch, no real money. PayU test VPAs:
//     test@payu succeeds, fail@payu declines (per PayU test docs).
//   - Free test key/salt from PayU Dashboard (Test Mode → Key Salt Details) —
//     no business KYC required, unlike Setu/ICICI production UPI access.
//
// Env toggle (additive — mock remains the default):
//   NPCI_MODE=payu
//   PAYU_MERCHANT_KEY=<test key>        PAYU_SALT=<test salt>
//   PAYU_BASE_URL=https://test.payu.in  (default; production = https://secure.payu.in)
//   PAYU_SURL / PAYU_FURL               (callback endpoints; default /api/npci/payu/callback)
//
// Hash sequences (PayU docs):
//   request:  sha512(key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||salt)
//   response: sha512(salt|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key)

import (
	"crypto/sha512"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	// PayU callback `status` values
	PayUStatusSuccess = "success"
	PayUStatusFailure = "failure"
	PayUStatusPending = "pending"

	// PayUCallbackPath — where PayU POSTs the browser redirect (surl/furl)
	PayUCallbackPath = "/api/npci/payu/callback"
)

// PayUProvider — test/live PayU hosted checkout for UPI Collect.
type PayUProvider struct {
	Key     string // merchant key
	Salt    string // merchant salt (never sent in the request)
	BaseURL string // https://test.payu.in (test) / https://secure.payu.in (live)
	Surl    string // success callback URL
	Furl    string // failure callback URL
	Test    bool   // true when BaseURL is the test server
}

// NewPayUProviderFromEnv builds the provider from PAYU_* env vars.
// Returns an error when credentials are absent (call sites treat PayU as inactive).
func NewPayUProviderFromEnv() (*PayUProvider, error) {
	key, salt := PayUKeyFromEnv(), PayUSaltFromEnv()
	if key == "" || salt == "" {
		return nil, errors.New("PayU not configured: need PAYU_MERCHANT_KEY and PAYU_SALT (set NPCI_MODE=payu to activate)")
	}
	base := strings.TrimRight(envPayuOr("PAYU_BASE_URL", "https://test.payu.in"), "/")
	return &PayUProvider{
		Key:     key,
		Salt:    salt,
		BaseURL: base,
		Surl:    envPayuOr("PAYU_SURL", PayUCallbackPath),
		Furl:    envPayuOr("PAYU_FURL", PayUCallbackPath),
		Test:    strings.Contains(base, "test.payu.in"),
	}, nil
}

// Env accessors (var-indirect so tests can stub without mutating process env)
var payuEnv = os.Getenv

func PayUKeyFromEnv() string  { return payuEnv("PAYU_MERCHANT_KEY") }
func PayUSaltFromEnv() string { return payuEnv("PAYU_SALT") }

func envPayuOr(k, def string) string {
	if v := payuEnv(k); v != "" {
		return v
	}
	return def
}

// PayUCheckout — the browser form the frontend auto-submits to PayU.
type PayUCheckout struct {
	Action string            `json:"action"`
	Params map[string]string `json:"params"`
}

// payuRequestHash — sha512(key|txnid|amount|productinfo|firstname|email|udf1..5||||||salt)
func payuRequestHash(key, txnid, amount, productinfo, firstname, email string, udf [5]string, salt string) string {
	seq := key + "|" + txnid + "|" + amount + "|" + productinfo + "|" + firstname + "|" + email +
		"|" + udf[0] + "|" + udf[1] + "|" + udf[2] + "|" + udf[3] + "|" + udf[4] + "||||||" + salt
	sum := sha512.Sum512([]byte(seq))
	return hex.EncodeToString(sum[:])
}

// PayUResponseHash — reverse hashing of the callback:
// sha512(salt|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key)
func PayUResponseHash(salt, status, email, firstname, productinfo, amount, txnid, key string, udf [5]string) string {
	seq := salt + "|" + status + "||||||" + udf[4] + "|" + udf[3] + "|" + udf[2] + "|" + udf[1] + "|" + udf[0] +
		"|" + email + "|" + firstname + "|" + productinfo + "|" + amount + "|" + txnid + "|" + key
	sum := sha512.Sum512([]byte(seq))
	return hex.EncodeToString(sum[:])
}

// BuildCheckout maps CollectRequest + our PENDING payment to the PayU hosted-checkout
// form. txnid = our paymentId; udf1 = assetId; udf2 = tokenAmount (echoed in the
// callback, giving tamper-evident linkage).
func (p *PayUProvider) BuildCheckout(req CollectRequest, payment *Payment) *PayUCheckout {
	firstname := strings.SplitN(req.PayerVPA, "@", 2)[0]
	email := firstname + "@aasthichain.demo"
	udf := [5]string{req.AssetID, fmt.Sprintf("%d", req.TokenAmount), payment.UpiTxnID, req.PayeeVPA, req.IdempotencyKey}
	productinfo := req.Note
	if productinfo == "" {
		productinfo = fmt.Sprintf("%d tokens of %s", req.TokenAmount, req.AssetID)
	}
	amount := fmt.Sprintf("%.2f", req.AmountINR)
	params := map[string]string{
		"key":         p.Key,
		"txnid":       payment.PaymentID,
		"amount":      amount,
		"productinfo": productinfo,
		"firstname":   firstname,
		"email":       email,
		"phone":       "9999999999",
		"pg":          "UPI",
		"bankcode":    "UPI",
		"vpa":         req.PayerVPA,
		"surl":        p.Surl,
		"furl":        p.Furl,
		"udf1":        udf[0],
		"udf2":        udf[1],
		"udf3":        udf[2],
		"udf4":        udf[3],
		"udf5":        udf[4],
	}
	params["hash"] = payuRequestHash(p.Key, payment.PaymentID, amount, productinfo, firstname, email, udf, p.Salt)
	return &PayUCheckout{Action: p.BaseURL + "/_payment", Params: params}
}

// AttachPayUCheckout — wrap Gateway.InitiateCollect and attach the PayU checkout
// form to the returned PENDING payment. The Payment stays the source of truth
// (same state machine as the mock rail: PENDING → CONFIRMED → RELEASED).
func AttachPayUCheckout(g *Gateway, p *PayUProvider, req CollectRequest) (*Payment, error) {
	payment, err := g.InitiateCollect(req)
	if err != nil && payment == nil {
		return nil, err
	}
	if payment != nil && payment.Status == StatusPending {
		payment.IsSimulation = p.Test // test server settles simulated — honest labeling
		payment.PayuTestMode = p.Test
		payment.Provider = "payu"
		payment.PayuCheckout = p.BuildCheckout(req, payment)
	}
	return payment, err
}

// ErrPayUHashMismatch — callback failed reverse-hash verification (tampered payload or wrong salt)
var ErrPayUHashMismatch = errors.New("ERR_PAYU_HASH_MISMATCH: callback hash verification failed — payload rejected")

func constTimeEq(a, b string) bool {
	return len(a) == len(b) && subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// VerifyPayUResponse — constant-time reverse-hash check of a browser-redirect callback.
// A nil error proves the callback came from PayU (salt knowledge) and was not tampered.
func VerifyPayUResponse(params map[string]string, key, salt string) error {
	get := func(k string) string { return strings.TrimSpace(params[k]) }
	udf := [5]string{get("udf1"), get("udf2"), get("udf3"), get("udf4"), get("udf5")}
	want := PayUResponseHash(salt, get("status"), get("email"), get("firstname"), get("productinfo"), get("amount"), get("txnid"), key, udf)
	if !constTimeEq(want, get("hash")) {
		return ErrPayUHashMismatch
	}
	return nil
}

func parsePayUAmount(s string) (float64, bool) {
	f, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	return f, err == nil
}

// HandlePayUCallback — verify, reconcile amount, and advance the payment state
// machine. Idempotent: repeating the same callback returns the current payment
// without double-processing. PayU field mapping:
//
//	mihpayid → payment.PayuID, bank_ref_num → payment.UTR/RRN,
//	status success → CONFIRMED, failure → DECLINED, pending → stays PENDING.
func HandlePayUCallback(g *Gateway, p *PayUProvider, params map[string]string) (*Payment, error) {
	if err := VerifyPayUResponse(params, p.Key, p.Salt); err != nil {
		return nil, err
	}
	txnid := strings.TrimSpace(params["txnid"])
	payment, err := g.GetPayment(txnid)
	if err != nil {
		return nil, fmt.Errorf("ERR_PAYMENT_NOT_FOUND: txnid %s not found — collect first", txnid)
	}
	if payment.Status != StatusPending {
		return payment, nil // idempotent — already CONFIRMED/RELEASED/REFUNDED/DECLINED
	}
	// Amount reconciliation — critical for DvP (same rule as the mock webhook)
	if amt, ok := parsePayUAmount(params["amount"]); ok {
		if diff := amt - payment.AmountINR; diff > 0.01 || diff < -0.01 {
			return nil, fmt.Errorf("ERR_AMOUNT_MISMATCH: expected ₹%.2f got ₹%.2f", payment.AmountINR, amt)
		}
	}
	g.mu.Lock()
	stored, ok := g.payments[payment.PaymentID]
	if !ok {
		g.mu.Unlock()
		return nil, errors.New("payment vanished mid-callback")
	}
	defer g.mu.Unlock()
	switch strings.ToLower(strings.TrimSpace(params["status"])) {
	case PayUStatusSuccess:
		now := time.Now()
		stored.Status = StatusConfirmed
		stored.ConfirmedAt = &now
		stored.PayuID = strings.TrimSpace(params["mihpayid"])
		stored.IsSimulation = p.Test // real money only on the live server
		if ref := strings.TrimSpace(params["bank_ref_num"]); ref != "" {
			stored.UTR = ref
			stored.RRN = ref // PayU's bank reference number is the RRN/UTR-equivalent
		}
		if mode := strings.TrimSpace(params["mode"]); mode != "" {
			stored.Note = strings.TrimSpace(stored.Note + " [PayU mode:" + mode + "]")
		}
	case PayUStatusFailure:
		stored.Status = StatusDeclined
		if f9 := strings.TrimSpace(params["field9"]); f9 != "" {
			stored.FailureReason = "PayU: " + f9
		} else {
			stored.FailureReason = "PayU test decline (fail@payu VPA)"
		}
	default: // pending — PayU retries / verify_payment settles it later
		return payment, nil
	}
	cp := *stored
	return &cp, nil
}

// PayUVerifyPaymentHash — S2S verify_payment service hash: sha512(key|verify_payment|txnid|salt)
func PayUVerifyPaymentHash(key, txnid, salt string) string {
	sum := sha512.Sum512([]byte(key + "|verify_payment|" + txnid + "|" + salt))
	return hex.EncodeToString(sum[:])
}

// FormValues — parse an application/x-www-form-urlencoded callback body.
func FormValues(body string) map[string]string {
	vals, _ := url.ParseQuery(strings.TrimSpace(body))
	out := make(map[string]string, len(vals))
	for k, v := range vals {
		if len(v) > 0 {
			out[k] = v[0]
		}
	}
	return out
}
