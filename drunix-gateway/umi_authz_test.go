package drunix

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The rail used to act on whoever the URL or the body named, with no idea
// who was asking. Over HTTP that meant anyone who could reach it could read
// a stranger's wholesale CBDC wallet, credit a wallet out of nothing, or run
// a settlement that spent someone else's cash.

func authzRail(t *testing.T) http.Handler {
	t.Helper()
	srv := newTestServerWithUMI(t)
	return srv.Router()
}

func callAs(h http.Handler, method, path, identity, role string, payload interface{}) *httptest.ResponseRecorder {
	var body *bytes.Reader
	if payload != nil {
		raw, _ := json.Marshal(payload)
		body = bytes.NewReader(raw)
	} else {
		body = bytes.NewReader(nil)
	}
	r := httptest.NewRequest(method, path, body)
	r.Header.Set("Content-Type", "application/json")
	if identity != "" {
		r.Header.Set("X-Fabric-Identity", identity)
		r.Header.Set("X-Identity-Role", role)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestWalletNeedsAnIdentifiedCaller(t *testing.T) {
	h := authzRail(t)

	if w := callAs(h, http.MethodGet, "/umi/wallets/investor1", "", "", nil); w.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous wallet read = %d, want 401: %s", w.Code, w.Body.String())
	}
	if w := callAs(h, http.MethodGet, "/umi/wallets", "", "", nil); w.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous wallet list = %d, want 401", w.Code)
	}
}

func TestWalletIsNotReadableByAnotherParticipant(t *testing.T) {
	h := authzRail(t)
	if w := callAs(h, http.MethodPost, "/umi/wallets/investor1/fund", "regulator1", "Regulator",
		map[string]float64{"amountINR": 50000}); w.Code != http.StatusOK {
		t.Fatalf("supervisor funding = %d: %s", w.Code, w.Body.String())
	}

	w := callAs(h, http.MethodGet, "/umi/wallets/investor1", "investor2", "Investor", nil)
	if w.Code != http.StatusForbidden {
		t.Fatalf("stranger wallet read = %d, want 403: %s", w.Code, w.Body.String())
	}

	if w := callAs(h, http.MethodGet, "/umi/wallets/investor1", "investor1", "Investor", nil); w.Code != http.StatusOK {
		t.Fatalf("owner wallet read = %d, want 200: %s", w.Code, w.Body.String())
	}
	if w := callAs(h, http.MethodGet, "/umi/wallets/investor1", "regulator1", "Regulator", nil); w.Code != http.StatusOK {
		t.Fatalf("supervisor wallet read = %d, want 200", w.Code)
	}
}

