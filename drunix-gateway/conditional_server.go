package drunix

// HTTP surface for conditional settlement (conditional.go).
//
//	GET  /umi/conditions                  the book, with the summary
//	POST /umi/conditions                  the buyer locks cash against a named condition
//	GET  /umi/conditions/{id}
//	POST /umi/conditions/{id}/present     present a credential and release both legs
//	POST /umi/conditions/{id}/cancel      either party ends it before the condition is met
//	POST /umi/conditions/sweep            refund everything past its deadline
//
// An agent presents on somebody's behalf by sending X-Agent-Mandate with its
// own identity, exactly as on the rest of the rail.

import (
	"errors"
	"net/http"
	"strings"
	"time"
)

func (s *Server) registerConditionRoutes(mux *http.ServeMux) {
	if s.Conditions == nil {
		return
	}
	mux.HandleFunc("/umi/conditions", s.handleConditionsRoot)
	mux.HandleFunc("/umi/conditions/", s.handleConditionPath)
}

func conditionStatusFor(err error) (int, string) {
	switch {
	case errors.Is(err, ErrConditionNotFound):
		return http.StatusNotFound, "ERR_UMI_CONDITION_NOT_FOUND"
	case errors.Is(err, ErrConditionClosed):
		return http.StatusConflict, "ERR_UMI_CONDITION_CLOSED"
	case errors.Is(err, ErrConditionExpired):
		return http.StatusConflict, "ERR_UMI_CONDITION_EXPIRED"
	case errors.Is(err, ErrConditionCredential):
		return http.StatusForbidden, "ERR_UMI_CONDITION_CREDENTIAL"
	case errors.Is(err, ErrConditionNotAsserter):
		return http.StatusForbidden, "ERR_UMI_CONDITION_NOT_ASSERTER"
	case errors.Is(err, ErrUMIInsufficientCBDC):
		return http.StatusConflict, "ERR_UMI_INSUFFICIENT_CBDC"
	case errors.Is(err, ErrUMIInsufficientSecurities):
		return http.StatusConflict, "ERR_UMI_INSUFFICIENT_SECURITIES"
	case errors.Is(err, ErrConditionFields):
		return http.StatusBadRequest, "ERR_UMI_CONDITION_FIELDS"
	default:
		return http.StatusBadRequest, "ERR_UMI_CONDITION_REJECTED"
	}
}

func (s *Server) handleConditionsRoot(w http.ResponseWriter, r *http.Request) {
	desk := s.Conditions
	caller := callerOf(r)

	switch r.Method {
	case http.MethodGet:
		if !umiRequireIdentity(w, caller) {
			return
		}
		// A condition names two parties and an amount of somebody's money,
		// so it is not public reading. You see the ones you are in; a
		// supervisor sees the book.
		participant := r.URL.Query().Get("participant")
		if !caller.supervisor() {
			participant = caller.ID
		}
		list := desk.List(participant, queryLimit(r, 50, 200))
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"conditions": list,
			"count":      len(list),
			"summary":    desk.Summary(),
			"model": "Cash is reserved on the buyer's own wallet at the point of agreement and moves only when a " +
				"named credential is presented and verified. The presenter can be an agent, if it holds a mandate " +
				"from the party entitled to assert it. Both legs then move in one step, as in an unconditional DvP.",
		})

	case http.MethodPost:
		if !umiRequireIdentity(w, caller) {
			return
		}
		var body ConditionRequest
		if err := umiDecode(r, &body); err != nil {
			umiErr(w, http.StatusBadRequest, "ERR_BAD_REQUEST", "Body must be JSON.")
			return
		}
		c, err := desk.Open(body, caller.ID, caller.supervisor())
		if err != nil {
			code, sentinel := conditionStatusFor(err)
			umiErr(w, code, sentinel, err.Error())
			return
		}
		writeJSON(w, http.StatusCreated, map[string]interface{}{
			"condition": c,
			"next": "Present the credential at POST /umi/conditions/" + c.ConditionID +
				"/present. Nothing has settled: the cash is reserved on " + c.Buyer + "'s wallet and the deadline is " + c.DeadlineAt + ".",
		})

	default:
		umiErr(w, http.StatusMethodNotAllowed, "ERR_UMI_METHOD", "GET or POST.")
	}
}

