package drunix

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Netting is an arithmetic claim before it is a feature: that a batch of
// obligations can be reduced to a much smaller amount of money actually
// moving, without changing where anything ends up. These tests hold both
// halves of that claim. The savings must be real, and the end state must be
// identical to what gross settlement would have produced.
//
// The most dangerous failure here is not a refused batch. It is a batch that
// settles and quietly creates or destroys value, because netting arithmetic
// that is off by one rupee looks exactly like netting arithmetic that works.

func nettingRail(t *testing.T) *UMIRail {
	t.Helper()
	rail := NewUMIRail(NewMemorySecurities(), NewChain())
	// Three participants, each holding some of the same asset, each with a
	// wallet of ₹5,000. The wallets are deliberately too small to support the
	// gross obligations below: that is the point being demonstrated.
	for _, h := range []string{"alice", "bob", "carol"} {
		if _, err := rail.SeedPosition("PROP-NET", h, 300, 900); err != nil {
			t.Fatalf("seed %s: %v", h, err)
		}
		if _, _, err := rail.FundWallet(h, 5000); err != nil {
			t.Fatalf("fund %s: %v", h, err)
		}
	}
	return rail
}

// A ring of obligations: alice pays bob, bob pays carol, carol pays alice,
// all for the same amount. Gross, that is three payments. Net, it is none.
func ringLegs(tokens int64, price float64) []NettingLeg {
	return []NettingLeg{
		{AssetID: "PROP-NET", Seller: "bob", Buyer: "alice", Tokens: tokens, PricePerTokenINR: price},
		{AssetID: "PROP-NET", Seller: "carol", Buyer: "bob", Tokens: tokens, PricePerTokenINR: price},
		{AssetID: "PROP-NET", Seller: "alice", Buyer: "carol", Tokens: tokens, PricePerTokenINR: price},
	}
}

func totalCashPaise(t *testing.T, rail *UMIRail, names ...string) int64 {
	t.Helper()
	var sum int64
	for _, n := range names {
		w, ok := rail.Wallet(n)
		if !ok {
			t.Fatalf("wallet %s missing", n)
		}
		sum += w.BalancePaise
	}
	return sum
}

func totalTokens(rail *UMIRail, asset string, names ...string) int64 {
	var sum int64
	for _, n := range names {
		sum += rail.Securities().Position(asset, n)
	}
	return sum
}

// A perfectly circular batch nets to nothing. This is the strongest possible
// version of the claim: three real obligations, zero rupees moved.
func TestCircularBatchNetsToZero(t *testing.T) {
	rail := nettingRail(t)
	b, err := rail.Net(ringLegs(100, 500))
	if err != nil {
		t.Fatalf("net: %v", err)
	}
	if b.GrossCashINR != 150000 {
		t.Fatalf("gross = %.2f, want 150000 (three legs of 100 tokens at 500)", b.GrossCashINR)
	}
	if b.NetCashINR != 0 {
		t.Fatalf("net = %.2f, want 0: a closed ring of equal obligations needs no money", b.NetCashINR)
	}
	if b.EfficiencyPct != 100 {
		t.Fatalf("efficiency = %.2f, want 100", b.EfficiencyPct)
	}
	if !b.Settleable {
		t.Fatalf("a batch needing no cash is not settleable: %s", b.RefusalDetail)
	}
}

// The liquidity claim, which is the one that matters to a participant: the
// ring is unfundable gross and trivially fundable net. Each wallet holds
// ₹5,000 and each participant owes ₹50,000 gross.
func TestNettingSettlesWhatGrossSettlementCouldNot(t *testing.T) {
	rail := nettingRail(t)
	legs := ringLegs(100, 500)

	// Gross first: the same obligation, submitted on its own, is refused.
	if _, err := rail.SettleDvP(DvPRequest{
		AssetID: "PROP-NET", Seller: "bob", Buyer: "alice",
		Tokens: 100, PricePerTokenINR: 500, AutoAssignISIN: true,
	}); err == nil {
		t.Fatalf("gross settlement of an unfunded leg succeeded, so this test proves nothing")
	}

	b, err := rail.SettleNet(legs)
	if err != nil {
		t.Fatalf("net settlement refused: %v (%s)", err, b.RefusalDetail)
	}
	if b.Status != NettingStatusSettled {
		t.Fatalf("status = %s, want %s", b.Status, NettingStatusSettled)
	}
	if b.PeakGrossFundingINR <= b.PeakNetFundingINR {
		t.Fatalf("peak funding gross %.2f should exceed net %.2f", b.PeakGrossFundingINR, b.PeakNetFundingINR)
	}
}

