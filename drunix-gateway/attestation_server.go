package drunix

// HTTP surface for attestation accountability (attestation.go).
//
//	GET /umi/attestations                       what the layer is and how to read it
//	GET /umi/attestations/{credentialId}        what rests on one attestation
//	GET /umi/attestors/{id}                     one attestor's record
//
// All reads are public, like credential reads. A holder who has to ask our
// permission before learning who vouched for their asset is not being told
// anything useful.

import (
	"net/http"
	"strings"
)

func (s *Server) registerAttestationRoutes(mux *http.ServeMux) {
	if s.Attestations == nil {
		return
	}
	mux.HandleFunc("/umi/attestations", s.handleAttestationsRoot)
	mux.HandleFunc("/umi/attestations/", s.handleAttestationImpact)
	mux.HandleFunc("/umi/attestors/", s.handleAttestor)
}

func (s *Server) handleAttestationsRoot(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		umiErr(w, http.StatusMethodNotAllowed, "ERR_METHOD", "Use GET.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"chain": []string{"real asset", "attestation", "credential", "token"},
		"model": "A token is only as good as the attestation under it. This layer answers three questions a " +
			"holder cannot otherwise answer: who vouched for this asset, what were they vouching for, and if " +
			"that is withdrawn, who is exposed.",
		"routes": []string{
			"GET /umi/attestations/{credentialId}  what rests on one attestation",
			"GET /umi/attestors/{id}               an attestor's record",
		},
		"onWithdrawal": "Withdrawing an attestation appends " + BlockAttestationWithdrawn + " naming the asset, " +
			"the holders at that moment, the tokens outstanding and the value that settled while it stood. " +
			"It is a notice, not a reversal.",
		"disclaimer": AttestationDisclaimer,
	})
}

func (s *Server) handleAttestationImpact(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		umiErr(w, http.StatusMethodNotAllowed, "ERR_METHOD", "Use GET.")
		return
	}
	id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/umi/attestations/"), "/")
	if id == "" {
		umiErr(w, http.StatusBadRequest, "ERR_UMI_CREDENTIAL_FIELDS", "Name a credential id.")
		return
	}
	impact, err := s.Attestations.Impact(id)
	if err != nil {
		code, sentinel := credentialStatusFor(err)
		umiErr(w, code, sentinel, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"impact": impact})
}

func (s *Server) handleAttestor(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		umiErr(w, http.StatusMethodNotAllowed, "ERR_METHOD", "Use GET.")
		return
	}
	id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/umi/attestors/"), "/")
	if id == "" {
		umiErr(w, http.StatusBadRequest, "ERR_UMI_CREDENTIAL_FIELDS", "Name an attestor.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"attestor": s.Attestations.Attestor(id)})
}
