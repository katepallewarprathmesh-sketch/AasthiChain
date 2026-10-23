package drunix

// Signed feeds: the one way an outside fact is allowed into this rail.
//
// WHAT WAS WRONG BEFORE THIS FILE
//
// Outside facts already reached the ledger: a pincode checked against the
// postal directory, a document digest anchored to a public chain, an
// attestation that money arrived, an indicative exchange rate set by whoever
// called the setter. Each bridge was hand-wired and each made its own private
// decisions about who to believe and how old a fact may be before it stops
// being a fact. That is four answers to the same two questions, and none of
// them written down where a reader could check.
//
// A feed here answers both questions out loud:
//
//   - WHO. Every observation is signed, and the signing key must be in the
//     key register, screened and not revoked. A signature from a key nobody
//     registered is not a weaker fact, it is not a fact at all. If a key is
//     later revoked for compromise, the observations it published are marked
//     unattributable rather than quietly left in place.
//
//   - HOW OLD. Every feed declares the age past which its values stop being
//     usable. A consumer that asks for a usable value gets a refusal when the
//     feed is stale. It never gets the last known value with the staleness
//     left for it to notice, because that is the failure the postal directory
//     bridge was explicitly written to avoid and the rest of the system had no
//     way to copy.
//
// WHAT THIS IS NOT
//
// This is not a decentralised oracle network. There is no staking, no slashing
// and no incentive design, and a feed is exactly as trustworthy as the people
// holding its publishing keys. What it provides is the part those systems get
// right and hand-wired bridges get wrong: provenance, an explicit freshness
// contract, a quorum rule, and a disagreement that is visible instead of
// averaged away.

