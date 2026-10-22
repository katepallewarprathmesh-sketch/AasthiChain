package drunix

// HTTP surface for cross-border corridors (corridors.go).
//
//	GET  /umi/corridors                     every corridor, with what it needs
//	GET  /umi/corridors/transfers           recent transfers
//	GET  /umi/corridors/transfers/{id}      one transfer
//	POST /umi/corridors/check               run the gate without moving money
//	POST /umi/corridors/send                put a payment on a corridor
//	POST /umi/corridors/transfers/{id}/claim    reveal the secret (cross-ledger)
//	POST /umi/corridors/transfers/{id}/confirm  the far institution reports its leg
//
// Reads are public: which corridors exist, what each one requires and where
// a payment currently sits are exactly the facts a sender is usually denied.

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
)

func (s *Server) registerCorridorRoutes(mux *http.ServeMux) {
	if s.Corridors == nil {
		return
	}
	mux.HandleFunc("/umi/corridors", s.durabilityGate(s.handleCorridorRoot))
	mux.HandleFunc("/umi/corridors/", s.durabilityGate(s.handleCorridorPath))
}

func corridorStatusFor(err error) (int, string) {
	switch {
	case errors.Is(err, ErrCorridorUnknown), errors.Is(err, ErrCorridorNotFound):
		return http.StatusNotFound, "ERR_UMI_CORRIDOR_NOT_FOUND"
	case errors.Is(err, ErrCorridorLicence):
		return http.StatusForbidden, "ERR_UMI_CORRIDOR_LICENCE"
	case errors.Is(err, ErrCorridorCap):
		return http.StatusConflict, "ERR_UMI_CORRIDOR_CAP"
	case errors.Is(err, ErrCorridorPurpose):
		return http.StatusConflict, "ERR_UMI_CORRIDOR_PURPOSE"
	case errors.Is(err, ErrCorridorTravel):
		return http.StatusConflict, "ERR_UMI_CORRIDOR_TRAVEL_RULE"
	case errors.Is(err, ErrCorridorState):
		return http.StatusConflict, "ERR_UMI_CORRIDOR_STATE"
	case errors.Is(err, ErrCorridorSecret):
		return http.StatusForbidden, "ERR_UMI_CORRIDOR_SECRET"
	case errors.Is(err, ErrAMLBlocked):
		// Screening refused it, not the corridor. The caller is told which,
		// because the two have entirely different remedies.
		return http.StatusForbidden, "ERR_UMI_AML_BLOCKED"
	default:
		code, reason := cbdcStatusFor(err)
		if reason != "ERR_UMI_CBDC_FIELDS" {
			return code, reason
		}
		return http.StatusBadRequest, "ERR_UMI_CORRIDOR_FIELDS"
	}
}

func (s *Server) corridorFail(w http.ResponseWriter, err error) {
	code, reason := corridorStatusFor(err)
	umiErr(w, code, reason, err.Error())
}

func (s *Server) handleCorridorRoot(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		umiErr(w, http.StatusMethodNotAllowed, "ERR_UMI_METHOD", "GET only.")
		return
	}
	s.Corridors.Sweep(time.Now().UTC())
	writeJSON(w, http.StatusOK, s.Corridors.Status())
}

func (s *Server) handleCorridorPath(w http.ResponseWriter, r *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/umi/corridors/"), "/")
	parts := strings.Split(rest, "/")
	switch {
	case parts[0] == "check":
		s.corridorCheck(w, r)
	case parts[0] == "send":
		s.corridorSend(w, r)
	case parts[0] == "transfers":
		s.corridorTransfers(w, r, parts)
	default:
		umiErr(w, http.StatusNotFound, "ERR_UMI_CORRIDOR_NOT_FOUND", "No such corridor route.")
	}
}

func (s *Server) corridorCheck(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		umiErr(w, http.StatusMethodNotAllowed, "ERR_UMI_METHOD", "POST only.")
		return
	}
	var body SendRequest
	if err := umiDecode(r, &body); err != nil {
		umiErr(w, http.StatusBadRequest, "ERR_UMI_CORRIDOR_FIELDS", err.Error())
		return
	}
	chk, err := s.Corridors.Check(body.CorridorID, body.AmountPaise, body.PurposeCode, body.Payer, time.Now().UTC())
	if err != nil {
		s.corridorFail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"check": chk, "disclaimer": CorridorDisclaimer})
}

func (s *Server) corridorSend(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		umiErr(w, http.StatusMethodNotAllowed, "ERR_UMI_METHOD", "POST only.")
		return
	}
	c := callerOf(r)
	if !umiRequireIdentity(w, c) {
		return
	}
	var body SendRequest
	if err := umiDecode(r, &body); err != nil {
		umiErr(w, http.StatusBadRequest, "ERR_UMI_CORRIDOR_FIELDS", err.Error())
		return
	}
	if body.Payer == "" {
		body.Payer = c.ID
	}
	if !umiRequireSelfOrSupervisor(w, c, body.Payer, "send money across a border") {
		return
	}
	t, err := s.Corridors.Send(body, time.Now().UTC())
	if err != nil {
		s.corridorFail(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]interface{}{"transfer": t, "disclaimer": CorridorDisclaimer})
}

func (s *Server) corridorTransfers(w http.ResponseWriter, r *http.Request, parts []string) {
	// /umi/corridors/transfers/{id}/{action}
	if len(parts) >= 3 {
		if r.Method != http.MethodPost {
			umiErr(w, http.StatusMethodNotAllowed, "ERR_UMI_METHOD", "POST only.")
			return
		}
		c := callerOf(r)
		if !umiRequireIdentity(w, c) {
			return
		}
		switch parts[2] {
		case "claim":
			var body struct {
				Secret string `json:"secret"`
			}
			if err := umiDecode(r, &body); err != nil {
				umiErr(w, http.StatusBadRequest, "ERR_UMI_CORRIDOR_FIELDS", err.Error())
				return
			}
			t, err := s.Corridors.Claim(parts[1], body.Secret, time.Now().UTC())
			if err != nil {
				s.corridorFail(w, err)
				return
			}
			writeJSON(w, http.StatusOK, map[string]interface{}{"transfer": t, "disclaimer": CorridorDisclaimer})
		case "confirm":
			t, err := s.Corridors.ConfirmLeg(parts[1], c.ID, time.Now().UTC())
			if err != nil {
				s.corridorFail(w, err)
				return
			}
			writeJSON(w, http.StatusOK, map[string]interface{}{"transfer": t, "disclaimer": CorridorDisclaimer})
		default:
			umiErr(w, http.StatusNotFound, "ERR_UMI_CORRIDOR_NOT_FOUND", "Use /claim or /confirm.")
		}
		return
	}

	if r.Method != http.MethodGet {
		umiErr(w, http.StatusMethodNotAllowed, "ERR_UMI_METHOD", "GET only.")
		return
	}
	if len(parts) == 2 && parts[1] != "" {
		t, ok := s.Corridors.Transfer(parts[1])
		if !ok {
			umiErr(w, http.StatusNotFound, "ERR_UMI_CORRIDOR_NOT_FOUND", "No transfer "+parts[1]+".")
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"transfer": t, "disclaimer": CorridorDisclaimer})
		return
	}
	limit := 25
	if v := strings.TrimSpace(r.URL.Query().Get("limit")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 200 {
			limit = n
		}
	}
	s.Corridors.Sweep(time.Now().UTC())
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"transfers": s.Corridors.Transfers(limit), "disclaimer": CorridorDisclaimer,
	})
}
