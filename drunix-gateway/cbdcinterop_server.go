package drunix

// HTTP surface for CBDC interoperability (cbdcinterop.go).
//
//	GET  /umi/cbdc/interop                     the instrument matrix and what each pair costs
//	GET  /umi/cbdc/interop/payments            recent cross-instrument payments
//	GET  /umi/cbdc/interop/payments/{p}        one payment
//	POST /umi/cbdc/interop/pay                 pay somebody holding a different instrument
//	POST /umi/cbdc/interop/payments/{p}/settle record that the far scheme settled
//	POST /umi/cbdc/interop/convert             swap a tokenised deposit for central bank money, or back
//	POST /umi/cbdc/interop/deposits            credit a simulated tokenised deposit
//
// The matrix is public: which pairs work, and what each one costs in finality,
// is the question a person needs answered before choosing an instrument.

import (
	"errors"
	"net/http"
	"strings"
	"time"
)

func (s *Server) registerCBDCInteropRoutes(mux *http.ServeMux) {
	if s.CBDCInterop == nil {
		return
	}
	// More specific than the "/umi/cbdc/" pattern, so these win.
	mux.HandleFunc("/umi/cbdc/interop", s.durabilityGate(s.handleInstrumentRoot))
	mux.HandleFunc("/umi/cbdc/interop/", s.durabilityGate(s.handleInstrumentPath))
}

func instrumentStatusFor(err error) (int, string) {
	switch {
	case errors.Is(err, ErrInstrumentNotFound):
		return http.StatusNotFound, "ERR_UMI_INTEROP_NOT_FOUND"
	case errors.Is(err, ErrInstrumentPair):
		return http.StatusConflict, "ERR_UMI_INTEROP_PAIR"
	case errors.Is(err, ErrInstrumentState):
		return http.StatusConflict, "ERR_UMI_INTEROP_STATE"
	case errors.Is(err, ErrInstrumentFields):
		return http.StatusBadRequest, "ERR_UMI_INTEROP_FIELDS"
	default:
		return cbdcStatusFor(err)
	}
}

func (s *Server) instrumentFail(w http.ResponseWriter, err error) {
	code, reason := instrumentStatusFor(err)
	umiErr(w, code, reason, err.Error())
}

func (s *Server) handleInstrumentRoot(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		umiErr(w, http.StatusMethodNotAllowed, "ERR_UMI_METHOD", "GET only.")
		return
	}
	writeJSON(w, http.StatusOK, s.CBDCInterop.Status())
}

func (s *Server) handleInstrumentPath(w http.ResponseWriter, r *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/umi/cbdc/interop/"), "/")
	parts := strings.Split(rest, "/")

	switch {
	case parts[0] == "pay":
		s.instrumentPay(w, r)
	case parts[0] == "convert":
		s.instrumentConvert(w, r)
	case parts[0] == "deposits":
		s.instrumentDeposit(w, r)
	case parts[0] == "payments" && len(parts) == 1:
		if r.Method != http.MethodGet {
			umiErr(w, http.StatusMethodNotAllowed, "ERR_UMI_METHOD", "GET only.")
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"payments":   s.CBDCInterop.Payments(queryLimit(r, 50, 200)),
			"disclaimer": interopDisclaimer,
		})
	case parts[0] == "payments" && len(parts) == 2:
		if r.Method != http.MethodGet {
			umiErr(w, http.StatusMethodNotAllowed, "ERR_UMI_METHOD", "GET only.")
			return
		}
		p, err := s.CBDCInterop.Payment(parts[1])
		if err != nil {
			s.instrumentFail(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"payment": p, "disclaimer": interopDisclaimer})
	case parts[0] == "payments" && len(parts) == 3 && parts[2] == "settle":
		s.instrumentSettle(w, r, parts[1])
	default:
		umiErr(w, http.StatusNotFound, "ERR_UMI_INTEROP_NOT_FOUND", "No such interoperability route.")
	}
}

