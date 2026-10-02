package drunix

// HTTP transport for the UMI rail (SRP: routing only, all logic in umi.go).
// Routes are registered additively by Server.Router(); if Server.UMI is nil the
// rail is simply absent and every existing endpoint behaves exactly as before.

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
)

var umiEndpointList = []string{
	"GET  /umi/config",
	"GET  /umi/wallets",
	"GET  /umi/wallets/{participant}",
	"POST /umi/wallets/{participant}/fund   {\"amountINR\":500000}",
	"GET  /umi/isin",
	"POST /umi/isin                          {\"assetId\":\"...\",\"issuer\":\"...\"}",
	"POST /umi/dvp                           {\"assetId\":\"...\",\"seller\":\"...\",\"buyer\":\"...\",\"tokens\":100,\"pricePerTokenINR\":500,\"dryRun\":false}",
	"GET  /umi/instructions?limit=50",
	"GET  /umi/instructions/{id}",
	"POST /umi/servicing                     {\"assetId\":\"...\",\"payer\":\"...\",\"amountINR\":6000}",
	"GET  /umi/reconciliation",
	"POST /umi/seed                          {\"assetId\":\"...\",\"holder\":\"...\",\"tokens\":15000}  (demo positions only)",
}

// registerUMIRoutes mounts the rail on an existing mux (called from Router).
func (s *Server) registerUMIRoutes(mux *http.ServeMux) {
	if s.UMI == nil {
		return
	}
	mux.HandleFunc("/umi/config", s.handleUMIConfig)
	mux.HandleFunc("/umi/wallets", s.handleUMIWallets)
	mux.HandleFunc("/umi/wallets/", s.handleUMIWallet)
	mux.HandleFunc("/umi/isin", s.handleUMIISIN)
	mux.HandleFunc("/umi/dvp", s.handleUMIDvP)
	mux.HandleFunc("/umi/instructions", s.handleUMIInstructions)
	mux.HandleFunc("/umi/instructions/", s.handleUMIInstruction)
	mux.HandleFunc("/umi/servicing", s.handleUMIServicing)
	mux.HandleFunc("/umi/reconciliation", s.handleUMIReconciliation)
	mux.HandleFunc("/umi/seed", s.handleUMISeed)
}

func umiDecode(r *http.Request, v interface{}) error {
	if r.Body == nil {
		return nil
	}
	defer r.Body.Close()
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(v); err != nil && err.Error() != "EOF" {
		return err
	}
	return nil
}

func umiErr(w http.ResponseWriter, code int, reason, message string) {
	writeJSON(w, code, map[string]interface{}{
		"error":      reason,
		"message":    message,
		"mode":       UMIMode,
		"disclaimer": UMIDisclaimer,
	})
}

func requirePost(w http.ResponseWriter, r *http.Request) bool {
	if r.Method != http.MethodPost {
		umiErr(w, http.StatusMethodNotAllowed, "ERR_METHOD", "POST required")
		return false
	}
	return true
}

func (s *Server) handleUMIConfig(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.UMI.Config())
}

func (s *Server) handleUMIWallets(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"wallets":         s.UMI.Wallets(),
		"settlementAsset": "e₹-W wholesale CBDC (simulated, integer paise)",
		"mode":            UMIMode,
		"disclaimer":      UMIDisclaimer,
	})
}

// /umi/wallets/{participant} and /umi/wallets/{participant}/fund
func (s *Server) handleUMIWallet(w http.ResponseWriter, r *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/umi/wallets/"), "/")
	if rest == "" {
		s.handleUMIWallets(w, r)
		return
	}
	parts := strings.Split(rest, "/")
	participant := parts[0]

	if len(parts) > 1 && parts[1] == "fund" {
		if !requirePost(w, r) {
			return
		}
		var body struct {
			AmountINR float64 `json:"amountINR"`
		}
		if err := umiDecode(r, &body); err != nil {
			umiErr(w, http.StatusBadRequest, "ERR_BAD_JSON", err.Error())
			return
		}
		wallet, blk, err := s.UMI.FundWallet(participant, body.AmountINR)
		if err != nil {
			umiErr(w, http.StatusBadRequest, err.Error(), "amountINR must be positive")
			return
		}
		resp := map[string]interface{}{
			"ok": true, "wallet": wallet, "fundedINR": body.AmountINR,
			"source": UMISettlementBank, "mode": UMIMode, "disclaimer": UMIDisclaimer,
		}
		if blk != nil {
			resp["blockHeight"], resp["blockHash"], resp["blockType"] = blk.Height, blk.Hash, blk.Type
		}
		writeJSON(w, http.StatusOK, resp)
		return
	}

	if r.Method == http.MethodPost {
		wallet, err := s.UMI.OpenWallet(participant)
		if err != nil {
			umiErr(w, http.StatusBadRequest, err.Error(), "participant required")
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true, "wallet": wallet, "mode": UMIMode})
		return
	}

	wallet, ok := s.UMI.Wallet(participant)
	if !ok {
		umiErr(w, http.StatusNotFound, ErrUMINoWallet.Error(), "no wholesale CBDC wallet for "+participant)
		return
	}
	// instructions touching this participant
	var history []SettlementInstruction
	for _, si := range s.UMI.Instructions(0) {
		if si.Buyer == participant || si.Seller == participant {
			history = append(history, si)
		}
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"wallet": wallet, "instructions": history, "mode": UMIMode, "disclaimer": UMIDisclaimer,
	})
}

