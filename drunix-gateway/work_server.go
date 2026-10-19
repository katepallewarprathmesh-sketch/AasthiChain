package drunix

// HTTP transport for the work desk (SRP: routing and authorisation only, all
// state logic in work.go).
//
// Authorisation lives here rather than in the node layer for the same reason
// the rail's does: the node layer is a pure proxy and holds no work state, so
// the only place that can safely decide who may release an escrow is the
// process that owns the escrow.

import (
	"errors"
	"net/http"
	"strings"
)

var workEndpointList = []string{
	"GET  /umi/work                          orders visible to the caller (?assetId= to filter)",
	"GET  /umi/work/provider                 talent adapter mode + roster (?category=)",
	"GET  /umi/work/{orderId}                one order with its full event trail",
	"POST /umi/work                          {\"assetId\":\"...\",\"title\":\"...\",\"spec\":\"...\",\"category\":\"INSPECTION\",\"feeINR\":9000,\"funder\":\"...\",\"acceptanceCriteria\":[\"...\"]}",
	"POST /umi/work/{id}/fund                reserve the fee on the funder's e₹-W wallet",
	"POST /umi/work/{id}/assign              {\"worker\":\"...\",\"providerRef\":\"...\"}",
	"POST /umi/work/{id}/submit              {\"deliverableHash\":\"<64 hex>\",\"deliverableUri\":\"...\",\"note\":\"...\"}",
	"POST /umi/work/{id}/accept              {\"note\":\"...\"}  releases escrow to the worker",
	"POST /umi/work/{id}/dispute             {\"reason\":\"...\"}  freezes the escrow",
	"POST /umi/work/{id}/refund              {\"reason\":\"...\"}  returns escrow to the funder",
	"POST /umi/work/{id}/cancel              {\"reason\":\"...\"}",
	"POST /umi/work/{id}/check               {\"check\":\"...\",\"passed\":true,\"evidence\":\"...\"}  verifier only",
	"POST /umi/work/{id}/finalise            releases a verified order once its dispute window has closed",
}

// registerWorkRoutes mounts the desk. If Server.Work is nil the routes are
// simply absent and everything else behaves exactly as before.
func (s *Server) registerWorkRoutes(mux *http.ServeMux) {
	if s.Work == nil {
		return
	}
	mux.HandleFunc("/umi/work", s.durabilityGate(s.handleWorkCollection))
	mux.HandleFunc("/umi/work/", s.durabilityGate(s.handleWorkItem))
}

// workErrStatus maps a refusal to the status code that tells the truth about
// it. A bad state transition is the caller's mistake (409), a missing order is
// 404, short escrow is 422 — not all of them are 400.
func workErrStatus(err error) (int, string) {
	switch {
	case errors.Is(err, ErrWorkNotFound):
		return http.StatusNotFound, "ERR_WORK_NOT_FOUND"
	case errors.Is(err, ErrWorkBadState):
		return http.StatusConflict, "ERR_WORK_BAD_STATE"
	case errors.Is(err, ErrUMIInsufficientCBDC):
		return http.StatusUnprocessableEntity, "ERR_UMI_INSUFFICIENT_CBDC"
	case errors.Is(err, ErrWorkSelfDeal):
		return http.StatusConflict, "ERR_WORK_SELF_DEAL"
	case errors.Is(err, ErrWorkBadHash):
		return http.StatusBadRequest, "ERR_WORK_BAD_HASH"
	case errors.Is(err, ErrWorkBadCategory):
		return http.StatusBadRequest, "ERR_WORK_BAD_CATEGORY"
	case errors.Is(err, ErrWorkInvalidAmount):
		return http.StatusBadRequest, "ERR_WORK_INVALID_AMOUNT"
	case errors.Is(err, ErrWorkMissingField):
		return http.StatusBadRequest, "ERR_WORK_MISSING_FIELD"
	case errors.Is(err, ErrWorkNotVerifier):
		return http.StatusForbidden, "ERR_WORK_NOT_VERIFIER"
	case errors.Is(err, ErrWorkWindowOpen):
		return http.StatusConflict, "ERR_WORK_WINDOW_OPEN"
	case errors.Is(err, ErrWorkNoEscrow):
		return http.StatusServiceUnavailable, "ERR_WORK_NO_ESCROW"
	default:
		return http.StatusBadRequest, "ERR_WORK_REFUSED"
	}
}