// Conservation. Netting may reduce how much money moves; it may never change
// how much money or how many tokens exist.
func TestNettingConservesCashAndTokens(t *testing.T) {
	rail := nettingRail(t)
	names := []string{"alice", "bob", "carol"}
	cashBefore := totalCashPaise(t, rail, names...)
	tokensBefore := totalTokens(rail, "PROP-NET", names...)

	legs := []NettingLeg{
		{AssetID: "PROP-NET", Seller: "bob", Buyer: "alice", Tokens: 60, PricePerTokenINR: 500},
		{AssetID: "PROP-NET", Seller: "carol", Buyer: "bob", Tokens: 40, PricePerTokenINR: 500},
		{AssetID: "PROP-NET", Seller: "alice", Buyer: "carol", Tokens: 50, PricePerTokenINR: 500},
	}
	b, err := rail.SettleNet(legs)
	if err != nil {
		t.Fatalf("settle: %v (%s)", err, b.RefusalDetail)
	}

	if got := totalCashPaise(t, rail, names...); got != cashBefore {
		t.Fatalf("total cash changed: %d → %d. Netting created or destroyed money", cashBefore, got)
	}
	if got := totalTokens(rail, "PROP-NET", names...); got != tokensBefore {
		t.Fatalf("total tokens changed: %d → %d. Netting minted or burned", tokensBefore, got)
	}

	// Ending positions must be exactly the sum of the legs: alice +60 -50,
	// bob -60 +40, carol -40 +50.
	want := map[string]int64{"alice": 310, "bob": 280, "carol": 310}
	for h, w := range want {
		if got := rail.Securities().Position("PROP-NET", h); got != w {
			t.Fatalf("%s holds %d of PROP-NET, want %d: netted positions must match the legs", h, got, w)
		}
	}
}

// Netted cash must land where gross settlement would have left it. Same legs,
// two rails, identical ending balances.
func TestNettedBalancesMatchGrossSettlement(t *testing.T) {
	legs := []NettingLeg{
		{AssetID: "PROP-NET", Seller: "bob", Buyer: "alice", Tokens: 60, PricePerTokenINR: 500},
		{AssetID: "PROP-NET", Seller: "carol", Buyer: "bob", Tokens: 40, PricePerTokenINR: 500},
		{AssetID: "PROP-NET", Seller: "alice", Buyer: "carol", Tokens: 50, PricePerTokenINR: 500},
	}

	netRail := nettingRail(t)
	if b, err := netRail.SettleNet(legs); err != nil {
		t.Fatalf("net settle: %v (%s)", err, b.RefusalDetail)
	}

	// The gross comparison needs wallets large enough to survive the
	// sequence, which is itself the cost netting removes.
	grossRail := nettingRail(t)
	for _, h := range []string{"alice", "bob", "carol"} {
		if _, _, err := grossRail.FundWallet(h, 10000000); err != nil {
			t.Fatalf("fund: %v", err)
		}
	}
	for i, l := range legs {
		if _, err := grossRail.SettleDvP(DvPRequest{
			AssetID: l.AssetID, Seller: l.Seller, Buyer: l.Buyer,
			Tokens: l.Tokens, PricePerTokenINR: l.PricePerTokenINR, AutoAssignISIN: true,
		}); err != nil {
			t.Fatalf("gross leg %d: %v", i+1, err)
		}
	}

	for _, h := range []string{"alice", "bob", "carol"} {
		nw, _ := netRail.Wallet(h)
		gw, _ := grossRail.Wallet(h)
		// Gross wallets were topped up by a known amount; compare the delta.
		netDelta := nw.BalancePaise - 500000
		grossDelta := gw.BalancePaise - 500000 - 1000000000
		if netDelta != grossDelta {
			t.Fatalf("%s: netted cash delta %d != gross cash delta %d", h, netDelta, grossDelta)
		}
		if netRail.Securities().Position("PROP-NET", h) != grossRail.Securities().Position("PROP-NET", h) {
			t.Fatalf("%s: netted position differs from gross position", h)
		}
	}
}

// A preview is a question, not an event. It must leave nothing behind.
func TestPreviewMovesNothing(t *testing.T) {
	rail := nettingRail(t)
	names := []string{"alice", "bob", "carol"}
	cashBefore := totalCashPaise(t, rail, names...)
	posBefore := rail.Securities().Position("PROP-NET", "alice")
	heightBefore := len(rail.chain.Blocks)

	if _, err := rail.Net(ringLegs(100, 500)); err != nil {
		t.Fatalf("preview: %v", err)
	}
	if got := totalCashPaise(t, rail, names...); got != cashBefore {
		t.Fatalf("a preview moved cash: %d → %d", cashBefore, got)
	}
	if got := rail.Securities().Position("PROP-NET", "alice"); got != posBefore {
		t.Fatalf("a preview moved tokens: %d → %d", posBefore, got)
	}
	if got := len(rail.chain.Blocks); got != heightBefore {
		t.Fatalf("a preview appended %d blocks", got-heightBefore)
	}
}

