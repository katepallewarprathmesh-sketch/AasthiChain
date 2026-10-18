package drunix

// Attestation accountability: who vouched, and what happens downstream when
// they turn out to be wrong.
//
// The chain that matters runs upstream of the token:
//
//	real asset -> attestation -> credential -> token
//
// Almost all the engineering goes into the last step and almost all the risk
// sits in the second. This file is about the second. The rail already issues
// signed credentials (credentials.go) and settles tokens against them
// (umi.go); what was missing was the join between them:
//
//   - who attested this asset, and what are they on the hook for
//   - if that attestation is withdrawn, which holders are affected, how many
//     tokens, how much settled value, and in which trades
//   - what the attestor's record looks like over time
//
// Withdrawing an attestation does not claw anything back. There is no
// mechanism here that reverses a settled trade, and pretending otherwise
// would be worse than saying nothing: what it does is make the exposure
// explicit and put it on the ledger, so nobody has to discover it by reading
// the chain by hand.

import (
	"sort"
	"strings"
	"sync"
	"time"
)

// Block types for the accountability record.
const (
	// BlockAttestationWithdrawn records that an attestation the market
	// relied on has been withdrawn, and who was holding when it happened.
	BlockAttestationWithdrawn = "UMI_ATTESTATION_WITHDRAWN"
)

// AttestationDisclaimer is attached to every answer this file produces.
const AttestationDisclaimer = "Attestors here are demo identities on a simulated rail. The signatures, the anchors and the " +
	"exposure arithmetic are real; the legal accountability of an attestor is not. Withdrawing an attestation " +
	"does not reverse any settled trade, and nothing in this system does."

// HolderExposure is one downstream holder of an attested asset.
type HolderExposure struct {
	Holder string `json:"holder"`
	Tokens int64  `json:"tokens"`
}

// TradeExposure is one settled trade that happened while the attestation
// stood. These are the trades whose pricing relied on it.
type TradeExposure struct {
	InstructionID string    `json:"instructionId"`
	Buyer         string    `json:"buyer"`
	Seller        string    `json:"seller"`
	Tokens        int64     `json:"tokens"`
	CashPaise     int64     `json:"cashPaise"`
	SettledAt     time.Time `json:"settledAt"`
}

// AttestationImpact is the answer to "what rests on this attestation".
type AttestationImpact struct {
	CredentialID string `json:"credentialId"`
	Type         string `json:"type"`
	AssetID      string `json:"assetId"`
	Attestor     string `json:"attestor"`
	IssuedBlock  int64  `json:"issuedBlock"`
	IssuedAt     string `json:"issuedAt"`

	Withdrawn       bool   `json:"withdrawn"`
	WithdrawnBy     string `json:"withdrawnBy,omitempty"`
	WithdrawnReason string `json:"withdrawnReason,omitempty"`
	WithdrawnBlock  int64  `json:"withdrawnBlock,omitempty"`

	Holders          []HolderExposure `json:"holders"`
	HolderCount      int              `json:"holderCount"`
	TokensOutstandng int64            `json:"tokensOutstanding"`
	Trades           []TradeExposure  `json:"tradesWhileStanding"`
	TradeCount       int              `json:"tradeCount"`
	ValueSettledPais int64            `json:"valueSettledPaiseWhileStanding"`

	Accountability string `json:"accountability"`
	Recourse       string `json:"recourse"`
	Disclaimer     string `json:"disclaimer"`
}

// AttestorRecord is an attestor's track record. An attestation is only worth
// what the attestor's record is worth, and a record nobody can read is not a
// record.
type AttestorRecord struct {
	Attestor         string `json:"attestor"`
	DID              string `json:"did"`
	PublicKey        string `json:"publicKey,omitempty"`
	Issued           int    `json:"issued"`
	Withdrawn        int    `json:"withdrawn"`
	Standing         int    `json:"standing"`
	WithdrawalRate   string `json:"withdrawalRate"`
	AssetsAttested   int    `json:"assetsAttested"`
	ExposureTokens   int64  `json:"tokensRestingOnThisAttestor"`
	LastWithdrawalAt string `json:"lastWithdrawalAt,omitempty"`
	Accountability   string `json:"accountability"`
	Disclaimer       string `json:"disclaimer"`
}