func writeWorkErr(w http.ResponseWriter, err error) {
	code, reason := workErrStatus(err)
	umiErr(w, code, reason, err.Error())
}

func writeOrder(w http.ResponseWriter, code int, o *WorkOrder) {
	writeJSON(w, code, map[string]interface{}{
		"order":      o,
		"mode":       UMIMode,
		"disclaimer": UMIDisclaimer,
	})
}

// GET /umi/work · POST /umi/work
func (s *Server) handleWorkCollection(w http.ResponseWriter, r *http.Request) {
	c := callerOf(r)
	switch r.Method {
	case http.MethodGet:
		if !umiRequireIdentity(w, c) {
			return
		}
		all := s.Work.Orders(strings.TrimSpace(r.URL.Query().Get("assetId")))
		// A work order names what a property needs doing and what it costs.
		// That is commercially sensitive to the two parties, so the desk is
		// scoped: your own as funder or worker, everything if you supervise.
		visible := all
		if !c.supervisor() {
			visible = make([]WorkOrder, 0, len(all))
			for i := range all {
				if all[i].party(c.ID) {
					visible = append(visible, all[i])
				}
			}
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"orders":     visible,
			"summary":    s.Work.Summary(),
			"scope":      scopeLabel(c),
			"endpoints":  workEndpointList,
			"outcome":    s.Work.OutcomeSummary(),
			"mode":       UMIMode,
			"disclaimer": UMIDisclaimer,
		})

	case http.MethodPost:
		var body WorkRequest
		if err := umiDecode(r, &body); err != nil {
			umiErr(w, http.StatusBadRequest, "ERR_BAD_JSON", err.Error())
			return
		}
		if strings.TrimSpace(body.Funder) == "" {
			body.Funder = c.ID
		}
		// Opening an order that spends someone else's wallet is the whole
		// attack. The funder must be you, unless you supervise the rail.
		if !umiRequireSelfOrSupervisor(w, c, body.Funder, "The wallet funding this work order") {
			return
		}
		o, err := s.Work.Create(body, c.ID)
		if err != nil {
			writeWorkErr(w, err)
			return
		}
		// Publishing is best-effort: a provider outage must not cost the user
		// the order they just defined. It can always be assigned by hand.
		if ref, perr := s.Work.Provider().Publish(o); perr == nil && ref != "" {
			o.ProviderRef = ref
		}
		writeOrder(w, http.StatusCreated, o)

	default:
		umiErr(w, http.StatusMethodNotAllowed, "ERR_METHOD", "GET or POST")
	}
}

func scopeLabel(c umiCaller) string {
	if c.supervisor() {
		return "supervisor — the whole desk"
	}
	return "participant — orders you fund or deliver"
}

