package drunix

// HTTP surface for signed feeds (oracle.go).
//
//	GET  /umi/oracle/feeds                      every feed, with its current value or the reason there is none
//	GET  /umi/oracle/posture                    what this mechanism gives you, and what it does not
//	POST /umi/oracle/feeds                      register a feed and its freshness contract
//	GET  /umi/oracle/feeds/{id}                 one feed
//	GET  /umi/oracle/feeds/{id}/observations    its readings, newest first
//	POST /umi/oracle/feeds/{id}/observations    publish a signed reading
//	POST /umi/oracle/feeds/{id}/retire          withdraw the feed
//
// The read routes are public. A feed whose provenance only an operator can
// inspect gives an outside reader no way to check whether the number a price
// or a rate rests on was fresh, or who signed it.

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"
)

func (s *Server) registerOracleRoutes(mux *http.ServeMux) {
	if s.Oracle == nil {
		return
	}
	mux.HandleFunc("/umi/oracle/feeds", s.handleOracleFeedsRoot)
	mux.HandleFunc("/umi/oracle/feeds/", s.handleOracleFeedPath)
	mux.HandleFunc("/umi/oracle/posture", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "GET required"})
			return
		}
		writeJSON(w, http.StatusOK, s.Oracle.Posture())
	})
}

func (s *Server) handleOracleFeedsRoot(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, map[string]interface{}{"feeds": s.Oracle.Feeds()})
	case http.MethodPost:
		var body struct {
			FeedID          string   `json:"feedId"`
			Description     string   `json:"description"`
			Unit            string   `json:"unit"`
			Publishers      []string `json:"publishers"`
			MaxStalenessSec int      `json:"maxStalenessSec"`
			MinPublishers   int      `json:"minPublishers"`
			MaxDeviationPct float64  `json:"maxDeviationPct"`
			By              string   `json:"by"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"error": "invalid JSON: " + err.Error(), "code": "ERR_UMI_FEED_FIELDS"})
			return
		}
		by := body.By
		if by == "" {
			by = feedCaller(r)
		}
		feed, err := s.Oracle.RegisterFeed(Feed{
			FeedID: body.FeedID, Description: body.Description, Unit: body.Unit,
			Publishers: body.Publishers, MaxStalenessSec: body.MaxStalenessSec,
			MinPublishers: body.MinPublishers, MaxDeviationPct: body.MaxDeviationPct,
		}, by)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"error": err.Error(), "code": "ERR_UMI_FEED_FIELDS"})
			return
		}
		writeJSON(w, http.StatusCreated, map[string]interface{}{"feed": feed})
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "GET or POST required"})
	}
}

func (s *Server) handleOracleFeedPath(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/umi/oracle/feeds/")
	parts := strings.Split(strings.Trim(rest, "/"), "/")
	feedID := parts[0]
	if feedID == "" {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "feed id required"})
		return
	}
	tail := ""
	if len(parts) > 1 {
		tail = parts[1]
	}

	switch {
	case tail == "" && r.Method == http.MethodGet:
		v := s.Oracle.Value(feedID)
		if v.State == FeedNoData && v.Reason == "no feed by that id" {
			writeJSON(w, http.StatusNotFound, map[string]string{
				"error": "no feed called " + feedID, "code": "ERR_UMI_FEED_NOT_FOUND"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"value": v, "observations": s.Oracle.Observations(feedID, 20)})

	case tail == "observations" && r.Method == http.MethodGet:
		limit := 50
		if n, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && n > 0 {
			limit = n
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"feedId": feedID, "observations": s.Oracle.Observations(feedID, limit)})

	case tail == "observations" && r.Method == http.MethodPost:
		var body struct {
			Publisher  string  `json:"publisher"`
			PublicKey  string  `json:"publicKey"`
			Signature  string  `json:"signature"`
			Value      float64 `json:"value"`
			ObservedAt string  `json:"observedAt"`
			Nonce      string  `json:"nonce"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"error": "invalid JSON: " + err.Error(), "code": "ERR_UMI_FEED_FIELDS"})
			return
		}
		at := time.Now().UTC()
		if body.ObservedAt != "" {
			parsed, err := time.Parse(time.RFC3339Nano, body.ObservedAt)
			if err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{
					"error": "observedAt must be RFC3339", "code": "ERR_UMI_FEED_FIELDS"})
				return
			}
			at = parsed
		}
		ob, err := s.Oracle.Publish(feedID, body.Publisher, body.PublicKey, body.Signature,
			body.Value, at, body.Nonce)
		if err != nil {
			status, code := oracleStatusFor(err)
			writeJSON(w, status, map[string]string{"error": err.Error(), "code": code})
			return
		}
		writeJSON(w, http.StatusCreated, map[string]interface{}{
			"observation": ob, "value": s.Oracle.Value(feedID)})

	case tail == "retire" && r.Method == http.MethodPost:
		var body struct {
			By     string `json:"by"`
			Reason string `json:"reason"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		by := body.By
		if by == "" {
			by = feedCaller(r)
		}
		feed, err := s.Oracle.Retire(feedID, by, body.Reason)
		if err != nil {
			writeJSON(w, http.StatusNotFound, map[string]string{
				"error": err.Error(), "code": "ERR_UMI_FEED_NOT_FOUND"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"feed": feed})

	default:
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such feed route"})
	}
}

// feedCaller names who acted, from the identity header the rest of the rail
// uses. An unsigned caller is recorded as unknown rather than as nobody.
func feedCaller(r *http.Request) string {
	if id := strings.TrimSpace(r.Header.Get("X-Identity-Id")); id != "" {
		return id
	}
	return "unknown"
}

// oracleStatusFor maps a refusal to a status a client can act on, rather than
// returning 400 for everything and making the caller read prose.
func oracleStatusFor(err error) (int, string) {
	msg := err.Error()
	switch {
	case strings.HasPrefix(msg, feedRejectUnknownFeed):
		return http.StatusNotFound, "ERR_UMI_FEED_NOT_FOUND"
	case strings.HasPrefix(msg, feedRejectBadKey):
		return http.StatusForbidden, "ERR_UMI_FEED_KEY"
	case strings.HasPrefix(msg, feedRejectNotAllowed):
		return http.StatusForbidden, "ERR_UMI_FEED_PUBLISHER"
	case strings.HasPrefix(msg, feedRejectBadSig):
		return http.StatusUnauthorized, "ERR_UMI_FEED_SIGNATURE"
	case strings.HasPrefix(msg, feedRejectReplay), strings.HasPrefix(msg, feedRejectBackwards):
		return http.StatusConflict, "ERR_UMI_FEED_REPLAY"
	case strings.HasPrefix(msg, feedRejectFuture):
		return http.StatusUnprocessableEntity, "ERR_UMI_FEED_CLOCK"
	case strings.HasPrefix(msg, FeedRetired):
		return http.StatusConflict, "ERR_UMI_FEED_RETIRED"
	default:
		return http.StatusBadRequest, "ERR_UMI_FEED_FIELDS"
	}
}
