package drunix

// HTTP surface for the public-chain token mirror (tokenmirror.go).
//
//	GET  /umi/token            what is configured, what it can write, what it wrote
//	GET  /umi/token/compare    every linked wallet against its rail position
//	POST /umi/token/link       register a holder's Ethereum address on chain
//	POST /umi/token/mirror     mint the shortfall so the chain matches the rail
//
// Reads are public. The whole claim being made is that an outsider can check
// our tokens against a public chain, and a status page they need a key to see
// would undercut it. Writes require an identity because they spend gas and
// mint supply.

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

func (s *Server) registerTokenMirrorRoutes(mux *http.ServeMux) {
	if s.TokenMirror == nil {
		return
	}
	mux.HandleFunc("/umi/token", s.durabilityGate(s.handleTokenStatus))
	mux.HandleFunc("/umi/token/compare", s.durabilityGate(s.handleTokenCompare))
	mux.HandleFunc("/umi/token/link", s.durabilityGate(s.handleTokenLink))
	mux.HandleFunc("/umi/token/mirror", s.durabilityGate(s.handleTokenMirror))
}

// tokenStatusFor maps a refusal to a status code. The distinction that
// matters: 409 means the rail refused on a rule, 503 means nothing was
// configured to write with. Collapsing them would let a missing key read as
// a policy decision.
func tokenStatusFor(err error) (int, string) {
	switch {
	case errors.Is(err, ErrTokenFields), errors.Is(err, ErrTokenAddress):
		return http.StatusBadRequest, "ERR_UMI_TOKEN_FIELDS"
	case errors.Is(err, ErrTokenNotKYC):
		return http.StatusForbidden, "ERR_UMI_TOKEN_HOLDER_NOT_VERIFIED"
	case errors.Is(err, ErrTokenNotLinked), errors.Is(err, ErrTokenNoPosition):
		return http.StatusConflict, "ERR_UMI_TOKEN_NOTHING_TO_MIRROR"
	case errors.Is(err, ErrTokenCurrent):
		return http.StatusConflict, "ERR_UMI_TOKEN_ALREADY_CURRENT"
	case errors.Is(err, ErrTokenExceeds):
		return http.StatusConflict, "ERR_UMI_TOKEN_EXCEEDS_RAIL_POSITION"
	case errors.Is(err, ErrTokenNoSigner), errors.Is(err, ErrEVMNoSigner):
		return http.StatusServiceUnavailable, "ERR_UMI_TOKEN_NO_SIGNER"
	case errors.Is(err, ErrTokenNoChain):
		return http.StatusServiceUnavailable, "ERR_UMI_TOKEN_NO_CHAIN"
	case errors.Is(err, ErrTokenReverted):
		return http.StatusConflict, "ERR_UMI_TOKEN_CONTRACT_REFUSED"
	case errors.Is(err, ErrTokenGas):
		return http.StatusServiceUnavailable, "ERR_UMI_TOKEN_NO_GAS"
	default:
		return http.StatusBadGateway, "ERR_UMI_TOKEN_WRITE_FAILED"
	}
}

func (s *Server) handleTokenStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		umiErr(w, http.StatusMethodNotAllowed, "ERR_METHOD", "GET reports the mirror's configuration and its writes.")
		return
	}
	st := s.TokenMirror.Status()
	st["records"] = s.TokenMirror.Records()
	st["links"] = s.TokenMirror.Links()
	st["contract"] = map[string]interface{}{
		"source":    "contracts/PropertyToken.sol",
		"standards": []string{"ERC-20", "ERC-7943 (uRWA)", "arranged as ERC-3643"},
		"role": "A mirror of the rail position, never the record of title. Settlement, the cash " +
			"leg and the register stay on the rail.",
	}
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) handleTokenCompare(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		umiErr(w, http.StatusMethodNotAllowed, "ERR_METHOD", "GET compares linked wallets with the rail.")
		return
	}
	assetID := strings.TrimSpace(r.URL.Query().Get("assetId"))
	if assetID == "" {
		umiErr(w, http.StatusBadRequest, "ERR_UMI_TOKEN_FIELDS", "assetId is required: a position is always a position in something.")
		return
	}
	writeJSON(w, http.StatusOK, s.TokenMirror.Compare(assetID))
}

func (s *Server) handleTokenLink(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		umiErr(w, http.StatusMethodNotAllowed, "ERR_METHOD", "POST registers an Ethereum address for a holder.")
		return
	}
	caller := callerOf(r)
	if !umiRequireIdentity(w, caller) {
		return
	}
	var body struct {
		Holder string `json:"holder"`
		Wallet string `json:"wallet"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		umiErr(w, http.StatusBadRequest, "ERR_UMI_TOKEN_FIELDS", "invalid JSON: "+err.Error())
		return
	}
	rec, err := s.TokenMirror.Link(body.Holder, body.Wallet, caller.ID)
	if err != nil {
		status, code := tokenStatusFor(err)
		writeJSON(w, status, map[string]interface{}{
			"error": code, "message": err.Error(),
			"refusalRecorded": true,
			"note": "The refusal is on the ledger as " + BlockTokenRefused +
				". A decision that leaves no trace cannot be audited.",
		})
		return
	}
	writeJSON(w, http.StatusCreated, map[string]interface{}{"record": rec})
}

func (s *Server) handleTokenMirror(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		umiErr(w, http.StatusMethodNotAllowed, "ERR_METHOD", "POST mirrors a rail position onto the public chain.")
		return
	}
	caller := callerOf(r)
	if !umiRequireIdentity(w, caller) {
		return
	}
	var body struct {
		AssetID string `json:"assetId"`
		Holder  string `json:"holder"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		umiErr(w, http.StatusBadRequest, "ERR_UMI_TOKEN_FIELDS", "invalid JSON: "+err.Error())
		return
	}
	rec, err := s.TokenMirror.Mirror(body.AssetID, body.Holder, caller.ID)
	if err != nil {
		status, code := tokenStatusFor(err)
		writeJSON(w, status, map[string]interface{}{
			"error": code, "message": err.Error(),
			"refusalRecorded": true,
			"invariant":       "the on-chain balance of a linked wallet never exceeds the holder's rail position",
		})
		return
	}
	writeJSON(w, http.StatusCreated, map[string]interface{}{"record": rec})
}
