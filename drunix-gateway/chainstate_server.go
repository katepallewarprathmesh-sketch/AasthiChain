package drunix

// HTTP surface for chain-first state (chainstate.go).
//
//	GET  /umi/chainstate                 every module's state rebuilt from blocks
//	GET  /umi/chainstate/verify          does the ledger agree with what is being served
//	GET  /umi/chainstate/{module}        one module's projection
//	POST /umi/chainstate/restore         rebuild the live offer book from the ledger
//
// All reads are public. A claim that a ledger is the source of truth is only
// worth something if an outsider can run the comparison themselves.

import (
	"net/http"
	"strings"
)

func (s *Server) registerChainStateRoutes(mux *http.ServeMux) {
	if s.ChainState == nil {
		return
	}
	mux.HandleFunc("/umi/chainstate", s.durabilityGate(s.handleChainStateCollection))
	mux.HandleFunc("/umi/chainstate/", s.durabilityGate(s.handleChainStateItem))
}

func (s *Server) handleChainStateCollection(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		umiErr(w, http.StatusMethodNotAllowed, "ERR_METHOD", "GET reads the projections.")
		return
	}
	projections := s.ChainState.Projections()
	modules := make([]string, 0, len(projections))
	for _, p := range projections {
		modules = append(modules, p.Module)
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"projections": projections,
		"modules":     modules,
		"meaning": "Each projection is the module's state as the committed blocks alone describe it, " +
			"rebuilt by replaying them. Nothing here is read from the running module's memory.",
		"disclaimer": "Modules absent from this list still hold state the ledger does not fully carry. " +
			"Each projection names the fields it cannot rebuild rather than implying there are none.",
	})
}

func (s *Server) handleChainStateItem(w http.ResponseWriter, r *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/umi/chainstate/"), "/")

	switch strings.ToLower(rest) {
	case "verify":
		if r.Method != http.MethodGet {
			umiErr(w, http.StatusMethodNotAllowed, "ERR_METHOD", "GET runs the comparison.")
			return
		}
		writeJSON(w, http.StatusOK, s.ChainState.Verify())
		return

	case "restore":
		if r.Method != http.MethodPost {
			umiErr(w, http.StatusMethodNotAllowed, "ERR_METHOD", "POST rebuilds the book from the ledger.")
			return
		}
		c := callerOf(r)
		if !umiRequireIdentity(w, c) {
			return
		}
		n := s.ChainState.RestoreOffers()
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"restored": n,
			"note": "Offers the ledger knows about and the running process did not. Zero is the healthy " +
				"answer on a rail that has not restarted, because the book is already the projection.",
			"verify": s.ChainState.CheckOffers(),
		})
		return
	}

	if r.Method != http.MethodGet {
		umiErr(w, http.StatusMethodNotAllowed, "ERR_METHOD", "GET reads one projection.")
		return
	}
	p, ok := s.ChainState.Projection(rest)
	if !ok {
		umiErr(w, http.StatusNotFound, "ERR_UMI_CHAINSTATE_MODULE",
			"No projection for "+rest+". This rail projects offers, documents and work.")
		return
	}
	writeJSON(w, http.StatusOK, p)
}
