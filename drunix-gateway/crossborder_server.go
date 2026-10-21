package drunix

// HTTP surface for the cross-border funding leg (crossborder.go).
//
//	GET  /umi/crossborder/rules          what the leg will and will not do
//	GET  /umi/crossborder                intents (own, or all for a supervisor)
//	POST /umi/crossborder                ask for a quote
//	GET  /umi/crossborder/{id}
//	POST /umi/crossborder/{id}/payment   record a transfer reference
//	POST /umi/crossborder/{id}/offramp   provider attestation, credits rupees
//
// The rules endpoint is public and unauthenticated on purpose. A buyer who is
// not allowed to purchase should be able to learn that without handing over a
// passport number first.

import (
	"errors"
	"net/http"
	"strings"
	"time"
)

func (s *Server) registerCrossBorderRoutes(mux *http.ServeMux) {
	if s.CrossBorder == nil {
		return
	}
	mux.HandleFunc("/umi/crossborder/rules", s.durabilityGate(s.handleCBXRules))
	mux.HandleFunc("/umi/crossborder", s.durabilityGate(s.handleCBXCollection))
	mux.HandleFunc("/umi/crossborder/", s.durabilityGate(s.handleCBXItem))
}

func cbxStatusFor(err error) (int, string) {
	switch {
	case errors.Is(err, ErrCBXNotFound):
		return http.StatusNotFound, "ERR_UMI_CBX_NOT_FOUND"
	case errors.Is(err, ErrCBXNotBuyer):
		return http.StatusForbidden, "ERR_UMI_CBX_NOT_BUYER"
	case errors.Is(err, ErrCBXIneligible):
		return http.StatusForbidden, "ERR_UMI_CBX_INELIGIBLE"
	case errors.Is(err, ErrCBXRestricted):
		return http.StatusForbidden, "ERR_UMI_CBX_RESTRICTED_NATIONALITY"
	case errors.Is(err, ErrCBXKYC):
		return http.StatusForbidden, "ERR_UMI_CBX_KYC_REQUIRED"
	case errors.Is(err, ErrCBXTravelRule):
		return http.StatusBadRequest, "ERR_UMI_CBX_TRAVEL_RULE"
	case errors.Is(err, ErrCBXExpired):
		return http.StatusConflict, "ERR_UMI_CBX_QUOTE_EXPIRED"
	case errors.Is(err, ErrCBXState):
		return http.StatusConflict, "ERR_UMI_CBX_STATE"
	case errors.Is(err, ErrCBXOfframp):
		return http.StatusConflict, "ERR_UMI_CBX_OFFRAMP"
	default:
		return http.StatusBadRequest, "ERR_UMI_CBX_FIELDS"
	}
}

func (s *Server) handleCBXRules(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		umiErr(w, http.StatusMethodNotAllowed, "ERR_METHOD", "Use GET.")
		return
	}
	writeJSON(w, http.StatusOK, s.CrossBorder.Rules())
}

func (s *Server) handleCBXCollection(w http.ResponseWriter, r *http.Request) {
	now := time.Now().UTC()
	c := callerOf(r)
	if !umiRequireIdentity(w, c) {
		return
	}

	switch r.Method {
	case http.MethodGet:
		scope := c.ID
		if c.supervisor() {
			scope = ""
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"intents":    s.CrossBorder.Intents(scope, queryLimit(r, 50, 200), now),
			"disclaimer": CBXDisclaimer,
		})

	case http.MethodPost:
		var body CBXRequest
		if err := umiDecode(r, &body); err != nil {
			umiErr(w, http.StatusBadRequest, "ERR_BAD_JSON", err.Error())
			return
		}
		intent, err := s.CrossBorder.Quote(body, c.ID, now)
		if err != nil {
			code, sentinel := cbxStatusFor(err)
			umiErr(w, code, sentinel, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"intent":     intent,
			"disclaimer": CBXDisclaimer,
		})

	default:
		umiErr(w, http.StatusMethodNotAllowed, "ERR_METHOD", "GET or POST.")
	}
}

func (s *Server) handleCBXItem(w http.ResponseWriter, r *http.Request) {
	now := time.Now().UTC()
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/umi/crossborder/"), "/")
	if rest == "" {
		umiErr(w, http.StatusBadRequest, "ERR_UMI_CBX_FIELDS", "Name an intent.")
		return
	}
	parts := strings.Split(rest, "/")
	id := parts[0]

	c := callerOf(r)
	if !umiRequireIdentity(w, c) {
		return
	}

	if len(parts) == 1 {
		if r.Method != http.MethodGet {
			umiErr(w, http.StatusMethodNotAllowed, "ERR_METHOD", "Use GET.")
			return
		}
		intent, found := s.CrossBorder.Intent(id, now)
		if !found {
			umiErr(w, http.StatusNotFound, "ERR_UMI_CBX_NOT_FOUND", "No funding intent "+id+".")
			return
		}
		if !c.supervisor() && !strings.EqualFold(intent.Buyer, c.ID) {
			umiErr(w, http.StatusForbidden, "ERR_UMI_CBX_NOT_BUYER",
				"A funding intent carries identity data. It is readable by the buyer and by a supervisor.")
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"intent": intent, "disclaimer": CBXDisclaimer})
		return
	}

	if !requirePost(w, r) {
		return
	}

	switch strings.ToLower(parts[1]) {
	case "payment":
		var body struct {
			TransferRef string `json:"transferRef"`
		}
		if err := umiDecode(r, &body); err != nil {
			umiErr(w, http.StatusBadRequest, "ERR_BAD_JSON", err.Error())
			return
		}
		intent, err := s.CrossBorder.RecordPayment(id, body.TransferRef, c.ID, now)
		if err != nil {
			code, sentinel := cbxStatusFor(err)
			umiErr(w, code, sentinel, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"intent": intent,
			"note":   "Recorded as reported. No chain is connected, so nothing here confirms the transfer.",
		})

	case "offramp":
		intent, err := s.CrossBorder.Offramp(id, c.ID, c.supervisor(), now)
		if err != nil {
			code, sentinel := cbxStatusFor(err)
			umiErr(w, code, sentinel, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"intent": intent,
			"note": "Rupees credited against the provider's attestation of an inward remittance. " +
				"Settlement now runs through the ordinary DvP path, in rupees.",
			"disclaimer": CBXDisclaimer,
		})

	default:
		umiErr(w, http.StatusNotFound, "ERR_UMI_CBX_NO_ACTION", "No action "+parts[1]+" on a funding intent.")
	}
}
