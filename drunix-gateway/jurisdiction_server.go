package drunix

// HTTP surface for the per-jurisdiction rule sets (jurisdiction.go).
//
//	GET  /umi/jurisdictions            every declared jurisdiction and its designation
//	GET  /umi/jurisdictions/{code}     one jurisdiction with its rules and charges
//	POST /umi/jurisdictions/evaluate   test a transaction against a rule set
//
// Reads are public and unauthenticated. A rule set that a counterparty cannot
// read before they transact is not a rule set, it is a surprise.

import (
	"errors"
	"net/http"
	"strings"
	"time"
)

func (s *Server) registerJurisdictionRoutes(mux *http.ServeMux) {
	if s.Jurisdictions == nil {
		return
	}
	mux.HandleFunc("/umi/jurisdictions", s.durabilityGate(s.handleJurisdictionCollection))
	mux.HandleFunc("/umi/jurisdictions/", s.durabilityGate(s.handleJurisdictionItem))
}

func jurisdictionStatusFor(err error) (int, string) {
	switch {
	case errors.Is(err, ErrJurisdictionUnknown):
		return http.StatusNotFound, "ERR_UMI_JURISDICTION_UNKNOWN"
	case errors.Is(err, ErrJurisdictionFields):
		return http.StatusBadRequest, "ERR_UMI_JURISDICTION_FIELDS"
	case errors.Is(err, ErrJurisdictionRefused):
		return http.StatusConflict, "ERR_UMI_JURISDICTION_REFUSED"
	default:
		return http.StatusBadRequest, "ERR_UMI_JURISDICTION"
	}
}

func (s *Server) handleJurisdictionCollection(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		umiErr(w, http.StatusMethodNotAllowed, "ERR_METHOD", "GET lists the declared jurisdictions.")
		return
	}
	list := s.Jurisdictions.Jurisdictions()
	designated := 0
	for _, j := range list {
		if j.Designation == JurisdictionDesignated {
			designated++
		}
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"jurisdictions":    list,
		"count":            len(list),
		"designated":       designated,
		"transactionKinds": []string{TxAcquisition, TxLease, TxFunding, TxTransfer},
		"default": "An undeclared jurisdiction refuses. Nothing falls through to permitted because no rule " +
			"was written for it.",
		"disclaimer": "A model of selected rules, not legal advice and not a complete statement of the law. " +
			"Every rule names the instrument it comes from so a reader can check it against the source.",
	})
}

func (s *Server) handleJurisdictionItem(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/umi/jurisdictions/")
	rest = strings.Trim(rest, "/")

	if strings.EqualFold(rest, "evaluate") {
		if r.Method != http.MethodPost {
			umiErr(w, http.StatusMethodNotAllowed, "ERR_METHOD", "POST a transaction to evaluate it.")
			return
		}
		var body Transaction
		if err := umiDecode(r, &body); err != nil {
			umiErr(w, http.StatusBadRequest, "ERR_BAD_JSON", err.Error())
			return
		}
		d, err := s.Jurisdictions.Evaluate(body, time.Now().UTC())
		if err != nil {
			code, sentinel := jurisdictionStatusFor(err)
			umiErr(w, code, sentinel, err.Error())
			return
		}
		// A failed evaluation is a successful request: the caller asked what
		// the rules say and the rules answered. The refusal is in the body.
		writeJSON(w, http.StatusOK, d)
		return
	}

	if r.Method != http.MethodGet {
		umiErr(w, http.StatusMethodNotAllowed, "ERR_METHOD", "GET reads one jurisdiction.")
		return
	}
	j, ok := s.Jurisdictions.Jurisdiction(rest)
	if !ok {
		umiErr(w, http.StatusNotFound, "ERR_UMI_JURISDICTION_UNKNOWN",
			"No rule set is declared for "+strings.ToUpper(rest)+", and an undeclared jurisdiction refuses "+
				"rather than defaulting to permitted.")
		return
	}
	rules, _ := s.Jurisdictions.RulesOf(rest)
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"jurisdiction": j,
		"rules":        rules,
		"ruleCount":    len(rules),
		"disclaimer": "A model of selected rules, not legal advice. Charges are indicative: slabs, city cesses " +
			"and buyer-category rebates move them and are not modelled.",
	})
}
