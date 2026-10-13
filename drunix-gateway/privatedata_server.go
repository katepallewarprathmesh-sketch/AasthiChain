package drunix

// HTTP surface for the private data collections (privatedata.go).
//
// Routes:
//
//	GET  /umi/private/collections             the definitions, public
//	GET  /umi/private/{collection}            proofs the caller may see
//	POST /umi/private/{collection}            write a value (members only)
//	GET  /umi/private/{collection}/{key}      value to a reader the policy admits, proof to everyone
//	POST /umi/private/{collection}/{key}/verify  check a value you already hold
//
// A non-member GET of a key answers 403 and still returns the proof. That is
// deliberate: refusing the value while publishing the hash is the mechanism,
// not a leak. Hiding existence would be a different promise and this rail
// does not make it.

import (
	"errors"
	"net/http"
	"strings"
)

func (s *Server) registerPrivateDataRoutes(mux *http.ServeMux) {
	if s.UMI == nil || s.UMI.Private() == nil {
		return
	}
	mux.HandleFunc("/umi/private/collections", s.handlePrivateCollections)
	mux.HandleFunc("/umi/private/", s.durabilityGate(s.handlePrivatePath))
}

func privateStatusFor(err error) (int, string) {
	switch {
	case errors.Is(err, ErrPDCNoCollection):
		return http.StatusNotFound, "ERR_UMI_PDC_NO_COLLECTION"
	case errors.Is(err, ErrPDCNotFound):
		return http.StatusNotFound, "ERR_UMI_PDC_NOT_FOUND"
	case errors.Is(err, ErrPDCForbidden):
		return http.StatusForbidden, "ERR_UMI_PDC_FORBIDDEN"
	case errors.Is(err, ErrPDCFields):
		return http.StatusBadRequest, "ERR_UMI_PDC_FIELDS"
	case errors.Is(err, ErrPDCGone):
		return http.StatusGone, "ERR_UMI_PDC_VALUE_GONE"
	default:
		return http.StatusBadRequest, "ERR_UMI_PDC_REJECTED"
	}
}

func (s *Server) handlePrivateCollections(w http.ResponseWriter, r *http.Request) {
	ps := s.UMI.Private()
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"collections": ps.Collections(),
		"stats":       ps.Stats(),
		"model": "Hyperledger Fabric private data collections. Members hold the value; the chain holds the " +
			"hash of the key and the hash of the value, so the network can prove a record exists and has " +
			"not changed without being able to read it.",
		"limitation": "This rail is a single process, so membership is enforced in code rather than by " +
			"keeping the value off a non-member's machine. The policy, the hashes and the ledger evidence " +
			"are real; the peer-to-peer distribution is not.",
		"disclaimer": UMIDisclaimer,
	})
}

func (s *Server) handlePrivatePath(w http.ResponseWriter, r *http.Request) {
	ps := s.UMI.Private()
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/umi/private/"), "/")
	if rest == "" {
		umiErr(w, http.StatusNotFound, "ERR_UMI_PDC_NO_COLLECTION", "Name a collection. GET /umi/private/collections lists them.")
		return
	}
	parts := strings.Split(rest, "/")
	collection := parts[0]
	caller := callerOf(r)

	switch {
	case len(parts) == 1 && r.Method == http.MethodGet:
		proofs, err := ps.Keys(collection, caller.ID, caller.Role)
		if err != nil {
			code, sentinel := privateStatusFor(err)
			umiErr(w, code, sentinel, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"collection": collection,
			"proofs":     proofs,
			"count":      len(proofs),
			"note":       "Proofs only. A value is served through GET /umi/private/{collection}/{key} and only to a reader the policy admits.",
		})

	case len(parts) == 1 && r.Method == http.MethodPost:
		if !umiRequireIdentity(w, caller) {
			return
		}
		var body PrivateWrite
		if err := umiDecode(r, &body); err != nil {
			umiErr(w, http.StatusBadRequest, "ERR_BAD_REQUEST", "Body must be JSON.")
			return
		}
		body.Collection = collection
		proof, err := ps.Put(body, caller.ID, caller.Role)
		if err != nil {
			code, sentinel := privateStatusFor(err)
			umiErr(w, code, sentinel, err.Error())
			return
		}
		writeJSON(w, http.StatusCreated, map[string]interface{}{
			"proof": proof,
			"note":  "Committed. The block carries the hashes; the value stayed in the collection.",
		})

	case len(parts) == 2 && r.Method == http.MethodGet:
		value, proof, err := ps.Get(collection, parts[1], caller.ID, caller.Role)
		if err != nil {
			code, sentinel := privateStatusFor(err)
			out := map[string]interface{}{"error": sentinel, "message": err.Error(), "disclaimer": UMIDisclaimer}
			if proof != nil {
				out["proof"] = proof
				out["note"] = "The proof is public even where the value is not. Verify a copy you already hold at POST /umi/private/" +
					collection + "/" + parts[1] + "/verify."
			}
			writeJSON(w, code, out)
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"value": value,
			"proof": proof,
		})

	case len(parts) == 3 && parts[2] == "verify" && r.Method == http.MethodPost:
		var body struct {
			Value map[string]interface{} `json:"value"`
		}
		if err := umiDecode(r, &body); err != nil {
			umiErr(w, http.StatusBadRequest, "ERR_BAD_REQUEST", "Body must be JSON with a value object.")
			return
		}
		match, proof, err := ps.Verify(collection, parts[1], body.Value)
		if err != nil && !errors.Is(err, ErrPDCFields) {
			code, sentinel := privateStatusFor(err)
			umiErr(w, code, sentinel, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"matches": match,
			"proof":   proof,
			"note": "The hash is computed over the canonical JSON of the value. Reproduce it yourself: " +
				"serialise the object with sorted keys and take its SHA-256.",
		})

	default:
		umiErr(w, http.StatusMethodNotAllowed, "ERR_METHOD", "Supported: GET/POST /umi/private/{collection}, GET /umi/private/{collection}/{key}, POST .../verify.")
	}
}
