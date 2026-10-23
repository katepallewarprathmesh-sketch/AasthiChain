package drunix

// HTTP surface for the card rail economics and dispute ladder (cardscheme.go).
//
//	GET  /umi/cards                      presented payments and their disputes
//	GET  /umi/cards/posture              every rate, deadline and reason code, published up front
//	POST /umi/cards/price                what a payment would cost and who takes what
//	POST /umi/cards                      present an authorised payment
//	GET  /umi/cards/{id}                 one payment with its full history
//	POST /umi/cards/{id}/chargeback      the issuer files a dispute
//	POST /umi/cards/{id}/represent       the merchant answers
//	POST /umi/cards/{id}/prearbitrate    the issuer comes back
//	POST /umi/cards/{id}/arbitrate       the network rules, the loser pays the fee
//
// Pricing and posture are public. A merchant who cannot see the fee schedule
// before accepting a card is in no position to price anything.

import (
	"errors"
	"net/http"
	"strings"
	"time"
)

func (s *Server) registerCardRoutes(mux *http.ServeMux) {
	if s.Cards == nil {
		return
	}
	mux.HandleFunc("/umi/cards", s.durabilityGate(s.handleCardCollection))
	mux.HandleFunc("/umi/cards/", s.durabilityGate(s.handleCardItem))
}

func cardStatusFor(err error) (int, string) {
	switch {
	case errors.Is(err, ErrCardNotFound):
		return http.StatusNotFound, "ERR_UMI_CARD_NOT_FOUND"
	case errors.Is(err, ErrCardFields):
		return http.StatusBadRequest, "ERR_UMI_CARD_FIELDS"
	case errors.Is(err, ErrCardReasonCode):
		return http.StatusBadRequest, "ERR_UMI_CARD_REASON_CODE"
	case errors.Is(err, ErrCardState):
		return http.StatusConflict, "ERR_UMI_CARD_STATE"
	case errors.Is(err, ErrCardWindow):
		return http.StatusConflict, "ERR_UMI_CARD_WINDOW_CLOSED"
	case errors.Is(err, ErrCardLiability):
		return http.StatusConflict, "ERR_UMI_CARD_LIABILITY_SHIFTED"
	case errors.Is(err, ErrCardZeroMDR):
		return http.StatusConflict, "ERR_UMI_CARD_ZERO_MDR"
	default:
		return http.StatusBadRequest, "ERR_UMI_CARD"
	}
}

type cardPresentRequest struct {
	Merchant      string `json:"merchant"`
	Network       string `json:"network"`
	AmountPaise   int64  `json:"amountPaise"`
	Instrument    string `json:"instrument"`
	Channel       string `json:"channel"`
	SmallMerchant bool   `json:"smallMerchant"`
	Authenticated bool   `json:"threeDSAuthenticated"`
}

func (s *Server) handleCardCollection(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"payments": s.Cards.Payments(),
			"disclaimer": "Modelled, not connected. This deployment holds no scheme membership, so nothing here " +
				"is authorised or cleared with a network and no money moves.",
		})

	case http.MethodPost:
		c := callerOf(r)
		if !umiRequireIdentity(w, c) {
			return
		}
		var body cardPresentRequest
		if err := umiDecode(r, &body); err != nil {
			umiErr(w, http.StatusBadRequest, "ERR_BAD_JSON", err.Error())
			return
		}
		merchant := strings.TrimSpace(body.Merchant)
		if merchant == "" {
			merchant = c.ID
		}
		p, err := s.Cards.Present(merchant, body.Network, CardQuote{
			AmountPaise: body.AmountPaise, Instrument: body.Instrument,
			Channel: body.Channel, SmallMerchant: body.SmallMerchant,
		}, body.Authenticated, time.Now().UTC())
		if err != nil {
			code, sentinel := cardStatusFor(err)
			umiErr(w, code, sentinel, err.Error())
			return
		}
		writeJSON(w, http.StatusCreated, p)

	default:
		umiErr(w, http.StatusMethodNotAllowed, "ERR_METHOD", "GET lists payments, POST presents one.")
	}
}

func (s *Server) handleCardItem(w http.ResponseWriter, r *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/umi/cards/"), "/")

	// Collection-level endpoints that sit under the same prefix.
	switch strings.ToLower(rest) {
	case "posture":
		if r.Method != http.MethodGet {
			umiErr(w, http.StatusMethodNotAllowed, "ERR_METHOD", "GET reads the posture.")
			return
		}
		writeJSON(w, http.StatusOK, s.Cards.Posture())
		return
	case "price":
		if r.Method != http.MethodPost {
			umiErr(w, http.StatusMethodNotAllowed, "ERR_METHOD", "POST an amount and an instrument to price it.")
			return
		}
		var q CardQuote
		if err := umiDecode(r, &q); err != nil {
			umiErr(w, http.StatusBadRequest, "ERR_BAD_JSON", err.Error())
			return
		}
		split, err := s.Cards.Price(q)
		if err != nil {
			code, sentinel := cardStatusFor(err)
			umiErr(w, code, sentinel, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, split)
		return
	}

	parts := strings.Split(rest, "/")
	id := parts[0]
	if id == "" {
		umiErr(w, http.StatusNotFound, "ERR_UMI_CARD_NOT_FOUND", "Name a payment.")
		return
	}

	if len(parts) == 1 {
		if r.Method != http.MethodGet {
			umiErr(w, http.StatusMethodNotAllowed, "ERR_METHOD", "GET reads one payment.")
			return
		}
		p, ok := s.Cards.Payment(id)
		if !ok {
			umiErr(w, http.StatusNotFound, "ERR_UMI_CARD_NOT_FOUND", "No payment called "+id+".")
			return
		}
		writeJSON(w, http.StatusOK, p)
		return
	}

	if r.Method != http.MethodPost {
		umiErr(w, http.StatusMethodNotAllowed, "ERR_METHOD", "POST moves a dispute along.")
		return
	}
	c := callerOf(r)
	if !umiRequireIdentity(w, c) {
		return
	}
	var body struct {
		ReasonCode   string `json:"reasonCode"`
		Evidence     string `json:"evidence"`
		Detail       string `json:"detail"`
		MerchantWins bool   `json:"merchantWins"`
	}
	_ = umiDecode(r, &body)

	now := time.Now().UTC()
	var (
		p   *CardPayment
		err error
	)
	switch strings.ToLower(parts[1]) {
	case "chargeback":
		p, err = s.Cards.Chargeback(id, body.ReasonCode, c.ID, now)
	case "represent":
		p, err = s.Cards.Represent(id, body.Evidence, c.ID, now)
	case "prearbitrate":
		p, err = s.Cards.PreArbitrate(id, body.Detail, c.ID, now)
	case "arbitrate":
		p, err = s.Cards.Arbitrate(id, c.ID, body.MerchantWins, now)
	default:
		umiErr(w, http.StatusNotFound, "ERR_UMI_CARD_NOT_FOUND", "Unknown step "+parts[1]+".")
		return
	}
	if err != nil {
		code, sentinel := cardStatusFor(err)
		// A refusal still changed the record: the window closing or the
		// liability shifting is itself the outcome, and the caller needs to
		// see the payment it left behind.
		if p != nil {
			writeJSON(w, code, map[string]interface{}{
				"error":   sentinel,
				"message": err.Error(),
				"payment": p,
			})
			return
		}
		umiErr(w, code, sentinel, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, p)
}