// All or nothing. One participant short on their net debit refuses the whole
// batch, including the legs that were perfectly fundable.
func TestOneShortParticipantRefusesTheWholeBatch(t *testing.T) {
	rail := nettingRail(t)
	names := []string{"alice", "bob", "carol"}
	cashBefore := totalCashPaise(t, rail, names...)
	posBefore := rail.Securities().Position("PROP-NET", "alice")

	// alice buys far more than she sells, and her wallet holds ₹5,000.
	legs := []NettingLeg{
		{AssetID: "PROP-NET", Seller: "bob", Buyer: "alice", Tokens: 200, PricePerTokenINR: 500},
		{AssetID: "PROP-NET", Seller: "alice", Buyer: "carol", Tokens: 10, PricePerTokenINR: 500},
	}
	b, err := rail.SettleNet(legs)
	if err == nil {
		t.Fatalf("an unfundable batch settled")
	}
	if b.RefusalReason != ErrNettingShortCash.Error() {
		t.Fatalf("refusal = %s, want %s", b.RefusalReason, ErrNettingShortCash.Error())
	}
	if b.RefusalDetail == "" {
		t.Fatalf("a refusal must name the shortfall")
	}
	if got := totalCashPaise(t, rail, names...); got != cashBefore {
		t.Fatalf("a refused batch moved cash")
	}
	if got := rail.Securities().Position("PROP-NET", "alice"); got != posBefore {
		t.Fatalf("a refused batch moved tokens")
	}
}

// A seller who cannot deliver on their net token position refuses the batch
// before any cash is considered.
func TestShortSecuritiesRefusesTheBatch(t *testing.T) {
	rail := nettingRail(t)
	legs := []NettingLeg{
		{AssetID: "PROP-NET", Seller: "bob", Buyer: "alice", Tokens: 5000, PricePerTokenINR: 1},
	}
	b, err := rail.SettleNet(legs)
	if err == nil {
		t.Fatalf("a batch with an undeliverable leg settled")
	}
	if b.RefusalReason != ErrNettingShortTokens.Error() {
		t.Fatalf("refusal = %s, want %s", b.RefusalReason, ErrNettingShortTokens.Error())
	}
}

// Nonsense legs are refused rather than netted into silence.
func TestInvalidLegsRefused(t *testing.T) {
	rail := nettingRail(t)
	cases := map[string][]NettingLeg{
		"empty batch":     {},
		"self settlement": {{AssetID: "PROP-NET", Seller: "bob", Buyer: "bob", Tokens: 1, PricePerTokenINR: 500}},
		"zero tokens":     {{AssetID: "PROP-NET", Seller: "bob", Buyer: "alice", Tokens: 0, PricePerTokenINR: 500}},
		"no asset":        {{AssetID: "", Seller: "bob", Buyer: "alice", Tokens: 1, PricePerTokenINR: 500}},
	}
	for name, legs := range cases {
		if _, err := rail.Net(legs); err == nil {
			t.Fatalf("%s was accepted", name)
		}
	}
}

// The batch must say what it is not. Netting without novation leaves
// counterparty exposure in place, and a settlement report that omits that is
// selling a guarantee the rail does not provide.
func TestBatchPublishesThatThereIsNoCentralCounterparty(t *testing.T) {
	rail := nettingRail(t)
	b, err := rail.Net(ringLegs(100, 500))
	if err != nil {
		t.Fatalf("net: %v", err)
	}
	if b.Guarantee != NettingNoCCP {
		t.Fatalf("batch does not publish the no-CCP caveat")
	}
}

// A settled batch is anchored once, as one block, with the measurement in it.
func TestSettledBatchIsAnchoredOnce(t *testing.T) {
	rail := nettingRail(t)
	before := len(rail.chain.Blocks)
	b, err := rail.SettleNet(ringLegs(100, 500))
	if err != nil {
		t.Fatalf("settle: %v", err)
	}
	if got := len(rail.chain.Blocks) - before; got != 1 {
		t.Fatalf("batch produced %d blocks, want exactly 1", got)
	}
	blk := rail.chain.Blocks[len(rail.chain.Blocks)-1]
	if blk.Type != BlockUMINettingSettled {
		t.Fatalf("block type = %s, want %s", blk.Type, BlockUMINettingSettled)
	}
	if b.BlockHash == "" || b.BlockHeight == 0 {
		t.Fatalf("settled batch is not linked to its block")
	}
	if _, ok := blk.Txns[0]["efficiencyPct"]; !ok {
		t.Fatalf("the block does not record what the netting saved")
	}
}

