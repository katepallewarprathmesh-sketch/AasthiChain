package drunix

import (
	"context"
	"encoding/json"
	"log"
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
	// Idem gives the money-moving POSTs request-level idempotency when the
	// caller sends an Idempotency-Key. nil means the old behaviour: every
	// request is executed, including a retry of one that already settled.
	Idem *IdemStore
	// events fans committed blocks out to live subscribers (see events.go).
	events *eventHub
	// metrics records request counts and latency for /metrics (see metrics.go).
	metrics *metrics
	// Docs is the content-addressed document register (see documents.go).
	// Nil disables the routes, exactly like the rest of the optional surface.
	Docs *DocumentRegistry
}

// NewServer wires dependencies (DIP).
func NewServer(l DrunixClient) *Server {
	return &Server{Ledger: l, Thresholds: DefaultThresholds(), events: newEventHub(), metrics: newMetrics()}
}

// StartOutboxRelay drains block consequences from durable storage.
//
// Only runs when the chain is backed by a store that implements the outbox;
// with no DATABASE_URL there is nothing to drain and this returns nil, which
// every OutboxRelay method tolerates. Returned so the caller can Stop it.
//
// Note the ledger.block consumer is additive for now: DrunixChain.Append still
// publishes inline, so a live subscriber may see the same height twice while
// both paths exist. That is safe by design — the payload is {height, hash} and
// clients refetch — and the inline publish goes away with the ordering change
// in docs/EVENT-OUTBOX.md §4.1.
func (s *Server) StartOutboxRelay(ctx context.Context) *OutboxRelay {
	if s.Pipeline == nil || s.Pipeline.CP == nil || s.Pipeline.CP.Ledger == nil {
		return nil
	}
	relay := NewOutboxRelay(s.Pipeline.CP.Ledger.outboxProcessor())
	if relay == nil {
		return nil
	}
	hub := s.events
	relay.Handle(TopicLedgerBlock, func(r OutboxRow) error {
		if hub == nil {
			return nil
		}
		height, _ := r.Payload["height"].(float64)
		hash, _ := r.Payload["hash"].(string)
		typ, _ := r.Payload["type"].(string)
		ts, _ := r.Payload["timestamp"].(string)
		hub.publish(LedgerEvent{Height: int64(height), Type: typ, Hash: hash, Timestamp: ts})
		return nil
	})
	// Notifications: a repair path. See handleNotificationEvent.
	if s.UMI != nil {
		for _, topic := range []string{TopicUMISettled, TopicUMIFailed, TopicUMIServicing} {
			relay.Handle(topic, s.UMI.handleNotificationEvent)
		}
	}
	relay.Start(ctx)
	log.Printf("outbox relay: started — block consequences are delivered from durable storage")
	return relay
}

// Router composes middleware + routes (Open/Closed: add routes, no rewrites).
func (s *Server) Router() http.Handler {
	// Late-bind the live-event hub: the pipeline (and therefore the chain) is
	// assigned after NewServer, so this is the first point where both exist.
	if s.events != nil && s.Pipeline != nil && s.Pipeline.CP != nil && s.Pipeline.CP.Ledger != nil {
		s.Pipeline.CP.Ledger.Watch(s.events)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleIndex)
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
	mux.HandleFunc("/drunix/chain", s.handleChain)
	mux.HandleFunc("/drunix/events", s.handleEvents)
	mux.HandleFunc("/metrics", s.handleMetrics)
	// Also reachable through the app's /api/umi/* proxy, so an operator can
	// read it without exposing the rail directly.
	mux.HandleFunc("/umi/metrics", s.handleMetrics)
	s.registerDocumentRoutes(mux)
	s.registerUMIRoutes(mux) // UMI rail (/umi/*) — additive, no-op when s.UMI is nil
	return logCORS(s.withMetrics(mux))
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

// handleIndex answers the service root with a machine- and human-readable
// directory. Without it "/" returned Go's bare "404 page not found", which
// makes a correctly-running deployment look broken.
func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		writeJSON(w, http.StatusNotFound, map[string]interface{}{
			"error": "ERR_NOT_FOUND", "path": r.URL.Path,
			"hint": "see / for the endpoint directory",
		})
		return
	}
	body := map[string]interface{}{
		"service":  "aasthichain-drunix-gateway",
		"language": "golang",
		"platform": "NPCI Drunix (Hyperledger Fabric fork)",
		"status":   "ok",
		"endpoints": map[string]interface{}{
			"health":  []string{"GET /health", "GET /drunix/ledger/status"},
			"drunix":  []string{"POST /drunix/submit", "POST /drunix/evaluate", "GET /drunix/tx/{txId}", "GET /drunix/recent", "POST /drunix/pipeline", "GET /drunix/pipeline/stats"},
			"fraud":   []string{"POST /fraud/score", "GET /fraud/config"},
			"umiRail": umiIndexEndpoints(s.UMI),
		},
		"note": "This is an API service, not a website. The AasthiChain UI lives on Vercel and proxies /api/umi/* here when UMI_GATEWAY_URL points at this host.",
	}
	writeJSON(w, http.StatusOK, body)
}

func umiIndexEndpoints(rail *UMIRail) interface{} {
	if rail == nil {
		return "disabled (UMI_ENABLED=false)"
	}
	return map[string]interface{}{
		"rail":      "RBI Unified Market Interface (UMI) — SEBI Demat 2.0 pattern, simulation",
		"routes":    umiEndpointList,
		"vercelEnv": "UMI_GATEWAY_URL=<this service's base URL>",
	}
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
		"build":      currentBuild(),
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

// handleChain serves the block chain itself: every block, the replay
// verification anyone can recompute, and whether history is durable.
// ?from=&limit= page through a long chain, newest-last.
func (s *Server) handleChain(w http.ResponseWriter, r *http.Request) {
	if s.Pipeline == nil || s.Pipeline.CP == nil || s.Pipeline.CP.Ledger == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "ledger not wired"})
		return
	}
	c := s.Pipeline.CP.Ledger
	v := c.Verify()
	blocks := c.Snapshot()

	limit := atoiDefault(r.URL.Query().Get("limit"), 50)
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	// Without an explicit cursor, return the NEWEST blocks rather than the
	// oldest. The ledger explorer asks for a fixed window and shows it as
	// "latest first"; serving blocks[0:limit] meant that once the chain grew
	// past that window it only ever showed genesis-era blocks, and a freshly
	// settled purchase could never appear. Explicit ?from= still pages from
	// the head for callers that walk the chain.
	hasFrom := r.URL.Query().Has("from")
	from := atoiDefault(r.URL.Query().Get("from"), 0)
	if !hasFrom {
		from = len(blocks) - limit
	}
	if from < 0 || from > len(blocks) {
		from = 0
	}
	end := from + limit
	if end > len(blocks) {
		end = len(blocks)
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"chainId":      DrunixChainID,
		"height":       v.Height,
		"totalBlocks":  len(blocks),
		"verification": v,
		"durability":   c.Durability(),
		"from":         from,
		"returned":     end - from,
		"blocks":       blocks[from:end],
		"note":         "Append-only. Blocks are never updated or deleted; verification replays SHA-512 linkage and merkle roots from genesis.",
	})
}

func atoiDefault(s string, def int) int {
	if s == "" {
		return def
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return def
	}
	return n
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
		"ledger": map[string]interface{}{"blocks": len(p.CP.Ledger.Blocks), "height": v.Height, "valid": v.Valid,
			"chainId": DrunixChainID, "durability": p.CP.Ledger.Durability()},
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