func TestWalletListShowsOnlyYourOwn(t *testing.T) {
	h := authzRail(t)
	for _, who := range []string{"investor1", "investor2"} {
		if w := callAs(h, http.MethodPost, "/umi/wallets/"+who+"/fund", "regulator1", "Regulator",
			map[string]float64{"amountINR": 10000}); w.Code != http.StatusOK {
			t.Fatalf("funding %s = %d", who, w.Code)
		}
	}

	w := callAs(h, http.MethodGet, "/umi/wallets", "investor1", "Investor", nil)
	var resp struct {
		Wallets []CBDCWallet `json:"wallets"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	if len(resp.Wallets) != 1 || resp.Wallets[0].Participant != "investor1" {
		t.Fatalf("investor1 saw %d wallets: %+v", len(resp.Wallets), resp.Wallets)
	}

	w = callAs(h, http.MethodGet, "/umi/wallets", "regulator1", "Regulator", nil)
	json.Unmarshal(w.Body.Bytes(), &resp)
	if len(resp.Wallets) < 2 {
		t.Fatalf("supervisor saw %d wallets, want the whole book", len(resp.Wallets))
	}
}

func TestFundingIsASettlementBankAction(t *testing.T) {
	h := authzRail(t)

	// Crediting your own wallet is making money, not moving it.
	w := callAs(h, http.MethodPost, "/umi/wallets/investor1/fund", "investor1", "Investor",
		map[string]float64{"amountINR": 1000000})
	if w.Code != http.StatusForbidden {
		t.Fatalf("self-funding = %d, want 403: %s", w.Code, w.Body.String())
	}

	w = callAs(h, http.MethodPost, "/umi/wallets/investor1/fund", "investor2", "Investor",
		map[string]float64{"amountINR": 1000000})
	if w.Code != http.StatusForbidden {
		t.Fatalf("funding a stranger = %d, want 403", w.Code)
	}

	if w := callAs(h, http.MethodPost, "/umi/wallets/investor1/fund", "", "",
		map[string]float64{"amountINR": 1000000}); w.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous funding = %d, want 401", w.Code)
	}
}

func TestSettlementCannotSpendSomeoneElsesWallet(t *testing.T) {
	h := authzRail(t)
	if w := callAs(h, http.MethodPost, "/umi/wallets/investor1/fund", "regulator1", "Regulator",
		map[string]float64{"amountINR": 1000000}); w.Code != http.StatusOK {
		t.Fatalf("funding = %d: %s", w.Code, w.Body.String())
	}

	trade := map[string]interface{}{
		"assetId": "PROP-AUTHZ-001", "seller": "originator1", "buyer": "investor1",
		"tokens": 10, "pricePerTokenINR": 500,
	}

	// investor2 naming investor1 as the buyer spends investor1's money.
	w := callAs(h, http.MethodPost, "/umi/dvp", "investor2", "Investor", trade)
	if w.Code != http.StatusForbidden {
		t.Fatalf("settling against a stranger's wallet = %d, want 403: %s", w.Code, w.Body.String())
	}

	if w := callAs(h, http.MethodPost, "/umi/dvp", "", "", trade); w.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous settlement = %d, want 401", w.Code)
	}

	// A dry run prices a trade without moving anything, so it stays open.
	dry := map[string]interface{}{
		"assetId": "PROP-AUTHZ-001", "seller": "originator1", "buyer": "investor1",
		"tokens": 10, "pricePerTokenINR": 500, "dryRun": true,
	}
	if w := callAs(h, http.MethodPost, "/umi/dvp", "investor2", "Investor", dry); w.Code == http.StatusForbidden {
		t.Fatalf("dry run was refused: %s", w.Body.String())
	}
}

func TestReconciliationStaysOpen(t *testing.T) {
	h := authzRail(t)
	// The public reconciliation view is deliberately readable by anyone: it
	// is the rail proving its own books balance.
	if w := callAs(h, http.MethodGet, "/umi/reconciliation", "", "", nil); w.Code != http.StatusOK {
		t.Fatalf("anonymous reconciliation = %d, want 200: %s", w.Code, w.Body.String())
	}
}

// A sealed ledger must stop the money, not just stop the block.
//
// Production hit this: the stored chain failed verification on restore, the
// chain sealed itself and refused appends — and the rail kept answering
// fund and settlement requests with ok:true. The wallet moved in memory and
// nothing on the ledger could prove it, which is the one thing a settlement
// rail must never do.
func TestSealedLedgerRefusesMoneyMovement(t *testing.T) {
	srv := newTestServerWithUMI(t)
	// Give the wallet a history before the ledger stops accepting blocks.
	fundRec := httptest.NewRecorder()
	fundReq := httptest.NewRequest(http.MethodPost, "/umi/wallets/investor1/fund",
		strings.NewReader(`{"amountINR":5000}`))
	fundReq.Header.Set("Content-Type", "application/json")
	fundReq.Header.Set("X-Fabric-Identity", "regulator1")
	fundReq.Header.Set("X-Identity-Role", "Regulator")
	srv.Router().ServeHTTP(fundRec, fundReq)
	if fundRec.Code != http.StatusOK {
		t.Fatalf("setup funding returned %d", fundRec.Code)
	}

	chain := srv.Pipeline.CP.Ledger
	chain.mu.Lock()
	chain.sealed = true
	chain.mu.Unlock()

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/umi/wallets/investor1/fund",
		strings.NewReader(`{"amountINR":100000}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Fabric-Identity", "regulator1")
	req.Header.Set("X-Identity-Role", "Regulator")
	srv.Router().ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("funding on a sealed ledger returned %d, want 503: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "ERR_LEDGER_SEALED") {
		t.Fatalf("want ERR_LEDGER_SEALED, got %s", rec.Body.String())
	}

	// Per-route gating missed these three: each commits a block, none was
	// covered, and all three used to answer as though the write had landed.
	for _, w := range []struct{ path, body string }{
		{"/umi/isin", `{"assetId":"PROP-SEALED-1","issuer":"originator1"}`},
		{"/umi/dvp", `{"assetId":"PROP-SEALED-1","seller":"originator1","buyer":"investor1","tokens":1,"pricePerTokenINR":100}`},
		{"/umi/documents", `{"assetId":"PROP-SEALED-1","kind":"TITLE_DEED","contentBase64":"aGVsbG8="}`},
	} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, w.path, strings.NewReader(w.body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Fabric-Identity", "regulator1")
		req.Header.Set("X-Identity-Role", "Regulator")
		srv.Router().ServeHTTP(rec, req)
		if rec.Code != http.StatusServiceUnavailable {
			t.Errorf("POST %s on a sealed ledger returned %d, want 503: %s", w.path, rec.Code, rec.Body.String())
		}
	}

	// Reading is still fine: a sealed chain can still show its books.
	rec = httptest.NewRecorder()
	read := httptest.NewRequest(http.MethodGet, "/umi/wallets/investor1", nil)
	read.Header.Set("X-Fabric-Identity", "regulator1")
	read.Header.Set("X-Identity-Role", "Regulator")
	srv.Router().ServeHTTP(rec, read)
	if rec.Code != http.StatusOK {
		t.Fatalf("reading a wallet on a sealed ledger returned %d, want 200", rec.Code)
	}
}

// The repair is destructive and erases what broke the chain, so it must be
// hard to reach by accident and impossible to reach as a stranger.
func TestLedgerRepairIsSupervisoryAndDeliberate(t *testing.T) {
	srv := newTestServerWithUMI(t)
	post := func(identity, role, body string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/drunix/ledger/recover", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if identity != "" {
			req.Header.Set("X-Fabric-Identity", identity)
			req.Header.Set("X-Identity-Role", role)
		}
		srv.Router().ServeHTTP(rec, req)
		return rec
	}

	if rec := post("", "", `{"confirm":"TRUNCATE_TO_LAST_VALID"}`); rec.Code != http.StatusUnauthorized {
		t.Errorf("anonymous repair = %d, want 401", rec.Code)
	}
	if rec := post("investor1", "Investor", `{"confirm":"TRUNCATE_TO_LAST_VALID"}`); rec.Code != http.StatusForbidden {
		t.Errorf("investor repair = %d, want 403", rec.Code)
	}
	rec := post("regulator1", "Regulator", `{}`)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "ERR_CONFIRMATION_REQUIRED") {
		t.Errorf("unconfirmed repair = %d %s, want 400 ERR_CONFIRMATION_REQUIRED", rec.Code, rec.Body.String())
	}
	// A healthy chain has nothing to discard, and saying so is not an error.
	if rec := post("regulator1", "Regulator", `{"confirm":"TRUNCATE_TO_LAST_VALID"}`); rec.Code != http.StatusOK {
		t.Errorf("repair on a healthy chain = %d, want 200: %s", rec.Code, rec.Body.String())
	}
}

