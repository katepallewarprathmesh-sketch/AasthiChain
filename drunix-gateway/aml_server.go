package drunix

// HTTP surface for AML screening (aml.go).
//
//	GET  /umi/aml                       which list is loaded, case counts, thresholds
//	GET  /umi/aml/watchlist             the list itself
//	POST /umi/aml/screen                screen a name without moving anything
//	GET  /umi/aml/cases[?limit=]        every case, newest first
//	GET  /umi/aml/cases/{id}            one case with its full history
//	POST /umi/aml/cases                 open a case by hand
//	POST /umi/aml/cases/{id}/review     pick it up
//	POST /umi/aml/cases/{id}/clear      close it as a false positive, with grounds
//	POST /umi/aml/cases/{id}/report     escalate it into a report artefact
//	GET  /umi/aml/reports/{id}          the report, as the document it is
//
// Reads of the list and of the thresholds are public: a person refused by a
// screen is entitled to see what they were screened against. Cases and
// reports carry names and suspicions, so they are supervisor-only.

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
)

func (s *Server) registerAMLRoutes(mux *http.ServeMux) {
	if s.AML == nil {
		return
	}
	mux.HandleFunc("/umi/aml", s.durabilityGate(s.handleAMLRoot))
	mux.HandleFunc("/umi/aml/", s.durabilityGate(s.handleAMLPath))
}

func amlStatusFor(err error) (int, string) {
	switch {
	case errors.Is(err, ErrAMLNotFound):
		return http.StatusNotFound, "ERR_UMI_AML_NOT_FOUND"
	case errors.Is(err, ErrAMLState):
		return http.StatusConflict, "ERR_UMI_AML_STATE"
	case errors.Is(err, ErrAMLBlocked):
		return http.StatusForbidden, "ERR_UMI_AML_BLOCKED"
	case errors.Is(err, ErrAMLNotReviewer):
		return http.StatusForbidden, "ERR_UMI_AML_NOT_REVIEWER"
	default:
		return http.StatusBadRequest, "ERR_UMI_AML_FIELDS"
	}
}

func (s *Server) amlFail(w http.ResponseWriter, err error) {
	code, reason := amlStatusFor(err)
	umiErr(w, code, reason, err.Error())
}

func (s *Server) handleAMLRoot(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		umiErr(w, http.StatusMethodNotAllowed, "ERR_UMI_METHOD", "GET only.")
		return
	}
	writeJSON(w, http.StatusOK, s.AML.Status())
}

func (s *Server) handleAMLPath(w http.ResponseWriter, r *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/umi/aml/"), "/")
	parts := strings.Split(rest, "/")
	switch {
	case parts[0] == "watchlist":
		s.amlWatchlist(w, r)
	case parts[0] == "screen":
		s.amlScreen(w, r)
	case parts[0] == "cases":
		s.amlCases(w, r, parts)
	case parts[0] == "reports" && len(parts) > 1:
		s.amlReport(w, r, parts[1])
	default:
		umiErr(w, http.StatusNotFound, "ERR_UMI_AML_NOT_FOUND", "No such AML route.")
	}
}

func (s *Server) amlWatchlist(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		umiErr(w, http.StatusMethodNotAllowed, "ERR_UMI_METHOD", "GET only.")
		return
	}
	st := s.AML.Status()
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"listName":        st["listName"],
		"listIsSynthetic": st["listIsSynthetic"],
		"entries":         s.AML.Watchlist(),
		"note": "Published deliberately. A person refused by a screen can see exactly what they were " +
			"screened against, and a list nobody can read cannot be corrected.",
		"disclaimer": amlDisclaimer,
	})
}

func (s *Server) amlScreen(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		umiErr(w, http.StatusMethodNotAllowed, "ERR_UMI_METHOD", "POST only.")
		return
	}
	var body struct {
		Name  string   `json:"name"`
		Names []string `json:"names"`
	}
	if err := umiDecode(r, &body); err != nil {
		umiErr(w, http.StatusBadRequest, "ERR_UMI_AML_FIELDS", err.Error())
		return
	}
	names := body.Names
	if strings.TrimSpace(body.Name) != "" {
		names = append(names, body.Name)
	}
	if len(names) == 0 {
		umiErr(w, http.StatusBadRequest, "ERR_UMI_AML_FIELDS", "Give a name, or a list of names, to screen.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"screening":  s.AML.ScreenParties(names...),
		"note":       "Screening alone moves nothing and opens nothing. It is the same check the payment path runs.",
		"disclaimer": amlDisclaimer,
	})
}