// --- HTTP surface -------------------------------------------------------
//
// Netting moves several participants' money in one call, so the question of
// who may press it matters as much as the arithmetic. A batch that any signed
// -in investor could settle would let one participant reach into another's
// wallet by constructing a batch that suits them.

func nettingServer(t *testing.T) *Server {
	t.Helper()
	s := newTestServerWithUMI(t)
	for _, h := range []string{"alice", "bob", "carol"} {
		if _, err := s.UMI.SeedPosition("PROP-NET", h, 300, 900); err != nil {
			t.Fatalf("seed: %v", err)
		}
		if _, _, err := s.UMI.FundWallet(h, 5000); err != nil {
			t.Fatalf("fund: %v", err)
		}
	}
	return s
}

func nettingBody() string {
	return `{"legs":[
		{"assetId":"PROP-NET","seller":"bob","buyer":"alice","tokens":100,"pricePerTokenINR":500},
		{"assetId":"PROP-NET","seller":"carol","buyer":"bob","tokens":100,"pricePerTokenINR":500},
		{"assetId":"PROP-NET","seller":"alice","buyer":"carol","tokens":100,"pricePerTokenINR":500}]}`
}

func nettingPost(t *testing.T, s *Server, path, identity, body string) (int, map[string]interface{}) {
	t.Helper()
	req := httptest.NewRequest("POST", path, strings.NewReader(body))
	if identity != "" {
		req.Header.Set("X-Fabric-Identity", identity)
		if identity == "regulator1" {
			req.Header.Set("X-Identity-Role", "Regulator")
		} else {
			req.Header.Set("X-Identity-Role", "Investor")
		}
	}
	rec := httptest.NewRecorder()
	s.Router().ServeHTTP(rec, req)
	var out map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func TestSettlingABatchIsSupervisoryOnly(t *testing.T) {
	s := nettingServer(t)
	code, body := nettingPost(t, s, "/umi/netting/settle", "alice", nettingBody())
	if code != http.StatusForbidden {
		t.Fatalf("a participant settled a batch: %d %v", code, body)
	}
	if body["error"] != "ERR_NOT_SUPERVISORY" {
		t.Fatalf("error = %v, want ERR_NOT_SUPERVISORY", body["error"])
	}
	code, body = nettingPost(t, s, "/umi/netting/settle", "regulator1", nettingBody())
	if code != http.StatusOK {
		t.Fatalf("a supervisor could not settle: %d %v", code, body)
	}
	if body["status"] != NettingStatusSettled {
		t.Fatalf("status = %v", body["status"])
	}
}

func TestPreviewRefusesABatchTheCallerIsNotPartyTo(t *testing.T) {
	s := nettingServer(t)
	// A batch alice appears nowhere in. Being on one leg is enough to look;
	// being on none is not.
	outside := `{"legs":[{"assetId":"PROP-NET","seller":"bob","buyer":"carol","tokens":10,"pricePerTokenINR":500}]}`
	code, body := nettingPost(t, s, "/umi/netting/preview", "alice", outside)
	if code != http.StatusForbidden {
		t.Fatalf("a stranger previewed someone else's batch: %d %v", code, body)
	}
	if body["error"] != "ERR_UMI_NETTING_NOT_A_PARTY" {
		t.Fatalf("error = %v", body["error"])
	}
}

func TestPreviewWithholdsOtherWalletsFromAParticipant(t *testing.T) {
	s := nettingServer(t)
	code, body := nettingPost(t, s, "/umi/netting/preview", "alice", nettingBody())
	if code != http.StatusOK {
		t.Fatalf("a party could not preview their own batch: %d %v", code, body)
	}
	positions, _ := body["cashPositions"].([]interface{})
	if len(positions) != 3 {
		t.Fatalf("expected three positions, got %d", len(positions))
	}
	for _, p := range positions {
		m := p.(map[string]interface{})
		if m["participant"] == "alice" {
			continue
		}
		if m["availableINR"].(float64) != 0 {
			t.Fatalf("%v's wallet balance was disclosed to alice", m["participant"])
		}
	}
	// A supervisor sees the whole book, which is the point of being one.
	_, sup := nettingPost(t, s, "/umi/netting/preview", "regulator1", nettingBody())
	seen := false
	for _, p := range sup["cashPositions"].([]interface{}) {
		if p.(map[string]interface{})["availableINR"].(float64) > 0 {
			seen = true
		}
	}
	if !seen {
		t.Fatalf("a supervisor saw no balances at all")
	}
}

func TestAnonymousCannotPreview(t *testing.T) {
	s := nettingServer(t)
	code, _ := nettingPost(t, s, "/umi/netting/preview", "", nettingBody())
	if code != http.StatusUnauthorized && code != http.StatusForbidden {
		t.Fatalf("an anonymous caller got %d", code)
	}
}
