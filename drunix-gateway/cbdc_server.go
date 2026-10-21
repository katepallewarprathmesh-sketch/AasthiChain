package drunix

// HTTP surface for the CBDC settlement layer (cbdc.go).
//
//	GET  /umi/cbdc                      policy, finality model, conservation
//	GET  /umi/cbdc/accounts             every account
//	GET  /umi/cbdc/accounts/{holder}    one account
//	GET  /umi/cbdc/movements            recent movements with both finalities
//	POST /umi/cbdc/issue                issue e₹ into an account   (central bank role)
//	POST /umi/cbdc/redeem               destroy e₹ back to the issuer (central bank role)
//	POST /umi/cbdc/transfer             move money between accounts
//	GET  /umi/cbdc/grants               purpose-bound money
//	POST /umi/cbdc/grants               bind money to a purpose
//	POST /umi/cbdc/grants/{id}/spend    spend against the conditions
//	POST /umi/cbdc/offline/issue        reserve value as a signed voucher
//	POST /umi/cbdc/offline/redeem       reconcile an offline payment
//	GET  /umi/cbdc/conditions           money locked against events
//	POST /umi/cbdc/conditions           lock money against an event
//	POST /umi/cbdc/events               attest an event and release what it satisfies
//
// Reads are public. Issuance and redemption are the central bank's own acts
// and are restricted to the regulator role; everything else acts on the
// caller's own money.

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
)

func (s *Server) registerCBDCRoutes(mux *http.ServeMux) {
	if s.CBDC == nil {
		return
	}
	mux.HandleFunc("/umi/cbdc", s.durabilityGate(s.handleCBDCRoot))
	mux.HandleFunc("/umi/cbdc/", s.durabilityGate(s.handleCBDCPath))
}

func cbdcStatusFor(err error) (int, string) {
	switch {
	case errors.Is(err, ErrCBDCNotFound):
		return http.StatusNotFound, "ERR_UMI_CBDC_NOT_FOUND"
	case errors.Is(err, ErrCBDCFunds):
		return http.StatusConflict, "ERR_UMI_CBDC_INSUFFICIENT"
	case errors.Is(err, ErrCBDCKYCCap):
		return http.StatusConflict, "ERR_UMI_CBDC_KYC_CAP"
	case errors.Is(err, ErrCBDCCondition):
		return http.StatusConflict, "ERR_UMI_CBDC_CONDITION"
	case errors.Is(err, ErrCBDCExpired):
		return http.StatusConflict, "ERR_UMI_CBDC_EXPIRED"
	case errors.Is(err, ErrCBDCDoubleSpend):
		return http.StatusConflict, "ERR_UMI_CBDC_DOUBLE_SPEND"
	case errors.Is(err, ErrCBDCOfflineCap):
		return http.StatusConflict, "ERR_UMI_CBDC_OFFLINE_CAP"
	case errors.Is(err, ErrCBDCBlocked):
		return http.StatusConflict, "ERR_UMI_CBDC_AML_BLOCKED"
	case errors.Is(err, ErrCBDCClosed):
		return http.StatusConflict, "ERR_UMI_CBDC_CLOSED"
	default:
		return http.StatusBadRequest, "ERR_UMI_CBDC_FIELDS"
	}
}

func (s *Server) cbdcFail(w http.ResponseWriter, err error) {
	code, reason := cbdcStatusFor(err)
	umiErr(w, code, reason, err.Error())
}

// cbdcIssuer: issuance and redemption are the central bank's acts.
func cbdcIssuer(c umiCaller) bool {
	return c.supervisor() || strings.EqualFold(c.Role, "Regulator")
}

func (s *Server) handleCBDCRoot(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		umiErr(w, http.StatusMethodNotAllowed, "ERR_UMI_METHOD", "GET only.")
		return
	}
	// Returning locked money whose deadline has passed is cheap and must not
	// depend on anybody remembering to run a sweep.
	s.CBDC.SweepConditions(time.Now().UTC())
	writeJSON(w, http.StatusOK, s.CBDC.Status())
}