// AttestationService joins the credential registry to the settlement rail.
// It owns no state of its own beyond a mutex: every figure it reports is
// derived at read time from the two registries, so it cannot drift away from
// them.
type AttestationService struct {
	mu    sync.Mutex
	chain *DrunixChain
	creds *CredentialRegistry
	rail  *UMIRail
}

// NewAttestationService wires the accountability view. Any of the
// dependencies may be nil, in which case the routes are not mounted.
func NewAttestationService(chain *DrunixChain, creds *CredentialRegistry, rail *UMIRail) *AttestationService {
	if chain == nil || creds == nil || rail == nil {
		return nil
	}
	return &AttestationService{chain: chain, creds: creds, rail: rail}
}

// accountabilityFor says, in one sentence, what this kind of attestor is
// vouching for. Saying it plainly is the point: "validated" on its own does
// not tell a holder what was actually checked.
func accountabilityFor(credType string) string {
	switch credType {
	case CredentialTitleValidation:
		return "The attestor states that the title record it inspected names this owner and carries no encumbrance " +
			"it could see at the time of signing. It does not state that the property is free of claims that were " +
			"never recorded, and it is not a guarantee of value."
	case CredentialKYCStatus:
		return "The attestor states that it checked this participant's identity documents at the time of signing. " +
			"It does not state that the participant remains in good standing today."
	case CredentialDelegated:
		return "The principal states that it delegated bounded authority to this agent. The bounds, not the " +
			"statement, are what the rail enforces."
	default:
		return "The attestor states that the claims in this credential were true at the time of signing."
	}
}

// assetOf pulls the asset a credential speaks about, if it speaks about one.
func assetOf(rec *credentialRecord) string {
	if rec == nil || rec.Credential == nil || rec.Credential.CredentialSubject == nil {
		return ""
	}
	if v, ok := rec.Credential.CredentialSubject["assetId"].(string); ok {
		return strings.TrimSpace(v)
	}
	return ""
}

// Impact reports everything resting on one attestation.
func (a *AttestationService) Impact(credentialID string) (*AttestationImpact, error) {
	if a == nil {
		return nil, ErrCredNotFound
	}
	rec, err := a.creds.Get(credentialID)
	if err != nil {
		return nil, err
	}
	out := &AttestationImpact{
		CredentialID:    rec.Credential.ID,
		AssetID:         assetOf(rec),
		Attestor:        rec.IssuedBy,
		IssuedBlock:     rec.IssuedBlock,
		IssuedAt:        rec.Credential.IssuanceDate,
		Withdrawn:       rec.Revoked,
		WithdrawnBy:     rec.RevokedBy,
		WithdrawnReason: rec.RevokedReason,
		WithdrawnBlock:  rec.RevokedBlock,
		Holders:         []HolderExposure{},
		Trades:          []TradeExposure{},
		Disclaimer:      AttestationDisclaimer,
		Recourse: "None is implemented. A real deployment would attach an indemnity, an insurer or a regulator " +
			"to this point, and that is the design question this view exists to make visible.",
	}
	for _, t := range rec.Credential.Type {
		if t != "VerifiableCredential" {
			out.Type = t
		}
	}
	out.Accountability = accountabilityFor(out.Type)

	if out.AssetID == "" {
		// A credential about a person rather than an asset has no token
		// exposure. Saying so beats reporting a confident zero.
		out.Accountability += " This credential is not about a specific asset, so no token exposure is derived."
		return out, nil
	}

	for holder, tokens := range a.rail.Securities().Holders(out.AssetID) {
		out.Holders = append(out.Holders, HolderExposure{Holder: holder, Tokens: tokens})
		out.TokensOutstandng += tokens
	}
	sort.Slice(out.Holders, func(i, j int) bool {
		if out.Holders[i].Tokens != out.Holders[j].Tokens {
			return out.Holders[i].Tokens > out.Holders[j].Tokens
		}
		return out.Holders[i].Holder < out.Holders[j].Holder
	})
	out.HolderCount = len(out.Holders)

	// Trades that settled while the attestation stood: after it was issued,
	// and before it was withdrawn if it ever was. A trade that settled
	// before the attestation existed did not rely on it.
	issued, issuedOK := parseAttestTime(rec.Credential.IssuanceDate)
	for _, si := range a.rail.SettledForAsset(out.AssetID) {
		if issuedOK && si.SettledAt.Before(issued) {
			continue
		}
		if rec.Revoked && rec.RevokedBlock > 0 && si.BlockHeight > rec.RevokedBlock {
			continue
		}
		out.Trades = append(out.Trades, TradeExposure{
			InstructionID: si.InstructionID,
			Buyer:         si.Buyer,
			Seller:        si.Seller,
			Tokens:        si.Tokens,
			CashPaise:     si.CashPaise,
			SettledAt:     *si.SettledAt,
		})
		out.ValueSettledPais += si.CashPaise
	}
	sort.Slice(out.Trades, func(i, j int) bool {
		return out.Trades[i].SettledAt.Before(out.Trades[j].SettledAt)
	})
	out.TradeCount = len(out.Trades)
	return out, nil
}

