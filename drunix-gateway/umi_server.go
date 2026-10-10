package drunix

// HTTP transport for the UMI rail (SRP: routing only, all logic in umi.go).
// Routes are registered additively by Server.Router(); if Server.UMI is nil the
// rail is simply absent and every existing endpoint behaves exactly as before.

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
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
	// Dynamic ownership — cap table over a window, not just a current balance.
	"GET  /umi/ownership/{assetId}?from=&to=  holders with pctNow, pctTimeWeighted, tokenDays",
	// Cross-property portfolio tokens — one wrapped unit over several properties.
	"GET  /umi/baskets",
	"GET  /umi/baskets/{basketId}",
	"POST /umi/baskets                       {\"basketId\":\"...\",\"name\":\"...\",\"components\":[{\"assetId\":\"...\",\"tokensPerUnit\":2}]}  (>=2 distinct assets)",
	"POST /umi/baskets/{basketId}/subscribe  {\"holder\":\"...\",\"units\":10}   wrap: moves tokens into custody",
	"POST /umi/baskets/{basketId}/redeem     {\"holder\":\"...\",\"units\":4}    unwrap: back to the underlying",
	"POST /umi/baskets/{basketId}/dvp        {\"seller\":\"...\",\"buyer\":\"...\",\"units\":3,\"pricePerUnitINR\":2100,\"dryRun\":false}  atomic units <-> e-rupee-W",
	"POST /umi/baskets/{basketId}/transfer   {\"from\":\"...\",\"to\":\"...\",\"units\":2}  no cash leg",
	"GET  /umi/holdings/{participant}        units held per basket + totalBasketValueINR",
	// Advanced analytics — derived from settled history, nothing new stored.
	"GET  /umi/analytics?days=14             rail: success rate, volume, top assets, daily activity",
	"GET  /umi/analytics/{participant}       investor: cost basis, P&L, income, concentration",
}

// registerUMIRoutes mounts the rail on an existing mux (called from Router).
// durabilityGate refuses money-moving requests while committed blocks are
// still waiting to reach durable storage.
//
// Reads are always allowed: showing someone their balance during a storage
// outage is harmless, and going dark would be a worse answer than a slightly
// stale one. Only the writes are held back, and only before they have changed
// anything.
func (s *Server) durabilityGate(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// A sealed chain cannot take a block, and the rail used to carry on
		// anyway: the wallet moved in memory and the response said ok, with
		// no block behind it. Refuse the write instead of reporting a
		// settlement the ledger cannot prove.
		if r.Method != http.MethodGet && r.Method != http.MethodOptions && s.chainSealed() {
			writeJSON(w, http.StatusServiceUnavailable, map[string]interface{}{
				"error":   "ERR_LEDGER_SEALED",
				"message": "the ledger failed verification on restore and is refusing new blocks, so this cannot be committed",
				"hint":    "see GET /drunix/ledger/status",
			})
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodOptions &&
			UMIDurabilityStrict() && s.chainDegraded() {
			writeJSON(w, http.StatusServiceUnavailable, map[string]interface{}{
				"error":   "ERR_UMI_DURABILITY_DEGRADED",
				"message": ErrDurabilityDegraded.Error(),
				"hint":    "see GET /drunix/ledger/status for how far behind durable storage is",
			})
			return
		}
		next(w, r)
	}
}

// chainSealed reports whether the ledger is refusing appends entirely.
func (s *Server) chainSealed() bool {
	if s.Pipeline == nil || s.Pipeline.CP == nil || s.Pipeline.CP.Ledger == nil {
		return false
	}
	return s.Pipeline.CP.Ledger.Sealed()
}

// chainDegraded reports whether any committed block is still unpersisted.
func (s *Server) chainDegraded() bool {
	if s.Pipeline == nil || s.Pipeline.CP == nil || s.Pipeline.CP.Ledger == nil {
		return false
	}
	return s.Pipeline.CP.Ledger.Behind() > 0
}

