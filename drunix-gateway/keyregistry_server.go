package drunix

// HTTP surface for the signing-key register (keyregistry.go).
//
//	GET  /umi/keys                  every key in service, with its screening verdict
//	GET  /umi/keys/posture          what this process signs with, including the bad news
//	POST /umi/keys/challenge        get a nonce to prove you hold the private key
//	POST /umi/keys                  register a screened key
//	POST /umi/keys/{keyId}/revoke   withdraw a key, with a reason
//	POST /umi/keys/audit            re-screen every key in service
//	POST /umi/keys/screen           screen a key without registering it
//
// The register is public on purpose. The thing that eventually caught the
// October 2026 eMudhra keys was that the certificates were published and an
// outsider could check them. A key register only an operator can read offers
// nobody that opportunity.

import (
	"crypto/ed25519"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"
)

func (s *Server) registerKeyRoutes(mux *http.ServeMux) {
	if s.Keys == nil {
		return
	}
	mux.HandleFunc("/umi/keys", s.handleKeysRoot)
	mux.HandleFunc("/umi/keys/", s.handleKeysPath)
}

func keyStatusFor(err error) (int, string) {
	switch {
	case errors.Is(err, ErrKeyWeak):
		return http.StatusUnprocessableEntity, "ERR_UMI_KEY_WEAK"
	case errors.Is(err, ErrKeyDuplicate):
		return http.StatusConflict, "ERR_UMI_KEY_DUPLICATE"
	case errors.Is(err, ErrKeyRevoked):
		return http.StatusConflict, "ERR_UMI_KEY_REVOKED"
	case errors.Is(err, ErrKeyNotFound):
		return http.StatusNotFound, "ERR_UMI_KEY_NOT_FOUND"
	case errors.Is(err, ErrKeyPossess):
		return http.StatusForbidden, "ERR_UMI_KEY_NOT_POSSESSED"
	default:
		return http.StatusBadRequest, "ERR_UMI_KEY_FIELDS"
	}
}

func (s *Server) keyFail(w http.ResponseWriter, err error) {
	code, tag := keyStatusFor(err)
	umiErr(w, code, tag, err.Error())
}

func (s *Server) handleKeysRoot(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"keys": s.Keys.Keys(),
			"why": "Every signing key this rail trusts, append-only on the chain. Published so that somebody outside " +
				"this organisation can check them, which is the only reason the October 2026 certificate authority " +
				"keys were ever found.",
			"revocationReasons": map[string]string{
				KeyRevokeCompromise: "the private key is or may be known to somebody else; every signature it ever made becomes unattributable",
				KeyRevokeSuperseded: "replaced by a newer key in an orderly rotation; earlier signatures stand",
				KeyRevokeRetired:    "withdrawn from service without suspicion; earlier signatures stand",
			},
			"disclaimer": UMIDisclaimer,
		})
	case http.MethodPost:
		c := callerOf(r)
		if !umiRequireIdentity(w, c) {
			return
		}
		var body struct {
			Holder    string `json:"holder"`
			Use       string `json:"use"`
			PublicKey string `json:"publicKey"`
			Signature string `json:"challengeSignature"`
		}
		if err := umiDecode(r, &body); err != nil {
			umiErr(w, http.StatusBadRequest, "ERR_UMI_KEY_FIELDS", err.Error())
			return
		}
		if body.Holder == "" {
			body.Holder = c.ID
		}
		if !umiRequireSelfOrSupervisor(w, c, body.Holder, "register a signing key") {
			return
		}
		rec, err := s.Keys.Register(body.Holder, body.Use, body.PublicKey, body.Signature, c.ID)
		if err != nil {
			s.keyFail(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, map[string]interface{}{"key": rec, "disclaimer": UMIDisclaimer})
	default:
		umiErr(w, http.StatusMethodNotAllowed, "ERR_UMI_METHOD", "GET or POST.")
	}
}

func (s *Server) handleKeysPath(w http.ResponseWriter, r *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/umi/keys/"), "/")
	parts := strings.Split(rest, "/")

	switch {
	case parts[0] == "posture":
		if r.Method != http.MethodGet {
			umiErr(w, http.StatusMethodNotAllowed, "ERR_UMI_METHOD", "GET only.")
			return
		}
		writeJSON(w, http.StatusOK, s.Keys.SelfReport(s.Credentials))

	case parts[0] == "challenge":
		if r.Method != http.MethodPost {
			umiErr(w, http.StatusMethodNotAllowed, "ERR_UMI_METHOD", "POST only.")
			return
		}
		c := callerOf(r)
		if !umiRequireIdentity(w, c) {
			return
		}
		var body struct {
			Holder string `json:"holder"`
		}
		_ = umiDecode(r, &body)
		if body.Holder == "" {
			body.Holder = c.ID
		}
		nonce, exp, err := s.Keys.Challenge(body.Holder)
		if err != nil {
			s.keyFail(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, map[string]interface{}{
			"holder": body.Holder, "nonce": nonce, "expiresAt": exp,
			"howTo": "Sign these nonce bytes with the private key and send the signature hex as challengeSignature. " +
				"Registering a public key without this proves nothing: anyone can copy a public key out of the register.",
		})

	case parts[0] == "screen":
		if r.Method != http.MethodPost {
			umiErr(w, http.StatusMethodNotAllowed, "ERR_UMI_METHOD", "POST only.")
			return
		}
		var body struct {
			PublicKey string `json:"publicKey"`
		}
		if err := umiDecode(r, &body); err != nil {
			umiErr(w, http.StatusBadRequest, "ERR_UMI_KEY_FIELDS", err.Error())
			return
		}
		raw, err := hex.DecodeString(strings.TrimSpace(body.PublicKey))
		if err != nil {
			umiErr(w, http.StatusBadRequest, "ERR_UMI_KEY_FIELDS", "the public key must be hex")
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"screen": ScreenPublicKey(ed25519.PublicKey(raw))})

	case parts[0] == "audit":
		if r.Method != http.MethodPost {
			umiErr(w, http.StatusMethodNotAllowed, "ERR_UMI_METHOD", "POST only.")
			return
		}
		c := callerOf(r)
		if !umiRequireIdentity(w, c) {
			return
		}
		writeJSON(w, http.StatusOK, s.Keys.Audit(c.ID))

	case len(parts) >= 2 && parts[1] == "revoke":
		if r.Method != http.MethodPost {
			umiErr(w, http.StatusMethodNotAllowed, "ERR_UMI_METHOD", "POST only.")
			return
		}
		c := callerOf(r)
		if !umiRequireIdentity(w, c) {
			return
		}
		var body struct {
			Reason string `json:"reason"`
		}
		_ = umiDecode(r, &body)
		rec, err := s.Keys.Revoke(parts[0], body.Reason, c.ID)
		if err != nil {
			s.keyFail(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"key": rec, "disclaimer": UMIDisclaimer})

	default:
		umiErr(w, http.StatusNotFound, "ERR_UMI_KEY_NOT_FOUND", "No such key route.")
	}
}
