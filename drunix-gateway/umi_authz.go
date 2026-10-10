package drunix

import (
	"net/http"
	"strings"
)

// Who is asking, and are they allowed to move this money?
//
// The rail had no notion of a caller at all. Every /umi/* route acted on
// whatever participant the URL or the body named, so anyone who could reach
// it could read a stranger's e₹-W wallet, credit a wallet out of nothing, or
// run a settlement that spent someone else's cash balance. The node layer in
// front of it is a pure proxy and holds no UMI state, so the check belongs
// here, next to the ledger it protects.
//
// Identity arrives in the headers the gateway forwards. The rail does not
// authenticate anyone itself — that is the gateway's job — it decides what
// an already-identified caller may touch.

type umiCaller struct {
	ID   string
	Role string
}

func (c umiCaller) anonymous() bool { return c.ID == "" }

// Regulators and admins supervise the whole rail: that is the role, not a
// loophole. Funding wallets is a settlement-bank act, so it lives here too.
func (c umiCaller) supervisor() bool {
	switch strings.ToLower(c.Role) {
	case "regulator", "admin":
		return true
	}
	return false
}

func (c umiCaller) is(participant string) bool {
	return c.ID != "" && strings.EqualFold(c.ID, participant)
}

func callerOf(r *http.Request) umiCaller {
	id := firstHeader(r, "X-Fabric-Identity", "X-Identity-Id", "X-Umi-Identity")
	role := firstHeader(r, "X-Identity-Role", "X-Umi-Role")
	return umiCaller{ID: strings.TrimSpace(id), Role: strings.TrimSpace(role)}
}

func firstHeader(r *http.Request, names ...string) string {
	for _, n := range names {
		if v := r.Header.Get(n); v != "" {
			return v
		}
	}
	return ""
}

// umiRequireIdentity answers 401 when the gateway forwarded no identity at
// all. Reporting and reconciliation stay open; anything touching a balance
// does not.
func umiRequireIdentity(w http.ResponseWriter, c umiCaller) bool {
	if c.anonymous() {
		umiErr(w, http.StatusUnauthorized, "ERR_UMI_NO_IDENTITY",
			"This route acts on a named participant's record and needs an identified caller.")
		return false
	}
	return true
}

// umiRequireSelfOrSupervisor guards anything scoped to one participant.
func umiRequireSelfOrSupervisor(w http.ResponseWriter, c umiCaller, participant, what string) bool {
	if !umiRequireIdentity(w, c) {
		return false
	}
	if c.is(participant) || c.supervisor() {
		return true
	}
	umiErr(w, http.StatusForbidden, "ERR_UMI_NOT_YOURS", what+" belongs to "+participant+".")
	return false
}

// umiRequireSupervisor guards acts that create money rather than move it.
func umiRequireSupervisor(w http.ResponseWriter, c umiCaller, what string) bool {
	if !umiRequireIdentity(w, c) {
		return false
	}
	if c.supervisor() {
		return true
	}
	umiErr(w, http.StatusForbidden, "ERR_UMI_NOT_SUPERVISOR", what+" is a settlement-bank action.")
	return false
}

// umiRequireAssetStake decides who may anchor evidence against an asset.
//
// Anchoring was open to the world, including callers with no identity at
// all: anyone could plant a second TITLE_DEED or a VALIDATION_CERTIFICATE on
// someone else's listing, and the submittedBy field came from the request
// body, so they could sign it as anybody. The verify report counts anchored
// documents as evidence, which made this a way to forge due diligence.
//
// Rule: supervisors and registrars (who issue certificates) always may; a
// participant may anchor against an asset they actually hold a position in.
// Everyone else is refused.
func umiRequireAssetStake(w http.ResponseWriter, c umiCaller, assetID string, holds func(assetID, holder string) int64) bool {
	if !umiRequireIdentity(w, c) {
		return false
	}
	if c.supervisor() || strings.EqualFold(c.Role, "registrar") {
		return true
	}
	if assetID != "" && holds != nil && holds(assetID, c.ID) > 0 {
		return true
	}
	writeJSON(w, http.StatusForbidden, map[string]interface{}{
		"error":      "ERR_UMI_NOT_YOUR_ASSET",
		"message":    "Anchoring a document against an asset is limited to its holders, a registrar, or a supervisor.",
		"mode":       UMIMode,
		"disclaimer": UMIDisclaimer,
	})
	return false
}