func (s *Server) instrumentPay(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		umiErr(w, http.StatusMethodNotAllowed, "ERR_UMI_METHOD", "POST only.")
		return
	}
	c := callerOf(r)
	if !umiRequireIdentity(w, c) {
		return
	}
	var body struct {
		Payer          string `json:"payer"`
		Payee          string `json:"payee"`
		FromInstrument string `json:"fromInstrument"`
		ToInstrument   string `json:"toInstrument"`
		AmountPaise    int64  `json:"amountPaise"`
		AcceptedVia    string `json:"acceptedVia"`
	}
	if err := umiDecode(r, &body); err != nil {
		umiErr(w, http.StatusBadRequest, "ERR_UMI_INTEROP_FIELDS", err.Error())
		return
	}
	if strings.TrimSpace(body.Payer) == "" {
		body.Payer = c.ID
	}
	// Spending somebody else's wallet is theirs to authorise.
	if !umiRequireSelfOrSupervisor(w, c, body.Payer, "this wallet") {
		return
	}
	p, err := s.CBDCInterop.Pay(body.Payer, body.Payee, body.FromInstrument, body.ToInstrument,
		body.AmountPaise, body.AcceptedVia, time.Now())
	if err != nil {
		s.instrumentFail(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]interface{}{
		"payment":    p,
		"disclaimer": interopDisclaimer,
	})
}

func (s *Server) instrumentSettle(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPost {
		umiErr(w, http.StatusMethodNotAllowed, "ERR_UMI_METHOD", "POST only.")
		return
	}
	c := callerOf(r)
	if !umiRequireIdentity(w, c) || !umiRequireSupervisor(w, c, "record a scheme settlement") {
		return
	}
	p, err := s.CBDCInterop.RecordSchemeSettlement(id, c.ID, time.Now())
	if err != nil {
		s.instrumentFail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"payment": p,
		"note": "Recorded by " + c.ID + ". Nothing here observed a scheme settling: this is somebody saying " +
			"that it did, and the block says who.",
		"disclaimer": interopDisclaimer,
	})
}

func (s *Server) instrumentConvert(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		umiErr(w, http.StatusMethodNotAllowed, "ERR_UMI_METHOD", "POST only.")
		return
	}
	c := callerOf(r)
	if !umiRequireIdentity(w, c) {
		return
	}
	var body struct {
		Holder      string `json:"holder"`
		Direction   string `json:"direction"`
		AmountPaise int64  `json:"amountPaise"`
	}
	if err := umiDecode(r, &body); err != nil {
		umiErr(w, http.StatusBadRequest, "ERR_UMI_INTEROP_FIELDS", err.Error())
		return
	}
	if strings.TrimSpace(body.Holder) == "" {
		body.Holder = c.ID
	}
	if !umiRequireSelfOrSupervisor(w, c, body.Holder, "this holding") {
		return
	}
	out, err := s.CBDCInterop.Convert(body.Holder, body.Direction, body.AmountPaise, c.ID)
	if err != nil {
		s.instrumentFail(w, err)
		return
	}
	out["conservation"] = s.CBDC.Conservation()
	out["disclaimer"] = interopDisclaimer
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) instrumentDeposit(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		umiErr(w, http.StatusMethodNotAllowed, "ERR_UMI_METHOD", "POST only.")
		return
	}
	c := callerOf(r)
	if !umiRequireIdentity(w, c) || !umiRequireSupervisor(w, c, "credit a tokenised deposit") {
		return
	}
	var body struct {
		Holder      string `json:"holder"`
		AmountPaise int64  `json:"amountPaise"`
	}
	if err := umiDecode(r, &body); err != nil {
		umiErr(w, http.StatusBadRequest, "ERR_UMI_INTEROP_FIELDS", err.Error())
		return
	}
	balance, err := s.CBDCInterop.CreditDeposit(body.Holder, body.AmountPaise, c.ID)
	if err != nil {
		s.instrumentFail(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]interface{}{
		"holder": body.Holder, "depositBalancePaise": balance,
		"note":       "Simulated. No bank was involved and this is not a claim on one.",
		"disclaimer": interopDisclaimer,
	})
}
