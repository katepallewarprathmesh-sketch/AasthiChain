package drunix

// HTTP surface for agent passports (agentid.go).
//
//	GET  /umi/agents                       every passport, pending openings first
//	POST /umi/agents                       register an agent (the caller is the principal)
//	GET  /umi/agents/{id}                  one passport
//	POST /umi/agents/{id}/revoke           stop it acting (principal or supervisor)
//	POST /umi/agents/{id}/reveal           open an identification request with a trigger
//	POST /umi/agents/{id}/reveal/approve   one custodian contributes one share
//
// Reads are public. The point of the layer is that a counterparty can see the
// pseudonym, the purpose, the custodian set and the threshold without learning
// who is behind it, so hiding the register would defeat it.

import (
	"errors"
	"net/http"
	"strings"
	"time"
)

func (s *Server) registerAgentRoutes(mux *http.ServeMux) {
	if s.Agents == nil {
		return
	}
	mux.HandleFunc("/umi/agents", s.durabilityGate(s.handleAgentCollection))
	mux.HandleFunc("/umi/agents/", s.durabilityGate(s.handleAgentItem))
}

func agentStatusFor(err error) (int, string) {
	switch {
	case errors.Is(err, ErrAgentNotFound):
		return http.StatusNotFound, "ERR_UMI_AGENT_NOT_FOUND"
	case errors.Is(err, ErrAgentNotPrincipal):
		return http.StatusForbidden, "ERR_UMI_AGENT_NOT_PRINCIPAL"
	case errors.Is(err, ErrAgentNotCustodian):
		return http.StatusForbidden, "ERR_UMI_AGENT_NOT_CUSTODIAN"
	case errors.Is(err, ErrAgentNoRequest):
		return http.StatusConflict, "ERR_UMI_AGENT_NO_REVEAL_REQUEST"
	case errors.Is(err, ErrAgentDuplicate):
		return http.StatusConflict, "ERR_UMI_AGENT_ALREADY_APPROVED"
	case errors.Is(err, ErrAgentRevealed):
		return http.StatusConflict, "ERR_UMI_AGENT_ALREADY_REVEALED"
	default:
		return http.StatusBadRequest, "ERR_UMI_AGENT_FIELDS"
	}
}

func (s *Server) handleAgentCollection(w http.ResponseWriter, r *http.Request) {
	now := time.Now().UTC()
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"agents":     s.Agents.List(now),
			"disclaimer": AgentDisclaimer,
		})

	case http.MethodPost:
		c := callerOf(r)
		if !umiRequireIdentity(w, c) {
			return
		}
		var body AgentRegistration
		if err := umiDecode(r, &body); err != nil {
			umiErr(w, http.StatusBadRequest, "ERR_BAD_JSON", err.Error())
			return
		}
		p, err := s.Agents.Register(c.ID, body)
		if err != nil {
			code, sentinel := agentStatusFor(err)
			umiErr(w, code, sentinel, err.Error())
			return
		}
		view, _ := s.Agents.Get(p.AgentID, now)
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"agent":      view,
			"disclaimer": AgentDisclaimer,
			"effect": "Your identity is sealed behind this pseudonym. Recovering it takes " +
				"the stated threshold of custodians, and every step of that is written to the chain.",
		})

	default:
		umiErr(w, http.StatusMethodNotAllowed, "ERR_METHOD", "GET or POST.")
	}
}

func (s *Server) handleAgentItem(w http.ResponseWriter, r *http.Request) {
	now := time.Now().UTC()
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/umi/agents/"), "/")
	if rest == "" {
		umiErr(w, http.StatusBadRequest, "ERR_UMI_AGENT_FIELDS", "Name an agent.")
		return
	}
	parts := strings.Split(rest, "/")
	agentID := parts[0]

	if len(parts) == 1 {
		if r.Method != http.MethodGet {
			umiErr(w, http.StatusMethodNotAllowed, "ERR_METHOD", "Use GET.")
			return
		}
		view, err := s.Agents.Get(agentID, now)
		if err != nil {
			code, sentinel := agentStatusFor(err)
			umiErr(w, code, sentinel, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"agent":      view,
			"disclaimer": AgentDisclaimer,
		})
		return
	}

	if !requirePost(w, r) {
		return
	}
	c := callerOf(r)
	if !umiRequireIdentity(w, c) {
		return
	}
	var body struct {
		Reason string `json:"reason"`
	}
	if err := umiDecode(r, &body); err != nil {
		umiErr(w, http.StatusBadRequest, "ERR_BAD_JSON", err.Error())
		return
	}

	action := strings.ToLower(parts[1])
	sub := ""
	if len(parts) > 2 {
		sub = strings.ToLower(parts[2])
	}

	switch {
	case action == "revoke":
		if _, err := s.Agents.Revoke(agentID, c.ID, c.supervisor()); err != nil {
			code, sentinel := agentStatusFor(err)
			umiErr(w, code, sentinel, err.Error())
			return
		}
		view, _ := s.Agents.Get(agentID, now)
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"agent":  view,
			"effect": "The agent may no longer act. Accountability for what it already did is unchanged.",
		})

	case action == "reveal" && sub == "":
		if _, err := s.Agents.RequestReveal(agentID, body.Reason, c.ID, c.supervisor()); err != nil {
			code, sentinel := agentStatusFor(err)
			umiErr(w, code, sentinel, err.Error())
			return
		}
		view, _ := s.Agents.Get(agentID, now)
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"agent": view,
			"effect": "The request is open and on the chain. It identifies nobody until the threshold " +
				"of custodians has approved it, and it lapses if they do not.",
		})

	case action == "reveal" && (sub == "approve" || sub == "approval"):
		p, err := s.Agents.ApproveReveal(agentID, c.ID)
		if err != nil {
			code, sentinel := agentStatusFor(err)
			umiErr(w, code, sentinel, err.Error())
			return
		}
		view, _ := s.Agents.Get(agentID, now)
		out := map[string]interface{}{"agent": view}
		if p.Revealed {
			out["principal"] = p.Principal
			out["effect"] = "The threshold was met. The principal is named here and in the block, " +
				"so the person identified can see that it happened and on whose approval."
		} else {
			out["effect"] = "Approval recorded. Nothing is identified until the threshold is reached."
		}
		writeJSON(w, http.StatusOK, out)

	default:
		umiErr(w, http.StatusNotFound, "ERR_UMI_AGENT_NO_ACTION", "No action "+action+" on an agent passport.")
	}
}
