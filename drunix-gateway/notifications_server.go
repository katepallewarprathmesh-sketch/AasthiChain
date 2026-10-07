package drunix

import (
	"net/http"
	"strconv"
	"strings"
)

// HTTP surface for notifications.
//
// Note what is deliberately absent: there is no "send a notification"
// endpoint. Notifications are raised by the rail when a block commits, so
// nothing outside this process can fabricate one. A feed you cannot write to
// is a feed you can believe.

func (s *Server) registerNotificationRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/umi/notifications/", s.handleNotifications)
}

// GET  /umi/notifications/{participant}?unread=true&limit=50
// POST /umi/notifications/{participant}/read      {"id": "NTF-..."}
// POST /umi/notifications/{participant}/read-all
func (s *Server) handleNotifications(w http.ResponseWriter, r *http.Request) {
	if s.UMI == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "ERR_UMI_DISABLED"})
		return
	}
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/umi/notifications/"), "/")
	if rest == "" {
		umiErr(w, http.StatusBadRequest, "ERR_UMI_PARTICIPANT",
			"Name the participant in the path, for example /umi/notifications/investor1.")
		return
	}
	parts := strings.Split(rest, "/")
	participant := parts[0]
	action := ""
	if len(parts) > 1 {
		action = parts[1]
	}

	switch action {
	case "":
		if r.Method != http.MethodGet {
			umiErr(w, http.StatusMethodNotAllowed, "ERR_UMI_METHOD", "Use GET to read notifications.")
			return
		}
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		if limit <= 0 || limit > 200 {
			limit = 50
		}
		unreadOnly := r.URL.Query().Get("unread") == "true"
		list, unread := s.UMI.Notifications(participant, unreadOnly, limit)
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"participant": participant, "notifications": list,
			"count": len(list), "unread": unread, "mode": UMIMode,
		})

	case "read":
		if !requirePost(w, r) {
			return
		}
		var body struct {
			ID string `json:"id"`
		}
		if err := umiDecode(r, &body); err != nil {
			umiErr(w, http.StatusBadRequest, "ERR_UMI_BAD_REQUEST", "Could not read the request body as JSON.")
			return
		}
		if !s.UMI.MarkNotificationRead(participant, strings.TrimSpace(body.ID)) {
			umiErr(w, http.StatusNotFound, "ERR_UMI_NOTIFICATION_NOT_FOUND",
				"No notification with that id for this participant.")
			return
		}
		_, unread := s.UMI.Notifications(participant, false, 1)
		writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true, "unread": unread})

	case "read-all":
		if !requirePost(w, r) {
			return
		}
		cleared := s.UMI.MarkAllNotificationsRead(participant)
		writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true, "cleared": cleared, "unread": 0})

	default:
		umiErr(w, http.StatusNotFound, "ERR_UMI_NOTIFICATION_ACTION", "Supported actions are read and read-all.")
	}
}