func (s *Server) registerUMIRoutes(mux *http.ServeMux) {
	if s.UMI == nil {
		return
	}
	mux.HandleFunc("/umi/config", s.handleUMIConfig)
	mux.HandleFunc("/umi/wallets", s.handleUMIWallets)
	mux.HandleFunc("/umi/wallets/", s.durabilityGate(s.handleUMIWallet))
	mux.HandleFunc("/umi/isin", s.handleUMIISIN)
	mux.HandleFunc("/umi/dvp", s.durabilityGate(s.handleUMIDvP))
	mux.HandleFunc("/umi/instructions", s.handleUMIInstructions)
	mux.HandleFunc("/umi/instructions/", s.handleUMIInstruction)
	mux.HandleFunc("/umi/servicing", s.durabilityGate(s.handleUMIServicing))
	mux.HandleFunc("/umi/servicing/history", s.handleUMIServicingHistory)
	mux.HandleFunc("/umi/income/", s.handleUMIIncome)
	mux.HandleFunc("/umi/reconciliation", s.handleUMIReconciliation)
	mux.HandleFunc("/umi/seed", s.durabilityGate(s.handleUMISeed))
	s.registerAnalyticsRoutes(mux)
	s.registerPortfolioRoutes(mux)
	s.registerMarketRoutes(mux)
	s.registerNotificationRoutes(mux)
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
	// The wallet book is every participant's cash position. A participant
	// sees their own; supervisors see the rail.
	c := callerOf(r)
	if !umiRequireIdentity(w, c) {
		return
	}
	wallets := s.UMI.Wallets()
	if !c.supervisor() {
		mine := make([]CBDCWallet, 0, 1)
		for _, wl := range wallets {
			if c.is(wl.Participant) {
				mine = append(mine, wl)
			}
		}
		wallets = mine
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"wallets":         wallets,
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

	caller := callerOf(r)

	if len(parts) > 1 && parts[1] == "fund" {
		if !requirePost(w, r) {
			return
		}
		// Funding credits a wallet with central-bank money that was never
		// debited anywhere else. Anyone could do it for anyone.
		if !umiRequireSupervisor(w, caller, "Funding a wholesale CBDC wallet") {
			return
		}
		// Funding credits a wallet from the settlement bank. A retried
		// funding call mints money that was never debited anywhere, which
		// breaks conservation — the one invariant the rail must not lose.
		tx, proceed := s.beginIdem(w, r)
		if !proceed {
			return
		}
		defer tx.release()

		var body struct {
			AmountINR float64 `json:"amountINR"`
		}
		if err := umiDecode(r, &body); err != nil {
			umiErr(w, http.StatusBadRequest, "ERR_BAD_JSON", err.Error())
			return
		}
		wallet, blk, err := s.UMI.FundWallet(participant, body.AmountINR)
		if err != nil {
			tx.finish(w, http.StatusBadRequest, map[string]interface{}{
				"ok": false, "error": err.Error(), "message": "amountINR must be positive",
				"mode": UMIMode, "disclaimer": UMIDisclaimer,
			})
			return
		}
		resp := map[string]interface{}{
			"ok": true, "wallet": wallet, "fundedINR": body.AmountINR,
			"source": UMISettlementBank, "mode": UMIMode, "disclaimer": UMIDisclaimer,
		}
		if blk != nil {
			resp["blockHeight"], resp["blockHash"], resp["blockType"] = blk.Height, blk.Hash, blk.Type
		}
		tx.finish(w, http.StatusOK, resp)
		return
	}

	if r.Method == http.MethodPost {
		if !umiRequireSelfOrSupervisor(w, caller, participant, "That wallet") {
			return
		}
		wallet, err := s.UMI.OpenWallet(participant)
		if err != nil {
			umiErr(w, http.StatusBadRequest, err.Error(), "participant required")
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true, "wallet": wallet, "mode": UMIMode})
		return
	}

	// A wallet read returns the cash balance and every settlement the
	// participant has been party to.
	if !umiRequireSelfOrSupervisor(w, caller, participant, "That wallet") {
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
	// Idempotency: a retry of a settlement that already happened must replay
	// the original response, never settle a second time.
	tx, proceed := s.beginIdem(w, r)
	if !proceed {
		return
	}
	defer tx.release()

	var body DvPRequest
	body.AutoAssignISIN = true // demo-friendly default; override with explicit false
	if err := umiDecode(r, &body); err != nil {
		umiErr(w, http.StatusBadRequest, "ERR_BAD_JSON", err.Error())
		return
	}
	// The buyer's wallet pays. Naming someone else as the buyer spent their
	// cash for them, so the caller has to be the buyer (or a supervisor
	// settling on the rail's behalf).
	if c := callerOf(r); !body.DryRun && !umiRequireSelfOrSupervisor(w, c, body.Buyer, "That settlement account") {
		return
	}
	si, err := s.UMI.SettleDvP(body)
	if err != nil {
		// Instruction object is still returned: it carries the full ISO 20022
		// trace showing exactly where the settlement stopped.
		tx.finish(w, http.StatusBadRequest, map[string]interface{}{
			"ok": false, "error": si.FailureReason, "message": si.FailureDetail,
			"instruction": si, "mode": UMIMode, "disclaimer": UMIDisclaimer,
		})
		return
	}
	tx.finish(w, http.StatusOK, map[string]interface{}{
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

// handleUMIIncome answers "what rent or coupon has this holder actually been
// paid?" — the per-investor view the ledger block alone cannot provide.
func (s *Server) handleUMIIncome(w http.ResponseWriter, r *http.Request) {
	if s.UMI == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "ERR_UMI_DISABLED"})
		return
	}
	participant := strings.Trim(strings.TrimPrefix(r.URL.Path, "/umi/income/"), "/")
	if participant == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "ERR_UMI_PARTICIPANT_REQUIRED",
			"message": "GET /umi/income/{participant}"})
		return
	}
	total, rows := s.UMI.Income(participant)
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"participant":    participant,
		"totalIncomeINR": total,
		"payouts":        rows,
		"count":          len(rows),
		"asset":          "e₹-W wholesale CBDC (simulated)",
		"note":           "Servicing credited directly to the holder's CBDC wallet by smart contract — no registrar file exchange.",
	})
}

