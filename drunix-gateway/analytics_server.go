package drunix

// HTTP surface for the analytics engine (analytics.go).
//
// Read-only by design: both routes are GET, neither takes a body, and nothing
// here can change rail state. Analytics must never be able to break a
// settlement.

import (
	"net/http"
	"strings"
)

// requireGet rejects anything but a read on a read-only route.
func requireGet(w http.ResponseWriter, r *http.Request) bool {
	if r.Method != http.MethodGet {
		umiErr(w, http.StatusMethodNotAllowed, "ERR_METHOD", "GET required")
		return false
	}
	return true
}

// registerAnalyticsRoutes mounts /umi/analytics[/{participant}].
func (s *Server) registerAnalyticsRoutes(mux *http.ServeMux) {
	if s.UMI == nil {
		return
	}
	mux.HandleFunc("/umi/analytics", s.handleRailAnalytics)
	mux.HandleFunc("/umi/analytics/", s.handleInvestorAnalytics)
}

// handleRailAnalytics is the market-wide view: throughput, success rate,
// where the volume is, and what is failing.
func (s *Server) handleRailAnalytics(w http.ResponseWriter, r *http.Request) {
	if !requireGet(w, r) {
		return
	}
	if s.UMI == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "ERR_UMI_DISABLED"})
		return
	}
	days := atoiDefault(r.URL.Query().Get("days"), 14)
	if days < 1 {
		days = 1
	}
	if days > 365 {
		days = 365
	}
	out := s.UMI.RailAnalytics(days)
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"window":     map[string]interface{}{"days": days},
		"analytics":  out,
		"mode":       UMIMode,
		"disclaimer": UMIDisclaimer,
	})
}

// handleInvestorAnalytics is one participant's performance and risk.
func (s *Server) handleInvestorAnalytics(w http.ResponseWriter, r *http.Request) {
	if !requireGet(w, r) {
		return
	}
	if s.UMI == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "ERR_UMI_DISABLED"})
		return
	}
	participant := strings.Trim(strings.TrimPrefix(r.URL.Path, "/umi/analytics/"), "/")
	if participant == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error":   "ERR_UMI_PARTICIPANT_REQUIRED",
			"message": "GET /umi/analytics/{participant}",
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"analytics":  s.UMI.Analytics(participant),
		"mode":       UMIMode,
		"disclaimer": UMIDisclaimer,
	})
}
