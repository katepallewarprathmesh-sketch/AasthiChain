package drunix

// HTTP surface for public-chain anchoring (solana.go).
//
//	GET  /umi/anchors              live cluster status and the anchors published
//	POST /umi/anchors              publish the current head (supervisor only)
//	GET  /umi/anchors/{signature}  read the anchor back off the cluster and compare
//
// Reads are public. An anchor whose verification needs a login is worth
// nothing: the point is that a stranger can check this ledger without
// trusting, or even asking, the people who run it.

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"
)

func (s *Server) registerAnchorRoutes(mux *http.ServeMux) {
	if s.Anchors == nil {
		return
	}
	mux.HandleFunc("/umi/anchors", s.durabilityGate(s.handleAnchorCollection))
	mux.HandleFunc("/umi/anchors/", s.durabilityGate(s.handleAnchorItem))
}

func anchorStatusFor(err error) (int, string) {
	switch {
	case errors.Is(err, ErrSolanaNoKey):
		return http.StatusConflict, "ERR_UMI_ANCHOR_NO_KEY"
	case errors.Is(err, ErrSolanaNoBalance):
		return http.StatusConflict, "ERR_UMI_ANCHOR_NO_BALANCE"
	case errors.Is(err, ErrSolanaNotFound):
		return http.StatusNotFound, "ERR_UMI_ANCHOR_NOT_FOUND"
	case errors.Is(err, ErrSolanaRPC):
		return http.StatusBadGateway, "ERR_UMI_ANCHOR_RPC"
	default:
		return http.StatusBadRequest, "ERR_UMI_ANCHOR"
	}
}

func (s *Server) handleAnchorCollection(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"status":  s.Anchors.Status(ctx),
			"anchors": s.Anchors.Records(queryLimit(r, 50, 200)),
		})

	case http.MethodPost:
		c := callerOf(r)
		if !umiRequireIdentity(w, c) {
			return
		}
		// Anchoring spends real money, however little, and publishes a
		// digest that cannot be withdrawn. Supervisors only.
		if !c.supervisor() {
			umiErr(w, http.StatusForbidden, "ERR_UMI_ANCHOR_FORBIDDEN",
				"Publishing to a public chain spends a fee and cannot be undone. A supervisor does it.")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
		defer cancel()
		rec, err := s.Anchors.Anchor(ctx)
		if err != nil {
			code, sentinel := anchorStatusFor(err)
			umiErr(w, code, sentinel, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"anchor": rec,
			"note": "Published to a public cluster. Anyone can open the explorer link and compare the memo " +
				"with this ledger's block at that height.",
			"disclaimer": SolanaDisclaimer,
		})

	default:
		umiErr(w, http.StatusMethodNotAllowed, "ERR_METHOD", "GET or POST.")
	}
}

func (s *Server) handleAnchorItem(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		umiErr(w, http.StatusMethodNotAllowed, "ERR_METHOD", "Use GET.")
		return
	}
	sig := strings.Trim(strings.TrimPrefix(r.URL.Path, "/umi/anchors/"), "/")
	if sig == "" {
		umiErr(w, http.StatusBadRequest, "ERR_UMI_ANCHOR_NOT_FOUND", "Name a transaction signature.")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	res, err := s.Anchors.Verify(ctx, sig)
	if err != nil {
		code, sentinel := anchorStatusFor(err)
		umiErr(w, code, sentinel, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"verification": res,
		"disclaimer":   SolanaDisclaimer,
	})
}