func (s *Server) handleCBDCPath(w http.ResponseWriter, r *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/umi/cbdc/"), "/")
	parts := strings.Split(rest, "/")
	switch {
	case parts[0] == "accounts":
		s.cbdcAccounts(w, r, parts)
	case parts[0] == "movements":
		s.cbdcMovements(w, r)
	case parts[0] == "issue":
		s.cbdcIssue(w, r)
	case parts[0] == "redeem":
		s.cbdcRedeem(w, r)
	case parts[0] == "transfer":
		s.cbdcTransfer(w, r)
	case parts[0] == "grants":
		s.cbdcGrants(w, r, parts)
	case parts[0] == "offline" && len(parts) > 1:
		s.cbdcOffline(w, r, parts[1])
	case parts[0] == "conditions":
		s.cbdcConditions(w, r)
	case parts[0] == "events":
		s.cbdcEvents(w, r)
	default:
		umiErr(w, http.StatusNotFound, "ERR_UMI_CBDC_NOT_FOUND", "No such CBDC route.")
	}
}

func (s *Server) cbdcAccounts(w http.ResponseWriter, r *http.Request, parts []string) {
	if r.Method != http.MethodGet {
		umiErr(w, http.StatusMethodNotAllowed, "ERR_UMI_METHOD", "GET only.")
		return
	}
	if len(parts) > 1 && parts[1] != "" {
		acct, ok := s.CBDC.Wallet(parts[1])
		if !ok {
			umiErr(w, http.StatusNotFound, "ERR_UMI_CBDC_NOT_FOUND", "No account for "+parts[1]+".")
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"account": acct, "availablePaise": acct.Available(), "disclaimer": CBDCDisclaimer,
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"accounts": s.CBDC.Wallets(), "conservation": s.CBDC.Conservation(), "disclaimer": CBDCDisclaimer,
	})
}

func (s *Server) cbdcMovements(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		umiErr(w, http.StatusMethodNotAllowed, "ERR_UMI_METHOD", "GET only.")
		return
	}
	limit := 25
	if v := strings.TrimSpace(r.URL.Query().Get("limit")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 200 {
			limit = n
		}
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"movements": s.CBDC.Movements(limit), "disclaimer": CBDCDisclaimer,
	})
}

func (s *Server) cbdcIssue(w http.ResponseWriter, r *http.Request) {
	c := callerOf(r)
	if !umiRequireIdentity(w, c) {
		return
	}
	if !cbdcIssuer(c) {
		umiErr(w, http.StatusForbidden, "ERR_UMI_CBDC_FORBIDDEN",
			"Creating central bank money is the central bank's act. The regulator role issues; everybody else moves what exists.")
		return
	}
	var body struct {
		Holder      string `json:"holder"`
		Segment     string `json:"segment"`
		KYCTier     string `json:"kycTier"`
		AmountPaise int64  `json:"amountPaise"`
		BankFunded  bool   `json:"fundedByBankRail"`
	}
	if err := umiDecode(r, &body); err != nil {
		umiErr(w, http.StatusBadRequest, "ERR_UMI_CBDC_FIELDS", err.Error())
		return
	}
	acct, mv, err := s.CBDC.Issue(body.Holder, body.Segment, body.KYCTier, body.AmountPaise, body.BankFunded, c.ID)
	if err != nil {
		s.cbdcFail(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]interface{}{
		"account": acct, "movement": mv, "disclaimer": CBDCDisclaimer,
	})
}

func (s *Server) cbdcRedeem(w http.ResponseWriter, r *http.Request) {
	c := callerOf(r)
	if !umiRequireIdentity(w, c) {
		return
	}
	if !cbdcIssuer(c) {
		umiErr(w, http.StatusForbidden, "ERR_UMI_CBDC_FORBIDDEN", "Destroying central bank money is the issuer's act.")
		return
	}
	var body struct {
		Holder      string `json:"holder"`
		AmountPaise int64  `json:"amountPaise"`
	}
	if err := umiDecode(r, &body); err != nil {
		umiErr(w, http.StatusBadRequest, "ERR_UMI_CBDC_FIELDS", err.Error())
		return
	}
	acct, mv, err := s.CBDC.Redeem(body.Holder, body.AmountPaise, c.ID)
	if err != nil {
		s.cbdcFail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"account": acct, "movement": mv, "disclaimer": CBDCDisclaimer})
}

