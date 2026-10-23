package drunix

// The signed feed. Nearly every test here is a refusal, because an oracle is
// worth exactly what it declines to believe.

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"strings"
	"testing"
	"time"
)

type testPublisher struct {
	holder string
	pub    ed25519.PublicKey
	priv   ed25519.PrivateKey
}

// newOracleFixture builds a chain, a key register with a registered publisher
// key, and a feed. Registration goes through the real challenge flow, so the
// fixture cannot accidentally test a path the server does not use.
func newOracleFixture(t *testing.T, publishers ...string) (*OracleRegistry, *KeyRegistry, map[string]*testPublisher) {
	t.Helper()
	chain := NewChain()
	keys := NewKeyRegistry(chain)
	oracle := NewOracleRegistry(chain, keys)

	out := map[string]*testPublisher{}
	for _, holder := range publishers {
		pub, priv, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			t.Fatalf("keygen: %v", err)
		}
		nonce, _, err := keys.Challenge(holder)
		if err != nil {
			t.Fatalf("challenge: %v", err)
		}
		sig := ed25519.Sign(priv, []byte(nonce))
		if _, err := keys.Register(holder, "oracle", hex.EncodeToString(pub), hex.EncodeToString(sig), holder); err != nil {
			t.Fatalf("register key for %s: %v", holder, err)
		}
		out[holder] = &testPublisher{holder: holder, pub: pub, priv: priv}
	}
	return oracle, keys, out
}

func (p *testPublisher) publish(t *testing.T, o *OracleRegistry, feedID string, value float64, at time.Time, nonce string) (*Observation, error) {
	t.Helper()
	sig := ed25519.Sign(p.priv, FeedSigningMessage(feedID, value, at, nonce))
	return o.Publish(feedID, p.holder, hex.EncodeToString(p.pub), hex.EncodeToString(sig), value, at, nonce)
}

func simpleFeed(t *testing.T, o *OracleRegistry, publishers []string, staleness, minPub int) {
	t.Helper()
	if _, err := o.RegisterFeed(Feed{
		FeedID: "FX.TEST", Unit: "INR per USD", Publishers: publishers,
		MaxStalenessSec: staleness, MinPublishers: minPub, MaxDeviationPct: 5,
	}, "regulator1"); err != nil {
		t.Fatalf("register feed: %v", err)
	}
}

func TestFeedRequiresAFreshnessContract(t *testing.T) {
	o, _, _ := newOracleFixture(t)
	_, err := o.RegisterFeed(Feed{FeedID: "X", Publishers: []string{"a"}}, "regulator1")
	if err == nil || !strings.Contains(err.Error(), "maxStalenessSec") {
		t.Fatalf("a feed without a staleness contract must be refused, got %v", err)
	}
	_, err = o.RegisterFeed(Feed{FeedID: "X", MaxStalenessSec: 60}, "regulator1")
	if err == nil || !strings.Contains(err.Error(), "publishers") {
		t.Fatalf("a feed with no publishers must be refused, got %v", err)
	}
}

func TestSignedReadingIsAcceptedAndUsable(t *testing.T) {
	o, _, pubs := newOracleFixture(t, "registrar1")
	simpleFeed(t, o, []string{"registrar1"}, 300, 1)

	if _, err := pubs["registrar1"].publish(t, o, "FX.TEST", 88.42, time.Now().UTC(), "n1"); err != nil {
		t.Fatalf("publish: %v", err)
	}
	v := o.Value("FX.TEST")
	if !v.Usable || v.Value != 88.42 {
		t.Fatalf("expected a usable 88.42, got %+v", v)
	}
	if len(v.Sources) != 1 || !strings.HasPrefix(v.Sources[0], "registrar1:") {
		t.Fatalf("the value must carry its provenance, got %v", v.Sources)
	}
	if v.Block == 0 {
		t.Fatal("a reading must be on the ledger")
	}
}

func TestUnregisteredKeyIsNotAWeakerFactButNoFact(t *testing.T) {
	o, _, pubs := newOracleFixture(t, "registrar1")
	simpleFeed(t, o, []string{"registrar1", "stranger"}, 300, 1)

	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	at := time.Now().UTC()
	sig := ed25519.Sign(priv, FeedSigningMessage("FX.TEST", 90, at, "n1"))
	_, err := o.Publish("FX.TEST", "stranger", hex.EncodeToString(pub), hex.EncodeToString(sig), 90, at, "n1")
	if err == nil || !strings.Contains(err.Error(), feedRejectBadKey) {
		t.Fatalf("a signature from an unregistered key must be refused, got %v", err)
	}
	_ = pubs
	if v := o.Value("FX.TEST"); v.Usable {
		t.Fatal("a refused reading must not become the feed's value")
	}
}

