package drunix

// HTTP surface for verifiable credentials (credentials.go).
//
//	GET  /umi/credentials                          the registry, its disclosure, the issued list
//	POST /umi/credentials                          issue (Registrar or supervisor)
//	GET  /umi/credentials/issuers/{id}             an issuer's public key
//	GET  /umi/credentials/{id}                     one credential
//	GET  /umi/credentials/{id}/verify              verify the stored copy
//	POST /umi/credentials/{id}/revoke              revoke (issuer or supervisor)
//	POST /umi/credentials/verify                   verify a credential presented in the body
//
// Reads are public on purpose. A credential whose verification needs our
// permission is not a verifiable credential, it is a login.

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
)

func (s *Server) registerCredentialRoutes(mux *http.ServeMux) {
	if s.Credentials == nil {
		return
	}
	mux.HandleFunc("/umi/credentials", s.handleCredentialsRoot)
	mux.HandleFunc("/umi/credentials/", s.handleCredentialPath)
}

func credentialStatusFor(err error) (int, string) {
	switch {
	case errors.Is(err, ErrCredNotFound):
		return http.StatusNotFound, "ERR_UMI_CREDENTIAL_NOT_FOUND"
	case errors.Is(err, ErrCredRevoked):
		return http.StatusConflict, "ERR_UMI_CREDENTIAL_REVOKED"
	case errors.Is(err, ErrCredUnknownTyp):
		return http.StatusBadRequest, "ERR_UMI_CREDENTIAL_TYPE"
	case errors.Is(err, ErrCredFields):
		return http.StatusBadRequest, "ERR_UMI_CREDENTIAL_FIELDS"
	default:
		return http.StatusBadRequest, "ERR_UMI_CREDENTIAL_REJECTED"
	}
}

// issueRequest is the body accepted when minting a credential.
type issueRequest struct {
	Type    string                 `json:"type"`
	Subject string                 `json:"subject"`
	AssetID string                 `json:"assetId"`
	Claims  map[string]interface{} `json:"claims"`
}

func (s *Server) handleCredentialsRoot(w http.ResponseWriter, r *http.Request) {
	reg := s.Credentials
	switch r.Method {
	case http.MethodGet:
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		list := reg.List(r.URL.Query().Get("assetId"), r.URL.Query().Get("subject"), limit)
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"credentials": list,
			"count":       len(list),
			"registry":    reg.Summary(),
			"model": "A registrar signs a statement about a property and the hash of the signed document is " +
				"anchored on the ledger. Anyone can check the signature against the issuer's published key and " +
				"the hash against the chain, without trusting this service.",
			"disclaimer": UMIDisclaimer,
		})

	case http.MethodPost:
		caller := callerOf(r)
		if !umiRequireRegistrarOrSupervisor(w, caller, "Issuing a title credential") {
			return
		}
		var body issueRequest
		if err := umiDecode(r, &body); err != nil {
			umiErr(w, http.StatusBadRequest, "ERR_BAD_REQUEST", "Body must be JSON.")
			return
		}
		claims := body.Claims
		if claims == nil {
			claims = map[string]interface{}{}
		}
		credType := strings.TrimSpace(body.Type)
		if credType == "" {
			credType = CredentialTitleValidation
		}

		var rec *credentialRecord
		var err error
		if credType == CredentialTitleValidation {
			rec, err = reg.IssueTitleCredential(caller.ID, body.Subject, body.AssetID, claims)
		} else {
			claims["id"] = body.Subject
			if body.AssetID != "" {
				claims["assetId"] = body.AssetID
			}
			rec, err = reg.Issue(caller.ID, credType, claims)
		}
		if err != nil {
			code, sentinel := credentialStatusFor(err)
			umiErr(w, code, sentinel, err.Error())
			return
		}
		writeJSON(w, http.StatusCreated, map[string]interface{}{
			"credential": rec,
			"note": "Keep the credential document. Verification needs the document and the ledger, not this " +
				"service's database.",
		})

	default:
		umiErr(w, http.StatusMethodNotAllowed, "ERR_METHOD", "Use GET or POST.")
	}
}

func (s *Server) handleCredentialPath(w http.ResponseWriter, r *http.Request) {
	reg := s.Credentials
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/umi/credentials/"), "/")
	parts := strings.Split(rest, "/")
	caller := callerOf(r)

	switch {
	// Verify a document the caller holds. This is the important one: the
	// holder presents the credential, we confirm the signature and the
	// anchor, and we never had to be asked for the document itself.
	case rest == "verify" && r.Method == http.MethodPost:
		var body struct {
			Credential *Credential `json:"credential"`
		}
		if err := umiDecode(r, &body); err != nil {
			umiErr(w, http.StatusBadRequest, "ERR_BAD_REQUEST", "Body must be JSON.")
			return
		}
		res, err := reg.VerifyPresented(body.Credential)
		if err != nil {
			code, sentinel := credentialStatusFor(err)
			umiErr(w, code, sentinel, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, res)

	case len(parts) == 2 && parts[0] == "issuers" && r.Method == http.MethodGet:
		_, demo := issuerSeed()
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"issuer":    parts[1],
			"did":       "did:aasthi:" + strings.ToLower(parts[1]),
			"algorithm": "Ed25519",
			"publicKey": reg.PublicKeyOf(parts[1]),
			"demoKey":   demo,
			"note": "Check a credential's signature against this key. When demoKey is true the signing seed is a " +
				"public constant in this repository, so a signature proves the document is unaltered and proves " +
				"nothing about authority.",
		})

	case len(parts) == 2 && parts[1] == "verify" && r.Method == http.MethodGet:
		res, err := reg.VerifyStored(parts[0])
		if err != nil {
			code, sentinel := credentialStatusFor(err)
			umiErr(w, code, sentinel, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, res)

	case len(parts) == 2 && parts[1] == "revoke" && r.Method == http.MethodPost:
		rec, err := reg.Get(parts[0])
		if err != nil {
			code, sentinel := credentialStatusFor(err)
			umiErr(w, code, sentinel, err.Error())
			return
		}
		if !caller.supervisor() && !caller.is(rec.IssuedBy) {
			umiErr(w, http.StatusForbidden, "ERR_UMI_CREDENTIAL_FORBIDDEN",
				"A credential can be revoked by the issuer that signed it or by a supervisor.")
			return
		}
		var body struct {
			Reason string `json:"reason"`
		}
		_ = umiDecode(r, &body)
		rec, err = reg.Revoke(parts[0], caller.ID, strings.TrimSpace(body.Reason))
		if err != nil {
			code, sentinel := credentialStatusFor(err)
			umiErr(w, code, sentinel, err.Error())
			return
		}
		// Withdrawing an attestation leaves holders downstream of it. Who
		// they are goes on the ledger at the moment of withdrawal, because
		// deriving it afterwards answers a different question.
		resp := map[string]interface{}{
			"credential": rec,
			"note": "The signature on the document is still valid. Revocation is a separate fact, recorded on " +
				"the ledger, and verification reports the two separately.",
		}
		if s.Attestations != nil {
			if impact, blk := s.Attestations.RecordWithdrawal(parts[0]); blk != nil {
				resp["impact"] = impact
				resp["noticeBlock"] = blk.Height
			}
		}
		writeJSON(w, http.StatusOK, resp)

	case len(parts) == 1 && r.Method == http.MethodGet:
		rec, err := reg.Get(parts[0])
		if err != nil {
			code, sentinel := credentialStatusFor(err)
			umiErr(w, code, sentinel, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"credential": rec})

	default:
		umiErr(w, http.StatusNotFound, "ERR_NOT_FOUND", "No such credential route.")
	}
}
