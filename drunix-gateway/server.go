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
	// Stream publishes each committed block's consequences to an external log
	// (optional; nil means no fan-out). See eventstream.go.
	Stream EventPublisher
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
	// Credentials issues and verifies signed attestations (see credentials.go).
	// Nil means the /umi/credentials/* routes are not mounted.
	Credentials *CredentialRegistry
	// Attestations joins credentials to settled positions so the downstream
	// exposure of an attestation is visible (see attestation.go). Nil means
	// the /umi/attestations/* routes are not mounted.
	Attestations *AttestationService
	// Mandates holds delegated authority for software agents (see mandates.go).
	// Nil means the /umi/mandates/* routes are not mounted and the settlement
	// path ignores the agent header entirely.
	Mandates *MandateRegistry
	// Work is the escrowed work-order desk (see work.go). Nil means the
	// /umi/work/* routes are not mounted and nothing else changes.
	Work *WorkDesk
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
	// Public-chain anchoring: unlike notifications this one genuinely retries,
	// because an anchor that never landed leaves a verifiability claim unmet.
	if s.Docs != nil && s.Docs.evm != nil {
		relay.Handle(TopicDocAnchored, s.Docs.evm.handleAnchorEvent)
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
	mux.HandleFunc("/drunix/ledger/recover", s.handleLedgerRecover)
	mux.HandleFunc("/drunix/tx/", s.handleTx)
	mux.HandleFunc("/drunix/submit", s.handleSubmit)
	mux.HandleFunc("/drunix/evaluate", s.handleEvaluate)
	mux.HandleFunc("/drunix/recent", s.handleRecent)
	mux.HandleFunc("/fraud/score", s.handleFraudScore)
	mux.HandleFunc("/fraud/config", s.handleFraudConfig)
	mux.HandleFunc("/drunix/pipeline", s.handlePipeline)
	mux.HandleFunc("/drunix/pipeline/stats", s.handlePipelineStats)
	mux.HandleFunc("/umi/stream", s.handleStream)
	mux.HandleFunc("/drunix/chain", s.handleChain)
	mux.HandleFunc("/drunix/events", s.handleEvents)
	mux.HandleFunc("/metrics", s.handleMetrics)
	// Also reachable through the app's /api/umi/* proxy, so an operator can
	// read it without exposing the rail directly.
	mux.HandleFunc("/umi/metrics", s.handleMetrics)
	s.registerDocumentRoutes(mux)
	s.registerUMIRoutes(mux) // UMI rail (/umi/*): additive, no-op when s.UMI is nil
	s.registerCredentialRoutes(mux)
	s.registerMandateRoutes(mux)
	s.registerAttestationRoutes(mux)
	s.registerWorkRoutes(mux) // work desk (/umi/work/*): additive, no-op when s.Work is nil
	return logCORS(s.withMetrics(s.sealedLedgerGate(mux)))
}

// sealedLedgerGate refuses every write once the ledger has stopped accepting
// blocks.
//
// Per-route gating missed routes: ISIN assignment, baskets, offers and
// document anchoring all commit blocks and none of them were covered. The
// rail's promise is that anything it confirms has a block behind it, so the
// check belongs in front of everything rather than on the handlers someone
// remembered.
func (s *Server) sealedLedgerGate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The repair route is the one write a sealed chain must still accept:
		// refusing it would leave no way back from the state it describes.
		if r.URL.Path == "/drunix/ledger/recover" {
			next.ServeHTTP(w, r)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead &&
			r.Method != http.MethodOptions && s.chainSealed() {
			writeJSON(w, http.StatusServiceUnavailable, map[string]interface{}{
				"error":   "ERR_LEDGER_SEALED",
				"message": "the ledger failed verification on restore and is refusing new blocks, so this cannot be committed",
				"hint":    "see GET /drunix/ledger/status",
			})
			return
		}
		next.ServeHTTP(w, r)
	})
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
	// This writes straight to the ledger, bypassing every business rule the
	// rail enforces above it — a stranger could post a token transfer here
	// and have it committed. It is an operator tool, so operators only.
	caller := callerOf(r)
	if !umiRequireIdentity(w, caller) {
		return
	}
	if !caller.supervisor() {
		umiErr(w, http.StatusForbidden, "ERR_NOT_SUPERVISORY",
			"Submitting a transaction straight to the ledger is a supervisory action. Use the rail routes instead.")
		return
	}
	rec, err := s.Ledger.SubmitTransaction(body.Chaincode, body.Function, body.Args, body.CreatorMSP)
	if err != nil {
		// An unknown outcome is not a failure. Hand back the transaction id
		// so the caller can settle the question against the ledger instead
		// of guessing from an error string.
		out := map[string]interface{}{"error": err.Error()}
		if rec != nil && rec.Status == "UNKNOWN" {
			out["txId"] = rec.TxID
			out["status"] = rec.Status
			out["hint"] = "query the ledger for this transaction id before assuming it did not commit"
			writeJSON(w, http.StatusAccepted, out)
			return
		}
		writeJSON(w, http.StatusBadRequest, out)
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
	// policyFor() has always said who may run each function — Originator plus
	// Registrar to mint, Regulator to freeze — but nothing checked the caller
	// against it here, so the policy was decoration: an anonymous request
	// could mint itself a hundred thousand tokens, move them, and freeze a
	// stranger's property, all committed to the chain.
	caller := callerOf(r)
	if !umiRequireIdentity(w, caller) {
		return
	}
	if !pipelineCallerMaySubmit(caller, body.Fn) {
		umiErr(w, http.StatusForbidden, "ERR_ENDORSEMENT_POLICY",
			"Running "+body.Fn+" through the pipeline needs "+pipelineWhoMay(body.Fn)+".")
		return
	}
	res, err := s.Pipeline.Submit(body.Fn, body.Args, priv)
	code := http.StatusOK
	if err != nil {
		code = http.StatusUnprocessableEntity
	}
	writeJSON(w, code, map[string]interface{}{"result": res, "error": errStr(err)})
}

