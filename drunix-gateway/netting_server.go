package drunix

// HTTP surface for multilateral netting (netting.go).
//
//	POST /umi/netting/preview   {"legs":[...]}  calculate only, moves nothing
//	POST /umi/netting/settle    {"legs":[...]}  apply the batch, all or nothing
//
// WHO MAY CALL THIS
// Settling a batch moves other people's money, so it is a clearing action and
// supervisors only. A preview does not move anything, but it does report
// every participant's available balance, which is somebody else's business.
// So a non-supervisor may preview a batch only when they are a party to it,
// and even then the other participants' balances are withheld. Requiring a
// party to every leg would be useless: the whole value of multilateral
// netting is that the batch contains legs between other people.
// Netting is a shared calculation; it is not a licence to read the book.

import (
	"errors"
	"net/http"
)

func (s *Server) registerNettingRoutes(mux *http.ServeMux) {
	if s.UMI == nil {
		return
	}
	mux.HandleFunc("/umi/netting/preview", s.durabilityGate(s.handleNettingPreview))
	mux.HandleFunc("/umi/netting/settle", s.durabilityGate(s.handleNettingSettle))
}

type nettingRequest struct {
	Legs []NettingLeg `json:"legs"`
}

func nettingStatusFor(err error) (int, string) {
	switch {
	case errors.Is(err, ErrNettingEmptyBatch), errors.Is(err, ErrNettingInvalidLeg):
		return http.StatusBadRequest, ""
	case errors.Is(err, ErrNettingShortCash), errors.Is(err, ErrNettingShortTokens):
		return http.StatusConflict, ""
	default:
		return http.StatusBadRequest, ""
	}
}

// partyToBatch reports whether the caller appears on at least one leg. A
// caller on no leg has no business asking what this group owes each other.
func partyToBatch(identity string, legs []NettingLeg) bool {
	if identity == "" {
		return false
	}
	for _, l := range legs {
		if l.Seller == identity || l.Buyer == identity {
			return true
		}
	}
	return false
}

// redactForeignBalances blanks the availability of participants other than
// the caller. The net obligation stays visible, because a counterparty needs
// to know what they are relying on; the wallet behind it does not.
func redactForeignBalances(b *NettingBatch, identity string) {
	for i := range b.CashPositions {
		if b.CashPositions[i].Participant != identity {
			b.CashPositions[i].AvailableINR = 0
			b.CashPositions[i].ShortfallINR = 0
		}
	}
}

func (s *Server) handleNettingPreview(w http.ResponseWriter, r *http.Request) {
	if !requirePost(w, r) {
		return
	}
	var req nettingRequest
	if err := umiDecode(r, &req); err != nil {
		umiErr(w, http.StatusBadRequest, "ERR_UMI_NETTING_FIELDS", "invalid JSON: "+err.Error())
		return
	}
	caller := callerOf(r)
	if !umiRequireIdentity(w, caller) {
		return
	}
	supervisor := caller.supervisor()
	if !supervisor && !partyToBatch(caller.ID, req.Legs) {
		umiErr(w, http.StatusForbidden, "ERR_UMI_NETTING_NOT_A_PARTY",
			"A netting preview reports every participant's position. Preview a batch you are a party to, "+
				"or ask a supervisor.")
		return
	}
	b, err := s.UMI.Net(req.Legs)
	if !supervisor && b != nil {
		redactForeignBalances(b, caller.ID)
	}
	if err != nil {
		code, _ := nettingStatusFor(err)
		writeJSON(w, code, b)
		return
	}
	writeJSON(w, http.StatusOK, b)
}

func (s *Server) handleNettingSettle(w http.ResponseWriter, r *http.Request) {
	if !requirePost(w, r) {
		return
	}
	var req nettingRequest
	if err := umiDecode(r, &req); err != nil {
		umiErr(w, http.StatusBadRequest, "ERR_UMI_NETTING_FIELDS", "invalid JSON: "+err.Error())
		return
	}
	caller := callerOf(r)
	if !umiRequireIdentity(w, caller) {
		return
	}
	if !caller.supervisor() {
		umiErr(w, http.StatusForbidden, "ERR_NOT_SUPERVISORY",
			"Settling a netting batch moves several participants' money in one step. That is a clearing "+
				"action, so it is supervisory. Use POST /umi/netting/preview to see the calculation.")
		return
	}
	b, err := s.UMI.SettleNet(req.Legs)
	if err != nil {
		code, _ := nettingStatusFor(err)
		writeJSON(w, code, b)
		return
	}
	writeJSON(w, http.StatusOK, b)
}
