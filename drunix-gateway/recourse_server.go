package drunix

// HTTP surface for recourse (recourse.go).
//
//	GET  /umi/recourse                        the model, and how to read a zero
//	GET  /umi/recourse/{assetId}              the terms this asset is sold under
//	POST /umi/recourse/simulate               {assetId, trigger, holder} -> the waterfall
//	POST /umi/recourse/terms                  set the terms (registrar/supervisor)
//	POST /umi/recourse/{assetId}/declare      {trigger, reason} (supervisor)
//
// Reads are public, like backing and attestations. What a holder gets when
// the asset fails is the single piece of information least likely to be
// published voluntarily, which is exactly why it should not require a login.
//
// The simulate route is a POST because it takes a body, not because it
// changes anything. It moves no money and appends no block.

import (
	"errors"
	"net/http"
	"strings"
	"time"
)

func (s *Server) registerRecourseRoutes(mux *http.ServeMux) {
	if s.Recourse == nil {
		return
	}
	mux.HandleFunc("/umi/recourse", s.handleRecourseRoot)
	mux.HandleFunc("/umi/recourse/", s.durabilityGate(s.handleRecourseItem))
}

func recourseStatusFor(err error) (int, string) {
	switch {
	case errors.Is(err, ErrRecourseNotYours):
		return http.StatusForbidden, "ERR_UMI_RECOURSE_NOT_YOURS"
	case errors.Is(err, ErrRecourseNoPosition):
		return http.StatusNotFound, "ERR_UMI_RECOURSE_NO_POSITION"
	case errors.Is(err, ErrRecourseUnknownTrig):
		return http.StatusBadRequest, "ERR_UMI_RECOURSE_TRIGGER"
	case errors.Is(err, ErrRecourseBadRank):
		return http.StatusBadRequest, "ERR_UMI_RECOURSE_RANK"
	default:
		return http.StatusBadRequest, "ERR_UMI_RECOURSE_FIELDS"
	}
}

// recourseMaySetTerms: a registrar or a supervisor. Deliberately not the
// issuer. Terms written by the issuer about the issuer's own failure are a
// marketing document, and the whole value of this layer is that they are not.
func recourseMaySetTerms(c umiCaller) bool {
	return c.supervisor() || strings.EqualFold(c.Role, "Registrar")
}

func (s *Server) handleRecourseRoot(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		umiErr(w, http.StatusMethodNotAllowed, "ERR_METHOD", "Use GET.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"model": "Recourse as data rather than prose. An asset carries an ordered claim priority and a set of " +
			"triggers with an observable test for each. Name an asset, a trigger and a holder, and the rail " +
			"walks the waterfall and returns the number.",
		"theRuleThatKeepsItHonest": "A rank counts as funded only when it names a pot this ledger can see: a " +
			"backing statement that stands, or a reserve wallet with a balance. Every other rank pays zero. " +
			"A simulated waterfall presented as protection would be worse than saying nothing.",
		"whyEveryAnswerIsZeroToday": "No asset on this rail has a funded rank, so every simulation returns a " +
			"recovery of zero. That is the correct answer, not a placeholder. The structure is what a real " +
			"cohort would fill in; the zero is what is true now.",
		"triggers": []string{
			TriggerIssuerDefault + "         the issuer stops meeting an obligation",
			TriggerImpairment + "        the asset is revalued below the tokens outstanding",
			TriggerAttestationWithdrawn + "  the attestation under the asset is withdrawn",
			TriggerCustodianFailure + "     the party holding the deed or the cash leg fails",
		},
		"funding": []string{
			FundingBackingStatement + "  paid from the valuation in the standing backing statement",
			FundingReserveWallet + "     paid from a named wallet on this rail, to the extent of its balance",
			FundingNone + "              described but unfunded; pays zero",
		},
		"routes": []string{
			"GET  /umi/recourse/{assetId}          the terms this asset is sold under",
			"POST /umi/recourse/simulate           {assetId, trigger, holder}",
			"POST /umi/recourse/terms              set the terms (registrar or supervisor)",
			"POST /umi/recourse/{assetId}/declare  {trigger, reason} (supervisor)",
		},
		"declaring": "Declaring a trigger fixes the facts and the moment. It moves no money. Declaring a " +
			"failure and paying for it are different acts, and the rail does only the first.",
		"disclaimer": RecourseDisclaimer,
	})
}