func (s *Server) cbdcTransfer(w http.ResponseWriter, r *http.Request) {
	c := callerOf(r)
	if !umiRequireIdentity(w, c) {
		return
	}
	var body struct {
		From        string `json:"from"`
		To          string `json:"to"`
		AmountPaise int64  `json:"amountPaise"`
	}
	if err := umiDecode(r, &body); err != nil {
		umiErr(w, http.StatusBadRequest, "ERR_UMI_CBDC_FIELDS", err.Error())
		return
	}
	if body.From == "" {
		body.From = c.ID
	}
	if !umiRequireSelfOrSupervisor(w, c, body.From, "move money out of an account") {
		return
	}
	mv, err := s.CBDC.Transfer(body.From, body.To, body.AmountPaise)
	if err != nil {
		s.cbdcFail(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]interface{}{"movement": mv, "disclaimer": CBDCDisclaimer})
}

func (s *Server) cbdcGrants(w http.ResponseWriter, r *http.Request, parts []string) {
	// /umi/cbdc/grants/{id}/spend
	if len(parts) >= 3 && parts[2] == "spend" {
		if r.Method != http.MethodPost {
			umiErr(w, http.StatusMethodNotAllowed, "ERR_UMI_METHOD", "POST only.")
			return
		}
		c := callerOf(r)
		if !umiRequireIdentity(w, c) {
			return
		}
		var ctx SpendContext
		if err := umiDecode(r, &ctx); err != nil {
			umiErr(w, http.StatusBadRequest, "ERR_UMI_CBDC_FIELDS", err.Error())
			return
		}
		g, mv, err := s.CBDC.Spend(parts[1], ctx, time.Now().UTC())
		if err != nil {
			s.cbdcFail(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, map[string]interface{}{
			"grant": g, "movement": mv, "disclaimer": CBDCDisclaimer,
		})
		return
	}

	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, map[string]interface{}{"grants": s.CBDC.Grants(), "disclaimer": CBDCDisclaimer})
	case http.MethodPost:
		c := callerOf(r)
		if !umiRequireIdentity(w, c) {
			return
		}
		var body struct {
			Sponsor     string           `json:"sponsor"`
			Beneficiary string           `json:"beneficiary"`
			AmountPaise int64            `json:"amountPaise"`
			Condition   ProgramCondition `json:"condition"`
		}
		if err := umiDecode(r, &body); err != nil {
			umiErr(w, http.StatusBadRequest, "ERR_UMI_CBDC_FIELDS", err.Error())
			return
		}
		if body.Sponsor == "" {
			body.Sponsor = c.ID
		}
		if !umiRequireSelfOrSupervisor(w, c, body.Sponsor, "bind money to a purpose") {
			return
		}
		g, err := s.CBDC.Grant(body.Sponsor, body.Beneficiary, body.AmountPaise, body.Condition)
		if err != nil {
			s.cbdcFail(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, map[string]interface{}{"grant": g, "disclaimer": CBDCDisclaimer})
	default:
		umiErr(w, http.StatusMethodNotAllowed, "ERR_UMI_METHOD", "GET or POST.")
	}
}

