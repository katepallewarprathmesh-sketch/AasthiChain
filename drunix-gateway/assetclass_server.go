package drunix

// HTTP surface for the asset-class registry and carbon retirement.
//
// Mounted alongside the rest of /umi/*, with the same identity rules: a
// registration is a supervisory act, a retirement may only be performed by
// the holder whose credits are being consumed (or a supervisor acting for
// them). Retirement is irreversible, so it is deliberately harder to do by
// accident than a transfer.

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
)

func (s *Server) handleUMIAssets(w http.ResponseWriter, r *http.Request) {
	if s.UMI == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "ERR_UMI_DISABLED"})
		return
	}
	switch r.Method {
	case http.MethodGet:
		profiles := s.UMI.AssetProfiles()
		// Enrich with live supply so one call answers "what is this asset and
		// how much of it is left", which is the question both the UI and a
		// reconciling participant actually ask.
		rows := make([]map[string]interface{}, 0, len(profiles))
		for _, p := range profiles {
			authorised, outstanding := s.UMI.AuthorisedSupply(p.AssetID)
			row := map[string]interface{}{
				"profile":           p,
				"authorisedTokens":  authorised,
				"outstandingTokens": outstanding,
			}
			if p.Class == AssetClassCarbon {
				retired := s.UMI.RetiredTokens(p.AssetID)
				row["retiredTokens"] = retired
				row["conserved"] = outstanding+retired <= authorised
			}
			rows = append(rows, row)
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"assets":  rows,
			"count":   len(rows),
			"classes": []string{AssetClassProperty, AssetClassCarbon},
			"note": "An asset with no profile is a PROPERTY. The settlement core does not read this registry: " +
				"DvP moves tokens against paise whatever the class says.",
			"disclaimer": UMIDisclaimer,
		})
	case http.MethodPost:
		caller := callerOf(r)
		if !umiRequireSupervisor(w, caller, "register an asset class") {
			return
		}
		var req AssetProfile
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			umiErr(w, http.StatusBadRequest, "ERR_BAD_REQUEST", "Body must be a JSON asset profile.")
			return
		}
		p, err := s.UMI.RegisterAsset(req)
		if err != nil {
			status := http.StatusBadRequest
			if err == ErrUMIAssetClassLocked {
				status = http.StatusConflict
			}
			umiErr(w, status, errCode(err), assetClassMessage(err))
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"profile": p})
	default:
		umiErr(w, http.StatusMethodNotAllowed, "ERR_METHOD", "GET or POST required")
	}
}

func (s *Server) handleUMIAsset(w http.ResponseWriter, r *http.Request) {
	if s.UMI == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "ERR_UMI_DISABLED"})
		return
	}
	assetID := strings.TrimPrefix(r.URL.Path, "/umi/assets/")
	if assetID == "" {
		umiErr(w, http.StatusBadRequest, "ERR_UMI_UNKNOWN_ASSET", "Asset id required in the path.")
		return
	}
	p := s.UMI.AssetProfileOf(assetID)
	authorised, outstanding := s.UMI.AuthorisedSupply(assetID)
	out := map[string]interface{}{
		"profile":           p,
		"authorisedTokens":  authorised,
		"outstandingTokens": outstanding,
	}
	if p.Class == AssetClassCarbon {
		retired := s.UMI.RetiredTokens(assetID)
		out["retiredTokens"] = retired
		out["conserved"] = outstanding+retired <= authorised
		out["retirements"] = s.UMI.Retirements(assetID)
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleUMICarbonRetire(w http.ResponseWriter, r *http.Request) {
	if s.UMI == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "ERR_UMI_DISABLED"})
		return
	}
	if !requirePost(w, r) {
		return
	}
	var req struct {
		AssetID     string `json:"assetId"`
		Holder      string `json:"holder"`
		Tokens      int64  `json:"tokens"`
		Beneficiary string `json:"beneficiary"`
		Reason      string `json:"reason"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		umiErr(w, http.StatusBadRequest, "ERR_BAD_REQUEST", "Body must be JSON.")
		return
	}
	caller := callerOf(r)
	// Retirement destroys value that belongs to the holder and cannot be
	// undone, so it is held to the same rule as spending their wallet.
	if !umiRequireSelfOrSupervisor(w, caller, req.Holder, "retire credits held by") {
		return
	}
	rec, err := s.UMI.RetireCredits(req.AssetID, req.Holder, req.Tokens, req.Beneficiary, req.Reason)
	if err != nil {
		status := http.StatusBadRequest
		if err == ErrUMIInsufficientSecurities {
			status = http.StatusConflict
		}
		umiErr(w, status, errCode(err), assetClassMessage(err))
		return
	}
	authorised, outstanding := s.UMI.AuthorisedSupply(req.AssetID)
	retired := s.UMI.RetiredTokens(req.AssetID)
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"retirement":        rec,
		"authorisedTokens":  authorised,
		"outstandingTokens": outstanding,
		"retiredTokens":     retired,
		"conserved":         outstanding+retired <= authorised,
		"irreversible":      true,
		"certificate": "Block " + strconv.FormatInt(rec.BlockHeight, 10) + " is the certificate. " +
			"These credits are permanently consumed and can never be settled again.",
		"disclaimer": UMIDisclaimer,
	})
}

func (s *Server) handleUMICarbonRetirements(w http.ResponseWriter, r *http.Request) {
	if s.UMI == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "ERR_UMI_DISABLED"})
		return
	}
	rows := s.UMI.Retirements(strings.TrimSpace(r.URL.Query().Get("assetId")))
	var total int64
	for _, rec := range rows {
		total += rec.Tokens
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"retirements":   rows,
		"count":         len(rows),
		"retiredTokens": total,
		"note": "Retirement is permanent. Each row names a block that proves it, " +
			"and the retired total counts against issued supply so the same credit cannot be sold twice.",
		"disclaimer": UMIDisclaimer,
	})
}

func assetClassMessage(err error) string {
	switch err {
	case ErrUMINotRetirable:
		return "Only a CARBON asset can be retired. Register the asset class first, and note that a property has no retirement lifecycle."
	case ErrUMIInsufficientSecurities:
		return "That holder does not have enough credits to retire."
	case ErrUMIAssetClassLocked:
		return "An asset's class cannot be changed once set: positions and retirements are interpreted through it, so changing it would reinterpret history."
	case ErrUMIUnknownAssetClass:
		return "Unknown asset class. Supported: PROPERTY, CARBON."
	case ErrUMIInvalidAmount:
		return "Token count must be a positive whole number."
	case ErrUMIUnknownAsset:
		return "Asset id is required."
	}
	return "Request rejected."
}