func parseAttestTime(s string) (time.Time, bool) {
	t, err := time.Parse(time.RFC3339, strings.TrimSpace(s))
	if err != nil {
		return time.Time{}, false
	}
	return t.UTC(), true
}

// RecordWithdrawal puts the downstream exposure of a withdrawn attestation on
// the ledger at the moment it is withdrawn.
//
// The figures are snapshotted deliberately. Deriving them later would answer
// "who holds this now", and the question a holder actually asks is "who was
// exposed when the attestation fell over".
func (a *AttestationService) RecordWithdrawal(credentialID string) (*AttestationImpact, *DrunixBlock) {
	if a == nil {
		return nil, nil
	}
	impact, err := a.Impact(credentialID)
	if err != nil || !impact.Withdrawn || impact.AssetID == "" {
		return impact, nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()

	holders := make([]map[string]interface{}, 0, len(impact.Holders))
	for _, h := range impact.Holders {
		holders = append(holders, map[string]interface{}{"holder": h.Holder, "tokens": h.Tokens})
	}
	blk := a.chain.Append(BlockAttestationWithdrawn, []map[string]interface{}{{
		"credentialId":      impact.CredentialID,
		"assetId":           impact.AssetID,
		"attestor":          impact.Attestor,
		"withdrawnBy":       impact.WithdrawnBy,
		"reason":            impact.WithdrawnReason,
		"holders":           holders,
		"holderCount":       impact.HolderCount,
		"tokensOutstanding": impact.TokensOutstandng,
		"tradesAffected":    impact.TradeCount,
		"valueSettledPaise": impact.ValueSettledPais,
		"effect": "Notice only. No settled trade is reversed and no token is frozen by this record. " +
			"It exists so the exposure is discoverable rather than buried.",
		"disclaimer": AttestationDisclaimer,
	}})
	return impact, blk
}

// Attestor reports one attestor's record.
func (a *AttestationService) Attestor(id string) *AttestorRecord {
	if a == nil {
		return nil
	}
	id = strings.TrimSpace(id)
	out := &AttestorRecord{
		Attestor:   id,
		DID:        "did:aasthi:" + strings.ToLower(id),
		PublicKey:  a.creds.PublicKeyOf(id),
		Disclaimer: AttestationDisclaimer,
	}
	assets := map[string]bool{}
	var lastWithdrawal string
	for _, rec := range a.creds.List("", "", 0) {
		if !strings.EqualFold(rec.IssuedBy, id) {
			continue
		}
		out.Issued++
		if rec.Revoked {
			out.Withdrawn++
			if rec.Credential != nil && rec.Credential.IssuanceDate > lastWithdrawal {
				lastWithdrawal = rec.Credential.IssuanceDate
			}
			continue
		}
		out.Standing++
		if asset := assetOf(rec); asset != "" && !assets[asset] {
			assets[asset] = true
			for _, tokens := range a.rail.Securities().Holders(asset) {
				out.ExposureTokens += tokens
			}
		}
	}
	out.AssetsAttested = len(assets)
	out.LastWithdrawalAt = lastWithdrawal
	out.WithdrawalRate = "0% (0 of 0)"
	if out.Issued > 0 {
		out.WithdrawalRate = itoaPct(out.Withdrawn, out.Issued)
	}
	out.Accountability = "This rail records what an attestor signed and what was withdrawn. It does not enforce a " +
		"penalty, because there is nobody here to enforce it against. In a real deployment this record is the input " +
		"to whatever does: an indemnity, a licence condition, or removal from the attestor set."
	return out
}

func itoaPct(n, of int) string {
	if of == 0 {
		return "0% (0 of 0)"
	}
	pct := (n * 100) / of
	return itoa(pct) + "% (" + itoa(n) + " of " + itoa(of) + ")"
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	if neg {
		return "-" + string(b)
	}
	return string(b)
}