type recourseSimulateRequest struct {
	AssetID string `json:"assetId"`
	Trigger string `json:"trigger"`
	Holder  string `json:"holder"`
}

type recourseDeclareRequest struct {
	Trigger string `json:"trigger"`
	Reason  string `json:"reason"`
}

func (s *Server) handleRecourseItem(w http.ResponseWriter, r *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/umi/recourse/"), "/")

	switch {
	case rest == "simulate":
		if r.Method != http.MethodPost {
			umiErr(w, http.StatusMethodNotAllowed, "ERR_METHOD", "Use POST.")
			return
		}
		var body recourseSimulateRequest
		if err := umiDecode(r, &body); err != nil {
			umiErr(w, http.StatusBadRequest, "ERR_BAD_JSON", err.Error())
			return
		}
		sim, err := s.Recourse.Simulate(body.AssetID, body.Trigger, body.Holder, time.Now().UTC())
		if err != nil {
			code, sentinel := recourseStatusFor(err)
			umiErr(w, code, sentinel, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"simulation": sim})

	case rest == "terms":
		if r.Method != http.MethodPost {
			umiErr(w, http.StatusMethodNotAllowed, "ERR_METHOD", "Use POST.")
			return
		}
		c := callerOf(r)
		if !umiRequireIdentity(w, c) {
			return
		}
		var body RecourseTerms
		if err := umiDecode(r, &body); err != nil {
			umiErr(w, http.StatusBadRequest, "ERR_BAD_JSON", err.Error())
			return
		}
		terms, err := s.Recourse.SetTerms(body, c.ID, recourseMaySetTerms(c))
		if err != nil {
			code, sentinel := recourseStatusFor(err)
			umiErr(w, code, sentinel, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"terms": terms, "disclaimer": RecourseDisclaimer})

	case strings.HasSuffix(rest, "/declare"):
		if r.Method != http.MethodPost {
			umiErr(w, http.StatusMethodNotAllowed, "ERR_METHOD", "Use POST.")
			return
		}
		c := callerOf(r)
		if !umiRequireIdentity(w, c) {
			return
		}
		assetID := strings.TrimSuffix(rest, "/declare")
		var body recourseDeclareRequest
		if err := umiDecode(r, &body); err != nil {
			umiErr(w, http.StatusBadRequest, "ERR_BAD_JSON", err.Error())
			return
		}
		blk, err := s.Recourse.Declare(assetID, body.Trigger, body.Reason, c.ID, c.supervisor())
		if err != nil {
			code, sentinel := recourseStatusFor(err)
			umiErr(w, code, sentinel, err.Error())
			return
		}
		height := int64(0)
		if blk != nil {
			height = blk.Height
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"declared": true,
			"assetId":  assetID,
			"trigger":  strings.ToUpper(strings.TrimSpace(body.Trigger)),
			"block":    height,
			"effect": "The facts and the moment are fixed on the ledger. No money moved, and nothing here " +
				"obliges anyone to pay.",
			"disclaimer": RecourseDisclaimer,
		})

	case rest != "":
		if r.Method != http.MethodGet {
			umiErr(w, http.StatusMethodNotAllowed, "ERR_METHOD", "Use GET.")
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"terms":      s.Recourse.Terms(rest),
			"disclaimer": RecourseDisclaimer,
		})

	default:
		umiErr(w, http.StatusBadRequest, "ERR_UMI_RECOURSE_FIELDS", "Name an asset id.")
	}
}
