package drunix

// HTTP surface for delegated authority (mandates.go).
//
//	GET  /umi/mandates                     the book, filtered by principal or agent
//	POST /umi/mandates                     a principal grants an agent bounded authority
//	GET  /umi/mandates/{id}
//	POST /umi/mandates/{id}/revoke         the principal or a supervisor withdraws it
//	POST /umi/mandates/{id}/check          would this action be allowed? changes nothing
//
// An agent acts by sending X-Agent-Mandate alongside its identity. The
// settlement path checks the mandate before anything moves, and records the
// spend against it afterwards.

import (
	"errors"
	"net/http"
	"strings"
)

// AgentMandateHeader carries the mandate an agent is acting under.
const AgentMandateHeader = "X-Agent-Mandate"

func (s *Server) registerMandateRoutes(mux *http.ServeMux) {
	if s.Mandates == nil {
		return
	}
	mux.HandleFunc("/umi/mandates", s.handleMandatesRoot)
	mux.HandleFunc("/umi/mandates/", s.handleMandatePath)
}

func mandateStatusFor(err error) (int, string) {
	switch {
	case errors.Is(err, ErrMandateNotFound):
		return http.StatusNotFound, "ERR_UMI_MANDATE_NOT_FOUND"
	case errors.Is(err, ErrAgentWithdrawn):
		return http.StatusForbidden, "ERR_UMI_AGENT_WITHDRAWN"
	case errors.Is(err, ErrMandateRevoked):
		return http.StatusForbidden, "ERR_UMI_MANDATE_REVOKED"
	case errors.Is(err, ErrMandateExpired):
		return http.StatusForbidden, "ERR_UMI_MANDATE_EXPIRED"
	case errors.Is(err, ErrMandateExceeded):
		return http.StatusForbidden, "ERR_UMI_MANDATE_LIMIT"
	case errors.Is(err, ErrMandateAssetward):
		return http.StatusForbidden, "ERR_UMI_MANDATE_ASSET"
	case errors.Is(err, ErrMandateAction):
		return http.StatusForbidden, "ERR_UMI_MANDATE_ACTION"
	case errors.Is(err, ErrMandateFields):
		return http.StatusBadRequest, "ERR_UMI_MANDATE_FIELDS"
	default:
		return http.StatusBadRequest, "ERR_UMI_MANDATE_REJECTED"
	}
}

func (s *Server) handleMandatesRoot(w http.ResponseWriter, r *http.Request) {
	reg := s.Mandates
	caller := callerOf(r)

	switch r.Method {
	case http.MethodGet:
		if !umiRequireIdentity(w, caller) {
			return
		}
		principal := r.URL.Query().Get("principal")
		agent := r.URL.Query().Get("agent")
		// A grant says what someone's money may be spent on, so it is not
		// public reading. You see your own grants, as principal or as the
		// agent they name; a supervisor sees the book.
		if !caller.supervisor() {
			if agent != "" && !caller.is(agent) {
				umiErr(w, http.StatusForbidden, "ERR_UMI_NOT_YOURS", "Those mandates are not yours.")
				return
			}
			if agent == "" {
				principal = caller.ID
			}
		}
		limit := queryLimit(r, 50, 200)
		list := reg.List(principal, agent, limit)
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"mandates": list,
			"count":    len(list),
			"registry": reg.Summary(),
			"model": "A principal grants an agent a bounded authority: which actions, up to how much, on which " +
				"assets, until when. The rail enforces every bound on the settlement path and adds up the spend " +
				"itself rather than trusting the agent's own account of it.",
			"disclaimer": MandateDisclaimer,
		})

	case http.MethodPost:
		if !umiRequireIdentity(w, caller) {
			return
		}
		var body GrantRequest
		if err := umiDecode(r, &body); err != nil {
			umiErr(w, http.StatusBadRequest, "ERR_BAD_REQUEST", "Body must be JSON.")
			return
		}
		// The principal is the caller. Taking it from the body would let an
		// agent grant itself authority over somebody else's wallet.
		m, err := reg.Grant(caller.ID, body)
		if err != nil {
			code, sentinel := mandateStatusFor(err)
			umiErr(w, code, sentinel, err.Error())
			return
		}
		writeJSON(w, http.StatusCreated, map[string]interface{}{
			"mandate": m,
			"note": "The agent acts by sending " + AgentMandateHeader + ": " + m.MandateID +
				" with its own identity. Revoke at any time; the next action is refused.",
		})

	default:
		umiErr(w, http.StatusMethodNotAllowed, "ERR_METHOD", "Use GET or POST.")
	}
}