func (s *Server) cbdcOffline(w http.ResponseWriter, r *http.Request, action string) {
	if r.Method != http.MethodPost {
		umiErr(w, http.StatusMethodNotAllowed, "ERR_UMI_METHOD", "POST only.")
		return
	}
	c := callerOf(r)
	if !umiRequireIdentity(w, c) {
		return
	}
	switch action {
	case "issue":
		var body struct {
			Holder      string `json:"holder"`
			Device      string `json:"device"`
			AmountPaise int64  `json:"amountPaise"`
		}
		if err := umiDecode(r, &body); err != nil {
			umiErr(w, http.StatusBadRequest, "ERR_UMI_CBDC_FIELDS", err.Error())
			return
		}
		if body.Holder == "" {
			body.Holder = c.ID
		}
		if !umiRequireSelfOrSupervisor(w, c, body.Holder, "reserve value for offline use") {
			return
		}
		v, err := s.CBDC.IssueOffline(body.Holder, body.Device, body.AmountPaise, time.Now().UTC())
		if err != nil {
			s.cbdcFail(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, map[string]interface{}{
			"voucher": v, "disclaimer": CBDCDisclaimer,
			"note": "The online balance is already reduced. Carry this to a device with no connectivity; " +
				"present it here when either side is back online.",
		})
	case "redeem":
		var body struct {
			Voucher OfflineVoucher `json:"voucher"`
			Payee   string         `json:"payee"`
		}
		if err := umiDecode(r, &body); err != nil {
			umiErr(w, http.StatusBadRequest, "ERR_UMI_CBDC_FIELDS", err.Error())
			return
		}
		if body.Payee == "" {
			body.Payee = c.ID
		}
		mv, err := s.CBDC.RedeemOffline(body.Voucher, body.Payee, time.Now().UTC())
		if err != nil {
			s.cbdcFail(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, map[string]interface{}{"movement": mv, "disclaimer": CBDCDisclaimer})
	default:
		umiErr(w, http.StatusNotFound, "ERR_UMI_CBDC_NOT_FOUND", "Use /offline/issue or /offline/redeem.")
	}
}

func (s *Server) cbdcConditions(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.CBDC.SweepConditions(time.Now().UTC())
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"conditions": s.CBDC.Conditions(), "disclaimer": CBDCDisclaimer,
		})
	case http.MethodPost:
		c := callerOf(r)
		if !umiRequireIdentity(w, c) {
			return
		}
		var body struct {
			Payer         string `json:"payer"`
			Payee         string `json:"payee"`
			AmountPaise   int64  `json:"amountPaise"`
			EventType     string `json:"eventType"`
			EventKey      string `json:"eventKey"`
			Attestor      string `json:"attestor"`
			DeadlineHours int    `json:"deadlineHours"`
		}
		if err := umiDecode(r, &body); err != nil {
			umiErr(w, http.StatusBadRequest, "ERR_UMI_CBDC_FIELDS", err.Error())
			return
		}
		if body.Payer == "" {
			body.Payer = c.ID
		}
		if !umiRequireSelfOrSupervisor(w, c, body.Payer, "lock money against an event") {
			return
		}
		if body.DeadlineHours <= 0 {
			body.DeadlineHours = 24
		}
		cond, err := s.CBDC.OpenCondition(body.Payer, body.Payee, body.AmountPaise,
			body.EventType, body.EventKey, body.Attestor,
			time.Now().UTC().Add(time.Duration(body.DeadlineHours)*time.Hour))
		if err != nil {
			s.cbdcFail(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, map[string]interface{}{"condition": cond, "disclaimer": CBDCDisclaimer})
	default:
		umiErr(w, http.StatusMethodNotAllowed, "ERR_UMI_METHOD", "GET or POST.")
	}
}

func (s *Server) cbdcEvents(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		umiErr(w, http.StatusMethodNotAllowed, "ERR_UMI_METHOD", "POST only.")
		return
	}
	c := callerOf(r)
	if !umiRequireIdentity(w, c) {
		return
	}
	var body struct {
		EventType string `json:"eventType"`
		EventKey  string `json:"eventKey"`
	}
	if err := umiDecode(r, &body); err != nil {
		umiErr(w, http.StatusBadRequest, "ERR_UMI_CBDC_FIELDS", err.Error())
		return
	}
	released, err := s.CBDC.SubmitEvent(c.ID, body.EventType, body.EventKey, time.Now().UTC())
	if err != nil {
		s.cbdcFail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"attestor": c.ID, "eventType": body.EventType, "eventKey": body.EventKey,
		"released": released, "count": len(released), "disclaimer": CBDCDisclaimer,
		"note": "Only conditions that named this caller as their attestor were released. The rest were " +
			"left alone and the mismatch was recorded.",
	})
}