func (s *Server) handleConditionPath(w http.ResponseWriter, r *http.Request) {
	desk := s.Conditions
	caller := callerOf(r)
	rest := strings.TrimPrefix(r.URL.Path, "/umi/conditions/")

	// The sweep is deliberately not behind an identity: a deadline that only
	// runs when an interested party asks is not a deadline. It is also
	// harmless, because the only thing it can do is give money back.
	if rest == "sweep" {
		if r.Method != http.MethodPost && r.Method != http.MethodGet {
			umiErr(w, http.StatusMethodNotAllowed, "ERR_UMI_METHOD", "GET or POST.")
			return
		}
		closed := desk.Tick(time.Now().UTC())
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"refunded": closed,
			"count":    len(closed),
			"summary":  desk.Summary(),
			"note": "Every condition past its deadline has had its reservation lifted. This runs at boot and " +
				"on every call here, and it is open to anyone because the only thing it can do is return money.",
		})
		return
	}

	parts := strings.Split(strings.Trim(rest, "/"), "/")
	id := parts[0]
	if id == "" {
		umiErr(w, http.StatusNotFound, "ERR_UMI_CONDITION_NOT_FOUND", "No condition id in the path.")
		return
	}
	action := ""
	if len(parts) > 1 {
		action = parts[1]
	}

	if !umiRequireIdentity(w, caller) {
		return
	}

	switch action {
	case "":
		if r.Method != http.MethodGet {
			umiErr(w, http.StatusMethodNotAllowed, "ERR_UMI_METHOD", "GET only.")
			return
		}
		c, err := desk.Get(id)
		if err != nil {
			code, sentinel := conditionStatusFor(err)
			umiErr(w, code, sentinel, err.Error())
			return
		}
		if !caller.supervisor() && !caller.is(c.Buyer) && !caller.is(c.Seller) && !caller.is(c.Asserter) {
			umiErr(w, http.StatusForbidden, "ERR_UMI_NOT_YOURS", "That settlement is not yours.")
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"condition": c})

	case "present":
		if r.Method != http.MethodPost {
			umiErr(w, http.StatusMethodNotAllowed, "ERR_UMI_METHOD", "POST only.")
			return
		}
		var body PresentRequest
		if err := umiDecode(r, &body); err != nil {
			umiErr(w, http.StatusBadRequest, "ERR_BAD_REQUEST", "Body must be JSON.")
			return
		}
		if body.MandateID == "" {
			body.MandateID = r.Header.Get(AgentMandateHeader)
		}
		c, err := desk.Present(id, body, caller.ID, caller.supervisor())
		if err != nil {
			code, sentinel := conditionStatusFor(err)
			payload := map[string]interface{}{
				"error":   sentinel,
				"message": err.Error(),
				"mode":    UMIMode,
			}
			if c != nil {
				payload["condition"] = c
				payload["note"] = "The agreement is still open. Present a credential that satisfies it, or cancel."
			}
			writeJSON(w, code, payload)
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"condition": c,
			"settled":   c.SettlementNote,
			"note": "The credential was verified against its anchor before anything moved, and both legs moved " +
				"in the same locked section.",
		})

	case "cancel":
		if r.Method != http.MethodPost {
			umiErr(w, http.StatusMethodNotAllowed, "ERR_UMI_METHOD", "POST only.")
			return
		}
		c, err := desk.Cancel(id, caller.ID, caller.supervisor())
		if err != nil {
			code, sentinel := conditionStatusFor(err)
			umiErr(w, code, sentinel, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"condition": c,
			"note":      "The reservation is lifted and neither leg moved.",
		})

	default:
		umiErr(w, http.StatusNotFound, "ERR_UMI_NOT_FOUND", "No such action on a condition.")
	}
}