func (s *Server) amlCases(w http.ResponseWriter, r *http.Request, parts []string) {
	// /umi/aml/cases/{id}/{action}
	if len(parts) >= 2 {
		if len(parts) == 2 && r.Method == http.MethodGet {
			c := callerOf(r)
			if !umiRequireIdentity(w, c) || !umiRequireSupervisor(w, c, "read an AML case") {
				return
			}
			rec, err := s.AML.Case(parts[1])
			if err != nil {
				s.amlFail(w, err)
				return
			}
			writeJSON(w, http.StatusOK, map[string]interface{}{"case": rec, "disclaimer": amlDisclaimer})
			return
		}
		if len(parts) >= 3 {
			s.amlCaseAction(w, r, parts[1], parts[2])
			return
		}
		umiErr(w, http.StatusMethodNotAllowed, "ERR_UMI_METHOD", "GET a case, or POST to /review, /clear or /report.")
		return
	}

	switch r.Method {
	case http.MethodGet:
		c := callerOf(r)
		if !umiRequireIdentity(w, c) || !umiRequireSupervisor(w, c, "read AML cases") {
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"cases":      s.AML.Cases(queryLimit(r, 50, 200)),
			"disclaimer": amlDisclaimer,
		})
	case http.MethodPost:
		c := callerOf(r)
		if !umiRequireIdentity(w, c) || !umiRequireSupervisor(w, c, "open an AML case") {
			return
		}
		var body struct {
			Name         string `json:"name"`
			RelatedRef   string `json:"relatedRef"`
			Counterparty string `json:"counterparty"`
			AmountPaise  int64  `json:"amountPaise"`
		}
		if err := umiDecode(r, &body); err != nil {
			umiErr(w, http.StatusBadRequest, "ERR_UMI_AML_FIELDS", err.Error())
			return
		}
		if strings.TrimSpace(body.Name) == "" {
			umiErr(w, http.StatusBadRequest, "ERR_UMI_AML_FIELDS", "A case is about a named subject.")
			return
		}
		rec := s.AML.OpenCase(s.AML.Screen(body.Name), c.ID, body.RelatedRef, body.Counterparty, body.AmountPaise)
		writeJSON(w, http.StatusCreated, map[string]interface{}{"case": rec, "disclaimer": amlDisclaimer})
	default:
		umiErr(w, http.StatusMethodNotAllowed, "ERR_UMI_METHOD", "GET or POST.")
	}
}

func (s *Server) amlCaseAction(w http.ResponseWriter, r *http.Request, id, action string) {
	if r.Method != http.MethodPost {
		umiErr(w, http.StatusMethodNotAllowed, "ERR_UMI_METHOD", "POST only.")
		return
	}
	c := callerOf(r)
	if !umiRequireIdentity(w, c) || !umiRequireSupervisor(w, c, "act on an AML case") {
		return
	}
	var body struct {
		Text      string   `json:"text"`
		Reason    string   `json:"reason"`
		Grounds   []string `json:"grounds"`
		Narrative string   `json:"narrative"`
	}
	if err := umiDecode(r, &body); err != nil {
		umiErr(w, http.StatusBadRequest, "ERR_UMI_AML_FIELDS", err.Error())
		return
	}

	switch action {
	case "review":
		rec, err := s.AML.Review(id, c.ID, firstNonEmpty(body.Text, "Picked up for review."))
		if err != nil {
			s.amlFail(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"case": rec, "disclaimer": amlDisclaimer})
	case "clear":
		rec, err := s.AML.Clear(id, c.ID, firstNonEmpty(body.Reason, body.Text))
		if err != nil {
			s.amlFail(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"case":       rec,
			"note":       "Cleared as a false positive, with the grounds recorded against the reviewer's name.",
			"disclaimer": amlDisclaimer,
		})
	case "report":
		rec, report, err := s.AML.Report(id, c.ID, body.Grounds, body.Narrative)
		if err != nil {
			s.amlFail(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, map[string]interface{}{
			"case": rec, "report": report,
			"note": "The report is a document. Its hash is on the ledger, so the copy held and the copy " +
				"recorded can be shown to be the same one. It has not been filed with anybody.",
			"disclaimer": amlDisclaimer,
		})
	default:
		umiErr(w, http.StatusNotFound, "ERR_UMI_AML_NOT_FOUND", "Use /review, /clear or /report.")
	}
}

func (s *Server) amlReport(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodGet {
		umiErr(w, http.StatusMethodNotAllowed, "ERR_UMI_METHOD", "GET only.")
		return
	}
	c := callerOf(r)
	if !umiRequireIdentity(w, c) || !umiRequireSupervisor(w, c, "read a suspicious transaction report") {
		return
	}
	rec, err := s.AML.ReportByID(id)
	if err != nil {
		s.amlFail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"report": rec,
		"verify": "Recompute the hash over this document with its hash field emptied; it must equal the " +
			"hash recorded in block " + strconv.FormatInt(rec.BlockHeight, 10) + ".",
		"disclaimer": amlDisclaimer,
	})
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}