import (
	"crypto/ed25519"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Block types for the feed record.
const (
	BlockFeedRegistered = "UMI_FEED_REGISTERED"
	BlockFeedPublished  = "UMI_FEED_PUBLISHED"
	BlockFeedRejected   = "UMI_FEED_REJECTED"
	BlockFeedRetired    = "UMI_FEED_RETIRED"
)

// Why a feed cannot be used right now. A refusal names one of these rather
// than returning a value with a warning attached, because a warning beside a
// number is read as a number.
const (
	FeedUsable       = "USABLE"
	FeedStale        = "STALE"          // nothing fresh enough to rely on
	FeedNoQuorum     = "NO_QUORUM"      // too few independent publishers are fresh
	FeedNoData       = "NO_DATA"        // registered, never published to
	FeedRetired      = "RETIRED"        // withdrawn by its owner
	FeedUnattributed = "UNATTRIBUTABLE" // every fresh observation came from a compromised key
)

// Why one observation was refused.
const (
	feedRejectUnknownFeed = "UNKNOWN_FEED"
	feedRejectBadKey      = "KEY_NOT_USABLE"
	feedRejectBadSig      = "SIGNATURE_INVALID"
	feedRejectReplay      = "NONCE_REUSED"
	feedRejectBackwards   = "TIMESTAMP_WENT_BACKWARDS"
	feedRejectFuture      = "TIMESTAMP_IN_FUTURE"
	feedRejectNotAllowed  = "PUBLISHER_NOT_ON_THE_FEED"
)

// feedClockSkew is how far ahead of us a publisher's clock may be. Beyond it
// the observation is refused: a timestamp from the future is either a broken
// clock or an attempt to keep a value fresh forever.
const feedClockSkew = 2 * time.Minute

// FeedINRUSD is the rupee rate feed the cross-border quote prefers over its
// indicative constant. Named here so the consumer and the publisher cannot
// disagree about the string.
const FeedINRUSD = "FX.INR.USD"

// Feed is a named outside fact with a declared trust and freshness contract.
type Feed struct {
	FeedID      string `json:"feedId"`
	Description string `json:"description"`
	Unit        string `json:"unit"` // "INR per USD", "percent", whatever the number means
	Owner       string `json:"owner"`

	// Publishers are the holders allowed to publish. Naming them is the
	// trust decision, and it is made once, in the open, rather than per
	// observation.
	Publishers []string `json:"publishers"`

	// MaxStalenessSec is the age at which a value stops being usable.
	MaxStalenessSec int `json:"maxStalenessSec"`

	// MinPublishers is how many distinct publishers must be fresh at once.
	// One is honest for a feed with a single source; it is not a quorum and
	// the posture says so.
	MinPublishers int `json:"minPublishers"`

	// MaxDeviationPct flags an observation that disagrees with the others
	// by more than this. Disagreement is recorded, never averaged away.
	MaxDeviationPct float64 `json:"maxDeviationPct"`

	RegisteredAt time.Time `json:"registeredAt"`
	RegisteredBy string    `json:"registeredBy"`
	Block        int64     `json:"registeredAtBlock"`

	Retired   bool      `json:"retired,omitempty"`
	RetiredAt time.Time `json:"retiredAt,omitempty"`
}

// Observation is one signed reading.
type Observation struct {
	FeedID     string    `json:"feedId"`
	Publisher  string    `json:"publisher"`
	Value      float64   `json:"value"`
	ObservedAt time.Time `json:"observedAt"` // the publisher's timestamp, which is what is signed
	ReceivedAt time.Time `json:"receivedAt"` // ours, which is not
	Nonce      string    `json:"nonce"`
	KeyID      string    `json:"keyId"`
	PublicKey  string    `json:"publicKey"`
	Block      int64     `json:"block"`

	// Disputed means this reading disagreed with its peers by more than the
	// feed allows. It is kept, not dropped: a disagreement deleted is a
	// disagreement nobody can audit.
	Disputed bool `json:"disputed,omitempty"`

	// Unattributable is set when the key that signed this was later revoked
	// for compromise. The reading stays on the record and stops counting.
	Unattributable bool `json:"unattributable,omitempty"`
}

// FeedValue is what a consumer gets back: a number, or a reason there is not
// one, and in both cases the provenance to check it.
type FeedValue struct {
	FeedID    string  `json:"feedId"`
	Value     float64 `json:"value"`
	Unit      string  `json:"unit"`
	Usable    bool    `json:"usable"`
	State     string  `json:"state"`
	Reason    string  `json:"reason,omitempty"`
	AgeSec    int     `json:"ageSec"`
	Observers int     `json:"observers"` // distinct fresh publishers behind it
	Disagreed bool    `json:"disagreed,omitempty"`
	Spread    float64 `json:"spreadPct,omitempty"`

	ObservedAt time.Time `json:"observedAt,omitempty"`
	Sources    []string  `json:"sources,omitempty"` // publisher:keyId
	Block      int64     `json:"block,omitempty"`
}

// OracleRegistry holds the feeds.
type OracleRegistry struct {
	mu    sync.Mutex
	chain *DrunixChain
	keys  *KeyRegistry

	feeds map[string]*Feed
	obs   map[string][]*Observation // feedId -> newest last
	seen  map[string]bool           // feedId|nonce, the replay index
	order []string
}

// NewOracleRegistry builds the registry. The key register is not optional:
// without it there is no way to decide whether a signature belongs to
// anybody, and a feed that cannot answer that is just a number someone typed.
func NewOracleRegistry(chain *DrunixChain, keys *KeyRegistry) *OracleRegistry {
	return &OracleRegistry{
		chain: chain, keys: keys,
		feeds: map[string]*Feed{},
		obs:   map[string][]*Observation{},
		seen:  map[string]bool{},
	}
}

// FeedTimeFormat is the canonical timestamp form inside a signed reading:
// UTC, always exactly three decimal places.
//
// The fixed width matters. RFC3339Nano trims trailing zeros, so a publisher
// whose clock happened to land on a round millisecond would build a different
// string from the one this process rebuilt, and get back a signature error
// that said nothing about the real cause. A canonical form cannot be left to
// whichever library each publisher happens to use.
const FeedTimeFormat = "2006-01-02T15:04:05.000Z"

// FeedSigningMessage is the exact byte string a publisher signs. Exported
// because a publisher outside this process has to build it identically, and
// a signing format described in prose is a signing format that drifts.
func FeedSigningMessage(feedID string, value float64, observedAt time.Time, nonce string) []byte {
	return []byte(strings.Join([]string{
		"aasthi-feed", "v1", feedID,
		strconv.FormatFloat(value, 'f', -1, 64),
		observedAt.UTC().Format(FeedTimeFormat),
		nonce,
	}, "|"))
}

// RegisterFeed declares a feed and its contract.
func (o *OracleRegistry) RegisterFeed(f Feed, by string) (*Feed, error) {
	if o == nil {
		return nil, errors.New("oracle: not configured")
	}
	f.FeedID = strings.TrimSpace(f.FeedID)
	if f.FeedID == "" {
		return nil, errors.New("feedId is required")
	}
	if len(f.Publishers) == 0 {
		return nil, errors.New("a feed with no publishers can never produce a value: name at least one")
	}
	if f.MaxStalenessSec <= 0 {
		return nil, errors.New("maxStalenessSec is required: a feed without a freshness contract is the problem this is meant to fix")
	}
	if f.MinPublishers <= 0 {
		f.MinPublishers = 1
	}
	if f.MinPublishers > len(f.Publishers) {
		return nil, fmt.Errorf("minPublishers %d cannot exceed the %d publishers named", f.MinPublishers, len(f.Publishers))
	}
	if f.MaxDeviationPct <= 0 {
		f.MaxDeviationPct = 5
	}

	o.mu.Lock()
	defer o.mu.Unlock()
	if _, exists := o.feeds[f.FeedID]; exists {
		return nil, fmt.Errorf("feed %s already exists", f.FeedID)
	}

	f.RegisteredAt = time.Now().UTC()
	f.RegisteredBy = by
	blk := o.commit(BlockFeedRegistered, map[string]interface{}{
		"feedId": f.FeedID, "unit": f.Unit, "publishers": f.Publishers,
		"maxStalenessSec": f.MaxStalenessSec, "minPublishers": f.MinPublishers,
		"maxDeviationPct": f.MaxDeviationPct, "by": by,
	})
	if blk != nil {
		f.Block = blk.Height
	}
	cp := f
	o.feeds[f.FeedID] = &cp
	o.order = append(o.order, f.FeedID)
	return &cp, nil
}

// Publish records one signed observation, or refuses it and says why.
//
// The order of the checks is deliberate: identity first, then authorisation,
// then the signature, then replay, then the clock. Checking the signature
// before knowing whose key it is would mean verifying against a key the rail
// has no opinion about, which proves only that somebody holds a private key.
func (o *OracleRegistry) Publish(feedID, publisher, publicKeyHex, signatureHex string,
	value float64, observedAt time.Time, nonce string) (*Observation, error) {

	if o == nil {
		return nil, errors.New("oracle: not configured")
	}
	feedID, publisher = strings.TrimSpace(feedID), strings.TrimSpace(publisher)
	publicKeyHex = strings.ToLower(strings.TrimSpace(publicKeyHex))
	nonce = strings.TrimSpace(nonce)
	if nonce == "" {
		return nil, errors.New("nonce is required: without one the same signed reading can be replayed forever")
	}

	o.mu.Lock()
	defer o.mu.Unlock()

	feed := o.feeds[feedID]
	if feed == nil {
		return nil, o.reject(feedID, publisher, feedRejectUnknownFeed, "no feed by that id")
	}
	if feed.Retired {
		return nil, o.reject(feedID, publisher, FeedRetired, "this feed was retired")
	}
	allowed := false
	for _, p := range feed.Publishers {
		if p == publisher {
			allowed = true
			break
		}
	}
	if !allowed {
		return nil, o.reject(feedID, publisher, feedRejectNotAllowed,
			"this holder is not a publisher on this feed")
	}

	// The key must be one the rail knows, screened and not revoked. This is
	// the join to the key register: a feed inherits its trust from a key
	// that was checked before it ever signed anything.
	status := o.keys.Status(publicKeyHex)
	usable, _ := status["usable"].(bool)
	if !usable {
		reason, _ := status["reason"].(string)
		if reason == "" {
			reason = "the signing key is not usable"
		}
		return nil, o.reject(feedID, publisher, feedRejectBadKey, reason)
	}
	keyHolder, _ := status["holder"].(string)
	if keyHolder != publisher {
		return nil, o.reject(feedID, publisher, feedRejectBadKey,
			"the signing key is registered to "+keyHolder+", not to the publisher")
	}
	keyID, _ := status["keyId"].(string)

	raw, err := hex.DecodeString(publicKeyHex)
	if err != nil || len(raw) != ed25519.PublicKeySize {
		return nil, o.reject(feedID, publisher, feedRejectBadKey, "public key is not a 32 byte ed25519 key")
	}
	sig, err := hex.DecodeString(strings.TrimSpace(signatureHex))
	if err != nil {
		return nil, o.reject(feedID, publisher, feedRejectBadSig, "signature is not hex")
	}
	msg := FeedSigningMessage(feedID, value, observedAt, nonce)
	if !ed25519.Verify(ed25519.PublicKey(raw), msg, sig) {
		return nil, o.reject(feedID, publisher, feedRejectBadSig,
			"the signature does not cover this value, timestamp and nonce")
	}

	if o.seen[feedID+"|"+nonce] {
		return nil, o.reject(feedID, publisher, feedRejectReplay, "this nonce was already used on this feed")
	}

	now := time.Now().UTC()
	observedAt = observedAt.UTC()
	if observedAt.After(now.Add(feedClockSkew)) {
		return nil, o.reject(feedID, publisher, feedRejectFuture,
			"the observation is timestamped in the future, which would keep it fresh forever")
	}
	for i := len(o.obs[feedID]) - 1; i >= 0; i-- {
		prev := o.obs[feedID][i]
		if prev.Publisher != publisher {
			continue
		}
		if !observedAt.After(prev.ObservedAt) {
			return nil, o.reject(feedID, publisher, feedRejectBackwards,
				"this publisher already published a reading at or after that time")
		}
		break
	}

	ob := &Observation{
		FeedID: feedID, Publisher: publisher, Value: value,
		ObservedAt: observedAt, ReceivedAt: now, Nonce: nonce,
		KeyID: keyID, PublicKey: publicKeyHex,
	}

	// Disagreement check against the other fresh publishers. The value is
	// kept either way; what changes is that the feed reports it disagreed.
	if peers := o.freshValuesLocked(feed, now, publisher); len(peers) > 0 {
		med := median(peers)
		if med != 0 {
			dev := (value - med) / med * 100
			if dev < 0 {
				dev = -dev
			}
			if dev > feed.MaxDeviationPct {
				ob.Disputed = true
			}
		}
	}

	blk := o.commit(BlockFeedPublished, map[string]interface{}{
		"feedId": feedID, "publisher": publisher, "value": value,
		"observedAt": observedAt.Format(time.RFC3339Nano), "nonce": nonce,
		"keyId": keyID, "disputed": ob.Disputed,
	})
	if blk != nil {
		ob.Block = blk.Height
	}

	o.seen[feedID+"|"+nonce] = true
	o.obs[feedID] = append(o.obs[feedID], ob)
	return ob, nil
}

// Value is what consumers call. It returns a usable number or a reason.
func (o *OracleRegistry) Value(feedID string) FeedValue {
	if o == nil {
		return FeedValue{FeedID: feedID, State: FeedNoData, Reason: "no oracle is configured"}
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.valueLocked(feedID, time.Now().UTC())
}

func (o *OracleRegistry) valueLocked(feedID string, now time.Time) FeedValue {
	out := FeedValue{FeedID: feedID}
	feed := o.feeds[feedID]
	if feed == nil {
		out.State, out.Reason = FeedNoData, "no feed by that id"
		return out
	}
	out.Unit = feed.Unit
	if feed.Retired {
		out.State, out.Reason = FeedRetired, "this feed was retired and publishes nothing"
		return out
	}

	all := o.obs[feedID]
	if len(all) == 0 {
		out.State, out.Reason = FeedNoData, "this feed has never been published to"
		return out
	}

	// Newest fresh reading per publisher, ignoring anything signed by a key
	// that was later revoked for compromise.
	cutoff := now.Add(-time.Duration(feed.MaxStalenessSec) * time.Second)
	latest := map[string]*Observation{}
	voided := 0
	for _, ob := range all {
		if o.unattributableLocked(ob) {
			voided++
			continue
		}
		if ob.ObservedAt.Before(cutoff) {
			continue
		}
		if cur, ok := latest[ob.Publisher]; !ok || ob.ObservedAt.After(cur.ObservedAt) {
			latest[ob.Publisher] = ob
		}
	}

	if len(latest) == 0 {
		if voided > 0 {
			out.State = FeedUnattributed
			out.Reason = "every fresh reading was signed by a key that has since been revoked for compromise"
			return out
		}
		newest := all[len(all)-1]
		out.State = FeedStale
		out.AgeSec = int(now.Sub(newest.ObservedAt).Seconds())
		out.Reason = fmt.Sprintf("the newest reading is %ds old and this feed stops being usable at %ds",
			out.AgeSec, feed.MaxStalenessSec)
		return out
	}

	vals := make([]float64, 0, len(latest))
	sources := make([]string, 0, len(latest))
	var newest *Observation
	disagreed := false
	for _, ob := range latest {
		vals = append(vals, ob.Value)
		sources = append(sources, ob.Publisher+":"+ob.KeyID)
		if ob.Disputed {
			disagreed = true
		}
		if newest == nil || ob.ObservedAt.After(newest.ObservedAt) {
			newest = ob
		}
	}
	sort.Strings(sources)

	out.Observers = len(vals)
	if len(vals) < feed.MinPublishers {
		out.State = FeedNoQuorum
		out.Reason = fmt.Sprintf("%d of the %d required publishers are fresh", len(vals), feed.MinPublishers)
		out.Sources = sources
		return out
	}

	// The median, not the newest and not the mean. One publisher cannot move
	// a feed with a quorum by sending an extreme value, and an average would
	// let it.
	out.Value = median(vals)
	out.Usable = true
	out.State = FeedUsable
	out.ObservedAt = newest.ObservedAt
	out.AgeSec = int(now.Sub(newest.ObservedAt).Seconds())
	out.Block = newest.Block
	out.Sources = sources
	out.Disagreed = disagreed
	if len(vals) > 1 {
		lo, hi := vals[0], vals[0]
		for _, v := range vals {
			if v < lo {
				lo = v
			}
			if v > hi {
				hi = v
			}
		}
		if med := out.Value; med != 0 {
			out.Spread = float64(int64((hi-lo)/med*100*10000+0.5)) / 10000
		}
	}
	return out
}

// unattributableLocked reports whether the key behind an observation has since
// been revoked for compromise. This is the item 26 consequence applied here:
// if the private key was computable, a signature under it proves nothing,
// including the ones made before anybody noticed.
func (o *OracleRegistry) unattributableLocked(ob *Observation) bool {
	if ob.Unattributable {
		return true
	}
	st := o.keys.Status(ob.PublicKey)
	if void, _ := st["signaturesRetroactivelyVoid"].(bool); void {
		ob.Unattributable = true
		return true
	}
	return false
}

func (o *OracleRegistry) freshValuesLocked(feed *Feed, now time.Time, excluding string) []float64 {
	cutoff := now.Add(-time.Duration(feed.MaxStalenessSec) * time.Second)
	latest := map[string]*Observation{}
	for _, ob := range o.obs[feed.FeedID] {
		if ob.Publisher == excluding || ob.ObservedAt.Before(cutoff) || o.unattributableLocked(ob) {
			continue
		}
		if cur, ok := latest[ob.Publisher]; !ok || ob.ObservedAt.After(cur.ObservedAt) {
			latest[ob.Publisher] = ob
		}
	}
	out := make([]float64, 0, len(latest))
	for _, ob := range latest {
		out = append(out, ob.Value)
	}
	return out
}

// Retire withdraws a feed. Its history stays readable; it stops producing.
func (o *OracleRegistry) Retire(feedID, by, reason string) (*Feed, error) {
	if o == nil {
		return nil, errors.New("oracle: not configured")
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	feed := o.feeds[feedID]
	if feed == nil {
		return nil, fmt.Errorf("no feed called %s", feedID)
	}
	if feed.Retired {
		return feed, nil
	}
	feed.Retired, feed.RetiredAt = true, time.Now().UTC()
	o.commit(BlockFeedRetired, map[string]interface{}{"feedId": feedID, "by": by, "reason": reason})
	cp := *feed
	return &cp, nil
}

// Feeds lists every feed with its current state.
func (o *OracleRegistry) Feeds() []map[string]interface{} {
	if o == nil {
		return nil
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	now := time.Now().UTC()
	out := make([]map[string]interface{}, 0, len(o.order))
	for _, id := range o.order {
		f := o.feeds[id]
		out = append(out, map[string]interface{}{
			"feed": f, "value": o.valueLocked(id, now), "observations": len(o.obs[id]),
		})
	}
	return out
}

// Observations returns a feed's readings, newest first.
func (o *OracleRegistry) Observations(feedID string, limit int) []Observation {
	if o == nil {
		return nil
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	all := o.obs[feedID]
	if limit <= 0 || limit > len(all) {
		limit = len(all)
	}
	out := make([]Observation, 0, limit)
	for i := len(all) - 1; i >= 0 && len(out) < limit; i-- {
		ob := *all[i]
		ob.Unattributable = o.unattributableLocked(all[i])
		out = append(out, ob)
	}
	return out
}

// Posture is the honest summary: what this mechanism does and does not give
// you, with the numbers that make the claim checkable.
func (o *OracleRegistry) Posture() map[string]interface{} {
	if o == nil {
		return map[string]interface{}{"configured": false}
	}
	o.mu.Lock()
	defer o.mu.Unlock()

	now := time.Now().UTC()
	usable, stale, single := 0, 0, 0
	for _, id := range o.order {
		v := o.valueLocked(id, now)
		switch {
		case v.Usable:
			usable++
		case v.State == FeedStale:
			stale++
		}
		if o.feeds[id].MinPublishers < 2 {
			single++
		}
	}
	return map[string]interface{}{
		"configured":        true,
		"feeds":             len(o.order),
		"usableNow":         usable,
		"staleNow":          stale,
		"singleSourceFeeds": single,
		"rules": []string{
			"Every observation is signed, and the key must be registered, screened and not revoked.",
			"Every feed declares the age at which its values stop being usable, and a stale feed refuses rather than returning the last value.",
			"A nonce cannot be reused and a publisher's timestamps cannot go backwards.",
			"A timestamp more than two minutes in the future is refused.",
			"With a quorum the usable value is the median, so one publisher cannot move it.",
			"A reading that disagrees with its peers is kept and marked, never dropped or averaged away.",
			"A key revoked for compromise makes the readings it signed unattributable, including earlier ones.",
		},
		"limits": []string{
			"This is not a decentralised oracle network: there is no staking, no slashing and no incentive design.",
			"A feed is exactly as trustworthy as the holders of its publishing keys.",
			fmt.Sprintf("%d of %d feeds have a single required publisher, which is provenance rather than consensus.", single, len(o.order)),
			"Nothing here makes an outside fact true. It makes it attributable, timely and auditable.",
		},
	}
}

func (o *OracleRegistry) reject(feedID, publisher, code, detail string) error {
	o.commit(BlockFeedRejected, map[string]interface{}{
		"feedId": feedID, "publisher": publisher, "code": code, "reason": detail,
	})
	return fmt.Errorf("%s: %s", code, detail)
}

func (o *OracleRegistry) commit(blockType string, txn map[string]interface{}) *DrunixBlock {
	if o.chain == nil {
		return nil
	}
	return o.chain.Append(blockType, []map[string]interface{}{txn})
}

func median(v []float64) float64 {
	if len(v) == 0 {
		return 0
	}
	s := append([]float64(nil), v...)
	sort.Float64s(s)
	n := len(s)
	if n%2 == 1 {
		return s[n/2]
	}
	return (s[n/2-1] + s[n/2]) / 2
}