func TestSignatureMustCoverValueAndTime(t *testing.T) {
	o, _, pubs := newOracleFixture(t, "registrar1")
	simpleFeed(t, o, []string{"registrar1"}, 300, 1)
	p := pubs["registrar1"]

	at := time.Now().UTC()
	sig := ed25519.Sign(p.priv, FeedSigningMessage("FX.TEST", 88.0, at, "n1"))
	// Same signature, different value: the classic substitution.
	_, err := o.Publish("FX.TEST", p.holder, hex.EncodeToString(p.pub), hex.EncodeToString(sig), 99.0, at, "n1")
	if err == nil || !strings.Contains(err.Error(), feedRejectBadSig) {
		t.Fatalf("changing the value must invalidate the signature, got %v", err)
	}
}

func TestNonceCannotBeReplayed(t *testing.T) {
	o, _, pubs := newOracleFixture(t, "registrar1")
	simpleFeed(t, o, []string{"registrar1"}, 300, 1)
	p := pubs["registrar1"]

	at := time.Now().UTC()
	if _, err := p.publish(t, o, "FX.TEST", 88.1, at, "same"); err != nil {
		t.Fatalf("first publish: %v", err)
	}
	_, err := p.publish(t, o, "FX.TEST", 88.1, at.Add(time.Second), "same")
	if err == nil || !strings.Contains(err.Error(), feedRejectReplay) {
		t.Fatalf("a reused nonce must be refused, got %v", err)
	}
}

func TestTimestampsCannotGoBackwardsOrIntoTheFuture(t *testing.T) {
	o, _, pubs := newOracleFixture(t, "registrar1")
	simpleFeed(t, o, []string{"registrar1"}, 3600, 1)
	p := pubs["registrar1"]

	now := time.Now().UTC()
	if _, err := p.publish(t, o, "FX.TEST", 88.1, now, "n1"); err != nil {
		t.Fatalf("publish: %v", err)
	}
	if _, err := p.publish(t, o, "FX.TEST", 88.2, now.Add(-time.Minute), "n2"); err == nil ||
		!strings.Contains(err.Error(), feedRejectBackwards) {
		t.Fatalf("a backdated reading must be refused, got %v", err)
	}
	if _, err := p.publish(t, o, "FX.TEST", 88.3, now.Add(10*time.Minute), "n3"); err == nil ||
		!strings.Contains(err.Error(), feedRejectFuture) {
		t.Fatalf("a reading from the future must be refused: it would never go stale, got %v", err)
	}
}

func TestStaleFeedRefusesRatherThanReturningTheLastValue(t *testing.T) {
	o, _, pubs := newOracleFixture(t, "registrar1")
	simpleFeed(t, o, []string{"registrar1"}, 60, 1)

	old := time.Now().UTC().Add(-10 * time.Minute)
	if _, err := pubs["registrar1"].publish(t, o, "FX.TEST", 88.5, old, "n1"); err != nil {
		t.Fatalf("publish: %v", err)
	}
	v := o.Value("FX.TEST")
	if v.Usable {
		t.Fatal("a reading older than the feed's contract must not be usable")
	}
	if v.State != FeedStale {
		t.Fatalf("expected STALE, got %s", v.State)
	}
	if v.Value != 0 {
		t.Fatalf("a stale feed must not hand back the last value anyway, got %v", v.Value)
	}
	if !strings.Contains(v.Reason, "stops being usable") {
		t.Fatalf("the refusal should say what the contract was, got %q", v.Reason)
	}
}