// pipelineCallerMaySubmit enforces policyFor() at the door, in terms of the
// roles the gateway actually forwards.
func pipelineCallerMaySubmit(c umiCaller, fn string) bool {
	if c.supervisor() {
		return true
	}
	switch strings.ToLower(c.Role) {
	case "originator", "registrar":
		return fn != "FreezeProperty"
	}
	// Everyone else — investors — may only move what they already hold; the
	// chaincode's balance check is the limit there.
	switch fn {
	case "MintPropertyTokens", "FreezeProperty":
		return false
	}
	return true
}

func pipelineWhoMay(fn string) string {
	switch fn {
	case "MintPropertyTokens":
		return "an originator, a registrar or a supervisor"
	case "FreezeProperty":
		return "a regulator"
	}
	return "an identified participant"
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

	limit := queryLimit(r, 50, 500)
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

// queryLimit reads ?limit= and keeps it inside a stated ceiling.
//
// Several list routes took the caller's number as given, so ?limit=1000000
// walked and copied the whole collection into one response: slow for the
// caller, and an easy way for anyone to make the rail allocate. A ceiling is
// not a feature flag; it is the difference between a list endpoint and a
// denial of service.
func queryLimit(r *http.Request, def, max int) int {
	n := atoiDefault(r.URL.Query().Get("limit"), def)
	if n <= 0 {
		return def
	}
	if n > max {
		return max
	}
	return n
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

// handleLedgerRecover reopens a sealed chain by dropping the history it
// cannot vouch for.
//
// This is destructive and it erases the evidence of whatever broke the
// chain, so it is deliberately awkward: supervisors only, an explicit
// confirmation string in the body, and the discarded heights and hashes are
// written into the replacement block. The alternative was a rail that stays
// stopped until someone edits the database by hand, which is worse — people
// edit the database by hand and nobody ever finds out.
func (s *Server) handleLedgerRecover(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "ERR_METHOD", "message": "POST required"})
		return
	}
	caller := callerOf(r)
	if !umiRequireSupervisor(w, caller, "Repairing the ledger") {
		return
	}
	var body struct {
		Confirm string `json:"confirm"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if body.Confirm != "TRUNCATE_TO_LAST_VALID" {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{
			"error":   "ERR_CONFIRMATION_REQUIRED",
			"message": `this discards every block from the first unverifiable one onwards — send {"confirm":"TRUNCATE_TO_LAST_VALID"} if that is what you want`,
		})
		return
	}
	if s.Pipeline == nil || s.Pipeline.CP == nil || s.Pipeline.CP.Ledger == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "ERR_NO_LEDGER"})
		return
	}
	chain := s.Pipeline.CP.Ledger
	before := chain.Verify()
	discarded, kept, err := chain.RecoverTruncate(caller.ID)
	if err != nil {
		writeJSON(w, http.StatusConflict, map[string]interface{}{
			"error": "ERR_LEDGER_UNREPAIRABLE", "message": err.Error(),
		})
		return
	}
	after := chain.Verify()
	log.Printf("Drunix chain: ledger repaired by %s — %d block(s) discarded, chain now valid=%v at height %d",
		caller.ID, len(discarded), after.Valid, after.Height)
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"ok":             true,
		"wasValid":       before.Valid,
		"brokenAt":       before.BrokenAt,
		"discardedCount": len(discarded),
		"discarded":      discarded,
		"keptThrough":    kept,
		"chain":          after,
		"note":           "the truncation is itself a block (LEDGER_TRUNCATED) naming every height and hash that was dropped",
	})
}

// handleStream reports the settlement event stream: which broker (if any), the
// topics, the counters, and in simulation the most recent envelopes. It is the
// one place to confirm that events are being derived correctly before a broker
// is ever attached.
func (s *Server) handleStream(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if s.Stream == nil {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"mode": "off",
			"note": "No event publisher is attached to this server.",
		})
		return
	}
	out := s.Stream.Describe()
	out["whyPostCommit"] = "A broker is a network dependency. Publishing happens after the block is appended and never blocks settlement, so an unreachable broker cannot stop a trade."
	out["lineage"] = "Hyperledger Fabric's ordering service was Kafka-based through the 1.x line before Raft replaced it in 1.4.1. This ledger models the same execute-order-validate pipeline, and speaks the Kafka protocol on the way out."
	_ = json.NewEncoder(w).Encode(out)
}
