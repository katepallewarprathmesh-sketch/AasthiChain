package drunix

import (
	"errors"
	"net/http"
	"strings"
)

// HTTP surface for the secondary marketplace. Same shape as the rest of the
// rail: POST-only mutations, plain-English hints on every rejection, and no
// sentinel codes leaking into prose.

func (s *Server) registerMarketRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/umi/offers", s.handleOffers)
	mux.HandleFunc("/umi/offers/", s.handleOfferByID)
	mux.HandleFunc("/umi/market/", s.handleMarketDepth)
}

// offerHint turns a rejection into something a person can act on.
func offerHint(err error) string {
	switch {
	case errors.Is(err, ErrOfferNotFound):
		return "No offer with that id. It may have been cancelled, or the rail restarted."
	case errors.Is(err, ErrOfferClosed):
		return "That offer is no longer open — it has been filled or withdrawn."
	case errors.Is(err, ErrOfferNotSeller):
		return "Only the seller who created an offer can withdraw it."
	case errors.Is(err, ErrOfferSelfTrade):
		return "You cannot buy your own offer."
	case errors.Is(err, ErrOfferOversold):
		return "You have already offered these tokens. Cancel or reduce an existing offer first."
	case errors.Is(err, ErrOfferAmount):
		return "Check the quantity and price: both must be positive, and you cannot take more than an offer has left."
	case errors.Is(err, ErrUMIInsufficientCBDC):
		return "The buyer's wallet does not hold enough e₹-W for this purchase. Top it up and try again."
	case errors.Is(err, ErrUMIInsufficientSecurities):
		return "The seller no longer holds the tokens this offer promised."
	}
	return "The marketplace rejected this request."
}

func offerStatus(err error) int {
	switch {
	case errors.Is(err, ErrOfferNotFound):
		return http.StatusNotFound
	case errors.Is(err, ErrOfferNotSeller):
		return http.StatusForbidden
	case errors.Is(err, ErrOfferClosed), errors.Is(err, ErrOfferOversold),
		errors.Is(err, ErrUMIInsufficientCBDC), errors.Is(err, ErrUMIInsufficientSecurities):
		return http.StatusConflict
	}
	return http.StatusBadRequest
}

func offerFail(w http.ResponseWriter, err error) {
	// Report the sentinel as the machine-readable code and the hint as prose,
	// never the other way around.
	code := "ERR_UMI_OFFER_REJECTED"
	if err != nil {
		if first := strings.SplitN(err.Error(), ":", 2)[0]; strings.HasPrefix(first, "ERR_") {
			code = first
		}
	}
	umiErr(w, offerStatus(err), code, offerHint(err))
}

// GET  /umi/offers?assetId=&all=true  — browse the book
// POST /umi/offers                    — list tokens for sale
func (s *Server) handleOffers(w http.ResponseWriter, r *http.Request) {
	if s.UMI == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "ERR_UMI_DISABLED"})
		return
	}
	switch r.Method {
	case http.MethodGet:
		assetID := strings.TrimSpace(r.URL.Query().Get("assetId"))
		openOnly := r.URL.Query().Get("all") != "true"
		offers := s.UMI.Offers(assetID, openOnly)
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"offers": offers, "count": len(offers), "mode": UMIMode,
			"disclaimer": "Secondary trading simulation — every purchase settles as atomic DvP.",
		})
	case http.MethodPost:
		var body struct {
			AssetID          string  `json:"assetId"`
			Seller           string  `json:"seller"`
			Tokens           int64   `json:"tokens"`
			PricePerTokenINR float64 `json:"pricePerTokenINR"`
		}
		if err := umiDecode(r, &body); err != nil {
			umiErr(w, http.StatusBadRequest, "ERR_UMI_BAD_REQUEST", "Could not read the request body as JSON.")
			return
		}
		o, err := s.UMI.CreateOffer(body.AssetID, body.Seller, body.Tokens, body.PricePerTokenINR)
		if err != nil {
			offerFail(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, map[string]interface{}{"ok": true, "offer": o, "mode": UMIMode})
	default:
		umiErr(w, http.StatusMethodNotAllowed, "ERR_UMI_METHOD", "Use GET to browse offers or POST to create one.")
	}
}

// GET  /umi/offers/{id}         — one offer
// POST /umi/offers/{id}/take    — buy against it
// POST /umi/offers/{id}/cancel  — withdraw it
func (s *Server) handleOfferByID(w http.ResponseWriter, r *http.Request) {
	if s.UMI == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "ERR_UMI_DISABLED"})
		return
	}
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/umi/offers/"), "/")
	if rest == "" {
		umiErr(w, http.StatusBadRequest, "ERR_UMI_OFFER_ID", "Name the offer in the path, for example /umi/offers/OFR-000001.")
		return
	}
	parts := strings.Split(rest, "/")
	offerID := parts[0]
	action := ""
	if len(parts) > 1 {
		action = parts[1]
	}

	switch action {
	case "":
		if r.Method != http.MethodGet {
			umiErr(w, http.StatusMethodNotAllowed, "ERR_UMI_METHOD", "Use GET to read an offer.")
			return
		}
		o, err := s.UMI.Offer(offerID)
		if err != nil {
			offerFail(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"offer": o, "mode": UMIMode})

	case "take":
		if !requirePost(w, r) {
			return
		}
		var body struct {
			Buyer  string `json:"buyer"`
			Tokens int64  `json:"tokens"`
			DryRun bool   `json:"dryRun"`
		}
		if err := umiDecode(r, &body); err != nil {
			umiErr(w, http.StatusBadRequest, "ERR_UMI_BAD_REQUEST", "Could not read the request body as JSON.")
			return
		}
		o, si, err := s.UMI.TakeOffer(offerID, body.Buyer, body.Tokens, body.DryRun)
		if err != nil {
			// A failed settlement still produced an instruction worth showing.
			writeJSON(w, offerStatus(err), map[string]interface{}{
				"error": strings.SplitN(err.Error(), ":", 2)[0], "message": offerHint(err),
				"instruction": si, "mode": UMIMode,
			})
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"ok": true, "dryRun": body.DryRun, "offer": o, "instruction": si, "mode": UMIMode,
		})

	case "cancel":
		if !requirePost(w, r) {
			return
		}
		var body struct {
			Seller string `json:"seller"`
		}
		if err := umiDecode(r, &body); err != nil {
			umiErr(w, http.StatusBadRequest, "ERR_UMI_BAD_REQUEST", "Could not read the request body as JSON.")
			return
		}
		o, err := s.UMI.CancelOffer(offerID, strings.TrimSpace(body.Seller))
		if err != nil {
			offerFail(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true, "offer": o, "mode": UMIMode})

	default:
		umiErr(w, http.StatusNotFound, "ERR_UMI_OFFER_ACTION", "Supported actions are take and cancel.")
	}
}

// GET /umi/market/{assetId} — depth summary for one asset
func (s *Server) handleMarketDepth(w http.ResponseWriter, r *http.Request) {
	if s.UMI == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "ERR_UMI_DISABLED"})
		return
	}
	if r.Method != http.MethodGet {
		umiErr(w, http.StatusMethodNotAllowed, "ERR_UMI_METHOD", "Use GET to read market depth.")
		return
	}
	assetID := strings.Trim(strings.TrimPrefix(r.URL.Path, "/umi/market/"), "/")
	if assetID == "" {
		umiErr(w, http.StatusBadRequest, "ERR_UMI_ASSET_ID", "Name the asset in the path, for example /umi/market/PROP-001.")
		return
	}
	writeJSON(w, http.StatusOK, s.UMI.MarketDepth(assetID))
}