// /umi/work/{id} and /umi/work/{id}/{action}, plus /umi/work/provider
func (s *Server) handleWorkItem(w http.ResponseWriter, r *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/umi/work/"), "/")
	if rest == "" {
		s.handleWorkCollection(w, r)
		return
	}
	parts := strings.Split(rest, "/")

	if parts[0] == "provider" {
		// Deliberately readable by any identified caller: knowing whether the
		// partner link is live or simulated is exactly the thing nobody
		// should have to guess.
		info := s.Work.Provider().Describe()
		info["roster"] = s.Work.Provider().Roster(r.URL.Query().Get("category"))
		info["endpoints"] = workEndpointList
		writeJSON(w, http.StatusOK, info)
		return
	}

	orderID := parts[0]
	action := ""
	if len(parts) > 1 {
		action = strings.ToLower(parts[1])
	}

	c := callerOf(r)
	if !umiRequireIdentity(w, c) {
		return
	}
	existing, ok := s.Work.Order(orderID)
	if !ok {
		umiErr(w, http.StatusNotFound, "ERR_WORK_NOT_FOUND", "No work order "+orderID+".")
		return
	}

	if action == "" {
		if r.Method != http.MethodGet {
			umiErr(w, http.StatusMethodNotAllowed, "ERR_METHOD", "GET")
			return
		}
		if !existing.party(c.ID) && !c.supervisor() {
			umiErr(w, http.StatusForbidden, "ERR_WORK_NOT_YOURS",
				"This order is between "+existing.Funder+" and its worker.")
			return
		}
		writeOrder(w, http.StatusOK, existing)
		return
	}

	if !requirePost(w, r) {
		return
	}

	var body struct {
		Worker          string `json:"worker"`
		ProviderRef     string `json:"providerRef"`
		DeliverableHash string `json:"deliverableHash"`
		DeliverableURI  string `json:"deliverableUri"`
		Note            string `json:"note"`
		Reason          string `json:"reason"`

		// Verification (outcome.go)
		Check    string `json:"check"`
		Passed   bool   `json:"passed"`
		Evidence string `json:"evidence"`
		Detail   string `json:"detail"`
	}
	if err := umiDecode(r, &body); err != nil {
		umiErr(w, http.StatusBadRequest, "ERR_BAD_JSON", err.Error())
		return
	}

	var (
		out *WorkOrder
		err error
	)
	switch action {

	// The funder's side of the contract: they put the money up, they choose
	// who does the work, and they say whether it was done.
	case "fund", "assign", "accept", "dispute", "refund", "cancel":
		if !workRequireFunder(w, c, existing, action) {
			return
		}
		switch action {
		case "fund":
			out, err = s.Work.Fund(orderID, c.ID)
		case "assign":
			out, err = s.Work.Assign(orderID, body.Worker, body.ProviderRef, c.ID)
		case "accept":
			out, err = s.Work.Accept(orderID, body.Note, c.ID)
		case "dispute":
			out, err = s.Work.Dispute(orderID, body.Reason, c.ID)
		case "refund":
			out, err = s.Work.Refund(orderID, body.Reason, c.ID)
		case "cancel":
			out, err = s.Work.Cancel(orderID, body.Reason, c.ID)
		}

	// The worker's side: only the person who was assigned may claim the work
	// is done. Letting the funder submit on their behalf would make the
	// deliverable hash worthless as evidence.
	case "submit":
		if !workRequireWorker(w, c, existing) {
			return
		}
		// A software agent may deliver under a mandate that names the
		// action. The bound is checked before the deliverable is recorded,
		// so an agent outside its authority never gets into the evidence.
		if _, ok := s.agentMandateFor(w, r, ActionDeliverWork, existing.AssetID, 0); !ok {
			return
		}
		out, err = s.Work.Submit(orderID, body.DeliverableHash, body.DeliverableURI, body.Note, c.ID)

	// The verifier's side: the whole reason outcome terms are worth
	// anything. Neither party records its own checks.
	case "check":
		out, err = s.Work.RecordCheck(orderID, CheckRequest{
			Name: body.Check, Passed: body.Passed, Evidence: body.Evidence, Detail: body.Detail,
		}, c.ID, c.supervisor())

	// Releasing a verified order: the funder may waive the rest of the
	// window, and once it has closed anyone may trigger it, which is what
	// stops silence being a free delay.
	case "finalise", "finalize":
		out, err = s.Work.Finalise(orderID, c.ID, c.supervisor())

	default:
		umiErr(w, http.StatusNotFound, "ERR_WORK_NO_ACTION", "No action "+action+" on a work order.")
		return
	}

	if err != nil {
		writeWorkErr(w, err)
		return
	}
	writeOrder(w, http.StatusOK, out)
}

// workRequireFunder guards the money side of the order.
func workRequireFunder(w http.ResponseWriter, c umiCaller, o *WorkOrder, action string) bool {
	if c.supervisor() || strings.EqualFold(o.Funder, c.ID) {
		return true
	}
	// A worker who could accept their own work could pay themselves out of a
	// stranger's wallet, which is the one thing escrow exists to prevent.
	umiErr(w, http.StatusForbidden, "ERR_WORK_NOT_YOURS",
		"Only "+o.Funder+", who is paying for this work, can "+action+" it.")
	return false
}

// workRequireWorker guards delivery.
func workRequireWorker(w http.ResponseWriter, c umiCaller, o *WorkOrder) bool {
	if c.supervisor() {
		return true
	}
	if o.Worker == "" {
		umiErr(w, http.StatusConflict, "ERR_WORK_BAD_STATE", "Nobody is assigned to this order yet.")
		return false
	}
	if strings.EqualFold(o.Worker, c.ID) {
		return true
	}
	umiErr(w, http.StatusForbidden, "ERR_WORK_NOT_YOURS",
		"Only "+o.Worker+", who was assigned this work, can submit the deliverable.")
	return false
}