// Anchoring is how evidence gets onto a listing, and the verify report
// counts it. Leaving it open let a stranger plant a second title deed on
// someone else's property — and sign it as whoever they liked.
func TestAnchoringEvidenceNeedsAStakeInTheAsset(t *testing.T) {
	srv := newTestServerWithUMI(t)
	const asset = "PROP-ANCHOR-TEST"

	// originator1 holds the asset; investor2 does not.
	if _, err := srv.UMI.SeedPosition(asset, "originator1", 1000, 1000); err != nil {
		t.Fatalf("seed: %v", err)
	}

	anchor := func(identity, role string) *httptest.ResponseRecorder {
		body := `{"assetId":"` + asset + `","docType":"TITLE_DEED","contentBase64":"` +
			base64.StdEncoding.EncodeToString([]byte("deed "+identity+role)) + `"}`
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/umi/documents", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if identity != "" {
			req.Header.Set("X-Fabric-Identity", identity)
			req.Header.Set("X-Identity-Role", role)
		}
		srv.Router().ServeHTTP(rec, req)
		return rec
	}

	if rec := anchor("", ""); rec.Code != http.StatusUnauthorized {
		t.Errorf("anonymous anchor = %d, want 401", rec.Code)
	}
	if rec := anchor("investor2", "Investor"); rec.Code != http.StatusForbidden {
		t.Errorf("stranger anchor = %d, want 403: %s", rec.Code, rec.Body.String())
	} else if !strings.Contains(rec.Body.String(), "ERR_UMI_NOT_YOUR_ASSET") {
		t.Errorf("want ERR_UMI_NOT_YOUR_ASSET, got %s", rec.Body.String())
	}
	if rec := anchor("originator1", "Originator"); rec.Code != http.StatusCreated {
		t.Errorf("holder anchor = %d, want 201: %s", rec.Code, rec.Body.String())
	}
	if rec := anchor("registrar1", "Registrar"); rec.Code != http.StatusCreated {
		t.Errorf("registrar anchor = %d, want 201: %s", rec.Code, rec.Body.String())
	}

	// And the anchor is attributed to the caller, not to whatever the body claimed.
	body := `{"assetId":"` + asset + `","docType":"VALIDATION_CERTIFICATE","submittedBy":"regulator1",` +
		`"contentBase64":"` + base64.StdEncoding.EncodeToString([]byte("cert")) + `"}`
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/umi/documents", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Fabric-Identity", "originator1")
	req.Header.Set("X-Identity-Role", "Originator")
	srv.Router().ServeHTTP(rec, req)
	var resp struct {
		Document struct {
			SubmittedBy string `json:"submittedBy"`
		} `json:"document"`
	}
	json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp.Document.SubmittedBy != "originator1" {
		t.Errorf("submittedBy = %q, want the authenticated caller not the body's claim", resp.Document.SubmittedBy)
	}
}

