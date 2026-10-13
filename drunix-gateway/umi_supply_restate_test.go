package drunix

import (
	"net/http/httptest"
	"strings"
	"testing"
)

// A cap derived from the book it is supposed to constrain can never be
// breached. That is how an asset reached seven times its issued supply while
// reconciliation still reported the securities leg conserved.
func TestRestateSupplyRemovesPhantomTokensOnly(t *testing.T) {
	chain := NewChain()
	rail := NewUMIRail(NewMemorySecurities(), chain)
	// An inflated book: 105,000 outstanding where the register says 15,000.
	if _, err := rail.SeedPosition("PROP-X", "originator1", 104086, 105000); err != nil {
		t.Fatalf("seed: %v", err)
	}
	for holder, n := range map[string]int64{"investor1": 802, "investor2": 100, "stress1": 12} {
		if _, err := rail.SeedPosition("PROP-X", holder, n, 0); err != nil {
			t.Fatalf("seed %s: %v", holder, err)
		}
	}
	if a, o := rail.AuthorisedSupply("PROP-X"); a != 105000 || o != 105000 {
		t.Fatalf("setup wrong: authorised=%d outstanding=%d", a, o)
	}

	out, blk, err := rail.RestateSupply("PROP-X", "originator1", 15000, "register says 15,000")
	if err != nil {
		t.Fatalf("restate: %v", err)
	}
	if out["tokensRemoved"].(int64) != 90000 {
		t.Fatalf("expected 90,000 phantom tokens removed, got %v", out["tokensRemoved"])
	}
	// Real investors must not lose a single token.
	if rail.PositionOf("PROP-X", "investor1") != 802 || rail.PositionOf("PROP-X", "investor2") != 100 ||
		rail.PositionOf("PROP-X", "stress1") != 12 {
		t.Fatal("a real holder's position was touched by the correction")
	}
	if got := rail.PositionOf("PROP-X", "originator1"); got != 14086 {
		t.Fatalf("originator should keep the remainder, got %d", got)
	}
	a, o := rail.AuthorisedSupply("PROP-X")
	if a != 15000 || o != 15000 {
		t.Fatalf("after restatement authorised=%d outstanding=%d, want 15000/15000", a, o)
	}
	// Silently editing a cap table is the one thing this ledger exists to
	// prevent, so the correction has to be on the chain.
	if blk == nil || blk.Type != BlockUMISupplyRestated {
		t.Fatal("the restatement was not committed as a block")
	}
	if !chain.Verify().Valid {
		t.Fatal("the chain no longer verifies")
	}
}

// Once declared, the cap must not drift upward again on the next seed.
func TestRestatedSupplyIsPinned(t *testing.T) {
	rail := NewUMIRail(NewMemorySecurities(), NewChain())
	_, _ = rail.SeedPosition("PROP-X", "originator1", 30000, 30000)
	if _, _, err := rail.RestateSupply("PROP-X", "originator1", 15000, "correction"); err != nil {
		t.Fatalf("restate: %v", err)
	}
	if _, err := rail.SeedPosition("PROP-X", "originator1", 30000, 30000); err == nil {
		t.Fatal("re-declaring the supply after a restatement must be refused")
	}
}

// The correction must never be a way to destroy somebody else's holding.
func TestRestateRefusesWhenOthersHoldTooMuch(t *testing.T) {
	rail := NewUMIRail(NewMemorySecurities(), NewChain())
	_, _ = rail.SeedPosition("PROP-X", "originator1", 5000, 25000)
	_, _ = rail.SeedPosition("PROP-X", "investor1", 20000, 0)
	_, _, err := rail.RestateSupply("PROP-X", "originator1", 15000, "")
	if err == nil || !strings.Contains(err.Error(), "ERR_UMI_RESTATE_NOT_POSSIBLE") {
		t.Fatalf("expected a refusal, got %v", err)
	}
	if rail.PositionOf("PROP-X", "investor1") != 20000 {
		t.Fatal("a refused restatement still changed a holding")
	}
}

// ---- the rail is on a public URL, so identity headers are a claim ----

func TestProxySecretGatesIdentityHeaders(t *testing.T) {
	req := httptest.NewRequest("GET", "/umi/wallets", nil)
	req.Header.Set("X-Fabric-Identity", "regulator1")
	req.Header.Set("X-Identity-Role", "regulator")

	// Unset: unchanged behaviour, which local development and CI rely on.
	t.Setenv("UMI_PROXY_SECRET", "")
	if c := callerOf(req); c.ID != "regulator1" || !c.supervisor() {
		t.Fatal("with no secret configured the old behaviour must be preserved")
	}

	// Set: the same headers from a stranger are worth nothing.
	t.Setenv("UMI_PROXY_SECRET", "s3cret")
	if c := callerOf(req); !c.anonymous() {
		t.Fatalf("a spoofed identity was believed: %+v", c)
	}
	req.Header.Set("X-Proxy-Auth", "wrong")
	if c := callerOf(req); !c.anonymous() {
		t.Fatal("a wrong secret was accepted")
	}
	req.Header.Set("X-Proxy-Auth", "s3cret")
	if c := callerOf(req); c.ID != "regulator1" || !c.supervisor() {
		t.Fatal("our own gateway was locked out by the secret it presented")
	}
}

func TestIdentityTrustIsReported(t *testing.T) {
	t.Setenv("UMI_PROXY_SECRET", "")
	if umiIdentityTrust()["mode"] != "open" {
		t.Fatal("an open deployment must say so")
	}
	t.Setenv("UMI_PROXY_SECRET", "s3cret")
	if umiIdentityTrust()["mode"] != "shared-secret" {
		t.Fatal("a closed deployment must say so")
	}
}