func (s *Server) handleUMIISIN(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"register": s.UMI.ISINs(), "mode": UMIMode, "disclaimer": UMIDisclaimer,
		})
		return
	}
	if !requirePost(w, r) {
		return
	}
	var body struct {
		AssetID    string `json:"assetId"`
		Issuer     string `json:"issuer"`
		Depository string `json:"depository"`
	}
	if err := umiDecode(r, &body); err != nil {
		umiErr(w, http.StatusBadRequest, "ERR_BAD_JSON", err.Error())
		return
	}
	rec, blk, err := s.UMI.AssignISIN(body.AssetID, body.Issuer, body.Depository)
	if err != nil {
		umiErr(w, http.StatusBadRequest, err.Error(), "assetId required")
		return
	}
	resp := map[string]interface{}{"ok": true, "isin": rec, "mode": UMIMode, "disclaimer": UMIDisclaimer}
	if blk != nil {
		resp["blockHeight"], resp["blockHash"], resp["blockType"] = blk.Height, blk.Hash, blk.Type
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) handleUMIDvP(w http.ResponseWriter, r *http.Request) {
	if !requirePost(w, r) {
		return
	}
	var body DvPRequest
	body.AutoAssignISIN = true // demo-friendly default; override with explicit false
	if err := umiDecode(r, &body); err != nil {
		umiErr(w, http.StatusBadRequest, "ERR_BAD_JSON", err.Error())
		return
	}
	si, err := s.UMI.SettleDvP(body)
	if err != nil {
		// Instruction object is still returned: it carries the full ISO 20022
		// trace showing exactly where the settlement stopped.
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{
			"ok": false, "error": si.FailureReason, "message": si.FailureDetail,
			"instruction": si, "mode": UMIMode, "disclaimer": UMIDisclaimer,
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"ok": true, "instruction": si, "mode": UMIMode, "disclaimer": UMIDisclaimer,
	})
}

func (s *Server) handleUMIInstructions(w http.ResponseWriter, r *http.Request) {
	limit := 50
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
		}
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"instructions": s.UMI.Instructions(limit), "mode": UMIMode, "disclaimer": UMIDisclaimer,
	})
}

func (s *Server) handleUMIInstruction(w http.ResponseWriter, r *http.Request) {
	id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/umi/instructions/"), "/")
	if id == "" {
		s.handleUMIInstructions(w, r)
		return
	}
	si, err := s.UMI.Instruction(id)
	if err != nil {
		umiErr(w, http.StatusNotFound, err.Error(), "no UMI instruction "+id)
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"instruction": si, "mode": UMIMode, "disclaimer": UMIDisclaimer,
	})
}

func (s *Server) handleUMIServicing(w http.ResponseWriter, r *http.Request) {
	if !requirePost(w, r) {
		return
	}
	var body struct {
		AssetID   string  `json:"assetId"`
		Payer     string  `json:"payer"`
		AmountINR float64 `json:"amountINR"`
	}
	if err := umiDecode(r, &body); err != nil {
		umiErr(w, http.StatusBadRequest, "ERR_BAD_JSON", err.Error())
		return
	}
	res, err := s.UMI.Servicing(body.AssetID, body.Payer, body.AmountINR)
	if err != nil {
		reason := err.Error()
		if i := strings.Index(reason, ":"); i > 0 && strings.HasPrefix(reason, "ERR_") {
			reason = reason[:i]
		}
		umiErr(w, http.StatusBadRequest, reason, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true, "servicing": res})
}

func (s *Server) handleUMIReconciliation(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.UMI.Reconcile())
}

// handleUMISeed credits demo positions into the in-memory securities book so
// the rail can be exercised standalone. No-op when the securities leg is backed
// by a real ledger (interface assertion fails).
func (s *Server) handleUMISeed(w http.ResponseWriter, r *http.Request) {
	if !requirePost(w, r) {
		return
	}
	var body struct {
		AssetID string `json:"assetId"`
		Holder  string `json:"holder"`
		Tokens  int64  `json:"tokens"`
	}
	if err := umiDecode(r, &body); err != nil {
		umiErr(w, http.StatusBadRequest, "ERR_BAD_JSON", err.Error())
		return
	}
	mem, ok := s.UMI.Securities().(*MemorySecurities)
	if !ok {
		umiErr(w, http.StatusConflict, "ERR_UMI_LEDGER_NOT_SEEDABLE", "securities leg is backed by a real ledger")
		return
	}
	if body.AssetID == "" || body.Holder == "" || body.Tokens <= 0 {
		umiErr(w, http.StatusBadRequest, ErrUMIInvalidAmount.Error(), "assetId, holder and positive tokens required")
		return
	}
	mem.Credit(body.AssetID, body.Holder, body.Tokens)
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"ok": true, "assetId": body.AssetID, "holder": body.Holder,
		"position": mem.Position(body.AssetID, body.Holder), "mode": UMIMode,
	})
}
