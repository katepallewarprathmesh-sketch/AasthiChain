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
	// Pipeline is the full Drunix LP→Orderer→VS→CP transaction path
	// (optional; wired by main when running the embedded pipeline demo).
	Pipeline *Pipeline
	// HistoryLookup returns the payer's recent-activity summary (wired by main
	// from the payments store; nil means zero-history).
	HistoryLookup func(payerID string) HistorySummary
	// UMI is the RBI Unified Market Interface settlement rail (optional, additive;
	// nil means the /umi/* routes are simply not mounted — see umi.go).
	UMI *UMIRail
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
	mux.HandleFunc("/drunix/pipeline", s.handlePipeline)
	mux.HandleFunc("/drunix/pipeline/stats", s.handlePipelineStats)
	s.registerUMIRoutes(mux) // UMI rail (/umi/*) — additive, no-op when s.UMI is nil
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

// handlePipeline runs a transaction through the full Drunix path:
// LP endorse → RAFT order → VS validate → CP MVCC + commit.
// Body: {"fn":"TransferTokens","args":["PROP-1","alice","bob","5"],
//
//	"private":{"InvestorMSP":{"pan":"ABCPX1234F"}}}
func (s *Server) handlePipeline(w http.ResponseWriter, r *http.Request) {
	if s.Pipeline == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "pipeline not wired"})
		return
	}
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST required"})
		return
	}
	var body struct {
		Fn      string                       `json:"fn"`
		Args    []string                     `json:"args"`
		Private map[string]map[string]string `json:"private"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Fn == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "body must be {fn, args, private?}"})
		return
	}
	// plain-string private fields (JSON []byte would demand base64)
	priv := map[string]map[string][]byte{}
	for org, fields := range body.Private {
		priv[org] = map[string][]byte{}
		for f, v := range fields {
			priv[org][f] = []byte(v)
		}
	}
	res, err := s.Pipeline.Submit(body.Fn, body.Args, priv)
	code := http.StatusOK
	if err != nil {
		code = http.StatusUnprocessableEntity
	}
	writeJSON(w, code, map[string]interface{}{"result": res, "error": errStr(err)})
}

func errStr(err error) string {
	if err != nil {
		return err.Error()
	}
	return ""
}

// handlePipelineStats reports live pipeline state (judge dashboard).
func (s *Server) handlePipelineStats(w http.ResponseWriter, r *http.Request) {
	if s.Pipeline == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "pipeline not wired"})
		return
	}
	p := s.Pipeline
	v := p.CP.Ledger.Verify()
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"stateDB":        map[string]interface{}{"keys": p.CP.State.Size(), "engine": "in-memory (YugabyteDB in production)"},
		"transientStore": map[string]interface{}{"entries": p.CP.Transient.Size(), "engine": "KeyDB (in-memory, never persisted)"},
		"ledger":         map[string]interface{}{"blocks": len(p.CP.Ledger.Blocks), "height": v.Height, "valid": v.Valid, "chainId": DrunixChainID},
		"orderer": map[string]interface{}{
			"nodes": p.Order.Nodes, "sequence": p.Order.Seq, "leader": p.Order.Leader(),
			"consensus": "RAFT (simulated)", "batchMax": p.Order.BatchMax,
			"pending": p.Order.Pending(), "blocksCut": p.Order.BlocksCut(),
		},
		"validation":      map[string]interface{}{"instances": len(p.VS.Instances), "dispatch": "round-robin (CP to VS)"},
		"client":          map[string]interface{}{"id": p.Client.ID, "phase2": "collects endorsements, signs envelope"},
		"transactionFlow": []string{"1-endorsement", "2-submit-txn", "3-ordering", "4-validation", "5-commit"},
		"roles":           []string{"Client (signs envelope)", "LitePeer (endorsement, stateless)", "Orderer (RAFT, batches txns into blocks)", "ValidationService (VSCC, round-robin)", "CommittingPeer (MVCC + commit)"},
	})
}