func TestQuorumIsRequiredWhenDeclared(t *testing.T) {
	o, _, pubs := newOracleFixture(t, "registrar1", "regulator1")
	simpleFeed(t, o, []string{"registrar1", "regulator1"}, 300, 2)

	now := time.Now().UTC()
	if _, err := pubs["registrar1"].publish(t, o, "FX.TEST", 88.4, now, "a1"); err != nil {
		t.Fatalf("publish: %v", err)
	}
	v := o.Value("FX.TEST")
	if v.Usable || v.State != FeedNoQuorum {
		t.Fatalf("one of two publishers is not a quorum, got %+v", v)
	}
	if _, err := pubs["regulator1"].publish(t, o, "FX.TEST", 88.6, now, "b1"); err != nil {
		t.Fatalf("publish: %v", err)
	}
	v = o.Value("FX.TEST")
	if !v.Usable || v.Observers != 2 {
		t.Fatalf("two fresh publishers should satisfy the quorum, got %+v", v)
	}
	// Median of two, and the spread is reported rather than hidden.
	if v.Value != 88.5 {
		t.Fatalf("expected the median 88.5, got %v", v.Value)
	}
	if v.Spread <= 0 {
		t.Fatal("a feed with more than one source should report its spread")
	}
}

func TestOneOutlierCannotMoveAQuorumFeed(t *testing.T) {
	o, _, pubs := newOracleFixture(t, "a", "b", "c")
	if _, err := o.RegisterFeed(Feed{
		FeedID: "FX.TEST", Publishers: []string{"a", "b", "c"},
		MaxStalenessSec: 300, MinPublishers: 2, MaxDeviationPct: 5,
	}, "regulator1"); err != nil {
		t.Fatalf("register: %v", err)
	}
	now := time.Now().UTC()
	for i, h := range []string{"a", "b"} {
		if _, err := pubs[h].publish(t, o, "FX.TEST", 88.0+float64(i)*0.1, now, "n"+h); err != nil {
			t.Fatalf("publish %s: %v", h, err)
		}
	}
	// A publisher sending a wild value.
	ob, err := pubs["c"].publish(t, o, "FX.TEST", 500, now, "nc")
	if err != nil {
		t.Fatalf("the outlier should be recorded, not refused: %v", err)
	}
	if !ob.Disputed {
		t.Fatal("a reading far from its peers must be marked disputed")
	}
	v := o.Value("FX.TEST")
	if v.Value > 90 {
		t.Fatalf("the median must resist one outlier, got %v", v.Value)
	}
	if !v.Disagreed {
		t.Fatal("the feed must report that its publishers disagreed")
	}
}

func TestCompromisedKeyMakesItsReadingsUnattributable(t *testing.T) {
	o, keys, pubs := newOracleFixture(t, "registrar1")
	simpleFeed(t, o, []string{"registrar1"}, 3600, 1)

	if _, err := pubs["registrar1"].publish(t, o, "FX.TEST", 88.5, time.Now().UTC(), "n1"); err != nil {
		t.Fatalf("publish: %v", err)
	}
	if v := o.Value("FX.TEST"); !v.Usable {
		t.Fatal("the reading should be usable before the revocation")
	}

	// Revoke the key for compromise: every signature it made, including the
	// ones from before anybody noticed, stops being attributable.
	var keyID string
	for _, k := range keys.Keys() {
		if k.Holder == "registrar1" {
			keyID = k.KeyID
		}
	}
	if _, err := keys.Revoke(keyID, "KEY_COMPROMISE", "regulator1"); err != nil {
		t.Fatalf("revoke: %v", err)
	}

	v := o.Value("FX.TEST")
	if v.Usable {
		t.Fatal("a reading signed by a compromised key must stop counting")
	}
	if v.State != FeedUnattributed {
		t.Fatalf("expected UNATTRIBUTABLE, got %s (%s)", v.State, v.Reason)
	}
	// The record keeps it, marked.
	obs := o.Observations("FX.TEST", 10)
	if len(obs) != 1 || !obs[0].Unattributable {
		t.Fatalf("the reading must stay on the record and be marked, got %+v", obs)
	}
}

func TestRetiredFeedStopsProducing(t *testing.T) {
	o, _, pubs := newOracleFixture(t, "registrar1")
	simpleFeed(t, o, []string{"registrar1"}, 300, 1)
	if _, err := pubs["registrar1"].publish(t, o, "FX.TEST", 88.5, time.Now().UTC(), "n1"); err != nil {
		t.Fatalf("publish: %v", err)
	}
	if _, err := o.Retire("FX.TEST", "regulator1", "replaced"); err != nil {
		t.Fatalf("retire: %v", err)
	}
	if v := o.Value("FX.TEST"); v.Usable || v.State != FeedRetired {
		t.Fatalf("a retired feed must produce nothing, got %+v", v)
	}
	if _, err := pubs["registrar1"].publish(t, o, "FX.TEST", 88.9, time.Now().UTC(), "n2"); err == nil {
		t.Fatal("a retired feed must refuse new readings")
	}
}

