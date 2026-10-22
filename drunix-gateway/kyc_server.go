package drunix

// HTTP surface for electronic KYC (kyc.go).
//
//	GET  /umi/kyc                  the routes, what each permits, and the Aadhaar policy
//	GET  /umi/kyc/records          recent verifications (supervisor)
//	GET  /umi/kyc/holders/{holder} the current record for one holder
//	POST /umi/kyc/verify           run a verification
//
// The route catalogue is public: somebody deciding how to get verified is
// entitled to know which route caps them and which does not. A record is the
// holder's own or a supervisor's to read.

import (
	"errors"
	"net/http"
	"strings"
	"time"
)

func (s *Server) registerKYCRoutes(mux *http.ServeMux) {
	if s.KYC == nil {
		return
	}
	mux.HandleFunc("/umi/kyc", s.durabilityGate(s.handleKYCRoot))
	mux.HandleFunc("/umi/kyc/", s.durabilityGate(s.handleKYCPath))
}

func kycStatusFor(err error) (int, string) {
	switch {
	case errors.Is(err, ErrKYCNotFound):
		return http.StatusNotFound, "ERR_UMI_KYC_NOT_FOUND"
	case errors.Is(err, ErrKYCAadhaar):
		return http.StatusUnprocessableEntity, "ERR_UMI_KYC_AADHAAR_NOT_ACCEPTED"
	case errors.Is(err, ErrKYCNoConsent):
		return http.StatusForbidden, "ERR_UMI_KYC_NO_CONSENT"
	case errors.Is(err, ErrKYCStale):
		return http.StatusConflict, "ERR_UMI_KYC_STALE_EVIDENCE"
	case errors.Is(err, ErrKYCRoute):
		return http.StatusConflict, "ERR_UMI_KYC_ROUTE"
	default:
		return http.StatusBadRequest, "ERR_UMI_KYC_FIELDS"
	}
}

func (s *Server) kycFail(w http.ResponseWriter, err error) {
	code, reason := kycStatusFor(err)
	umiErr(w, code, reason, err.Error())
}

func (s *Server) handleKYCRoot(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		umiErr(w, http.StatusMethodNotAllowed, "ERR_UMI_METHOD", "GET only.")
		return
	}
	writeJSON(w, http.StatusOK, s.KYC.Status())
}

func (s *Server) handleKYCPath(w http.ResponseWriter, r *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/umi/kyc/"), "/")
	parts := strings.Split(rest, "/")

	switch {
	case parts[0] == "verify":
		s.kycVerify(w, r)
	case parts[0] == "records":
		c := callerOf(r)
		if !umiRequireIdentity(w, c) || !umiRequireSupervisor(w, c, "read the verification log") {
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"records":    s.KYC.Records(queryLimit(r, 50, 200)),
			"disclaimer": kycDisclaimer,
		})
	case parts[0] == "holders" && len(parts) > 1:
		s.kycHolder(w, r, parts[1])
	default:
		umiErr(w, http.StatusNotFound, "ERR_UMI_KYC_NOT_FOUND", "No such KYC route.")
	}
}

func (s *Server) kycVerify(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		umiErr(w, http.StatusMethodNotAllowed, "ERR_UMI_METHOD", "POST only.")
		return
	}
	c := callerOf(r)
	if !umiRequireIdentity(w, c) {
		return
	}
	var req KYCRequest
	if err := umiDecode(r, &req); err != nil {
		umiErr(w, http.StatusBadRequest, "ERR_UMI_KYC_FIELDS", err.Error())
		return
	}
	if strings.TrimSpace(req.Holder) == "" {
		req.Holder = c.ID
	}
	// Verifying somebody else is an institution's act, not a peer's.
	if !umiRequireSelfOrSupervisor(w, c, req.Holder, "this verification") {
		return
	}

	rec, err := s.KYC.Verify(req, c.ID, time.Now())
	if err != nil {
		s.kycFail(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]interface{}{
		"record": rec,
		"note": "The wallet tier now follows from this verification rather than from whatever the request " +
			"that opened the wallet claimed.",
		"disclaimer": kycDisclaimer,
	})
}

func (s *Server) kycHolder(w http.ResponseWriter, r *http.Request, holder string) {
	if r.Method != http.MethodGet {
		umiErr(w, http.StatusMethodNotAllowed, "ERR_UMI_METHOD", "GET only.")
		return
	}
	c := callerOf(r)
	if !umiRequireSelfOrSupervisor(w, c, holder, "this verification record") {
		return
	}
	rec, expired, err := s.KYC.Record(holder, time.Now())
	if err != nil {
		s.kycFail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"record":     rec,
		"expired":    expired,
		"disclaimer": kycDisclaimer,
	})
}
