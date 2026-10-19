package drunix

// HTTP surface for proof of backing (backing.go).
//
//	GET  /umi/backing                 solvency across every attested asset
//	GET  /umi/backing/{assetId}       coverage for one asset
//	POST /umi/backing                 make or refresh a statement (registrar/supervisor)
//	POST /umi/backing/{assetId}/withdraw
//
// Reads are public on purpose. Coverage is the number a holder most needs and
// is least able to obtain, and one that is only published when it flatters the
// issuer is worth nothing.

import (
	"errors"
	"net/http"
	"strings"
	"time"
)

func (s *Server) registerBackingRoutes(mux *http.ServeMux) {
	if s.Backing == nil {
		return
	}
	mux.HandleFunc("/umi/backing", s.durabilityGate(s.handleBackingCollection))
	mux.HandleFunc("/umi/backing/", s.durabilityGate(s.handleBackingItem))
}

func backingStatusFor(err error) (int, string) {
	switch {
	case errors.Is(err, ErrBackingNotFound):
		return http.StatusNotFound, "ERR_UMI_BACKING_NOT_FOUND"
	case errors.Is(err, ErrBackingNotYours):
		return http.StatusForbidden, "ERR_UMI_BACKING_NOT_ATTESTOR"
	case errors.Is(err, ErrBackingFields):
		return http.StatusBadRequest, "ERR_UMI_BACKING_FIELDS"
	case errors.Is(err, ErrBackingShort):
		return http.StatusConflict, "ERR_UMI_BACKING_SHORT"
	case errors.Is(err, ErrBackingStale):
		return http.StatusConflict, "ERR_UMI_BACKING_STALE"
	case errors.Is(err, ErrBackingWithdrawn):
		return http.StatusConflict, "ERR_UMI_BACKING_WITHDRAWN"
	default:
		return http.StatusBadRequest, "ERR_UMI_BACKING"
	}
}

// backingMayAttest: a registrar or a supervisor. Explicitly not the holder of
// the asset, which is the entire point of an independent figure.
func backingMayAttest(c umiCaller) bool {
	return c.supervisor() || strings.EqualFold(c.Role, "Registrar")
}

func (s *Server) handleBackingCollection(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, s.Backing.Solvency(time.Now().UTC()))

	case http.MethodPost:
		c := callerOf(r)
		if !umiRequireIdentity(w, c) {
			return
		}
		if !backingMayAttest(c) {
			umiErr(w, http.StatusForbidden, "ERR_UMI_BACKING_NOT_ATTESTOR",
				"A statement of backing is only worth something when the party making it is not the party "+
					"whose book it supports. A registrar or a supervisor makes it.")
			return
		}
		var body BackingRequest
		if err := umiDecode(r, &body); err != nil {
			umiErr(w, http.StatusBadRequest, "ERR_BAD_JSON", err.Error())
			return
		}
		st, err := s.Backing.Attest(body, c.ID, c.supervisor())
		if err != nil {
			code, sentinel := backingStatusFor(err)
			umiErr(w, code, sentinel, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"statement":  st,
			"coverage":   s.Backing.Coverage(st.AssetID, time.Now().UTC()),
			"disclaimer": BackingDisclaimer,
		})

	default:
		umiErr(w, http.StatusMethodNotAllowed, "ERR_METHOD", "GET or POST.")
	}
}

func (s *Server) handleBackingItem(w http.ResponseWriter, r *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/umi/backing/"), "/")
	if rest == "" {
		umiErr(w, http.StatusBadRequest, "ERR_UMI_BACKING_FIELDS", "Name an asset.")
		return
	}
	parts := strings.Split(rest, "/")
	assetID := parts[0]

	if len(parts) == 1 {
		if r.Method != http.MethodGet {
			umiErr(w, http.StatusMethodNotAllowed, "ERR_METHOD", "Use GET.")
			return
		}
		cov := s.Backing.Coverage(assetID, time.Now().UTC())
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"coverage":   cov,
			"disclaimer": BackingDisclaimer,
		})
		return
	}

	if strings.ToLower(parts[1]) != "withdraw" {
		umiErr(w, http.StatusNotFound, "ERR_UMI_BACKING_NO_ACTION", "No action "+parts[1]+" on a backing statement.")
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
	st, err := s.Backing.Withdraw(assetID, body.Reason, c.ID, c.supervisor())
	if err != nil {
		code, sentinel := backingStatusFor(err)
		umiErr(w, code, sentinel, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"statement": st,
		"coverage":  s.Backing.Coverage(assetID, time.Now().UTC()),
		"effect":    "Notice only. No token is burned and no settled trade is reversed.",
	})
}
