package drunix

// HTTP surface for the proposing agent (agent.go).
//
//	GET  /umi/proposals[?status=]     what it may propose, what it may not do, and the queue
//	POST /umi/proposals/scan          read live state and draft what it finds
//	GET  /umi/proposals/{id}          one proposal with the evidence behind it
//	POST /umi/proposals/{id}/approve  a named person accepts it; the evidence is re-read first
//	POST /umi/proposals/{id}/reject   a named person declines it, with a reason
//
// Reads are public, deliberately: a queue of drafted actions that only its
// own operator can see is a queue nobody can hold to account. Scanning and
// deciding are supervisor-only, and the approver's identity comes from the
// signed caller, never from the request body, because an approval that can
// name somebody else is not an approval.

import (
	"errors"
	"net/http"
	"strings"
	"time"
)

func (s *Server) registerProposalRoutes(mux *http.ServeMux) {
	if s.Agent == nil {
		return
	}
	mux.HandleFunc("/umi/proposals", s.durabilityGate(s.handleAgentRoot))
	mux.HandleFunc("/umi/proposals/", s.durabilityGate(s.handleAgentPath))
}

func proposalStatusFor(err error) (int, string) {
	switch {
	case errors.Is(err, ErrProposalNotFound):
		return http.StatusNotFound, "ERR_UMI_AGENT_NOT_FOUND"
	case errors.Is(err, ErrProposalState):
		return http.StatusConflict, "ERR_UMI_AGENT_STATE"
	case errors.Is(err, ErrProposalStale):
		return http.StatusConflict, "ERR_UMI_AGENT_STALE"
	default:
		return http.StatusBadRequest, "ERR_UMI_AGENT_FIELDS"
	}
}

func (s *Server) agentFail(w http.ResponseWriter, err error) {
	code, reason := proposalStatusFor(err)
	umiErr(w, code, reason, err.Error())
}

func (s *Server) handleAgentRoot(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		umiErr(w, http.StatusMethodNotAllowed, "ERR_UMI_METHOD", "GET only.")
		return
	}
	body := s.Agent.Status()
	body["proposalQueue"] = s.Agent.Proposals(strings.TrimSpace(r.URL.Query().Get("status")), queryLimit(r, 50, 200))
	writeJSON(w, http.StatusOK, body)
}

func (s *Server) handleAgentPath(w http.ResponseWriter, r *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/umi/proposals/"), "/")
	parts := strings.Split(rest, "/")

	switch {
	case parts[0] == "scan":
		s.agentScan(w, r)
	case len(parts) == 1 && parts[0] != "":
		s.agentOne(w, r, parts[0])
	case len(parts) == 2:
		s.agentDecide(w, r, parts[0], parts[1])
	default:
		umiErr(w, http.StatusNotFound, "ERR_UMI_AGENT_NOT_FOUND", "No such proposal route.")
	}
}

func (s *Server) agentScan(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		umiErr(w, http.StatusMethodNotAllowed, "ERR_UMI_METHOD", "POST only.")
		return
	}
	c := callerOf(r)
	if !umiRequireIdentity(w, c) || !umiRequireSupervisor(w, c, "run the agent over live state") {
		return
	}
	drafted := s.Agent.Scan(time.Now())
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"drafted":    drafted,
		"count":      len(drafted),
		"note":       "Nothing has been performed. Each of these waits for a named person to approve or reject it.",
		"disclaimer": agentDisclaimer,
	})
}

func (s *Server) agentOne(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodGet {
		umiErr(w, http.StatusMethodNotAllowed, "ERR_UMI_METHOD", "GET only.")
		return
	}
	p, err := s.Agent.Proposal(id)
	if err != nil {
		s.agentFail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"proposal": p, "disclaimer": agentDisclaimer})
}

func (s *Server) agentDecide(w http.ResponseWriter, r *http.Request, id, action string) {
	if r.Method != http.MethodPost {
		umiErr(w, http.StatusMethodNotAllowed, "ERR_UMI_METHOD", "POST only.")
		return
	}
	c := callerOf(r)
	if !umiRequireIdentity(w, c) || !umiRequireSupervisor(w, c, "decide an agent proposal") {
		return
	}
	var body struct {
		Note   string `json:"note"`
		Reason string `json:"reason"`
	}
	if err := umiDecode(r, &body); err != nil {
		umiErr(w, http.StatusBadRequest, "ERR_UMI_AGENT_FIELDS", err.Error())
		return
	}

	switch action {
	case "approve":
		// The approver is the signed caller. A body that could name somebody
		// else would make the audit trail worthless.
		p, err := s.Agent.Approve(id, c.ID, body.Note)
		if err != nil {
			if errors.Is(err, ErrProposalStale) && p != nil {
				umiErr(w, http.StatusConflict, "ERR_UMI_AGENT_STALE", err.Error())
				return
			}
			s.agentFail(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"proposal":   p,
			"note":       "Performed as an act by " + c.ID + ". The block records the approver, not the agent.",
			"disclaimer": agentDisclaimer,
		})
	case "reject":
		p, err := s.Agent.Reject(id, c.ID, firstNonEmpty(body.Reason, body.Note))
		if err != nil {
			s.agentFail(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"proposal": p, "disclaimer": agentDisclaimer})
	default:
		umiErr(w, http.StatusNotFound, "ERR_UMI_AGENT_NOT_FOUND", "Use /approve or /reject.")
	}
}