// handleUMIServicingHistory lists every payout across all holders.
func (s *Server) handleUMIServicingHistory(w http.ResponseWriter, r *http.Request) {
	if s.UMI == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "ERR_UMI_DISABLED"})
		return
	}
	rows := s.UMI.ServicingHistory(atoiDefault(r.URL.Query().Get("limit"), 100))
	writeJSON(w, http.StatusOK, map[string]interface{}{"payouts": rows, "count": len(rows)})
}

func (s *Server) handleUMIServicing(w http.ResponseWriter, r *http.Request) {
	if !requirePost(w, r) {
		return
	}
	// A coupon or rental run credits every holder's wallet. Running it twice
	// pays everybody twice, so it needs the same protection as DvP.
	tx, proceed := s.beginIdem(w, r)
	if !proceed {
		return
	}
	defer tx.release()

	var body struct {
		AssetID   string  `json:"assetId"`
		Payer     string  `json:"payer"`
		AmountINR float64 `json:"amountINR"`
		// Optional. Omitted means snapshot, which is the original behaviour.
		Basis string `json:"basis"`
		From  string `json:"from"`
		To    string `json:"to"`
	}
	if err := umiDecode(r, &body); err != nil {
		umiErr(w, http.StatusBadRequest, "ERR_BAD_JSON", err.Error())
		return
	}
	parseTS := func(v string) time.Time {
		if t, err := time.Parse(time.RFC3339, v); err == nil {
			return t.UTC()
		}
		return time.Time{}
	}
	res, err := s.UMI.ServicingByBasis(body.AssetID, body.Payer, body.AmountINR,
		body.Basis, parseTS(body.From), parseTS(body.To))
	if err != nil {
		reason := err.Error()
		if i := strings.Index(reason, ":"); i > 0 && strings.HasPrefix(reason, "ERR_") {
			reason = reason[:i]
		}
		tx.finish(w, http.StatusBadRequest, map[string]interface{}{
			"ok": false, "error": reason, "message": err.Error(),
			"mode": UMIMode, "disclaimer": UMIDisclaimer,
		})
		return
	}
	tx.finish(w, http.StatusOK, map[string]interface{}{"ok": true, "servicing": res})
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
	// Seeding issues securities. It is a demo fixture, so it must be possible
	// to switch it off entirely in an environment that holds real positions.
	if os.Getenv("UMI_SEED_DEMO") == "false" {
		umiErr(w, http.StatusNotFound, "ERR_NOT_FOUND", "demo seeding is disabled on this deployment")
		return
	}
	var body struct {
		AssetID          string `json:"assetId"`
		Holder           string `json:"holder"`
		Tokens           int64  `json:"tokens"`
		AuthorisedTokens int64  `json:"authorisedTokens"`
	}
	if err := umiDecode(r, &body); err != nil {
		umiErr(w, http.StatusBadRequest, "ERR_BAD_JSON", err.Error())
		return
	}
	if body.AssetID == "" || body.Holder == "" || body.Tokens <= 0 {
		umiErr(w, http.StatusBadRequest, ErrUMIInvalidAmount.Error(), "assetId, holder and positive tokens required")
		return
	}
	pos, err := s.UMI.SeedPosition(body.AssetID, body.Holder, body.Tokens, body.AuthorisedTokens)
	if err != nil {
		if err.Error() == "ERR_UMI_LEDGER_NOT_SEEDABLE" {
			umiErr(w, http.StatusConflict, "ERR_UMI_LEDGER_NOT_SEEDABLE", "securities leg is backed by a real ledger")
			return
		}
		if errors.Is(err, ErrUMISupplyExceeded) {
			// 409, not 400: the request is well formed, it is the ledger state
			// that forbids it.
			umiErr(w, http.StatusConflict, ErrUMISupplyExceeded.Error(), err.Error())
			return
		}
		umiErr(w, http.StatusBadRequest, err.Error(), "assetId, holder and positive tokens required")
		return
	}
	authorised, outstanding := s.UMI.AuthorisedSupply(body.AssetID)
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"ok": true, "assetId": body.AssetID, "holder": body.Holder,
		"position": pos, "authorisedTokens": authorised, "outstandingTokens": outstanding,
		"mode": UMIMode,
	})
}
