package drunix

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Server exposes the Drunix gateway over HTTP (SRP: routing + transport only;
// all logic lives in DrunixClient / ScorePayment — Dependency Inversion).
type Server struct {
	Ledger     DrunixClient
	Thresholds Thresholds
	// HistoryLookup returns the payer's recent-activity summary (wired by main
	// from the payments store; nil means zero-history).
	HistoryLookup func(payerID string) HistorySummary
}

// NewServer wires dependencies (DIP).
func NewServer(l DrunixClient) *Server {
	return &Server{Ledger: l, Thresholds: DefaultThresholds()}
}

// Router composes middleware + routes (Open/Closed: add routes, no rewrites).
func (s *Server) Router() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", s.handleHealth)
	mux.HandleFunc("/drunix/ledger/status", s.handleLedgerStatus)
	mux.HandleFunc("/drunix/tx/", s.handleTx)
	mux.HandleFunc("/drunix/submit", s.handleSubmit)
	mux.HandleFunc("/drunix/evaluate", s.handleEvaluate)
	mux.HandleFunc("/drunix/recent", s.handleRecent)
	mux.HandleFunc("/fraud/score", s.handleFraudScore)
	mux.HandleFunc("/fraud/config", s.handleFraudConfig)
	return logCORS(mux)
}

func logCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}
		start := time.Now()
		next.ServeHTTP(w, r)
		if strings.HasPrefix(r.URL.Path, "/drunix") || strings.HasPrefix(r.URL.Path, "/fraud") {
			_ = start // structured logging hook (kept minimal for the demo)
		}
	})
}

func writeJSON(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	st, err := s.Ledger.LedgerStatus()
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"status":     "ok",
		"service":    "aasthichain-drunix-gateway",
		"language":   "golang",
		"platform":   "NPCI Drunix (Hyperledger Fabric fork)",
		"mode":       st.Mode,
		"channel":    st.Channel,
		"height":     st.Height,
		"txCount":    st.TxCount,
		"fraudModel": "aasthichain-rules-v1 (ML-pluggable)",
	})
}

func (s *Server) handleLedgerStatus(w http.ResponseWriter, r *http.Request) {
	st, err := s.Ledger.LedgerStatus()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) handleTx(w http.ResponseWriter, r *http.Request) {
	txID := strings.TrimPrefix(r.URL.Path, "/drunix/tx/")
	if txID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "txId required"})
		return
	}
	rec, err := s.Ledger.GetTransaction(txID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, rec)
}

func (s *Server) handleSubmit(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST required"})
		return
	}
	var body struct {
		Chaincode  string   `json:"chaincode"`
		Function   string   `json:"function"`
		Args       []string `json:"args"`
		CreatorMSP string   `json:"creatorMsp"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON: " + err.Error()})
		return
	}
	rec, err := s.Ledger.SubmitTransaction(body.Chaincode, body.Function, body.Args, body.CreatorMSP)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, rec)
}

func (s *Server) handleEvaluate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST required"})
		return
	}
	var body struct {
		Chaincode  string   `json:"chaincode"`
		Function   string   `json:"function"`
		Args       []string `json:"args"`
		CreatorMSP string   `json:"creatorMsp"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON: " + err.Error()})
		return
	}
	rec, err := s.Ledger.EvaluateTransaction(body.Chaincode, body.Function, body.Args, body.CreatorMSP)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, rec)
}

func (s *Server) handleRecent(w http.ResponseWriter, r *http.Request) {
	type recentable interface {
		RecentTransactions(n int) []*TxRecord
	}
	if rc, ok := s.Ledger.(recentable); ok {
		n, _ := strconv.Atoi(r.URL.Query().Get("n"))
		writeJSON(w, http.StatusOK, map[string]interface{}{"transactions": rc.RecentTransactions(n)})
		return
	}
	writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "recent not supported by this ledger mode"})
}

func (s *Server) handleFraudScore(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST required"})
		return
	}
	var body struct {
		Payment PaymentInput    `json:"payment"`
		History *HistorySummary `json:"history,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON: " + err.Error()})
		return
	}
	h := HistorySummary{KYCVerified: true}
	if body.History != nil {
		h = *body.History
	} else if s.HistoryLookup != nil {
		h = s.HistoryLookup(body.Payment.PayerID)
	}
	if body.Payment.CreatedAt.IsZero() {
		body.Payment.CreatedAt = time.Now()
	}
	writeJSON(w, http.StatusOK, ScorePayment(body.Payment, h, s.Thresholds))
}

func (s *Server) handleFraudConfig(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"model":       "aasthichain-rules-v1 (ML-pluggable — swap ScorePayment for a trained model)",
		"thresholds":  s.Thresholds,
		"explainable": "every factor carries its weight — regulator-auditable decisions",
		"theme":       "AI & Fraud Detection (NPCI x Citi Drunix Hackathon)",
	})
}
