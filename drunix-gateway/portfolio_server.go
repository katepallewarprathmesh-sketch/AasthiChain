package drunix

// HTTP surface for cross-property portfolio tokens and dynamic ownership.
// Additive: every route is new, nothing existing changes shape.

import (
	"errors"
	"net/http"
	"strings"
	"time"
)

// registerPortfolioRoutes mounts the basket and ownership endpoints.
func (s *Server) registerPortfolioRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/umi/baskets", s.handleBaskets)
	mux.HandleFunc("/umi/baskets/", s.handleBasketByID)
	mux.HandleFunc("/umi/ownership/", s.handleOwnership)
	mux.HandleFunc("/umi/holdings/", s.handleBasketHoldings)
}

// GET  /umi/baskets  — list
// POST /umi/baskets  — define a basket
func (s *Server) handleBaskets(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"baskets": s.UMI.Baskets(), "mode": UMIMode,
		})
	case http.MethodPost:
		var body struct {
			BasketID   string            `json:"basketId"`
			Name       string            `json:"name"`
			Custodian  string            `json:"custodian"`
			Components []BasketComponent `json:"components"`
		}
		if err := umiDecode(r, &body); err != nil {
			umiErr(w, http.StatusBadRequest, "ERR_BAD_JSON", err.Error())
			return
		}
		b, blk, err := s.UMI.CreateBasket(body.BasketID, body.Name, body.Custodian, body.Components)
		if err != nil {
			status := http.StatusBadRequest
			if errors.Is(err, ErrBasketExists) {
				status = http.StatusConflict
			}
			umiErr(w, status, errCode(err), basketHint(err))
			return
		}
		writeJSON(w, http.StatusCreated, map[string]interface{}{
			"ok": true, "basket": b, "navPerUnitINR": b.NAVPerUnitINR(), "block": blk,
		})
	default:
		umiErr(w, http.StatusMethodNotAllowed, "ERR_METHOD", "GET or POST")
	}
}

// /umi/baskets/{id}            GET
// /umi/baskets/{id}/subscribe  POST
// /umi/baskets/{id}/redeem     POST
func (s *Server) handleBasketByID(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/umi/baskets/")
	parts := strings.Split(strings.Trim(rest, "/"), "/")
	id := parts[0]
	if id == "" {
		umiErr(w, http.StatusNotFound, "ERR_NOT_FOUND", "basket id required")
		return
	}

	action := ""
	if len(parts) > 1 {
		action = parts[1]
	}

	if action == "" {
		if r.Method != http.MethodGet {
			umiErr(w, http.StatusMethodNotAllowed, "ERR_METHOD", "GET required")
			return
		}
		view, err := s.UMI.BasketByID(id)
		if err != nil {
			umiErr(w, http.StatusNotFound, errCode(err), "no such basket")
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"basket": view, "mode": UMIMode})
		return
	}

	if action != "subscribe" && action != "redeem" {
		umiErr(w, http.StatusNotFound, "ERR_NOT_FOUND", "use /subscribe or /redeem")
		return
	}
	if !requirePost(w, r) {
		return
	}
	var body struct {
		Holder string `json:"holder"`
		Units  int64  `json:"units"`
	}
	if err := umiDecode(r, &body); err != nil {
		umiErr(w, http.StatusBadRequest, "ERR_BAD_JSON", err.Error())
		return
	}

	var (
		b    *Basket
		blk  *DrunixBlock
		err  error
		verb string
	)
	if action == "subscribe" {
		b, blk, err = s.UMI.Subscribe(id, body.Holder, body.Units)
		verb = "subscribed"
	} else {
		b, blk, err = s.UMI.Redeem(id, body.Holder, body.Units)
		verb = "redeemed"
	}
	if err != nil {
		status := http.StatusBadRequest
		switch {
		case errors.Is(err, ErrBasketNotFound):
			status = http.StatusNotFound
		case errors.Is(err, ErrUMIInsufficientSecurities),
			errors.Is(err, ErrBasketInsufficientUnits):
			// Well formed, but the book will not allow it.
			status = http.StatusConflict
		}
		umiErr(w, status, errCode(err), basketHint(err))
		return
	}
	view, _ := s.UMI.BasketByID(id)
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"ok": true, "action": verb, "holder": body.Holder, "units": body.Units,
		"basket": view, "unitsHeld": b.Units[body.Holder], "block": blk,
	})
}

// GET /umi/ownership/{assetId}?from=RFC3339&to=RFC3339
func (s *Server) handleOwnership(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		umiErr(w, http.StatusMethodNotAllowed, "ERR_METHOD", "GET required")
		return
	}
	assetID := strings.Trim(strings.TrimPrefix(r.URL.Path, "/umi/ownership/"), "/")
	if assetID == "" {
		umiErr(w, http.StatusNotFound, "ERR_NOT_FOUND", "assetId required")
		return
	}
	q := r.URL.Query()
	parse := func(k string) time.Time {
		if v := q.Get(k); v != "" {
			if t, err := time.Parse(time.RFC3339, v); err == nil {
				return t.UTC()
			}
		}
		return time.Time{}
	}
	from, to := parse("from"), parse("to")
	table := s.UMI.CapTable(assetID, from, to)

	authorised, outstanding := s.UMI.AuthorisedSupply(assetID)
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"assetId": assetID, "holders": table,
		"authorisedTokens": authorised, "outstandingTokens": outstanding,
		"events": len(s.UMI.OwnershipHistory(assetID)),
		"basis": map[string]string{
			"pctNow":          "position at this instant",
			"pctTimeWeighted": "average position across the window — the fair basis for splitting income",
		},
		"mode": UMIMode,
	})
}

// GET /umi/holdings/{participant} — basket units held.
func (s *Server) handleBasketHoldings(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		umiErr(w, http.StatusMethodNotAllowed, "ERR_METHOD", "GET required")
		return
	}
	who := strings.Trim(strings.TrimPrefix(r.URL.Path, "/umi/holdings/"), "/")
	if who == "" {
		umiErr(w, http.StatusNotFound, "ERR_NOT_FOUND", "participant required")
		return
	}
	holdings := s.UMI.BasketHoldings(who)
	var total float64
	for _, h := range holdings {
		total += h["valueINR"].(float64)
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"participant": who, "baskets": holdings,
		"totalBasketValueINR": total, "mode": UMIMode,
	})
}

func errCode(err error) string {
	type coded interface{ Error() string }
	var c coded = err
	msg := c.Error()
	if i := strings.Index(msg, ":"); i > 0 && strings.HasPrefix(msg, "ERR_") {
		return msg[:i]
	}
	if strings.HasPrefix(msg, "ERR_") {
		return msg
	}
	for _, e := range []error{ErrBasketNotFound, ErrBasketExists, ErrBasketComponents,
		ErrBasketUnits, ErrBasketInsufficientUnits, ErrUMIInsufficientSecurities} {
		if errors.Is(err, e) {
			return e.Error()
		}
	}
	return "ERR_UMI_BASKET"
}

func basketHint(err error) string {
	switch {
	case errors.Is(err, ErrBasketComponents):
		return "a basket needs at least two distinct assets, each with a positive tokensPerUnit"
	case errors.Is(err, ErrBasketExists):
		return "this basket already has units outstanding; its recipe cannot be changed"
	case errors.Is(err, ErrBasketUnits):
		return "units must be positive and a holder is required"
	case errors.Is(err, ErrBasketInsufficientUnits):
		return "you do not hold that many units of this basket"
	case errors.Is(err, ErrBasketNotFound):
		return "no such basket on this rail"
	}
	return err.Error()
}
