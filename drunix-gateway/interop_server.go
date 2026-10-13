package drunix

// HTTP surface for the cross-ledger gateway (interop.go).
//
//	GET  /umi/interop                      connectors, stats, the honest caveat
//	GET  /umi/interop/transfers?limit=50   the book
//	POST /umi/interop/lock                 immobilise tokens here
//	GET  /umi/interop/{id}
//	POST /umi/interop/{id}/commit          record the counterpart leg
//	POST /umi/interop/{id}/abort           return the tokens
//
// Locking moves someone's asset, so it is the holder's act or a supervisor's.
// Committing asserts something about another chain, which on an unconfigured
// connector is an attestation that gets recorded under the attester's name,
// so it is supervisor only.

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
)

func (s *Server) registerInteropRoutes(mux *http.ServeMux) {
	if s.UMI == nil || s.UMI.Interop() == nil {
		return
	}
	mux.HandleFunc("/umi/interop", s.handleInteropRoot)
	mux.HandleFunc("/umi/interop/", s.durabilityGate(s.handleInteropPath))
}

func interopStatusFor(err error) (int, string) {
	switch {
	case errors.Is(err, ErrInteropNotFound):
		return http.StatusNotFound, "ERR_UMI_INTEROP_NOT_FOUND"
	case errors.Is(err, ErrInteropNoLedger):
		return http.StatusNotFound, "ERR_UMI_INTEROP_UNKNOWN_LEDGER"
	case errors.Is(err, ErrInteropState):
		return http.StatusConflict, "ERR_UMI_INTEROP_STATE"
	case errors.Is(err, ErrInteropForbidden):
		return http.StatusForbidden, "ERR_UMI_INTEROP_FORBIDDEN"
	case errors.Is(err, ErrInteropFields):
		return http.StatusBadRequest, "ERR_UMI_INTEROP_FIELDS"
	case errors.Is(err, ErrUMIInsufficientSecurities):
		return http.StatusConflict, "ERR_UMI_INSUFFICIENT_SECURITIES"
	default:
		return http.StatusBadRequest, "ERR_UMI_INTEROP_REJECTED"
	}
}

func (s *Server) handleInteropRoot(w http.ResponseWriter, r *http.Request) {
	g := s.UMI.Interop()
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"connectors": g.Connectors(),
		"stats":      g.Stats(),
		"model": "Hyperledger Cacti: one connector per ledger, and a single plugin that sequences a transfer across " +
			"them. The sequence is lock then claim, so a crash cannot leave the asset on both ledgers.",
		"custody": "Locked tokens sit in the " + InteropCustody + " account in the securities ledger, so the amount " +
			"immobilised is a position an auditor can read rather than a status field.",
		"limitation": "The lock, the custody movement, the abort and the state machine run here and are real. The " +
			"counterpart leg is only as real as the connector: an unconfigured connector means a commit is an " +
			"attestation by a supervisor, recorded as such and never counted as verified.",
		"disclaimer": UMIDisclaimer,
	})
}

func (s *Server) handleInteropPath(w http.ResponseWriter, r *http.Request) {
	g := s.UMI.Interop()
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/umi/interop/"), "/")
	parts := strings.Split(rest, "/")
	caller := callerOf(r)

	switch {
	case rest == "transfers" && r.Method == http.MethodGet:
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		list := g.Transfers(limit)
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"transfers": list,
			"count":     len(list),
			"stats":     g.Stats(),
		})

	case rest == "lock" && r.Method == http.MethodPost:
		var body LockRequest
		if err := umiDecode(r, &body); err != nil {
			umiErr(w, http.StatusBadRequest, "ERR_BAD_REQUEST", "Body must be JSON.")
			return
		}
		if !umiRequireSelfOrSupervisor(w, caller, body.Holder, "The position being locked") {
			return
		}
		t, err := g.Lock(body)
		if err != nil {
			code, sentinel := interopStatusFor(err)
			umiErr(w, code, sentinel, err.Error())
			return
		}
		writeJSON(w, http.StatusCreated, map[string]interface{}{
			"transfer": t,
			"note": "Tokens are immobilised in custody on this ledger. They cannot be settled here until this " +
				"transfer is committed or aborted.",
		})

	case len(parts) == 2 && parts[1] == "commit" && r.Method == http.MethodPost:
		if !umiRequireSupervisor(w, caller, "Recording a counterpart leg on another ledger") {
			return
		}
		var body CommitRequest
		if err := umiDecode(r, &body); err != nil {
			umiErr(w, http.StatusBadRequest, "ERR_BAD_REQUEST", "Body must be JSON.")
			return
		}
		t, err := g.Commit(parts[0], body, caller.ID)
		if err != nil {
			code, sentinel := interopStatusFor(err)
			umiErr(w, code, sentinel, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"transfer": t,
			"note":     t.Evidence,
		})

	case len(parts) == 2 && parts[1] == "abort" && r.Method == http.MethodPost:
		if !umiRequireIdentity(w, caller) {
			return
		}
		var body struct {
			Reason string `json:"reason"`
		}
		_ = umiDecode(r, &body)
		t, err := g.Abort(parts[0], caller.ID, caller.supervisor(), body.Reason)
		if err != nil {
			code, sentinel := interopStatusFor(err)
			umiErr(w, code, sentinel, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"transfer": t,
			"note":     "Tokens returned from custody to " + t.Holder + ".",
		})

	case len(parts) == 1 && r.Method == http.MethodGet:
		t, err := g.Transfer(parts[0])
		if err != nil {
			code, sentinel := interopStatusFor(err)
			umiErr(w, code, sentinel, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"transfer": t})

	default:
		umiErr(w, http.StatusMethodNotAllowed, "ERR_METHOD",
			"Supported: GET /umi/interop/transfers, POST /umi/interop/lock, GET /umi/interop/{id}, POST /umi/interop/{id}/commit, POST /umi/interop/{id}/abort.")
	}
}