func (s *Server) handleMandatePath(w http.ResponseWriter, r *http.Request) {
	reg := s.Mandates
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/umi/mandates/"), "/")
	parts := strings.Split(rest, "/")
	caller := callerOf(r)

	m, err := reg.Get(parts[0])
	if err != nil {
		code, sentinel := mandateStatusFor(err)
		umiErr(w, code, sentinel, err.Error())
		return
	}
	involved := caller.supervisor() || caller.is(m.Principal) || caller.is(m.Agent)

	switch {
	case len(parts) == 1 && r.Method == http.MethodGet:
		if !umiRequireIdentity(w, caller) {
			return
		}
		if !involved {
			umiErr(w, http.StatusForbidden, "ERR_UMI_NOT_YOURS", "That mandate is not yours.")
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"mandate": m})

	case len(parts) == 2 && parts[1] == "revoke" && r.Method == http.MethodPost:
		if !umiRequireIdentity(w, caller) {
			return
		}
		// The agent cannot revoke its own mandate: that is the principal's
		// right, and an agent cancelling its audit trail is not a feature.
		if !caller.supervisor() && !caller.is(m.Principal) {
			umiErr(w, http.StatusForbidden, "ERR_UMI_MANDATE_FORBIDDEN",
				"A mandate is withdrawn by the principal who granted it, or by a supervisor.")
			return
		}
		m, err = reg.Revoke(parts[0], caller.ID)
		if err != nil {
			code, sentinel := mandateStatusFor(err)
			umiErr(w, code, sentinel, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"mandate": m,
			"note":    "Authority withdrawn. The next action under this mandate is refused.",
		})

	case len(parts) == 2 && parts[1] == "check" && r.Method == http.MethodPost:
		var body struct {
			Action   string  `json:"action"`
			AssetID  string  `json:"assetId"`
			AmontINR float64 `json:"amountINR"`
		}
		if err := umiDecode(r, &body); err != nil {
			umiErr(w, http.StatusBadRequest, "ERR_BAD_REQUEST", "Body must be JSON.")
			return
		}
		if !umiRequireIdentity(w, caller) {
			return
		}
		if !involved {
			umiErr(w, http.StatusForbidden, "ERR_UMI_NOT_YOURS", "That mandate is not yours.")
			return
		}
		_, aerr := reg.Authorise(parts[0], m.Agent, body.Action, body.AssetID, INRToPaise(body.AmontINR))
		if aerr != nil {
			_, sentinel := mandateStatusFor(aerr)
			writeJSON(w, http.StatusOK, map[string]interface{}{
				"allowed": false, "reason": sentinel, "message": aerr.Error(),
				"remainingPaise": m.RemainingPaise(),
			})
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"allowed": true, "remainingPaise": m.RemainingPaise(),
			"note": "Nothing was consumed. A check is a question, not a reservation.",
		})

	default:
		umiErr(w, http.StatusNotFound, "ERR_NOT_FOUND", "No such mandate route.")
	}
}

// agentMandateFor returns the mandate an agent is acting under, if the
// request carries one, having checked it against the proposed action.
//
// No header means an ordinary human caller and the normal rules apply. A
// header means the caller is claiming delegated authority, and from that
// point the claim has to hold up or the request is refused: a bad mandate
// never silently falls back to acting as the caller.
func (s *Server) agentMandateFor(w http.ResponseWriter, r *http.Request, action, assetID string, amountPaise int64) (*Mandate, bool) {
	id := strings.TrimSpace(r.Header.Get(AgentMandateHeader))
	if id == "" || s.Mandates == nil {
		return nil, true
	}
	caller := callerOf(r)
	if !umiRequireIdentity(w, caller) {
		return nil, false
	}
	m, err := s.Mandates.Authorise(id, caller.ID, action, assetID, amountPaise)
	if err != nil {
		code, sentinel := mandateStatusFor(err)
		umiErr(w, code, sentinel, err.Error())
		return nil, false
	}
	return m, true
}