// The secondary market reached the same money by a different path: the
// seller on an offer and the buyer on a take both came from the request
// body, so a stranger could fire-sale someone's holdings or settle a
// purchase against someone else's wallet.
func TestMarketplaceActsOnlyForTheCaller(t *testing.T) {
	srv := newTestServerWithUMI(t)
	const asset = "PROP-MARKET-TEST"
	if _, err := srv.UMI.SeedPosition(asset, "originator1", 1000, 1000); err != nil {
		t.Fatalf("seed: %v", err)
	}

	do := func(method, path, identity, role, body string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if identity != "" {
			req.Header.Set("X-Fabric-Identity", identity)
			req.Header.Set("X-Identity-Role", role)
		}
		srv.Router().ServeHTTP(rec, req)
		return rec
	}
	offerBody := `{"assetId":"` + asset + `","seller":"originator1","tokens":10,"pricePerTokenINR":1}`

	if rec := do(http.MethodPost, "/umi/offers", "", "", offerBody); rec.Code != http.StatusUnauthorized {
		t.Errorf("anonymous listing = %d, want 401", rec.Code)
	}
	if rec := do(http.MethodPost, "/umi/offers", "investor2", "Investor", offerBody); rec.Code != http.StatusForbidden {
		t.Errorf("listing someone else's tokens = %d, want 403: %s", rec.Code, rec.Body.String())
	}

	rec := do(http.MethodPost, "/umi/offers", "originator1", "Originator",
		`{"assetId":"`+asset+`","seller":"originator1","tokens":10,"pricePerTokenINR":100}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("the seller's own listing = %d: %s", rec.Code, rec.Body.String())
	}
	var created struct {
		Offer struct {
			OfferID string `json:"offerId"`
		} `json:"offer"`
	}
	json.Unmarshal(rec.Body.Bytes(), &created)
	id := created.Offer.OfferID

	// Taking it spends the named buyer's cash.
	if rec := do(http.MethodPost, "/umi/offers/"+id+"/take", "", "", `{"buyer":"investor1","tokens":1}`); rec.Code != http.StatusUnauthorized {
		t.Errorf("anonymous take = %d, want 401", rec.Code)
	}
	if rec := do(http.MethodPost, "/umi/offers/"+id+"/take", "investor2", "Investor", `{"buyer":"investor1","tokens":1}`); rec.Code != http.StatusForbidden {
		t.Errorf("take naming another buyer = %d, want 403: %s", rec.Code, rec.Body.String())
	}
	// A dry run moves nothing, so it stays open.
	if rec := do(http.MethodPost, "/umi/offers/"+id+"/take", "investor2", "Investor", `{"buyer":"investor1","tokens":1,"dryRun":true}`); rec.Code == http.StatusForbidden || rec.Code == http.StatusUnauthorized {
		t.Errorf("dry run take = %d, should not be refused on identity", rec.Code)
	}

	// Cancelling used to accept the real seller's name from the body.
	if rec := do(http.MethodPost, "/umi/offers/"+id+"/cancel", "investor2", "Investor", `{"seller":"originator1"}`); rec.Code != http.StatusForbidden {
		t.Errorf("cancel by naming the seller = %d, want 403: %s", rec.Code, rec.Body.String())
	}
	if rec := do(http.MethodPost, "/umi/offers/"+id+"/cancel", "originator1", "Originator", `{}`); rec.Code != http.StatusOK {
		t.Errorf("the seller's own cancel = %d, want 200: %s", rec.Code, rec.Body.String())
	}
}

// Baskets hold the same securities and spend the same wallets as the single
// asset routes, and every participant on them came from the request body.
func TestBasketRoutesActOnlyForTheCaller(t *testing.T) {
	srv := newTestServerWithUMI(t)
	for _, a := range []string{"PROP-BSK-A", "PROP-BSK-B"} {
		if _, err := srv.UMI.SeedPosition(a, "originator1", 1000, 1000); err != nil {
			t.Fatalf("seed %s: %v", a, err)
		}
	}
	do := func(path, identity, role, body string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if identity != "" {
			req.Header.Set("X-Fabric-Identity", identity)
			req.Header.Set("X-Identity-Role", role)
		}
		srv.Router().ServeHTTP(rec, req)
		return rec
	}
	basket := `{"basketId":"BSK-AUTHZ","name":"Authz","custodian":"originator1","components":[` +
		`{"assetId":"PROP-BSK-A","tokensPerUnit":1,"indicativePriceINR":100},` +
		`{"assetId":"PROP-BSK-B","tokensPerUnit":1,"indicativePriceINR":100}]}`

	if rec := do("/umi/baskets", "", "", basket); rec.Code != http.StatusUnauthorized {
		t.Errorf("anonymous basket creation = %d, want 401", rec.Code)
	}
	if rec := do("/umi/baskets", "investor2", "Investor", basket); rec.Code != http.StatusForbidden {
		t.Errorf("basket under someone else's custody = %d, want 403: %s", rec.Code, rec.Body.String())
	}
	if rec := do("/umi/baskets", "originator1", "Originator", basket); rec.Code != http.StatusCreated {
		t.Fatalf("the custodian's own basket = %d: %s", rec.Code, rec.Body.String())
	}

	for _, c := range []struct {
		name, path, body string
	}{
		{"subscribe", "/umi/baskets/BSK-AUTHZ/subscribe", `{"holder":"originator1","units":5}`},
		{"redeem", "/umi/baskets/BSK-AUTHZ/redeem", `{"holder":"originator1","units":1}`},
		{"transfer", "/umi/baskets/BSK-AUTHZ/transfer", `{"from":"originator1","to":"investor2","units":1}`},
		{"dvp", "/umi/baskets/BSK-AUTHZ/dvp", `{"seller":"originator1","buyer":"investor1","units":1,"pricePerUnitINR":100}`},
	} {
		if rec := do(c.path, "", "", c.body); rec.Code != http.StatusUnauthorized {
			t.Errorf("anonymous %s = %d, want 401: %s", c.name, rec.Code, rec.Body.String())
		}
		if rec := do(c.path, "investor2", "Investor", c.body); rec.Code != http.StatusForbidden {
			t.Errorf("%s on someone else's behalf = %d, want 403: %s", c.name, rec.Code, rec.Body.String())
		}
	}

	// The holder's own subscription still works, and moves real tokens.
	if rec := do("/umi/baskets/BSK-AUTHZ/subscribe", "originator1", "Originator", `{"holder":"originator1","units":5}`); rec.Code != http.StatusOK {
		t.Errorf("the holder's own subscription = %d, want 200: %s", rec.Code, rec.Body.String())
	}
}

// Notification feeds say who traded what and when.
func TestNotificationFeedsArePrivateToTheirOwner(t *testing.T) {
	srv := newTestServerWithUMI(t)
	check := func(method, path, identity, role string, want int) {
		t.Helper()
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(method, path, strings.NewReader(`{}`))
		req.Header.Set("Content-Type", "application/json")
		if identity != "" {
			req.Header.Set("X-Fabric-Identity", identity)
			req.Header.Set("X-Identity-Role", role)
		}
		srv.Router().ServeHTTP(rec, req)
		if rec.Code != want {
			t.Errorf("%s %s as %q = %d, want %d: %s", method, path, identity, rec.Code, want, rec.Body.String())
		}
	}
	check(http.MethodGet, "/umi/notifications/investor1", "", "", http.StatusUnauthorized)
	check(http.MethodGet, "/umi/notifications/investor1", "investor2", "Investor", http.StatusForbidden)
	check(http.MethodPost, "/umi/notifications/investor1/read-all", "investor2", "Investor", http.StatusForbidden)
	check(http.MethodGet, "/umi/notifications/investor1", "investor1", "Investor", http.StatusOK)
	check(http.MethodPost, "/umi/notifications/investor1/read-all", "investor1", "Investor", http.StatusOK)
	check(http.MethodGet, "/umi/notifications/investor1", "regulator1", "Regulator", http.StatusOK)
}

// Analytics is a participant's whole financial picture; ISIN assignment and
// raw ledger submission both write blocks.
func TestPrivateAnalyticsIsinAndRawSubmitAreScoped(t *testing.T) {
	srv := newTestServerWithUMI(t)
	const asset = "PROP-ISIN-AUTHZ"
	if _, err := srv.UMI.SeedPosition(asset, "originator1", 100, 100); err != nil {
		t.Fatalf("seed: %v", err)
	}
	call := func(method, path, identity, role, body string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if identity != "" {
			req.Header.Set("X-Fabric-Identity", identity)
			req.Header.Set("X-Identity-Role", role)
		}
		srv.Router().ServeHTTP(rec, req)
		return rec
	}
	want := func(name string, rec *httptest.ResponseRecorder, code int) {
		t.Helper()
		if rec.Code != code {
			t.Errorf("%s = %d, want %d: %s", name, rec.Code, code, rec.Body.String())
		}
	}

	// The market-wide view is aggregate and stays open.
	want("rail analytics anonymous", call(http.MethodGet, "/umi/analytics", "", "", ""), http.StatusOK)
	want("someone's analytics anonymous", call(http.MethodGet, "/umi/analytics/investor1", "", "", ""), http.StatusUnauthorized)
	want("someone else's analytics", call(http.MethodGet, "/umi/analytics/investor1", "investor2", "Investor", ""), http.StatusForbidden)
	want("own analytics", call(http.MethodGet, "/umi/analytics/investor1", "investor1", "Investor", ""), http.StatusOK)
	want("supervisor reads analytics", call(http.MethodGet, "/umi/analytics/investor1", "regulator1", "Regulator", ""), http.StatusOK)

	isin := `{"assetId":"` + asset + `","issuer":"originator1","depository":"NSDL"}`
	want("isin anonymous", call(http.MethodPost, "/umi/isin", "", "", isin), http.StatusUnauthorized)
	want("isin by a stranger", call(http.MethodPost, "/umi/isin", "investor2", "Investor", isin), http.StatusForbidden)
	want("isin by the holder", call(http.MethodPost, "/umi/isin", "originator1", "Originator", isin), http.StatusOK)

	raw := `{"chaincode":"aasthichain","function":"TransferTokens","args":["` + asset + `","originator1","investor2","100"],"creatorMsp":"InvestorMSP"}`
	want("raw submit anonymous", call(http.MethodPost, "/drunix/submit", "", "", raw), http.StatusUnauthorized)
	want("raw submit by an investor", call(http.MethodPost, "/drunix/submit", "investor2", "Investor", raw), http.StatusForbidden)
	want("raw submit by a supervisor", call(http.MethodPost, "/drunix/submit", "regulator1", "Regulator", raw), http.StatusCreated)
}

// The pipeline runs chaincode straight through endorsement, ordering and
// commit. policyFor() names who may run each function; nothing was checking
// it at the HTTP door.
func TestPipelineHonoursItsOwnEndorsementPolicy(t *testing.T) {
	srv := newTestServerWithUMI(t)
	run := func(identity, role, fn string, args ...string) *httptest.ResponseRecorder {
		body := map[string]interface{}{"fn": fn, "args": args}
		raw, _ := json.Marshal(body)
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/drunix/pipeline", strings.NewReader(string(raw)))
		req.Header.Set("Content-Type", "application/json")
		if identity != "" {
			req.Header.Set("X-Fabric-Identity", identity)
			req.Header.Set("X-Identity-Role", role)
		}
		srv.Router().ServeHTTP(rec, req)
		return rec
	}
	want := func(name string, rec *httptest.ResponseRecorder, code int) {
		t.Helper()
		if rec.Code != code {
			t.Errorf("%s = %d, want %d: %s", name, rec.Code, code, rec.Body.String())
		}
	}

	want("anonymous mint", run("", "", "MintPropertyTokens", "PROP-PIPE", "mallory", "100000"),
		http.StatusUnauthorized)
	want("investor mints to themselves", run("investor2", "Investor", "MintPropertyTokens", "PROP-PIPE", "investor2", "100000"),
		http.StatusForbidden)
	want("investor freezes someone's property", run("investor2", "Investor", "FreezeProperty", "PROP-PIPE"),
		http.StatusForbidden)
	want("originator freezes a property", run("originator1", "Originator", "FreezeProperty", "PROP-PIPE"),
		http.StatusForbidden)

	// The people the policy names still get through.
	want("originator mints", run("originator1", "Originator", "MintPropertyTokens", "PROP-PIPE", "originator1", "1000"),
		http.StatusOK)
	want("regulator freezes", run("regulator1", "Regulator", "FreezeProperty", "PROP-PIPE"),
		http.StatusOK)

	// And an investor may still move what they hold: refused on balance, not
	// on who they are.
	rec := run("investor2", "Investor", "TransferTokens", "PROP-PIPE", "investor2", "investor1", "5")
	if rec.Code == http.StatusForbidden || rec.Code == http.StatusUnauthorized {
		t.Errorf("investor transfer = %d, should be judged on balance not identity: %s", rec.Code, rec.Body.String())
	}
}