func TestPostureAdmitsSingleSourceFeeds(t *testing.T) {
	o, _, _ := newOracleFixture(t, "registrar1")
	simpleFeed(t, o, []string{"registrar1"}, 300, 1)
	p := o.Posture()
	if p["singleSourceFeeds"].(int) != 1 {
		t.Fatalf("a one-publisher feed must be counted as single source, got %v", p["singleSourceFeeds"])
	}
	limits, _ := p["limits"].([]string)
	joined := strings.Join(limits, " ")
	if !strings.Contains(joined, "not a decentralised oracle network") {
		t.Fatalf("the posture must say what this is not, got %q", joined)
	}
}

func TestCrossBorderQuotePrefersTheSignedRate(t *testing.T) {
	chain := NewChain()
	keys := NewKeyRegistry(chain)
	oracle := NewOracleRegistry(chain, keys)
	rail := NewUMIRail(NewMemorySecurities(), chain)
	cbx := NewCBXRegistry(rail, chain, nil)
	cbx.UseRateFeed(oracle, FeedINRUSD)

	// With no feed at all the quote falls back and says so.
	rate, prov := cbx.rateNow()
	if rate != cbxDefaultRate {
		t.Fatalf("expected the indicative constant, got %v", rate)
	}
	if signed, _ := prov["signed"].(bool); signed {
		t.Fatal("an unpublished feed must not be reported as a signed rate")
	}

	// With a fresh signed reading the quote uses it and carries provenance.
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	nonce, _, err := keys.Challenge("registrar1")
	if err != nil {
		t.Fatalf("challenge: %v", err)
	}
	if _, err := keys.Register("registrar1", "oracle", hex.EncodeToString(pub),
		hex.EncodeToString(ed25519.Sign(priv, []byte(nonce))), "registrar1"); err != nil {
		t.Fatalf("register: %v", err)
	}
	if _, err := oracle.RegisterFeed(Feed{
		FeedID: FeedINRUSD, Unit: "INR per USD", Publishers: []string{"registrar1"},
		MaxStalenessSec: 300, MinPublishers: 1,
	}, "regulator1"); err != nil {
		t.Fatalf("register feed: %v", err)
	}
	at := time.Now().UTC()
	sig := ed25519.Sign(priv, FeedSigningMessage(FeedINRUSD, 91.25, at, "r1"))
	if _, err := oracle.Publish(FeedINRUSD, "registrar1", hex.EncodeToString(pub),
		hex.EncodeToString(sig), 91.25, at, "r1"); err != nil {
		t.Fatalf("publish: %v", err)
	}

	rate, prov = cbx.rateNow()
	if rate != 91.25 {
		t.Fatalf("the quote should use the signed rate, got %v", rate)
	}
	if signed, _ := prov["signed"].(bool); !signed {
		t.Fatalf("the provenance must say the rate was signed, got %+v", prov)
	}
}

// A publisher whose clock lands on a round millisecond must not be told its
// signature is invalid. The canonical timestamp is fixed width precisely so
// that the string this process rebuilds is the string the publisher signed,
// whatever its time library does with trailing zeros.
func TestARoundMillisecondStillVerifies(t *testing.T) {
	o, _, pubs := newOracleFixture(t, "registrar1")
	if _, err := o.RegisterFeed(Feed{
		FeedID: "FX.ROUND", Unit: "INR per USD",
		Publishers: []string{"registrar1"}, MaxStalenessSec: 3600,
	}, "regulator1"); err != nil {
		t.Fatalf("register feed: %v", err)
	}

	at := time.Now().UTC().Truncate(time.Second)
	if at.Format(time.RFC3339Nano) == at.Format(FeedTimeFormat) {
		t.Fatalf("this test is pointless if RFC3339Nano agrees: %s", at.Format(FeedTimeFormat))
	}

	if _, err := pubs["registrar1"].publish(t, o, "FX.ROUND", 88.5, at, "round-ms"); err != nil {
		t.Fatalf("a reading on a round millisecond was refused: %v", err)
	}
}
